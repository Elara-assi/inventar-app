"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, RefObject } from "react";
import { API_BASE, Bootstrap, inventoryTypeLabel, setAuthToken } from "@/lib/api";
import { api } from "@/lib/api";
import {
  QueueItem,
  QueueDetails,
  QueueSummary,
  createClientItemId,
  discardQueueItems,
  enqueueItemDraft,
  enqueuePhotoUpload,
  getOrCreateDeviceId,
  getQueueDetails,
  getQueueSummary,
  initQueue,
  listQueueItems,
  nextLocalSequenceNumber,
  queueSchemaVersion,
} from "@/lib/offlineQueue";
import { getOnlineStatus, retryFailed, syncNow } from "@/lib/syncClient";

type Joined = {
  session: {
    id: string;
    location_id: string;
    building_id: string;
    room_id: string;
    inventory_type?: string | null;
  };
  device: { id: string };
  access_token?: string;
};

type LocalItem = {
  id: string;
  inventory_id: string;
  temporary_id: string;
  server_item_id?: string;
  sequence_number?: number;
};

type PhotoType = "object_front" | "object_back" | "type_plate" | "uvv_label" | "condition_detail" | "other";
type FunctionOk = "ja" | "nein" | "nicht_geprueft";
type UvvStatus = "vorhanden" | "nicht_vorhanden" | "nicht_uvv_pflichtig" | "unklar";
type InspectionBook = "ja" | "nein" | "nicht_erforderlich" | "unklar";

const steps = [
  "Fotos & Nachweise",
  "KI-Vorschlag",
  "Stammdaten",
  "Zustand & Prüfung",
  "Zusammenfassung",
];

const photoLabels: Record<PhotoType, string> = {
  object_front: "Objektfoto",
  object_back: "Weiteres Foto",
  type_plate: "Typenschild",
  uvv_label: "UVV-Siegel",
  condition_detail: "Zustandsfoto",
  other: "Weiteres Foto",
};

const photoMaxSide: Record<PhotoType, number> = {
  object_front: 1600,
  object_back: 1600,
  condition_detail: 2400,
  other: 1200,
  type_plate: 2400,
  uvv_label: 2400,
};

type BgaForm = {
  object_type: string;
  specification: string;
  construction_year: string;
  condition: string;
  condition_note: string;
  function_ok: FunctionOk;
  uvv_status: UvvStatus;
  uvv_valid_until: string;
  inspection_book_available: InspectionBook;
  remark: string;
  type_plate_status: "vorhanden" | "nicht_vorhanden" | "unklar" | "uebersprungen" | "nicht_geprueft";
};

type ServerItemSuggestion = {
  object_name?: string | null;
  object_type?: string | null;
  object_class?: string | null;
  manufacturer?: string | null;
  brand?: string | null;
  model?: string | null;
  serial_number?: string | null;
  specification?: string | null;
  construction_year?: string | null;
  condition?: string | null;
  condition_guess?: string | null;
  suggested_remark?: string | null;
  suggested_fields?: {
    object_type?: string | null;
    specification?: string | null;
    condition?: string | null;
    construction_year?: string | null;
    remark?: string | null;
  } | null;
  visible_features?: string[] | null;
  uncertainty_reason?: string | null;
  value_estimate?: number | string | null;
  estimated_value_eur?: number | string | null;
  estimated_value_confidence?: number | string | null;
  estimated_value_reason?: string | null;
  value_requires_review?: boolean | null;
  estimated_age_years?: number | string | null;
  age_confidence?: number | string | null;
  age_reason?: string | null;
  age_requires_review?: boolean | null;
  age_source?: string | null;
  age_verification_status?: string | null;
  confidence?: number | string | null;
  confidence_score?: number | string | null;
  requires_manual_review?: boolean | null;
  status?: string | null;
  bga_detection?: ServerItemSuggestion | null;
};

type AiResultRow = {
  ai_type?: string | null;
  status?: string | null;
  result_json?: ServerItemSuggestion | null;
};

type ServerItemWithAi = ServerItemSuggestion & {
  ai_results?: AiResultRow[];
};

const emptyForm: BgaForm = {
  object_type: "",
  specification: "",
  construction_year: "",
  condition: "gebraucht",
  condition_note: "",
  function_ok: "nicht_geprueft",
  uvv_status: "unklar",
  uvv_valid_until: "",
  inspection_book_available: "nicht_erforderlich",
  remark: "",
  type_plate_status: "nicht_geprueft",
};

const emptySummary: QueueSummary = {
  total: 0,
  pending: 0,
  uploading: 0,
  synced: 0,
  failed: 0,
  conflict: 0,
  open: 0,
  pendingPhotos: 0,
  failedPhotos: 0,
};

const queueTypeLabels = {
  item_draft: "Objekt",
  photo_upload: "Foto",
};

const queueStatusLabels = {
  pending: "wartet",
  uploading: "Übertragung läuft",
  synced: "synchronisiert",
  failed: "Upload fehlgeschlagen",
  conflict: "Zuordnung prüfen",
};

const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || "unbekannt";

function queueValue(item: QueueItem, key: string) {
  return (item as unknown as Record<string, unknown>)[key];
}

function queueBool(value: unknown) {
  return value === undefined ? "offen" : value ? "ja" : "nein";
}

function diagnosticPhotoBlob(item: QueueItem) {
  const blob = item.photo_blob;
  return {
    vorhanden: Boolean(blob),
    size: blob?.size ?? item.file_size ?? 0,
    type: blob?.type || item.file_type || "unbekannt",
  };
}

