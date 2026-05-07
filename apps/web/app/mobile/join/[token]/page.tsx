"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, RefObject } from "react";
import { Bootstrap, inventoryTypeLabel } from "@/lib/api";
import { api } from "@/lib/api";
import {
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
  "Objektfoto",
  "Typenschild?",
  "Typenschildfoto",
  "KI-Vorschlag",
  "Bezeichnung",
  "Typ / Spezifikation",
  "Baujahr",
  "Zustand",
  "Funktion",
  "UVV",
  "Bemerkung",
  "Zusammenfassung",
];

const photoLabels: Record<PhotoType, string> = {
  object_front: "Objektfoto",
  object_back: "Rückseite / Detailansicht",
  type_plate: "Typenschild",
  uvv_label: "UVV-Siegel",
  condition_detail: "Zustandsdetail",
  other: "Sonstiges Foto",
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
  type_plate_status: "vorhanden" | "nicht_vorhanden" | "uebersprungen" | "nicht_geprueft";
};

type ServerItemSuggestion = {
  object_type?: string | null;
  brand?: string | null;
  model?: string | null;
  serial_number?: string | null;
  specification?: string | null;
  construction_year?: string | null;
  condition?: string | null;
  value_estimate?: number | string | null;
  estimated_age_years?: number | string | null;
  age_source?: string | null;
  age_verification_status?: string | null;
  confidence_score?: number | string | null;
  status?: string | null;
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

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [objectClassId, setObjectClassId] = useState("");
  const [step, setStep] = useState(0);
  const [activeItem, setActiveItem] = useState<LocalItem | null>(null);
  const [form, setForm] = useState<BgaForm>(emptyForm);
  const [photos, setPhotos] = useState<Array<{ type: PhotoType; id?: string; name: string; size: number; previewUrl?: string }>>([]);
  const [savedItem, setSavedItem] = useState<{ label: string } | null>(null);
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

  const fileInputRefs: Record<PhotoType, RefObject<HTMLInputElement | null>> = {
    object_front: useRef<HTMLInputElement>(null),
    object_back: useRef<HTMLInputElement>(null),
    type_plate: useRef<HTMLInputElement>(null),
    uvv_label: useRef<HTMLInputElement>(null),
    condition_detail: useRef<HTMLInputElement>(null),
    other: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

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
    api<Bootstrap>("/meta/bootstrap").then((boot) => {
      setBootstrap(boot);
      setObjectClassId(boot.object_classes.find((entry) => entry.slug === "bga")?.id ?? boot.object_classes[0]?.id ?? "");
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Stammdaten nicht erreichbar"));
  }, []);

  useEffect(() => {
    if (!token || !deviceId) return;
    api<Joined>("/sessions/join", {
      method: "POST",
      body: JSON.stringify({ token, device_name: "Handy-Erfassung BGA", device_fingerprint: deviceId }),
    }).then(setJoined).catch((err) => setMessage(err instanceof Error ? err.message : "Join fehlgeschlagen"));
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
      setPhotos([]);
      setAiSuggestion(null);
      setAiSuggestionMessage("");
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
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startNextObject() {
    setSavedItem(null);
    setActiveItem(null);
    setForm(emptyForm);
    setPhotos([]);
    setAiSuggestion(null);
    setAiSuggestionMessage("");
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
  ].filter(Boolean);
  const openQueueItems = queueDetails?.openItems ?? [];
  const openQueueObjects = openQueueItems.filter((item) => item.type === "item_draft").length;
  const openQueuePhotos = openQueueItems.filter((item) => item.type === "photo_upload").length;
  const hasOpenLocalQueue = isBgaSession && openQueueItems.length > 0;
  const openQueueIntro = openQueuePhotos
    ? `Es sind noch ${openQueuePhotos} Fotos auf diesem iPhone gespeichert, die noch nicht übertragen wurden.`
    : `Es sind noch ${openQueueObjects} Objekte auf diesem iPhone gespeichert, die noch nicht übertragen wurden.`;
  const otherSessionOpen = queueDetails?.otherSessionItems.length ?? 0;
  const currentSessionOpen = queueDetails?.currentSessionItems.length ?? 0;
  const hasQueueFailure = queueSummary.failed > 0;
  const hasQueueConflict = queueSummary.conflict > 0;
  const hasForeignQueue = otherSessionOpen > 0;
  const shouldPauseForQueue = isBgaSession && (hasForeignQueue || hasQueueConflict);
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
  const canCaptureInThisSession = isBgaSession && !shouldPauseForQueue;

  async function findServerItemId(clientItemId: string) {
    const entries = await listQueueItems();
    return entries.find((entry) => entry.type === "item_draft" && entry.client_item_id === clientItemId && entry.server_item_id)?.server_item_id;
  }

  function applyAiSuggestion(item: ServerItemSuggestion) {
    const specParts = [item.specification, item.brand, item.model, item.serial_number ? `SN ${item.serial_number}` : ""]
      .filter(Boolean)
      .map(String);
    setForm((current) => ({
      ...current,
      object_type: current.object_type || item.object_type || "",
      specification: current.specification || specParts.join(" · "),
      construction_year: current.construction_year || item.construction_year || "",
      condition: current.condition === "gebraucht" && item.condition ? item.condition : current.condition,
      remark: current.remark || (item.status?.startsWith("ki_") ? "KI-Vorschlag vorhanden, bitte am Laptop/iPad prüfen." : current.remark),
    }));
    setAiSuggestion(item);
    setAiSuggestionMessage("KI-Vorschlag übernommen. Bitte prüfen und bei Bedarf korrigieren.");
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
      await api(`/items/${serverItemId}/ai/run?mode=review`, { method: "POST", body: "{}" }).catch(() => undefined);
      let serverItem: ServerItemSuggestion | null = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        serverItem = await api<ServerItemSuggestion>(`/items/${serverItemId}`);
        if (serverItem.object_type || serverItem.brand || serverItem.model || serverItem.serial_number || serverItem.status === "ki_fertig") break;
      }
      if (serverItem) {
        applyAiSuggestion(serverItem);
      } else {
        setAiSuggestionMessage("Noch kein KI-Vorschlag verfügbar. Du kannst normal weiterarbeiten.");
      }
    } catch {
      setAiSuggestionMessage("KI-Vorschlag ist gerade nicht verfügbar. Du kannst normal weiterarbeiten.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page grid mobile-capture-page bga-wizard-page">
      <section className="mobile-capture-shell bga-wizard">
        <div className="mobile-room-bar">
          <div>
            <strong>{roomName}</strong>
            <span>{inventoryTypeLabel(inventoryType)}</span>
          </div>
          <span className="live-indicator">Live</span>
        </div>

        {isBgaSession && !shouldPauseForQueue ? (
          <div className={`mobile-sync-bar ${!isOnline ? "is-offline" : queueSummary.failed || queueSummary.conflict ? "is-failed" : queueSummary.open ? "is-pending" : "is-synced"}`}>
            <div>
              <strong>{syncText}</strong>
              <span>{syncDetail}</span>
            </div>
            <button
              className="btn secondary"
              type="button"
              disabled={false}
              onClick={() => void retrySync()}
              title={!isOnline ? "Synchronisierung wird versucht. Wenn keine Verbindung besteht, bleiben die Daten lokal gesichert." : undefined}
            >
              Jetzt synchronisieren
            </button>
            {queueSummary.failed ? <button className="btn secondary" type="button" onClick={() => void retrySync()}>Fehler erneut versuchen</button> : null}
            {hasOpenLocalQueue ? <button className="btn secondary" type="button" onClick={() => setShowQueueDetails((value) => !value)}>Details anzeigen</button> : null}
          </div>
        ) : null}

        {hasOpenLocalQueue && !shouldPauseForQueue && queueDetails && showQueueDetails ? (
          <section className="wizard-card queue-detail-list">
            <QueueDetailsPanel
              queueDetails={queueDetails}
              joinedSessionId={joined?.session.id}
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
              onClick={() => setStep(index)}
            >
              {index + 1}
            </button>
          ))}
        </div> : null}

        {canCaptureInThisSession && !savedItem && step === 0 ? (
          <WizardCard title="Objektfoto aufnehmen" hint="Fotografiere das Objekt vollständig und gut erkennbar.">
            <button className="mobile-photo-stage" type="button" disabled={busy} onClick={() => openCamera("object_front")}>
              <span>Objektfoto aufnehmen</span>
              <small>{photos.filter((photo) => photo.type === "object_front").length ? "Objektfoto gespeichert" : "Pflichtfoto"}</small>
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("object_back")}>
              Rückseite/Detail ergänzen
            </button>
            {photos.length ? <PhotoPreviewList photos={photos} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 1 ? (
          <WizardCard title="Typenschild vorhanden?" hint="Falls sichtbar, direkt angeben. Das blockiert die Erfassung nicht.">
            <div className="segmented">
              <button className={form.type_plate_status === "vorhanden" ? "is-active" : ""} onClick={() => update("type_plate_status", "vorhanden")} type="button">Ja</button>
              <button className={form.type_plate_status === "nicht_vorhanden" ? "is-active" : ""} onClick={() => update("type_plate_status", "nicht_vorhanden")} type="button">Nein</button>
              <button className={form.type_plate_status === "uebersprungen" || form.type_plate_status === "nicht_geprueft" ? "is-active" : ""} onClick={() => update("type_plate_status", "uebersprungen")} type="button">Nicht erkennbar</button>
            </div>
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 2 ? (
          <WizardCard title="Typenschild fotografieren" hint="Falls ein Typenschild vorhanden ist, bitte gut lesbar fotografieren.">
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("type_plate")}>Typenschildfoto aufnehmen</button>
            {form.type_plate_status !== "vorhanden" ? <p className="muted">Wenn kein Typenschild vorhanden oder erkennbar ist, einfach weitergehen.</p> : null}
            {photos.some((photo) => photo.type === "type_plate") ? <PhotoPreviewList photos={photos.filter((photo) => photo.type === "type_plate")} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 3 ? (
          <WizardCard title="KI-Vorschlag" hint="KI-Vorschlag starten, dann prüfen und korrigieren.">
            <div className="summary-box info">
              <strong>KI-Vorschlag – bitte prüfen</strong>
              <span>Objektfoto und Typenschild helfen der KI. Ohne Netz oder ohne Sync kannst du normal weiterarbeiten.</span>
              {aiSuggestionMessage ? <span>{aiSuggestionMessage}</span> : null}
            </div>
            {aiSuggestion ? (
              <div className="summary-list">
                <span><b>Vorschlag</b>{aiSuggestion.object_type || "offen"}</span>
                <span><b>Typ/Spezifikation</b>{[aiSuggestion.specification, aiSuggestion.brand, aiSuggestion.model].filter(Boolean).join(" · ") || "offen"}</span>
                <span><b>KI-Schätzung</b>{aiSuggestion.estimated_age_years || aiSuggestion.value_estimate ? `${aiSuggestion.estimated_age_years ?? "Alter offen"} Jahre · ${aiSuggestion.value_estimate ?? "Wert offen"} €` : "offen"}</span>
              </div>
            ) : null}
            <button className="btn accent" type="button" disabled={busy || !hasObjectPhoto} onClick={() => void loadAiSuggestion()}>
              KI-Vorschlag holen
            </button>
            {!hasObjectPhoto ? <p className="muted">Zuerst Objektfoto aufnehmen.</p> : null}
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 4 ? (
          <WizardCard title="Bezeichnung erfassen" hint="Kurz eintragen oder KI-Vorschlag prüfen.">
            <label className="field">
              <span>Bezeichnung</span>
              <input value={form.object_type} onChange={(event) => update("object_type", event.target.value)} placeholder="z. B. Ölschlucker" />
            </label>
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 5 ? (
          <WizardCard title="Typ / Spezifikation" hint="Modell, Hersteller oder technische Daten erfassen.">
            <label className="field">
              <span>Typ / Spezifikation</span>
              <textarea rows={4} value={form.specification} onChange={(event) => update("specification", event.target.value)} placeholder="z. B. Hersteller, Modell, Größe, Traglast, technische Daten" />
            </label>
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 6 ? (
          <WizardCard title="Baujahr erfassen" hint="Eintragen, wenn bekannt. Sonst leer lassen.">
            <label className="field">
              <span>Baujahr</span>
              <input inputMode="numeric" value={form.construction_year} onChange={(event) => update("construction_year", event.target.value)} placeholder="z. B. 2018 oder unbekannt" />
            </label>
            {aiSuggestion?.estimated_age_years ? <p className="muted">KI-Schätzung: ca. {aiSuggestion.estimated_age_years} Jahre. Bitte nicht als gesichertes Baujahr übernehmen, wenn keine Quelle erkennbar ist.</p> : null}
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 7 ? (
          <WizardCard title="Zustand erfassen" hint="Sichtbaren Zustand auswählen.">
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
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("condition_detail")}>Zustandsfoto ergänzen</button>
            {photos.some((photo) => photo.type === "condition_detail") ? <PhotoPreviewList photos={photos.filter((photo) => photo.type === "condition_detail")} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 8 ? (
          <WizardCard title="Funktion i. O." hint="Funktion kurz bewerten.">
            <div className="choice-grid">
              {[
                ["ja", "Ja"],
                ["nein", "Nein"],
                ["nicht_geprueft", "Nicht geprüft"],
              ].map(([value, label]) => (
                <button key={value} className={form.function_ok === value ? "is-active" : ""} type="button" onClick={() => update("function_ok", value as FunctionOk)}>{label}</button>
              ))}
            </div>
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 9 ? (
          <WizardCard title="UVV / Prüffrist" hint="UVV-Siegel gut lesbar fotografieren.">
            <label className="field">
              <span>UVV Status</span>
              <select value={form.uvv_status} onChange={(event) => update("uvv_status", event.target.value as UvvStatus)}>
                <option value="vorhanden">UVV vorhanden</option>
                <option value="nicht_vorhanden">UVV nicht vorhanden</option>
                <option value="nicht_uvv_pflichtig">nicht UVV-pflichtig</option>
                <option value="unklar">unklar</option>
              </select>
            </label>
            <label className="field">
              <span>UVV gültig bis</span>
              <input type="date" value={form.uvv_valid_until} onChange={(event) => update("uvv_valid_until", event.target.value)} />
            </label>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("uvv_label")}>UVV-Siegel fotografieren</button>
            {photos.some((photo) => photo.type === "uvv_label") ? <PhotoPreviewList photos={photos.filter((photo) => photo.type === "uvv_label")} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 10 ? (
          <WizardCard title="Bemerkung / Diktat" hint="Bemerkung diktieren oder eingeben.">
            <label className="field">
              <span>Bemerkung</span>
              <textarea rows={5} value={form.remark} onChange={(event) => update("remark", event.target.value)} placeholder="z. B. Standortdetail, Zubehör, auffällige Schäden, Nutzerhinweis" />
            </label>
          </WizardCard>
        ) : null}

        {canCaptureInThisSession && !savedItem && step === 11 ? (
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
              {summaryBlockers.length ? "Entwurf lokal speichern" : "Objekt speichern"}
            </button>
            <button className="btn secondary" type="button" onClick={() => setStep(0)}>Zurück bearbeiten</button>
          </WizardCard>
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
  discardConfirm,
  setDiscardConfirm,
  discardOpenQueue,
}: {
  queueDetails: QueueDetails;
  joinedSessionId?: string;
  discardConfirm: string;
  setDiscardConfirm: (value: string) => void;
  discardOpenQueue: () => void;
}) {
  return (
    <div className="queue-detail-list">
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
