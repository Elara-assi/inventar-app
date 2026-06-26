import { ApiError, api, apiResponse, getAuthToken } from "@/lib/api";
import {
  DamagePhoto,
  DamageReport,
  deleteLocalDamageReport,
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

type MobileDamageContext = {
  sessionId?: string;
  deviceId?: string;
};

export type DamageSyncResult = {
  synced: number;
  failed: number;
  conflict: number;
  skipped: number;
  pending: number;
  lastError?: string;
};

type DamageSyncOptions = {
  onlyLocalReportId?: string;
};

const requiredPhotoLabels: Record<string, string> = {
  front: "Frontansicht",
  damage_detail_1: "Schaden 1",
  uvv_sticker: "UVV-Aufkleber",
};

export function getDamageOnlineStatus() {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

function decodeMobileDamageContext(): MobileDamageContext {
  const token = getAuthToken();
  const payloadText = token.split(".")[1];
  if (!payloadText || typeof window === "undefined") return {};
  try {
    const normalized = payloadText.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const payload = JSON.parse(window.atob(padded)) as {
      kind?: string;
      session_id?: string;
      device_id?: string;
    };
    if (payload.kind !== "mobile_session") return {};
    return {
      sessionId: payload.session_id,
      deviceId: payload.device_id,
    };
  } catch {
    return {};
  }
}

function buildPayload(report: DamageReport, photos: DamagePhoto[], deviceId: string, context: MobileDamageContext) {
  return {
    report: {
      client_report_id: report.local_report_id,
      session_id: context.sessionId,
      source_device_id: context.deviceId || deviceId,
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

export function damageReportSyncIssues(report: DamageReport, photos: DamagePhoto[]) {
  const issues: string[] = [];
  if (!report.team_name.trim()) issues.push("Team fehlt");
  if (!report.description.trim()) issues.push("Schadensbeschreibung fehlt");
  if (report.server_report_id) return issues;
  const photoTypes = new Set(photos.map((photo) => photo.photo_type));
  for (const requiredType of ["front", "damage_detail_1"]) {
    if (!photoTypes.has(requiredType as DamagePhoto["photo_type"])) {
      issues.push(`Pflichtfoto fehlt: ${requiredPhotoLabels[requiredType]}`);
    }
  }
  if (report.uvv_sticker_present === "ja" && !photoTypes.has("uvv_sticker")) {
    issues.push(`Pflichtfoto fehlt: ${requiredPhotoLabels.uvv_sticker}`);
  }
  return issues;
}

function isDamageReportReadyForSync(report: DamageReport, photos: DamagePhoto[]) {
  return damageReportSyncIssues(report, photos).length === 0;
}

async function appendPhotoFiles(form: FormData, photos: DamagePhoto[]) {
  for (const photo of photos) {
    const type = photo.mime_type || photo.blob.type || "image/jpeg";
    const fileBlob = photo.blob.type ? photo.blob : photo.blob.slice(0, photo.blob.size, type);
    form.append("files", fileBlob, photo.file_name || `${photo.client_photo_id}.jpg`);
  }
}

export async function syncDamageReport(report: DamageReport, deviceId: string): Promise<DamageSyncResponse> {
  const photos = await listDamagePhotos(report.local_report_id);
  await markDamageReportStatus(report.local_report_id, "uploading", { last_error: undefined });
  const form = new FormData();
  form.append("payload", JSON.stringify(buildPayload(report, photos, deviceId, decodeMobileDamageContext())));
  await appendPhotoFiles(form, photos);
  const response = await apiResponse("/damage-reports/sync", {
    method: "POST",
    body: form,
  });
  return response.json() as Promise<DamageSyncResponse>;
}

export async function syncPendingDamageReports(deviceId: string, options: DamageSyncOptions = {}): Promise<DamageSyncResult> {
  if (!getDamageOnlineStatus()) {
    const summary = await getDamageSummary();
    return { synced: 0, failed: 0, conflict: 0, skipped: 0, pending: summary.pending, lastError: "Offline: Schäden bleiben lokal gespeichert." };
  }
  let synced = 0;
  let failed = 0;
  let conflict = 0;
  let skipped = 0;
  let lastError = "";
  const reports = (await listDamageReports()).filter((report) => (
    ["local", "pending", "failed", "uploading"].includes(report.sync_status)
    && (!options.onlyLocalReportId || report.local_report_id === options.onlyLocalReportId)
  ));
  for (const report of reports) {
    try {
      const photos = await listDamagePhotos(report.local_report_id);
      if (!isDamageReportReadyForSync(report, photos)) {
        skipped += 1;
        const message = `Noch nicht syncbar: ${damageReportSyncIssues(report, photos).join(", ")}`;
        if (options.onlyLocalReportId || report.sync_status !== "local") {
          await markDamageReportStatus(report.local_report_id, "failed", { last_error: message });
          failed += 1;
        }
        lastError = message;
        continue;
      }
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
        try {
          await deleteLocalDamageReport(report.local_report_id);
        } catch {
          // Server has the report; a local cleanup problem must not turn a successful upload into a failed sync.
        }
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
  return { synced, failed, conflict, skipped, pending: summary.pending, lastError: lastError || undefined };
}

export async function createDamageExcelExport(): Promise<{ id: string }> {
  return api<{ id: string }>("/damage-reports/export/excel", { method: "POST", body: "{}" });
}

export async function deleteServerDamageReport(reportId: string): Promise<{ deleted: boolean; removed_files: number }> {
  return api<{ deleted: boolean; removed_files: number }>(`/damage-reports/${reportId}`, { method: "DELETE" });
}
