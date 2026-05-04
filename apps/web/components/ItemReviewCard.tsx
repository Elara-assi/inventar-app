"use client";

import { useEffect, useState } from "react";
import { Bootstrap, api } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

type Task = {
  id: string;
  assigned_role: string;
  missing_field?: string;
  comment?: string;
};

type Item = {
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
  commercial_category?: string;
  accounting_status?: string;
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

export function ItemReviewCard({
  item,
  objectClasses,
  onChanged,
}: {
  item: Item;
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState({
    object_class_id: item.object_class_id ?? "",
    condition: item.condition ?? "gebraucht",
    review_status: item.review_status ?? "erfasst",
    serial_number: item.serial_number ?? "",
  });
  const [details, setDetails] = useState<Item | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setDraft({
      object_class_id: item.object_class_id ?? "",
      condition: item.condition ?? "gebraucht",
      review_status: item.review_status ?? "erfasst",
      serial_number: item.serial_number ?? "",
    });
    api<Item>(`/items/${item.id}`).then(setDetails).catch(() => setDetails(null));
  }, [item]);

  const blockers = details?.blockers ?? item.blockers ?? [];
  const tasks = details?.open_tasks ?? item.open_tasks ?? [];

  async function save() {
    await api(`/items/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        object_class_id: draft.object_class_id || null,
        condition: draft.condition,
        review_status: draft.review_status,
        serial_number: draft.serial_number || null,
      }),
    });
    setMessage("Gespeichert");
    onChanged();
  }

  async function requestRework(role: "Buchhaltung" | "Erfasser" | "Pruefer", missingField: string) {
    await api(`/items/${item.id}/request-rework`, {
      method: "POST",
      body: JSON.stringify({
        assigned_role: role,
        missing_field: missingField,
        comment: `${missingField} im Raumtest nacharbeiten`,
      }),
    });
    setMessage(`Nacharbeit ${role} gesetzt`);
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

  return (
    <article className="card">
      <div className="photo-placeholder">{item.has_object_photo ? "Objektfoto vorhanden" : "Objektfoto fehlt"}</div>
      <div className="card-body grid">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "start" }}>
          <div>
            <strong>{item.object_type || "Neues Objekt"}</strong>
            <div className="muted">{item.inventory_id || item.temporary_id}</div>
          </div>
          <StatusBadge value={item.review_status} />
        </div>

        <div>{[item.brand, item.model].filter(Boolean).join(" ") || item.object_class_name || "KI wartet"}</div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="status erfasst">{item.condition || "gebraucht"}</span>
          {item.has_nameplate_photo ? <span className="status geprueft">Typenschild</span> : <span className="status pruefen">Typenschild offen</span>}
          {item.has_dot_photo ? <span className="status geprueft">DOT</span> : null}
        </div>

        <div className="grid grid-2">
          <label className="field">
            <span>Objektklasse</span>
            <select value={draft.object_class_id} onChange={(event) => setDraft({ ...draft, object_class_id: event.target.value })}>
              <option value="">Offen</option>
              {objectClasses.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Zustand</span>
            <select value={draft.condition} onChange={(event) => setDraft({ ...draft, condition: event.target.value })}>
              {conditions.map((entry) => (
                <option key={entry} value={entry}>{entry}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>Seriennummer</span>
          <input value={draft.serial_number} onChange={(event) => setDraft({ ...draft, serial_number: event.target.value })} placeholder="falls vorhanden" />
        </label>

        <label className="field">
          <span>Pruefstatus</span>
          <select value={draft.review_status} onChange={(event) => setDraft({ ...draft, review_status: event.target.value })}>
            {reviewStatuses.map((entry) => (
              <option key={entry} value={entry}>{entry}</option>
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
              <span className="status nacharbeit_pruefer" key={task.id}>{task.assigned_role}: {task.missing_field}</span>
            ))}
          </div>
        ) : null}

        <div className="quick-row">
          <button className="btn secondary" onClick={() => requestRework("Buchhaltung", "Anlagenummer/Buchwert")}>Buchhaltung</button>
          <button className="btn secondary" onClick={() => requestRework("Erfasser", "Foto/Nachweis")}>Erfasser</button>
        </div>
        <div className="quick-row">
          <button className="btn accent" onClick={save}>Speichern</button>
          <button className="btn" onClick={finalize}>Finalisieren</button>
        </div>
        {message ? <p className="status pruefen">{message}</p> : null}
      </div>
    </article>
  );
}
