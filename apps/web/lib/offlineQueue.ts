export type QueueStatus = "pending" | "uploading" | "synced" | "failed" | "conflict";
export type QueueItemType = "item_draft" | "photo_upload";

export type ItemDraftQueueData = Record<string, unknown>;

export type QueueItem = {
  id: string;
  type: QueueItemType;
  status: QueueStatus;
  session_id: string;
  device_id: string;
  client_item_id: string;
  client_photo_id?: string;
  server_item_id?: string;
  photo_type?: string;
  photo_blob?: Blob;
  file_name?: string;
  file_type?: string;
  file_size?: number;
  draft?: ItemDraftQueueData;
  created_at: string;
  updated_at: string;
  retry_count: number;
  last_error?: string;
};

export type QueueSummary = {
  total: number;
  pending: number;
  uploading: number;
  synced: number;
  failed: number;
  conflict: number;
  open: number;
  pendingPhotos: number;
  failedPhotos: number;
  lastError?: string;
};

const DB_NAME = "inventar-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "queue_items";
const DEVICE_KEY = "inventar.device_id";

let dbPromise: Promise<IDBDatabase> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function createLocalId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function browserOnly() {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

export function initQueue(): Promise<IDBDatabase> {
  if (!browserOnly()) return Promise.reject(new Error("IndexedDB ist nicht verfügbar"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store) return;
      if (!store.indexNames.contains("status")) store.createIndex("status", "status");
      if (!store.indexNames.contains("type")) store.createIndex("type", "type");
      if (!store.indexNames.contains("session_id")) store.createIndex("session_id", "session_id");
      if (!store.indexNames.contains("client_item_id")) store.createIndex("client_item_id", "client_item_id");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB konnte nicht geöffnet werden"));
  });
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await initQueue();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let request: IDBRequest<T> | void;
    transaction.oncomplete = () => resolve((request as IDBRequest<T> | undefined)?.result as T);
    transaction.onerror = () => reject(transaction.error ?? new Error("Queue-Transaktion fehlgeschlagen"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Queue-Transaktion abgebrochen"));
    request = callback(store);
  });
}

export async function getOrCreateDeviceId(): Promise<string> {
  if (typeof window === "undefined") return createLocalId("device");
  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = createLocalId("device");
  window.localStorage.setItem(DEVICE_KEY, created);
  return created;
}

export async function enqueueItemDraft(input: {
  session_id: string;
  device_id: string;
  client_item_id?: string;
  draft: ItemDraftQueueData;
}): Promise<QueueItem> {
  const existing = input.client_item_id
    ? (await listQueueItems()).find((item) => item.type === "item_draft" && item.client_item_id === input.client_item_id)
    : undefined;
  const item: QueueItem = {
    id: existing?.id ?? createLocalId("queue-item"),
    type: "item_draft",
    status: existing?.status === "synced" ? "pending" : existing?.status ?? "pending",
    session_id: input.session_id,
    device_id: input.device_id,
    client_item_id: input.client_item_id ?? createLocalId("client-item"),
    server_item_id: existing?.server_item_id,
    draft: input.draft,
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
    retry_count: existing?.retry_count ?? 0,
    last_error: undefined,
  };
  await withStore("readwrite", (store) => store.put(item));
  return item;
}

export async function enqueuePhotoUpload(input: {
  session_id: string;
  device_id: string;
  client_item_id: string;
  server_item_id?: string;
  photo_type: string;
  photo_blob: Blob;
  file_name: string;
  file_type: string;
  file_size: number;
  client_photo_id?: string;
}): Promise<QueueItem> {
  const item: QueueItem = {
    id: createLocalId("queue-photo"),
    type: "photo_upload",
    status: "pending",
    session_id: input.session_id,
    device_id: input.device_id,
    client_item_id: input.client_item_id,
    client_photo_id: input.client_photo_id ?? createLocalId("client-photo"),
    server_item_id: input.server_item_id,
    photo_type: input.photo_type,
    photo_blob: input.photo_blob,
    file_name: input.file_name,
    file_type: input.file_type,
    file_size: input.file_size,
    created_at: nowIso(),
    updated_at: nowIso(),
    retry_count: 0,
  };
  await withStore("readwrite", (store) => store.put(item));
  return item;
}

export async function listQueueItems(): Promise<QueueItem[]> {
  if (!browserOnly()) return [];
  const db = await initQueue();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as QueueItem[]).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    request.onerror = () => reject(request.error ?? new Error("Queue konnte nicht gelesen werden"));
  });
}

export async function updateQueueStatus(
  id: string,
  status: QueueStatus,
  patch: Partial<QueueItem> = {},
): Promise<QueueItem | null> {
  const current = (await listQueueItems()).find((item) => item.id === id);
  if (!current) return null;
  const next: QueueItem = {
    ...current,
    ...patch,
    status,
    updated_at: nowIso(),
    retry_count: status === "failed" ? current.retry_count + 1 : current.retry_count,
  };
  await withStore("readwrite", (store) => store.put(next));
  return next;
}

export async function removeSyncedQueueItem(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

export async function clearOnlySyncedItems(): Promise<void> {
  // Keep synced item drafts as a small client_id -> server_item_id map.
  // Synced photo blobs are the heavy data and can be removed safely.
  const synced = (await listQueueItems()).filter((item) => item.type === "photo_upload" && item.status === "synced");
  await Promise.all(synced.map((item) => removeSyncedQueueItem(item.id)));
}

export async function recoverInterruptedUploads(): Promise<void> {
  const interrupted = (await listQueueItems()).filter((item) => item.status === "uploading");
  await Promise.all(interrupted.map((item) => updateQueueStatus(item.id, "pending", {
    last_error: "Synchronisierung wurde unterbrochen und wird erneut versucht.",
  })));
}

export async function getQueueSummary(): Promise<QueueSummary> {
  const items = await listQueueItems();
  const lastFailed = items
    .filter((item) => item.status === "failed" && item.last_error)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const summary: QueueSummary = {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    uploading: items.filter((item) => item.status === "uploading").length,
    synced: items.filter((item) => item.status === "synced").length,
    failed: items.filter((item) => item.status === "failed").length,
    conflict: items.filter((item) => item.status === "conflict").length,
    open: items.filter((item) => item.status !== "synced").length,
    pendingPhotos: items.filter((item) => item.type === "photo_upload" && item.status !== "synced").length,
    failedPhotos: items.filter((item) => item.type === "photo_upload" && item.status === "failed").length,
    lastError: lastFailed?.last_error,
  };
  return summary;
}

export function createClientItemId() {
  return createLocalId("client-item");
}

export function createClientPhotoId() {
  return createLocalId("client-photo");
}
