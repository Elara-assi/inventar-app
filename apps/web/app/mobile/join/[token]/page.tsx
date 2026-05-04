"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Bootstrap, api } from "@/lib/api";

type Joined = {
  session: {
    id: string;
    location_id: string;
    building_id: string;
    room_id: string;
  };
  device: { id: string };
};

type Item = {
  id: string;
  inventory_id: string;
  temporary_id: string;
};

type PhotoType = "object" | "dot" | "nameplate" | "condition";

const photoLabels: Record<PhotoType, string> = {
  object: "Objektfoto",
  dot: "DOT-Foto",
  nameplate: "Typenschildfoto",
  condition: "Zustandsfoto",
};

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [objectClassId, setObjectClassId] = useState("");
  const [transcript, setTranscript] = useState("");
  const [activeItem, setActiveItem] = useState<Item | null>(null);
  const [photos, setPhotos] = useState<Partial<Record<PhotoType, File>>>({});
  const [message, setMessage] = useState("Bereit");

  const objectPhotoInputRef = useRef<HTMLInputElement>(null);
  const nameplatePhotoInputRef = useRef<HTMLInputElement>(null);
  const dotPhotoInputRef = useRef<HTMLInputElement>(null);
  const conditionPhotoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

  useEffect(() => {
    api<Bootstrap>("/meta/bootstrap").then((boot) => {
      setBootstrap(boot);
      setObjectClassId(boot.object_classes.find((entry) => entry.slug === "monitor")?.id ?? boot.object_classes[0]?.id ?? "");
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Stammdaten nicht erreichbar"));
  }, []);

  useEffect(() => {
    if (!token) return;
    api<Joined>("/sessions/join", {
      method: "POST",
      body: JSON.stringify({ token, device_name: "Handy-Erfassung" }),
    }).then(setJoined).catch((err) => setMessage(err instanceof Error ? err.message : "Join fehlgeschlagen"));
  }, [token]);

  const roomName = useMemo(() => {
    const room = bootstrap?.rooms.find((entry) => entry.id === joined?.session.room_id);
    return room?.name ?? "Raum";
  }, [bootstrap, joined]);

  async function ensureItem() {
    if (activeItem) return activeItem;
    if (!joined) throw new Error("Session noch nicht gekoppelt");
    const item = await api<Item>("/items", {
      method: "POST",
      body: JSON.stringify({
        session_id: joined.session.id,
        object_class_id: objectClassId,
        condition: "gebraucht",
      }),
    });
    setActiveItem(item);
    return item;
  }

  function inputFor(type: PhotoType) {
    return {
      object: objectPhotoInputRef,
      dot: dotPhotoInputRef,
      nameplate: nameplatePhotoInputRef,
      condition: conditionPhotoInputRef,
    }[type].current;
  }

  function openCamera(type: PhotoType) {
    const input = inputFor(type);
    if (!input) {
      setMessage("Kamera-Eingabe nicht bereit");
      return;
    }
    input.value = "";
    input.click();
  }

  async function uploadPhoto(itemId: string, photoType: PhotoType, file: File) {
    const form = new FormData();
    form.append("file", file);
    await api(`/items/${itemId}/photos?photo_type=${photoType}`, {
      method: "POST",
      body: form,
    });
  }

  async function handlePhotoSelected(type: PhotoType, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setMessage("Kein Foto ausgewählt");
      return;
    }
    setPhotos((current) => ({ ...current, [type]: file }));
    setMessage(`${photoLabels[type]} wird hochgeladen...`);
    try {
      const item = await ensureItem();
      await uploadPhoto(item.id, type, file);
      await api(`/items/${item.id}/ai/run`, { method: "POST", body: "{}" });
      setMessage(`${photoLabels[type]} gespeichert und ausgewertet: ${item.inventory_id || item.temporary_id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Foto fehlgeschlagen");
    }
  }

  async function scanCode() {
    try {
      const item = await ensureItem();
      setMessage(`Code/ID bereit: ${item.inventory_id || item.temporary_id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Code fehlgeschlagen");
    }
  }

  async function recordVoice() {
    try {
      const item = await ensureItem();
      await api(`/items/${item.id}/audio?transcript=${encodeURIComponent(transcript || "Sprachnotiz ohne Text")}`, {
        method: "POST",
        body: undefined,
      });
      await api(`/items/${item.id}/ai/run`, { method: "POST", body: "{}" });
      setMessage(`Sprachnotiz und KI-Vorschlag gespeichert: ${item.inventory_id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sprache fehlgeschlagen");
    }
  }

  async function addEvidence(type: Exclude<PhotoType, "object">) {
    const selected = photos[type];
    if (!selected) {
      openCamera(type);
      return;
    }
    try {
      const item = await ensureItem();
      await uploadPhoto(item.id, type, selected);
      await api(`/items/${item.id}/ai/run`, { method: "POST", body: "{}" });
      setMessage(`${photoLabels[type]} gespeichert und ausgewertet: ${item.inventory_id || item.temporary_id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Nachweis fehlgeschlagen");
    }
  }

  function resetItem() {
    setActiveItem(null);
    setTranscript("");
    setPhotos({});
    setMessage("Bereit für nächstes Objekt");
  }

  return (
    <main className="page grid">
      <section className="panel grid">
        <div>
          <h1>{roomName}</h1>
          <p className="muted">Foto, Code, Sprache. Keine Buchhaltungsmaske.</p>
        </div>

        <label className="field">
          <span>Objektklasse</span>
          <select value={objectClassId} onChange={(event) => setObjectClassId(event.target.value)}>
            {bootstrap?.object_classes.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </label>

        <input
          ref={objectPhotoInputRef}
          className="visually-hidden-file"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => handlePhotoSelected("object", event)}
        />
        <input
          ref={nameplatePhotoInputRef}
          className="visually-hidden-file"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => handlePhotoSelected("nameplate", event)}
        />
        <input
          ref={dotPhotoInputRef}
          className="visually-hidden-file"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => handlePhotoSelected("dot", event)}
        />
        <input
          ref={conditionPhotoInputRef}
          className="visually-hidden-file"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => handlePhotoSelected("condition", event)}
        />

        <label className="field">
          <span>Sprachnotiz für Raumtest</span>
          <textarea
            value={transcript}
            rows={3}
            placeholder="Dell Monitor, Serviceannahme, Zustand gut"
            onChange={(event) => setTranscript(event.target.value)}
          />
        </label>

        <div className="mobile-actions">
          <button className="btn accent" onClick={() => openCamera("object")}>Foto</button>
          <button className="btn" onClick={scanCode}>Code scannen</button>
          <button className="btn secondary" onClick={recordVoice}>Sprache aufnehmen</button>
        </div>

        <div className="quick-row">
          <button className="btn secondary" onClick={() => addEvidence("nameplate")}>Typenschildfoto</button>
          <button className="btn secondary" onClick={() => addEvidence("dot")}>DOT-Foto</button>
        </div>
        <button className="btn secondary" onClick={() => addEvidence("condition")}>Zustandsfoto</button>

        {activeItem ? <p className="muted">Aktiv: {activeItem.inventory_id || activeItem.temporary_id}</p> : null}
        <p className="status pruefen">{message}</p>
        <button className="btn" onClick={resetItem}>Nächstes Objekt</button>
      </section>
    </main>
  );
}
