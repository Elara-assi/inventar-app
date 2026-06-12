"use client";

import { useEffect, useRef, useState } from "react";
import { Bootstrap, api, photoUrl } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

type Task = {
  id: string;
  assigned_role: string;
  missing_field?: string;
  comment?: string;
};

type Photo = { id: string; photo_type: string };

export type ReviewItem = {
  id: string;
  inventory_id?: string;
  temporary_id?: string;
  object_type?: string;
  object_class_id?: string;
  object_class_name?: string;
  brand?: string;
  model?: string;
  serial_number?: string;
  condition?: string;
  condition_note?: string;
  status?: string;
  review_status?: string;
  commercial_category?: string;
  accounting_status?: string;
  confidence_score?: number;
  locked_at?: string | null;
  has_object_photo?: boolean;
  has_nameplate_photo?: boolean;
  has_dot_photo?: boolean;
  photos?: Photo[];
  blockers?: string[];
  open_tasks?: Task[];
};

const conditions = ["neu", "sehr_gut", "gut", "gebraucht", "reparaturbeduerftig", "defekt", "aussondern"];
// Quelle: docs/DATA_MODEL.md (Review Status)
const reviewStatuses = [
  "erfasst",
  "ki_vorgefuellt",
  "nacharbeit_erfasser",
  "nacharbeit_pruefer",
  "nacharbeit_buchhaltung",
  "nacharbeit_technik",
  "finalisierbar",
  "finalisiert",
  "abweichung",
  "dublette",
];

const photoTypeLabels: Record<string, string> = {
  object: "Objekt",
  nameplate: "Typenschild",
  dot: "DOT",
  serial: "Seriennr.",
  condition: "Zustand",
  other: "Weitere",
};

type Draft = {
  object_class_id: string;
  condition: string;
  review_status: string;
  serial_number: string;
  brand: string;
  model: string;
  condition_note: string;
};

function draftFromItem(item: ReviewItem): Draft {
  return {
    object_class_id: item.object_class_id ?? "",
    condition: item.condition ?? "gebraucht",
    review_status: item.review_status ?? "erfasst",
    serial_number: item.serial_number ?? "",
    brand: item.brand ?? "",
    model: item.model ?? "",
    condition_note: item.condition_note ?? "",
  };
}

