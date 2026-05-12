import { API_BASE, api, getAuthToken } from "@/lib/api";
import {
  QueueItem,
  clearOnlySyncedItems,
  getQueueSummary,
  listQueueItems,
  markFailedAsPending,
  recoverInterruptedUploads,
  updateQueueStatus,
} from "@/lib/offlineQueue";

type SyncResult = {
  synced: number;
  failed: number;
  open: number;
};

type BundlePhotoResult = {
  client_photo_id: string;
  photo_type?: string;
  status: "synced" | "already_exists" | "failed";
  server_photo_id?: string;
  error?: string;
};

type BundleSyncResponse = {
  server_item_id: string;
  client_item_id: string;
  created_or_updated: "created" | "updated";
  photo_results: BundlePhotoResult[];
};

type PhotoReceiptResponse = {
  server_item_id: string;
  server_photo_id: string;
  client_item_id: string;
  client_photo_id: string;
  photo_type?: string;
  status: "synced" | "already_exists";
};

type FormUploadResponse = {
  ok: boolean;
  status: number;
  text: string;
  transport: "xhr" | "fetch";
};

let syncRunning = false;
let syncRunningStartedAt = 0;
const SYNC_LOCK_STALE_MS = 60_000;

class SyncTimeoutError extends Error {
  constructor(message = "Keine Serverantwort nach 45 Sekunden.") {
    super(message);
    this.name = "TimeoutError";
  }
}

export function getOnlineStatus() {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function limitConcurrentUploads() {
  return 1;
}

function cleanError(error?: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Session not found") || message.includes("Item not found") || message.includes("Raum ist abgeschlossen")) {
    return "Die ursprüngliche Session oder das Objekt ist nicht mehr verfügbar. Bitte Details prüfen oder lokale Daten bewusst verwerfen.";
  }
  if (error instanceof Error && error.message.includes("Maximal 5 Fotos")) {
    return "Maximal 5 Fotos pro Gegenstand möglich.";
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "Keine Serverantwort nach 45 Sekunden. Bitte Verbindung prüfen und erneut synchronisieren.";
  }
  return "Upload fehlgeschlagen. Bitte Verbindung prüfen und erneut synchronisieren.";
}

function isPermanentQueueError(error?: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("Session not found")
    || message.includes("Item not found")
    || message.includes("Raum ist abgeschlossen")
    || message.includes("Join token invalid");
}

function describePhotoForLog(item: QueueItem, serverItemId?: string) {
  return {
    queue_id: item.id,
    client_item_id: item.client_item_id,
    client_photo_id: item.client_photo_id,
    server_item_id: serverItemId ?? item.server_item_id,
    session_id: item.session_id,
    photo_type: item.photo_type,
    status: item.status,
    sequence_number: item.sequence_number,
    blob_present: Boolean(item.photo_blob),
    blob_size: item.photo_blob?.size ?? item.file_size ?? 0,
    blob_type: item.photo_blob?.type || item.file_type || "",
  };
}

function photoUploadUrl(item: QueueItem, serverItemId: string) {
  const params = new URLSearchParams({
    photo_type: item.photo_type ?? "object_front",
    client_photo_id: item.client_photo_id ?? "",
    source_device_id: item.device_id,
  });
  return `${API_BASE}/items/${serverItemId}/photos?${params.toString()}`;
}

function bundleUploadUrl() {
  return `${API_BASE}/offline-sync/items`;
}

function photoReceiptUploadUrl() {
  return `${API_BASE}/offline-sync/photos`;
}

