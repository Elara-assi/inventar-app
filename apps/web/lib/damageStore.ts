export type DamageArticle = {
  article_no: string;
  nr: string;
  buchungskreis: string;
  anlagenbezeichnung: string;
  aktivdatum: number | string | null;
  aktivdatum_iso?: string | null;
  alter: number | null;
};

export type DamagePhotoType =
  | "front"
  | "side"
  | "serial_number"
  | "uvv_sticker"
  | "damage_detail_1"
  | "damage_detail_2";

export type DamageSyncStatus = "local" | "pending" | "uploading" | "synced" | "failed" | "conflict";
export type DamageEntryType = "catalog" | "free";

export type DamageReport = {
  local_report_id: string;
  server_report_id?: string;
  article_no: string;
  article: DamageArticle;
  entry_type?: DamageEntryType;
  free_reference?: string;
  team_name: string;
  description: string;
  uvv_sticker_present: "ja" | "nein" | "unklar";
  sync_status: DamageSyncStatus;
  created_at: string;
  updated_at: string;
  last_error?: string;
};

export type DamagePhoto = {
  client_photo_id: string;
  local_report_id: string;
  photo_type: DamagePhotoType;
  blob: Blob;
  file_name: string;
  mime_type: string;
  size: number;
  created_at: string;
  updated_at: string;
};

export type DamageCatalogPayload = {
  version: string;
  source_file: string;
  generated_at: string;
  count: number;
  articles: DamageArticle[];
};

export type DamageSummary = {
  total: number;
  pending: number;
  synced: number;
  failed: number;
  conflict: number;
};

const DB_NAME = "inventar-damage-v1";
const DB_VERSION = 1;
const ARTICLE_STORE = "articles";
const REPORT_STORE = "damage_reports";
const PHOTO_STORE = "damage_photos";
const META_STORE = "damage_meta";
const DEVICE_KEY = "inventar.damage.device_id";
const TEAM_KEY = "inventar.damage.team_name";
const CATALOG_META_KEY = "catalog_version";

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

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB-Anfrage fehlgeschlagen"));
  });
}

export function initDamageDb(): Promise<IDBDatabase> {
  if (!browserOnly()) return Promise.reject(new Error("IndexedDB ist nicht verfügbar"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      dbPromise = null;
      reject(new Error("Lokale Schadensspeicherung ist blockiert. Bitte alte Tabs schließen und neu laden."));
    }, 4_000);
    request.onupgradeneeded = () => {
      const db = request.result;
      const articles = db.objectStoreNames.contains(ARTICLE_STORE)
        ? request.transaction?.objectStore(ARTICLE_STORE)
        : db.createObjectStore(ARTICLE_STORE, { keyPath: "article_no" });
      if (articles && !articles.indexNames.contains("anlagenbezeichnung")) {
        articles.createIndex("anlagenbezeichnung", "anlagenbezeichnung");
      }
      const reports = db.objectStoreNames.contains(REPORT_STORE)
        ? request.transaction?.objectStore(REPORT_STORE)
        : db.createObjectStore(REPORT_STORE, { keyPath: "local_report_id" });
      if (reports) {
        if (!reports.indexNames.contains("article_no")) reports.createIndex("article_no", "article_no", { unique: true });
        if (!reports.indexNames.contains("sync_status")) reports.createIndex("sync_status", "sync_status");
        if (!reports.indexNames.contains("updated_at")) reports.createIndex("updated_at", "updated_at");
      }
      const photos = db.objectStoreNames.contains(PHOTO_STORE)
        ? request.transaction?.objectStore(PHOTO_STORE)
        : db.createObjectStore(PHOTO_STORE, { keyPath: "client_photo_id" });
      if (photos) {
        if (!photos.indexNames.contains("local_report_id")) photos.createIndex("local_report_id", "local_report_id");
        if (!photos.indexNames.contains("report_photo_type")) photos.createIndex("report_photo_type", ["local_report_id", "photo_type"], { unique: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
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
    request.onblocked = () => undefined;
    request.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      dbPromise = null;
      reject(request.error ?? new Error("Schadensdatenbank konnte nicht geöffnet werden"));
    };
  });
  return dbPromise;
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const db = await initDamageDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let request: IDBRequest<T> | void;
    transaction.oncomplete = () => resolve((request as IDBRequest<T> | undefined)?.result as T);
    transaction.onerror = () => reject(transaction.error ?? new Error("Lokale Schadens-Transaktion fehlgeschlagen"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Lokale Schadens-Transaktion abgebrochen"));
    request = callback(store);
  });
}

async function getMeta(key: string): Promise<unknown> {
  if (!browserOnly()) return undefined;
  const result = await withStore<{ key: string; value: unknown } | undefined>(META_STORE, "readonly", (store) => store.get(key));
  return result?.value;
}

async function setMeta(key: string, value: unknown): Promise<void> {
  await withStore(META_STORE, "readwrite", (store) => store.put({ key, value, updated_at: nowIso() }));
}

export async function getOrCreateDamageDeviceId(): Promise<string> {
  if (typeof window === "undefined") return createLocalId("damage-device");
  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = createLocalId("damage-device");
  window.localStorage.setItem(DEVICE_KEY, created);
  return created;
}

export function getStoredDamageTeamName() {
  if (typeof window === "undefined") return "Team 1";
  return window.localStorage.getItem(TEAM_KEY) || "Team 1";
}

export function setStoredDamageTeamName(value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TEAM_KEY, value.trim() || "Team 1");
}

export function createDamageReportId() {
  return createLocalId("damage-report");
}

export function createDamagePhotoId() {
  return createLocalId("damage-photo");
}

