export type QueueStatus = "pending" | "uploading" | "unknown_ack" | "repairing" | "synced" | "failed" | "conflict" | "discard_pending" | "discarded";
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
  server_photo_id?: string;
  photo_type?: string;
  photo_blob?: Blob;
  file_name?: string;
  file_type?: string;
  file_size?: number;
  sequence_number?: number;
  upload_started_at?: string;
  upload_url?: string;
  upload_debug_state?: string;
  sync_run_id?: string;
  sync_checked_at?: string;
  health_checked?: boolean;
  health_result?: string;
  eligible_for_upload?: boolean;
  skip_reason?: string;
  fetch_started?: boolean;
  upload_response_status?: number;
  upload_response_text?: string;
  upload_debug?: string;
  sync_receipt?: Record<string, unknown>;
  discard_reason?: string;
  discarded_at?: string;
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
  unknownAck: number;
  synced: number;
  failed: number;
  conflict: number;
  repairing: number;
  discardPending: number;
  discarded: number;
  open: number;
  pendingPhotos: number;
  failedPhotos: number;
  lastError?: string;
};

export type QueueDetails = {
  openItems: QueueItem[];
  currentSessionItems: QueueItem[];
  otherSessionItems: QueueItem[];
  sessions: Array<{
    session_id: string;
    total: number;
    open: number;
    objects: number;
    photos: number;
    failed: number;
    conflict: number;
    discardPending: number;
    discarded: number;
    latest_at: string;
  }>;
};

export type QueueRepairResult = {
  repaired: number;
  isolated: number;
  discarded: number;
  currentSessionOpen: number;
  reason?: string;
  isolatedItems: Array<{
    id: string;
    type: QueueItemType;
    session_id: string;
    client_item_id: string;
    client_photo_id?: string;
    reason: string;
  }>;
};

const DB_NAME = "inventar-offline-queue";
const DB_VERSION = 3;
const STORE_NAME = "queue_items";
const META_STORE_NAME = "queue_meta";
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

function isOpenStatus(status: QueueStatus) {
  return status !== "synced" && status !== "discard_pending" && status !== "discarded";
}

function compactTombstone(item: QueueItem, status: "discard_pending" | "discarded", reason: string): QueueItem {
  const next: QueueItem = {
    ...item,
    status,
    updated_at: nowIso(),
    discarded_at: status === "discarded" ? nowIso() : item.discarded_at,
    discard_reason: reason,
    last_error: reason,
    upload_debug_state: status,
    upload_debug: "Lokaler Queue-Eintrag wurde isoliert; schwere Foto-Daten wurden entfernt.",
    eligible_for_upload: false,
    fetch_started: false,
  };
  delete next.photo_blob;
  return next;
}

export function initQueue(): Promise<IDBDatabase> {
  if (!browserOnly()) return Promise.reject(new Error("IndexedDB ist nicht verfügbar"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      dbPromise = null;
      reject(new Error("Lokale Speicherung ist blockiert. Bitte alte Inventar-Tabs schliessen und die Seite neu laden."));
    }, 4_000);
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
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      request.result.onversionchange = () => {
        request.result.close();
        dbPromise = null;
      };
      resolve(request.result);
    };
    request.onblocked = () => {
      // Safari can keep an older tab's IndexedDB connection alive. The timeout
      // above prevents the mobile join flow from waiting forever.
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      dbPromise = null;
      reject(request.error ?? new Error("IndexedDB konnte nicht geöffnet werden"));
    };
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
  sequence_number?: number;
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
    sequence_number: input.sequence_number ?? existing?.sequence_number ?? (typeof input.draft.sequence_number === "number" ? input.draft.sequence_number : undefined),
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
  sequence_number?: number;
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
    sequence_number: input.sequence_number,
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

export async function listOpenQueueItems(): Promise<QueueItem[]> {
  return (await listQueueItems()).filter((item) => isOpenStatus(item.status));
}

