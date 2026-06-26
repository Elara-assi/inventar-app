import { ApiError, api, apiResponse } from "@/lib/api";
import {
  DamagePhoto,
  DamageReport,
  getDamageSummary,
  listDamagePhotos,
  listDamageReports,
  markDamageReportStatus,
} from "@/lib/damageStore";

type DamageSyncResponse = {
  server_report_id: string;
  client_report_id: string;
  article_no: string;
  status: "synced" | "updated";
  photo_results: Array<{
    client_photo_id?: string;
    photo_type?: string;
    status: "synced" | "already_exists" | "failed";
    server_photo_id?: string;
    error?: string;
  }>;
};

export type DamageSyncResult = {
  synced: number;
  failed: number;
  conflict: number;
  pending: number;
  lastError?: string;
};

export function getDamageOnlineStatus() {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

function buildPayload(report: DamageReport, photos: DamagePhoto[], deviceId: string) {
  return {
    report: {
      client_report_id: report.local_report_id,
      source_device_id: deviceId,
      article_no: report.article_no,
      article: report.article,
      entry_type: report.entry_type ?? "catalog",
      free_reference: report.free_reference,
      team_name: report.team_name,
      description: report.description,
      uvv_sticker_present: report.uvv_sticker_present,
      created_at: report.created_at,
      updated_at: report.updated_at,
    },
    photos: photos.map((photo) => ({
      client_photo_id: photo.client_photo_id,
      photo_type: photo.photo_type,
      filename: photo.file_name,
      mime_type: photo.mime_type,
      size: photo.size,
    })),
  };
}

function isDamageReportReadyForSync(report: DamageReport, photos: DamagePhoto[]) {
  if (!report.description.trim() || !report.team_name.trim()) return false;
  if (report.server_report_id) return true;
  const photoTypes = new Set(photos.map((photo) => photo.photo_type));
  if (!photoTypes.has("front") || !photoTypes.has("damage_detail_1")) return false;
  if (report.uvv_sticker_present === "ja" && !photoTypes.has("uvv_sticker")) return false;
  return true;
}

async function appendPhotoFiles(form: FormData, photos: DamagePhoto[]) {
  for (const photo of photos) {
    const type = photo.mime_type || photo.blob.type || "image/jpeg";
    const data = await photo.blob.arrayBuffer();
    form.append("files", new Blob([data], { type }), photo.file_name || `${photo.client_photo_id}.jpg`);
  }
}

export async function syncDamageReport(report: DamageReport, deviceId: string): Promise<DamageSyncResponse> {
  const photos = await listDamagePhotos(report.local_report_id);
  await markDamageReportStatus(report.local_report_id, "uploading", { last_error: undefined });
  const form = new FormData();
  form.append("payload", JSON.stringify(buildPayload(report, photos, deviceId)));
  await appendPhotoFiles(form, photos);
  const response = await apiResponse("/damage-reports/sync", {
    method: "POST",
    body: form,
  });
  return response.json() as Promise<DamageSyncResponse>;
}

export async function syncPendingDamageReports(deviceId: string): Promise<DamageSyncResult> {
  if (!getDamageOnlineStatus()) {
    const summary = await getDamageSummary();
    return { synced: 0, failed: 0, conflict: 0, pending: summary.pending, lastError: "Offline: Schäden bleiben lokal gespeichert." };
  }
  let synced = 0;
  let failed = 0;
  let conflict = 0;
  let lastError = "";
  const reports = (await listDamageReports()).filter((report) => ["local", "pending", "failed", "uploading"].includes(report.sync_status));
  for (const report of reports) {
    try {
      const photos = await listDamagePhotos(report.local_report_id);
      if (!isDamageReportReadyForSync(report, photos)) continue;
      const result = await syncDamageReport(report, deviceId);
      const failedPhotos = result.photo_results.filter((photo) => photo.status === "failed");
      if (failedPhotos.length) {
        const message = failedPhotos.map((photo) => photo.error || photo.photo_type || "Foto fehlgeschlagen").join(", ");
        await markDamageReportStatus(report.local_report_id, "failed", {
          server_report_id: result.server_report_id,
          last_error: message,
        });
        failed += 1;
        lastError = message;
      } else {
        await markDamageReportStatus(report.local_report_id, "synced", {
          server_report_id: result.server_report_id,
          last_error: undefined,
        });
        synced += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Schaden-Sync fehlgeschlagen";
      const isConflict = error instanceof ApiError && error.status === 409;
      await markDamageReportStatus(report.local_report_id, isConflict ? "conflict" : "failed", { last_error: message });
      if (isConflict) conflict += 1;
      else failed += 1;
      lastError = message;
    }
  }
  const summary = await getDamageSummary();
  return { synced, failed, conflict, pending: summary.pending, lastError: lastError || undefined };
}

export async function createDamageExcelExport(): Promise<{ id: string }> {
  return api<{ id: string }>("/damage-reports/export/excel", { method: "POST", body: "{}" });
}