export async function seedDamageCatalog(payload: DamageCatalogPayload): Promise<void> {
  const currentVersion = await getMeta(CATALOG_META_KEY);
  if (currentVersion === payload.version) return;
  const db = await initDamageDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([ARTICLE_STORE, META_STORE], "readwrite");
    const articleStore = transaction.objectStore(ARTICLE_STORE);
    articleStore.clear();
    for (const article of payload.articles) {
      articleStore.put(article);
    }
    transaction.objectStore(META_STORE).put({
      key: CATALOG_META_KEY,
      value: payload.version,
      count: payload.count,
      source_file: payload.source_file,
      updated_at: nowIso(),
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Artikelkatalog konnte nicht gespeichert werden"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Artikelkatalog-Speicherung abgebrochen"));
  });
}

export async function loadDamageCatalog(): Promise<DamageArticle[]> {
  if (!browserOnly()) return [];
  try {
    const response = await fetch("/data/damage-articles.v1.json", { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json() as DamageCatalogPayload;
      await seedDamageCatalog(payload);
    }
  } catch {
    // Offline is fine: fall back to the locally seeded catalog.
  }
  return listDamageArticles();
}

export async function listDamageArticles(): Promise<DamageArticle[]> {
  if (!browserOnly()) return [];
  const db = await initDamageDb();
  const transaction = db.transaction(ARTICLE_STORE, "readonly");
  const articles = await requestToPromise(transaction.objectStore(ARTICLE_STORE).getAll() as IDBRequest<DamageArticle[]>);
  return articles.sort((a, b) => Number(a.article_no) - Number(b.article_no));
}

export async function getDamageArticle(articleNo: string): Promise<DamageArticle | undefined> {
  const key = articleNo.trim();
  if (!key) return undefined;
  return withStore<DamageArticle | undefined>(ARTICLE_STORE, "readonly", (store) => store.get(key));
}

export async function getDamageReportByArticle(articleNo: string): Promise<DamageReport | undefined> {
  const db = await initDamageDb();
  const transaction = db.transaction(REPORT_STORE, "readonly");
  const request = transaction.objectStore(REPORT_STORE).index("article_no").get(articleNo.trim()) as IDBRequest<DamageReport | undefined>;
  return requestToPromise(request);
}

export async function getDamageReport(localReportId: string): Promise<DamageReport | undefined> {
  return withStore<DamageReport | undefined>(REPORT_STORE, "readonly", (store) => store.get(localReportId));
}

export async function listDamageReports(): Promise<DamageReport[]> {
  if (!browserOnly()) return [];
  const reports = await withStore<DamageReport[]>(REPORT_STORE, "readonly", (store) => store.getAll());
  return reports.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function saveDamageReport(report: DamageReport): Promise<DamageReport> {
  const now = nowIso();
  const existing = await getDamageReportByArticle(report.article_no);
  const next: DamageReport = {
    ...report,
    local_report_id: existing?.local_report_id ?? report.local_report_id,
    server_report_id: existing?.server_report_id ?? report.server_report_id,
    entry_type: report.entry_type ?? existing?.entry_type ?? "catalog",
    free_reference: report.free_reference ?? existing?.free_reference,
    created_at: existing?.created_at ?? report.created_at ?? now,
    updated_at: now,
    sync_status: "pending",
    last_error: undefined,
  };
  await withStore(REPORT_STORE, "readwrite", (store) => store.put(next));
  return next;
}

export async function markDamageReportStatus(
  localReportId: string,
  syncStatus: DamageSyncStatus,
  patch: Partial<DamageReport> = {},
): Promise<DamageReport | undefined> {
  const current = await getDamageReport(localReportId);
  if (!current) return undefined;
  const next: DamageReport = {
    ...current,
    ...patch,
    sync_status: syncStatus,
    updated_at: nowIso(),
  };
  await withStore(REPORT_STORE, "readwrite", (store) => store.put(next));
  return next;
}

export async function listDamagePhotos(localReportId: string): Promise<DamagePhoto[]> {
  if (!browserOnly()) return [];
  const db = await initDamageDb();
  const transaction = db.transaction(PHOTO_STORE, "readonly");
  const request = transaction.objectStore(PHOTO_STORE).index("local_report_id").getAll(localReportId) as IDBRequest<DamagePhoto[]>;
  const photos = await requestToPromise(request);
  return photos.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function putDamagePhoto(photo: DamagePhoto): Promise<DamagePhoto> {
  const existing = (await listDamagePhotos(photo.local_report_id)).find((entry) => entry.photo_type === photo.photo_type);
  const next: DamagePhoto = {
    ...photo,
    client_photo_id: existing?.client_photo_id ?? photo.client_photo_id,
    created_at: existing?.created_at ?? photo.created_at ?? nowIso(),
    updated_at: nowIso(),
  };
  await withStore(PHOTO_STORE, "readwrite", (store) => store.put(next));
  await markDamageReportStatus(photo.local_report_id, "pending", { last_error: undefined });
  return next;
}

export async function deleteDamagePhoto(clientPhotoId: string): Promise<void> {
  await withStore(PHOTO_STORE, "readwrite", (store) => store.delete(clientPhotoId));
}

export async function getDamageSummary(): Promise<DamageSummary> {
  const reports = await listDamageReports();
  return {
    total: reports.length,
    pending: reports.filter((report) => report.sync_status === "local" || report.sync_status === "pending" || report.sync_status === "uploading" || report.sync_status === "failed").length,
    synced: reports.filter((report) => report.sync_status === "synced").length,
    failed: reports.filter((report) => report.sync_status === "failed").length,
    conflict: reports.filter((report) => report.sync_status === "conflict").length,
  };
}
