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

function bundleUploadUrl() {
  return `${API_BASE}/offline-sync/items`;
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
    const file = new File(
      [photo.photo_blob],
      photo.file_name || `${photo.client_photo_id}.jpg`,
      { type: photo.file_type || photo.photo_blob.type || "image/jpeg" },
    );
    form.append("files", file);
  }
  await updateQueueStatus(item.id, "uploading", {
    sync_run_id: syncRunId,
    sync_checked_at: new Date().toISOString(),
    upload_url: url,
    upload_debug_state: "bundle_fetch_starting",
    upload_debug: `Paket-Sync gestartet: ${photos.length} Foto(s).`,
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
    upload_debug: `Paket-Sync gestartet: ${photo.photo_blob?.size ?? photo.file_size ?? 0} Byte, ${photo.photo_blob?.type || photo.file_type || "unbekannter Typ"}.`,
    last_error: undefined,
  })));
  const response = await fetchWithTimeout(url, { method: "POST", body: form }, 45_000);
  const responseText = await response.text();
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
  await Promise.all(orphanPhotos.map((photo) => updateQueueStatus(photo.id, "conflict", {
    sync_run_id: syncRunId,
    sync_checked_at: new Date().toISOString(),
    eligible_for_upload: false,
    skip_reason: "Foto hat kein lokales Objektpaket mehr.",
    fetch_started: false,
    last_error: "Dieses Foto ist eine lokale Altlast ohne Objektpaket. Bitte Details pruefen oder lokale Daten bewusst verwerfen.",
    upload_debug_state: "guard_missing_item_bundle",
    upload_debug: "Paket-Sync wurde nicht gestartet: Objektpaket fehlt.",
  })));
  if (!bundles.length) {
    return { synced: 0, failed: orphanPhotos.length, open: (await getQueueSummary()).open };
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
        upload_debug_state: error instanceof Error && error.name === "AbortError" ? "timeout" : "fetch_error",
        upload_response_status: error instanceof Error && error.name === "AbortError" ? 0 : undefined,
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
        upload_debug_state: error instanceof Error && error.name === "AbortError" ? "timeout" : "fetch_error",
        upload_response_status: error instanceof Error && error.name === "AbortError" ? 0 : undefined,
        upload_response_text: rawError.slice(0, 500),
        upload_debug: "Paket-Sync wurde gestartet, aber nicht erfolgreich abgeschlossen.",
      })));
      failed += 1 + uploadablePhotos.length;
    }
  }
  return { synced, failed, open: (await getQueueSummary()).open };
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
  console.warn("[inventar-sync] Foto-Sync startet", { count: photos.length, online_hint: getOnlineStatus() });
  if (photos.length) {
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
        upload_debug: "Foto-Upload wurde nicht gestartet, weil die API nicht erreichbar war.",
      })));
      return { synced, failed: photos.length, open: (await getQueueSummary()).open };
    }
  }
  photos = photoCandidates(await listQueueItems());
  for (const photo of photos) {
    const currentItems = await listQueueItems();
    const serverItemId = await findServerItemId(photo, currentItems);
    const skipReason = photoSkipReason(photo, serverItemId);
    if (skipReason) {
      const linkedDraft = currentItems.find((entry) => entry.type === "item_draft" && entry.client_item_id === photo.client_item_id);
      const isUnrecoverable = !serverItemId && (!linkedDraft || linkedDraft.status === "failed" || linkedDraft.status === "conflict");
      const nextStatus = skipReason.includes("Zielobjekt-ID fehlt") && !isUnrecoverable ? "pending" : "conflict";
      await updateQueueStatus(photo.id, nextStatus, {
        server_item_id: serverItemId,
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: false,
        skip_reason: skipReason,
        fetch_started: false,
        last_error: skipReason,
        upload_url: serverItemId ? photoUploadUrl(photo, serverItemId) : undefined,
        upload_debug_state: skipReason.includes("Zielobjekt-ID fehlt")
          ? "guard_no_target_item"
          : skipReason.includes("Blob")
            ? "guard_missing_blob"
            : "guard_missing_metadata",
        upload_debug: skipReason,
      });
      console.warn("[inventar-sync] Foto wird übersprungen", {
        ...describePhotoForLog(photo, serverItemId),
        skip_reason: skipReason,
      });
      continue;
    }
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
    const photoBlob = photo.photo_blob;
    if (!photoBlob) {
      continue;
    }
    try {
      await updateQueueStatus(photo.id, "uploading", {
        server_item_id: serverItemId,
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: true,
        skip_reason: undefined,
        fetch_started: true,
        last_error: undefined,
        upload_started_at: new Date().toISOString(),
        upload_url: photoUploadUrl(photo, serverItemId),
        upload_debug_state: "fetch_starting",
        upload_response_status: undefined,
        upload_response_text: undefined,
        upload_debug: `Upload gestartet: ${photoBlob.size} Byte, ${photoBlob.type || photo.file_type || "unbekannter Typ"}.`,
      });
      const uploaded = await uploadPhoto(photo, serverItemId);
      await updateQueueStatus(photo.id, "synced", {
        server_item_id: serverItemId,
        sync_run_id: syncRunId,
        sync_checked_at: new Date().toISOString(),
        health_checked: true,
        health_result: "ok",
        eligible_for_upload: true,
        skip_reason: undefined,
        fetch_started: true,
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
    const bundle = await syncPendingBundles();
    const summary = await getQueueSummary();
    if (bundle.synced > 0) {
      await clearOnlySyncedItems();
    }
    return { synced: bundle.synced, failed: bundle.failed, open: summary.open };
  } finally {
    syncRunning = false;
  }
}