export function ItemReviewCard({
  item,
  objectClasses,
  onChanged,
}: {
  item: ReviewItem;
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFromItem(item));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Kernfix F1: Das Polling der Elternseite liefert alle 3s neue Item-Props.
  // Der Draft wird NUR uebernommen, solange der Pruefer nichts geaendert hat –
  // vorher gingen Eingaben mitten im Tippen verloren.
  useEffect(() => {
    if (!dirtyRef.current) {
      setDraft(draftFromItem(item));
    }
  }, [item]);

  const locked = Boolean(item.locked_at) || item.review_status === "finalisiert";
  const blockers = item.blockers ?? [];
  const tasks = item.open_tasks ?? [];
  const photos = item.photos ?? [];
  const objectPhoto = photos.find((p) => p.photo_type === "object");

  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setMessage("");
  }

  async function save() {
    setSaving(true);
    try {
      await api(`/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          object_class_id: draft.object_class_id || null,
          condition: draft.condition,
          review_status: draft.review_status,
          serial_number: draft.serial_number || null,
          brand: draft.brand || null,
          model: draft.model || null,
          condition_note: draft.condition_note || null,
        }),
      });
      setDirty(false);
      setMessage("Gespeichert");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(draftFromItem(item));
    setDirty(false);
    setMessage("");
  }

  async function requestRework(role: "Buchhaltung" | "Erfasser", missingField: string) {
    try {
      await api(`/items/${item.id}/request-rework`, {
        method: "POST",
        body: JSON.stringify({
          assigned_role: role,
          missing_field: missingField,
          comment: `${missingField} nacharbeiten`,
        }),
      });
      setMessage(`Nacharbeit ${role} gesetzt`);
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Nacharbeit fehlgeschlagen");
    }
  }

  async function finalize() {
    try {
      await api(`/items/${item.id}/finalize`, { method: "POST", body: "{}" });
      setMessage("Finalisiert");
      setDirty(false);
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Finalisierung blockiert");
    }
  }

  return (
    <article className={`card${locked ? " card-locked" : ""}`}>
      {objectPhoto ? (
        <a href={photoUrl(objectPhoto.id)} target="_blank" rel="noreferrer" className="photo-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl(objectPhoto.id)} alt={item.object_type || "Objektfoto"} loading="lazy" />
        </a>
      ) : (
        <div className="photo-placeholder">Objektfoto fehlt</div>
      )}
      <div className="card-body grid">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "start" }}>
          <div>
            <strong>{item.object_type || "Neues Objekt"}</strong>
            <div className="muted">{item.inventory_id || item.temporary_id}</div>
          </div>
          <StatusBadge value={item.review_status} />
        </div>

        {photos.length > 1 ? (
          <div className="thumb-row">
            {photos.filter((p) => p.photo_type !== "object").map((photo) => (
              <a key={photo.id} href={photoUrl(photo.id)} target="_blank" rel="noreferrer" className="thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(photo.id)} alt={photo.photo_type} loading="lazy" />
                <span>{photoTypeLabels[photo.photo_type] ?? photo.photo_type}</span>
              </a>
            ))}
          </div>
        ) : null}

        <div className="grid grid-2">
          <label className="field">
            <span>Objektklasse</span>
            <select disabled={locked} value={draft.object_class_id} onChange={(event) => edit("object_class_id", event.target.value)}>
              <option value="">Offen</option>
              {objectClasses.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Zustand</span>
            <select disabled={locked} value={draft.condition} onChange={(event) => edit("condition", event.target.value)}>
              {conditions.map((entry) => (
                <option key={entry} value={entry}>{entry.replaceAll("_", " ")}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-2">
          <label className="field">
            <span>Marke</span>
            <input disabled={locked} value={draft.brand} onChange={(event) => edit("brand", event.target.value)} placeholder="z. B. Dell" />
          </label>
          <label className="field">
            <span>Modell</span>
            <input disabled={locked} value={draft.model} onChange={(event) => edit("model", event.target.value)} placeholder="z. B. U2722D" />
          </label>
        </div>

        <label className="field">
          <span>Seriennummer</span>
          <input disabled={locked} value={draft.serial_number} onChange={(event) => edit("serial_number", event.target.value)} placeholder="falls vorhanden" />
        </label>

        <label className="field">
          <span>Bemerkung</span>
          <input disabled={locked} value={draft.condition_note} onChange={(event) => edit("condition_note", event.target.value)} placeholder="Zustand, Hinweise" />
        </label>

        <label className="field">
          <span>Pruefstatus</span>
          <select disabled={locked} value={draft.review_status} onChange={(event) => edit("review_status", event.target.value)}>
            {reviewStatuses.map((entry) => (
              <option key={entry} value={entry}>{entry.replaceAll("_", " ")}</option>
            ))}
          </select>
        </label>

        {blockers.length ? (
          <div className="grid">
            <strong>Blocker</strong>
            {blockers.map((blocker) => <span className="status upload_fehler" key={blocker}>{blocker}</span>)}
          </div>
        ) : <span className="status finalisierbar">finalisierbar</span>}

        {tasks.length ? (
          <div className="grid">
            <strong>Nacharbeit</strong>
            {tasks.map((task) => (
              <span className="status nacharbeit_pruefer" key={task.id}>{task.assigned_role}: {task.missing_field || task.comment}</span>
            ))}
          </div>
        ) : null}

        {locked ? (
          <span className="status finalisiert">Finalisiert und gesperrt</span>
        ) : (
          <>
            <div className="quick-row">
              <button className="btn secondary" onClick={() => requestRework("Buchhaltung", "Anlagenummer/Buchwert")}>Buchhaltung</button>
              <button className="btn secondary" onClick={() => requestRework("Erfasser", "Foto/Nachweis")}>Erfasser</button>
            </div>
            <div className="quick-row">
              <button className="btn accent" onClick={save} disabled={saving || !dirty}>
                {saving ? "Speichert…" : dirty ? "Speichern" : "Gespeichert"}
              </button>
              <button className="btn" onClick={finalize} disabled={saving}>Finalisieren</button>
            </div>
            {dirty ? (
              <button className="btn ghost" onClick={discard}>Aenderungen verwerfen</button>
            ) : null}
          </>
        )}
        {message ? <p className="status pruefen">{message}</p> : null}
      </div>
    </article>
  );
}
