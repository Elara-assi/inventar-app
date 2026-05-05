"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { API_BASE, Bootstrap, ItemTemplate, api } from "@/lib/api";
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
  deep_dive?: {
    estimated_by_ai?: boolean;
    web_search_performed?: boolean;
    query?: string;
    sources?: Array<{ title?: string; url?: string }>;
    estimated_age_years?: number | null;
    estimated_value?: number | null;
    estimated_value_range?: { min?: number; max?: number };
    value_source?: string;
    notes?: string;
  } | null;
};

type ItemPhoto = {
  id: string;
  photo_type: string;
  uploaded_at?: string;
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
  estimated_age_years?: number | string | null;
  age_source?: string;
  age_verification_status?: string;
  status?: string;
  review_status?: string;
  has_object_photo?: boolean;
  has_nameplate_photo?: boolean;
  has_dot_photo?: boolean;
  object_photo_id?: string;
  photos?: ItemPhoto[];
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
  nacharbeit_buchhaltung: "Später auswerten",
  nacharbeit_technik: "Noch zu ergänzen: Technik",
  finalisierbar: "Finalisierbar",
  geprueft: "Geprüft",
  finalisiert: "Finalisiert",
  abweichung: "Abweichung",
};

const reworkOptions = [
  { role: "Erfasser", label: "Erfasser: Foto/Nachweis", missingField: "Foto/Nachweis" },
  { role: "Technik", label: "Technik: UVV/Wartung/Prüfbuch", missingField: "UVV/Wartung/Prüfbuch" },
  { role: "Auswertung", label: "Spätere Auswertung: Wert/Zuordnung", missingField: "Wert/Zuordnung später klären" },
] as const;

function displayTaskRole(role?: string) {
  if (role === "Buchhaltung" || role === "Auswertung") return "Spätere Auswertung";
  return role || "Hinweis";
}

function displayTaskField(field?: string) {
  const value = field || "offen";
  const replacements: Record<string, string> = {
    Anschaffungsdatum: "Anschaffungsdatum später klären",
    Buchwert: "Wert später klären",
    Anlagenummer: "Zuordnung später klären",
    "Anlagenummer/Buchwert": "Wert/Zuordnung später klären",
  };
  return replacements[value] ?? value.replace(/^Buchhaltung:\s*/i, "").replace(/^BUCHHALTUNG:\s*/i, "");
}

const evidencePhotoTypes = [
  { type: "object", label: "Objektfoto", hint: "Gesamtansicht" },
  { type: "nameplate", label: "Typenschild", hint: "Seriennummer" },
  { type: "condition", label: "Rückseite/Zustand", hint: "Nachweis" },
  { type: "dot", label: "DOT", hint: "Reifen" },
  { type: "other", label: "Sonstiges", hint: "Zusatzfoto" },
] as const;

