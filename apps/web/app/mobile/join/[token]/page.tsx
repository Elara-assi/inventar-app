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

type AiJob = {
  status: string;
  message: string;
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
  const [aiSummary, setAiSummary] = useState("");
  const [busy, setBusy] = useState(false);

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
    if (busy) return;
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

  async function runAi(item: Item) {
    setMessage("KI-Auswertung wird gestartet...");
    const job = await api<AiJob>(`/items/${item.id}/ai/run`, { method: "POST", body: "{}" });
    setAiSummary(job.message || "KI läuft im Hintergrund");
  }

  async function handlePhotoSelected(type: PhotoType, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setMessage("Kein Foto ausgewählt");
      return;
    }
    setPhotos((current) => ({ ...current, [type]: file }));
    setMessage(`${photoLabels[type]} wird hochgeladen...`);
    setBusy(true);
    try {
      const item = await ensureItem();
      await uploadPhoto(item.id, type, file);
      await runAi(item);
      setMessage(`${photoLabels[type]} gespeichert. Bei Bedarf Sprache oder Nachweis ergänzen, dann Objekt speichern.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Foto fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function scanCode() {
    if (busy) return;
    try {
      const item = await ensureItem();
      setMessage(`Code/ID bereit: ${item.inventory_id || item.temporary_id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Code fehlgeschlagen");
    }
  }

  async function recordVoice() {
    if (busy) return;
    setBusy(true);
    try {
      const item = await ensureItem();
      await api(`/items/${item.id}/audio?transcript=${encodeURIComponent(transcript || "Sprachnotiz ohne Text")}`, {
        method: "POST",
        body: undefined,
      });
      await runAi(item);
      setMessage("Sprachnotiz gespeichert. Objekt speichern, wenn die Erfassung fertig ist.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sprache fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function addEvidence(type: Exclude<PhotoType, "object">) {
    if (busy) return;
    const selected = photos[type];
    if (!selected) {
      openCamera(type);
      return;
    }
    try {
      setBusy(true);
      const item = await ensureItem();
      await uploadPhoto(item.id, type, selected);
      await runAi(item);
      setMessage(`${photoLabels[type]} gespeichert. Objekt speichern, wenn die Erfassung fertig ist.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Nachweis fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  function saveCurrentItem() {
    if (busy) return;
    const savedLabel = activeItem?.inventory_id || activeItem?.temporary_id || "Objekt";
    setActiveItem(null);
    setTranscript("");
    setPhotos({});
    setAiSummary("");
    setMessage(`${savedLabel} gespeichert. Bereit für nächstes Objekt.`);
  }

  return (
    <main className="page grid mobile-capture-page">
      <section className="mobile-capture-shell">
        <div className="mobile-room-bar">
          <div>
            <strong>{roomName}</strong>
            <span>Foto · Code · Sprache</span>
          </div>
          <span className="live-indicator">Live</span>
        </div>

        <div className={`capture-status ${busy ? "is-busy" : ""}`}>
          <strong>{busy ? "Bitte warten" : aiSummary ? "KI-Vorschlag" : "Erfassung bereit"}</strong>
          <span>{aiSummary || message}</span>
        </div>

        <button
          className={`mobile-photo-stage ${photos.object ? "has-photo" : ""}`}
          type="button"
          disabled={busy}
          onClick={() => openCamera("object")}
        >
          <span>{photos.object ? "Objektfoto bereit" : "Objektfoto aufnehmen"}</span>
          <small>{busy ? "Upload läuft" : "Foto steht im Mittelpunkt der Erfassung"}</small>
        </button>

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

        <div className="mobile-actions">
          <button className="btn" disabled={busy} onClick={scanCode}>Code scannen</button>
          <button className="btn secondary" disabled={busy} onClick={recordVoice}>Sprache aufnehmen</button>
        </div>

        <label className="field mobile-voice-field">
          <span>Sprachnotiz</span>
          <textarea
            value={transcript}
            rows={3}
            placeholder="Dell Monitor, Serviceannahme, Zustand gut"
            onChange={(event) => setTranscript(event.target.value)}
          />
        </label>

        <div className="quick-row evidence-actions">
          <button className="btn secondary" disabled={busy} onClick={() => addEvidence("nameplate")}>Typenschildfoto</button>
          <button className="btn secondary" disabled={busy} onClick={() => addEvidence("dot")}>DOT-Foto</button>
          <button className="btn secondary" disabled={busy} onClick={() => addEvidence("condition")}>Zustandsfoto</button>
        </div>

        {activeItem ? <p className="muted">Aktiv: {activeItem.inventory_id || activeItem.temporary_id}</p> : null}
        {activeItem ? (
          <div className="mobile-save-bar">
            <button className="btn accent" disabled={busy} onClick={saveCurrentItem}>Speichern · nächstes Objekt</button>
          </div>
        ) : null}
        {joined ? (
          <a className="btn secondary" href={`/session/${joined.session.id}`}>Tablet-Liste bearbeiten</a>
        ) : null}
      </section>
    </main>
  );
}
