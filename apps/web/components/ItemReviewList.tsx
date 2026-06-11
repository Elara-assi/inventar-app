"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bootstrap, api, apiObjectUrl, downloadApiFile } from "@/lib/api";
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
  uvv_due?: boolean;
  maintenance_due?: boolean;
  inspection_book_missing?: boolean;
  missing?: boolean;
  defective?: boolean;
};

type AiSuggestedFields = {
  object_type?: string | null;
  specification?: string | null;
  condition?: string | null;
  serial_number?: string | null;
  construction_year?: string | null;
  remark?: string | null;
};

type NameplateExtraction = {
  raw_text?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  type_designation?: string | null;
  serial_number?: string | null;
  construction_year?: string | null;
  technical_specs?: string[] | null;
  suggested_object_type?: string | null;
  suggested_specification?: string | null;
  suggested_remark?: string | null;
  confidence?: number | string | null;
  uncertain_fields?: string[] | null;
};

type AiSummary = {
  notes?: string;
  confidence?: number | string | null;
  uncertainty_reason?: string | null;
  requires_manual_review?: boolean | null;
  suggested_fields?: AiSuggestedFields | null;
  nameplate_extraction?: NameplateExtraction | null;
  bga_detection?: {
    object_name?: string | null;
    object_class?: string | null;
    manufacturer?: string | null;
    brand?: string | null;
    model?: string | null;
    serial_number?: string | null;
    specification?: string | null;
    suggested_remark?: string | null;
    nameplate_extraction?: NameplateExtraction | null;
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
    research_basis?: Record<string, string | null | undefined>;
    sources?: Array<{ title?: string; url?: string; snippet?: string; source_provider?: string; query?: string; rank?: number }>;
    source_evidence?: Array<{ title?: string; url?: string; host?: string; kind?: string; snippet?: string; query?: string; rank?: number; relevance_score?: number; matched_terms?: string[]; review_required?: boolean }>;
    identified_product?: { designation?: string | null; manufacturer?: string | null; model?: string | null; serial_number?: string | null; construction_year?: string | null; specification?: string | null; confidence?: number | null; review_required?: boolean };
    technical_facts?: Record<string, string | boolean | null | undefined>;
    suggested_value?: { amount?: number | null; range?: { min?: number | null; max?: number | null }; source?: string | null; confidence?: number | null; review_required?: boolean };
    confidence?: number | null;
    review_required?: boolean;
    estimated_age_years?: number | null;
    estimated_value?: number | null;
    estimated_value_range?: { min?: number; max?: number };
    estimated_value_confidence?: number | null;
    estimated_value_reason?: string | null;
    age_confidence?: number | null;
    age_reason?: string | null;
    valuation_state?: "reference_available" | "range_review" | "no_reference" | string;
    reference_price_available?: boolean;
    reference_price_label?: string;
    price_candidates?: Array<{
      value?: number;
      source?: string;
      title?: string;
      market_kind?: string;
      reference_match?: "exact" | "similar" | "weak" | string;
      reference_status?: string;
      match_reason?: string;
      matched_terms?: string[];
    }>;
    selected_price_reference?: {
      value?: number;
      source?: string;
      title?: string;
      market_kind?: string;
      reference_match?: string;
      match_reason?: string;
    } | null;
    value_reference_used?: ValueReference | null;
    matching_value_references?: ValueReference[];
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

type ValueReference = {
  id?: string;
  object_type?: string | null;
  brand?: string | null;
  model?: string | null;
  specification?: string | null;
  construction_year?: string | null;
  condition?: string | null;
  value_estimate?: number | null;
  estimated_age_years?: number | null;
  match_score?: number;
  match_reason?: string;
  notes?: string | null;
  created_at?: string;
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
  created_at?: string;
  updated_at?: string;
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

function compactText(value?: string | number | null) {
  const text = String(value ?? "").trim();
  return text || "";
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

function historyMatchNeedsAttention(match: ReferenceMatch, item: ReviewItem) {
  if (match.uvv_due && !["vorhanden", "nicht_uvv_pflichtig"].includes(item.uvv_status ?? "")) return true;
  if (match.inspection_book_missing && !["ja", "nicht_erforderlich"].includes(item.inspection_book_available ?? "")) return true;
  if (match.defective && item.function_ok !== "ja") return true;
  return Boolean(match.maintenance_due || match.missing);
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

const aiWorkStatuses = new Set(["ki_wartet", "ki_laeuft", "ki_schnell_wartet", "ki_schnell_laeuft", "ki_pruefung_wartet", "ki_pruefung_laeuft"]);

type AiWorkState = {
  title: string;
  shortLabel: string;
  phaseLabel: string;
  description: string;
  elapsedLabel: string;
  isLong: boolean;
  isVeryLong: boolean;
};

function isAiWorking(item: ReviewItem) {
  return aiWorkStatuses.has(item.status ?? "");
}

function formatAiElapsed(timestamp: string | undefined, now: number) {
  if (!timestamp) return { label: "läuft", minutes: 0 };
  const started = new Date(timestamp).getTime();
  if (!Number.isFinite(started)) return { label: "läuft", minutes: 0 };
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 55) return { label: `${Math.max(1, seconds)} Sek.`, minutes: 0 };
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 10) return { label: `${minutes}:${String(rest).padStart(2, "0")} Min.`, minutes };
  return { label: `${minutes} Min.`, minutes };
}

function aiWorkState(item: ReviewItem, now: number): AiWorkState | null {
  const status = item.status ?? "";
  if (!aiWorkStatuses.has(status)) return null;
  const isQueued = status.endsWith("_wartet") || status === "ki_wartet";
  const isFast = status.includes("schnell") || status === "ki_wartet" || status === "ki_laeuft";
  const elapsed = formatAiElapsed(item.updated_at || item.created_at, now);
  const title = isFast ? "Schnell-KI prüft diesen Artikel" : "Prüf-KI prüft diesen Artikel";
  const phaseLabel = isQueued ? "wartet auf Start" : isFast ? "Objektfoto wird erkannt" : "Fotos und Typenschild werden geprüft";
  return {
    title,
    shortLabel: isFast ? "Schnell-KI läuft" : "Prüf-KI läuft",
    phaseLabel,
    description: elapsed.minutes >= 3
      ? "Dauert länger als üblich, arbeitet aber weiter im Hintergrund. Die Liste aktualisiert automatisch."
      : isFast
        ? "Bezeichnung, Klasse und erste Hinweise werden aus den Fotos vorbereitet."
        : "Typenschild, Nacharbeitslogik und geprüfte Hinweise werden ausgewertet.",
    elapsedLabel: isQueued ? "in Warteschlange" : `seit ${elapsed.label}`,
    isLong: elapsed.minutes >= 2,
    isVeryLong: elapsed.minutes >= 8,
  };
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

function draftFromItem(item: ReviewItem) {
  const detection = item.ai_summary?.bga_detection;
  const fields = detection?.suggested_fields ?? item.ai_summary?.suggested_fields ?? {};
  const nameplate = detection?.nameplate_extraction ?? item.ai_summary?.nameplate_extraction;
  const deepDive = item.ai_summary?.deep_dive;
  const constructionYear = item.construction_year || fields.construction_year || nameplate?.construction_year || "";
  const derivedAge = ageFromConstructionYear(constructionYear);
  const itemAgeIsEstimate = item.age_source === "schaetzung" || item.age_verification_status === "geschaetzt";
  return {
    object_type: item.object_type || fields.object_type || detection?.object_name || nameplate?.suggested_object_type || "",
    brand: item.brand || detection?.manufacturer || detection?.brand || "",
    model: item.model || detection?.model || "",
    serial_number: item.serial_number || fields.serial_number || detection?.serial_number || nameplate?.serial_number || "",
    specification: item.specification || fields.specification || nameplate?.suggested_specification || detection?.specification || "",
    construction_year: constructionYear,
    function_ok: item.function_ok ?? "nicht_geprueft",
    uvv_status: item.uvv_status ?? "unklar",
    uvv_valid_until: item.uvv_valid_until ?? "",
    inspection_book_available: item.inspection_book_available ?? "unklar",
    remark: item.remark || fields.remark || nameplate?.suggested_remark || detection?.suggested_remark || "",
    type_plate_status: item.type_plate_status ?? "nicht_geprueft",
    value_estimate: item.value_estimate?.toString() ?? "",
    estimated_age_years:
      derivedAge != null && (item.estimated_age_years == null || itemAgeIsEstimate)
        ? String(derivedAge)
        : item.estimated_age_years?.toString() ?? (deepDive?.estimated_age_years != null ? String(deepDive.estimated_age_years) : detection?.estimated_age_years != null ? String(detection.estimated_age_years) : ""),
    object_class_id: item.object_class_id ?? "",
    condition: item.condition ?? "gebraucht",
    review_status: item.review_status ?? "erfasst",
  };
}

function optionalNumber(value: string) {
  const normalized = value.trim().replace(",", ".").replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageFromConstructionYear(value?: string | null) {
  const match = String(value ?? "").match(/\b(19[8-9][0-9]|20[0-3][0-9])\b/);
  if (!match) return null;
  const year = Number(match[1]);
  const currentYear = new Date().getFullYear();
  if (!Number.isFinite(year) || year > currentYear + 1) return null;
  return Math.max(0, currentYear - year);
}

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
  onChanged: () => void | Promise<void>;
  readOnly?: boolean;
}) {
  const [activeFilter, setActiveFilter] = useState<ReviewFilterKey>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const baseVisibleItems = useMemo(
    () => items.filter((item) => matchesReviewFilter(item, activeFilter)).sort((left, right) => {
      const priority = reviewSortPriority(left) - reviewSortPriority(right);
      if (priority !== 0) return priority;
      return (left.sequence_number ?? 999999) - (right.sequence_number ?? 999999);
    }),
    [activeFilter, items],
  );
  const visibleItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return baseVisibleItems;
    return baseVisibleItems.filter((item) => [
      item.object_type,
      item.inventory_id,
      item.temporary_id,
      item.brand,
      item.model,
      item.serial_number,
      item.specification,
      item.object_class_name,
    ].some((value) => String(value ?? "").toLowerCase().includes(query)));
  }, [baseVisibleItems, searchQuery]);
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
  const aiWorkingItems = useMemo(() => items.filter(isAiWorking), [items]);
  const selectedItem = visibleItems.find((item) => item.id === selectedItemId)
    ?? visibleItems[0]
    ?? baseVisibleItems[0]
    ?? null;

  useEffect(() => {
    if (!aiWorkingItems.length) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [aiWorkingItems.length]);

  useEffect(() => {
    if (!selectedItem) return;
    if (selectedItem.id !== selectedItemId) setSelectedItemId(selectedItem.id);
  }, [selectedItem, selectedItemId]);

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
          {aiWorkingItems.length ? <AiWorkOverview items={aiWorkingItems} now={now} /> : null}
          {visibleItems.length ? (
            <div className="review-cockpit-layout">
              <section className="review-list-pane" aria-label="Inventarliste">
                <div className="review-list-toolbar">
                  <label>
                    <span>Objekte suchen</span>
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Bezeichnung, Typ, Seriennummer ..."
                    />
                  </label>
                  <div>
                    <strong>{visibleItems.length}</strong>
                    <span>sichtbar</span>
                  </div>
                </div>
                <div className="review-cockpit-table" role="table" aria-label="Gegenstände im Raum">
                  <div className="review-cockpit-head" role="row">
                    <span>#</span>
                    <span>Foto</span>
                    <span>Bezeichnung</span>
                    <span>Funktion</span>
                  </div>
                  {visibleItems.map((item) => (
                    <ReviewCockpitRow
                      item={item}
                      key={item.id}
                      isSelected={selectedItem?.id === item.id}
                      now={now}
                      onSelect={() => setSelectedItemId(item.id)}
                      onOpenPhoto={openPhoto}
                    />
                  ))}
                </div>
              </section>
              <aside className="review-inspector-pane" aria-label="Artikel-Inspektor">
                {selectedItem ? (
                  <ItemReviewRow
                    item={selectedItem}
                    key={selectedItem.id}
                    objectClasses={objectClasses}
                    onChanged={onChanged}
                    onOpenPhoto={openPhoto}
                    readOnly={readOnly}
                    now={now}
                    inspector
                  />
                ) : null}
              </aside>
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

function ReviewCockpitRow({
  item,
  isSelected,
  now,
  onSelect,
  onOpenPhoto,
}: {
  item: ReviewItem;
  isSelected: boolean;
  now: number;
  onSelect: () => void;
  onOpenPhoto: (url: string, label: string) => void;
}) {
  const itemPhotos = item.photos ?? [];
  const mainPhoto = itemPhotos.find((photo) => photo.photo_type === "object" || photo.photo_type === "object_front") ?? itemPhotos[0];
  const photoPath = mainPhoto ? `/uploads/photos/${mainPhoto.id}` : item.object_photo_id ? `/uploads/photos/${item.object_photo_id}` : "";
  const itemName = item.object_type || "Bezeichnung offen";
  const itemMeta = [item.inventory_id || item.temporary_id, item.brand, item.model].filter(Boolean).join(" · ");
  const aiWork = aiWorkState(item, now);
  const deepDive = item.ai_summary?.deep_dive;
  const aiLabel = aiWork
    ? aiWork.shortLabel
    : deepDive?.valuation_state === "no_reference"
      ? "Keine Wertquelle"
      : item.ai_summary?.bga_detection || item.ai_summary?.suggested_fields
        ? "Objekt erkannt"
        : item.status?.startsWith("ki_")
          ? "KI offen"
          : "Bereit";
  const statusLabel = reviewStatusLabels[item.review_status ?? ""] ?? item.review_status ?? "erfasst";
  const functionLabel = functionLabels[item.function_ok ?? ""] ?? item.function_ok ?? "offen";
  const rowTags = [
    { label: statusLabel, kind: isFinalized(item) ? "ok" : needsRework(item) ? "warn" : "info" },
    { label: aiLabel, kind: aiWork ? "ai" : deepDive?.valuation_state === "no_reference" ? "muted" : "info" },
    ...(item.blockers ?? []).slice(0, 2).map((label) => ({ label: displayTaskField(label), kind: "warn" })),
    ...(!hasObjectPhoto(item) ? [{ label: "Foto fehlt", kind: "warn" }] : []),
  ].slice(0, 3);

  return (
    <div
      className={`review-cockpit-row ${isSelected ? "is-selected" : ""} ${needsRework(item) ? "needs-work" : ""}`.trim()}
      role="row"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-selected={isSelected}
    >
      <span className="review-row-number">{item.sequence_number ?? "-"}</span>
      <AuthPhotoButton path={photoPath} label={itemName} className="review-table-photo" onOpenPhoto={onOpenPhoto} />
      <span className="review-row-name">
        <b>{itemName}</b>
        <small>{itemMeta || item.object_class_name || "Details offen"}</small>
        {rowTags.length ? (
          <span className="review-row-tags">
            {rowTags.map((tag) => <i className={`is-${tag.kind}`} key={`${tag.kind}-${tag.label}`}>{tag.label}</i>)}
          </span>
        ) : null}
      </span>
      <span className={`review-row-pill ${item.function_ok === "ja" ? "is-ok" : item.function_ok === "nein" ? "is-danger" : "is-muted"}`}>
        {functionLabel}
      </span>
    </div>
  );
}

function AiWorkOverview({ items, now }: { items: ReviewItem[]; now: number }) {
  const first = items[0];
  const firstState = aiWorkState(first, now);
  const firstName = first.object_type || first.inventory_id || first.temporary_id || "Artikel";
  const moreCount = Math.max(0, items.length - 1);
  return (
    <div className="ai-work-overview" role="status" aria-live="polite">
      <div className="ai-work-overview-main">
        <span className="ai-work-spinner" aria-hidden="true" />
        <div>
          <strong>KI arbeitet gerade an: {firstName}</strong>
          <span>
            {firstState?.phaseLabel || "Prüfung läuft"} · {firstState?.elapsedLabel || "läuft"}
            {moreCount ? ` · ${moreCount} weitere` : ""}
          </span>
        </div>
      </div>
      <div className="ai-work-overview-meter" aria-hidden="true"><span /></div>
    </div>
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
  now,
  inspector = false,
}: {
  item: ReviewItem;
  objectClasses: Bootstrap["object_classes"];
  onChanged: () => void | Promise<void>;
  onOpenPhoto: (url: string, label: string) => void;
  readOnly: boolean;
  now: number;
  inspector?: boolean;
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
  const [draft, setDraft] = useState(() => draftFromItem(item));
  const [draftDirty, setDraftDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedRework, setSelectedRework] = useState<string>(reworkOptions[0].label);
  const [editOpen, setEditOpen] = useState(inspector);
  const [actionBusy, setActionBusy] = useState("");

  useEffect(() => {
    if (editOpen && draftDirty) return;
    setDraft(draftFromItem(item));
    setDraftDirty(false);
  }, [item, editOpen, draftDirty]);

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
    if (inspector) setEditOpen(true);
  }, [inspector, item.id]);

  function updateDraft(patch: Partial<typeof draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setDraftDirty(true);
  }

  function updateConstructionYear(value: string) {
    const derivedAge = ageFromConstructionYear(value);
    setDraft((current) => ({
      ...current,
      construction_year: value,
      estimated_age_years: derivedAge != null ? String(derivedAge) : current.estimated_age_years,
    }));
    setDraftDirty(true);
    if (derivedAge != null) setMessage(`Alter aus Baujahr abgeleitet: ${derivedAge} Jahre`);
  }

  function applyAiSuggestionToDraft() {
    const detection = item.ai_summary?.bga_detection;
    const fields = detection?.suggested_fields ?? item.ai_summary?.suggested_fields ?? {};
    const nameplate = detection?.nameplate_extraction ?? item.ai_summary?.nameplate_extraction;
    const flexibleFields = fields as Record<string, string | number | null | undefined>;
    const flexibleNameplate = nameplate as Record<string, string | number | null | undefined> | undefined;
    const modelText = compactText(flexibleFields.model || flexibleNameplate?.model);
    const specificationText = fields.specification || nameplate?.suggested_specification || modelText;
    const nextValues = {
      object_type: compactText(fields.object_type || detection?.object_name || nameplate?.suggested_object_type),
      specification: compactText(specificationText),
      brand: compactText(flexibleFields.brand || flexibleNameplate?.brand || flexibleNameplate?.manufacturer),
      serial_number: compactText(fields.serial_number || detection?.serial_number || nameplate?.serial_number),
      construction_year: compactText(fields.construction_year || nameplate?.construction_year),
      remark: compactText(fields.remark || nameplate?.suggested_remark),
      condition: compactText(fields.condition),
    };
    const changedFields = [
      nextValues.object_type ? "Bezeichnung" : "",
      nextValues.specification ? "Typ/Spezifikation" : "",
      nextValues.brand ? "Marke" : "",
      nextValues.serial_number ? "Seriennummer" : "",
      nextValues.construction_year ? "Baujahr" : "",
      nextValues.remark ? "Bemerkung" : "",
      nextValues.condition ? "Zustand" : "",
    ].filter(Boolean);
    setDraft((current) => ({
      ...current,
      object_type: nextValues.object_type || current.object_type,
      specification: nextValues.specification || current.specification,
      brand: nextValues.brand || current.brand,
      serial_number: nextValues.serial_number || current.serial_number,
      construction_year: nextValues.construction_year || current.construction_year,
      remark: nextValues.remark || current.remark,
      condition: nextValues.condition || current.condition,
    }));
    if (changedFields.length) {
      setDraftDirty(true);
      setMessage(`KI-Vorschlag übernommen: ${Array.from(new Set(changedFields)).join(", ")}. Bitte prüfen und speichern.`);
    } else {
      setMessage("Kein KI-Vorschlag für diese Felder vorhanden.");
    }
  }

  async function persistDraft() {
    const derivedAge = ageFromConstructionYear(draft.construction_year);
    const typedAge = optionalNumber(draft.estimated_age_years);
    const ageEstimate = typedAge ?? derivedAge;
    const ageComesFromConstructionYear = derivedAge != null && (typedAge == null || Math.abs(typedAge - derivedAge) < 0.01);
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
        object_class_id: draft.object_class_id || null,
        condition: draft.condition,
        estimated_age_years: ageEstimate,
        age_source: ageEstimate != null ? (ageComesFromConstructionYear ? "baujahr" : "manuell") : "unbekannt",
        age_verification_status: ageEstimate != null ? "geprueft" : "offen",
        review_status: draft.review_status,
      }),
    });
    setDraftDirty(false);
  }

  async function save() {
    if (readOnly) return false;
    setActionBusy("save");
    try {
      await persistDraft();
      await onChanged();
      setMessage("Gespeichert");
      return true;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
      return false;
    } finally {
      setActionBusy("");
    }
  }

  async function finishEditing() {
    if (!readOnly && draftDirty) {
      const saved = await save();
      if (!saved) return;
    }
    setEditOpen(false);
  }

  async function requestRework(role: "Auswertung" | "Erfasser" | "Technik", missingField: string) {
    if (readOnly) return;
    setActionBusy("rework");
    try {
    await api(`/items/${item.id}/request-rework`, {
      method: "POST",
      body: JSON.stringify({
        assigned_role: role,
        missing_field: missingField,
        comment: `${missingField} im Raumtest nacharbeiten`,
      }),
    });
    await onChanged();
    setMessage(role === "Auswertung" ? "Spätere Auswertung markiert" : `Nacharbeit ${role}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Nacharbeit konnte nicht gesetzt werden");
    } finally {
      setActionBusy("");
    }
  }

  async function requestSelectedRework() {
    const option = reworkOptions.find((entry) => entry.label === selectedRework) ?? reworkOptions[0];
    await requestRework(option.role as "Auswertung" | "Erfasser" | "Technik", option.missingField);
  }

  async function finalize() {
    if (readOnly) return;
    setActionBusy("finalize");
    try {
      await api(`/items/${item.id}/finalize`, { method: "POST", body: "{}" });
      await onChanged();
      setMessage("Finalisiert");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Finalisierung blockiert");
    } finally {
      setActionBusy("");
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
    setActionBusy("ai");
    try {
      await api(`/items/${item.id}/ai/run?mode=review`, { method: "POST", body: "{}" });
      setMessage("Prüf-KI gestartet");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Prüf-KI konnte nicht gestartet werden");
    } finally {
      setActionBusy("");
    }
  }

  async function cancelAiWork() {
    if (readOnly) return;
    try {
      await api(`/items/${item.id}/ai/cancel`, { method: "POST", body: "{}" });
      setMessage("KI-Prozess abgebrochen");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "KI-Prozess konnte nicht abgebrochen werden");
    }
  }

  async function removeItem() {
    if (readOnly) return;
    const label = item.object_type || item.inventory_id || item.temporary_id || "Gegenstand";
    const confirmed = window.confirm(`Gegenstand "${label}" wirklich löschen? Fotos und Notizen bleiben im Uploadspeicher erhalten, der Datensatz wird aus dieser Session entfernt.`);
    if (!confirmed) return;
    setActionBusy("delete");
    try {
      await api(`/items/${item.id}`, { method: "DELETE" });
      setMessage("Gelöscht");
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Gegenstand konnte nicht gelöscht werden");
    } finally {
      setActionBusy("");
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
  const firstHistory = item.ai_summary?.inventory_history_matches?.find((match) => historyMatchNeedsAttention(match, item));
  const aiProposal = item.ai_summary?.bga_detection;
  const aiProposalFields = aiProposal?.suggested_fields ?? item.ai_summary?.suggested_fields;
  const nameplateProposal = aiProposal?.nameplate_extraction ?? item.ai_summary?.nameplate_extraction;
  const deepDive = item.ai_summary?.deep_dive;
  const flexibleAiFields = aiProposalFields as Record<string, string | number | null | undefined> | undefined;
  const flexibleNameplate = nameplateProposal as Record<string, string | number | null | undefined> | undefined;
  const aiFieldSuggestions = {
    object_type: aiProposalFields?.object_type || aiProposal?.object_name || nameplateProposal?.suggested_object_type || "",
    specification: aiProposalFields?.specification || nameplateProposal?.suggested_specification || flexibleAiFields?.model || flexibleNameplate?.model || "",
    brand: flexibleAiFields?.brand || flexibleNameplate?.brand || flexibleNameplate?.manufacturer || "",
    serial_number: aiProposalFields?.serial_number || aiProposal?.serial_number || nameplateProposal?.serial_number || "",
    construction_year: aiProposalFields?.construction_year || nameplateProposal?.construction_year || "",
    condition: aiProposalFields?.condition || "",
  };
  const suggestionLabel = (current: string | null | undefined, suggestion: unknown) => {
    const value = typeof suggestion === "string" || typeof suggestion === "number" ? compactText(suggestion) : "";
    if (!value) return "";
    if (compactText(current) === value) return "";
    return value;
  };
  const hasAiFieldSuggestion = Object.values(aiFieldSuggestions).some((value) => compactText(value));
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
  const aiWork = aiWorkState(item, now);
  const selectedClassName = filteredObjectClasses.find((entry) => entry.id === draft.object_class_id)?.name || item.object_class_name || "Offen";
  const itemMeta = [draft.specification, draft.brand].filter(Boolean).join(" · ") || selectedClassName || "Details offen";
  const derivedAgeFromYear = ageFromConstructionYear(draft.construction_year || item.construction_year || deepDive?.research_basis?.construction_year);
  const displayedAge = derivedAgeFromYear ?? deepDive?.estimated_age_years ?? item.estimated_age_years ?? null;
  const displayedAgeLabel = displayedAge != null ? `${displayedAge} Jahre` : "Alter offen";
  const ageBasis = derivedAgeFromYear != null ? `aus Baujahr ${draft.construction_year || item.construction_year || deepDive?.research_basis?.construction_year}` : null;
  const isAiEstimate = Boolean(!ageBasis && (deepDive?.estimated_by_ai || item.age_source === "schaetzung" || item.age_verification_status === "geschaetzt"));
  const compactKi = deepDive
    ? `${displayedAgeLabel}${ageBasis ? ` (${ageBasis})` : ""}`
    : isAiEstimate
      ? displayedAgeLabel
      : aiWork ? `${aiWork.phaseLabel} · ${aiWork.elapsedLabel}` : item.status?.startsWith("ki_") ? "KI läuft" : "";
  const blockerSummary = blockers.slice(0, 3).map(displayTaskField).join(", ");
  const finalizeBlocked = blockers.length > 0;
  const openStateLabel = finalizeBlocked ? `Noch offen: ${blockerSummary || "Pflichtangaben prüfen"}` : "Bereit zum Finalisieren";

  return (
    <div className={`item-row ${inspector ? "is-inspector" : ""} ${aiWork ? "is-ai-working" : ""} ${aiWork?.isVeryLong ? "is-ai-slow" : ""}`.trim()}>
      <AuthPhotoButton path={photoPath} label={photoLabel} className="photo-thumb" onOpenPhoto={onOpenPhoto} />

      <div className="item-main">
        {readOnly ? <div className="locked-strip">Raum abgeschlossen: Dieser Datensatz ist schreibgeschützt.</div> : null}
        <div className="item-title-line">
          <div className="item-identity">
            <strong>{itemName}</strong>
          <span>{item.inventory_id || item.temporary_id} · {item.sequence_number ? `Nr. ${item.sequence_number} · ` : ""}{itemMeta}</span>
          </div>
          <StatusBadge value={item.review_status} />
          {aiWork ? <span className={`status ai-work-badge ${aiWork.isLong ? "is-long" : ""}`}>{aiWork.shortLabel}</span> : null}
          <span className={item.has_object_photo ? "status geprueft" : "status upload_fehler"}>{itemPhotos.length || (item.has_object_photo ? 1 : 0)}/5 Fotos</span>
        </div>

        {aiWork ? (
          <div className={`ai-work-panel ${aiWork.isLong ? "is-long" : ""} ${aiWork.isVeryLong ? "is-very-long" : ""}`} role="status" aria-live="polite">
            <div className="ai-work-panel-head">
              <span className="ai-work-spinner" aria-hidden="true" />
              <div>
                <strong>{aiWork.title}</strong>
                <span>{aiWork.phaseLabel}</span>
              </div>
              <small>{aiWork.elapsedLabel}</small>
            </div>
            <div className="ai-work-meter" aria-hidden="true"><span /></div>
            <p>{aiWork.description}</p>
            <div className="ai-work-actions">
              <button className="btn secondary compact-btn" type="button" onClick={cancelAiWork} disabled={readOnly}>
                KI abbrechen
              </button>
            </div>
          </div>
        ) : null}

        <div className="item-compact-grid">
          <span><b>Klasse</b>{selectedClassName}</span>
          <span><b>Zustand</b>{conditionLabels[draft.condition] ?? draft.condition}</span>
          <span><b>Bearbeitung</b>{reviewStatusLabels[draft.review_status] ?? draft.review_status}</span>
          <span><b>Funktion</b>{functionLabels[draft.function_ok] ?? draft.function_ok}</span>
          <span><b>UVV</b>{uvvLabels[draft.uvv_status] ?? draft.uvv_status}</span>
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

        <div className="compact-row-actions review-primary-actions">
          <button
            className="btn accent compact-btn"
            type="button"
            onClick={() => inspector ? editPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }) : setEditOpen((current) => !current)}
          >
            Bearbeiten
          </button>
          {finalizeBlocked ? (
            <span className="open-state-pill" title={blockerSummary ? `Fehlt: ${blockerSummary}` : "Pflichtangaben prüfen"}>{openStateLabel}</span>
          ) : (
            <button className="btn compact-btn" type="button" onClick={finalize} disabled={readOnly || Boolean(actionBusy)} title="Datensatz finalisieren">
              {actionBusy === "finalize" ? "Finalisiere..." : "Finalisieren"}
            </button>
          )}
        </div>

        {editOpen ? (
          <div className="item-edit-panel" ref={editPanelRef}>
            <div className="item-edit-head">
              <div>
                <strong>{itemName}</strong>
                <span>Prüfen, korrigieren, speichern. Manuelle Eingaben sind führend.</span>
              </div>
              {message ? <span className="edit-save-feedback">{message}</span> : null}
            </div>
            <section className="item-edit-section">
              <div className="item-edit-section-head">
                <strong>Papierliste</strong>
                <span>KI-Vorschläge stehen direkt am Feld. Speichern übernimmt nur deine Eingaben.</span>
              </div>
            <div className="item-main-fields">
              <label className="field">
                <span>Bezeichnung</span>
                <input disabled={readOnly} value={draft.object_type} onChange={(event) => updateDraft({ object_type: event.target.value })} placeholder="Artikelname, z. B. Smartphone" />
                <small className="field-help">Führendes Feld für Liste und Export.</small>
                {suggestionLabel(draft.object_type, aiFieldSuggestions.object_type) ? <small className="field-suggestion">KI: {suggestionLabel(draft.object_type, aiFieldSuggestions.object_type)}</small> : null}
              </label>
              <label className="field">
                <span>Typ / Spezifikation</span>
                <input disabled={readOnly} value={draft.specification} onChange={(event) => updateDraft({ specification: event.target.value })} placeholder="Modell, Typ, Größe, Ausführung" />
                <small className="field-help">Modell gehört hier hinein, nicht in die Bezeichnung.</small>
                {suggestionLabel(draft.specification, aiFieldSuggestions.specification) ? <small className="field-suggestion">KI: {suggestionLabel(draft.specification, aiFieldSuggestions.specification)}</small> : null}
              </label>
              <label className="field">
                <span>Baujahr</span>
                <input disabled={readOnly} value={draft.construction_year} onChange={(event) => updateConstructionYear(event.target.value)} placeholder="z. B. 2025" />
                {suggestionLabel(draft.construction_year, aiFieldSuggestions.construction_year) ? <small className="field-suggestion">KI: {suggestionLabel(draft.construction_year, aiFieldSuggestions.construction_year)}</small> : null}
              </label>
              <label className="field">
                <span>Marke</span>
                <input disabled={readOnly} value={draft.brand} onChange={(event) => updateDraft({ brand: event.target.value })} placeholder="z. B. Apple" />
                {suggestionLabel(draft.brand, aiFieldSuggestions.brand) ? <small className="field-suggestion">KI: {suggestionLabel(draft.brand, aiFieldSuggestions.brand)}</small> : null}
              </label>
              <label className="field">
                <span>Seriennummer</span>
                <input disabled={readOnly} value={draft.serial_number} onChange={(event) => updateDraft({ serial_number: event.target.value })} placeholder="falls vorhanden" />
                {suggestionLabel(draft.serial_number, aiFieldSuggestions.serial_number) ? <small className="field-suggestion">KI: {suggestionLabel(draft.serial_number, aiFieldSuggestions.serial_number)}</small> : null}
              </label>
            </div>
            {hasAiFieldSuggestion ? (
              <button className="btn secondary compact-btn inline-ai-apply" type="button" onClick={applyAiSuggestionToDraft} disabled={readOnly}>
                KI-Vorschlag übernehmen
              </button>
            ) : null}
            </section>

            <section className="item-edit-section">
              <div className="item-edit-section-head">
                <strong>Zustand & Prüfung</strong>
                <span>Was entscheidet der Prüfer?</span>
              </div>
            <div className="item-review-selects bga-review-selects">
              <label>
                <span>Funktion i. O.</span>
                <select disabled={readOnly} value={draft.function_ok} onChange={(event) => updateDraft({ function_ok: event.target.value })}>
                  <option value="ja">Ja</option>
                  <option value="nein">Nein</option>
                  <option value="nicht_geprueft">Nicht geprüft</option>
                </select>
              </label>
              <label>
                <span>UVV Status</span>
                <select disabled={readOnly} value={draft.uvv_status} onChange={(event) => updateDraft({ uvv_status: event.target.value })}>
                  <option value="vorhanden">UVV vorhanden</option>
                  <option value="nicht_vorhanden">UVV nicht vorhanden</option>
                  <option value="nicht_uvv_pflichtig">nicht UVV-pflichtig</option>
                  <option value="unklar">unklar</option>
                </select>
              </label>
              <label>
                <span>UVV gültig bis</span>
                <input disabled={readOnly} type="date" value={draft.uvv_valid_until} onChange={(event) => updateDraft({ uvv_valid_until: event.target.value })} />
              </label>
              {!isBga ? <label>
                <span>Prüfbuch</span>
                <select disabled={readOnly} value={draft.inspection_book_available} onChange={(event) => updateDraft({ inspection_book_available: event.target.value })}>
                  <option value="ja">Ja</option>
                  <option value="nein">Nein</option>
                  <option value="nicht_erforderlich">Nicht erforderlich</option>
                  <option value="unklar">Unklar</option>
                </select>
              </label> : null}
              <label className="field">
                <span>Klasse</span>
                <select disabled={readOnly} value={draft.object_class_id} onChange={(event) => updateDraft({ object_class_id: event.target.value })}>
                  <option value="">Offen</option>
                  {filteredObjectClasses.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Zustand</span>
                <select disabled={readOnly} value={draft.condition} onChange={(event) => updateDraft({ condition: event.target.value })}>
                  {conditions.map((entry) => (
                    <option key={entry} value={entry}>{conditionLabels[entry] ?? entry}</option>
                  ))}
                </select>
                {suggestionLabel(draft.condition, aiFieldSuggestions.condition) ? <small className="field-suggestion">KI: {suggestionLabel(draft.condition, aiFieldSuggestions.condition)}</small> : null}
              </label>
              <label>
                <span>Bearbeitung</span>
                <select disabled={readOnly} value={draft.review_status} onChange={(event) => updateDraft({ review_status: event.target.value })}>
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
              <textarea disabled={readOnly} rows={3} value={draft.remark} onChange={(event) => updateDraft({ remark: event.target.value })} placeholder="Bemerkung aus der Aufnahme" />
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
              <button className="btn accent" type="button" onClick={save} disabled={readOnly || Boolean(actionBusy)}>{actionBusy === "save" ? "Speichert..." : "Speichern"}</button>
              {!inspector ? <button className="btn secondary compact-btn" type="button" onClick={finishEditing} disabled={Boolean(actionBusy)}>Fertig</button> : null}
              <div className="rework-action">
                <select disabled={readOnly} value={selectedRework} onChange={(event) => setSelectedRework(event.target.value as typeof selectedRework)}>
                  {reworkOptions.map((option) => (
                    <option key={option.label} value={option.label}>{option.label}</option>
                  ))}
                </select>
                <button className="btn secondary compact-btn" type="button" onClick={requestSelectedRework} disabled={readOnly || Boolean(actionBusy)}>Nacharbeit setzen</button>
              </div>
            </div>
            <div className="more-actions review-secondary-actions">
              <button className="btn secondary compact-btn" type="button" onClick={runReviewAi} disabled={readOnly || Boolean(aiWork) || Boolean(actionBusy)}>{aiWork ? "KI läuft..." : "Prüf-KI manuell"}</button>
              <button className="btn secondary compact-btn" type="button" onClick={exportItem}>Excel Einzelzeile</button>
              <button className="btn danger compact-btn" type="button" onClick={removeItem} disabled={readOnly || Boolean(actionBusy)}>Löschen</button>
            </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

