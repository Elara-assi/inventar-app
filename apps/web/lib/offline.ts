/**
 * Offline-Fundament (O1/O2): IndexedDB-Layer.
 *
 * Prinzip "Lokal zuerst": Jede abgeschlossene Erfassung wird als
 * CaptureRecord atomar lokal gespeichert (< 100 ms, ohne Netz) und von der
 * Sync-Engine im Hintergrund uebertragen. App-Kill, Reload oder Funkloch
 * verlieren nie Daten; Teilfortschritt des Uploads steht im Record.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type CapturePhoto = { type: string; blob: Blob; name: string };

export type CaptureRecord = {
  clientCaptureId: string;
  sessionId: string;
  createdAt: number;
  state: "wartet" | "sync" | "quarantaene";
  error?: string;
  attempts: number;
  // Erfassungsdaten
  objectClassId: string | null;
  condition: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  inventoryId: string | null;
  manufacturingYear: number | null;
  transcript: string | null;
  audio: { blob: Blob; mime: string } | null;
  photos: CapturePhoto[];
  // Sync-Teilfortschritt (idempotent fortsetzbar)
  progress: { itemId: string | null; photosDone: string[]; audioDone: boolean };
  // Anzeige
  label: string;
};

export type CachedSession = {
  token: string;
  sessionId: string;
  deviceId: string;
  roomName: string;
  joinedAt: number;
};

type KvValue = unknown;

interface InventarDB extends DBSchema {
  outbox: { key: string; value: CaptureRecord; indexes: { byCreated: number } };
  kv: { key: string; value: KvValue };
}

let dbPromise: Promise<IDBPDatabase<InventarDB>> | null = null;

function db(): Promise<IDBPDatabase<InventarDB>> {
  if (!dbPromise) {
    dbPromise = openDB<InventarDB>("inventar-offline", 1, {
      upgrade(database) {
        const outbox = database.createObjectStore("outbox", { keyPath: "clientCaptureId" });
        outbox.createIndex("byCreated", "createdAt");
        database.createObjectStore("kv");
      },
    });
  }
  return dbPromise;
}

// ---- Outbox -----------------------------------------------------------------

export async function outboxAdd(record: CaptureRecord): Promise<void> {
  await (await db()).put("outbox", record);
  notify();
}

export async function outboxAll(): Promise<CaptureRecord[]> {
  return (await db()).getAllFromIndex("outbox", "byCreated");
}

export async function outboxCount(): Promise<number> {
  return (await db()).count("outbox");
}

export async function outboxUpdate(record: CaptureRecord): Promise<void> {
  await (await db()).put("outbox", record);
  notify();
}

export async function outboxRemove(clientCaptureId: string): Promise<void> {
  await (await db()).delete("outbox", clientCaptureId);
  notify();
}

// ---- Key-Value (Stammdaten-/Session-Cache, Zaehler) -------------------------

export async function kvSet(key: string, value: KvValue): Promise<void> {
  await (await db()).put("kv", value, key);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}

export async function getCachedSession(token: string): Promise<CachedSession | null> {
  const cached = await kvGet<CachedSession>("session");
  return cached && cached.token === token ? cached : null;
}

export async function incrementSyncedCount(): Promise<number> {
  const current = ((await kvGet<number>("syncedCount")) ?? 0) + 1;
  await kvSet("syncedCount", current);
  return current;
}

// ---- Aenderungs-Benachrichtigung (UI-Refresh ohne Polling-Bibliothek) -------

type Listener = () => void;
const listeners = new Set<Listener>();

export function onOfflineChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* Listener-Fehler nie eskalieren */
    }
  });
}

// ---- Speicher-Management (O3) ------------------------------------------------

export async function ensurePersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persisted();
      return persisted || (await navigator.storage.persist());
    }
  } catch {
    /* optional */
  }
  return false;
}

export async function storageUsageRatio(): Promise<number | null> {
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (usage !== undefined && quota) return usage / quota;
    }
  } catch {
    /* optional */
  }
  return null;
}