export async function listQueueItemsBySession(sessionId: string): Promise<QueueItem[]> {
  return (await listQueueItems()).filter((item) => item.session_id === sessionId);
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
    retry_count: status === "failed" || status === "unknown_ack" ? current.retry_count + 1 : current.retry_count,
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

export async function recoverInterruptedUploads(sessionId?: string | null): Promise<void> {
  await markUploadingAsPending(sessionId);
}

export async function markUploadingAsPending(sessionId?: string | null): Promise<void> {
  const interrupted = (await listQueueItems()).filter((item) => item.status === "uploading" && (!sessionId || item.session_id === sessionId));
  await Promise.all(interrupted.map((item) => updateQueueStatus(item.id, "unknown_ack", {
    last_error: "Synchronisierung wurde unterbrochen. Server-Quittung wird vor erneutem Upload geprueft.",
    upload_debug_state: "unknown_ack_recovery",
  })));
}

export async function markFailedAsPending(sessionId?: string | null): Promise<void> {
  const failed = (await listQueueItems()).filter((item) => item.status === "failed" && (!sessionId || item.session_id === sessionId));
  await Promise.all(failed.map((item) => updateQueueStatus(item.id, "pending", {
    last_error: undefined,
    eligible_for_upload: undefined,
    skip_reason: undefined,
    fetch_started: false,
    upload_response_status: undefined,
    upload_response_text: undefined,
    upload_debug_state: "retry_pending",
    upload_debug: "Fehler wurde für erneuten Versuch zurückgesetzt.",
  })));
}

export async function discardQueueItems(ids?: string[]): Promise<void> {
  const items = ids?.length ? (await listQueueItems()).filter((item) => ids.includes(item.id)) : await listOpenQueueItems();
  await Promise.all(items.map((item) => withStore("readwrite", (store) => store.put(compactTombstone(item, "discarded", "Lokale Daten wurden bewusst verworfen.")))));
}

async function putQueueItem(item: QueueItem): Promise<void> {
  await withStore("readwrite", (store) => store.put(item));
}

export async function finalizeDiscardPendingQueueItems(ids?: string[]): Promise<number> {
  const items = (await listQueueItems()).filter((item) => item.status === "discard_pending" && (!ids?.length || ids.includes(item.id)));
  await Promise.all(items.map((item) => putQueueItem(compactTombstone(item, "discarded", item.discard_reason || "Alter Queue-Eintrag wurde bereinigt."))));
  return items.length;
}

export async function repairQueueForSession(currentSessionId?: string | null): Promise<QueueRepairResult> {
  if (!currentSessionId) {
    return { repaired: 0, isolated: 0, discarded: 0, currentSessionOpen: 0, isolatedItems: [] };
  }
  const items = await listQueueItems();
  let repaired = 0;
  let isolated = 0;
  let discarded = 0;
  const isolatedItems: QueueRepairResult["isolatedItems"] = [];

  for (const item of items) {
    if (item.status === "synced" || item.status === "discarded") continue;
    const isCurrentSession = item.session_id === currentSessionId;
    const missingIdentity = !item.session_id || !item.device_id || !item.client_item_id;
    const missingPhotoData = item.type === "photo_upload"
      && (!item.client_photo_id || !item.photo_type || !item.photo_blob || (item.photo_blob.size ?? item.file_size ?? 0) <= 0);
    const isForeignSession = Boolean(item.session_id) && !isCurrentSession;

    if (item.status === "repairing" && isCurrentSession && !missingIdentity && !missingPhotoData) {
      await updateQueueStatus(item.id, "pending", {
        last_error: undefined,
        upload_debug_state: "repair_requeued",
        upload_debug: "Queue-Reparatur hat den Eintrag wieder fuer Sync freigegeben.",
      });
      repaired += 1;
      continue;
    }

    if (item.status === "uploading" && isCurrentSession) {
      await updateQueueStatus(item.id, "unknown_ack", {
        last_error: "Synchronisierung wurde unterbrochen. Server-Quittung wird vor erneutem Upload geprueft.",
        upload_debug_state: "unknown_ack_recovery",
      });
      repaired += 1;
      continue;
    }

    if (isForeignSession || missingIdentity || missingPhotoData || item.status === "discard_pending") {
      const reason = isForeignSession
        ? "Alter lokaler Eintrag gehoert zu einer anderen Session und blockiert diese Erfassung nicht mehr."
        : missingIdentity
          ? "Lokaler Eintrag ist defekt: Session, Geraet oder Client-ID fehlt."
          : missingPhotoData
            ? "Lokales Foto ist defekt oder nicht mehr vollstaendig vorhanden."
            : item.discard_reason || "Alter Queue-Eintrag wartet auf Bereinigung.";
      await putQueueItem(compactTombstone(item, "discard_pending", reason));
      isolated += item.status === "discard_pending" ? 0 : 1;
      discarded += 1;
      isolatedItems.push({
        id: item.id,
        type: item.type,
        session_id: item.session_id,
        client_item_id: item.client_item_id,
        client_photo_id: item.client_photo_id,
        reason,
      });
    }
  }

  const currentSessionOpen = (await listOpenQueueItems()).filter((item) => item.session_id === currentSessionId).length;
  return { repaired, isolated, discarded, currentSessionOpen, isolatedItems };
}

export async function getQueueDetails(currentSessionId?: string | null): Promise<QueueDetails> {
  const openItems = await listOpenQueueItems();
  const currentSessionItems = currentSessionId ? openItems.filter((item) => item.session_id === currentSessionId) : [];
  const otherSessionItems = currentSessionId ? openItems.filter((item) => item.session_id !== currentSessionId) : openItems;
  const grouped = new Map<string, QueueItem[]>();
  for (const item of openItems) {
    const key = item.session_id || "unbekannt";
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const sessions = Array.from(grouped.entries()).map(([session_id, items]) => {
    const sortedDates = items.map((item) => item.updated_at).sort();
    return {
      session_id,
      total: items.length,
      open: items.filter((item) => item.status !== "synced").length,
      objects: items.filter((item) => item.type === "item_draft").length,
      photos: items.filter((item) => item.type === "photo_upload").length,
      failed: items.filter((item) => item.status === "failed").length,
      conflict: items.filter((item) => item.status === "conflict").length,
      discardPending: items.filter((item) => item.status === "discard_pending").length,
      discarded: items.filter((item) => item.status === "discarded").length,
      latest_at: sortedDates[sortedDates.length - 1] ?? "",
    };
  });
  return { openItems, currentSessionItems, otherSessionItems, sessions };
}

export async function getQueueSummary(currentSessionId?: string | null): Promise<QueueSummary> {
  const items = (await listQueueItems()).filter((item) => !currentSessionId || item.session_id === currentSessionId);
  const lastFailed = items
    .filter((item) => item.status === "failed" && item.last_error)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const summary: QueueSummary = {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    uploading: items.filter((item) => item.status === "uploading").length,
    unknownAck: items.filter((item) => item.status === "unknown_ack").length,
    synced: items.filter((item) => item.status === "synced").length,
    failed: items.filter((item) => item.status === "failed").length,
    conflict: items.filter((item) => item.status === "conflict").length,
    repairing: items.filter((item) => item.status === "repairing").length,
    discardPending: items.filter((item) => item.status === "discard_pending").length,
    discarded: items.filter((item) => item.status === "discarded").length,
    open: items.filter((item) => isOpenStatus(item.status)).length,
    pendingPhotos: items.filter((item) => item.type === "photo_upload" && isOpenStatus(item.status)).length,
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

export function queueSchemaVersion() {
  return DB_VERSION;
}

export async function nextLocalSequenceNumber(sessionId: string): Promise<number> {
  const existingNumbers = (await listQueueItems())
    .filter((item) => item.session_id === sessionId && item.type === "item_draft")
    .map((item) => item.sequence_number ?? (typeof item.draft?.sequence_number === "number" ? item.draft.sequence_number : undefined))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return existingNumbers.length ? Math.max(...existingNumbers) + 1 : 1;
}
