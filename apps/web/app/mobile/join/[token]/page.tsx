"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Bootstrap, ItemTemplate, api } from "@/lib/api";

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

const photoMaxSide: Record<PhotoType, number> = {
  object: 1280,
  condition: 1280,
  dot: 1600,
  nameplate: 1600,
};

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [objectClassId, setObjectClassId] = useState("");
  const [templateQuery, setTemplateQuery] = useState("");
  const [templates, setTemplates] = useState<ItemTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<ItemTemplate | null>(null);
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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = new URLSearchParams({ q: templateQuery, room: roomName, limit: "8" });
      api<ItemTemplate[]>(`/item-templates?${search.toString()}`)
        .then(setTemplates)
        .catch(() => setTemplates([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [templateQuery, roomName]);

  function applyTemplate(template: ItemTemplate) {
    setSelectedTemplate(template);
    setTemplateQuery(template.label);
    if (template.object_class_id) setObjectClassId(template.object_class_id);
    if (!activeItem) return;
    api(`/items/${activeItem.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        object_type: template.object_type || template.label,
        object_class_id: template.object_class_id || objectClassId || null,
        brand: template.brand || null,
        model: template.model || null,
      }),
    }).then(() => setMessage("Vorlage am Artikel gespeichert")).catch(() => setMessage("Vorlage gewählt"));
  }

  async function ensureItem() {
    if (activeItem) return activeItem;
    if (!joined) throw new Error("Session noch nicht gekoppelt");
    const item = await api<Item>("/items", {
      method: "POST",
      body: JSON.stringify({
        session_id: joined.session.id,
        object_class_id: objectClassId,
        object_type: selectedTemplate?.object_type || selectedTemplate?.label || null,
        brand: selectedTemplate?.brand || null,
        model: selectedTemplate?.model || null,
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

  async function compressPhoto(file: File, photoType: PhotoType) {
    if (!file.type.startsWith("image/")) return file;
    const maxSide = photoMaxSide[photoType];
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }
    const scale = Math.min(maxSide / bitmap.width, maxSide / bitmap.height, 1);
    if (scale >= 1 && file.size <= 1_400_000) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.74);
    });
    if (!blob) return file;
    const name = `${file.name.replace(/\.[^.]+$/, "") || photoType}.jpg`;
    return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
  }

  async function uploadPhoto(itemId: string, photoType: PhotoType, file: File) {
    const form = new FormData();
    const prepared = await compressPhoto(file, photoType);
    form.append("file", prepared);
    await api(`/items/${itemId}/photos?photo_type=${photoType}`, {
      method: "POST",
      body: form,
    });
    return prepared;
  }

  function startAiInBackground(item: Item) {
    setAiSummary("KI läuft im Hintergrund");
    api<AiJob>(`/items/${item.id}/ai/run`, { method: "POST", body: "{}" })
      .then((job) => setAiSummary(job.message || "KI läuft im Hintergrund"))
      .catch(() => setAiSummary("KI konnte nicht gestartet werden. Erfassung bleibt gespeichert."));
  }

  async function handlePhotoSelected(type: PhotoType, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setMessage("Kein Foto ausgewählt");
      return;
    }
    setMessage(`${photoLabels[type]} wird vorbereitet...`);
    setBusy(true);
    try {
      const item = await ensureItem();
      const uploadedFile = await uploadPhoto(item.id, type, file);
      setPhotos((current) => ({ ...current, [type]: uploadedFile }));
      startAiInBackground(item);
      setMessage(`${photoLabels[type]} gespeichert. Du kannst direkt weitermachen.`);
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
      startAiInBackground(item);
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
      const uploadedFile = await uploadPhoto(item.id, type, selected);
      setPhotos((current) => ({ ...current, [type]: uploadedFile }));
      startAiInBackground(item);
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
    setSelectedTemplate(null);
    setTemplateQuery("");
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

        <div className="template-picker">
          <label className="field">
            <span>Artikelvorlage suchen</span>
            <input
              value={templateQuery}
              placeholder="z. B. Hebebühne, Wuchtmaschine, Dell, VAS"
              onChange={(event) => {
                setTemplateQuery(event.target.value);
                setSelectedTemplate(null);
              }}
            />
          </label>
          {templates.length ? (
            <div className="template-results">
              {templates.map((template) => (
                <button
                  className={selectedTemplate?.id === template.id ? "template-result is-selected" : "template-result"}
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                >
                  <strong>{template.label}</strong>
                  <span>{template.source}{template.subtitle ? ` · ${template.subtitle}` : ""}</span>
                </button>
              ))}
            </div>
          ) : null}
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
