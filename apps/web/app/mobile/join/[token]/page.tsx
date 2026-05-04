"use client";

import { useEffect, useMemo, useState } from "react";
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

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [objectClassId, setObjectClassId] = useState("");
  const [transcript, setTranscript] = useState("");
  const [activeItem, setActiveItem] = useState<Item | null>(null);
  const [objectPhoto, setObjectPhoto] = useState<File | null>(null);
  const [dotPhoto, setDotPhoto] = useState<File | null>(null);
  const [nameplatePhoto, setNameplatePhoto] = useState<File | null>(null);
  const [message, setMessage] = useState("Bereit");

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

  useEffect(() => {
    api<Bootstrap>("/meta/bootstrap").then((boot) => {
      setBootstrap(boot);
      setObjectClassId(boot.object_classes.find((entry) => entry.slug === "monitor")?.id ?? boot.object_classes[0]?.id ?? "");
    });
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

  function fallbackFile(name: string, content: string) {
    return new File([content], name, { type: "text/plain" });
  }

  async function uploadPhoto(itemId: string, photoType: "object" | "dot" | "nameplate" | "condition", file: File | null) {
    const form = new FormData();
    form.append("file", file ?? fallbackFile(`${photoType}.txt`, `Raumtest ${photoType} ${new Date().toISOString()}`));
    await api(`/items/${itemId}/photos?photo_type=${photoType}`, {
      method: "POST",
      body: form,
    });
  }

  async function captureObjectPhoto() {
    try {
      const item = await ensureItem();
      await uploadPhoto(item.id, "object", objectPhoto);
      setMessage(`Objektfoto gespeichert: ${item.inventory_id}`);
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

  async function addEvidence(type: "nameplate" | "condition" | "dot") {
    try {
      const item = await ensureItem();
      const selected = type === "dot" ? dotPhoto : type === "nameplate" ? nameplatePhoto : null;
      await uploadPhoto(item.id, type, selected);
      setMessage(`${type === "dot" ? "DOT-Foto" : type === "nameplate" ? "Typenschildfoto" : "Zustandsfoto"} gespeichert`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Nachweis fehlgeschlagen");
    }
  }

  function resetItem() {
    setActiveItem(null);
    setTranscript("");
    setObjectPhoto(null);
    setDotPhoto(null);
    setNameplatePhoto(null);
    setMessage("Bereit fuer naechstes Objekt");
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

        <label className="field">
          <span>Objektfoto</span>
          <input type="file" accept="image/*" capture="environment" onChange={(event) => setObjectPhoto(event.target.files?.[0] ?? null)} />
        </label>

        <label className="field">
          <span>Sprachnotiz fuer Raumtest</span>
          <textarea
            value={transcript}
            rows={3}
            placeholder="Dell Monitor, Serviceannahme, Zustand gut"
            onChange={(event) => setTranscript(event.target.value)}
          />
        </label>

        <div className="mobile-actions">
          <button className="btn accent" onClick={captureObjectPhoto}>Foto</button>
          <button className="btn" onClick={scanCode}>Code scannen</button>
          <button className="btn secondary" onClick={recordVoice}>Sprache aufnehmen</button>
        </div>

        <div className="quick-row">
          <label className="field">
            <span>Typenschild</span>
            <input type="file" accept="image/*" capture="environment" onChange={(event) => setNameplatePhoto(event.target.files?.[0] ?? null)} />
          </label>
          <label className="field">
            <span>DOT</span>
            <input type="file" accept="image/*" capture="environment" onChange={(event) => setDotPhoto(event.target.files?.[0] ?? null)} />
          </label>
        </div>

        <div className="quick-row">
          <button className="btn secondary" onClick={() => addEvidence("nameplate")}>Typenschildfoto</button>
          <button className="btn secondary" onClick={() => addEvidence("dot")}>DOT-Foto</button>
        </div>
        <button className="btn secondary" onClick={() => addEvidence("condition")}>Zustandsfoto</button>

        {activeItem ? <p className="muted">Aktiv: {activeItem.inventory_id || activeItem.temporary_id}</p> : null}
        <p className="status pruefen">{message}</p>
        <button className="btn" onClick={resetItem}>Naechstes Objekt</button>
      </section>
    </main>
  );
}
