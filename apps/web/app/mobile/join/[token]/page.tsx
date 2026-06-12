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
  enqueueAudioUpload,
  initQueue,
  listQueueItems,
  nextLocalSequenceNumber,
  queueSchemaVersion,
} from "@/lib/offlineQueue";
import { getOnlineStatus, retryFailed, syncNow } from "@/lib/syncClient";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { PushToTalk } from "@/components/PushToTalk";
import { BgaDictationFields, parseDictation, toBgaFields } from "@/lib/dictation";
import { loadMobileSessionCapsule, saveMobileSessionCapsule } from "@/lib/sessionCapsule";

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
  bootstrap?: Bootstrap | null;
};

type LocalItem = {
  id: string;
  inventory_id: string;
  temporary_id: string;
  server_item_id?: string;
  sequence_number?: number;
};

type PhotoType = "object_front" | "object_back" | "type_plate" | "uvv_label" | "condition_detail" | "other";
type CapturedPhoto = { type: PhotoType; id?: string; queueId?: string; name: string; size: number; previewUrl?: string };
type AiProgressState = { active: boolean; label: string; progress: number };
type FunctionOk = "ja" | "nein" | "nicht_geprueft";
type UvvStatus = "vorhanden" | "nicht_vorhanden" | "nicht_uvv_pflichtig" | "unklar";
type InspectionBook = "ja" | "nein" | "nicht_erforderlich" | "unklar";
type SpeechField = Extract<keyof BgaForm, "object_type" | "specification" | "serial_number" | "construction_year" | "condition_note" | "uvv_valid_until" | "remark">;
type BrowserSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: any) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};
type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

const steps = [
  "Fotos & Nachweise",
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

function photoInputId(type: PhotoType) {
  return `mobile-photo-input-${type}`;
}

function revokePhotoPreviews(photos: CapturedPhoto[]) {
  photos.forEach((photo) => {
    if (photo.previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(photo.previewUrl);
    }
  });
}

function defaultObjectClassId(boot?: Bootstrap | null) {
  return boot?.object_classes.find((entry) => entry.slug === "bga")?.id ?? boot?.object_classes[0]?.id ?? "";
}

type BgaForm = {
  object_type: string;
  specification: string;
  serial_number: string;
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
    serial_number?: string | null;
    construction_year?: string | null;
    remark?: string | null;
  } | null;
  nameplate_extraction?: NameplateExtraction | null;
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

type AiStatusResponse = {
  item_id: string;
  scope: "fast" | "review" | "deep_dive";
  state: "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
  message?: string;
  result_preview?: ServerItemSuggestion | null;
  updated_fields?: string[];
  can_cancel?: boolean;
  started_at?: string | null;
  completed_at?: string | null;
  item_status?: string | null;
};

const emptyForm: BgaForm = {
  object_type: "",
  specification: "",
  serial_number: "",
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

const appendSpeechFields = new Set<SpeechField>(["specification", "condition_note", "remark"]);

const emptySummary: QueueSummary = {
  total: 0,
  pending: 0,
  uploading: 0,
  unknownAck: 0,
  synced: 0,
  failed: 0,
  conflict: 0,
  repairing: 0,
  discardPending: 0,
  discarded: 0,
  open: 0,
  pendingPhotos: 0,
  failedPhotos: 0,
};

const queueTypeLabels = {
  item_draft: "Objekt",
  photo_upload: "Foto",
  audio_upload: "Diktat",
};

const queueStatusLabels = {
  pending: "wartet",
  uploading: "Übertragung läuft",
  unknown_ack: "Quittung wird geprüft",
  repairing: "wird repariert",
  synced: "synchronisiert",
  failed: "Upload fehlgeschlagen",
  conflict: "Zuordnung prüfen",
  discard_pending: "wird bereinigt",
  discarded: "entfernt",
};

const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || "unbekannt";

function registerMobileServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") {
    navigator.serviceWorker.getRegistrations?.()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => undefined);
    return;
  }
  if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") return;
  navigator.serviceWorker.register("/sw.js")
    .then((registration) => {
      void registration.update();
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    })
    .catch(() => undefined);
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

