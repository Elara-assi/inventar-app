"use client";

import { useEffect, useState } from "react";
import { Bootstrap, api } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

type Task = {
  id: string;
  assigned_role: string;
  missing_field?: string;
};

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
  status?: string;
  review_status?: string;
  has_object_photo?: boolean;
  has_nameplate_photo?: boolean;
  has_dot_photo?: boolean;
  blockers?: string[];
  open_tasks?: Task[];
};

const conditions = ["neu", "sehr_gut", "gut", "gebraucht", "reparaturbeduerftig", "defekt", "aussondern"];
const reviewStatuses = [
  "erfasst",
  "ki_vorgefuellt",
  "nacharbeit_erfasser",
  "nacharbeit_pruefer",
  "nacharbeit_buchhaltung",
  "finalisierbar",
  "geprueft",
  "finalisiert",
  "abweichung",
];

export function ItemReviewList({
  items,
  objectClasses,
  onChanged,
}: {
  items: ReviewItem[];
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void;
}) {
  if (!items.length) {
    return (
      <div className="empty-state">
        <strong>Warte auf mobile Erfassung</strong>
        <span>QR-Code mit dem Handy öffnen, Foto aufnehmen und Sprachnotiz speichern.</span>
      </div>
    );
  }

  return (
    <div className="item-list">
      <div className="item-list-head">
        <span>ID</span>
        <span>Objekt</span>
        <span>Details</span>
        <span>Klasse</span>
        <span>Zustand</span>
        <span>Status</span>
        <span>Aktion</span>
      </div>
      {items.map((item) => (
        <ItemReviewRow item={item} key={item.id} objectClasses={objectClasses} onChanged={onChanged} />
      ))}
    </div>
  );
}

function ItemReviewRow({
  item,
  objectClasses,
  onChanged,
}: {
  item: ReviewItem;
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState({
    object_type: item.object_type ?? "",
    brand: item.brand ?? "",
    model: item.model ?? "",
    serial_number: item.serial_number ?? "",
    object_class_id: item.object_class_id ?? "",
    condition: item.condition ?? "gebraucht",
    review_status: item.review_status ?? "erfasst",
  });
  const [message, setMessage] = useState("");

  useEffect(() => {
    setDraft({
      object_type: item.object_type ?? "",
      brand: item.brand ?? "",
      model: item.model ?? "",
      serial_number: item.serial_number ?? "",
      object_class_id: item.object_class_id ?? "",
      condition: item.condition ?? "gebraucht",
      review_status: item.review_status ?? "erfasst",
    });
  }, [item]);

  async function save() {
    await api(`/items/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        object_type: draft.object_type || null,
        brand: draft.brand || null,
        model: draft.model || null,
        serial_number: draft.serial_number || null,
        object_class_id: draft.object_class_id || null,
        condition: draft.condition,
        review_status: draft.review_status,
      }),
    });
    setMessage("Gespeichert");
    onChanged();
  }

  async function requestRework(role: "Buchhaltung" | "Erfasser", missingField: string) {
    await api(`/items/${item.id}/request-rework`, {
      method: "POST",
      body: JSON.stringify({
        assigned_role: role,
        missing_field: missingField,
        comment: `${missingField} im Raumtest nacharbeiten`,
      }),
    });
    setMessage(`Nacharbeit ${role}`);
    onChanged();
  }

  async function finalize() {
    try {
      await api(`/items/${item.id}/finalize`, { method: "POST", body: "{}" });
      setMessage("Finalisiert");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Finalisierung blockiert");
    }
  }

  async function removeItem() {
    const label = item.object_type || item.inventory_id || item.temporary_id || "Gegenstand";
    const confirmed = window.confirm(`Gegenstand "${label}" wirklich löschen? Fotos und Notizen bleiben im Uploadspeicher erhalten, der Datensatz wird aus dieser Session entfernt.`);
    if (!confirmed) return;
    try {
      await api(`/items/${item.id}`, { method: "DELETE" });
      setMessage("Gelöscht");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Gegenstand konnte nicht gelöscht werden");
    }
  }

  const blockers = item.blockers ?? [];
  const tasks = item.open_tasks ?? [];

  return (
    <div className="item-row">
      <div className="item-id">
        <strong>{item.inventory_id || item.temporary_id}</strong>
        <StatusBadge value={item.review_status} />
        <div className="evidence-row">
          <span className={item.has_object_photo ? "status geprueft" : "status upload_fehler"}>Foto</span>
          {item.has_nameplate_photo ? <span className="status geprueft">Typ</span> : null}
          {item.has_dot_photo ? <span className="status geprueft">DOT</span> : null}
        </div>
      </div>

      <div className="field compact-field">
        <input value={draft.object_type} onChange={(event) => setDraft({ ...draft, object_type: event.target.value })} placeholder="Objektart" />
      </div>

      <div className="detail-fields">
        <input value={draft.brand} onChange={(event) => setDraft({ ...draft, brand: event.target.value })} placeholder="Marke" />
        <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Modell" />
        <input value={draft.serial_number} onChange={(event) => setDraft({ ...draft, serial_number: event.target.value })} placeholder="Seriennummer" />
      </div>

      <select value={draft.object_class_id} onChange={(event) => setDraft({ ...draft, object_class_id: event.target.value })}>
        <option value="">Offen</option>
        {objectClasses.map((entry) => (
          <option key={entry.id} value={entry.id}>{entry.name}</option>
        ))}
      </select>

      <select value={draft.condition} onChange={(event) => setDraft({ ...draft, condition: event.target.value })}>
        {conditions.map((entry) => (
          <option key={entry} value={entry}>{entry}</option>
        ))}
      </select>

      <select value={draft.review_status} onChange={(event) => setDraft({ ...draft, review_status: event.target.value })}>
        {reviewStatuses.map((entry) => (
          <option key={entry} value={entry}>{entry}</option>
        ))}
      </select>

      <div className="row-actions">
        <button className="btn accent" onClick={save}>Speichern</button>
        <button className="btn secondary" onClick={() => requestRework("Erfasser", "Foto/Nachweis")}>Erfasser</button>
        <button className="btn secondary" onClick={() => requestRework("Buchhaltung", "Anlagenummer/Buchwert")}>Buchhaltung</button>
        <button className="btn" onClick={finalize}>Finalisieren</button>
        <button className="btn danger" onClick={removeItem}>Löschen</button>
      </div>

      {(blockers.length || tasks.length || message) ? (
        <div className="item-row-notes">
          {blockers.map((blocker) => <span className="status upload_fehler" key={blocker}>{blocker}</span>)}
          {tasks.map((task) => <span className="status nacharbeit_pruefer" key={task.id}>{task.assigned_role}: {task.missing_field}</span>)}
          {message ? <span className="status pruefen">{message}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
