import { API_BASE, api } from "@/lib/api";
import {
  QueueItem,
  clearOnlySyncedItems,
  getQueueSummary,
  listQueueItems,
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

function cleanError() {
  return "Upload fehlgeschlagen. Bitte Verbindung prüfen und erneut synchronisieren.";
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
  const response = await fetch(`${API_BASE}/items/${serverItemId}/photos?${params.toString()}`, {
    method: "POST",
    body: form,
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
    } catch {
      await updateQueueStatus(item.id, "failed", { last_error: cleanError() });
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
    (item) => item.type === "photo_upload" && (item.status === "pending" || item.status === "failed"),
  );
  for (const photo of photos) {
    const serverItemId = await findServerItemId(photo, await listQueueItems());
    if (!serverItemId) continue;
    try {
      await updateQueueStatus(photo.id, "uploading", { server_item_id: serverItemId, last_error: undefined });
      await uploadPhoto(photo, serverItemId);
      await updateQueueStatus(photo.id, "synced", { server_item_id: serverItemId, last_error: undefined });
      api(`/items/${serverItemId}/ai/run`, { method: "POST", body: "{}" }).catch(() => undefined);
      synced += 1;
    } catch {
      await updateQueueStatus(photo.id, "failed", { server_item_id: serverItemId, last_error: cleanError() });
      failed += 1;
    }
  }
  return { synced, failed, open: (await getQueueSummary()).open };
}

export async function retryFailed(): Promise<SyncResult> {
  const failedItems = (await listQueueItems()).filter((item) => item.status === "failed");
  await Promise.all(failedItems.map((item) => updateQueueStatus(item.id, "pending", { last_error: undefined })));
  return syncNow();
}

export async function syncNow(): Promise<SyncResult> {
  if (syncRunning) return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
  if (!getOnlineStatus()) return { synced: 0, failed: 0, open: (await getQueueSummary()).open };
  syncRunning = true;
  try {
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
