"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { API_BASE, Bootstrap, api } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

type Task = {
  id: string;
  assigned_role: string;
  missing_field?: string;
};

type ProcessHint = {
  kind: string;
  label: string;
  severity: "info" | "ok" | "warn" | "danger";
};

type ReferenceMatch = {
  designation_de?: string;
  tool_no?: string;
  vag_no?: string;
  action?: string;
  note?: string;
  source_file?: string;
};

type AiSummary = {
  notes?: string;
  special_tool_matches?: ReferenceMatch[];
  inventory_history_matches?: ReferenceMatch[];
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
  value_estimate?: number | string | null;
  status?: string;
  review_status?: string;
  has_object_photo?: boolean;
  has_nameplate_photo?: boolean;
  has_dot_photo?: boolean;
  object_photo_id?: string;
  blockers?: string[];
  open_tasks?: Task[];
  process_hints?: ProcessHint[];
  ai_summary?: AiSummary;
};

const conditions = ["neu", "sehr_gut", "gut", "gebraucht", "reparaturbeduerftig", "defekt", "aussondern"];
const reviewStatuses = [
  "erfasst",
  "ki_vorgefuellt",
  "nacharbeit_erfasser",
  "nacharbeit_pruefer",
  "nacharbeit_buchhaltung",
  "nacharbeit_technik",
  "finalisierbar",
  "geprueft",
  "finalisiert",
  "abweichung",
];

const reviewStatusLabels: Record<string, string> = {
  erfasst: "Erfasst",
  ki_vorgefuellt: "KI vorgefüllt",
  nacharbeit_erfasser: "Noch zu ergänzen: Erfasser",
  nacharbeit_pruefer: "Noch zu ergänzen: Prüfer",
  nacharbeit_buchhaltung: "Noch zu ergänzen: Buchhaltung",
  nacharbeit_technik: "Noch zu ergänzen: Technik",
  finalisierbar: "Finalisierbar",
  geprueft: "Geprüft",
  finalisiert: "Finalisiert",
  abweichung: "Abweichung",
};

const reworkOptions = [
  { role: "Erfasser", label: "Erfasser: Foto/Nachweis", missingField: "Foto/Nachweis" },
  { role: "Technik", label: "Technik: UVV/Wartung/Prüfbuch", missingField: "UVV/Wartung/Prüfbuch" },
  { role: "Buchhaltung", label: "Buchhaltung: Anlagenummer/Buchwert", missingField: "Anlagenummer/Buchwert" },
] as const;

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
    <PhotoPreviewProvider>
      {(openPhoto) => (
        <div className="item-list">
          {items.map((item) => (
            <ItemReviewRow item={item} key={item.id} objectClasses={objectClasses} onChanged={onChanged} onOpenPhoto={openPhoto} />
          ))}
        </div>
      )}
    </PhotoPreviewProvider>
  );
}