async function compressEvidencePhoto(file: File, photoType: string): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const maxSide = photoType === "nameplate" || photoType === "dot" ? 1600 : 1200;
  const quality = photoType === "nameplate" || photoType === "dot" ? 0.82 : 0.76;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    bitmap.close?.();
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    return file;
  }
}

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
  const [templateQuery, setTemplateQuery] = useState("");
  const [templates, setTemplates] = useState<ItemTemplate[]>([]);

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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!templateQuery.trim()) {
        setTemplates([]);
        return;
      }
      const search = new URLSearchParams({ q: templateQuery, limit: "8" });
      api<ItemTemplate[]>(`/item-templates?${search.toString()}`)
        .then(setTemplates)
        .catch(() => setTemplates([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [templateQuery]);

  function applyTemplate(template: ItemTemplate) {
    setDraft((current) => ({
      ...current,
      object_type: template.object_type || template.label,
      object_class_id: template.object_class_id || current.object_class_id,
      brand: template.brand || current.brand,
      model: template.model || current.model,
    }));
    setTemplateQuery(template.label);
    setTemplates([]);
    setMessage("Vorlage gewählt");
  }

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

  async function requestRework(role: "Auswertung" | "Erfasser" | "Technik", missingField: string) {
    await api(`/items/${item.id}/request-rework`, {
      method: "POST",
      body: JSON.stringify({
        assigned_role: role,
        missing_field: missingField,
        comment: `${missingField} im Raumtest nacharbeiten`,
      }),
    });
    setMessage(role === "Auswertung" ? "Spätere Auswertung markiert" : `Nacharbeit ${role}`);
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

  async function exportItem() {
    try {
      const result = await api<{ id: string }>(`/items/${item.id}/export/excel`, { method: "POST", body: "{}" });
      window.location.href = `${API_BASE}/exports/${result.id}/download`;
      setMessage("Excel erstellt");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Export fehlgeschlagen");
    }
  }

  async function runReviewAi() {
    try {
      await api(`/items/${item.id}/ai/run?mode=review`, { method: "POST", body: "{}" });
      setMessage("Prüf-KI gestartet");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Prüf-KI konnte nicht gestartet werden");
    }
  }

  async function runDeepDive() {
    try {
      await api(`/items/${item.id}/ai/deep-dive`, { method: "POST", body: "{}" });
      setMessage("KI Deep Dive gestartet");
      window.setTimeout(onChanged, 1200);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "KI Deep Dive konnte nicht gestartet werden");
    }
  }

  async function saveLearningExample() {
    try {
      await api(`/items/${item.id}/ai/learning-example`, {
        method: "POST",
        body: JSON.stringify({ notes: "Menschlich korrigierter Raumtest-Datensatz" }),
      });
      setMessage("Als KI-Beispiel gespeichert");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "KI-Beispiel konnte nicht gespeichert werden");
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

  async function uploadEvidencePhoto(photoType: string, file?: File) {
    if (!file) return;
    if ((item.photos?.length ?? 0) >= 5) {
      setMessage("Maximal 5 Fotos pro Gegenstand möglich");
      return;
    }
    try {
      setMessage("Foto wird hochgeladen");
      const prepared = await compressEvidencePhoto(file, photoType);
      const form = new FormData();
      form.append("file", prepared);
      await api(`/items/${item.id}/photos?photo_type=${photoType}`, { method: "POST", body: form });
      setMessage("Foto ergänzt");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Foto konnte nicht hochgeladen werden");
    }
  }

  const blockers = item.blockers ?? [];
  const tasks = item.open_tasks ?? [];
  const hints = item.process_hints ?? [];
  const firstSpecial = item.ai_summary?.special_tool_matches?.[0];
  const firstHistory = item.ai_summary?.inventory_history_matches?.[0];
  const deepDive = item.ai_summary?.deep_dive;
  const hasKiEstimate = Boolean(deepDive?.estimated_by_ai || item.age_source === "schaetzung");
  const itemPhotos = item.photos ?? [];
  const mainPhoto = itemPhotos.find((photo) => photo.photo_type === "object") ?? itemPhotos[0];
  const photoUrl = mainPhoto ? `${API_BASE}/uploads/photos/${mainPhoto.id}` : item.object_photo_id ? `${API_BASE}/uploads/photos/${item.object_photo_id}` : "";
  const photoLabel = item.object_type || item.inventory_id || item.temporary_id || "Objektfoto";
  const itemName = draft.object_type || "Unbekanntes Objekt";
  const itemMeta = [draft.brand, draft.model].filter(Boolean).join(" · ") || item.object_class_name || "Details offen";

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
          <div className="item-identity">
            <strong>{itemName}</strong>
            <span>{item.inventory_id || item.temporary_id} · {itemMeta}</span>
          </div>
          <StatusBadge value={item.review_status} />
          <span className={item.has_object_photo ? "status geprueft" : "status upload_fehler"}>{itemPhotos.length || (item.has_object_photo ? 1 : 0)}/5 Fotos</span>
          {item.has_nameplate_photo ? <span className="status geprueft">Typenschild</span> : null}
          {item.has_dot_photo ? <span className="status geprueft">DOT</span> : null}
        </div>

        {itemPhotos.length ? (
          <div className="photo-strip">
            {itemPhotos.map((photo, index) => {
              const label = `${photoLabel} · ${photo.photo_type}`;
              const url = `${API_BASE}/uploads/photos/${photo.id}`;
              return (
                <button key={photo.id} type="button" onClick={() => onOpenPhoto(url, label)} title={label}>
                  <img src={url} alt={label} />
                  <span>{index + 1}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="item-main-fields">
          <input value={draft.object_type} onChange={(event) => setDraft({ ...draft, object_type: event.target.value })} placeholder="Objektart" />
          <input value={draft.brand} onChange={(event) => setDraft({ ...draft, brand: event.target.value })} placeholder="Marke" />
          <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Modell" />
          <input value={draft.serial_number} onChange={(event) => setDraft({ ...draft, serial_number: event.target.value })} placeholder="Seriennummer" />
          <input
            value={draft.value_estimate}
            onChange={(event) => setDraft({ ...draft, value_estimate: event.target.value })}
            inputMode="decimal"
            placeholder={deepDive?.estimated_by_ai ? "KI-Schätzwert €" : "Schätzwert €"}
          />
        </div>

        {hasKiEstimate ? (
          <div className="ki-origin-strip">
            <span>KI-Herkunft</span>
            {draft.value_estimate ? <strong>Schätzwert: KI konservativ</strong> : null}
            {item.estimated_age_years ? <strong>Alter: KI geschätzt ({item.estimated_age_years} Jahre)</strong> : null}
            <small>Automatische Werte sind Vorschläge und werden im Excel als KI gekennzeichnet.</small>
          </div>
        ) : null}

        <div className="template-picker compact">
          <input
            value={templateQuery}
            placeholder="Vorlage suchen: Hebebühne, Wuchtmaschine, VAS ..."
            onChange={(event) => setTemplateQuery(event.target.value)}
          />
          {templates.length ? (
            <div className="template-results">
              {templates.map((template) => (
                <button className="template-result" key={template.id} type="button" onClick={() => applyTemplate(template)}>
                  <strong>{template.label}</strong>
                  <span>{template.source}{template.subtitle ? ` · ${template.subtitle}` : ""}</span>
                </button>
              ))}
            </div>
          ) : null}
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
            {tasks.map((task) => <span className="status nacharbeit_pruefer" key={task.id}>{displayTaskRole(task.assigned_role)}: {displayTaskField(task.missing_field)}</span>)}
            {message ? <span className="status pruefen">{message}</span> : null}
          </div>
        ) : null}
        {deepDive ? (
          <div className="deep-dive-box">
            <div>
              <strong>KI-Schätzung</strong>
              <span>Diese Werte sind automatisch recherchiert und müssen bei Bedarf fachlich bestätigt werden.</span>
            </div>
            <div className="deep-dive-grid">
              <span>Alter: <b>{deepDive.estimated_age_years ?? "offen"} Jahre</b></span>
              <span>Wert: <b>{deepDive.estimated_value ? `${deepDive.estimated_value} €` : "offen"}</b></span>
              <span>Quelle: <b>{deepDive.web_search_performed ? "Websuche + KI" : "KI-Schätzung ohne Webtreffer"}</b></span>
            </div>
            {deepDive.sources?.length ? (
              <div className="deep-dive-sources">
                {deepDive.sources.slice(0, 3).filter((source) => source.url).map((source) => (
                  <a key={source.url || source.title} href={source.url || "#"} target="_blank" rel="noreferrer">
                    {source.title || source.url}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="evidence-add-panel">
          <strong>Fotos ergänzen ({Math.min(itemPhotos.length, 5)}/5)</strong>
          <div className="evidence-add-grid">
            {evidencePhotoTypes.map((entry) => (
              <label className="btn secondary evidence-upload" key={entry.type}>
                <span>{entry.label}</span>
                <small>{entry.hint}</small>
                <input
                  type="file"
                  accept="image/*"
                  capture={entry.type === "nameplate" || entry.type === "dot" ? "environment" : undefined}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    void uploadEvidencePhoto(entry.type, file);
                  }}
                />
              </label>
            ))}
          </div>
        </div>
        <div className="row-actions">
          <button className="btn accent" onClick={save}>Speichern</button>
          <button className="btn" onClick={finalize}>Finalisieren</button>
          <div className="rework-action">
            <select value={selectedRework} onChange={(event) => setSelectedRework(event.target.value as typeof selectedRework)}>
              {reworkOptions.map((option) => (
                <option key={option.label} value={option.label}>{option.label}</option>
              ))}
            </select>
            <button className="btn secondary compact-btn" onClick={requestSelectedRework}>Nacharbeit setzen</button>
          </div>
          <button className="btn secondary compact-btn" onClick={runReviewAi}>KI Check</button>
          <button className="btn secondary compact-btn" onClick={runDeepDive}>KI Deep Dive</button>
          <button className="btn secondary compact-btn" onClick={saveLearningExample}>Als Beispiel merken</button>
          <button className="btn secondary compact-btn" onClick={exportItem}>Excel</button>
          <button className="btn danger icon-btn" onClick={removeItem} title="Löschen" aria-label="Gegenstand löschen">×</button>
        </div>
      </div>
    </div>
  );
}

