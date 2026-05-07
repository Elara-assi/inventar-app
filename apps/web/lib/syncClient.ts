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
    return "Upload hat zu lange gedauert. Bitte Verbindung prüfen und erneut synchronisieren.";
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
  const form = new FormData();
  const fileName = item.file_name || `${item.client_photo_id}.jpg`;
  const file = new File([item.photo_blob], fileName, { type: item.file_type || item.photo_blob.type || "image/jpeg" });
  form.append("file", file);
  const params = new URLSearchParams({
    photo_type: item.photo_type,
    client_photo_id: item.client_photo_id,
    source_device_id: item.device_id,
  });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45_000);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/items/${serverItemId}/photos?${params.toString()}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
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
  return draft?.server_item_id;
}

export async function syncPendingItems(): Promise<SyncResult> {
  if (!getOnlineStatus()) return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
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
  if (!getOnlineStatus()) return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
  let synced = 0;
  let failed = 0;
  const allItems = await listQueueItems();
  const photos = allItems.filter(
    (item) => item.type === "photo_upload" && (item.status === "pending" || item.status === "failed" || item.status === "uploading"),
  );
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
      });
      continue;
    }
    try {
      await updateQueueStatus(photo.id, "uploading", { server_item_id: serverItemId, last_error: undefined });
      await uploadPhoto(photo, serverItemId);
      await updateQueueStatus(photo.id, "synced", { server_item_id: serverItemId, last_error: undefined });
      api(`/items/${serverItemId}/ai/run`, { method: "POST", body: "{}" }).catch(() => undefined);
      synced += 1;
    } catch (error) {
      await updateQueueStatus(photo.id, isPermanentQueueError(error) ? "conflict" : "failed", { server_item_id: serverItemId, last_error: cleanError(error) });
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
  if (!getOnlineStatus()) return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
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