function PhotoPreviewProvider({ children }: { children: (openPhoto: (url: string, label: string) => void) => ReactNode }) {
  const [photo, setPhoto] = useState<{ url: string; label: string } | null>(null);
  return (
    <>
      {children((url, label) => setPhoto({ url, label }))}
      {photo ? (
        <div className="photo-modal" role="dialog" aria-modal="true" onClick={() => setPhoto(null)}>
          <div className="photo-modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="photo-modal-head">
              <strong>{photo.label}</strong>
              <button className="btn secondary compact-btn" onClick={() => setPhoto(null)}>Schließen</button>
            </div>
            <img src={photo.url} alt={photo.label} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ItemReviewRow({
  item,
  objectClasses,
  onChanged,
  onOpenPhoto,
}: {
  item: ReviewItem;
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void;
  onOpenPhoto: (url: string, label: string) => void;
}) {
  const [draft, setDraft] = useState({
    object_type: item.object_type ?? "",
    brand: item.brand ?? "",
    model: item.model ?? "",
    serial_number: item.serial_number ?? "",
    value_estimate: item.value_estimate?.toString() ?? "",
    object_class_id: item.object_class_id ?? "",
    condition: item.condition ?? "gebraucht",
    review_status: item.review_status ?? "erfasst",
  });
  const [message, setMessage] = useState("");
  const [selectedRework, setSelectedRework] = useState<(typeof reworkOptions)[number]["label"]>(reworkOptions[0].label);

  useEffect(() => {
    setDraft({
      object_type: item.object_type ?? "",
      brand: item.brand ?? "",
      model: item.model ?? "",
      serial_number: item.serial_number ?? "",
      value_estimate: item.value_estimate?.toString() ?? "",
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
        value_estimate: draft.value_estimate ? Number(draft.value_estimate) : null,
        object_class_id: draft.object_class_id || null,
        condition: draft.condition,
        review_status: draft.review_status,
      }),
    });
    setMessage("Gespeichert");
    onChanged();
  }

  async function requestRework(role: "Buchhaltung" | "Erfasser" | "Technik", missingField: string) {
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

  async function requestSelectedRework() {
    const option = reworkOptions.find((entry) => entry.label === selectedRework) ?? reworkOptions[0];
    await requestRework(option.role, option.missingField);
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
  const hints = item.process_hints ?? [];
  const firstSpecial = item.ai_summary?.special_tool_matches?.[0];
  const firstHistory = item.ai_summary?.inventory_history_matches?.[0];
  const photoUrl = item.object_photo_id ? `${API_BASE}/uploads/photos/${item.object_photo_id}` : "";
  const photoLabel = item.object_type || item.inventory_id || item.temporary_id || "Objektfoto";

  return (
    <div className="item-row">
      <button
        className={`photo-thumb ${photoUrl ? "" : "is-empty"}`}
        type="button"
        onClick={() => photoUrl && onOpenPhoto(photoUrl, photoLabel)}
        disabled={!photoUrl}
        title={photoUrl ? "Foto groß öffnen" : "Kein Objektfoto vorhanden"}
      >
        {photoUrl ? <img src={photoUrl} alt={photoLabel} /> : <span>Kein Foto</span>}
      </button>

      <div className="item-main">
        <div className="item-title-line">
          <strong>{item.inventory_id || item.temporary_id}</strong>
          <StatusBadge value={item.review_status} />
          <span className={item.has_object_photo ? "status geprueft" : "status upload_fehler"}>Foto</span>
          {item.has_nameplate_photo ? <span className="status geprueft">Typenschild</span> : null}
          {item.has_dot_photo ? <span className="status geprueft">DOT</span> : null}
        </div>

        <div className="item-main-fields">
          <input value={draft.object_type} onChange={(event) => setDraft({ ...draft, object_type: event.target.value })} placeholder="Objektart" />
          <input value={draft.brand} onChange={(event) => setDraft({ ...draft, brand: event.target.value })} placeholder="Marke" />
          <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Modell" />
          <input value={draft.serial_number} onChange={(event) => setDraft({ ...draft, serial_number: event.target.value })} placeholder="Seriennummer" />
          <input
            value={draft.value_estimate}
            onChange={(event) => setDraft({ ...draft, value_estimate: event.target.value })}
            inputMode="decimal"
            placeholder="Schätzwert €"
          />
        </div>

        <div className="item-review-selects">
          <label>
            <span>Klasse</span>
            <select value={draft.object_class_id} onChange={(event) => setDraft({ ...draft, object_class_id: event.target.value })}>
              <option value="">Offen</option>
              {objectClasses.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Zustand</span>
            <select value={draft.condition} onChange={(event) => setDraft({ ...draft, condition: event.target.value })}>
              {conditions.map((entry) => (
                <option key={entry} value={entry}>{reviewStatusLabels[entry] ?? entry}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Bearbeitung</span>
            <select value={draft.review_status} onChange={(event) => setDraft({ ...draft, review_status: event.target.value })}>
              {reviewStatuses.map((entry) => (
                <option key={entry} value={entry}>{reviewStatusLabels[entry] ?? entry}</option>
              ))}
            </select>
          </label>
        </div>

        {(blockers.length || tasks.length || hints.length || firstSpecial || firstHistory || message) ? (
          <div className="item-row-notes">
            {hints.map((hint) => <span className={`hint-badge ${hint.severity}`} key={hint.kind}>{hint.label}</span>)}
            {firstSpecial ? (
              <span className="hint-badge info">Referenz: {firstSpecial.designation_de || firstSpecial.vag_no || firstSpecial.source_file}</span>
            ) : null}
            {firstHistory ? (
              <span className="hint-badge warn">Historie: {firstHistory.designation_de || firstHistory.tool_no || firstHistory.action || firstHistory.source_file}</span>
            ) : null}
            {blockers.map((blocker) => <span className="status upload_fehler" key={blocker}>{blocker}</span>)}
            {tasks.map((task) => <span className="status nacharbeit_pruefer" key={task.id}>{task.assigned_role}: {task.missing_field}</span>)}
            {message ? <span className="status pruefen">{message}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="row-actions">
        <button className="btn accent" onClick={save}>Speichern</button>
        <div className="rework-action">
          <select value={selectedRework} onChange={(event) => setSelectedRework(event.target.value as typeof selectedRework)}>
            {reworkOptions.map((option) => (
              <option key={option.label} value={option.label}>{option.label}</option>
            ))}
          </select>
          <button className="btn secondary" onClick={requestSelectedRework}>Nacharbeit</button>
        </div>
        <div className="final-actions">
          <button className="btn" onClick={finalize}>Finalisieren</button>
          <button className="btn danger icon-btn" onClick={removeItem} title="Löschen" aria-label="Gegenstand löschen">×</button>
        </div>
      </div>
    </div>
  );
}

