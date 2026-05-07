import { API_BASE, api } from "@/lib/api";
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

let syncRunning = false;

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
  if (error instanceof Error && error.name === "AbortError") {
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
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
  const file = new File([item.photo_blob], fileName, { type: item.file_type || item.photo_blob.type || "image/jpeg" });
  form.append("file", file);
  const url = photoUploadUrl(item, serverItemId);
  console.warn("[inventar-sync] POST Foto startet", {
    url,
    ...describePhotoForLog(item, serverItemId),
  });
  const response = await fetchWithTimeout(url, { method: "POST", body: form }, 45_000);
  console.warn("[inventar-sync] POST Foto Antwort", {
    response_status: response.status,
    ok: response.ok,
    ...describePhotoForLog(item, serverItemId),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<{ id: string }>;
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
  const allItems = await listQueueItems();
  const photos = allItems.filter(
    (item) => item.type === "photo_upload" && (item.status === "pending" || item.status === "failed" || item.status === "uploading"),
  );
  console.warn("[inventar-sync] Foto-Sync startet", { count: photos.length, online_hint: getOnlineStatus() });
  if (photos.length) {
    try {
      const health = await assertApiHealth();
      await Promise.all(photos.map((photo) => updateQueueStatus(photo.id, photo.status, {
        upload_debug_state: "api_health_ok",
        upload_debug: `API erreichbar: ${health.url}`,
      })));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Promise.all(photos.map((photo) => updateQueueStatus(photo.id, "failed", {
        last_error: message,
        upload_debug_state: "api_health_failed",
        upload_debug: "Foto-Upload wurde nicht gestartet, weil die API nicht erreichbar war.",
      })));
      return { synced, failed: photos.length, open: (await getQueueSummary()).open };
    }
  }
  for (const photo of photos) {
    const currentItems = await listQueueItems();
    const serverItemId = await findServerItemId(photo, currentItems);
    if (!serverItemId) {
      const linkedDraft = currentItems.find((entry) => entry.type === "item_draft" && entry.client_item_id === photo.client_item_id);
      const isUnrecoverable = !linkedDraft || linkedDraft.status === "failed" || linkedDraft.status === "conflict";
      await updateQueueStatus(photo.id, isUnrecoverable ? "conflict" : "pending", {
        last_error: isUnrecoverable
          ? "Kein gültiges Server-Objekt für dieses Foto gefunden. Bitte Details prüfen oder lokale Daten bewusst verwerfen."
          : "Objekt ist noch nicht vollständig synchronisiert. Foto bleibt lokal gespeichert.",
        upload_debug_state: "guard_no_target_item",
        upload_debug: "Upload wurde nicht gestartet: Zielobjekt-ID fehlt.",
      });
      console.warn("[inventar-sync] Foto wird übersprungen: Zielobjekt fehlt", describePhotoForLog(photo));
      continue;
    }
    if (!photo.photo_blob) {
      await updateQueueStatus(photo.id, "conflict", {
        server_item_id: serverItemId,
        last_error: "Upload wurde nicht gestartet: Lokales Foto fehlt.",
        upload_debug_state: "guard_missing_blob",
        upload_debug: "Blob fehlt im lokalen Fotoeintrag.",
      });
      console.warn("[inventar-sync] Foto wird übersprungen: Blob fehlt", describePhotoForLog(photo, serverItemId));
      continue;
    }
    if (!photo.client_photo_id || !photo.photo_type) {
      await updateQueueStatus(photo.id, "conflict", {
        server_item_id: serverItemId,
        last_error: "Upload wurde nicht gestartet: Fotoart oder lokale Foto-ID fehlt.",
        upload_debug_state: "guard_missing_metadata",
        upload_debug: "client_photo_id oder photo_type fehlt im lokalen Fotoeintrag.",
      });
      console.warn("[inventar-sync] Foto wird übersprungen: Metadaten fehlen", describePhotoForLog(photo, serverItemId));
      continue;
    }
    try {
      await updateQueueStatus(photo.id, "uploading", {
        server_item_id: serverItemId,
        last_error: undefined,
        upload_started_at: new Date().toISOString(),
        upload_url: photoUploadUrl(photo, serverItemId),
        upload_debug_state: "fetch_starting",
        upload_response_status: undefined,
        upload_response_text: undefined,
        upload_debug: `Upload gestartet: ${photo.photo_blob.size} Byte, ${photo.photo_blob.type || photo.file_type || "unbekannter Typ"}.`,
      });
      const uploaded = await uploadPhoto(photo, serverItemId);
      await updateQueueStatus(photo.id, "synced", {
        server_item_id: serverItemId,
        last_error: undefined,
        upload_response_status: 200,
        upload_response_text: uploaded?.id ? `Foto gespeichert: ${uploaded.id}` : "Foto gespeichert.",
        upload_debug_state: "response_received",
        upload_debug: "Upload erfolgreich abgeschlossen.",
      });
      api(`/items/${serverItemId}/ai/run`, { method: "POST", body: "{}" }).catch(() => undefined);
      synced += 1;
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      console.error("[inventar-sync] Foto-Upload fehlgeschlagen", {
        ...describePhotoForLog(photo, serverItemId),
        error: rawError,
      });
      await updateQueueStatus(photo.id, isPermanentQueueError(error) ? "conflict" : "failed", {
        server_item_id: serverItemId,
        last_error: cleanError(error),
        upload_debug_state: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? "timeout" : "fetch_error",
        upload_response_status: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError") ? 0 : undefined,
        upload_response_text: rawError.slice(0, 500),
        upload_debug: error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
          ? "Keine Serverantwort nach 45 Sekunden."
          : "Upload wurde gestartet, aber nicht erfolgreich abgeschlossen.",
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
  if (syncRunning) return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
  syncRunning = true;
  try {
    await recoverInterruptedUploads();
    const items = await syncPendingItems();
    const photos = await syncPendingPhotos();
    const summary = await getQueueSummary();
    const synced = items.synced + photos.synced;
    if (synced > 0) {
      const serverItems = (await listQueueItems()).filter((item) => item.type === "item_draft" && item.server_item_id);
      await Promise.all(
        serverItems.map((item) => api(`/items/${item.server_item_id}/ai/run?mode=review`, { method: "POST", body: "{}" }).catch(() => undefined)),
      );
      await clearOnlySyncedItems();
    }
    return { synced, failed: items.failed + photos.failed, open: summary.open };
  } finally {
    syncRunning = false;
  }
}
