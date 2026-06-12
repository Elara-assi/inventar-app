/**
 * Sync-Engine (O2): uebertraegt die Outbox in Reihenfolge zum Server.
 *
 * - Idempotent: client_capture_id (Item) + Inhalts-Hashes (Fotos/Audio)
 *   machen Wiederholungen dublettenfrei; Teilfortschritt steht im Record.
 * - Fehlerklassen: Netz/5xx -> Retry mit Backoff (Record bleibt "wartet");
 *   fachliche 4xx (z. B. Raum abgeschlossen) -> "quarantaene", sichtbar,
 *   wird NIE verworfen.
 * - Trigger: online-Event, Sichtbarkeit, Timer, manuell.
 */
import { API_BASE } from "./api";
import {
  CaptureRecord,
  incrementSyncedCount,
  onOfflineChange,
  outboxAll,
  outboxRemove,
  outboxUpdate,
} from "./offline";

let running = false;

export type SyncEvents = {
  onRecordSynced?: (record: CaptureRecord, inventoryId: string) => void;
  onRecordQuarantined?: (record: CaptureRecord) => void;
};

async function request(path: string, init: RequestInit, timeoutMs = 45000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class TransientError extends Error {}

async function classify(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  let message = `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail;
    message = typeof detail === "string" ? detail : detail?.message ?? message;
  } catch {
    if (text) message = text.slice(0, 200);
  }
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    return new TransientError(message);
  }
  return new Error(message);
}

async function syncRecord(record: CaptureRecord, events: SyncEvents): Promise<void> {
  // 1) Item anlegen (oder per client_capture_id wiederfinden)
  if (!record.progress.itemId) {
    const response = await request("/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: record.sessionId,
        object_class_id: record.objectClassId,
        condition: record.condition,
        brand: record.brand,
        model: record.model,
        serial_number: record.serialNumber,
        inventory_id: record.inventoryId,
        manufacturing_year: record.manufacturingYear,
        client_capture_id: record.clientCaptureId,
      }),
    });
    if (!response.ok) throw await classify(response);
    const item = (await response.json()) as { id: string; inventory_id?: string; temporary_id?: string };
    record.progress.itemId = item.id;
    record.label = item.inventory_id || item.temporary_id || record.label;
    await outboxUpdate(record);
  }
  const itemId = record.progress.itemId;

  // 2) Fotos (einzeln fortsetzbar)
  for (const photo of record.photos) {
    if (record.progress.photosDone.includes(photo.type)) continue;
    const form = new FormData();
    form.append("file", new File([photo.blob], photo.name, { type: photo.blob.type || "image/jpeg" }));
    const response = await request(`/items/${itemId}/photos?photo_type=${photo.type}`, { method: "POST", body: form });
    if (!response.ok) throw await classify(response);
    record.progress.photosDone.push(photo.type);
    await outboxUpdate(record);
  }

  // 3) Sprachnotiz
  if ((record.audio || record.transcript) && !record.progress.audioDone) {
    const form = new FormData();
    if (record.audio) {
      const ext = record.audio.mime.includes("mp4") ? "m4a" : record.audio.mime.includes("ogg") ? "ogg" : "webm";
      form.append("file", new File([record.audio.blob], `notiz.${ext}`, { type: record.audio.mime || "audio/webm" }));
    }
    if (record.transcript) form.append("transcript", record.transcript);
    const response = await request(`/items/${itemId}/audio`, { method: "POST", body: form });
    if (!response.ok) throw await classify(response);
    record.progress.audioDone = true;
    await outboxUpdate(record);
  }

  await outboxRemove(record.clientCaptureId);
  await incrementSyncedCount();
  events.onRecordSynced?.(record, record.label);
}

/** Verarbeitet die komplette Outbox; bricht bei Netzproblemen ab (Retry per Trigger). */
export async function processOutbox(events: SyncEvents = {}): Promise<void> {
  if (running || (typeof navigator !== "undefined" && !navigator.onLine)) return;
  running = true;
  try {
    const records = await outboxAll();
    for (const record of records) {
      if (record.state === "quarantaene") continue;
      record.state = "sync";
      await outboxUpdate(record);
      try {
        await syncRecord(record, events);
      } catch (err) {
        record.attempts += 1;
        if (err instanceof TransientError || err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError")) {
          // Netz/Server: zurueck auf "wartet", naechster Trigger versucht erneut.
          record.state = "wartet";
          record.error = err instanceof Error ? err.message : "Netzwerkfehler";
          await outboxUpdate(record);
          return;
        }
        record.state = "quarantaene";
        record.error = err instanceof Error ? err.message : "Abgelehnt";
        await outboxUpdate(record);
        events.onRecordQuarantined?.(record);
      }
    }
  } finally {
    running = false;
  }
}

/** Quarantaene-Record erneut freigeben (z. B. nachdem der Pruefer den Raum wieder geoeffnet hat). */
export async function retryQuarantined(record: CaptureRecord): Promise<void> {
  record.state = "wartet";
  record.error = undefined;
  await outboxUpdate(record);
  void processOutbox();
}

/** Installiert die Sync-Trigger; Rueckgabe raeumt auf. */
export function startSyncLoop(events: SyncEvents = {}): () => void {
  const run = () => void processOutbox(events);
  const interval = setInterval(() => {
    if (!document.hidden) run();
  }, 30000);
  window.addEventListener("online", run);
  const onVisible = () => {
    if (!document.hidden) run();
  };
  document.addEventListener("visibilitychange", onVisible);
  const unsubscribe = onOfflineChange(() => {
    if (navigator.onLine) setTimeout(run, 250);
  });
  run();
  return () => {
    clearInterval(interval);
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
    unsubscribe();
  };
}