async function readStorageHealth() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { available: false, freeMb: null as number | null, low: false, critical: false };
  }
  const estimate = await navigator.storage.estimate();
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  if (!quota) return { available: false, freeMb: null as number | null, low: false, critical: false };
  const freeMb = Math.max(0, Math.round((quota - usage) / 1024 / 1024));
  const usedPercent = usage / quota;
  return {
    available: true,
    freeMb,
    low: freeMb < 250 || usedPercent > 0.85,
    critical: freeMb < 100,
  };
}

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
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [savedItem, setSavedItem] = useState<{ label: string } | null>(null);
  const [editedFields, setEditedFields] = useState<Partial<Record<keyof BgaForm, boolean>>>({});
  const [message, setMessage] = useState("Bereit");
  const [busy, setBusy] = useState(false);
  const [dictationAudio, setDictationAudio] = useState<{ blob: Blob; mime: string } | null>(null);
  const [dictationChips, setDictationChips] = useState<BgaDictationFields | null>(null);
  const [serialScannerOpen, setSerialScannerOpen] = useState(false);
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
  const [aiProgress, setAiProgress] = useState<AiProgressState>({ active: false, label: "", progress: 0 });
  const [, setDismissedAiKey] = useState("");
  const [dismissedValueKey, setDismissedValueKey] = useState("");
  const [abortConfirm, setAbortConfirm] = useState(false);
  const [diagnosisMessage, setDiagnosisMessage] = useState("");
  const [diagnosisText, setDiagnosisText] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [storageCritical, setStorageCritical] = useState(false);
  const [compactPhotoMode, setCompactPhotoMode] = useState(false);
  const [designationPromptOpen, setDesignationPromptOpen] = useState(false);
  const [listeningField, setListeningField] = useState<SpeechField | "">("");
  const [speechMessage, setSpeechMessage] = useState("");
  const [showAdvancedFlow, setShowAdvancedFlow] = useState(false);

  const fileInputRefs: Record<PhotoType, RefObject<HTMLInputElement | null>> = {
    object_front: useRef<HTMLInputElement>(null),
    object_back: useRef<HTMLInputElement>(null),
    type_plate: useRef<HTMLInputElement>(null),
    uvv_label: useRef<HTMLInputElement>(null),
    condition_detail: useRef<HTMLInputElement>(null),
    other: useRef<HTMLInputElement>(null),
  };
  const captureStartRef = useRef<HTMLDivElement>(null);
  const activeStepRef = useRef<HTMLDivElement>(null);
  const uvvStatusRef = useRef<HTMLLabelElement>(null);
  const uvvDateRef = useRef<HTMLLabelElement>(null);
  const remarkFieldRef = useRef<HTMLLabelElement>(null);
  const summaryStepRef = useRef<HTMLElement>(null);
  const lastStepRef = useRef(step);
  const aiAutoRequestKeyRef = useRef("");
  const aiProgressRunRef = useRef("");
  const activeItemRef = useRef<LocalItem | null>(null);
  const dismissedAiKeyRef = useRef("");
  const lastAutoSyncRef = useRef(0);
  const savedResetTimerRef = useRef<number | null>(null);
  const joinedRef = useRef<Joined | null>(null);
  const lastJoinRefreshRef = useRef(0);
  const designationInputRef = useRef<HTMLInputElement | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const speechBaseValueRef = useRef("");
  const speechTranscriptRef = useRef("");
  const speechAutoAdvanceRef = useRef(false);

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

  useEffect(() => {
    registerMobileServiceWorker();
  }, []);

  useEffect(() => () => {
    if (savedResetTimerRef.current) {
      window.clearTimeout(savedResetTimerRef.current);
    }
    speechRecognitionRef.current?.abort?.();
    speechRecognitionRef.current = null;
  }, []);

  useEffect(() => {
    joinedRef.current = joined;
  }, [joined]);

  useEffect(() => {
    activeItemRef.current = activeItem;
  }, [activeItem]);

  useEffect(() => {
    async function checkStorage() {
      const health = await readStorageHealth();
      setStorageCritical(health.critical);
      setCompactPhotoMode(health.low);
      if (health.critical) {
        setStorageWarning(`Lokaler Speicher fast voll: ca. ${health.freeMb} MB frei. Bitte synchronisieren, bevor du weitere Fotos aufnimmst.`);
      } else if (health.low) {
        setStorageWarning(`Wenig lokaler Speicher frei: ca. ${health.freeMb} MB. Neue Fotos werden kleiner gespeichert.`);
      } else {
        setStorageWarning("");
      }
    }
    checkStorage().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!joined || !navigator.storage?.persist) return;
    navigator.storage.persist().catch(() => undefined);
  }, [joined]);

  const refreshQueueSummary = useCallback(async () => {
    try {
      const summary = await getQueueSummary(joined?.session.id);
      setQueueSummary(summary);
    } catch {
      setSyncMessage("Lokale Sync-Liste konnte nicht gelesen werden.");
    }
  }, [joined?.session.id]);

  const refreshQueueDetails = useCallback(async () => {
    try {
      setQueueDetails(await getQueueDetails(joined?.session.id));
    } catch {
      setSyncMessage("Lokale Sync-Details konnten nicht gelesen werden.");
    }
  }, [joined?.session.id]);

  const toggleQueueDetails = useCallback(() => {
    setShowQueueDetails((value) => {
      const next = !value;
      if (next && !queueDetails) void refreshQueueDetails();
      return next;
    });
  }, [queueDetails, refreshQueueDetails]);

  useEffect(() => {
    getOrCreateDeviceId()
      .then(setDeviceId)
      .catch(() => setDeviceId(`device-${Date.now()}-${Math.random().toString(16).slice(2)}`));
    initQueue()
      .catch((error) => {
        setSyncMessage(error instanceof Error ? error.message : "Lokale Speicherung ist auf diesem Gerät nicht verfügbar.");
      });
  }, []);

  useEffect(() => {
    if (!joined?.session.id) return;
    refreshQueueSummary();
  }, [joined?.session.id, refreshQueueSummary]);

  useEffect(() => {
    if (!joined || bootstrap?.object_classes.length) return;
    api<Bootstrap>("/meta/bootstrap").then((boot) => {
      const nextObjectClassId = defaultObjectClassId(boot);
      setBootstrap(boot);
      setObjectClassId(nextObjectClassId);
      if (token) {
        saveMobileSessionCapsule({ token, joined, bootstrap: boot, objectClassId: nextObjectClassId, accessToken: joined.access_token });
      }
    }).catch((err) => {
      const capsule = loadMobileSessionCapsule(token);
      if (capsule?.bootstrap) {
        setBootstrap(capsule.bootstrap);
        setObjectClassId(capsule.objectClassId ?? defaultObjectClassId(capsule.bootstrap));
        setMessage("Offline-Modus: Stammdaten aus lokaler Session geladen.");
        return;
      }
      setMessage(err instanceof Error ? err.message : "Stammdaten nicht erreichbar");
    });
  }, [bootstrap?.object_classes.length, joined, objectClassId, token]);

  useEffect(() => {
    if (!token || !deviceId) return;
    setJoinError("");
    const capsule = loadMobileSessionCapsule(token);
    if (capsule?.bootstrap) {
      setBootstrap(capsule.bootstrap);
      setObjectClassId(capsule.objectClassId ?? defaultObjectClassId(capsule.bootstrap));
    }
    api<Joined>("/sessions/join", {
      method: "POST",
      body: JSON.stringify({ token, device_name: "Handy-Erfassung BGA", device_fingerprint: deviceId }),
    }).then((result) => {
      if (result.access_token) setAuthToken(result.access_token);
      const nextBootstrap = result.bootstrap ?? capsule?.bootstrap ?? null;
      const nextObjectClassId = defaultObjectClassId(nextBootstrap) || capsule?.objectClassId || "";
      if (nextBootstrap) setBootstrap(nextBootstrap);
      if (nextObjectClassId) setObjectClassId(nextObjectClassId);
      setJoined(result);
      saveMobileSessionCapsule({ token, joined: result, bootstrap: nextBootstrap ?? bootstrap, objectClassId: nextObjectClassId || objectClassId, accessToken: result.access_token });
    }).catch((err) => {
      if (capsule) {
        if (capsule.accessToken) setAuthToken(capsule.accessToken);
        setJoined(capsule.joined);
        if (capsule.bootstrap) setBootstrap(capsule.bootstrap);
        if (capsule.objectClassId) setObjectClassId(capsule.objectClassId);
        setIsOnline(false);
        setJoinError("");
        setMessage("Offline-Modus: Session lokal geladen. Erfassung bleibt möglich.");
        return;
      }
      setJoinError(err instanceof Error ? err.message : "Join fehlgeschlagen");
      setMessage("Session nicht verfügbar");
    });
  }, [token, deviceId]);

  const refreshMobileSession = useCallback(async (force = false) => {
    if (!token || !deviceId) return joinedRef.current;
    const now = Date.now();
    if (!force && joinedRef.current && now - lastJoinRefreshRef.current < 5 * 60_000) {
      return joinedRef.current;
    }
    const result = await api<Joined>("/sessions/join", {
      method: "POST",
      body: JSON.stringify({ token, device_name: "Handy-Erfassung BGA", device_fingerprint: deviceId }),
    });
    if (result.access_token) setAuthToken(result.access_token);
    const nextBootstrap = result.bootstrap ?? bootstrap;
    const nextObjectClassId = defaultObjectClassId(nextBootstrap) || objectClassId;
    if (result.bootstrap) {
      setBootstrap(result.bootstrap);
      setObjectClassId(nextObjectClassId);
    }
    joinedRef.current = result;
    lastJoinRefreshRef.current = now;
    setJoined(result);
    saveMobileSessionCapsule({ token, joined: result, bootstrap: nextBootstrap, objectClassId: nextObjectClassId, accessToken: result.access_token });
    return result;
  }, [bootstrap, deviceId, objectClassId, token]);

  const roomName = useMemo(() => {
    const room = bootstrap?.rooms.find((entry) => entry.id === joined?.session.room_id);
    return room?.name ?? "Raum";
  }, [bootstrap, joined]);
  const inventoryType = joined?.session.inventory_type || "bga";
  const isBgaSession = inventoryType === "bga";

  const runSync = useCallback(async (label = "Synchronisierung läuft", options: { wake?: boolean } = {}) => {
    setSyncMessage(label);
    try {
      const activeSession = await refreshMobileSession();
      const activeSessionId = activeSession?.session.id ?? joinedRef.current?.session.id;
      await syncNow({ sessionId: activeSessionId, manual: options.wake });
      const summary = await getQueueSummary(activeSessionId);
      setSyncMessage(summary.open ? "Lokal gesichert. Synchronisierung wird weiter versucht." : "Alles übertragen.");
      setIsOnline(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setIsOnline(getOnlineStatus());
      setSyncMessage(message.includes("QR neu koppeln")
        ? "QR neu koppeln."
        : message.includes("API nicht erreichbar")
          ? "Keine Verbindung. Daten bleiben lokal gesichert."
          : "Übertragung wird repariert.");
    } finally {
      await refreshQueueSummary();
    }
  }, [refreshMobileSession, refreshQueueSummary]);

  const buildSyncDiagnosis = useCallback(async () => {
    const [summary, allSummary, details, items, currentDeviceId] = await Promise.all([
      getQueueSummary(joined?.session.id),
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
        pendingItems: itemDrafts.filter((item) => item.session_id === joined?.session.id && (item.status === "pending" || item.status === "uploading")).length,
        pendingPhotos: photoUploads.filter((item) => item.session_id === joined?.session.id && (item.status === "pending" || item.status === "uploading")).length,
        failedItems: itemDrafts.filter((item) => item.session_id === joined?.session.id && item.status === "failed").length,
        failedPhotos: photoUploads.filter((item) => item.session_id === joined?.session.id && item.status === "failed").length,
        conflict: summary.conflict,
        unknown_ack: summary.unknownAck,
        repairing: summary.repairing,
        discard_pending: summary.discardPending,
        discarded: summary.discarded,
        synced: summary.synced,
        total: summary.total,
        lastError: summary.lastError ?? null,
      },
      all_queue_summary: {
        open: allSummary.open,
        pendingItems,
        pendingPhotos,
        failedItems,
        failedPhotos,
        conflict: allSummary.conflict,
        unknown_ack: allSummary.unknownAck,
        repairing: allSummary.repairing,
        discard_pending: allSummary.discardPending,
        discarded: allSummary.discarded,
        synced: allSummary.synced,
        total: allSummary.total,
        lastError: allSummary.lastError ?? null,
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
      const text = JSON.stringify(diagnosis, null, 2);
      setDiagnosisText(text);
      await copyToClipboard(text);
      setDiagnosisMessage("Diagnose kopiert. Du kannst sie jetzt einfügen und senden.");
    } catch (error) {
      setDiagnosisMessage(error instanceof Error ? `Diagnose konnte nicht kopiert werden. Die Diagnose wird unten angezeigt: ${error.message}` : "Diagnose konnte nicht kopiert werden. Die Diagnose wird unten angezeigt.");
    }
  }, [buildSyncDiagnosis]);

  const showSyncDiagnostics = useCallback(async () => {
    const diagnosis = await buildSyncDiagnosis();
    setDiagnosisText(JSON.stringify(diagnosis, null, 2));
    setDiagnosisMessage("Diagnose unten eingeblendet. Text bei Bedarf markieren und senden.");
  }, [buildSyncDiagnosis]);

  const sendSyncDiagnostics = useCallback(async () => {
    try {
      const diagnosis = await buildSyncDiagnosis();
      const text = JSON.stringify(diagnosis, null, 2);
      setDiagnosisText(text);
      const result = await api<{ id: string }>("/mobile-diagnostics", {
        method: "POST",
        body: JSON.stringify(diagnosis),
      });
      setDiagnosisMessage(`Diagnose an Server gesendet: ${result.id}`);
    } catch (error) {
      setDiagnosisMessage(error instanceof Error ? `Diagnose konnte nicht gesendet werden: ${error.message}` : "Diagnose konnte nicht gesendet werden.");
    }
  }, [buildSyncDiagnosis]);

  const runBundleDiagnosticSync = useCallback(async () => {
    setDiagnosisMessage("Foto-Sync wird erneut getestet.");
    await runSync("Foto-Sync wird erneut getestet.", { wake: true });
    setDiagnosisMessage("Foto-Sync-Test abgeschlossen. Details wurden aktualisiert.");
  }, [runSync]);

  useEffect(() => {
    setIsOnline(getOnlineStatus());
    const handleOnline = () => {
      if (document.visibilityState === "hidden" || !getOnlineStatus()) return;
      setIsOnline(true);
      void runSync("Verbindung wieder da. Synchronisierung läuft.", { wake: true });
    };
    const handleOffline = () => {
      setIsOnline(false);
      setSyncMessage("Offline – Daten werden lokal gespeichert.");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("focus", handleOnline);
    window.addEventListener("pageshow", handleOnline);
    document.addEventListener("visibilitychange", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("focus", handleOnline);
      window.removeEventListener("pageshow", handleOnline);
      document.removeEventListener("visibilitychange", handleOnline);
    };
  }, [runSync]);

  useEffect(() => {
    if (!joined || !isBgaSession) return;
    const interval = window.setInterval(async () => {
      const summary = await getQueueSummary(joined.session.id);
      await refreshQueueSummary();
      if (!summary.open) return;
      const now = Date.now();
      if (now - lastAutoSyncRef.current < 30_000) return;
      lastAutoSyncRef.current = now;
      void runSync("Offene lokale Daten werden erneut synchronisiert.");
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [joined, isBgaSession, refreshQueueSummary, runSync]);

  useEffect(() => {
    if (!joined || !isBgaSession) return;
    const timeout = window.setTimeout(async () => {
      const summary = await getQueueSummary(joined.session.id);
      setQueueSummary(summary);
      if (!summary.open) return;
      void runSync("Offene lokale Einträge werden synchronisiert.");
    }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [joined, isBgaSession, runSync]);

  const hasManualInput = Boolean(
    form.object_type.trim() ||
    form.specification.trim() ||
    form.serial_number.trim() ||
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
      serial_number: form.serial_number || null,
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
    setAbortConfirm(false);
    const input = fileInputRefs[type].current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  function focusFlowTarget(target: HTMLElement | null | undefined, behavior: ScrollBehavior = "smooth") {
    window.requestAnimationFrame(() => {
      if (!target) {
        window.scrollTo({ top: 0, behavior });
        return;
      }
      target.scrollIntoView({ behavior, block: "start" });
      target.focus?.({ preventScroll: true });
    });
  }

  function focusCaptureStart(behavior: ScrollBehavior = "smooth") {
    focusFlowTarget(captureStartRef.current ?? activeStepRef.current, behavior);
  }

  function focusAfterRender(getTarget: () => HTMLElement | null | undefined, behavior: ScrollBehavior = "smooth") {
    window.setTimeout(() => focusFlowTarget(getTarget(), behavior), 80);
  }

  async function compressPhoto(file: File, photoType: PhotoType, forceCompact = false) {
    if (!file.type.startsWith("image/")) return file;
    const maxSide = forceCompact ? Math.min(photoMaxSide[photoType], 1600) : photoMaxSide[photoType];
    const quality = forceCompact
      ? (photoType === "type_plate" || photoType === "uvv_label" || photoType === "condition_detail" ? 0.78 : 0.72)
      : (photoType === "type_plate" || photoType === "uvv_label" || photoType === "condition_detail" ? 0.9 : 0.86);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }
    const scale = Math.min(maxSide / Math.max(bitmap.width, bitmap.height), 1);
    if (!forceCompact && scale >= 1 && file.size <= 1_200_000) {
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
      const storage = await readStorageHealth();
      setStorageCritical(storage.critical);
      setCompactPhotoMode(storage.low);
      if (storage.critical) {
        setStorageWarning(`Lokaler Speicher fast voll: ca. ${storage.freeMb} MB frei. Bitte zuerst synchronisieren.`);
        throw new Error(`Lokaler Speicher fast voll: ca. ${storage.freeMb} MB frei. Bitte zuerst synchronisieren.`);
      }
      if (storage.low) {
        setStorageWarning(`Wenig lokaler Speicher frei: ca. ${storage.freeMb} MB. Dieses Foto wird kleiner gespeichert.`);
      }
      setUploadState("Foto wird verkleinert");
      const item = await ensureItem();
      const prepared = await compressPhoto(file, type, storage.low || compactPhotoMode);
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
      const nextPhoto = { type, id: queuedPhoto.client_photo_id, queueId: queuedPhoto.id, name: prepared.name, size: prepared.size, previewUrl: URL.createObjectURL(prepared) };
      const nextPhotos = [...photos, nextPhoto];
      setPhotos((current) => [...current, nextPhoto]);
      setMessage(`${photoLabels[type]} lokal gespeichert. ${getOnlineStatus() ? "Synchronisierung läuft." : "Foto wird später übertragen."}`);
      await refreshQueueSummary();
      const shouldStartAi = type === "object_front" || type === "type_plate" || nextPhotos.length >= 2;
      if (shouldStartAi) {
        const requestKey = aiRequestKey(item, nextPhotos);
        setDismissedAiKey("");
        dismissedAiKeyRef.current = "";
        setDismissedValueKey("");
        aiAutoRequestKeyRef.current = requestKey;
        setAiProgress({ active: true, label: "KI startet", progress: 8 });
        setAiSuggestionMessage("KI startet.");
        void loadAiSuggestion({ silent: true, itemOverride: item, photosOverride: nextPhotos, requestKey });
      } else {
        void runSync("Foto wird synchronisiert.");
      }
      if (nextPhotos.length >= 2 || type === "type_plate") {
        setStep(1);
        focusAfterRender(() => designationInputRef.current ?? activeStepRef.current);
      } else {
        focusAfterRender(() => captureStartRef.current ?? activeStepRef.current);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Foto ist lokal nicht gespeichert worden.");
    } finally {
      setBusy(false);
      setUploadState("");
      setUploadProgress(0);
    }
  }

  async function removeCapturedPhoto(photo: CapturedPhoto, index: number) {
    if (busy) return;
    const remainingPhotos = photos.filter((_, photoIndex) => photoIndex !== index);
    if (photo.previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(photo.previewUrl);
    }
    setSavedItem(null);
    setAbortConfirm(false);
    setPhotos(remainingPhotos);
    const hasAiPhoto = remainingPhotos.some((entry) => entry.type === "object_front" || entry.type === "type_plate");
    if (!hasAiPhoto) {
      setAiSuggestion(null);
      setAiSuggestionMessage("");
      setAiProgress({ active: false, label: "", progress: 0 });
      aiAutoRequestKeyRef.current = "";
    } else if (activeItem) {
      aiAutoRequestKeyRef.current = aiRequestKey(activeItem, remainingPhotos);
    }
    try {
      let queueId = photo.queueId;
      if (!queueId && photo.id) {
        const queued = (await listQueueItems()).find((item) => item.type === "photo_upload" && item.client_photo_id === photo.id);
        queueId = queued?.id;
      }
      if (queueId) {
        await discardQueueItems([queueId]);
        await refreshQueueSummary();
      }
      setMessage(`${photoLabels[photo.type]} geloescht.`);
    } catch {
      setMessage(`${photoLabels[photo.type]} aus der Ansicht entfernt. Lokale Queue bitte pruefen.`);
    }
  }

  async function saveObject() {
    if (!canSaveDraft || busy) {
      setMessage("Noch keine Eingabe vorhanden. Bitte Foto aufnehmen oder eine Angabe erfassen.");
      return;
    }
    if (!form.object_type.trim()) {
      setDesignationPromptOpen(true);
      setStep(1);
      setMessage("Bezeichnung fehlt. Bitte kurz eingeben oder einsprechen, dann speichern.");
      window.setTimeout(() => designationInputRef.current?.focus(), 80);
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
      if (dictationAudio) {
        await enqueueAudioUpload({
          session_id: joined?.session.id ?? "",
          device_id: deviceId,
          client_item_id: item.id,
          audio_blob: dictationAudio.blob,
          file_type: dictationAudio.mime,
        });
      }
      const savedLabel = form.object_type || item.inventory_id || item.temporary_id || "Entwurf";
      const savedPhotos = photos;
      setSavedItem({ label: savedLabel });
      setActiveItem(null);
      setForm(emptyForm);
      setDictationAudio(null);
      setDictationChips(null);
      setSerialScannerOpen(false);
      setEditedFields({});
      setAiSuggestion(null);
      setAiSuggestionMessage("");
      setDismissedAiKey("");
      dismissedAiKeyRef.current = "";
      setDismissedValueKey("");
      setAbortConfirm(false);
      setDesignationPromptOpen(false);
      setShowAdvancedFlow(false);
      stopSpeechInput();
      aiAutoRequestKeyRef.current = "";
      setStep(0);
      setMessage(
        isCompleteCapture
          ? `${savedLabel} lokal gespeichert. Bereit für nächstes Objekt.`
          : "Offline oder Pflichtangaben fehlen. Das Objekt wurde lokal als Entwurf gesichert. Bitte später ergänzen und synchronisieren.",
      );
      focusAfterRender(() => captureStartRef.current ?? activeStepRef.current);
      scheduleFreshCaptureAfterSaved(savedPhotos);
      void runSync("Objekt wird synchronisiert.", { wake: true });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Objekt konnte lokal nicht gespeichert werden");
    } finally {
      setBusy(false);
    }
  }

  async function retrySync() {
    setSyncMessage("Fehler werden erneut synchronisiert.");
    try {
      const activeSession = await refreshMobileSession(true);
      const activeSessionId = activeSession?.session.id ?? joinedRef.current?.session.id;
      await retryFailed({ sessionId: activeSessionId });
      const summary = await getQueueSummary(activeSessionId);
      setSyncMessage(summary.open ? `${summary.pendingPhotos} Fotos warten noch auf Synchronisierung.` : "Synchronisierung abgeschlossen.");
    } catch {
      setSyncMessage("Upload fehlgeschlagen. Bitte Verbindung prüfen und erneut synchronisieren.");
    } finally {
      await refreshQueueSummary();
    }
  }

  async function discardOpenQueue() {
    const discardTargets = queueDetails?.currentSessionItems.length
      ? queueDetails.currentSessionItems
      : queueDetails?.otherSessionItems ?? [];
    if (discardConfirm !== "VERWERFEN" || !discardTargets.length) return;
    await discardQueueItems(discardTargets.map((item) => item.id));
    setDiscardConfirm("");
    setShowQueueDetails(false);
    setSyncMessage("Lokale Daten wurden bewusst verworfen.");
    await refreshQueueSummary();
  }

  function update<K extends keyof BgaForm>(key: K, value: BgaForm[K]) {
    setSavedItem(null);
    setAbortConfirm(false);
    setEditedFields((current) => ({ ...current, [key]: true }));
    setForm((current) => ({ ...current, [key]: value }));
    if (key === "object_type" && String(value).trim()) {
      setDesignationPromptOpen(false);
    }
  }

  function composeSpeechValue(field: SpeechField, baseValue: string, transcript: string) {
    const cleanTranscript = transcript.replace(/\s+/g, " ").trim();
    if (!cleanTranscript) return baseValue;
    if (appendSpeechFields.has(field) && baseValue.trim()) {
      return `${baseValue.trimEnd()}\n${cleanTranscript}`;
    }
    return cleanTranscript;
  }

  function writeSpeechTranscript(field: SpeechField, transcript: string) {
    setSavedItem(null);
    setAbortConfirm(false);
    setEditedFields((current) => ({ ...current, [field]: true }));
    setForm((current) => ({
      ...current,
      [field]: composeSpeechValue(field, speechBaseValueRef.current, transcript),
    }));
  }

  function stopSpeechInput() {
    speechRecognitionRef.current?.stop();
    speechRecognitionRef.current = null;
    setListeningField("");
  }

  function startSpeechInput(field: SpeechField, label: string) {
    if (listeningField === field) {
      stopSpeechInput();
      return;
    }
    speechRecognitionRef.current?.abort?.();
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setSpeechMessage("Spracheingabe ist in diesem Browser nicht verfuegbar.");
      return;
    }
    const recognition = new Recognition();
    const baseValue = String(form[field] ?? "");
    speechBaseValueRef.current = baseValue;
    speechTranscriptRef.current = "";
    speechAutoAdvanceRef.current = false;
    recognition.lang = "de-DE";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event: any) => {
      let transcript = "";
      let finalResultSeen = false;
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += `${event.results[index]?.[0]?.transcript ?? ""} `;
        finalResultSeen = finalResultSeen || Boolean(event.results[index]?.isFinal);
      }
      speechTranscriptRef.current = transcript;
      writeSpeechTranscript(field, transcript);
      setSpeechMessage(finalResultSeen ? `${label}: Text uebernommen.` : `${label}: Ich schreibe mit.`);
      if (finalResultSeen && field === "object_type" && transcript.trim() && !speechAutoAdvanceRef.current) {
        speechAutoAdvanceRef.current = true;
        setDesignationPromptOpen(false);
        setStep(2);
        setMessage("Bezeichnung per Sprache erfasst. Weiter mit Zustand und Funktion.");
        focusAfterRender(() => activeStepRef.current);
      }
    };
    recognition.onerror = (event) => {
      setSpeechMessage(event.error === "not-allowed" ? "Mikrofon wurde nicht freigegeben." : "Spracheingabe wurde gestoppt.");
      setListeningField("");
      speechRecognitionRef.current = null;
    };
    recognition.onend = () => {
      setListeningField("");
      speechRecognitionRef.current = null;
      if (field === "object_type" && speechTranscriptRef.current.trim() && !speechAutoAdvanceRef.current) {
        speechAutoAdvanceRef.current = true;
        setDesignationPromptOpen(false);
        setStep(2);
        setMessage("Bezeichnung per Sprache erfasst. Weiter mit Zustand und Funktion.");
        focusAfterRender(() => activeStepRef.current);
      }
    };
    try {
      speechRecognitionRef.current = recognition;
      setListeningField(field);
      setSpeechMessage(`${label}: Spracheingabe laeuft.`);
      recognition.start();
    } catch {
      setListeningField("");
      speechRecognitionRef.current = null;
      setSpeechMessage("Spracheingabe konnte nicht gestartet werden.");
    }
  }

  function handleDictation(blob: Blob | null, mime: string, transcript: string) {
    setDictationAudio(blob ? { blob, mime } : null);
    if (!transcript.trim()) {
      if (blob) setMessage("Aufnahme gespeichert. Transkription folgt nach dem Sync (Worker).");
      return;
    }
    const fields = toBgaFields(parseDictation(transcript, bootstrap?.brands ?? []));
    setDictationChips(Object.keys(fields).length ? fields : null);
    // Nur leere Felder fuellen – Diktat ueberschreibt nie manuelle Eingaben.
    setForm((current) => ({
      ...current,
      object_type: current.object_type || fields.object_type || current.object_type,
      specification: current.specification || fields.specification || current.specification,
      serial_number: current.serial_number || fields.serial_number || current.serial_number,
      construction_year: current.construction_year || fields.construction_year || current.construction_year,
      condition: current.condition === "gebraucht" && fields.condition ? fields.condition : current.condition,
      remark: current.remark || fields.remark || current.remark,
    }));
  }

  function speechButton(field: SpeechField, label: string) {
    const active = listeningField === field;
    return (
      <button
        className={`speech-field-button ${active ? "is-listening" : ""}`}
        type="button"
        onClick={() => startSpeechInput(field, label)}
        aria-pressed={active}
      >
        {active ? "Stop" : "Sprechen"}
      </button>
    );
  }

  function decideTypePlate(status: BgaForm["type_plate_status"]) {
    update("type_plate_status", status);
    if (status === "vorhanden") return;
    setStep(1);
    setMessage(status === "nicht_vorhanden" ? "Kein Typenschild vorhanden. Weiter mit KI-Vorschlag." : "Typenschild nicht erkennbar. Weiter mit KI-Vorschlag.");
  }

  function decideFunctionOk(value: FunctionOk) {
    update("function_ok", value);
    if (value === "nein") {
      setMessage("Funktion nicht in Ordnung. Nacharbeit wird vorgemerkt, du kannst weiter erfassen.");
    } else if (value === "nicht_geprueft") {
      setMessage("Funktion nicht geprüft. Nacharbeit wird vorgemerkt, du kannst weiter erfassen.");
    } else {
      setMessage("Funktion erfasst. Weiter mit UVV oder Bemerkung.");
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
      focusAfterRender(() => uvvDateRef.current ?? remarkFieldRef.current);
    } else if (value === "nicht_vorhanden") {
      setMessage("UVV nicht vorhanden. Weiter mit Bemerkung.");
      focusAfterRender(() => remarkFieldRef.current);
    } else if (value === "nicht_uvv_pflichtig") {
      setMessage("Nicht UVV-pflichtig. Weiter mit Bemerkung.");
      focusAfterRender(() => remarkFieldRef.current);
    } else {
      setMessage("UVV offen gelassen. Weiter mit Bemerkung.");
      focusAfterRender(() => remarkFieldRef.current);
    }
  }

  function startNextObject() {
    if (savedResetTimerRef.current) {
      window.clearTimeout(savedResetTimerRef.current);
      savedResetTimerRef.current = null;
    }
    revokePhotoPreviews(photos);
    setSavedItem(null);
    setActiveItem(null);
    setForm(emptyForm);
    setEditedFields({});
    setPhotos([]);
    setAiSuggestion(null);
    setAiSuggestionMessage("");
    setAiProgress({ active: false, label: "", progress: 0 });
    setDismissedAiKey("");
    dismissedAiKeyRef.current = "";
    setDismissedValueKey("");
    setAbortConfirm(false);
    setDesignationPromptOpen(false);
    setShowAdvancedFlow(false);
    stopSpeechInput();
    aiAutoRequestKeyRef.current = "";
    setStep(0);
    setMessage("Bereit für nächstes Objekt");
    focusAfterRender(() => captureStartRef.current ?? activeStepRef.current, "auto");
  }

  const hasObjectPhoto = photos.some((photo) => photo.type === "object_front");
  const summaryBlockers = [
    !hasObjectPhoto ? "Objektfoto fehlt" : "",
    !form.object_type.trim() ? "Bezeichnung fehlt" : "",
  ].filter(Boolean);
  const summaryRework: string[] = [];
  const currentQueueItems = queueDetails?.currentSessionItems ?? [];
  const foreignQueueItems = queueDetails?.otherSessionItems ?? [];
  const openQueueItems = currentQueueItems;
  const openQueuePhotos = queueDetails ? openQueueItems.filter((item) => item.type === "photo_upload").length : queueSummary.pendingPhotos;
  const openQueueObjects = queueDetails ? openQueueItems.filter((item) => item.type === "item_draft").length : Math.max(0, queueSummary.open - openQueuePhotos);
  const hasOpenLocalQueue = Boolean(joined) && isBgaSession && queueSummary.open > 0;
  const openQueueIntro = openQueuePhotos
    ? `Es sind noch ${openQueuePhotos} Fotos auf diesem iPhone gespeichert, die noch nicht übertragen wurden.`
    : `Es sind noch ${openQueueObjects} Objekte auf diesem iPhone gespeichert, die noch nicht übertragen wurden.`;
  const otherSessionOpen = queueDetails ? foreignQueueItems.length : 0;
  const currentSessionOpen = queueDetails ? currentQueueItems.length : queueSummary.open;
  const hasQueueFailure = queueSummary.failed > 0;
  const hasQueueConflict = queueSummary.conflict > 0;
  const isRepairingSync = queueSummary.unknownAck > 0 || queueSummary.repairing > 0 || syncMessage.includes("repariert");
  const hasRecentlyDiscarded = queueSummary.discardPending > 0 || queueSummary.discarded > 0;
  const hasForeignQueue = otherSessionOpen > 0;
  const shouldPauseForQueue = Boolean(joined) && isBgaSession && hasQueueConflict;
  const isCurrentSessionPendingOnly = hasOpenLocalQueue && currentSessionOpen > 0 && !hasQueueFailure && !hasQueueConflict;
  const shouldShowForeignQueueNotice = Boolean(joined) && isBgaSession && hasForeignQueue && !shouldPauseForQueue;
  const syncText = isCurrentSessionPendingOnly && !isOnline
    ? "Offline-Erfassung aktiv"
    : !isOnline
    ? "Offline – Daten werden lokal gespeichert"
    : hasQueueConflict
      ? "QR neu koppeln"
    : isRepairingSync
      ? "Übertragung wird repariert"
    : hasQueueFailure
      ? "Übertragung wird repariert"
    : hasRecentlyDiscarded
      ? "Alte Daten entfernt"
      : queueSummary.open
        ? `Lokal gesichert – ${queueSummary.open} Einträge offen`
      : "Alles übertragen";
  const syncDetail = isCurrentSessionPendingOnly
    ? `${openQueueObjects} Objekte und ${openQueuePhotos} Fotos sind lokal auf diesem iPhone gesichert und werden später synchronisiert.`
    : hasQueueConflict
    ? "Diese Daten gehören vermutlich zu einer alten oder gelöschten Session. Bitte Details prüfen. Testdaten kannst du bewusst verwerfen."
    : hasQueueFailure
    ? "Der Sync versucht automatisch den roten Faden wiederzufinden. Du kannst manuell sofort erneut synchronisieren."
    : isRepairingSync
    ? "Server-Quittung wird geprüft, bevor erneut hochgeladen wird."
    : hasRecentlyDiscarded
    ? "Alte oder defekte lokale Reste wurden isoliert und blockieren diese Session nicht."
    : queueSummary.pendingPhotos
      ? `${queueSummary.pendingPhotos} Fotos offen. Lokal gesichert, bis der Server den Upload bestätigt.`
      : syncMessage || "Lokale Queue ist leer.";
  const canCaptureInThisSession = Boolean(joined) && isBgaSession && !shouldPauseForQueue && !storageCritical;
  const mobilePrimaryLabel = !hasObjectPhoto
    ? "Foto aufnehmen"
    : step === 0
      ? "Bezeichnung pruefen"
      : step === 1
        ? form.object_type.trim()
          ? "Weiter"
          : "Bezeichnung pruefen"
        : step === 2
          ? "Weiter"
          : summaryBlockers.length
            ? "Entwurf speichern"
            : "Speichern";
  const mobilePrimaryDisabled = busy || (step === 3 && !canSaveDraft);
  const shouldShowSyncActions = !isOnline
    || queueSummary.open > 0
    || hasQueueFailure
    || hasQueueConflict
    || (Boolean(syncMessage) && !["Synchronisierung abgeschlossen.", "Alles übertragen.", "Alles übertragen"].includes(syncMessage));

  useEffect(() => {
    if ((shouldPauseForQueue || showQueueDetails) && !queueDetails) {
      void refreshQueueDetails();
    }
  }, [queueDetails, refreshQueueDetails, shouldPauseForQueue, showQueueDetails]);

  useEffect(() => {
    if (!canCaptureInThisSession || savedItem) return;
    if (lastStepRef.current === step) return;
    lastStepRef.current = step;
    window.requestAnimationFrame(() => {
      activeStepRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [canCaptureInThisSession, savedItem, step]);

  function runMobilePrimaryAction() {
    if (mobilePrimaryDisabled) return;
    if (!hasObjectPhoto) {
      fileInputRefs.object_front.current?.click();
      return;
    }
    if (step === 0) {
      setStep(1);
      focusAfterRender(() => designationInputRef.current ?? activeStepRef.current);
      return;
    }
    if (step === 1) {
      if (!form.object_type.trim()) {
        setDesignationPromptOpen(true);
        setMessage("Bezeichnung fehlt. Kurz eintippen oder einsprechen.");
        focusAfterRender(() => designationInputRef.current ?? activeStepRef.current);
        return;
      }
      setStep(2);
      focusAfterRender(() => activeStepRef.current);
      return;
    }
    if (step === 2) {
      setStep(3);
      focusAfterRender(() => summaryStepRef.current ?? activeStepRef.current);
      return;
    }
    void saveObject();
  }

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

  function aiRequestKey(item: LocalItem | null = activeItem, photoList: CapturedPhoto[] = photos) {
    const relevantPhotoIds = photoList
      .filter((photo) => photo.type !== "uvv_label")
      .map((photo) => photo.id || photo.name)
      .join("|");
    return item ? `${item.id}:${relevantPhotoIds}` : "";
  }

  function resetCurrentCapture(nextMessage: string) {
    if (savedResetTimerRef.current) {
      window.clearTimeout(savedResetTimerRef.current);
      savedResetTimerRef.current = null;
    }
    revokePhotoPreviews(photos);
    setSavedItem(null);
    setActiveItem(null);
    setForm(emptyForm);
    setEditedFields({});
    setPhotos([]);
    setAiSuggestion(null);
    setAiSuggestionMessage("");
    setAiProgress({ active: false, label: "", progress: 0 });
    setDismissedAiKey("");
    dismissedAiKeyRef.current = "";
    setDismissedValueKey("");
    setAbortConfirm(false);
    setDesignationPromptOpen(false);
    setShowAdvancedFlow(false);
    stopSpeechInput();
    aiAutoRequestKeyRef.current = "";
    setStep(0);
    setMessage(nextMessage);
    focusAfterRender(() => captureStartRef.current ?? activeStepRef.current, "auto");
  }

  function scheduleFreshCaptureAfterSaved(savedPhotos: CapturedPhoto[]) {
    if (savedResetTimerRef.current) {
      window.clearTimeout(savedResetTimerRef.current);
    }
    savedResetTimerRef.current = window.setTimeout(() => {
      revokePhotoPreviews(savedPhotos);
      setSavedItem(null);
      setActiveItem(null);
      setForm(emptyForm);
      setEditedFields({});
      setPhotos([]);
      setAiSuggestion(null);
      setAiSuggestionMessage("");
      setAiProgress({ active: false, label: "", progress: 0 });
      setDismissedAiKey("");
      dismissedAiKeyRef.current = "";
      setDismissedValueKey("");
      setAbortConfirm(false);
      setDesignationPromptOpen(false);
      setShowAdvancedFlow(false);
      stopSpeechInput();
      aiAutoRequestKeyRef.current = "";
      setStep(0);
      setMessage("Bereit fuer naechstes Objekt");
      savedResetTimerRef.current = null;
      focusAfterRender(() => captureStartRef.current ?? activeStepRef.current, "auto");
    }, 700);
  }

  function discardAiSuggestion() {
    const key = aiRequestKey();
    if (key) {
      setDismissedAiKey(key);
      dismissedAiKeyRef.current = key;
    }
    setAiSuggestion(null);
    setAiSuggestionMessage("KI-Vorschlag verworfen. Fotos und manuelle Eingaben bleiben erhalten.");
  }

  function discardValueSuggestion() {
    const key = aiRequestKey();
    if (key) setDismissedValueKey(key);
    setAiSuggestionMessage("Wertvorschlag verworfen. Der Gebrauchtwert bleibt fuer dieses Objekt offen.");
  }

  async function abortCurrentObject() {
    if (busy) return;
    if (!activeItem && !photos.length && !hasManualInput) {
      resetCurrentCapture("Erfassung abgebrochen. Bereit fuer naechstes Objekt.");
      return;
    }
    if (!abortConfirm) {
      setAbortConfirm(true);
      setMessage("Zum Verwerfen des aktuellen Objekts bitte Abbrechen erneut druecken.");
      return;
    }
    const targetItem = activeItem;
    setBusy(true);
    try {
      if (targetItem) {
        const serverItemId = targetItem.server_item_id || await findServerItemId(targetItem.id);
        if (serverItemId) {
          if (!getOnlineStatus()) {
            setMessage("Dieses Objekt ist schon am Server. Zum Verwerfen bitte kurz online gehen.");
            return;
          }
          await api(`/items/${serverItemId}`, { method: "DELETE" });
        }
        const entries = await listQueueItems();
        const discardTargets = entries.filter((entry) => entry.client_item_id === targetItem.id).map((entry) => entry.id);
        if (discardTargets.length) {
          await discardQueueItems(discardTargets);
        }
      }
      resetCurrentCapture("Aktuelles Objekt verworfen. Bereit fuer naechstes Objekt.");
      await refreshQueueSummary();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Objekt konnte nicht verworfen werden.");
    } finally {
      setBusy(false);
    }
  }

  function normalizeAiPayload(payload?: ServerItemSuggestion | null): ServerItemSuggestion | null {
    if (!payload) return null;
    const detection = payload.bga_detection ?? null;
    const source = detection
      ? {
          ...payload,
          ...detection,
          suggested_fields: detection.suggested_fields ?? payload.suggested_fields,
          nameplate_extraction: detection.nameplate_extraction ?? payload.nameplate_extraction,
        }
      : payload;
    const suggested = source.suggested_fields ?? {};
    const nameplate = source.nameplate_extraction ?? null;
    const objectType = suggested.object_type || source.object_name || source.object_type || nameplate?.suggested_object_type;
    const serialNumber = suggested.serial_number || source.serial_number || nameplate?.serial_number || "";
    const specification = suggested.specification || source.specification || nameplate?.suggested_specification || "";
    const constructionYear = suggested.construction_year || source.construction_year || nameplate?.construction_year || "";
    const suggestedRemark = suggested.remark || source.suggested_remark || nameplate?.suggested_remark || source.uncertainty_reason || "";
    if (!objectType && !specification && !serialNumber && !constructionYear && !source.condition_guess && !suggestedRemark) return null;
    return {
      ...source,
      object_type: objectType,
      specification,
      serial_number: serialNumber,
      condition: suggested.condition || source.condition_guess || source.condition || "",
      construction_year: constructionYear,
      suggested_remark: suggestedRemark,
      nameplate_extraction: nameplate,
      confidence_score: source.confidence ?? source.confidence_score,
    };
  }

  function aiSpecSuggestion(item: ServerItemSuggestion) {
    const specParts = [
      item.suggested_fields?.specification,
      item.nameplate_extraction?.suggested_specification,
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
    return item.suggested_fields?.remark || item.suggested_remark || item.nameplate_extraction?.suggested_remark || item.uncertainty_reason || (item.status?.startsWith("ki_") ? "KI-Vorschlag vorhanden, bitte prüfen." : "");
  }

  function hasNameplateExtraction(item?: ServerItemSuggestion | null) {
    const nameplate = item?.nameplate_extraction;
    return Boolean(nameplate?.raw_text || nameplate?.serial_number || nameplate?.suggested_remark);
  }

  function aiConfidenceValue(item?: ServerItemSuggestion | null) {
    const raw = Number(item?.confidence ?? item?.confidence_score ?? 0);
    return raw > 1 ? raw / 100 : raw;
  }

  function isSafeAiSuggestion(item?: ServerItemSuggestion | null) {
    if (!item) return false;
    const confidence = aiConfidenceValue(item);
    const objectClass = String(item.object_class || "").toLowerCase();
    if (objectClass === "unklar") return false;
    if (hasNameplateExtraction(item)) return confidence >= 0.68;
    if (confidence >= 0.86) return true;
    if (item.requires_manual_review) return false;
    return confidence >= 0.78;
  }

  function aiConfidenceLabel(item: ServerItemSuggestion) {
    const normalized = aiConfidenceValue(item);
    if (!normalized) return "unklar";
    if (isSafeAiSuggestion(item)) return "sicher";
    if (item.requires_manual_review || normalized < 0.78) return "prüfen";
    return "sicher";
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
      { key: "serial_number", label: "Seriennummer", value: item.suggested_fields?.serial_number || item.serial_number || item.nameplate_extraction?.serial_number || "", field: "serial_number" as const, note: "vom Typenschild" },
      { key: "condition", label: "Zustand", value: item.suggested_fields?.condition || item.condition_guess || item.condition || "", field: "condition" as const },
      { key: "construction_year", label: "Baujahr", value: item.suggested_fields?.construction_year || item.construction_year || "", field: "construction_year" as const, note: "bitte prüfen" },
      { key: "remark", label: "Bemerkung", value: aiRemarkSuggestion(item), field: "remark" as const },
      { key: "estimate", label: "Alter/Wert", value: ageValue, note: `${item.estimated_value_reason || item.age_reason || "KI-Schätzung"} · manuell prüfen` },
    ].filter((row) => row.value);
  }

  function applyAiSuggestionField(key: keyof BgaForm, value: string) {
    setEditedFields((current) => ({ ...current, [key]: true }));
    setForm((current) => ({ ...current, [key]: value }));
    if (key === "object_type" && value.trim()) setDesignationPromptOpen(false);
    setAiSuggestionMessage("KI-Vorschlag übernommen. Bitte prüfen und bei Bedarf korrigieren.");
  }

  function applyAiSuggestionsToEmptyFields(item: ServerItemSuggestion) {
    if (!isSafeAiSuggestion(item)) {
      setAiSuggestionMessage("KI hat Vorschläge. Bitte mit den Chips prüfen.");
      return;
    }
    const specSuggestion = aiSpecSuggestion(item);
    const remarkSuggestion = aiRemarkSuggestion(item);
    const objectSuggestion = item.suggested_fields?.object_type || item.object_name || item.object_type || "";
    setForm((current) => ({
      ...current,
      object_type: current.object_type || objectSuggestion,
      specification: current.specification || specSuggestion,
      serial_number: current.serial_number || item.suggested_fields?.serial_number || item.serial_number || item.nameplate_extraction?.serial_number || "",
      construction_year: current.construction_year || item.suggested_fields?.construction_year || item.construction_year || "",
      condition: current.condition,
      remark: current.remark || remarkSuggestion,
    }));
    if (objectSuggestion) {
      setDesignationPromptOpen(false);
      setStep(2);
      focusAfterRender(() => activeStepRef.current);
    }
    setAiSuggestionMessage(hasNameplateExtraction(item) ? "Typenschild erkannt. Leere Felder wurden automatisch gefüllt." : "Leere Felder wurden automatisch mit KI-Vorschlägen gefüllt. Bitte prüfen.");
  }

  async function loadAiSuggestion({
    silent = false,
    itemOverride,
    photosOverride,
    requestKey,
  }: {
    silent?: boolean;
    itemOverride?: LocalItem;
    photosOverride?: CapturedPhoto[];
    requestKey?: string;
  } = {}) {
    const itemForAi = itemOverride ?? activeItem;
    const photosForAi = photosOverride ?? photos;
    if (!itemForAi || (!silent && busy)) return;
    const effectiveRequestKey = requestKey || aiRequestKey(itemForAi, photosForAi);
    if (effectiveRequestKey && dismissedAiKeyRef.current === effectiveRequestKey) return;
    if (!getOnlineStatus()) {
      setIsOnline(false);
      setAiSuggestionMessage("Offline - KI-Prüfung wird übersprungen. Deine Daten bleiben lokal gespeichert; KI startet erst mit Verbindung.");
      return;
    }
    const aiRunId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `ai-${Date.now()}-${Math.random()}`;
    aiProgressRunRef.current = aiRunId;
    if (!silent) setBusy(true);
    const hasTypePlatePhoto = photosForAi.some((photo) => photo.type === "type_plate");
    const startLabel = silent ? "KI liest im Hintergrund" : hasTypePlatePhoto ? "Typenschild wird gelesen" : "KI-Vorschlag wird vorbereitet";
    setAiSuggestionMessage(`${startLabel}.`);
    setAiProgress({ active: true, label: startLabel, progress: 12 });
    try {
      await enqueueItemDraft({
        session_id: joined?.session.id ?? "",
        device_id: deviceId,
        client_item_id: itemForAi.id,
        sequence_number: itemForAi.sequence_number,
        draft: buildDraft(itemForAi.id),
      });
      if (aiProgressRunRef.current === aiRunId) setAiProgress({ active: true, label: "Daten werden vorbereitet", progress: 28 });
      await runSync("Fotos und Objekt werden für KI synchronisiert.");
      if (!getOnlineStatus()) {
        setIsOnline(false);
        setAiSuggestionMessage("Offline - KI-Prüfung wurde gestoppt. Deine Daten bleiben lokal gespeichert; KI startet erst mit Verbindung.");
        return;
      }
      if (aiProgressRunRef.current === aiRunId) setAiProgress({ active: true, label: "Fotos werden uebertragen", progress: 48 });
      let serverItemId = await findServerItemId(itemForAi.id);
      for (let attempt = 0; !serverItemId && attempt < 6; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 550));
        serverItemId = await findServerItemId(itemForAi.id);
        if (aiProgressRunRef.current === aiRunId) setAiProgress({ active: true, label: "Server bestaetigt Objekt", progress: Math.min(62, 50 + attempt * 2) });
      }
      if (!serverItemId) {
        setAiSuggestionMessage("Objekt ist lokal gesichert. KI-Vorschlag kommt nach der Synchronisierung.");
        return;
      }
      if (aiProgressRunRef.current === aiRunId) setAiProgress({ active: true, label: "KI wird gestartet", progress: 66 });
      const aiStart = await api<{ status?: string; message?: string }>(`/items/${serverItemId}/ai/run?mode=fast`, { method: "POST", body: "{}" }).catch(() => null);
      if (aiStart?.status === "skipped") {
        setAiSuggestionMessage(aiStart.message || "KI-Vorschlag erst nach Objektfoto möglich.");
        return;
      }
      let serverSuggestion: ServerItemSuggestion | null = null;
      let lastStatus: AiStatusResponse | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (effectiveRequestKey && dismissedAiKeyRef.current === effectiveRequestKey) return;
        if (activeItemRef.current?.id !== itemForAi.id) return;
        if (aiProgressRunRef.current === aiRunId) setAiProgress({ active: true, label: "KI analysiert Foto", progress: Math.min(92, 70 + attempt * 3) });
        lastStatus = await api<AiStatusResponse>(`/items/${serverItemId}/ai/status?scope=fast`);
        serverSuggestion = normalizeAiPayload(lastStatus.result_preview);
        if (serverSuggestion || lastStatus.state === "completed" || lastStatus.state === "failed" || lastStatus.state === "cancelled") break;
      }
      if (serverSuggestion) {
        if (effectiveRequestKey && dismissedAiKeyRef.current === effectiveRequestKey) return;
        if (activeItemRef.current?.id !== itemForAi.id) return;
        if (aiProgressRunRef.current === aiRunId) setAiProgress({ active: true, label: "KI-Vorschlag ist da", progress: 100 });
        setAiSuggestion(serverSuggestion);
        applyAiSuggestionsToEmptyFields(serverSuggestion);
      } else if (lastStatus?.state === "running" || lastStatus?.state === "queued") {
        setAiSuggestionMessage("KI laeuft im Hintergrund. Du kannst weiter erfassen.");
      } else if (lastStatus?.state === "cancelled") {
        setAiSuggestionMessage("KI wurde abgebrochen. Du kannst normal weiterarbeiten.");
      } else if (lastStatus?.message) {
        setAiSuggestionMessage(lastStatus.message);
      } else {
        setAiSuggestionMessage("Noch kein KI-Vorschlag verfügbar. Du kannst normal weiterarbeiten.");
      }
    } catch {
      setAiSuggestionMessage("KI-Vorschlag ist gerade nicht verfügbar. Du kannst normal weiterarbeiten.");
    } finally {
      if (!silent) setBusy(false);
      if (aiProgressRunRef.current === aiRunId) {
        window.setTimeout(() => {
          if (aiProgressRunRef.current === aiRunId) setAiProgress({ active: false, label: "", progress: 0 });
        }, 450);
      }
    }
  }

  useEffect(() => {
    const hasAiPhoto = photos.some((photo) => photo.type === "object_front" || photo.type === "type_plate");
    if (!hasAiPhoto || !activeItem || busy) return;
    if (!isOnline || !getOnlineStatus()) {
      setAiSuggestionMessage("Offline - KI-Prüfung wird nicht gestartet. Du kannst normal weiter erfassen.");
      return;
    }
    const requestKey = aiRequestKey(activeItem, photos);
    if (aiAutoRequestKeyRef.current === requestKey) return;
    aiAutoRequestKeyRef.current = requestKey;
    void loadAiSuggestion({ silent: true, requestKey });
  }, [activeItem, busy, isOnline, photos]);

  const currentAiKey = aiRequestKey(activeItem, photos);
  const visibleSuggestionRows = aiSuggestion
    ? aiSuggestionRows(aiSuggestion).filter((row) => row.key !== "estimate" || !dismissedValueKey || dismissedValueKey !== currentAiKey)
    : [];

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
            {hasOpenLocalQueue ? <button className="btn secondary" type="button" onClick={toggleQueueDetails}>Details anzeigen</button> : null}
          </div>
        ) : null}

        {shouldShowForeignQueueNotice ? (
          <div className="mobile-sync-bar is-compact is-pending">
            <div>
              <strong>Alte lokale Daten gefunden</strong>
              <span>{otherSessionOpen} alte EintrÃ¤ge liegen noch auf diesem iPhone. Sie blockieren diese Session nicht.</span>
            </div>
            <button className="btn secondary" type="button" onClick={toggleQueueDetails}>Details anzeigen</button>
          </div>
        ) : null}

        {storageWarning ? (
          <div className="mobile-storage-warning" role="status">
            {storageWarning}
          </div>
        ) : null}

        {(hasOpenLocalQueue || hasForeignQueue) && !shouldPauseForQueue && queueDetails && showQueueDetails ? (
          <section className="wizard-card queue-detail-list">
            <QueueDetailsPanel
              queueDetails={queueDetails}
              joinedSessionId={joined?.session.id}
              diagnosisMessage={diagnosisMessage}
              diagnosisText={diagnosisText}
              copySyncDiagnostics={() => void copySyncDiagnostics()}
              showSyncDiagnostics={() => void showSyncDiagnostics()}
              sendSyncDiagnostics={() => void sendSyncDiagnostics()}
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
              <button className="btn secondary" type="button" onClick={toggleQueueDetails}>Details anzeigen</button>
            </div>
            {showQueueDetails ? (
              <QueueDetailsPanel
                queueDetails={queueDetails}
                joinedSessionId={joined?.session.id}
                diagnosisMessage={diagnosisMessage}
                diagnosisText={diagnosisText}
                copySyncDiagnostics={() => void copySyncDiagnostics()}
                showSyncDiagnostics={() => void showSyncDiagnostics()}
                sendSyncDiagnostics={() => void sendSyncDiagnostics()}
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
          <strong>
            {busy
              ? uploadState || "Bitte warten"
              : savedItem
                ? "Objekt gespeichert"
                : showAdvancedFlow
                  ? `Schritt ${step + 1} von ${steps.length}: ${steps[step]}`
                  : photos.length
                    ? `${photos.length}/5 Fotos lokal gesichert`
                    : "Bereit für das erste Foto"}
          </strong>
          <span>{busy && uploadProgress ? `${uploadProgress}% lokal gesichert` : message}</span>
        </div> : null}

        {canCaptureInThisSession && busy && uploadProgress ? (
          <div className="upload-meter" aria-label="Upload-Fortschritt">
            <span style={{ width: `${uploadProgress}%` }} />
          </div>
        ) : null}

        {canCaptureInThisSession && designationPromptOpen && !savedItem ? (
          <section className="mobile-designation-prompt" role="dialog" aria-live="polite" aria-label="Bezeichnung fehlt">
            <div>
              <strong>Bezeichnung fehlt</strong>
              <span>Kurz eintippen oder direkt sprechen, dann kann der Artikel sauber gespeichert werden.</span>
            </div>
            <div className="speech-input-row">
              <input
                ref={designationInputRef}
                value={form.object_type}
                onChange={(event) => update("object_type", event.target.value)}
                placeholder="z. B. Computermaus, Kaffeemaschine"
              />
              {speechButton("object_type", "Bezeichnung")}
            </div>
            {speechMessage ? <small>{speechMessage}</small> : null}
            <div className="designation-prompt-actions">
              <button className="btn accent" type="button" disabled={!form.object_type.trim() || busy} onClick={() => void saveObject()}>
                Speichern
              </button>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => setDesignationPromptOpen(false)}>
                Weiter bearbeiten
              </button>
            </div>
          </section>
        ) : null}

        {canCaptureInThisSession && !savedItem ? (
          <>
            <div className="scanner-action-dock is-fast" ref={captureStartRef} tabIndex={-1} aria-label="Profi-Scanner Aktionen">
              <label
                className={busy ? "is-disabled" : ""}
                htmlFor={photoInputId("object_front")}
                onClick={(event) => busy && event.preventDefault()}
              >
                <strong>Foto</strong>
                <span>{hasObjectPhoto ? "gesichert" : "Pflicht"}</span>
              </label>
            </div>
            <CapturePhotoStrip
              photos={photos}
              labels={photoLabels}
              busy={busy}
              onRemovePhoto={removeCapturedPhoto}
              onTypePlateRequested={() => decideTypePlate("vorhanden")}
            />
            {hasObjectPhoto || aiProgress.active || aiSuggestion ? (
              <MobileCopilotCard
                form={form}
                photos={photos}
                aiSuggestion={aiSuggestion}
                aiSuggestionMessage={aiSuggestionMessage}
                aiProgress={aiProgress}
                suggestionRows={visibleSuggestionRows}
                confidenceLabel={aiSuggestion ? aiConfidenceLabel(aiSuggestion) : "unklar"}
                isOnline={isOnline}
                busy={busy}
                canFinish={canSaveDraft}
                abortConfirm={abortConfirm}
                onApplyField={applyAiSuggestionField}
                onDiscardAi={discardAiSuggestion}
                onDiscardValue={discardValueSuggestion}
                onAccept={() => setStep(summaryBlockers.length ? 1 : 3)}
                onEdit={() => { setAbortConfirm(false); setStep(1); }}
                onFinish={() => void saveObject()}
                onAbort={() => void abortCurrentObject()}
              />
            ) : null}
            <section className="mobile-conveyor-card" aria-label="Schnelle Erfassung">
              <div className="mobile-conveyor-head">
                <div>
                  <strong>Schnelle Erfassung</strong>
                  <span>Foto, Bezeichnung, Zustand, speichern.</span>
                </div>
                <span>{photos.length}/5 Fotos</span>
              </div>

              <label className="field mobile-voice-field">
                <span>Bezeichnung</span>
                <div className="speech-input-row">
                  <input
                    ref={designationInputRef}
                    value={form.object_type}
                    onChange={(event) => update("object_type", event.target.value)}
                    placeholder="z. B. Computermaus"
                  />
                  {speechButton("object_type", "Bezeichnung")}
                </div>
                <small>{form.object_type ? "Kann geaendert werden." : hasObjectPhoto ? "KI kann dieses Feld fuellen." : "Kurz eingeben oder nach Foto von KI fuellen lassen."}</small>
              </label>

              <div className="mobile-condition-grid is-compact">
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
              </div>

              {showAdvancedFlow ? (
                <>
                <label className="field mobile-voice-field">
                  <span>Zustand sprechen</span>
                  <div className="speech-input-row">
                    <input
                      value={form.condition_note}
                      onChange={(event) => update("condition_note", event.target.value)}
                      placeholder="z. B. gut, leichte Kratzer"
                    />
                    {speechButton("condition_note", "Zustand")}
                  </div>
                </label>

              <div className="mobile-function-rail" aria-label="Funktion">
                {[
                  ["ja", "Funktion i. O."],
                  ["nein", "Defekt"],
                  ["nicht_geprueft", "Nicht geprüft"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={form.function_ok === value ? "is-active" : ""}
                    type="button"
                    onClick={() => decideFunctionOk(value as FunctionOk)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <label className="field mobile-voice-field">
                <span>Bemerkung</span>
                <div className="speech-input-row is-textarea">
                  <textarea
                    rows={3}
                    value={form.remark}
                    onChange={(event) => update("remark", event.target.value)}
                    placeholder="z. B. Zubehör, Standort, Schaden, Nutzerhinweis"
                  />
                  {speechButton("remark", "Bemerkung")}
                </div>
              </label>
                </>
              ) : null}

              {speechMessage ? <p className="speech-live-status" aria-live="polite">{speechMessage}</p> : null}

              <div className="mobile-conveyor-actions">
                <button className="btn accent" type="button" disabled={busy || !canSaveDraft} onClick={() => void saveObject()}>
                  Speichern · nächstes Objekt
                </button>
                <label className={`btn secondary ${busy ? "is-disabled" : ""}`} htmlFor={photoInputId(hasObjectPhoto ? "other" : "object_front")} onClick={(event) => busy && event.preventDefault()}>
                  Foto +
                </label>
                <button className="btn secondary" type="button" disabled={busy} onClick={() => void abortCurrentObject()}>
                  {abortConfirm ? "Verwerfen bestätigen" : "Abbrechen"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setStep(1);
                    setShowAdvancedFlow((current) => !current);
                  }}
                >
                  {showAdvancedFlow ? "Details ausblenden" : "Details öffnen"}
                </button>
              </div>
            </section>
          </>
        ) : null}

        {canCaptureInThisSession && savedItem ? (
          <section className="wizard-card saved-card">
            <div className="saved-mark">✓</div>
            <h1>Objekt gespeichert</h1>
            <p>{savedItem.label} ist lokal gesichert. Naechstes Objekt wird vorbereitet.</p>
            {photos.length ? <PhotoPreviewList photos={photos} labels={photoLabels} /> : null}
            <button className="btn accent" type="button" onClick={startNextObject}>Nächstes Objekt erfassen</button>
            {joined ? <a className="btn secondary" href={`/session/${joined.session.id}`}>Zur Prüfliste</a> : null}
          </section>
        ) : null}

        {canCaptureInThisSession && !savedItem && showAdvancedFlow ? <div className="wizard-progress">
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

        {canCaptureInThisSession && !savedItem && showAdvancedFlow ? (
          <div className="wizard-step-anchor" ref={activeStepRef}>
            {step === 0 ? (
              <WizardCard title="Fotos & Nachweise" hint="Objekt vollständig fotografieren. Typenschild und weitere Nachweise direkt hier ergänzen.">
                <label
                  className={`mobile-photo-stage ${busy ? "is-disabled" : ""}`}
                  htmlFor={photoInputId("object_front")}
                  onClick={(event) => busy && event.preventDefault()}
                >
                  <span>Objekt fotografieren</span>
                  <small>{photos.filter((photo) => photo.type === "object_front").length ? "Objektfoto gespeichert" : "Pflichtfoto"}</small>
                </label>
                <div className="summary-box info">
                  <strong>Typenschild</strong>
                  <span>Wenn vorhanden, gut lesbar fotografieren. Daraus können Hersteller, Modell und Baujahr besser erkannt werden.</span>
                </div>
                <div className="choice-grid">
                  <label
                    className={`${form.type_plate_status === "vorhanden" ? "is-active" : ""} ${busy ? "is-disabled" : ""}`.trim()}
                    htmlFor={photoInputId("type_plate")}
                    onClick={(event) => {
                      if (busy) {
                        event.preventDefault();
                        return;
                      }
                      decideTypePlate("vorhanden");
                    }}
                  >
                    Typenschild fotografieren
                  </label>
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
                  <label className={`btn secondary ${busy ? "is-disabled" : ""}`} htmlFor={photoInputId("condition_detail")} onClick={(event) => busy && event.preventDefault()}>Zustand/Schaden fotografieren</label>
                  <label className={`btn secondary ${busy ? "is-disabled" : ""}`} htmlFor={photoInputId("other")} onClick={(event) => busy && event.preventDefault()}>Weiteres Foto</label>
                </div>
              </WizardCard>
            ) : null}

            {false ? (
              <WizardCard title="KI-Vorschlag" hint="KI füllt leere Felder automatisch. Bitte alles prüfen.">
                <div className="summary-box info">
                  <strong>KI-Vorschlag – bitte prüfen</strong>
                  <span>Die KI startet mit Objektfoto automatisch. Ein Typenschildfoto wird zusätzlich genutzt, wenn es vorhanden ist.</span>
                  {aiSuggestionMessage ? <span>{aiSuggestionMessage}</span> : null}
                </div>
                {aiSuggestion ? (
                  <div className="summary-list ai-suggestion-list">
                    {aiSuggestionRows(aiSuggestion!).map((row) => (
                      <span key={row.key}>
                        <b>{row.label}</b>
                        <span>{row.value}</span>
                        <small>{row.note || aiConfidenceLabel(aiSuggestion!)}</small>
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
                <button className="btn accent" type="button" disabled={busy || !hasObjectPhoto || !isOnline} onClick={() => void loadAiSuggestion()}>
                  KI erneut prüfen
                </button>
                {!hasObjectPhoto ? <p className="muted">Zuerst Objektfoto aufnehmen.</p> : null}
              </WizardCard>
            ) : null}

            {step === 1 ? (
              <WizardCard title="Stammdaten" hint="Bezeichnung, Typ und Baujahr eintragen oder KI-Vorschlag prüfen.">
                <div className="dictation-block">
                  <p className="muted dictation-hint">Komplett-Diktat: Bezeichnung … Marke … Typ … Baujahr … Seriennummer … Zustand …</p>
                  <PushToTalk onResult={handleDictation} />
                  {dictationChips ? (
                    <div className="dictation-chips">
                      {dictationChips.object_type ? <span className="status-chip">Bezeichnung erkannt</span> : null}
                      {dictationChips.specification ? <span className="status-chip">Typ: {dictationChips.specification}</span> : null}
                      {dictationChips.serial_number ? <span className="status-chip">S/N: {dictationChips.serial_number}</span> : null}
                      {dictationChips.construction_year ? <span className="status-chip">Baujahr: {dictationChips.construction_year}</span> : null}
                      {dictationChips.condition ? <span className="status-chip">Zustand: {dictationChips.condition.replaceAll("_", " ")}</span> : null}
                    </div>
                  ) : null}
                  {dictationAudio ? <p className="muted">Audio-Beleg wird beim Speichern mitgesichert.</p> : null}
                </div>
                <label className="field">
                  <span>Bezeichnung</span>
                  <div className="speech-input-row">
                    <input ref={designationInputRef} value={form.object_type} onChange={(event) => update("object_type", event.target.value)} placeholder="z. B. Computermaus" />
                    {speechButton("object_type", "Bezeichnung")}
                  </div>
                </label>
                <label className="field">
                  <span>Typ / Spezifikation</span>
                  <div className="speech-input-row is-textarea">
                    <textarea rows={4} value={form.specification} onChange={(event) => update("specification", event.target.value)} placeholder="z. B. Hersteller, Modell, Größe, Traglast, technische Daten" />
                    {speechButton("specification", "Typ / Spezifikation")}
                  </div>
                </label>
                <label className="field">
                  <span>Seriennummer</span>
                  <div className="speech-input-row">
                    <input value={form.serial_number} onChange={(event) => update("serial_number", event.target.value)} placeholder="nur wenn eindeutig lesbar" />
                    <button type="button" className="speech-btn" onClick={() => setSerialScannerOpen(true)} aria-label="Barcode scannen">Scan</button>
                    {speechButton("serial_number", "Seriennummer")}
                  </div>
                  {serialScannerOpen ? (
                    <BarcodeScanner
                      onDetected={(code) => {
                        update("serial_number", code);
                        setSerialScannerOpen(false);
                      }}
                      onClose={() => setSerialScannerOpen(false)}
                    />
                  ) : null}
                </label>
                <label className="field">
                  <span>Baujahr</span>
                  <div className="speech-input-row">
                    <input inputMode="numeric" value={form.construction_year} onChange={(event) => update("construction_year", event.target.value)} placeholder="z. B. 2018 oder unbekannt" />
                    {speechButton("construction_year", "Baujahr")}
                  </div>
                </label>
                {aiSuggestion?.estimated_age_years ? <p className="muted">KI-Schätzung: ca. {aiSuggestion.estimated_age_years} Jahre. Bitte nicht als gesichertes Baujahr übernehmen, wenn keine Quelle erkennbar ist.</p> : null}
                {speechMessage ? <p className="speech-live-status" aria-live="polite">{speechMessage}</p> : null}
              </WizardCard>
            ) : null}

            {step === 2 ? (
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
                  <div className="speech-input-row is-textarea">
                    <textarea rows={3} value={form.condition_note} onChange={(event) => update("condition_note", event.target.value)} placeholder="z. B. stark verschmutzt, beschädigt, funktionsfähig laut Nutzer" />
                    {speechButton("condition_note", "Zustandsbemerkung")}
                  </div>
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
                <label className="field" ref={uvvStatusRef} tabIndex={-1}>
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
                    <label className="field" ref={uvvDateRef} tabIndex={-1}>
                      <span>UVV gültig bis</span>
                      <div className="speech-input-row">
                        <input type="date" value={form.uvv_valid_until} onChange={(event) => update("uvv_valid_until", event.target.value)} />
                        {speechButton("uvv_valid_until", "UVV gueltig bis")}
                      </div>
                    </label>
                    <label className={`btn secondary ${busy ? "is-disabled" : ""}`} htmlFor={photoInputId("uvv_label")} onClick={(event) => busy && event.preventDefault()}>UVV-Siegel fotografieren</label>
                  </>
                ) : (
                  <div className="summary-box info">
                    <strong>Kein UVV-Foto nötig</strong>
                    <span>{form.uvv_status === "unklar" ? "UVV wird als Nacharbeit gekennzeichnet." : "Diese Entscheidung überspringt das UVV-Siegel-Foto."}</span>
                  </div>
                )}
                <label className="field" ref={remarkFieldRef} tabIndex={-1}>
                  <span>Bemerkung</span>
                  <div className="speech-input-row is-textarea">
                    <textarea rows={5} value={form.remark} onChange={(event) => update("remark", event.target.value)} placeholder="z. B. Standortdetail, Zubehör, auffällige Schäden, Nutzerhinweis" />
                    {speechButton("remark", "Bemerkung")}
                  </div>
                </label>
                {speechMessage ? <p className="speech-live-status" aria-live="polite">{speechMessage}</p> : null}
              </WizardCard>
            ) : null}

            {step === 3 ? (
              <section ref={summaryStepRef} className="wizard-step-section" tabIndex={-1}>
              <WizardCard title="Zusammenfassung" hint="Prüfen, dann speichern.">
                <div className="summary-list">
                  <span><b>Bezeichnung</b>{form.object_type || "fehlt"}</span>
                  <span><b>Typ/Spezifikation</b>{form.specification || "offen"}</span>
                  <span><b>Seriennummer</b>{form.serial_number || "offen"}</span>
                  <span><b>Baujahr</b>{form.construction_year || "offen"}</span>
                  <span><b>Zustand</b>{form.condition}</span>
                  <span><b>Funktion</b>{form.function_ok}</span>
                  <span><b>UVV</b>{form.uvv_status}{form.uvv_valid_until ? ` bis ${form.uvv_valid_until}` : ""}</span>
                  <span><b>Fotos</b>{photos.length}/5</span>
                </div>
                {photos.length ? <PhotoPreviewList photos={photos} labels={photoLabels} onRemovePhoto={removeCapturedPhoto} busy={busy} /> : null}
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
              </section>
            ) : null}
          </div>
        ) : null}

        {canCaptureInThisSession && !savedItem && showAdvancedFlow ? <div className="wizard-nav">
          <button className="btn secondary" type="button" disabled={step === 0 || busy} onClick={() => setStep((value) => Math.max(0, value - 1))}>Zurück</button>
          <button className="btn accent" type="button" disabled={mobilePrimaryDisabled} onClick={runMobilePrimaryAction}>{mobilePrimaryLabel}</button>
        </div> : null}

        {canCaptureInThisSession ? (["object_front", "object_back", "type_plate", "uvv_label", "condition_detail", "other"] as PhotoType[]).map((type) => (
          <input
            key={type}
            id={photoInputId(type)}
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
  diagnosisText,
  copySyncDiagnostics,
  showSyncDiagnostics,
  sendSyncDiagnostics,
  runBundleDiagnosticSync,
  discardConfirm,
  setDiscardConfirm,
  discardOpenQueue,
}: {
  queueDetails: QueueDetails;
  joinedSessionId?: string;
  diagnosisMessage: string;
  diagnosisText: string;
  copySyncDiagnostics: () => void;
  showSyncDiagnostics: () => void;
  sendSyncDiagnostics: () => void;
  runBundleDiagnosticSync: () => void;
  discardConfirm: string;
  setDiscardConfirm: (value: string) => void;
  discardOpenQueue: () => void;
}) {
  return (
    <div className="queue-detail-list">
      <div className="queue-diagnostics-actions">
        <button className="btn secondary" type="button" onClick={copySyncDiagnostics}>Diagnose kopieren</button>
        <button className="btn secondary" type="button" onClick={showSyncDiagnostics}>Diagnose anzeigen</button>
        <button className="btn secondary" type="button" onClick={sendSyncDiagnostics}>Diagnose an Server senden</button>
        <button className="btn secondary" type="button" onClick={runBundleDiagnosticSync}>Foto-Sync erneut testen</button>
        {diagnosisMessage ? <small>{diagnosisMessage}</small> : null}
      </div>
      {diagnosisText ? (
        <textarea className="queue-diagnosis-text" readOnly value={diagnosisText} rows={10} aria-label="Sync-Diagnose" />
      ) : null}
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

function MobileCopilotCard({
  form,
  photos,
  aiSuggestion,
  aiSuggestionMessage,
  aiProgress,
  suggestionRows,
  confidenceLabel,
  isOnline,
  busy,
  canFinish,
  abortConfirm,
  onApplyField,
  onDiscardAi,
  onDiscardValue,
  onAccept,
  onEdit,
  onFinish,
  onAbort,
}: {
  form: BgaForm;
  photos: CapturedPhoto[];
  aiSuggestion: ServerItemSuggestion | null;
  aiSuggestionMessage: string;
  aiProgress: AiProgressState;
  suggestionRows: Array<{ key: string; label: string; value: string; field?: keyof BgaForm; note?: string }>;
  confidenceLabel: string;
  isOnline: boolean;
  busy: boolean;
  canFinish: boolean;
  abortConfirm: boolean;
  onApplyField: (field: keyof BgaForm, value: string) => void;
  onDiscardAi: () => void;
  onDiscardValue: () => void;
  onAccept: () => void;
  onEdit: () => void;
  onFinish: () => void;
  onAbort: () => void;
}) {
  const hasObjectPhoto = photos.some((photo) => photo.type === "object_front");
  const nameplate = aiSuggestion?.nameplate_extraction;
  const seenLabel = form.object_type
    || aiSuggestion?.suggested_fields?.object_type
    || aiSuggestion?.object_name
    || aiSuggestion?.object_type
    || nameplate?.suggested_object_type
    || "";
  const statusText = !hasObjectPhoto
    ? "Objektfoto fehlt"
    : !isOnline
      ? "KI nach Verbindung"
      : nameplate?.raw_text || nameplate?.serial_number
        ? "Typenschild gelesen"
        : aiSuggestion
          ? "Objekt erkannt"
          : aiSuggestionMessage || "KI liest mit";
  const accepted = [
    form.object_type ? "Bezeichnung" : "",
    form.specification ? "Typ/Spezifikation" : "",
    form.serial_number ? "Seriennummer" : "",
    form.construction_year ? "Baujahr" : "",
    form.remark ? "Bemerkung" : "",
  ].filter(Boolean);
  const open = [
    !hasObjectPhoto ? "Objektfoto" : "",
    !form.object_type.trim() ? "Bezeichnung prüfen" : "",
  ].filter(Boolean);
  const chips = suggestionRows.flatMap((row) => {
    if (row.key === "estimate" || !row.field || !row.value) return [];
    return String(form[row.field] ?? "").trim() === row.value.trim() ? [] : [{ ...row, field: row.field }];
  }).slice(0, 4);
  const valueRow = suggestionRows.find((row) => row.key === "estimate");
  const confidenceTone = confidenceLabel === "sicher" ? "safe" : confidenceLabel === "prüfen" ? "review" : "unknown";

  const showAiProgress = aiProgress.active || (hasObjectPhoto && !aiSuggestion && /KI/.test(aiSuggestionMessage));
  const aiProgressValue = Math.max(5, Math.min(100, aiProgress.progress || 16));
  const aiProgressLabel = aiProgress.label || aiSuggestionMessage || "KI arbeitet";

  return (
    <section className={`mobile-copilot-card ${aiSuggestion ? "has-ai" : ""}`} aria-label="KI-Copilot">
      <div className="mobile-copilot-head">
        <div>
          <strong>{statusText}</strong>
          <span>{seenLabel ? `Ich sehe: ${seenLabel}` : hasObjectPhoto ? "Ich prüfe die Aufnahme im Hintergrund." : "Erstes Foto aufnehmen, dann helfe ich mit."}</span>
        </div>
        <span className={`copilot-confidence is-${confidenceTone}`}>{confidenceLabel}</span>
      </div>

      {showAiProgress ? (
        <div className="copilot-ai-meter" role="status" aria-live="polite" aria-label="KI arbeitet">
          <div>
            <strong>{aiProgressLabel}</strong>
            <span>{aiProgressValue}%</span>
          </div>
          <div className="copilot-ai-track">
            <span style={{ width: `${aiProgressValue}%` }} />
          </div>
        </div>
      ) : null}

      <div className="mobile-copilot-summary">
        <span><b>Übernommen</b>{accepted.length ? accepted.join(", ") : "noch nichts"}</span>
        <span><b>Noch offen</b>{open.length ? open.slice(0, 4).join(", ") : "bereit zum Abschluss"}</span>
      </div>

      {chips.length ? (
        <div className="copilot-chip-row" aria-label="KI-Vorschläge übernehmen">
          {chips.map((row) => (
            <button key={row.key} type="button" disabled={busy || !row.field} onClick={() => row.field && onApplyField(row.field, row.value)}>
              <b>{row.label}</b>
              <span>{row.value}</span>
            </button>
          ))}
        </div>
      ) : null}

      {valueRow ? (
        <div className="copilot-value-row" aria-label="Gebrauchtwert pruefen">
          <div>
            <b>Gebrauchtwert pruefen</b>
            <span>{valueRow.value}</span>
            {valueRow.note ? <small>{valueRow.note}</small> : null}
          </div>
          <button className="btn secondary" type="button" disabled={busy} onClick={onDiscardValue}>Wert verwerfen</button>
        </div>
      ) : null}

      <div className="mobile-copilot-actions">
        <button className="btn accent" type="button" disabled={busy || !hasObjectPhoto} onClick={onAccept}>Passt</button>
        <button className="btn secondary" type="button" disabled={busy} onClick={onEdit}>Ändern</button>
        <label className={`btn secondary ${busy ? "is-disabled" : ""}`} htmlFor={photoInputId("other")} onClick={(event) => busy && event.preventDefault()}>Noch ein Foto</label>
        <button className="btn" type="button" disabled={busy || !canFinish} onClick={onFinish}>Fertig</button>
        <button className="btn danger" type="button" disabled={busy} onClick={onAbort}>{abortConfirm ? "Verwerfen bestaetigen" : "Abbrechen"}</button>
      </div>

      {aiSuggestion ? <button className="copilot-discard" type="button" disabled={busy} onClick={onDiscardAi}>KI verwerfen</button> : null}
    </section>
  );
}

function CapturePhotoStrip({
  photos,
  labels,
  busy,
  onRemovePhoto,
  onTypePlateRequested,
}: {
  photos: CapturedPhoto[];
  labels: Record<PhotoType, string>;
  busy: boolean;
  onRemovePhoto: (photo: CapturedPhoto, index: number) => void;
  onTypePlateRequested: () => void;
}) {
  const slotPlan: Array<{ type: PhotoType; title: string; state: string; optional?: boolean }> = [
    { type: "object_front", title: "Objektfoto", state: "Pflicht" },
    { type: "type_plate", title: "Typenschild", state: "optional", optional: true },
    { type: "condition_detail", title: "Detail", state: "optional", optional: true },
    { type: "object_back", title: "Rückseite", state: "optional", optional: true },
    { type: "other", title: "Zusatz", state: "optional", optional: true },
  ];

  return (
    <section className={`mobile-photo-proof ${photos.length ? "has-photos" : "is-empty"}`} aria-label="Aufgenommene Fotos">
      <div className="mobile-photo-proof-head">
        <strong>{photos.length ? `${photos.length}/5 Fotos` : "Noch kein Foto"}</strong>
        <span>{photos.length ? "lokal sichtbar gesichert" : "1 Pflichtfoto, 4 optional"}</span>
      </div>
      <div className="mobile-photo-proof-row">
        {slotPlan.map((slot, index) => {
          const photo = photos[index];
          if (photo) {
            return (
              <div
                key={`${photo.type}-${photo.id ?? photo.name}-${index}`}
                className={`photo-proof-card has-image ${busy ? "is-disabled" : ""}`}
              >
                {photo.previewUrl ? <img src={photo.previewUrl} alt={labels[photo.type]} /> : <span className="photo-proof-fallback">Foto</span>}
                <span className="photo-proof-index">{index + 1}</span>
                <button
                  className="photo-proof-delete"
                  type="button"
                  disabled={busy}
                  aria-label={`${labels[photo.type]} loeschen`}
                  onClick={() => onRemovePhoto(photo, index)}
                >
                  x
                </button>
                <span className="photo-proof-label">{labels[photo.type]}</span>
                <span className="photo-proof-state">lokal</span>
              </div>
            );
          }
          return (
            <label
              key={`${slot.type}-${index}`}
              className={`photo-proof-card is-empty ${slot.optional ? "is-optional" : ""} ${busy ? "is-disabled" : ""}`}
              htmlFor={photoInputId(slot.type)}
              onClick={(event) => {
                if (busy) {
                  event.preventDefault();
                  return;
                }
                if (slot.type === "type_plate") onTypePlateRequested();
              }}
            >
              <span className="photo-proof-empty-icon">+</span>
              <span className="photo-proof-label">{slot.title}</span>
              <span className="photo-proof-state">{slot.state}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function PhotoPreviewList({
  photos,
  labels,
  onRemovePhoto,
  busy = false,
}: {
  photos: CapturedPhoto[];
  labels: Record<PhotoType, string>;
  onRemovePhoto?: (photo: CapturedPhoto, index: number) => void;
  busy?: boolean;
}) {
  return (
    <div className="mobile-photo-previews">
      {photos.map((photo, index) => (
        <figure key={`${photo.type}-${photo.name}-${index}`}>
          {photo.previewUrl ? <img src={photo.previewUrl} alt={labels[photo.type]} /> : null}
          {onRemovePhoto ? (
            <button
              className="photo-preview-delete"
              type="button"
              disabled={busy}
              aria-label={`${labels[photo.type]} loeschen`}
              onClick={() => onRemovePhoto(photo, index)}
            >
              Foto loeschen
            </button>
          ) : null}
          <figcaption>
            <span>{labels[photo.type]}</span>
            <small>Foto {index + 1}</small>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
