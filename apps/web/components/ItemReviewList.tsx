"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bootstrap, ItemTemplate, api, apiObjectUrl, downloadApiFile } from "@/lib/api";
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

type AiSuggestedFields = {
  object_type?: string | null;
  specification?: string | null;
  condition?: string | null;
  construction_year?: string | null;
  remark?: string | null;
};

type AiSummary = {
  notes?: string;
  confidence?: number | string | null;
  uncertainty_reason?: string | null;
  requires_manual_review?: boolean | null;
  suggested_fields?: AiSuggestedFields | null;
  bga_detection?: {
    object_name?: string | null;
    object_class?: string | null;
    confidence?: number | string | null;
    uncertainty_reason?: string | null;
    suggested_fields?: AiSuggestedFields | null;
    estimated_age_years?: number | string | null;
    estimated_value_eur?: number | string | null;
    estimated_value_reason?: string | null;
    age_reason?: string | null;
    requires_manual_review?: boolean | null;
  } | null;
  special_tool_matches?: ReferenceMatch[];
  inventory_history_matches?: ReferenceMatch[];
  deep_dive?: {
    estimated_by_ai?: boolean;
    web_search_performed?: boolean;
    search_provider?: string;
    web_search_error?: string | null;
    query?: string;
    search_queries?: string[];
    sources?: Array<{ title?: string; url?: string; snippet?: string; source_provider?: string }>;
    estimated_age_years?: number | null;
    estimated_value?: number | null;
    estimated_value_range?: { min?: number; max?: number };
    estimated_value_confidence?: number | null;
    estimated_value_reason?: string | null;
    age_confidence?: number | null;
    age_reason?: string | null;
    price_candidates?: Array<{ value?: number; source?: string; title?: string }>;
    value_source?: string;
    tire_valuation?: {
      lowest_new_price_basis?: number;
      dot_age_years?: number | null;
      profile_depth_mm?: number | null;
      season?: string;
      age_factor?: number;
      profile_factor?: number;
      condition_factor?: number;
      safety_factor?: number;
      policy?: string;
    };
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
  specification?: string;
  construction_year?: string;
  function_ok?: string;
  uvv_status?: string;
  uvv_valid_until?: string;
  inspection_book_available?: string;
  remark?: string;
  type_plate_status?: string;
  sequence_number?: number;
  inventory_type?: string;
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

const conditions = ["neu", "sehr_gut", "gut", "gebraucht", "reparaturbeduerftig", "defekt", "unklar", "aussondern"];
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

const conditionLabels: Record<string, string> = {
  neu: "neu",
  sehr_gut: "sehr gut",
  gut: "gut",
  gebraucht: "gebraucht",
  reparaturbeduerftig: "reparaturbedürftig",
  defekt: "defekt",
  aussondern: "aussondern",
  unklar: "unklar",
};

const functionLabels: Record<string, string> = {
  ja: "Ja",
  nein: "Nein",
  nicht_geprueft: "Nicht geprüft",
};

const uvvLabels: Record<string, string> = {
  vorhanden: "vorhanden",
  nicht_vorhanden: "nicht vorhanden",
  nicht_uvv_pflichtig: "nicht UVV-pflichtig",
  unklar: "unklar",
};

const inspectionBookLabels: Record<string, string> = {
  ja: "Ja",
  nein: "Nein",
  nicht_erforderlich: "Nicht erforderlich",
  unklar: "Unklar",
};

const baseReworkOptions = [
  { role: "Erfasser", label: "Erfasser: Foto/Nachweis", missingField: "Foto/Nachweis" },
  { role: "Technik", label: "Technik: UVV/Funktion", missingField: "UVV/Funktion prüfen" },
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

function reviewSortPriority(item: ReviewItem) {
  if ((item.blockers?.length ?? 0) > 0) return 0;
  if ((item.open_tasks?.length ?? 0) > 0) return 1;
  if (!item.object_type || !item.has_object_photo) return 2;
  if (item.status?.startsWith("ki_")) return 3;
  if (item.review_status === "finalisiert" || item.status === "finalisiert") return 5;
  return 4;
}

type ReviewFilterKey = "all" | "rework" | "missing_photo" | "function" | "uvv" | "ready" | "finalized";

function isFinalized(item: ReviewItem) {
  return item.review_status === "finalisiert" || item.status === "finalisiert";
}

function hasObjectPhoto(item: ReviewItem) {
  return Boolean(item.has_object_photo || item.object_photo_id || item.photos?.some((photo) => photo.photo_type === "object" || photo.photo_type === "object_front"));
}

function needsRework(item: ReviewItem) {
  return (item.blockers?.length ?? 0) > 0
    || (item.open_tasks?.length ?? 0) > 0
    || item.review_status?.startsWith("nacharbeit")
    || item.process_hints?.some((hint) => hint.severity === "warn" || hint.severity === "danger");
}

function matchesReviewFilter(item: ReviewItem, filter: ReviewFilterKey) {
  if (filter === "all") return true;
  if (filter === "rework") return needsRework(item);
  if (filter === "missing_photo") return !hasObjectPhoto(item);
  if (filter === "function") return item.function_ok === "nein" || item.function_ok === "nicht_geprueft";
  if (filter === "uvv") return ["unklar", "nicht_vorhanden", "abgelaufen"].includes(item.uvv_status ?? "");
  if (filter === "ready") return !isFinalized(item) && (item.blockers?.length ?? 0) === 0;
  if (filter === "finalized") return isFinalized(item);
  return true;
}

const reviewFilters: Array<{ key: ReviewFilterKey; label: string; empty: string }> = [
  { key: "all", label: "Alle", empty: "Noch keine Gegenstände in dieser Ansicht." },
  { key: "rework", label: "Nacharbeit", empty: "Sehr gut: keine offene Nacharbeit." },
  { key: "missing_photo", label: "Ohne Foto", empty: "Alle sichtbaren Gegenstände haben ein Objektfoto." },
  { key: "function", label: "Funktion offen", empty: "Keine offene oder negative Funktionsprüfung." },
  { key: "uvv", label: "UVV offen", empty: "Keine offenen UVV-Punkte." },
  { key: "ready", label: "Finalisierbar", empty: "Noch nichts ist finalisierbar." },
  { key: "finalized", label: "Finalisiert", empty: "Noch keine finalisierten Gegenstände." },
];

const evidencePhotoTypes = [
  { type: "object_front", label: "Objektfoto", hint: "Gesamtansicht" },
  { type: "type_plate", label: "Typenschild", hint: "Seriennummer" },
  { type: "condition_detail", label: "Zustandsfoto", hint: "Schaden/Detail" },
  { type: "uvv_label", label: "UVV-Siegel", hint: "Prüfplakette" },
  { type: "other", label: "Weiteres Foto", hint: "Zusatznachweis" },
] as const;

async function compressEvidencePhoto(file: File, photoType: string): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const maxSide = photoType === "nameplate" || photoType === "type_plate" || photoType === "uvv_label" || photoType === "dot" || photoType === "condition_detail" ? 2400 : 1600;
  const quality = photoType === "nameplate" || photoType === "type_plate" || photoType === "uvv_label" || photoType === "dot" || photoType === "condition_detail" ? 0.9 : 0.86;
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
  readOnly = false,
}: {
  items: ReviewItem[];
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const [activeFilter, setActiveFilter] = useState<ReviewFilterKey>("all");
  const visibleItems = useMemo(
    () => items.filter((item) => matchesReviewFilter(item, activeFilter)).sort((left, right) => {
      const priority = reviewSortPriority(left) - reviewSortPriority(right);
      if (priority !== 0) return priority;
      return (left.sequence_number ?? 999999) - (right.sequence_number ?? 999999);
    }),
    [activeFilter, items],
  );
  const filterCounts = useMemo(
    () => reviewFilters.reduce<Record<ReviewFilterKey, number>>((acc, filter) => {
      acc[filter.key] = items.filter((item) => matchesReviewFilter(item, filter.key)).length;
      return acc;
    }, {
      all: 0,
      rework: 0,
      missing_photo: 0,
      function: 0,
      uvv: 0,
      ready: 0,
      finalized: 0,
    }),
    [items],
  );

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
        <>
          <div className="review-filter-bar" aria-label="Prüfliste filtern">
            {reviewFilters.map((filter) => (
              <button
                className={activeFilter === filter.key ? "active" : ""}
                key={filter.key}
                type="button"
                onClick={() => setActiveFilter(filter.key)}
              >
                <span>{filter.label}</span>
                <b>{filterCounts[filter.key]}</b>
              </button>
            ))}
          </div>
          {visibleItems.length ? (
            <div className="item-list">
              {visibleItems.map((item) => (
                <ItemReviewRow item={item} key={item.id} objectClasses={objectClasses} onChanged={onChanged} onOpenPhoto={openPhoto} readOnly={readOnly} />
              ))}
            </div>
          ) : (
            <div className="filter-empty-state">
              <strong>{reviewFilters.find((filter) => filter.key === activeFilter)?.empty}</strong>
              <span>Mit den Filtern springt der Prüfer direkt zu den relevanten Gegenständen.</span>
            </div>
          )}
        </>
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

function useApiObjectUrl(path: string) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!path) {
      setUrl("");
      return;
    }
    let active = true;
    let objectUrl = "";
    apiObjectUrl(path)
      .then((nextUrl) => {
        if (!active) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        objectUrl = nextUrl;
        setUrl(nextUrl);
      })
      .catch(() => setUrl(""));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url;
}

function AuthPhotoButton({
  path,
  label,
  className = "",
  badge,
  onOpenPhoto,
}: {
  path: string;
  label: string;
  className?: string;
  badge?: string;
  onOpenPhoto: (url: string, label: string) => void;
}) {
  const url = useApiObjectUrl(path);
  const hasPath = Boolean(path);
  return (
    <button
      className={`${className} ${url ? "" : "is-empty"}`.trim()}
      type="button"
      onClick={() => url && onOpenPhoto(url, label)}
      disabled={!url}
      title={url ? "Foto groß öffnen" : hasPath ? "Foto wird geladen" : "Kein Foto vorhanden"}
    >
      {url ? <img src={url} alt={label} /> : <span>{hasPath ? "Foto laden" : "Kein Foto"}</span>}
      {badge ? <span>{badge}</span> : null}
    </button>
  );
}

function ItemReviewRow({
  item,
  objectClasses,
  onChanged,
  onOpenPhoto,
  readOnly,
}: {
  item: ReviewItem;
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void;
  onOpenPhoto: (url: string, label: string) => void;
  readOnly: boolean;
}) {
  const editPanelRef = useRef<HTMLDivElement | null>(null);
  const inventoryType = item.inventory_type || "bga";
  const isBga = inventoryType === "bga";
  const reworkOptions = useMemo(
    () => isBga
      ? baseReworkOptions
      : [
          baseReworkOptions[0],
          { role: "Technik", label: "Technik: UVV/Wartung/Prüfbuch", missingField: "UVV/Wartung/Prüfbuch" },
          baseReworkOptions[2],
        ] as const,
    [isBga],
  );
  const [draft, setDraft] = useState({
    object_type: item.object_type ?? "",
    brand: item.brand ?? "",
    model: item.model ?? "",
    serial_number: item.serial_number ?? "",
    specification: item.specification ?? "",
    construction_year: item.construction_year ?? "",
    function_ok: item.function_ok ?? "nicht_geprueft",
    uvv_status: item.uvv_status ?? "unklar",
    uvv_valid_until: item.uvv_valid_until ?? "",
    inspection_book_available: item.inspection_book_available ?? "unklar",
    remark: item.remark ?? "",
    type_plate_status: item.type_plate_status ?? "nicht_geprueft",
    value_estimate: item.value_estimate?.toString() ?? "",
    estimated_age_years: item.estimated_age_years?.toString() ?? "",
    object_class_id: item.object_class_id ?? "",
    condition: item.condition ?? "gebraucht",
    review_status: item.review_status ?? "erfasst",
  });
  const [message, setMessage] = useState("");
  const [selectedRework, setSelectedRework] = useState<string>(reworkOptions[0].label);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templates, setTemplates] = useState<ItemTemplate[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    setDraft({
      object_type: item.object_type ?? "",
      brand: item.brand ?? "",
      model: item.model ?? "",
      serial_number: item.serial_number ?? "",
      specification: item.specification ?? "",
      construction_year: item.construction_year ?? "",
      function_ok: item.function_ok ?? "nicht_geprueft",
      uvv_status: item.uvv_status ?? "unklar",
      uvv_valid_until: item.uvv_valid_until ?? "",
      inspection_book_available: item.inspection_book_available ?? "unklar",
      remark: item.remark ?? "",
      type_plate_status: item.type_plate_status ?? "nicht_geprueft",
      value_estimate: item.value_estimate?.toString() ?? "",
      estimated_age_years: item.estimated_age_years?.toString() ?? "",
      object_class_id: item.object_class_id ?? "",
      condition: item.condition ?? "gebraucht",
      review_status: item.review_status ?? "erfasst",
    });
  }, [item]);

  useEffect(() => {
    if (!reworkOptions.some((option) => option.label === selectedRework)) {
      setSelectedRework(reworkOptions[0].label);
    }
  }, [reworkOptions, selectedRework]);

  useEffect(() => {
    if (!editOpen) return;
    window.setTimeout(() => {
      editPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, [editOpen]);

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

  function applyAiSuggestionToDraft() {
    const detection = item.ai_summary?.bga_detection;
    const fields = detection?.suggested_fields ?? item.ai_summary?.suggested_fields ?? {};
    setDraft((current) => ({
      ...current,
      object_type: current.object_type || fields.object_type || detection?.object_name || "",
      specification: current.specification || fields.specification || "",
      construction_year: current.construction_year || fields.construction_year || "",
      remark: current.remark || fields.remark || current.remark,
      condition: current.condition || fields.condition || "gebraucht",
    }));
    setMessage("KI-Vorschlag in leere Felder übernommen. Bitte prüfen und speichern.");
  }

  function applyDeepDiveEstimate(kind: "age" | "value" | "both") {
    setDraft((current) => ({
      ...current,
      estimated_age_years:
        (kind === "age" || kind === "both") && deepDive?.estimated_age_years != null
          ? String(deepDive.estimated_age_years)
          : current.estimated_age_years,
      value_estimate:
        (kind === "value" || kind === "both") && deepDive?.estimated_value != null
          ? String(deepDive.estimated_value)
          : current.value_estimate,
    }));
    setMessage("KI-Schätzung übernommen. Bitte fachlich prüfen und speichern.");
  }

  async function save() {
    if (readOnly) return;
    await api(`/items/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        object_type: draft.object_type || null,
        brand: draft.brand || null,
        model: draft.model || null,
        serial_number: draft.serial_number || null,
        specification: draft.specification || null,
        construction_year: draft.construction_year || null,
        function_ok: draft.function_ok,
        uvv_status: draft.uvv_status,
        uvv_valid_until: draft.uvv_valid_until || null,
        inspection_book_available: draft.inspection_book_available,
        remark: draft.remark || null,
        type_plate_status: draft.type_plate_status,
        value_estimate: draft.value_estimate ? Number(draft.value_estimate) : null,
        object_class_id: draft.object_class_id || null,
        condition: draft.condition,
        estimated_age_years: draft.estimated_age_years ? Number(draft.estimated_age_years) : null,
        age_source: draft.estimated_age_years ? "manuell" : null,
        age_verification_status: draft.estimated_age_years ? "geprueft" : "offen",
        review_status: draft.review_status,
      }),
    });
    setMessage("Gespeichert");
    onChanged();
  }

  async function requestRework(role: "Auswertung" | "Erfasser" | "Technik", missingField: string) {
    if (readOnly) return;
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
    await requestRework(option.role as "Auswertung" | "Erfasser" | "Technik", option.missingField);
  }

  async function finalize() {
    if (readOnly) return;
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
      await downloadApiFile(`/exports/${result.id}/download`, `aufnahme-${item.id}.xlsx`);
      setMessage("Excel erstellt");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Export fehlgeschlagen");
    }
  }

  async function runReviewAi() {
    if (readOnly) return;
    try {
      await api(`/items/${item.id}/ai/run?mode=review`, { method: "POST", body: "{}" });
      setMessage("Prüf-KI gestartet");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Prüf-KI konnte nicht gestartet werden");
    }
  }

  async function runDeepDive() {
    if (readOnly) return;
    try {
      await api(`/items/${item.id}/ai/deep-dive`, { method: "POST", body: "{}" });
      setMessage("KI-Websuche gestartet");
      window.setTimeout(onChanged, 1200);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "KI-Websuche konnte nicht gestartet werden");
    }
  }

  async function saveLearningExample() {
    if (readOnly) return;
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
    if (readOnly) return;
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
    if (readOnly) return;
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
  const aiProposal = item.ai_summary?.bga_detection;
  const aiProposalFields = aiProposal?.suggested_fields ?? item.ai_summary?.suggested_fields;
  const deepDive = item.ai_summary?.deep_dive;
  const itemPhotos = item.photos ?? [];
  const mainPhoto = itemPhotos.find((photo) => photo.photo_type === "object" || photo.photo_type === "object_front") ?? itemPhotos[0];
  const photoPath = mainPhoto ? `/uploads/photos/${mainPhoto.id}` : item.object_photo_id ? `/uploads/photos/${item.object_photo_id}` : "";
  const photoLabel = item.object_type || item.inventory_id || item.temporary_id || "Objektfoto";
  const filteredObjectClasses = useMemo(
    () => objectClasses.filter((entry) => {
      const name = `${entry.name} ${entry.slug ?? ""}`.toLowerCase();
      if (isBga) return !["reifen", "reifen/räder", "reifenraeder", "tires_wheels", "special_tools", "spezialwerkzeuge"].some((blocked) => name === blocked || name.includes(` ${blocked}`));
      return true;
    }),
    [isBga, objectClasses],
  );
  const itemName = draft.object_type || "Unbekanntes Objekt";
  const selectedClassName = filteredObjectClasses.find((entry) => entry.id === draft.object_class_id)?.name || item.object_class_name || "Offen";
  const itemMeta = [draft.specification, draft.brand, draft.model].filter(Boolean).join(" · ") || selectedClassName || "Details offen";
  const isAiEstimate = Boolean(deepDive?.estimated_by_ai || item.age_source === "schaetzung" || item.age_verification_status === "geschaetzt");
  const compactValue = draft.value_estimate ? `${draft.value_estimate} €${isAiEstimate ? " (KI)" : ""}` : deepDive?.estimated_value ? `${deepDive.estimated_value} € (KI)` : "Wert offen";
  const compactKi = deepDive
    ? `${deepDive.estimated_age_years ?? "Alter offen"} Jahre · ${deepDive.estimated_value ?? "Wert offen"} €`
    : isAiEstimate
      ? `${item.estimated_age_years ?? "Alter offen"} Jahre · ${item.value_estimate ?? "Wert offen"} €`
      : item.status?.startsWith("ki_") ? "KI läuft" : "";
  const blockerSummary = blockers.slice(0, 3).map(displayTaskField).join(", ");
  const finalizeBlocked = blockers.length > 0;
  const finalizableLabel = finalizeBlocked ? "Noch offen" : "Finalisieren";

  return (
    <div className="item-row">
      <AuthPhotoButton path={photoPath} label={photoLabel} className="photo-thumb" onOpenPhoto={onOpenPhoto} />

      <div className="item-main">
        {readOnly ? <div className="locked-strip">Raum abgeschlossen: Dieser Datensatz ist schreibgeschützt.</div> : null}
        <div className="item-title-line">
          <div className="item-identity">
            <strong>{itemName}</strong>
          <span>{item.inventory_id || item.temporary_id} · {item.sequence_number ? `Nr. ${item.sequence_number} · ` : ""}{itemMeta}</span>
          </div>
          <StatusBadge value={item.review_status} />
          <span className={item.has_object_photo ? "status geprueft" : "status upload_fehler"}>{itemPhotos.length || (item.has_object_photo ? 1 : 0)}/5 Fotos</span>
        </div>

        <div className="item-compact-grid">
          <span><b>Klasse</b>{selectedClassName}</span>
          <span><b>Zustand</b>{conditionLabels[draft.condition] ?? draft.condition}</span>
          <span><b>Bearbeitung</b>{reviewStatusLabels[draft.review_status] ?? draft.review_status}</span>
          <span><b>Funktion</b>{functionLabels[draft.function_ok] ?? draft.function_ok}</span>
          <span><b>UVV</b>{uvvLabels[draft.uvv_status] ?? draft.uvv_status}</span>
          <span><b>Schätzwert</b>{compactValue}</span>
          {compactKi ? <span className={isAiEstimate ? "ki-estimate-cell" : ""}><b>{isAiEstimate ? "KI-Schätzung" : "KI"}</b>{compactKi}</span> : null}
        </div>
        {blockerSummary ? (
          <div className="blocker-summary">
            <strong>Fehlt für Abschluss</strong>
            <span>{blockerSummary}</span>
          </div>
        ) : null}

        {itemPhotos.length > 1 ? (
          <div className="photo-strip compact-strip">
            {itemPhotos.slice(0, 5).map((photo, index) => {
                const label = `${photoLabel} · ${photo.photo_type}`;
                return (
                  <AuthPhotoButton key={photo.id} path={`/uploads/photos/${photo.id}`} label={label} badge={`${index + 1}`} onOpenPhoto={onOpenPhoto} />
                );
              })}
          </div>
        ) : null}

        <div className="compact-row-actions">
          <button className="btn secondary compact-btn" type="button" onClick={() => setEditOpen((current) => !current)}>
            {editOpen ? "Schließen" : "Bearbeiten"}
          </button>
          <button className="btn" onClick={finalize} disabled={readOnly || finalizeBlocked} title={finalizeBlocked ? `Fehlt: ${blockerSummary}` : "Datensatz finalisieren"}>
            {finalizableLabel}
          </button>
          <button className="btn secondary compact-btn" type="button" onClick={runDeepDive} disabled={readOnly}>
            KI-Websuche
          </button>
          <button className="btn secondary compact-btn" type="button" onClick={() => setMoreOpen((current) => !current)}>Mehr</button>
        </div>

        {editOpen ? (
          <div className="item-edit-panel" ref={editPanelRef}>
            <div className="item-edit-head">
              <div>
                <strong>{itemName}</strong>
                <span>Prüfen, korrigieren, speichern. Manuelle Eingaben sind führend.</span>
              </div>
              <button className="btn secondary compact-btn" type="button" onClick={() => setEditOpen(false)}>Fertig</button>
            </div>
            <section className="item-edit-section">
              <div className="item-edit-section-head">
                <strong>Stammdaten</strong>
                <span>Was ist es?</span>
              </div>
            <div className="item-main-fields">
              <input disabled={readOnly} value={draft.object_type} onChange={(event) => setDraft({ ...draft, object_type: event.target.value })} placeholder="Objektart" />
              <input disabled={readOnly} value={draft.specification} onChange={(event) => setDraft({ ...draft, specification: event.target.value })} placeholder="Typ / Spezifikation" />
              <input disabled={readOnly} value={draft.brand} onChange={(event) => setDraft({ ...draft, brand: event.target.value })} placeholder="Marke" />
              <input disabled={readOnly} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Modell" />
              <input disabled={readOnly} value={draft.serial_number} onChange={(event) => setDraft({ ...draft, serial_number: event.target.value })} placeholder="Seriennummer" />
              <input disabled={readOnly} value={draft.construction_year} onChange={(event) => setDraft({ ...draft, construction_year: event.target.value })} placeholder="Baujahr" />
              <input
                disabled={readOnly}
                value={draft.value_estimate}
                onChange={(event) => setDraft({ ...draft, value_estimate: event.target.value })}
                inputMode="decimal"
                placeholder={deepDive?.estimated_by_ai ? "KI-Schätzwert €" : "Schätzwert €"}
              />
              <input
                disabled={readOnly}
                value={draft.estimated_age_years}
                onChange={(event) => setDraft({ ...draft, estimated_age_years: event.target.value })}
                inputMode="decimal"
                placeholder={deepDive?.estimated_by_ai ? "KI-Alter Jahre" : "Alter Jahre"}
              />
            </div>
            </section>

            <section className="item-edit-section">
              <div className="item-edit-section-head">
                <strong>Zustand & Prüfung</strong>
                <span>Was entscheidet der Prüfer?</span>
              </div>
            <div className="item-review-selects bga-review-selects">
              <label>
                <span>Funktion i. O.</span>
                <select disabled={readOnly} value={draft.function_ok} onChange={(event) => setDraft({ ...draft, function_ok: event.target.value })}>
                  <option value="ja">Ja</option>
                  <option value="nein">Nein</option>
                  <option value="nicht_geprueft">Nicht geprüft</option>
                </select>
              </label>
              <label>
                <span>UVV Status</span>
                <select disabled={readOnly} value={draft.uvv_status} onChange={(event) => setDraft({ ...draft, uvv_status: event.target.value })}>
                  <option value="vorhanden">UVV vorhanden</option>
                  <option value="nicht_vorhanden">UVV nicht vorhanden</option>
                  <option value="nicht_uvv_pflichtig">nicht UVV-pflichtig</option>
                  <option value="unklar">unklar</option>
                </select>
              </label>
              <label>
                <span>UVV gültig bis</span>
                <input disabled={readOnly} type="date" value={draft.uvv_valid_until} onChange={(event) => setDraft({ ...draft, uvv_valid_until: event.target.value })} />
              </label>
              {!isBga ? <label>
                <span>Prüfbuch</span>
                <select disabled={readOnly} value={draft.inspection_book_available} onChange={(event) => setDraft({ ...draft, inspection_book_available: event.target.value })}>
                  <option value="ja">Ja</option>
                  <option value="nein">Nein</option>
                  <option value="nicht_erforderlich">Nicht erforderlich</option>
                  <option value="unklar">Unklar</option>
                </select>
              </label> : null}
            </div>
            </section>

            <section className="item-edit-section">
              <div className="item-edit-section-head">
                <strong>Vorlage & Status</strong>
                <span>Optional schneller zuordnen</span>
              </div>
            <div className="template-picker compact">
              <input
                value={templateQuery}
                disabled={readOnly}
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
                <select disabled={readOnly} value={draft.object_class_id} onChange={(event) => setDraft({ ...draft, object_class_id: event.target.value })}>
                  <option value="">Offen</option>
                  {filteredObjectClasses.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Zustand</span>
                <select disabled={readOnly} value={draft.condition} onChange={(event) => setDraft({ ...draft, condition: event.target.value })}>
                  {conditions.map((entry) => (
                    <option key={entry} value={entry}>{conditionLabels[entry] ?? entry}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Bearbeitung</span>
                <select disabled={readOnly} value={draft.review_status} onChange={(event) => setDraft({ ...draft, review_status: event.target.value })}>
                  {reviewStatuses.map((entry) => (
                    <option key={entry} value={entry}>{reviewStatusLabels[entry] ?? entry}</option>
                  ))}
                </select>
              </label>
            </div>
            </section>

            <section className="item-edit-section">
              <div className="item-edit-section-head">
                <strong>Bemerkung & Nachweise</strong>
                <span>Was fehlt noch?</span>
              </div>
            <label className="field">
              <span>Bemerkung</span>
              <textarea disabled={readOnly} rows={3} value={draft.remark} onChange={(event) => setDraft({ ...draft, remark: event.target.value })} placeholder="Bemerkung aus der Aufnahme" />
            </label>

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
            {aiProposal || aiProposalFields ? (
              <details className="deep-dive-box">
                <summary>
                  <strong>KI-Vorschlag</strong>
                  <span>
                    {aiProposalFields?.object_type || aiProposal?.object_name || "Vorschlag vorhanden"}
                    {aiProposal?.confidence ? ` · ${(Number(aiProposal.confidence) * 100).toFixed(0)} %` : ""}
                  </span>
                </summary>
                <p className="deep-dive-note">Vorschlag – bitte prüfen. Er wird erst durch Übernahme und Speichern zum Datensatz.</p>
                <div className="deep-dive-grid">
                  <span>Bezeichnung: <b>{aiProposalFields?.object_type || aiProposal?.object_name || "offen"}</b></span>
                  <span>Klasse: <b>{aiProposal?.object_class || "offen"}</b></span>
                  <span>Typ/Spezifikation: <b>{aiProposalFields?.specification || "offen"}</b></span>
                  <span>Zustand: <b>{aiProposalFields?.condition || "offen"}</b></span>
                </div>
                {aiProposal?.estimated_age_years || aiProposal?.estimated_value_eur ? (
                  <p className="deep-dive-note">
                    KI-Schätzung: {aiProposal.estimated_age_years ?? "Alter offen"} Jahre · {aiProposal.estimated_value_eur ?? "Wert offen"} €. Manuell prüfen.
                  </p>
                ) : null}
                {aiProposal?.uncertainty_reason || item.ai_summary?.uncertainty_reason ? (
                  <p className="deep-dive-note">{aiProposal?.uncertainty_reason || item.ai_summary?.uncertainty_reason}</p>
                ) : null}
                <button className="btn secondary compact-btn" type="button" onClick={applyAiSuggestionToDraft} disabled={readOnly}>
                  In leere Felder übernehmen
                </button>
              </details>
            ) : null}
            {deepDive ? (
              <details className="deep-dive-box">
            <summary>
              <strong>KI-Schätzung</strong>
              <span>
                {deepDive.estimated_age_years ? `${deepDive.estimated_age_years} Jahre` : "Alter offen"}
                {" · "}
                {deepDive.estimated_value ? `${deepDive.estimated_value} €` : "Wert offen"}
                {deepDive.web_search_performed ? " · Websuche" : ""}
              </span>
            </summary>
            <p className="deep-dive-note">Schätzung – bitte prüfen. Manuelle Eingaben im Datensatz sind führend.</p>
            <div className="deep-dive-grid">
              <span>Alter: <b>{deepDive.estimated_age_years ?? "offen"} Jahre</b></span>
              <span>Wert: <b>{deepDive.estimated_value ? `${deepDive.estimated_value} €` : "offen"}</b></span>
              <span>Quelle: <b>{deepDive.web_search_performed ? `Websuche (${deepDive.search_provider || "Quelle"})` : "Keine verwertbare Webquelle"}</b></span>
            </div>
            <div className="deep-dive-actions">
              <button
                className="btn secondary compact-btn"
                type="button"
                onClick={() => applyDeepDiveEstimate("value")}
                disabled={readOnly || deepDive.estimated_value == null}
              >
                Wert übernehmen
              </button>
              <button
                className="btn secondary compact-btn"
                type="button"
                onClick={() => applyDeepDiveEstimate("age")}
                disabled={readOnly || deepDive.estimated_age_years == null}
              >
                Alter übernehmen
              </button>
              <button
                className="btn secondary compact-btn"
                type="button"
                onClick={() => applyDeepDiveEstimate("both")}
                disabled={readOnly || (deepDive.estimated_value == null && deepDive.estimated_age_years == null)}
              >
                Schätzung übernehmen
              </button>
            </div>
            {deepDive.estimated_value_reason || deepDive.age_reason ? (
              <p className="deep-dive-note">
                {deepDive.estimated_value_reason || "Wertgrundlage offen"}
                {deepDive.age_reason ? ` · ${deepDive.age_reason}` : ""}
              </p>
            ) : null}
            {deepDive.price_candidates?.length ? (
              <div className="deep-dive-grid">
                {deepDive.price_candidates.slice(0, 3).map((candidate, index) => (
                  <span key={`${candidate.source || "price"}-${index}`}>
                    Preisfund: <b>{candidate.value ? `${candidate.value} €` : "offen"}</b>
                  </span>
                ))}
              </div>
            ) : null}
            {deepDive.tire_valuation ? (
              <div className="deep-dive-grid">
                <span>Reifen-Neupreis: <b>{deepDive.tire_valuation.lowest_new_price_basis ?? "offen"} €</b></span>
                <span>DOT-Alter: <b>{deepDive.tire_valuation.dot_age_years ?? "offen"} Jahre</b></span>
                <span>Profil: <b>{deepDive.tire_valuation.profile_depth_mm ?? "offen"} mm</b></span>
              </div>
            ) : null}
            {deepDive.notes ? <p className="deep-dive-note">{deepDive.notes}</p> : null}
            {deepDive.web_search_error ? <p className="deep-dive-note">Suchhinweis: {deepDive.web_search_error}</p> : null}
            {deepDive.sources?.length ? (
              <div className="deep-dive-sources">
                {deepDive.sources.slice(0, 3).filter((source) => source.url).map((source) => (
                  <a key={source.url || source.title} href={source.url || "#"} target="_blank" rel="noreferrer">
                    {source.title || source.url}
                  </a>
                ))}
              </div>
            ) : null}
              </details>
            ) : null}
            <details className="evidence-add-panel">
              <summary>Fotos ergänzen ({Math.min(itemPhotos.length, 5)}/5)</summary>
              <div className="evidence-add-grid">
                {evidencePhotoTypes.map((entry) => (
                  <label className={`btn secondary evidence-upload ${readOnly ? "is-disabled" : ""}`} key={entry.type}>
                    <span>{entry.label}</span>
                    <small>{entry.hint}</small>
                    {readOnly ? null : <input
                      type="file"
                      accept="image/*"
                      capture={entry.type === "type_plate" || entry.type === "uvv_label" ? "environment" : undefined}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        void uploadEvidencePhoto(entry.type, file);
                      }}
                    />}
                  </label>
                ))}
              </div>
            </details>
            <div className="row-actions">
              <button className="btn accent" onClick={save} disabled={readOnly}>Speichern</button>
              <div className="rework-action">
                <select disabled={readOnly} value={selectedRework} onChange={(event) => setSelectedRework(event.target.value as typeof selectedRework)}>
                  {reworkOptions.map((option) => (
                    <option key={option.label} value={option.label}>{option.label}</option>
                  ))}
                </select>
                <button className="btn secondary compact-btn" onClick={requestSelectedRework} disabled={readOnly}>Nacharbeit setzen</button>
              </div>
            </div>
            </section>
          </div>
        ) : null}
        {moreOpen ? (
          <div className="more-actions">
            <button className="btn secondary compact-btn" onClick={runReviewAi} disabled={readOnly}>Prüf-KI manuell</button>
            <button className="btn secondary compact-btn" onClick={runDeepDive} disabled={readOnly}>KI-Websuche</button>
            <button className="btn secondary compact-btn" onClick={exportItem}>Excel Einzelzeile</button>
            <button className="btn secondary compact-btn" onClick={saveLearningExample} disabled={readOnly}>Als Beispiel merken</button>
            <button className="btn danger compact-btn" onClick={removeItem} disabled={readOnly}>Löschen</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