function createSyncRunId() {
  return `sync-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function photoCandidates(items: QueueItem[]) {
  return items.filter(
    (item) => item.type === "photo_upload" && (item.status === "pending" || item.status === "failed" || item.status === "uploading"),
  );
}

function photoSkipReason(photo: QueueItem, serverItemId?: string) {
  if (photo.status === "conflict") return "Foto ist als Konflikt markiert und wird nicht automatisch hochgeladen.";
  if (photo.status === "synced") return "Foto ist bereits synchronisiert.";
  if (!serverItemId) return "Foto-Upload übersprungen: Zielobjekt-ID fehlt.";
  if (!photo.photo_blob) return "Foto-Upload übersprungen: lokales Foto/Blob fehlt.";
  if ((photo.photo_blob.size ?? photo.file_size ?? 0) <= 0) return "Foto-Upload übersprungen: Blob-Größe ist 0 Byte.";
  if (!photo.client_photo_id) return "Foto-Upload übersprungen: lokale Foto-ID fehlt.";
  if (!photo.photo_type) return "Foto-Upload übersprungen: Fotoart fehlt.";
  if (photo.status !== "pending" && photo.status !== "failed" && photo.status !== "uploading") {
    return `Foto-Upload übersprungen: Status ${photo.status} ist nicht uploadfähig.`;
  }
  return "";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const headers = new Headers(init.headers);
  const token = getAuthToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let settled = false;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    window.setTimeout(() => {
      if (settled) return;
      controller.abort();
      reject(new SyncTimeoutError());
    }, timeoutMs);
  });
  const fetchPromise = fetch(url, {
    ...init,
    headers,
    signal: controller.signal,
  });
  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    settled = true;
  }
}

async function postFormDataWithTimeout(url: string, form: FormData, timeoutMs: number): Promise<FormUploadResponse> {
  const token = getAuthToken();
  if (typeof XMLHttpRequest !== "undefined") {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.timeout = timeoutMs;
      if (token) {
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      }
      xhr.onload = () => resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: typeof xhr.responseText === "string" ? xhr.responseText : "",
        transport: "xhr",
      });
      xhr.onerror = () => reject(new Error("Load failed"));
      xhr.ontimeout = () => reject(new SyncTimeoutError());
      xhr.onabort = () => reject(new SyncTimeoutError("Upload wurde abgebrochen."));
      try {
        xhr.send(form);
      } catch (error) {
        reject(error);
      }
    });
  }
  const response = await fetchWithTimeout(url, { method: "POST", body: form }, timeoutMs);
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
    transport: "fetch",
  };
}

async function clonePhotoBlobForUpload(item: QueueItem): Promise<Blob> {
  if (!item.photo_blob) {
    throw new Error("Lokales Foto ist unvollstaendig");
  }
  const type = item.file_type || item.photo_blob.type || "image/jpeg";
  const data = await item.photo_blob.arrayBuffer();
  return new Blob([data], { type });
}

async function assertApiHealth() {
  const healthUrl = `${API_BASE}/health`;
  try {
    const response = await fetchWithTimeout(healthUrl, { method: "GET", cache: "no-store" }, 10_000);
    if (!response.ok) {
      throw new Error(`API Health HTTP ${response.status}`);
    }
    return { ok: true, url: healthUrl };
  } catch (error) {
    throw new Error(`API nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function postItemDraft(item: QueueItem) {
  const body = {
    ...(item.draft ?? {}),
    session_id: item.session_id,
    client_item_id: item.client_item_id,
    source_device_id: item.device_id,
  };
  return api<{ id: string; inventory_id?: string; temporary_id?: string }>("/items", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function patchItemDraft(serverItemId: string, item: QueueItem) {
  await api(`/items/${serverItemId}`, {
    method: "PATCH",
    body: JSON.stringify(item.draft ?? {}),
  });
}

async function uploadPhoto(item: QueueItem, serverItemId: string) {
  if (!item.photo_blob || !item.photo_type || !item.client_photo_id) {
    throw new Error("Lokales Foto ist unvollständig");
  }
  console.warn("[inventar-sync] Foto-Upload Request wird vorbereitet", describePhotoForLog(item, serverItemId));
  const form = new FormData();
  const fileName = item.file_name || `${item.client_photo_id}.jpg`;
  const blob = await clonePhotoBlobForUpload(item);
  form.append("file", blob, fileName);
  const url = photoUploadUrl(item, serverItemId);
  console.warn("[inventar-sync] POST Foto startet", {
    url,
    ...describePhotoForLog(item, serverItemId),
  });
  const response = await postFormDataWithTimeout(url, form, 45_000);
  console.warn("[inventar-sync] POST Foto Antwort", {
    response_status: response.status,
    ok: response.ok,
    transport: response.transport,
    ...describePhotoForLog(item, serverItemId),
  });
  if (!response.ok) {
    throw new Error(response.text);
  }
  return JSON.parse(response.text) as { id: string };
}

async function uploadPhotoWithReceipt(item: QueueItem, syncRunId: string) {
  if (!item.photo_blob || !item.photo_type || !item.client_photo_id || !item.client_item_id || !item.session_id || !item.device_id) {
    throw new Error("Lokales Foto ist unvollständig");
  }
  const url = photoReceiptUploadUrl();
  const form = new FormData();
  const fileName = item.file_name || `${item.client_photo_id}.jpg`;
  const blob = await clonePhotoBlobForUpload(item);
  form.append("session_id", item.session_id);
  form.append("source_device_id", item.device_id);
  form.append("client_item_id", item.client_item_id);
  form.append("client_photo_id", item.client_photo_id);
  form.append("photo_type", item.photo_type);
  form.append("file", blob, fileName);
  await updateQueueStatus(item.id, "uploading", {
    sync_run_id: syncRunId,
    sync_checked_at: new Date().toISOString(),
    health_checked: true,
    health_result: "ok",
    eligible_for_upload: true,
    skip_reason: undefined,
    fetch_started: true,
    last_error: undefined,
    upload_started_at: new Date().toISOString(),
    upload_url: url,
    upload_debug_state: "photo_receipt_fetch_starting",
    upload_response_status: undefined,
    upload_response_text: undefined,
    upload_debug: `Foto-Sync gestartet: ${item.photo_blob.size} Byte, ${item.photo_blob.type || item.file_type || "unbekannter Typ"}.`,
  });
  const response = await postFormDataWithTimeout(url, form, 45_000);
  const responseText = response.text;
  if (!response.ok) {
    throw new Error(responseText || `Foto-Sync HTTP ${response.status}`);
  }
  try {
    return JSON.parse(responseText) as PhotoReceiptResponse;
  } catch (error) {
    throw new Error(`Foto-Sync Antwort ist kein JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function findServerItemId(item: QueueItem, allItems: QueueItem[]) {
  if (item.server_item_id) return item.server_item_id;
  const draft = allItems.find(
    (entry) => entry.type === "item_draft"
      && entry.client_item_id === item.client_item_id
      && entry.server_item_id,
  );
  if (draft?.server_item_id) return draft.server_item_id;
  if (!item.session_id || !item.device_id || !item.client_item_id) return undefined;
  try {
    const params = new URLSearchParams({
      session_id: item.session_id,
      source_device_id: item.device_id,
      client_item_id: item.client_item_id,
    });
    const resolved = await api<{ id: string }>(`/items/resolve-client?${params.toString()}`);
    return resolved.id;
  } catch (error) {
    console.warn("[inventar-sync] Server-Zuordnung konnte nicht aufgelöst werden", {
      ...describePhotoForLog(item),
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function openPhotoCandidates(items: QueueItem[]) {
  return items.filter(
    (item) => item.type === "photo_upload" && (item.status === "pending" || item.status === "failed" || item.status === "uploading"),
  );
}

function bundleCandidates(items: QueueItem[]) {
  const openPhotos = openPhotoCandidates(items);
  const byClientItemId = new Set(openPhotos.map((photo) => photo.client_item_id));
  return items.filter(
    (item) => item.type === "item_draft"
      && (
        item.status === "pending"
        || item.status === "failed"
        || item.status === "uploading"
        || byClientItemId.has(item.client_item_id)
      ),
  );
}

function buildBundlePayload(item: QueueItem, photos: QueueItem[]) {
  return {
    ...(item.draft ?? {}),
    session_id: item.session_id,
    source_device_id: item.device_id,
    client_item_id: item.client_item_id,
    inventory_type: String(item.draft?.inventory_type || "bga"),
    sequence_number: item.sequence_number,
    photos: photos.map((photo) => ({
      client_photo_id: photo.client_photo_id,
      photo_type: photo.photo_type || "object_front",
      filename: photo.file_name || `${photo.client_photo_id}.jpg`,
      mime_type: photo.file_type || photo.photo_blob?.type || "image/jpeg",
      size: photo.photo_blob?.size ?? photo.file_size ?? 0,
    })),
  };
}

async function postItemBundle(item: QueueItem, photos: QueueItem[], syncRunId: string) {
  const url = bundleUploadUrl();
  const form = new FormData();
  form.append("payload", JSON.stringify(buildBundlePayload(item, photos)));
  for (const photo of photos) {
    if (!photo.photo_blob || !photo.client_photo_id) continue;
    const blob = await clonePhotoBlobForUpload(photo);
    form.append("files", blob, photo.file_name || `${photo.client_photo_id}.jpg`);
  }
  await updateQueueStatus(item.id, "uploading", {
    sync_run_id: syncRunId,
    sync_checked_at: new Date().toISOString(),
    upload_url: url,
    upload_debug_state: "bundle_fetch_starting",
    upload_debug: `Paket-Sync gestartet: ${photos.length} Foto(s). Upload erfolgt Safari-robust per Multipart/XHR.`,
    last_error: undefined,
  });
  await Promise.all(photos.map((photo) => updateQueueStatus(photo.id, "uploading", {
    sync_run_id: syncRunId,
    sync_checked_at: new Date().toISOString(),
    health_checked: true,
    health_result: "ok",
    eligible_for_upload: true,
    fetch_started: true,
    upload_started_at: new Date().toISOString(),
    upload_url: url,
    upload_debug_state: "bundle_fetch_starting",
    upload_debug: `Paket-Sync gestartet: ${photo.photo_blob?.size ?? photo.file_size ?? 0} Byte, ${photo.photo_blob?.type || photo.file_type || "unbekannter Typ"}. Upload erfolgt Safari-robust per Multipart/XHR.`,
    last_error: undefined,
  })));
  const response = await postFormDataWithTimeout(url, form, 45_000);
  const responseText = response.text;
  if (!response.ok) {
    throw new Error(responseText || `Bundle Sync HTTP ${response.status}`);
  }
  try {
    return JSON.parse(responseText) as BundleSyncResponse;
  } catch (error) {
    throw new Error(`Bundle Sync Antwort ist kein JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function syncPendingBundles(): Promise<SyncResult> {
  let synced = 0;
  let failed = 0;
  const syncRunId = createSyncRunId();
  await recoverInterruptedUploads();
  const initialItems = await listQueueItems();
  const bundles = bundleCandidates(initialItems);
  const bundleIds = new Set(bundles.map((item) => item.client_item_id));
  const orphanPhotos = openPhotoCandidates(initialItems).filter((photo) => !bundleIds.has(photo.client_item_id));
  await Promise.all(orphanPhotos.map((photo) => updateQueueStatus(photo.id, photo.status, {
    sync_run_id: syncRunId,
    sync_checked_at: new Date().toISOString(),
    eligible_for_upload: undefined,
    skip_reason: "Foto wird ohne lokales Objektpaket über die Foto-Quittung synchronisiert.",
    fetch_started: false,
    last_error: undefined,
    upload_debug_state: "waiting_for_photo_receipt_sync",
    upload_debug: "Bundle-Sync überspringt dieses Foto; der Foto-Receipt-Sync versucht die Server-Zuordnung.",
  })));
  if (!bundles.length) {
    return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
  }
  let health: { ok: boolean; url: string };
  try {
    health = await assertApiHealth();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ids = new Set(bundles.map((item) => item.client_item_id));
    const affected = (await listQueueItems()).filter((item) => ids.has(item.client_item_id) && item.status !== "synced");
    await Promise.all(affected.map((entry) => updateQueueStatus(entry.id, "failed", {
      sync_run_id: syncRunId,
      sync_checked_at: new Date().toISOString(),
      health_checked: true,
      health_result: "failed",
      eligible_for_upload: false,
      skip_reason: "API Health fehlgeschlagen.",
      fetch_started: false,
      last_error: message,
      upload_debug_state: "api_health_failed",
      upload_debug: "Paket-Sync wurde nicht gestartet, weil die API nicht erreichbar war.",
    })));
    return { synced: 0, failed: affected.length, open: (await getQueueSummary()).open };
  }

  for (const bundle of bundles) {
    const latestItems = await listQueueItems();
    const latestBundle = latestItems.find((item) => item.id === bundle.id) ?? bundle;
    const linkedPhotos = openPhotoCandidates(latestItems).filter((photo) => photo.client_item_id === latestBundle.client_item_id);
    const uploadablePhotos = linkedPhotos.filter((photo) => photo.photo_blob && photo.client_photo_id);
    const missingPhotos = linkedPhotos.filter((photo) => !photo.photo_blob || !photo.client_photo_id);
    await Promise.all(missingPhotos.map((photo) => updateQueueStatus(photo.id, "conflict", {
      sync_run_id: syncRunId,
      sync_checked_at: new Date().toISOString(),
      health_checked: true,
      health_result: "ok",
      eligible_for_upload: false,
      skip_reason: !photo.photo_blob ? "Lokales Foto/Blob fehlt." : "Lokale Foto-ID fehlt.",
      fetch_started: false,
      last_error: !photo.photo_blob
        ? "Dieses Foto ist lokal nicht mehr vollstaendig vorhanden. Bitte Details pruefen oder lokale Daten bewusst verwerfen."
        : "Diesem Foto fehlt die lokale Foto-ID. Bitte Details pruefen oder lokale Daten bewusst verwerfen.",
      upload_debug_state: !photo.photo_blob ? "guard_missing_blob" : "guard_missing_metadata",
      upload_debug: "Paket-Sync fuer dieses Foto nicht moeglich.",
    })));
    try {
      await updateQueueStatus(latestBundle.id, latestBundle.status, {
        health_checked: true,
        health_result: "ok",
        upload_debug_state: "api_health_ok",
        upload_debug: `API erreichbar: ${health.url}`,
      });
      const result = await postItemBundle(latestBundle, uploadablePhotos, syncRunId);
      if (!result.server_item_id || !Array.isArray(result.photo_results)) {
        throw new Error("Bundle Sync Antwort ist unvollständig: server_item_id oder photo_results fehlen.");
      }
      await updateQueueStatus(latestBundle.id, "synced", {
        server_item_id: result.server_item_id,
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        fetch_started: true,
        upload_response_status: 200,
        upload_response_text: `${result.created_or_updated}: ${result.server_item_id}`,
        upload_debug_state: "response_received",
        upload_debug: "Objektpaket erfolgreich synchronisiert.",
        last_error: undefined,
      });
      const byClientPhotoId = new Map(result.photo_results.map((entry) => [entry.client_photo_id, entry]));
      for (const photo of uploadablePhotos) {
        const photoResult = photo.client_photo_id ? byClientPhotoId.get(photo.client_photo_id) : undefined;
        if (photoResult?.status === "synced" || photoResult?.status === "already_exists") {
          await updateQueueStatus(photo.id, "synced", {
            server_item_id: result.server_item_id,
            sync_run_id: syncRunId,
            sync_checked_at: new Date().toISOString(),
            health_checked: true,
            health_result: "ok",
            eligible_for_upload: true,
            fetch_started: true,
            upload_response_status: 200,
            upload_response_text: photoResult.status === "already_exists" ? "Foto war bereits gespeichert." : "Foto gespeichert.",
            upload_debug_state: "response_received",
            upload_debug: "Foto im Objektpaket erfolgreich synchronisiert.",
            last_error: undefined,
          });
          synced += 1;
        } else {
          await updateQueueStatus(photo.id, "failed", {
            server_item_id: result.server_item_id,
            sync_run_id: syncRunId,
            sync_checked_at: new Date().toISOString(),
            health_checked: true,
            health_result: "ok",
            eligible_for_upload: true,
            fetch_started: true,
            upload_response_status: 207,
            upload_response_text: photoResult?.error || "Foto wurde vom Server nicht bestaetigt.",
            upload_debug_state: "partial_failure",
            upload_debug: "Objekt ist gespeichert, dieses Foto bleibt fuer Retry lokal erhalten.",
            last_error: photoResult?.error || "Foto wurde vom Server nicht bestaetigt.",
          });
          failed += 1;
        }
      }
      synced += 1;
      api(`/items/${result.server_item_id}/ai/run?mode=review`, { method: "POST", body: "{}" }).catch(() => undefined);
    } catch (error) {
      const message = cleanError(error);
      const rawError = error instanceof Error ? error.message : String(error);
      await updateQueueStatus(latestBundle.id, isPermanentQueueError(error) ? "conflict" : "failed", {
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        fetch_started: true,
        last_error: message,
        upload_debug_state: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "timeout" : "fetch_error",
        upload_response_status: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? 0 : undefined,
        upload_response_text: rawError.slice(0, 500),
        upload_debug: "Objektpaket wurde gestartet, aber nicht erfolgreich abgeschlossen.",
      });
      await Promise.all(uploadablePhotos.map((photo) => updateQueueStatus(photo.id, isPermanentQueueError(error) ? "conflict" : "failed", {
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: true,
        fetch_started: true,
        last_error: message,
        upload_debug_state: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "timeout" : "fetch_error",
        upload_response_status: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? 0 : undefined,
        upload_response_text: rawError.slice(0, 500),
        upload_debug: "Paket-Sync wurde gestartet, aber nicht erfolgreich abgeschlossen.",
      })));
      failed += 1 + uploadablePhotos.length;
    }
  }
  return { synced, failed, open: (await getQueueSummary()).open };
}

async function recoverResolvablePhotoConflicts(): Promise<number> {
  const items = await listQueueItems();
  const conflictPhotos = items.filter(
    (item) => item.type === "photo_upload"
      && item.status === "conflict"
      && item.photo_blob
      && item.session_id
      && item.device_id
      && item.client_item_id
      && item.client_photo_id,
  );
  let recovered = 0;
  for (const photo of conflictPhotos) {
    const serverItemId = await findServerItemId(photo, items);
    if (!serverItemId) continue;
    await updateQueueStatus(photo.id, "pending", {
      server_item_id: serverItemId,
      eligible_for_upload: true,
      skip_reason: undefined,
      fetch_started: false,
      last_error: undefined,
      upload_debug_state: "photo_mapping_recovered",
      upload_debug: "Server-Objekt wurde gefunden. Foto wird erneut synchronisiert.",
    });
    recovered += 1;
  }
  return recovered;
}

export async function syncPendingItems(): Promise<SyncResult> {
  let synced = 0;
  let failed = 0;
  const items = (await listQueueItems()).filter(
    (item) => item.type === "item_draft" && (item.status === "pending" || item.status === "failed"),
  );
  for (const item of items) {
    try {
      await updateQueueStatus(item.id, "uploading", { last_error: undefined });
      const created = await postItemDraft(item);
      const latestItem = (await listQueueItems()).find((entry) => entry.id === item.id) ?? item;
      await patchItemDraft(created.id, latestItem);
      await updateQueueStatus(item.id, "synced", {
        server_item_id: created.id,
        last_error: undefined,
      });
      const linkedPhotos = (await listQueueItems()).filter((entry) => entry.client_item_id === item.client_item_id && entry.type === "photo_upload");
      await Promise.all(linkedPhotos.map((photo) => updateQueueStatus(photo.id, photo.status, { server_item_id: created.id })));
      synced += 1;
    } catch (error) {
      await updateQueueStatus(item.id, isPermanentQueueError(error) ? "conflict" : "failed", { last_error: cleanError(error) });
      failed += 1;
    }
  }
  return { synced, failed, open: (await getQueueSummary()).open };
}

export async function syncPendingPhotos(): Promise<SyncResult> {
  let synced = 0;
  let failed = 0;
  const syncRunId = createSyncRunId();
  await recoverInterruptedUploads();
  let photos = photoCandidates(await listQueueItems());
  if (!photos.length) {
    return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
  }

  try {
    const health = await assertApiHealth();
    await Promise.all(photos.map((photo) => updateQueueStatus(photo.id, photo.status, {
      sync_run_id: syncRunId,
      sync_checked_at: new Date().toISOString(),
      health_checked: true,
      health_result: "ok",
      eligible_for_upload: undefined,
      skip_reason: undefined,
      fetch_started: false,
      upload_debug_state: "api_health_ok",
      upload_debug: `API erreichbar: ${health.url}`,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all(photos.map((photo) => updateQueueStatus(photo.id, "failed", {
      sync_run_id: syncRunId,
      sync_checked_at: new Date().toISOString(),
      health_checked: true,
      health_result: "failed",
      eligible_for_upload: false,
      skip_reason: "API Health fehlgeschlagen.",
      fetch_started: false,
      last_error: message,
      upload_debug_state: "api_health_failed",
      upload_debug: "Foto-Sync wurde nicht gestartet, weil die API nicht erreichbar war.",
    })));
    return { synced: 0, failed: photos.length, open: (await getQueueSummary()).open };
  }

  photos = photoCandidates(await listQueueItems());
  for (const queuedPhoto of photos) {
    const currentItems = await listQueueItems();
    const photo = currentItems.find((entry) => entry.id === queuedPhoto.id) ?? queuedPhoto;
    const linkedDraft = currentItems.find((entry) => entry.type === "item_draft" && entry.client_item_id === photo.client_item_id);
    if (linkedDraft && linkedDraft.status !== "synced" && !linkedDraft.server_item_id) {
      const bundleFailed = linkedDraft.status === "failed" || linkedDraft.status === "conflict";
      await updateQueueStatus(photo.id, bundleFailed ? linkedDraft.status : "pending", {
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: false,
        skip_reason: bundleFailed ? "Objektpaket wurde nicht erfolgreich synchronisiert." : "Objekt wird zuerst synchronisiert.",
        fetch_started: photo.fetch_started,
        last_error: bundleFailed
          ? (linkedDraft.last_error || "Objektpaket fehlgeschlagen. Foto bleibt lokal gespeichert und wird beim naechsten Paket-Sync erneut versucht.")
          : "Objekt wird zuerst synchronisiert. Foto bleibt lokal gespeichert.",
        upload_debug_state: bundleFailed ? "bundle_failed_waiting_for_retry" : "waiting_for_item_receipt",
        upload_debug: bundleFailed
          ? "Foto wurde nicht einzeln hochgeladen, weil das Objektpaket keine Server-Quittung erhalten hat. Der naechste Sync sendet Objekt und Foto erneut gemeinsam."
          : "Foto-Sync wartet auf Server-Quittung des Objekts.",
        upload_response_text: bundleFailed ? linkedDraft.upload_response_text : photo.upload_response_text,
      });
      continue;
    }

    const missing: string[] = [];
    if (!photo.session_id) missing.push("session_id fehlt");
    if (!photo.device_id) missing.push("source_device_id fehlt");
    if (!photo.client_item_id) missing.push("client_item_id fehlt");
    if (!photo.client_photo_id) missing.push("client_photo_id fehlt");
    if (!photo.photo_type) missing.push("photo_type fehlt");
    if (!photo.photo_blob) missing.push("Foto-Blob fehlt");
    if ((photo.photo_blob?.size ?? photo.file_size ?? 0) <= 0) missing.push("Blob-Größe ist 0 Byte");
    if (missing.length) {
      const message = `Foto-Sync nicht möglich: ${missing.join(", ")}.`;
      await updateQueueStatus(photo.id, "conflict", {
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: false,
        skip_reason: message,
        fetch_started: false,
        last_error: message,
        upload_debug_state: "guard_missing_photo_receipt_data",
        upload_debug: message,
      });
      failed += 1;
      continue;
    }

    try {
      const result = await uploadPhotoWithReceipt(photo, syncRunId);
      if (result.status !== "synced" && result.status !== "already_exists") {
        throw new Error(`Foto-Sync nicht bestätigt: ${result.status}`);
      }
      await updateQueueStatus(photo.id, "synced", {
        server_item_id: result.server_item_id,
        server_photo_id: result.server_photo_id,
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: true,
        skip_reason: undefined,
        fetch_started: true,
        last_error: undefined,
        upload_response_status: 200,
        upload_response_text: result.status === "already_exists" ? "Foto war bereits gespeichert." : "Foto gespeichert.",
        upload_debug_state: "response_received",
        upload_debug: "Server-Quittung für dieses Foto erhalten.",
        sync_receipt: result as unknown as Record<string, unknown>,
      });
      if (linkedDraft && result.server_item_id && linkedDraft.server_item_id !== result.server_item_id) {
        await updateQueueStatus(linkedDraft.id, linkedDraft.status, { server_item_id: result.server_item_id });
      }
      api(`/items/${result.server_item_id}/ai/run?mode=review`, { method: "POST", body: "{}" }).catch(() => undefined);
      synced += 1;
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      const permanent = isPermanentQueueError(error) || rawError.includes("Objekt ist noch nicht synchronisiert") || rawError.includes("Session not found");
      await updateQueueStatus(photo.id, permanent ? "conflict" : "failed", {
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: true,
        skip_reason: undefined,
        fetch_started: true,
        last_error: cleanError(error),
        upload_debug_state: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "timeout" : "fetch_error",
        upload_response_status: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? 0 : undefined,
        upload_response_text: rawError.slice(0, 500),
        upload_debug: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
          ? "Keine Serverantwort nach 45 Sekunden."
          : "Foto-Sync wurde gestartet, aber nicht erfolgreich abgeschlossen.",
      });
      failed += 1;
    }
  }
  return { synced, failed, open: (await getQueueSummary()).open };
}
export async function retryFailed(): Promise<SyncResult> {
  await markFailedAsPending();
  return syncNow();
}

export async function syncNow(): Promise<SyncResult> {
  if (syncRunning) {
    if (syncRunningStartedAt && Date.now() - syncRunningStartedAt > SYNC_LOCK_STALE_MS) {
      syncRunning = false;
      syncRunningStartedAt = 0;
      await recoverInterruptedUploads();
    } else {
      return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
    }
  }
  syncRunning = true;
  syncRunningStartedAt = Date.now();
  try {
    await recoverInterruptedUploads();
    const bundles = await syncPendingBundles();
    if (bundles.synced > 0) {
      await clearOnlySyncedItems();
    }
    await recoverResolvablePhotoConflicts();
    const photos = await syncPendingPhotos();
    if (photos.synced > 0) {
      await clearOnlySyncedItems();
    }
    const summary = await getQueueSummary();
    return { synced: bundles.synced + photos.synced, failed: bundles.failed + photos.failed, open: summary.open };
  } finally {
    syncRunning = false;
    syncRunningStartedAt = 0;
  }
}