function buildBundleDiagnostics(items: QueueItem[]) {
  const grouped = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = item.client_item_id || `ohne-client-item-${item.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  return Array.from(grouped.entries()).map(([clientItemId, entries]) => {
    const itemDraft = entries.find((entry) => entry.type === "item_draft");
    const photos = entries.filter((entry) => entry.type === "photo_upload");
    const reasons: string[] = [];
    if (!clientItemId) reasons.push("client_item_id fehlt");
    if (!(itemDraft?.session_id || photos[0]?.session_id)) reasons.push("session_id fehlt");
    if (!(itemDraft?.device_id || photos[0]?.device_id)) reasons.push("source_device_id fehlt");
    for (const photo of photos) {
      if (!photo.client_photo_id) reasons.push(`Foto ${photo.id}: client_photo_id fehlt`);
      if (!photo.photo_type) reasons.push(`Foto ${photo.client_photo_id ?? photo.id}: photo_type fehlt`);
      if (!photo.photo_blob) reasons.push(`Foto ${photo.client_photo_id ?? photo.id}: Blob fehlt`);
    }
    const requiredValuesPresent = reasons.length === 0;
    return {
      client_item_id: clientItemId,
      foto_sync_faehig: requiredValuesPresent ? "ja" : "nein",
      grund: reasons.length ? reasons : [],
      fotos_offen: photos.length,
      blob_summe_bytes: photos.reduce((sum, photo) => sum + (photo.photo_blob?.size ?? photo.file_size ?? 0), 0),
      pflichtwerte_fuer_offline_sync_photos_vorhanden: requiredValuesPresent ? "ja" : "nein",
      item_draft_status: itemDraft?.status ?? "fehlt",
      server_item_id: itemDraft?.server_item_id ?? photos.find((photo) => photo.server_item_id)?.server_item_id ?? null,
      post_gestartet: entries.some((entry) => Boolean(entry.fetch_started)) ? "ja" : "nein",
      response_verarbeitet: entries.some((entry) => entry.upload_debug_state === "response_received" || entry.status === "synced") ? "ja" : "nein",
      lokale_queue_bereinigt: entries.every((entry) => entry.status === "synced") ? "ja, nach clearOnlySyncedItems" : "nein, noch lokale Eintraege offen",
    };
  });
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [joinError, setJoinError] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [objectClassId, setObjectClassId] = useState("");
  const [step, setStep] = useState(0);
  const [activeItem, setActiveItem] = useState<LocalItem | null>(null);
  const [form, setForm] = useState<BgaForm>(emptyForm);
  const [photos, setPhotos] = useState<Array<{ type: PhotoType; id?: string; name: string; size: number; previewUrl?: string }>>([]);
  const [savedItem, setSavedItem] = useState<{ label: string } | null>(null);
  const [editedFields, setEditedFields] = useState<Partial<Record<keyof BgaForm, boolean>>>({});
  const [message, setMessage] = useState("Bereit");
  const [busy, setBusy] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [syncMessage, setSyncMessage] = useState("");
  const [queueSummary, setQueueSummary] = useState<QueueSummary>(emptySummary);
  const [queueDetails, setQueueDetails] = useState<QueueDetails | null>(null);
  const [showQueueDetails, setShowQueueDetails] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState("");
  const [aiSuggestion, setAiSuggestion] = useState<ServerItemSuggestion | null>(null);
  const [aiSuggestionMessage, setAiSuggestionMessage] = useState("");
  const [diagnosisMessage, setDiagnosisMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState("");

  const fileInputRefs: Record<PhotoType, RefObject<HTMLInputElement | null>> = {
    object_front: useRef<HTMLInputElement>(null),
    object_back: useRef<HTMLInputElement>(null),
    type_plate: useRef<HTMLInputElement>(null),
    uvv_label: useRef<HTMLInputElement>(null),
    condition_detail: useRef<HTMLInputElement>(null),
    other: useRef<HTMLInputElement>(null),
  };
  const activeStepRef = useRef<HTMLDivElement>(null);
  const lastStepRef = useRef(step);
  const aiAutoRequestKeyRef = useRef("");

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

  useEffect(() => {
    async function checkStorage() {
      if (!navigator.storage?.estimate) return;
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      if (!quota) return;
      const freeMb = Math.round((quota - usage) / 1024 / 1024);
      const usedPercent = usage / quota;
      if (freeMb < 250 || usedPercent > 0.85) {
        setStorageWarning(`Wenig lokaler Speicher frei: ca. ${freeMb} MB. Bitte bald synchronisieren.`);
      } else {
        setStorageWarning("");
      }
    }
    checkStorage().catch(() => undefined);
  }, []);

  const refreshQueueSummary = useCallback(async () => {
    try {
      const [summary, details] = await Promise.all([
        getQueueSummary(),
        getQueueDetails(joined?.session.id),
      ]);
      setQueueSummary(summary);
      setQueueDetails(details);
    } catch {
      setSyncMessage("Lokale Sync-Liste konnte nicht gelesen werden.");
    }
  }, [joined?.session.id]);

  useEffect(() => {
    initQueue()
      .then(() => getOrCreateDeviceId())
      .then(setDeviceId)
      .then(refreshQueueSummary)
      .catch(() => setSyncMessage("Lokale Speicherung ist auf diesem Gerät nicht verfügbar."));
  }, [refreshQueueSummary]);

  useEffect(() => {
    if (!joined) return;
    api<Bootstrap>("/meta/bootstrap").then((boot) => {
      setBootstrap(boot);
      setObjectClassId(boot.object_classes.find((entry) => entry.slug === "bga")?.id ?? boot.object_classes[0]?.id ?? "");
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Stammdaten nicht erreichbar"));
  }, [joined]);

  useEffect(() => {
    if (!token || !deviceId) return;
    setJoinError("");
    api<Joined>("/sessions/join", {
      method: "POST",
      body: JSON.stringify({ token, device_name: "Handy-Erfassung BGA", device_fingerprint: deviceId }),
    }).then((result) => {
      if (result.access_token) setAuthToken(result.access_token);
      setJoined(result);
    }).catch((err) => {
      setJoinError(err instanceof Error ? err.message : "Join fehlgeschlagen");
      setMessage("Session nicht verfügbar");
    });
  }, [token, deviceId]);

  const roomName = useMemo(() => {
    const room = bootstrap?.rooms.find((entry) => entry.id === joined?.session.room_id);
    return room?.name ?? "Raum";
  }, [bootstrap, joined]);
  const inventoryType = joined?.session.inventory_type || "bga";
  const isBgaSession = inventoryType === "bga";

  const runSync = useCallback(async (label = "Synchronisierung läuft") => {
    setSyncMessage(getOnlineStatus() ? label : "Offline – Daten werden lokal gespeichert.");
    try {
      if (getOnlineStatus()) {
        await syncNow();
        setSyncMessage("Synchronisierung abgeschlossen.");
      }
    } catch {
      setSyncMessage("Upload fehlgeschlagen. Bitte Verbindung prüfen und erneut synchronisieren.");
    } finally {
      await refreshQueueSummary();
      setIsOnline(getOnlineStatus());
    }
  }, [refreshQueueSummary]);

  const buildSyncDiagnosis = useCallback(async () => {
    const [summary, details, items, currentDeviceId] = await Promise.all([
      getQueueSummary(),
      getQueueDetails(joined?.session.id),
      listQueueItems(),
      getOrCreateDeviceId(),
    ]);
    const itemDrafts = items.filter((item) => item.type === "item_draft");
    const photoUploads = items.filter((item) => item.type === "photo_upload");
    const pendingItems = itemDrafts.filter((item) => item.status === "pending" || item.status === "uploading").length;
    const pendingPhotos = photoUploads.filter((item) => item.status === "pending" || item.status === "uploading").length;
    const failedItems = itemDrafts.filter((item) => item.status === "failed").length;
    const failedPhotos = photoUploads.filter((item) => item.status === "failed").length;

    return {
      allgemein: {
        app_version: appVersion,
        token,
        session_id: joined?.session.id ?? null,
        erfassungsart: inventoryTypeLabel(inventoryType),
        inventory_type: inventoryType,
        device_id: currentDeviceId,
        captured_by: queueValue(itemDrafts[0] ?? photoUploads[0] ?? ({} as QueueItem), "captured_by") ?? "nicht angegeben",
        navigator_online: typeof navigator === "undefined" ? null : navigator.onLine,
        zeitpunkt: new Date().toISOString(),
        api_base_url: API_BASE,
        queue_schema_version: queueSchemaVersion(),
        storage_warning: storageWarning || null,
      },
      queue_summary: {
        open: summary.open,
        pendingItems,
        pendingPhotos,
        failedItems,
        failedPhotos,
        conflict: summary.conflict,
        synced: summary.synced,
        total: summary.total,
        lastError: summary.lastError ?? null,
      },
      session_bezug: {
        aktuelle_session_eintraege: details.currentSessionItems.length,
        andere_session_eintraege: details.otherSessionItems.length,
        sessions: details.sessions,
      },
      item_drafts: itemDrafts.map((item) => ({
        client_item_id: item.client_item_id,
        server_item_id: item.server_item_id ?? null,
        session_id: item.session_id,
        source_device_id: item.device_id,
        status: item.status,
        sequence_number: item.sequence_number ?? null,
        designation: String(item.draft?.object_type || item.draft?.designation || item.draft?.name || ""),
        hasPayload: Boolean(item.draft && Object.keys(item.draft).length),
        last_error: item.last_error ?? null,
        created_at: item.created_at,
        updated_at: item.updated_at,
      })),
      photo_uploads: photoUploads.map((item) => {
        const blob = diagnosticPhotoBlob(item);
        return {
          client_photo_id: item.client_photo_id ?? null,
          client_item_id: item.client_item_id,
          server_item_id: item.server_item_id ?? null,
          session_id: item.session_id,
          source_device_id: item.device_id,
          photo_type: item.photo_type ?? null,
          status: item.status,
          blob_vorhanden: blob.vorhanden ? "ja" : "nein",
          blob_size: blob.size,
          blob_type: blob.type,
          upload_url: item.upload_url ?? null,
          debug_state: item.upload_debug_state ?? null,
          health_result: item.health_result ?? null,
          eligible_for_upload: queueBool(item.eligible_for_upload),
          skip_reason: item.skip_reason ?? null,
          fetch_started: queueBool(item.fetch_started),
          http_status: item.upload_response_status ?? null,
          response_text: item.upload_response_text ?? null,
          upload_debug: item.upload_debug ?? null,
          last_error: item.last_error ?? null,
          retry_count: item.retry_count,
          im_bundle_aufnehmbar: item.client_item_id && item.client_photo_id && item.photo_type && item.photo_blob ? "ja" : "nein",
          post_gestartet: item.fetch_started ? "ja" : "nein",
          response_verarbeitet: item.upload_debug_state === "response_received" || item.status === "synced" ? "ja" : "nein",
          lokale_queue_bereinigt: item.status === "synced" ? "bereit zur Bereinigung" : "nein, noch lokal offen",
        };
      }),
      foto_sync_diagnose: buildBundleDiagnostics(items.filter((item) => item.status !== "synced")),
    };
  }, [joined?.session.id, inventoryType, storageWarning, token]);

  const copySyncDiagnostics = useCallback(async () => {
    try {
      const diagnosis = await buildSyncDiagnosis();
      await copyToClipboard(JSON.stringify(diagnosis, null, 2));
      setDiagnosisMessage("Diagnose kopiert. Du kannst sie jetzt einfügen und senden.");
    } catch (error) {
      setDiagnosisMessage(error instanceof Error ? `Diagnose konnte nicht kopiert werden: ${error.message}` : "Diagnose konnte nicht kopiert werden.");
    }
  }, [buildSyncDiagnosis]);

  const runBundleDiagnosticSync = useCallback(async () => {
    setDiagnosisMessage("Foto-Sync wird erneut getestet.");
    await runSync("Foto-Sync wird erneut getestet.");
    setDiagnosisMessage("Foto-Sync-Test abgeschlossen. Details wurden aktualisiert.");
  }, [runSync]);

  useEffect(() => {
    setIsOnline(getOnlineStatus());
    const handleOnline = () => {
      setIsOnline(true);
      void runSync("Verbindung wieder da. Synchronisierung läuft.");
    };
    const handleOffline = () => {
      setIsOnline(false);
      setSyncMessage("Offline – Daten werden lokal gespeichert.");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [runSync]);

  useEffect(() => {
    if (!joined || !isBgaSession) return;
    refreshQueueSummary().then(() => {
      if (getOnlineStatus()) void runSync("Offene lokale Einträge werden synchronisiert.");
    });
  }, [joined, isBgaSession, refreshQueueSummary, runSync]);

  const hasManualInput = Boolean(
    form.object_type.trim() ||
    form.specification.trim() ||
    form.construction_year.trim() ||
    form.condition_note.trim() ||
    form.uvv_valid_until ||
    form.remark.trim() ||
    form.type_plate_status !== "nicht_geprueft" ||
    form.function_ok !== "nicht_geprueft" ||
    form.uvv_status !== "unklar" ||
    form.condition !== emptyForm.condition,
  );
  const canSaveDraft = Boolean(activeItem || photos.length || hasManualInput);

  function buildDraft(clientItemId: string) {
    return {
      session_id: joined?.session.id,
      inventory_type: "bga",
      object_class_id: objectClassId || null,
      object_type: form.object_type || null,
      specification: form.specification || null,
      construction_year: form.construction_year || null,
      condition: form.condition,
      condition_note: form.condition_note || null,
      function_ok: form.function_ok,
      uvv_status: form.uvv_status,
      uvv_valid_until: form.uvv_valid_until || null,
      inspection_book_available: form.inspection_book_available,
      remark: form.remark || null,
      type_plate_status: form.type_plate_status,
      client_item_id: clientItemId,
      source_device_id: deviceId,
    };
  }

  async function ensureItem() {
    if (activeItem) return activeItem;
    if (!joined) throw new Error("Session noch nicht gekoppelt");
    if (!isBgaSession) throw new Error(`${inventoryTypeLabel(inventoryType)} ist vorbereitet, aber noch nicht aktiv.`);
    if (!deviceId) throw new Error("Gerät wird noch vorbereitet");
    const clientItemId = createClientItemId();
    const sequenceNumber = await nextLocalSequenceNumber(joined.session.id);
    const queued = await enqueueItemDraft({
      session_id: joined.session.id,
      device_id: deviceId,
      client_item_id: clientItemId,
      sequence_number: sequenceNumber,
      draft: buildDraft(clientItemId),
    });
    const item: LocalItem = {
      id: queued.client_item_id,
      inventory_id: "",
      temporary_id: `Lokal-${sequenceNumber}`,
      sequence_number: sequenceNumber,
    };
    setActiveItem(item);
    await refreshQueueSummary();
    return item;
  }

  function openCamera(type: PhotoType) {
    if (busy) return;
    const input = fileInputRefs[type].current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  async function compressPhoto(file: File, photoType: PhotoType) {
    if (!file.type.startsWith("image/")) return file;
    const maxSide = photoMaxSide[photoType];
    const quality = photoType === "type_plate" || photoType === "uvv_label" || photoType === "condition_detail" ? 0.9 : 0.86;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }
    const scale = Math.min(maxSide / Math.max(bitmap.width, bitmap.height), 1);
    if (scale >= 1 && file.size <= 1_200_000) {
      bitmap.close?.();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return file;
    const name = `${file.name.replace(/\.[^.]+$/, "") || photoType}.jpg`;
    return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
  }

  async function handlePhotoSelected(type: PhotoType, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    event.target.value = "";
    if (photos.length >= 5) {
      setMessage("Maximal 5 Fotos pro Gegenstand möglich");
      return;
    }
    setBusy(true);
    setUploadProgress(0);
    try {
      setUploadState("Foto wird verkleinert");
      const item = await ensureItem();
      const prepared = await compressPhoto(file, type);
      setUploadState("Foto wird lokal gespeichert");
      setUploadProgress(100);
      const queuedPhoto = await enqueuePhotoUpload({
        session_id: joined?.session.id ?? "",
        device_id: deviceId,
        client_item_id: item.id,
        server_item_id: item.server_item_id,
        sequence_number: item.sequence_number,
        photo_type: type,
        photo_blob: prepared,
        file_name: prepared.name,
        file_type: prepared.type,
        file_size: prepared.size,
      });
      setPhotos((current) => [...current, { type, id: queuedPhoto.client_photo_id, name: prepared.name, size: prepared.size, previewUrl: URL.createObjectURL(prepared) }]);
      if (type === "type_plate" && step === 0) {
        setStep(1);
      }
      setMessage(`${photoLabels[type]} lokal gespeichert. ${getOnlineStatus() ? "Synchronisierung läuft." : "Foto wird später übertragen."}`);
      await refreshQueueSummary();
      void runSync("Foto wird synchronisiert.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Foto ist lokal nicht gespeichert worden.");
    } finally {
      setBusy(false);
      setUploadState("");
      setUploadProgress(0);
    }
  }

  async function saveObject() {
    if (!canSaveDraft || busy) {
      setMessage("Noch keine Eingabe vorhanden. Bitte Foto aufnehmen oder eine Angabe erfassen.");
      return;
    }
    setBusy(true);
    try {
      const item = activeItem ?? (await ensureItem());
      const isCompleteCapture = photos.some((photo) => photo.type === "object_front") && Boolean(form.object_type.trim());
      await enqueueItemDraft({
        session_id: joined?.session.id ?? "",
        device_id: deviceId,
        client_item_id: item.id,
        sequence_number: item.sequence_number,
        draft: buildDraft(item.id),
      });
      const savedLabel = form.object_type || item.inventory_id || item.temporary_id || "Entwurf";
      setSavedItem({ label: savedLabel });
      setActiveItem(null);
      setForm(emptyForm);
      setEditedFields({});
      setPhotos([]);
      setAiSuggestion(null);
      setAiSuggestionMessage("");
      aiAutoRequestKeyRef.current = "";
      setStep(0);
      setMessage(
        isCompleteCapture
          ? `${savedLabel} lokal gespeichert. Bereit für nächstes Objekt.`
          : "Offline oder Pflichtangaben fehlen. Das Objekt wurde lokal als Entwurf gesichert. Bitte später ergänzen und synchronisieren.",
      );
      await runSync("Objekt wird synchronisiert.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Objekt konnte lokal nicht gespeichert werden");
    } finally {
      setBusy(false);
    }
  }

  async function retrySync() {
    setSyncMessage("Fehler werden erneut synchronisiert.");
    try {
      await retryFailed();
      const summary = await getQueueSummary();
      setSyncMessage(summary.open ? `${summary.pendingPhotos} Fotos warten noch auf Synchronisierung.` : "Synchronisierung abgeschlossen.");
    } catch {
      setSyncMessage("Upload fehlgeschlagen. Bitte Verbindung prüfen und erneut synchronisieren.");
    } finally {
      await refreshQueueSummary();
    }
  }

  async function discardOpenQueue() {
    if (discardConfirm !== "VERWERFEN" || !queueDetails?.openItems.length) return;
    await discardQueueItems(queueDetails.openItems.map((item) => item.id));
    setDiscardConfirm("");
    setShowQueueDetails(false);
    setSyncMessage("Lokale Daten wurden bewusst verworfen.");
    await refreshQueueSummary();
  }

  function update<K extends keyof BgaForm>(key: K, value: BgaForm[K]) {
    setSavedItem(null);
    setEditedFields((current) => ({ ...current, [key]: true }));
    setForm((current) => ({ ...current, [key]: value }));
  }

  function decideTypePlate(status: BgaForm["type_plate_status"]) {
    update("type_plate_status", status);
    if (status === "vorhanden") {
      openCamera("type_plate");
      return;
    }
    setStep(1);
    setMessage(status === "nicht_vorhanden" ? "Kein Typenschild vorhanden. Weiter mit KI-Vorschlag." : "Typenschild nicht erkennbar. Weiter mit KI-Vorschlag.");
  }

  function decideFunctionOk(value: FunctionOk) {
    update("function_ok", value);
    if (value === "nein") {
      setMessage("Funktion nicht in Ordnung. Nacharbeit wird vorgemerkt, du kannst weiter erfassen.");
    } else if (value === "nicht_geprueft") {
      setMessage("Funktion nicht geprüft. Nacharbeit wird vorgemerkt, du kannst weiter erfassen.");
    }
  }

  function decideUvvStatus(value: UvvStatus) {
    setSavedItem(null);
    setEditedFields((current) => ({ ...current, uvv_status: true, uvv_valid_until: true }));
    setForm((current) => ({
      ...current,
      uvv_status: value,
      uvv_valid_until: value === "vorhanden" ? current.uvv_valid_until : "",
    }));
    if (value === "vorhanden") {
      setMessage("UVV vorhanden. Datum eintragen und Siegel optional fotografieren.");
    } else if (value === "nicht_vorhanden") {
      setMessage("UVV nicht vorhanden. Kein UVV-Foto nötig, Nacharbeit wird vorgemerkt.");
    } else if (value === "nicht_uvv_pflichtig") {
      setMessage("Nicht UVV-pflichtig. Kein UVV-Foto nötig.");
    } else {
      setMessage("UVV unklar. Nacharbeit wird vorgemerkt, du kannst weiter erfassen.");
    }
  }

  function startNextObject() {
    setSavedItem(null);
    setActiveItem(null);
    setForm(emptyForm);
    setEditedFields({});
    setPhotos([]);
    setAiSuggestion(null);
    setAiSuggestionMessage("");
    aiAutoRequestKeyRef.current = "";
    setStep(0);
    setMessage("Bereit für nächstes Objekt");
  }

  const hasObjectPhoto = photos.some((photo) => photo.type === "object_front");
  const hasTypePlatePhoto = photos.some((photo) => photo.type === "type_plate");
  const summaryBlockers = [
    !hasObjectPhoto ? "Objektfoto fehlt" : "",
    !form.object_type.trim() ? "Bezeichnung fehlt" : "",
  ].filter(Boolean);
  const summaryRework = [
    form.condition === "unklar" ? "Zustand unklar" : "",
    form.function_ok === "nein" ? "Funktion nicht in Ordnung" : "",
    form.function_ok === "nicht_geprueft" ? "Funktion nicht geprüft" : "",
    form.uvv_status === "nicht_vorhanden" ? "UVV nicht vorhanden" : "",
    form.uvv_status === "unklar" ? "UVV klären" : "",
    form.uvv_status === "vorhanden" && !form.uvv_valid_until ? "UVV-Datum offen" : "",
    form.type_plate_status === "vorhanden" && !photos.some((photo) => photo.type === "type_plate") ? "Typenschildfoto fehlt" : "",
    form.type_plate_status === "unklar" ? "Typenschild nicht erkennbar" : "",
  ].filter(Boolean);
  const openQueueItems = queueDetails?.openItems ?? [];
  const openQueueObjects = openQueueItems.filter((item) => item.type === "item_draft").length;
  const openQueuePhotos = openQueueItems.filter((item) => item.type === "photo_upload").length;
  const hasOpenLocalQueue = Boolean(joined) && isBgaSession && openQueueItems.length > 0;
  const openQueueIntro = openQueuePhotos
    ? `Es sind noch ${openQueuePhotos} Fotos auf diesem iPhone gespeichert, die noch nicht übertragen wurden.`
    : `Es sind noch ${openQueueObjects} Objekte auf diesem iPhone gespeichert, die noch nicht übertragen wurden.`;
  const otherSessionOpen = queueDetails?.otherSessionItems.length ?? 0;
  const currentSessionOpen = queueDetails?.currentSessionItems.length ?? 0;
  const hasQueueFailure = queueSummary.failed > 0;
  const hasQueueConflict = queueSummary.conflict > 0;
  const hasForeignQueue = otherSessionOpen > 0;
  const shouldPauseForQueue = Boolean(joined) && isBgaSession && (hasForeignQueue || hasQueueConflict);
  const isCurrentSessionPendingOnly = hasOpenLocalQueue && currentSessionOpen > 0 && !hasForeignQueue && !hasQueueFailure && !hasQueueConflict;
  const syncText = isCurrentSessionPendingOnly && !isOnline
    ? "Offline-Erfassung aktiv"
    : !isOnline
    ? "Offline – Daten werden lokal gespeichert"
    : hasQueueConflict
      ? `Übertragung prüfen – ${queueSummary.conflict} lokale Einträge`
    : hasQueueFailure
      ? `Fehler – ${queueSummary.failed} Uploads erneut versuchen`
      : queueSummary.open
        ? `Upload läuft – ${queueSummary.open} Einträge offen`
      : "Alles synchronisiert";
  const syncDetail = isCurrentSessionPendingOnly
    ? `${openQueueObjects} Objekte und ${openQueuePhotos} Fotos sind lokal auf diesem iPhone gesichert und werden später synchronisiert.`
    : hasQueueConflict
    ? "Diese Daten gehören vermutlich zu einer alten oder gelöschten Session. Bitte Details prüfen. Testdaten kannst du bewusst verwerfen."
    : hasQueueFailure
    ? "Die Fotos konnten noch nicht übertragen werden. Bitte WLAN/Mobilfunk prüfen und erneut synchronisieren."
    : queueSummary.pendingPhotos
      ? `${queueSummary.pendingPhotos} Fotos offen. Lokal gesichert, bis der Server den Upload bestätigt.`
      : syncMessage || "Lokale Queue ist leer.";
  const canCaptureInThisSession = Boolean(joined) && isBgaSession && !shouldPauseForQueue;
  const shouldShowSyncActions = !isOnline
    || queueSummary.open > 0
    || hasQueueFailure
    || hasQueueConflict
    || (Boolean(syncMessage) && syncMessage !== "Synchronisierung abgeschlossen.");

  useEffect(() => {
    if (!canCaptureInThisSession || savedItem) return;
    if (lastStepRef.current === step) return;
    lastStepRef.current = step;
    window.requestAnimationFrame(() => {
      activeStepRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [canCaptureInThisSession, savedItem, step]);

  async function findServerItemId(clientItemId: string) {
    const entries = await listQueueItems();
    const queuedServerItemId = entries.find((entry) => entry.type === "item_draft" && entry.client_item_id === clientItemId && entry.server_item_id)?.server_item_id;
    if (queuedServerItemId) return queuedServerItemId;
    if (!joined?.session.id || !deviceId) return undefined;
    const params = new URLSearchParams({
      session_id: joined.session.id,
      source_device_id: deviceId,
      client_item_id: clientItemId,
    });
    const resolved = await api<{ id: string }>(`/items/resolve-client?${params.toString()}`).catch(() => null);
    if (resolved?.id) {
      setActiveItem((current) => current?.id === clientItemId ? { ...current, server_item_id: resolved.id } : current);
    }
    return resolved?.id;
  }

  function normalizeAiPayload(payload?: ServerItemSuggestion | null): ServerItemSuggestion | null {
    if (!payload) return null;
    const detection = payload.bga_detection ?? null;
    const source = detection ? { ...payload, ...detection, suggested_fields: detection.suggested_fields ?? payload.suggested_fields } : payload;
    const suggested = source.suggested_fields ?? {};
    const objectType = suggested.object_type || source.object_name || source.object_type;
    if (!objectType && !source.specification && !source.condition_guess && !source.suggested_remark) return null;
    return {
      ...source,
      object_type: objectType,
      specification: suggested.specification || source.specification || "",
      condition: suggested.condition || source.condition_guess || source.condition || "",
      construction_year: suggested.construction_year || source.construction_year || "",
      suggested_remark: suggested.remark || source.suggested_remark || source.uncertainty_reason || "",
      confidence_score: source.confidence ?? source.confidence_score,
    };
  }

  function latestAiSuggestion(item?: ServerItemWithAi | null) {
    if (!item) return null;
    const latest = item.ai_results?.find((entry) => entry.ai_type !== "deep_dive" && entry.result_json);
    return normalizeAiPayload(latest?.result_json) ?? normalizeAiPayload(item);
  }

  function aiSpecSuggestion(item: ServerItemSuggestion) {
    const specParts = [
      item.suggested_fields?.specification,
      item.specification,
      item.manufacturer || item.brand,
      item.model,
      item.serial_number ? `SN ${item.serial_number}` : "",
    ]
      .filter(Boolean)
      .map(String);
    return specParts.join(" · ");
  }

  function aiRemarkSuggestion(item: ServerItemSuggestion) {
    return item.suggested_fields?.remark || item.suggested_remark || item.uncertainty_reason || (item.status?.startsWith("ki_") ? "KI-Vorschlag vorhanden, bitte prüfen." : "");
  }

  function aiConfidenceLabel(item: ServerItemSuggestion) {
    const raw = Number(item.confidence ?? item.confidence_score ?? 0);
    const normalized = raw > 1 ? raw / 100 : raw;
    if (!normalized) return "bitte prüfen";
    if (item.requires_manual_review || normalized < 0.85) return "unsicher · bitte prüfen";
    return "KI-Vorschlag · bitte prüfen";
  }

  function aiSuggestionRows(item: ServerItemSuggestion) {
    const estimateValue = item.estimated_value_eur ?? item.value_estimate;
    const ageValue = item.estimated_age_years || estimateValue
      ? `${item.estimated_age_years ?? "Alter offen"} Jahre · ${estimateValue ?? "Wert offen"} €`
      : "";
    return [
      { key: "object_type", label: "Bezeichnung", value: item.suggested_fields?.object_type || item.object_name || item.object_type || "", field: "object_type" as const },
      { key: "specification", label: "Typ/Spezifikation", value: aiSpecSuggestion(item), field: "specification" as const },
      { key: "condition", label: "Zustand", value: item.suggested_fields?.condition || item.condition_guess || item.condition || "", field: "condition" as const },
      { key: "construction_year", label: "Baujahr", value: item.suggested_fields?.construction_year || item.construction_year || "", field: "construction_year" as const, note: "bitte prüfen" },
      { key: "remark", label: "Bemerkung", value: aiRemarkSuggestion(item), field: "remark" as const },
      { key: "estimate", label: "Alter/Wert", value: ageValue, note: `${item.estimated_value_reason || item.age_reason || "KI-Schätzung"} · manuell prüfen` },
    ].filter((row) => row.value);
  }

  function applyAiSuggestionField(key: keyof BgaForm, value: string) {
    setEditedFields((current) => ({ ...current, [key]: true }));
    setForm((current) => ({ ...current, [key]: value }));
    setAiSuggestionMessage("KI-Vorschlag übernommen. Bitte prüfen und bei Bedarf korrigieren.");
  }

  function applyAiSuggestionsToEmptyFields(item: ServerItemSuggestion) {
    const specSuggestion = aiSpecSuggestion(item);
    const remarkSuggestion = aiRemarkSuggestion(item);
    const conditionSuggestion = item.suggested_fields?.condition || item.condition_guess || item.condition || "";
    setForm((current) => ({
      ...current,
      object_type: current.object_type || item.suggested_fields?.object_type || item.object_name || item.object_type || "",
      specification: current.specification || specSuggestion,
      construction_year: current.construction_year || item.suggested_fields?.construction_year || item.construction_year || "",
      condition: editedFields.condition ? current.condition : conditionSuggestion || current.condition,
      remark: current.remark || remarkSuggestion,
    }));
    setAiSuggestionMessage("Leere Felder wurden automatisch mit KI-Vorschlägen gefüllt. Bitte prüfen.");
  }

  async function loadAiSuggestion() {
    if (!activeItem || busy) return;
    setBusy(true);
    setAiSuggestionMessage("KI-Vorschlag wird vorbereitet.");
    try {
      await enqueueItemDraft({
        session_id: joined?.session.id ?? "",
        device_id: deviceId,
        client_item_id: activeItem.id,
        sequence_number: activeItem.sequence_number,
        draft: buildDraft(activeItem.id),
      });
      await runSync("Fotos und Objekt werden für KI synchronisiert.");
      let serverItemId = await findServerItemId(activeItem.id);
      for (let attempt = 0; !serverItemId && attempt < 4; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 550));
        serverItemId = await findServerItemId(activeItem.id);
      }
      if (!serverItemId) {
        setAiSuggestionMessage("Objekt ist lokal gesichert. KI-Vorschlag kommt nach der Synchronisierung.");
        return;
      }
      const aiStart = await api<{ status?: string; message?: string }>(`/items/${serverItemId}/ai/run?mode=review`, { method: "POST", body: "{}" }).catch(() => null);
      if (aiStart?.status === "skipped") {
        setAiSuggestionMessage(aiStart.message || "KI-Vorschlag erst nach Objektfoto möglich.");
        return;
      }
      let serverSuggestion: ServerItemSuggestion | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const serverItem = await api<ServerItemWithAi>(`/items/${serverItemId}`);
        serverSuggestion = latestAiSuggestion(serverItem);
        if (serverSuggestion || serverItem.status === "ki_pruefung_fertig" || serverItem.status === "ki_schnell_fertig") break;
      }
      if (serverSuggestion) {
        setAiSuggestion(serverSuggestion);
        applyAiSuggestionsToEmptyFields(serverSuggestion);
      } else {
        setAiSuggestionMessage("Noch kein KI-Vorschlag verfügbar. Du kannst normal weiterarbeiten.");
      }
    } catch {
      setAiSuggestionMessage("KI-Vorschlag ist gerade nicht verfügbar. Du kannst normal weiterarbeiten.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (step !== 1 || !hasObjectPhoto || !activeItem || aiSuggestion || busy) return;
    const requestKey = `${activeItem.id}:${photos.filter((photo) => photo.type === "object_front" || photo.type === "type_plate").length}`;
    if (aiAutoRequestKeyRef.current === requestKey) return;
    aiAutoRequestKeyRef.current = requestKey;
    void loadAiSuggestion();
  }, [activeItem, aiSuggestion, busy, hasObjectPhoto, photos, step]);

  return (
    <main className="page grid mobile-capture-page bga-wizard-page">
      <section className="mobile-capture-shell bga-wizard">
        {joined ? <div className="mobile-room-bar">
          <div>
            <strong>{roomName}</strong>
            <span>{inventoryTypeLabel(inventoryType)}</span>
          </div>
          <span className="live-indicator">Live</span>
        </div> : null}

        {!joined ? (
          <section className={`wizard-card join-state-card ${joinError ? "is-error" : ""}`}>
            <h1>{joinError ? "Session nicht verfügbar" : "Session wird geöffnet"}</h1>
            <p>
              {joinError
                ? "Der QR-Code ist ungültig oder abgelaufen. Bitte öffne einen aktuellen QR-Code aus der Prüferliste."
                : "Die Handy-Erfassung wird vorbereitet."}
            </p>
            {joinError ? <div className="summary-box danger"><strong>Hinweis</strong><span>{joinError}</span></div> : null}
          </section>
        ) : null}

        {joined && isBgaSession && !shouldPauseForQueue ? (
          <div className={`mobile-sync-bar ${!isOnline ? "is-offline" : queueSummary.failed || queueSummary.conflict ? "is-failed" : queueSummary.open ? "is-pending" : "is-synced"} ${shouldShowSyncActions ? "" : "is-compact"}`}>
            <div>
              <strong>{syncText}</strong>
              <span>{syncDetail}</span>
            </div>
            {shouldShowSyncActions ? (
              <button
                className="btn secondary"
                type="button"
                disabled={false}
                onClick={() => void retrySync()}
                title={!isOnline ? "Synchronisierung wird versucht. Wenn keine Verbindung besteht, bleiben die Daten lokal gesichert." : undefined}
              >
                Jetzt synchronisieren
              </button>
            ) : null}
            {queueSummary.failed ? <button className="btn secondary" type="button" onClick={() => void retrySync()}>Fehler erneut versuchen</button> : null}
            {hasOpenLocalQueue ? <button className="btn secondary" type="button" onClick={() => setShowQueueDetails((value) => !value)}>Details anzeigen</button> : null}
          </div>
        ) : null}

        {storageWarning ? (
          <div className="mobile-storage-warning" role="status">
            {storageWarning}
          </div>
        ) : null}

        {hasOpenLocalQueue && !shouldPauseForQueue && queueDetails && showQueueDetails ? (
          <section className="wizard-card queue-detail-list">
            <QueueDetailsPanel
              queueDetails={queueDetails}
              joinedSessionId={joined?.session.id}
              diagnosisMessage={diagnosisMessage}
              copySyncDiagnostics={() => void copySyncDiagnostics()}
              runBundleDiagnosticSync={() => void runBundleDiagnosticSync()}
              discardConfirm={discardConfirm}
              setDiscardConfirm={setDiscardConfirm}
              discardOpenQueue={discardOpenQueue}
            />
          </section>
        ) : null}

        {shouldPauseForQueue && queueDetails ? (
          <section className="wizard-card queue-warning is-blocking">
            <h2>Übertragung prüfen</h2>
            <p>
              {openQueueIntro} Bitte zuerst synchronisieren oder bewusst verwerfen, bevor du weiter erfasst.
            </p>
            <div className="queue-stats">
              <span><strong>{openQueueObjects}</strong> Objekte offen</span>
              <span><strong>{openQueuePhotos}</strong> Fotos offen</span>
              <span><strong>{queueSummary.failed}</strong> fehlgeschlagen</span>
              <span><strong>{queueSummary.conflict}</strong> zu prüfen</span>
            </div>
            {otherSessionOpen ? (
              <p className="queue-warning-text">
                Es gibt offene lokale Daten aus einer anderen Session. Wenn die alte Session gelöscht wurde, prüfe die Details. Testdaten kannst du bewusst verwerfen.
              </p>
            ) : (
              <p className="muted">Diese offenen Daten gehören zur aktuellen Session: {currentSessionOpen} Einträge.</p>
            )}
            <p className="muted">{syncDetail}</p>
            <div className="queue-actions">
              <button className="btn accent" type="button" onClick={() => void retrySync()}>Jetzt synchronisieren</button>
              <button className="btn secondary" type="button" onClick={() => setShowQueueDetails((value) => !value)}>Details anzeigen</button>
            </div>
            {showQueueDetails ? (
              <QueueDetailsPanel
                queueDetails={queueDetails}
                joinedSessionId={joined?.session.id}
                diagnosisMessage={diagnosisMessage}
                copySyncDiagnostics={() => void copySyncDiagnostics()}
                runBundleDiagnosticSync={() => void runBundleDiagnosticSync()}
                discardConfirm={discardConfirm}
                setDiscardConfirm={setDiscardConfirm}
                discardOpenQueue={discardOpenQueue}
              />
            ) : null}
            <div className="capture-paused-note">Erfassung pausiert, bis die lokale Übertragung geklärt ist.</div>
          </section>
        ) : null}

        {joined && !isBgaSession ? (
          <section className="wizard-card saved-card">
            <h1>{inventoryTypeLabel(inventoryType)}</h1>
            <p>{inventoryTypeLabel(inventoryType)}-Erfassung ist vorbereitet, aber in der Handy-Erfassung noch nicht aktiv.</p>
            <a className="btn secondary" href={`/session/${joined.session.id}`}>Zur Session-Ansicht</a>
          </section>
        ) : null}

        {canCaptureInThisSession ? <div className={`capture-status ${busy ? "is-busy" : savedItem ? "is-done" : ""}`}>
          <strong>{busy ? uploadState || "Bitte warten" : savedItem ? "Objekt gespeichert" : `Schritt ${step + 1} von ${steps.length}: ${steps[step]}`}</strong>
          <span>{busy && uploadProgress ? `${uploadProgress}% lokal gesichert` : message}</span>
        </div> : null}

        {canCaptureInThisSession && busy && uploadProgress ? (
          <div className="upload-meter" aria-label="Upload-Fortschritt">
            <span style={{ width: `${uploadProgress}%` }} />
          </div>
        ) : null}

        {canCaptureInThisSession && savedItem ? (
          <section className="wizard-card saved-card">
            <div className="saved-mark">✓</div>
            <h1>Objekt gespeichert</h1>
            <p>{savedItem.label} ist lokal gesichert und wird synchronisiert.</p>
            <button className="btn accent" type="button" onClick={startNextObject}>Nächstes Objekt erfassen</button>
            {joined ? <a className="btn secondary" href={`/session/${joined.session.id}`}>Zur Prüfliste</a> : null}
          </section>
        ) : null}

        {canCaptureInThisSession && !savedItem ? <div className="wizard-progress">
          {steps.map((label, index) => (
            <button
              key={label}
              className={index === step ? "is-active" : index < step ? "is-done" : ""}
              type="button"
              aria-label={`Schritt ${index + 1}: ${label}`}
              title={label}
              onClick={() => setStep(index)}
            >
              {index + 1}
            </button>
          ))}
        </div> : null}

        {canCaptureInThisSession && !savedItem ? (
          <div className="wizard-step-anchor" ref={activeStepRef}>
            {step === 0 ? (
              <WizardCard title="Fotos & Nachweise" hint="Objekt vollständig fotografieren. Typenschild und weitere Nachweise direkt hier ergänzen.">
                <button className="mobile-photo-stage" type="button" disabled={busy} onClick={() => openCamera("object_front")}>
                  <span>Objekt fotografieren</span>
                  <small>{photos.filter((photo) => photo.type === "object_front").length ? "Objektfoto gespeichert" : "Pflichtfoto"}</small>
                </button>
                <div className="summary-box info">
                  <strong>Typenschild</strong>
                  <span>Wenn vorhanden, gut lesbar fotografieren. Daraus können Hersteller, Modell und Baujahr besser erkannt werden.</span>
                </div>
                <div className="choice-grid">
                  <button
                    className={form.type_plate_status === "vorhanden" ? "is-active" : ""}
                    type="button"
                    disabled={busy}
                    onClick={() => decideTypePlate("vorhanden")}
                  >
                    Typenschild fotografieren
                  </button>
                  <button
                    className={form.type_plate_status === "nicht_vorhanden" ? "is-active" : ""}
                    type="button"
                    disabled={busy}
                    onClick={() => decideTypePlate("nicht_vorhanden")}
                  >
                    Kein Typenschild vorhanden
                  </button>
                  <button
                    className={form.type_plate_status === "unklar" ? "is-active" : ""}
                    type="button"
                    disabled={busy}
                    onClick={() => decideTypePlate("unklar")}
                  >
                    Nicht erkennbar
                  </button>
                </div>
                <div className="summary-box">
                  <strong>Weiteres Foto hinzufügen</strong>
                  <span>Optional, falls es für Prüfung oder Nacharbeit hilft.</span>
                </div>
                <div className="choice-grid">
                  <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("condition_detail")}>Zustand/Schaden fotografieren</button>
                  <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("other")}>Weiteres Foto</button>
                </div>
                {photos.length ? <PhotoPreviewList photos={photos} labels={photoLabels} /> : null}
              </WizardCard>
            ) : null}

            {step === 1 ? (
              <WizardCard title="KI-Vorschlag" hint="KI füllt leere Felder automatisch. Bitte alles prüfen.">
                <div className="summary-box info">
                  <strong>KI-Vorschlag – bitte prüfen</strong>
                  <span>Die KI startet mit Objektfoto automatisch. Ein Typenschildfoto wird zusätzlich genutzt, wenn es vorhanden ist.</span>
                  {aiSuggestionMessage ? <span>{aiSuggestionMessage}</span> : null}
                </div>
                {aiSuggestion ? (
                  <div className="summary-list ai-suggestion-list">
                    {aiSuggestionRows(aiSuggestion).map((row) => (
                      <span key={row.key}>
                        <b>{row.label}</b>
                        <span>{row.value}</span>
                        <small>{row.note || aiConfidenceLabel(aiSuggestion)}</small>
                        {row.field ? (
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() => applyAiSuggestionField(row.field, row.value)}
                          >
                            Ersetzen
                          </button>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                <button className="btn accent" type="button" disabled={busy || !hasObjectPhoto} onClick={() => void loadAiSuggestion()}>
                  KI erneut prüfen
                </button>
                {!hasObjectPhoto ? <p className="muted">Zuerst Objektfoto aufnehmen.</p> : null}
              </WizardCard>
            ) : null}

            {step === 2 ? (
              <WizardCard title="Stammdaten" hint="Bezeichnung, Typ und Baujahr eintragen oder KI-Vorschlag prüfen.">
                <label className="field">
                  <span>Bezeichnung</span>
                  <input value={form.object_type} onChange={(event) => update("object_type", event.target.value)} placeholder="z. B. Ölschlucker" />
                </label>
                <label className="field">
                  <span>Typ / Spezifikation</span>
                  <textarea rows={4} value={form.specification} onChange={(event) => update("specification", event.target.value)} placeholder="z. B. Hersteller, Modell, Größe, Traglast, technische Daten" />
                </label>
                <label className="field">
                  <span>Baujahr</span>
                  <input inputMode="numeric" value={form.construction_year} onChange={(event) => update("construction_year", event.target.value)} placeholder="z. B. 2018 oder unbekannt" />
                </label>
                {aiSuggestion?.estimated_age_years ? <p className="muted">KI-Schätzung: ca. {aiSuggestion.estimated_age_years} Jahre. Bitte nicht als gesichertes Baujahr übernehmen, wenn keine Quelle erkennbar ist.</p> : null}
              </WizardCard>
            ) : null}

            {step === 3 ? (
              <WizardCard title="Zustand & Prüfung" hint="Zustand, Funktion, UVV und Bemerkung kompakt erfassen.">
                <label className="field">
                  <span>Zustand</span>
                  <select value={form.condition} onChange={(event) => update("condition", event.target.value)}>
                    <option value="sehr_gut">sehr gut</option>
                    <option value="gut">gut</option>
                    <option value="gebraucht">gebraucht</option>
                    <option value="reparaturbeduerftig">reparaturbedürftig</option>
                    <option value="defekt">defekt</option>
                    <option value="unklar">unklar</option>
                  </select>
                </label>
                <label className="field">
                  <span>Zustandsbemerkung</span>
                  <textarea rows={3} value={form.condition_note} onChange={(event) => update("condition_note", event.target.value)} placeholder="z. B. stark verschmutzt, beschädigt, funktionsfähig laut Nutzer" />
                </label>
                <div className="summary-box">
                  <strong>Funktion i. O.</strong>
                  <span>Kurze Funktionsbewertung auswählen.</span>
                </div>
                <div className="choice-grid">
                  {[
                    ["ja", "Ja"],
                    ["nein", "Nein"],
                    ["nicht_geprueft", "Nicht geprüft"],
                  ].map(([value, label]) => (
                    <button key={value} className={form.function_ok === value ? "is-active" : ""} type="button" onClick={() => decideFunctionOk(value as FunctionOk)}>{label}</button>
                  ))}
                </div>
                <label className="field">
                  <span>UVV Status</span>
                  <select value={form.uvv_status} onChange={(event) => decideUvvStatus(event.target.value as UvvStatus)}>
                    <option value="vorhanden">UVV vorhanden</option>
                    <option value="nicht_vorhanden">UVV nicht vorhanden</option>
                    <option value="nicht_uvv_pflichtig">nicht UVV-pflichtig</option>
                    <option value="unklar">unklar</option>
                  </select>
                </label>
                {form.uvv_status === "vorhanden" ? (
                  <>
                    <label className="field">
                      <span>UVV gültig bis</span>
                      <input type="date" value={form.uvv_valid_until} onChange={(event) => update("uvv_valid_until", event.target.value)} />
                    </label>
                    <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("uvv_label")}>UVV-Siegel fotografieren</button>
                  </>
                ) : (
                  <div className="summary-box info">
                    <strong>Kein UVV-Foto nötig</strong>
                    <span>{form.uvv_status === "unklar" ? "UVV wird als Nacharbeit gekennzeichnet." : "Diese Entscheidung überspringt das UVV-Siegel-Foto."}</span>
                  </div>
                )}
                <label className="field">
                  <span>Bemerkung</span>
                  <textarea rows={5} value={form.remark} onChange={(event) => update("remark", event.target.value)} placeholder="z. B. Standortdetail, Zubehör, auffällige Schäden, Nutzerhinweis" />
                </label>
              </WizardCard>
            ) : null}

            {step === 4 ? (
              <WizardCard title="Zusammenfassung" hint="Prüfen, dann speichern.">
                <div className="summary-list">
                  <span><b>Bezeichnung</b>{form.object_type || "fehlt"}</span>
                  <span><b>Typ/Spezifikation</b>{form.specification || "offen"}</span>
                  <span><b>Baujahr</b>{form.construction_year || "offen"}</span>
                  <span><b>Zustand</b>{form.condition}</span>
                  <span><b>Funktion</b>{form.function_ok}</span>
                  <span><b>UVV</b>{form.uvv_status}{form.uvv_valid_until ? ` bis ${form.uvv_valid_until}` : ""}</span>
                  <span><b>Fotos</b>{photos.length}/5</span>
                </div>
                {photos.length ? (
                  <div className="photo-summary">
                    {photos.map((photo, index) => <span key={`${photo.type}-${index}`}>{photoLabels[photo.type]}</span>)}
                  </div>
                ) : null}
                <div className="summary-checks">
                  {summaryBlockers.length ? (
                    <div className="summary-box danger">
                      <strong>Fehlt für Abschluss</strong>
                      {summaryBlockers.map((entry) => <span key={entry}>{entry}</span>)}
                      <span>Entwurf lokal speichern ist trotzdem möglich.</span>
                    </div>
                  ) : <div className="summary-box ok"><strong>Vollständig genug</strong><span>Pflichtfoto und Bezeichnung sind vorhanden.</span></div>}
                  {summaryRework.length ? (
                    <div className="summary-box warn">
                      <strong>Erzeugt Nacharbeit</strong>
                      {summaryRework.map((entry) => <span key={entry}>{entry}</span>)}
                    </div>
                  ) : <div className="summary-box ok"><strong>Keine automatische Nacharbeit</strong><span>Keine kritischen Hinweise in dieser Aufnahme.</span></div>}
                </div>
                <button className="btn accent" type="button" disabled={!canSaveDraft || busy} onClick={saveObject}>
                  {summaryBlockers.length ? "Entwurf lokal speichern" : "Speichern & synchronisieren"}
                </button>
                <button className="btn secondary" type="button" onClick={() => setStep(0)}>Zurück bearbeiten</button>
              </WizardCard>
            ) : null}
          </div>
        ) : null}

        {canCaptureInThisSession && !savedItem ? <div className="wizard-nav">
          <button className="btn secondary" type="button" disabled={step === 0 || busy} onClick={() => setStep((value) => Math.max(0, value - 1))}>Zurück</button>
          <button className="btn" type="button" disabled={step === steps.length - 1 || busy} onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>Weiter</button>
        </div> : null}

        {canCaptureInThisSession ? (["object_front", "object_back", "type_plate", "uvv_label", "condition_detail", "other"] as PhotoType[]).map((type) => (
          <input
            key={type}
            ref={fileInputRefs[type]}
            className="visually-hidden-file"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => handlePhotoSelected(type, event)}
          />
        )) : null}

        {canCaptureInThisSession && !savedItem && joined ? <a className="btn secondary" href={`/session/${joined.session.id}`}>Tablet-Liste bearbeiten</a> : null}
        <div className="mobile-app-version">App-Version: {appVersion}</div>
      </section>
    </main>
  );
}

function QueueDetailsPanel({
  queueDetails,
  joinedSessionId,
  diagnosisMessage,
  copySyncDiagnostics,
  runBundleDiagnosticSync,
  discardConfirm,
  setDiscardConfirm,
  discardOpenQueue,
}: {
  queueDetails: QueueDetails;
  joinedSessionId?: string;
  diagnosisMessage: string;
  copySyncDiagnostics: () => void;
  runBundleDiagnosticSync: () => void;
  discardConfirm: string;
  setDiscardConfirm: (value: string) => void;
  discardOpenQueue: () => void;
}) {
  return (
    <div className="queue-detail-list">
      <div className="queue-diagnostics-actions">
        <button className="btn secondary" type="button" onClick={copySyncDiagnostics}>Diagnose kopieren</button>
        <button className="btn secondary" type="button" onClick={runBundleDiagnosticSync}>Foto-Sync erneut testen</button>
        {diagnosisMessage ? <small>{diagnosisMessage}</small> : null}
      </div>
      {queueDetails.sessions.map((session) => (
        <div className="queue-session-card" key={session.session_id}>
          <strong>{session.session_id === joinedSessionId ? "Aktuelle Session" : "Andere Session"}</strong>
          <span>Session: {session.session_id.slice(0, 8)}</span>
          <span>{session.objects} Objekte · {session.photos} Fotos · {session.failed} fehlgeschlagen · {session.conflict} zu prüfen</span>
        </div>
      ))}
      {queueDetails.openItems.slice(0, 12).map((item) => (
        <div className="queue-entry-row" key={item.id}>
          <span>{queueTypeLabels[item.type]} {item.photo_type ? `· ${photoLabels[item.photo_type as PhotoType] ?? item.photo_type}` : ""}</span>
          <small>{queueStatusLabels[item.status]} · Session {item.session_id.slice(0, 8)} · {new Date(item.updated_at).toLocaleString("de-DE")}</small>
          {item.type === "photo_upload" ? (
            <>
              <small>
                lokale Nr.: {item.sequence_number ?? "offen"} · Objekt-Zuordnung: {item.client_item_id ? "lokale ID vorhanden" : "lokale ID fehlt"} · Zielobjekt: {item.server_item_id ? item.server_item_id.slice(0, 8) : "noch nicht zugeordnet"}
              </small>
              <small>
                Blob: {item.photo_blob ? "vorhanden" : "fehlt"} · Größe: {item.photo_blob?.size ?? item.file_size ?? 0} Byte · Typ: {item.photo_blob?.type || item.file_type || "unbekannt"}
              </small>
              <small>
                Upload gestartet: {item.upload_started_at ? new Date(item.upload_started_at).toLocaleString("de-DE") : "nein"} · HTTP: {item.upload_response_status ?? "offen"}
              </small>
              <small>
                URL: {item.upload_url ?? "noch nicht gestartet"} · Status: {item.upload_debug_state ?? "offen"}
              </small>
              <small>
                Uploadfähig: {item.eligible_for_upload === undefined ? "offen" : item.eligible_for_upload ? "ja" : "nein"} · Health: {item.health_checked ? item.health_result ?? "geprüft" : "nicht geprüft"} · Fetch: {item.fetch_started ? "gestartet" : "nein"}
              </small>
              {item.sync_run_id ? <small>Sync: {item.sync_run_id} · geprüft: {item.sync_checked_at ? new Date(item.sync_checked_at).toLocaleString("de-DE") : "offen"}</small> : null}
              {item.skip_reason ? <small>Grund: {item.skip_reason}</small> : null}
              {item.upload_debug ? <small>{item.upload_debug}</small> : null}
              {item.upload_response_text ? <small>{item.upload_response_text}</small> : null}
            </>
          ) : null}
          {item.last_error ? <small>{item.last_error}</small> : null}
        </div>
      ))}
      <div className="queue-discard-box">
        <strong>Lokale Daten verwerfen</strong>
        <span>Diese lokalen Daten wurden noch nicht vollständig übertragen. Nur verwenden, wenn es Testdaten sind oder die alte Session gelöscht wurde.</span>
        <input value={discardConfirm} onChange={(event) => setDiscardConfirm(event.target.value)} placeholder="VERWERFEN eingeben" />
        <button className="btn danger" type="button" disabled={discardConfirm !== "VERWERFEN"} onClick={discardOpenQueue}>
          Lokale Daten endgültig verwerfen
        </button>
      </div>
    </div>
  );
}

function WizardCard({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="wizard-card">
      <div>
        <h1>{title}</h1>
        <p>{hint}</p>
      </div>
      {children}
    </section>
  );
}

function PhotoPreviewList({ photos, labels }: { photos: Array<{ type: PhotoType; previewUrl?: string; name: string }>; labels: Record<PhotoType, string> }) {
  return (
    <div className="mobile-photo-previews">
      {photos.map((photo, index) => (
        <div key={`${photo.type}-${photo.name}-${index}`}>
          {photo.previewUrl ? <img src={photo.previewUrl} alt={labels[photo.type]} /> : null}
          <span>{labels[photo.type]}</span>
        </div>
      ))}
    </div>
  );
}
