"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, downloadApiFile, joinUrl } from "@/lib/api";
import {
  DamageArticle,
  DamageEntryType,
  DamagePhoto,
  DamagePhotoType,
  DamageReport,
  DamageSummary,
  createDamagePhotoId,
  createDamageReportId,
  deleteDamagePhoto,
  getDamageArticle,
  getDamageReportByArticle,
  getOrCreateDamageDeviceId,
  getStoredDamageTeamName,
  listDamagePhotos,
  listDamageReports,
  loadDamageCatalog,
  putDamagePhoto,
  saveDamageReport,
  setStoredDamageTeamName,
} from "@/lib/damageStore";
import { createDamageExcelExport, getDamageOnlineStatus, syncPendingDamageReports } from "@/lib/damageSync";

const photoSlots: Array<{ type: DamagePhotoType; label: string; required: boolean; hint: string }> = [
  { type: "front", label: "Frontbild", required: true, hint: "Pflicht" },
  { type: "side", label: "Seitenbild", required: false, hint: "optional" },
  { type: "serial_number", label: "Seriennummer", required: false, hint: "optional" },
  { type: "uvv_sticker", label: "UVV-Aufkleber", required: false, hint: "wenn vorhanden" },
  { type: "damage_detail_1", label: "Schaden 1", required: true, hint: "Pflicht" },
  { type: "damage_detail_2", label: "Schaden 2", required: false, hint: "optional" },
];

const emptySummary: DamageSummary = { total: 0, pending: 0, synced: 0, failed: 0, conflict: 0 };

type DamageSession = {
  id: string;
  join_token: string;
  join_token_expires_at?: string | null;
  room_name?: string | null;
  building_name?: string | null;
  location_name?: string | null;
  status: string;
};

type DamageQrOption = {
  id: string;
  token: string;
  label: string;
  detail: string;
  expiresAt?: string | null;
  source: "server" | "local";
};

type ServerDamageReport = {
  id: string;
  article_no: string;
  entry_type?: DamageEntryType | null;
  free_reference?: string | null;
  nr?: string | null;
  anlagenbezeichnung?: string | null;
  team_name?: string | null;
  damage_description?: string | null;
  uvv_sticker_present?: string | null;
  captured_at?: string | null;
  updated_at?: string | null;
  photo_count?: number | null;
  photo_types?: DamagePhotoType[] | null;
};

function registerDamageServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") {
    navigator.serviceWorker.getRegistrations?.()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => undefined);
    return;
  }
  if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") return;
  navigator.serviceWorker.register("/sw.js")
    .then((registration) => {
      void registration.update();
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    })
    .catch(() => undefined);
}

function formatDateTime(value?: string) {
  if (!value) return "offen";
  return new Date(value).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function articleDate(article?: DamageArticle | null) {
  if (!article) return "";
  return article.aktivdatum_iso || String(article.aktivdatum || "");
}

function statusLabel(status: DamageReport["sync_status"]) {
  return {
    local: "lokal",
    pending: "wartet",
    uploading: "Sync",
    synced: "synchronisiert",
    failed: "Fehler",
    conflict: "Doppelung",
  }[status];
}

function statusTone(status: DamageReport["sync_status"]) {
  if (status === "synced") return "geprueft";
  if (status === "failed" || status === "conflict") return "upload_fehler";
  return "pruefen";
}

function sessionLabel(session: DamageSession) {
  return session.room_name || session.building_name || session.location_name || `Session ${session.id.slice(0, 8)}`;
}

function sessionDetail(session: DamageSession) {
  return [session.location_name, session.building_name, session.room_name].filter(Boolean).join(" / ") || "Offene Session";
}

function normalizedUvv(value?: string | null): DamageReport["uvv_sticker_present"] {
  return value === "ja" || value === "nein" || value === "unklar" ? value : "unklar";
}

function createFreeArticleNo() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FREI-${stamp}-${suffix}`;
}

function createFreeDamageArticle(articleNo: string, title: string): DamageArticle {
  return {
    article_no: articleNo,
    nr: articleNo,
    buchungskreis: "Nicht in Liste",
    anlagenbezeichnung: title.trim() || "Freier Schaden",
    aktivdatum: null,
    aktivdatum_iso: null,
    alter: null,
  };
}

function isFreeServerReport(report?: ServerDamageReport | null) {
  return report?.entry_type === "free" || String(report?.article_no || "").startsWith("FREI-");
}

function localQrOptionsFromCapsules(): DamageQrOption[] {
  if (typeof window === "undefined") return [];
  const options: DamageQrOption[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index) || "";
    if (!key.startsWith("inventar.mobile_session_capsule.")) continue;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const capsule = JSON.parse(raw) as {
        token?: string;
        joined?: { session?: { id?: string; room_id?: string; building_id?: string; location_id?: string } };
        bootstrap?: {
          locations?: Array<{ id: string; name: string }>;
          buildings?: Array<{ id: string; name: string }>;
          rooms?: Array<{ id: string; name: string }>;
        };
      };
      const session = capsule.joined?.session;
      const token = capsule.token || key.replace("inventar.mobile_session_capsule.", "");
      if (!session?.id || !token) continue;
      const room = capsule.bootstrap?.rooms?.find((entry) => entry.id === session.room_id);
      const building = capsule.bootstrap?.buildings?.find((entry) => entry.id === session.building_id);
      const location = capsule.bootstrap?.locations?.find((entry) => entry.id === session.location_id);
      options.push({
        id: session.id,
        token,
        label: room?.name || building?.name || location?.name || `Session ${session.id.slice(0, 8)}`,
        detail: "Lokal gekoppelte Session",
        source: "local",
      });
    } catch {
      // Ignore older or partial local capsules.
    }
  }
  return options;
}

async function compressPhoto(file: File, maxSide = 1800): Promise<Blob> {
  if (typeof document === "undefined" || !file.type.startsWith("image/")) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    const scale = Math.min(maxSide / image.width, maxSide / image.height, 1);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.84));
    return blob ?? file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function DamageCapturePage() {
  const [catalogCount, setCatalogCount] = useState(0);
  const [catalogReady, setCatalogReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [teamName, setTeamName] = useState("Team 1");
  const [captureMode, setCaptureMode] = useState<DamageEntryType>("catalog");
  const [articleNo, setArticleNo] = useState("");
  const [article, setArticle] = useState<DamageArticle | null>(null);
  const [freeArticleNo, setFreeArticleNo] = useState("");
  const [freeTitle, setFreeTitle] = useState("");
  const [freeReference, setFreeReference] = useState("");
  const [localReportId, setLocalReportId] = useState("");
  const [description, setDescription] = useState("");
  const [uvvStickerPresent, setUvvStickerPresent] = useState<DamageReport["uvv_sticker_present"]>("unklar");
  const [photos, setPhotos] = useState<DamagePhoto[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<Partial<Record<DamagePhotoType, string>>>({});
  const [reports, setReports] = useState<DamageReport[]>([]);
  const [summary, setSummary] = useState<DamageSummary>(emptySummary);
  const [isOnline, setIsOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Bereit");
  const [error, setError] = useState("");
  const [existingHint, setExistingHint] = useState("");
  const [qrOptions, setQrOptions] = useState<DamageQrOption[]>([]);
  const [selectedQrSessionId, setSelectedQrSessionId] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const [qrMessage, setQrMessage] = useState("");
  const [serverReports, setServerReports] = useState<ServerDamageReport[]>([]);
  const [serverReportsBusy, setServerReportsBusy] = useState(false);
  const [serverReportsMessage, setServerReportsMessage] = useState("");
  const articleInputRef = useRef<HTMLInputElement | null>(null);
  const freeTitleInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputs = useRef<Partial<Record<DamagePhotoType, HTMLInputElement | null>>>({});

  const photoMap = useMemo(() => {
    const map = new Map<DamagePhotoType, DamagePhoto>();
    for (const photo of photos) map.set(photo.photo_type, photo);
    return map;
  }, [photos]);

  const serverReportForArticle = useMemo(() => {
    const normalized = articleNo.trim();
    if (!normalized) return undefined;
    return serverReports.find((report) => (
      String(report.article_no || "").trim() === normalized
      || String(report.nr || "").trim() === normalized
    ));
  }, [articleNo, serverReports]);
  const serverPhotoTypeSet = useMemo(
    () => new Set<DamagePhotoType>(serverReportForArticle?.photo_types || []),
    [serverReportForArticle],
  );
  const uvvPhotoRequired = uvvStickerPresent === "ja";
  const missingRequiredPhotos = photoSlots
    .filter((slot) => slot.required || (slot.type === "uvv_sticker" && uvvPhotoRequired))
    .filter((slot) => !photoMap.has(slot.type) && !serverPhotoTypeSet.has(slot.type))
    .map((slot) => slot.label);
  const canSave = Boolean(article)
    && Boolean(localReportId)
    && teamName.trim().length > 0
    && description.trim().length >= 3
    && missingRequiredPhotos.length === 0;
  const selectedQrOption = useMemo(
    () => qrOptions.find((option) => option.id === selectedQrSessionId) || qrOptions[0],
    [qrOptions, selectedQrSessionId],
  );
  const selectedQrExpired = selectedQrOption?.expiresAt ? new Date(selectedQrOption.expiresAt).getTime() <= Date.now() : false;
  const serverPhotoCount = useMemo(
    () => serverReports.reduce((total, report) => total + Number(report.photo_count || 0), 0),
    [serverReports],
  );
  const serverTeamCount = useMemo(
    () => new Set(serverReports.map((report) => report.team_name).filter(Boolean)).size,
    [serverReports],
  );

  const refreshReports = useCallback(async () => {
    const nextReports = await listDamageReports();
    setReports(nextReports);
    setSummary({
      total: nextReports.length,
      pending: nextReports.filter((report) => ["local", "pending", "uploading", "failed"].includes(report.sync_status)).length,
      synced: nextReports.filter((report) => report.sync_status === "synced").length,
      failed: nextReports.filter((report) => report.sync_status === "failed").length,
      conflict: nextReports.filter((report) => report.sync_status === "conflict").length,
    });
  }, []);

  const refreshServerReports = useCallback(async (quiet = false) => {
    if (!getDamageOnlineStatus()) {
      setServerReportsMessage("Offline: Server-Stand bleibt unverändert.");
      return;
    }
    if (!quiet) setServerReportsBusy(true);
    try {
      const nextReports = await api<ServerDamageReport[]>("/damage-reports");
      setServerReports(nextReports);
      setServerReportsMessage(nextReports.length ? "" : "Noch kein synchronisierter Schaden auf dem Server.");
    } catch (err) {
      setServerReportsMessage(err instanceof Error ? err.message : "Server-Stand konnte nicht geladen werden.");
    } finally {
      if (!quiet) setServerReportsBusy(false);
    }
  }, []);

  const loadPhotosForReport = useCallback(async (reportId: string) => {
    const storedPhotos = reportId ? await listDamagePhotos(reportId) : [];
    setPhotoPreviews((current) => {
      Object.values(current).forEach((url) => {
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      });
      const next: Partial<Record<DamagePhotoType, string>> = {};
      for (const photo of storedPhotos) {
        next[photo.photo_type] = URL.createObjectURL(photo.blob);
      }
      return next;
    });
    setPhotos(storedPhotos);
  }, []);

  const resetCaptureForm = useCallback((nextMessage = "Neue Schadensaufnahme bereit") => {
    if (captureMode === "free") {
      setFreeArticleNo(createFreeArticleNo());
      setFreeTitle("");
      setFreeReference("");
      setArticleNo("");
    } else {
      setArticleNo("");
      setFreeArticleNo("");
      setFreeTitle("");
      setFreeReference("");
    }
    setArticle(null);
    setLocalReportId("");
    setDescription("");
    setUvvStickerPresent("unklar");
    setPhotos([]);
    setPhotoPreviews((current) => {
      Object.values(current).forEach((url) => {
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      });
      return {};
    });
    setExistingHint("");
    setError("");
    setMessage(nextMessage);
    window.setTimeout(() => {
      const target = captureMode === "free" ? freeTitleInputRef.current : articleInputRef.current;
      target?.focus();
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }, [captureMode]);

  const refreshQrOptions = useCallback(async () => {
    const localOptions = localQrOptionsFromCapsules();
    try {
      const sessions = await api<DamageSession[]>("/sessions");
      const serverOptions = sessions
        .filter((session) => session.status === "open" && session.join_token)
        .map((session) => ({
          id: session.id,
          token: session.join_token,
          label: sessionLabel(session),
          detail: sessionDetail(session),
          expiresAt: session.join_token_expires_at,
          source: "server" as const,
        }));
      const nextOptions = serverOptions.length ? serverOptions : localOptions;
      setQrOptions(nextOptions);
      setSelectedQrSessionId((current) => (
        current && nextOptions.some((option) => option.id === current)
          ? current
          : nextOptions[0]?.id || ""
      ));
      setQrMessage(serverOptions.length ? "" : localOptions.length ? "Lokale Kopplung erkannt" : "");
    } catch {
      setQrOptions(localOptions);
      setSelectedQrSessionId((current) => (
        current && localOptions.some((option) => option.id === current)
          ? current
          : localOptions[0]?.id || ""
      ));
      setQrMessage(localOptions.length ? "Lokale Kopplung erkannt" : "");
    }
  }, []);

  useEffect(() => {
    registerDamageServiceWorker();
    setIsOnline(getDamageOnlineStatus());
    const onOnline = () => {
      setIsOnline(true);
      refreshServerReports(true).catch(() => undefined);
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    getOrCreateDamageDeviceId().then(setDeviceId).catch(() => undefined);
    setTeamName(getStoredDamageTeamName());
    loadDamageCatalog()
      .then((articles) => {
        setCatalogCount(articles.length);
        setMessage(`${articles.length} Artikel offline bereit`);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Artikelkatalog konnte nicht geladen werden"))
      .finally(() => setCatalogReady(true));
    refreshReports().catch(() => undefined);
    refreshServerReports(true).catch(() => undefined);
    refreshQrOptions().catch(() => undefined);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      setPhotoPreviews((current) => {
        Object.values(current).forEach((url) => {
          if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
        });
        return {};
      });
    };
  }, [refreshQrOptions, refreshReports, refreshServerReports]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && getDamageOnlineStatus()) {
        refreshServerReports(true).catch(() => undefined);
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshServerReports]);

  useEffect(() => {
    setStoredDamageTeamName(teamName);
  }, [teamName]);

  useEffect(() => {
    if (captureMode === "free") return;
    const normalized = articleNo.trim();
    let ignore = false;
    async function resolveArticle() {
      setError("");
      setExistingHint("");
      if (!normalized) {
        setArticle(null);
        setLocalReportId("");
        setDescription("");
        setUvvStickerPresent("unklar");
        await loadPhotosForReport("");
        return;
      }
      if (!catalogReady) {
        setArticle(null);
        setLocalReportId("");
        setMessage("Artikelkatalog wird offline vorbereitet...");
        await loadPhotosForReport("");
        return;
      }
      const found = await getDamageArticle(normalized);
      if (ignore) return;
      setArticle(found ?? null);
      if (!found) {
        setLocalReportId("");
        setDescription("");
        setUvvStickerPresent("unklar");
        await loadPhotosForReport("");
        setError(`Artikel ${normalized} nicht im importierten Katalog gefunden.`);
        return;
      }
      if (article?.article_no === found.article_no && localReportId) {
        const synced = serverReports.find((report) => (
          String(report.article_no || "").trim() === normalized
          || String(report.nr || "").trim() === normalized
        ));
        if (synced) setExistingHint("Artikel ist bereits synchronisiert und wurde zum Nachbearbeiten ge\u00f6ffnet.");
        return;
      }
      const existing = await getDamageReportByArticle(normalized);
      if (ignore) return;
      if (existing) {
        setLocalReportId(existing.local_report_id);
        setDescription(existing.description);
        setUvvStickerPresent(existing.uvv_sticker_present);
        setTeamName(existing.team_name || getStoredDamageTeamName());
        setExistingHint("Artikel ist bereits lokal erfasst und wurde zum Bearbeiten geöffnet.");
        await loadPhotosForReport(existing.local_report_id);
      } else {
        const synced = serverReports.find((report) => (
          String(report.article_no || "").trim() === normalized
          || String(report.nr || "").trim() === normalized
        ));
        const nextId = createDamageReportId();
        setLocalReportId(nextId);
        setDescription(synced?.damage_description || "");
        setUvvStickerPresent(normalizedUvv(synced?.uvv_sticker_present));
        if (synced?.team_name) setTeamName(synced.team_name);
        setExistingHint(synced ? "Artikel ist bereits synchronisiert und wurde zum Nachbearbeiten ge\u00f6ffnet." : "");
        await loadPhotosForReport(nextId);
      }
    }
    resolveArticle().catch((err) => setError(err instanceof Error ? err.message : "Artikel konnte nicht geprüft werden"));
    return () => {
      ignore = true;
    };
  }, [articleNo, captureMode, catalogReady, loadPhotosForReport, serverReports]);

  useEffect(() => {
    if (captureMode !== "free") return;
    let ignore = false;
    async function resolveFreeArticle() {
      setError("");
      setExistingHint("");
      const nextNo = freeArticleNo || createFreeArticleNo();
      if (!freeArticleNo) {
        setFreeArticleNo(nextNo);
        return;
      }
      if (articleNo !== nextNo) setArticleNo(nextNo);
      const title = freeTitle.trim();
      if (!title) {
        setArticle(null);
        setExistingHint("Freier Schaden: Bezeichnung eingeben, dann Fotos und Beschreibung erfassen.");
        return;
      }
      const nextArticle = createFreeDamageArticle(nextNo, title);
      setArticle(nextArticle);
      if (localReportId && articleNo === nextNo) return;
      const existing = await getDamageReportByArticle(nextNo);
      if (ignore) return;
      if (existing) {
        setLocalReportId(existing.local_report_id);
        setDescription(existing.description);
        setUvvStickerPresent(existing.uvv_sticker_present);
        setTeamName(existing.team_name || getStoredDamageTeamName());
        setFreeReference(existing.free_reference || "");
        setExistingHint("Freier Schaden ist bereits lokal erfasst und wurde zum Bearbeiten ge\u00f6ffnet.");
        await loadPhotosForReport(existing.local_report_id);
        return;
      }
      const synced = serverReports.find((report) => String(report.article_no || "").trim() === nextNo);
      const nextId = createDamageReportId();
      setLocalReportId(nextId);
      setDescription(synced?.damage_description || "");
      setUvvStickerPresent(normalizedUvv(synced?.uvv_sticker_present));
      if (synced?.team_name) setTeamName(synced.team_name);
      if (synced?.free_reference) setFreeReference(synced.free_reference);
      setExistingHint(synced ? "Freier Schaden ist bereits synchronisiert und wurde zum Nachbearbeiten ge\u00f6ffnet." : "");
      await loadPhotosForReport(nextId);
    }
    resolveFreeArticle().catch((err) => setError(err instanceof Error ? err.message : "Freier Schaden konnte nicht vorbereitet werden"));
    return () => {
      ignore = true;
    };
  }, [articleNo, captureMode, freeArticleNo, freeTitle, loadPhotosForReport, localReportId, serverReports]);

  async function selectPhoto(type: DamagePhotoType, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !localReportId) return;
    setBusy(true);
    setError("");
    try {
      const blob = await compressPhoto(file, type === "damage_detail_1" || type === "damage_detail_2" || type === "serial_number" ? 2200 : 1800);
      const existing = photoMap.get(type);
      const photo = await putDamagePhoto({
        client_photo_id: existing?.client_photo_id ?? createDamagePhotoId(),
        local_report_id: localReportId,
        photo_type: type,
        blob,
        file_name: `${articleNo || "artikel"}-${type}.jpg`,
        mime_type: "image/jpeg",
        size: blob.size,
        created_at: existing?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      setPhotos((current) => {
        const withoutType = current.filter((entry) => entry.photo_type !== type);
        return [...withoutType, photo].sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
      setPhotoPreviews((current) => {
        const old = current[type];
        if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
        return { ...current, [type]: URL.createObjectURL(blob) };
      });
      setMessage(`${photoSlots.find((slot) => slot.type === type)?.label ?? "Foto"} lokal gespeichert`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Foto konnte nicht gespeichert werden");
    } finally {
      setBusy(false);
      await refreshReports();
    }
  }

  async function removePhoto(type: DamagePhotoType) {
    const photo = photoMap.get(type);
    if (!photo) return;
    await deleteDamagePhoto(photo.client_photo_id);
    setPhotos((current) => current.filter((entry) => entry.client_photo_id !== photo.client_photo_id));
    setPhotoPreviews((current) => {
      const old = current[type];
      if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
      const next = { ...current };
      delete next[type];
      return next;
    });
    setMessage("Foto entfernt");
  }

  async function saveCurrentReport() {
    if (!article || !localReportId) {
      setError(captureMode === "free" ? "Bitte zuerst eine Bezeichnung f\u00fcr den freien Schaden eingeben." : "Bitte zuerst eine g\u00fcltige Artikelnummer eingeben.");
      return null;
    }
    if (!canSave) {
      setError(`Noch offen: ${[
        !description.trim() ? "Schadensbeschreibung" : "",
        ...missingRequiredPhotos,
      ].filter(Boolean).join(", ")}`);
      return null;
    }
    const now = new Date().toISOString();
    const saved = await saveDamageReport({
      local_report_id: localReportId,
      server_report_id: serverReportForArticle?.id,
      article_no: article.article_no,
      article,
      entry_type: captureMode,
      free_reference: captureMode === "free" ? (freeReference.trim() || undefined) : undefined,
      team_name: teamName.trim() || "Team 1",
      description: description.trim(),
      uvv_sticker_present: uvvStickerPresent,
      sync_status: "pending",
      created_at: now,
      updated_at: now,
    });
    setLocalReportId(saved.local_report_id);
    setMessage("Schaden lokal gesichert");
    await refreshReports();
    return saved;
  }

  async function saveLocalOnly() {
    setBusy(true);
    setError("");
    try {
      const saved = await saveCurrentReport();
      if (!saved) return;
      resetCaptureForm("Schaden lokal gesichert - nächster Artikel bereit");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Schaden konnte nicht lokal gespeichert werden");
    } finally {
      setBusy(false);
    }
  }

  async function saveAndSync() {
    setBusy(true);
    setError("");
    try {
      const saved = await saveCurrentReport();
      if (!saved) return;
      const result = await syncPendingDamageReports(deviceId);
      await refreshReports();
      await refreshServerReports(true);
      if (result.failed || result.conflict) {
        setMessage(`Schaden lokal gesichert - Sync pr\u00fcfen: ${result.failed} Fehler, ${result.conflict} Doppelung`);
        if (result.lastError) setError(result.lastError);
        return;
      }
      resetCaptureForm("Schaden synchronisiert - n\u00e4chster Artikel bereit");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Schaden konnte nicht synchronisiert werden");
    } finally {
      setBusy(false);
    }
  }

  async function syncAll() {
    setBusy(true);
    setError("");
    try {
      const result = await syncPendingDamageReports(deviceId);
      setMessage(`Sync fertig: ${result.synced} synchronisiert, ${result.failed} Fehler, ${result.conflict} Doppelung`);
      if (result.lastError) setError(result.lastError);
      await refreshReports();
      await refreshServerReports(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function exportExcel() {
    setBusy(true);
    setError("");
    try {
      const result = await createDamageExcelExport();
      await downloadApiFile(`/exports/${result.id}/download`, "schadensliste.xlsx");
      setMessage("Excel-Schadensliste erstellt");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Excel-Export fehlgeschlagen. Vorher synchronisieren und anmelden.");
    } finally {
      setBusy(false);
    }
  }

  function switchCaptureMode(nextMode: DamageEntryType) {
    if (nextMode === captureMode) return;
    setCaptureMode(nextMode);
    setArticle(null);
    setLocalReportId("");
    setDescription("");
    setUvvStickerPresent("unklar");
    setPhotos([]);
    setPhotoPreviews((current) => {
      Object.values(current).forEach((url) => {
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      });
      return {};
    });
    setExistingHint("");
    setError("");
    if (nextMode === "free") {
      const nextNo = createFreeArticleNo();
      setFreeArticleNo(nextNo);
      setFreeTitle("");
      setFreeReference("");
      setArticleNo(nextNo);
      setMessage("Freier Schaden bereit");
    } else {
      setArticleNo("");
      setFreeArticleNo("");
      setFreeTitle("");
      setFreeReference("");
      setMessage("Listenartikel bereit");
    }
    window.setTimeout(() => {
      const target = nextMode === "free" ? freeTitleInputRef.current : articleInputRef.current;
      target?.focus();
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }

  function startFreeFromMissingArticle() {
    const typedNumber = articleNo.trim();
    switchCaptureMode("free");
    setFreeReference(typedNumber ? `Eingegebene Nr. ${typedNumber}` : "");
    setMessage("Artikel als freien Schaden aufnehmen");
  }

  async function renewSelectedQr() {
    if (!selectedQrOption || selectedQrOption.source !== "server") return;
    setQrBusy(true);
    setQrMessage("");
    try {
      const session = await api<DamageSession>(`/sessions/${selectedQrOption.id}/join-token`, { method: "POST", body: "{}" });
      setQrOptions((current) => current.map((option) => (
        option.id === selectedQrOption.id
          ? {
            ...option,
            token: session.join_token,
            expiresAt: session.join_token_expires_at,
          }
          : option
      )));
      setQrMessage("QR aktualisiert");
    } catch (err) {
      setQrMessage(err instanceof Error ? err.message : "QR konnte nicht aktualisiert werden");
    } finally {
      setQrBusy(false);
    }
  }

  function openReport(report: DamageReport) {
    const isFree = report.entry_type === "free" || report.article_no.startsWith("FREI-");
    setCaptureMode(isFree ? "free" : "catalog");
    setArticle(null);
    setLocalReportId("");
    if (isFree) {
      setFreeArticleNo(report.article_no);
      setFreeTitle(report.article.anlagenbezeichnung || "");
      setFreeReference(report.free_reference || "");
    } else {
      setFreeArticleNo("");
      setFreeTitle("");
      setFreeReference("");
    }
    setArticleNo(report.article_no);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openServerReport(report: ServerDamageReport) {
    const nextArticleNo = String(report.article_no || report.nr || "");
    const isFree = isFreeServerReport(report);
    setCaptureMode(isFree ? "free" : "catalog");
    setArticle(null);
    setLocalReportId("");
    if (isFree) {
      setFreeArticleNo(nextArticleNo);
      setFreeTitle(report.anlagenbezeichnung || "");
      setFreeReference(report.free_reference || "");
    } else {
      setFreeArticleNo("");
      setFreeTitle("");
      setFreeReference("");
    }
    setArticleNo(nextArticleNo);
    setMessage("Synchronisierten Schaden zum Nachbearbeiten ge\u00f6ffnet");
    window.setTimeout(() => {
      const target = isFree ? freeTitleInputRef.current : articleInputRef.current;
      target?.focus();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 60);
  }

  return (
    <main className="damage-page">
      <section className="damage-hero">
        <div>
          <a className="damage-back-link" href="/">Zurück</a>
          <h1>Schadenerfassung</h1>
          <p>Artikelnummer eingeben, Pflichtfotos sichern, Schaden beschreiben. Alles wird zuerst lokal gespeichert.</p>
        </div>
        <div className="damage-kpis" aria-label="Schadensstatus">
          <span className={`status ${isOnline ? "geprueft" : "pruefen"}`}>{isOnline ? "Online" : "Offline"}</span>
          <strong>{summary.pending} warten auf Sync</strong>
          <small>{catalogCount} Artikel offline bereit</small>
        </div>
      </section>

      <section className="damage-layout">
        <div className="damage-main-column">
        <div className="damage-capture-panel">
          <div className="damage-section-head">
            <div>
              <h2>Aufnahme</h2>
              <span>{existingHint || "Ein Artikel darf lokal nur einmal als Schaden angelegt werden."}</span>
            </div>
            <span className="status erfasst">{teamName || "Team"}</span>
          </div>

          {error ? <p className="status upload_fehler damage-message">{error}</p> : null}
          {message ? <p className="damage-inline-message">{message}</p> : null}

          <div className="damage-mode-toggle" role="group" aria-label="Art der Schadensaufnahme">
            <button type="button" className={captureMode === "catalog" ? "is-active" : ""} onClick={() => switchCaptureMode("catalog")}>
              Listenartikel
            </button>
            <button type="button" className={captureMode === "free" ? "is-active" : ""} onClick={() => switchCaptureMode("free")}>
              Nicht in Liste
            </button>
          </div>

          {captureMode === "catalog" ? (
            <div className="damage-form-grid">
              <label className="field damage-team-field">
                <span>Team</span>
                <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Team 1" />
              </label>
              <label className="field damage-number-field">
                <span>Artikel-Nr. aus Spalte A</span>
                <input
                  ref={articleInputRef}
                  inputMode="numeric"
                  value={articleNo}
                  onChange={(event) => setArticleNo(event.target.value.replace(/[^\d]/g, ""))}
                  placeholder="z. B. 811"
                  autoFocus
                />
              </label>
            </div>
          ) : (
            <div className="damage-form-grid damage-free-grid">
              <label className="field damage-team-field">
                <span>Team</span>
                <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Team 1" />
              </label>
              <label className="field damage-free-title-field">
                <span>Bezeichnung</span>
                <input
                  ref={freeTitleInputRef}
                  value={freeTitle}
                  onChange={(event) => setFreeTitle(event.target.value)}
                  placeholder="z. B. unbekannte Maschine Waschhalle"
                />
              </label>
              <label className="field damage-free-reference-field">
                <span>Hinweis / Referenz</span>
                <input
                  value={freeReference}
                  onChange={(event) => setFreeReference(event.target.value)}
                  placeholder="z. B. Standort, alte Nummer, Fundort"
                />
              </label>
            </div>
          )}

          <div className={`damage-article-box ${article ? "is-found" : ""}`}>
            {article ? (
              <>
                <strong>{article.anlagenbezeichnung}</strong>
                {captureMode === "free" ? (
                  <>
                    <span>Nicht in Liste / interne Nr. {article.nr}</span>
                    {freeReference.trim() ? <span>Hinweis: {freeReference.trim()}</span> : null}
                  </>
                ) : (
                  <>
                    <span>Nr. {article.nr} / Buchungskreis {article.buchungskreis}</span>
                    <span>Aktivdatum {articleDate(article) || "offen"} / Alter {article.alter ?? "offen"}</span>
                  </>
                )}
                {serverReportForArticle ? (
                  <span className="damage-server-hit">
                    Bereits synchronisiert: {serverReportForArticle.team_name || "Team offen"} / {formatDateTime(serverReportForArticle.updated_at || serverReportForArticle.captured_at || undefined)}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <strong>{captureMode === "free" ? "Freien Schaden vorbereiten" : "Artikel suchen"}</strong>
                <span>
                  {captureMode === "free"
                    ? "Bezeichnung eingeben, dann Fotos und Beschreibung erfassen."
                    : "Die App gleicht die Nummer mit dem lokalen Excel-Katalog ab."}
                </span>
                {captureMode === "catalog" && articleNo.trim() && catalogReady ? (
                  <button className="damage-inline-action" type="button" onClick={startFreeFromMissingArticle}>
                    Als freien Schaden aufnehmen
                  </button>
                ) : null}
              </>
            )}
          </div>

          <div className="damage-photo-grid">
            {photoSlots.map((slot) => {
              const photo = photoMap.get(slot.type);
              const serverHasPhoto = serverPhotoTypeSet.has(slot.type);
              const required = slot.required || (slot.type === "uvv_sticker" && uvvPhotoRequired);
              return (
                <div className={`damage-photo-slot ${photo || serverHasPhoto ? "has-photo" : ""} ${serverHasPhoto && !photo ? "has-server-photo" : ""} ${required ? "is-required" : ""}`} key={slot.type}>
                  <button
                    type="button"
                    disabled={!article || busy}
                    onClick={() => fileInputs.current[slot.type]?.click()}
                  >
                    {photoPreviews[slot.type] ? <img src={photoPreviews[slot.type]} alt={slot.label} /> : <span>+</span>}
                  </button>
                  <div>
                    <strong>{slot.label}</strong>
                    <small>{serverHasPhoto && !photo ? "am Server" : required ? "Pflicht" : slot.hint}</small>
                    {photo ? <button type="button" disabled={busy} onClick={() => void removePhoto(slot.type)}>Entfernen</button> : null}
                  </div>
                  <input
                    ref={(node) => { fileInputs.current[slot.type] = node; }}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="visually-hidden-file"
                    onChange={(event) => void selectPhoto(slot.type, event)}
                  />
                </div>
              );
            })}
          </div>

          <div className="damage-uvv-row" role="group" aria-label="UVV-Aufkleber vorhanden">
            <span>UVV-Aufkleber vorhanden?</span>
            {(["unklar", "ja", "nein"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={uvvStickerPresent === value ? "is-active" : ""}
                onClick={() => setUvvStickerPresent(value)}
              >
                {value === "unklar" ? "Unklar" : value === "ja" ? "Ja" : "Nein"}
              </button>
            ))}
          </div>

          <label className="field damage-description">
            <span>Ausführliche Schadensbeschreibung</span>
            <textarea
              rows={7}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="z. B. Gehäuse rechts gerissen, Bedienfeld lose, Nutzung nur eingeschränkt möglich..."
            />
          </label>

          <div className="damage-save-bar">
            <button className="btn accent" type="button" disabled={!canSave || busy} onClick={() => void saveLocalOnly()}>
              Lokal sichern
            </button>
            <button className="btn accent" type="button" disabled={!canSave || busy} onClick={() => void saveAndSync()}>
              Speichern & Sync
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => resetCaptureForm()}>
              {captureMode === "free" ? "Neuer freier Schaden" : "Neuer Artikel"}
            </button>
          </div>
        </div>

          <section className="damage-server-section damage-server-main">
            <div className="damage-section-head damage-section-head-action">
              <div>
                <h2>Erfasste Sch&auml;den</h2>
                <span>Direkt nach der Erfassung sichtbar. Zum Nachbearbeiten einen Artikel &ouml;ffnen.</span>
              </div>
              <div className="damage-list-toolbar">
                <button className="btn secondary damage-mini-button" type="button" disabled={serverReportsBusy} onClick={() => void refreshServerReports()}>
                  {serverReportsBusy ? "L\u00e4dt" : "Aktualisieren"}
                </button>
                <button className="btn secondary damage-mini-button" type="button" disabled={busy} onClick={() => void exportExcel()}>
                  Excel-Schadensliste
                </button>
              </div>
            </div>
            <div className="damage-summary-grid damage-server-summary">
              <span><b>{serverReports.length}</b>Artikel</span>
              <span><b>{serverPhotoCount}</b>Fotos</span>
              <span><b>{serverTeamCount}</b>Teams</span>
            </div>
            {serverReportsMessage ? <p className="damage-server-message">{serverReportsMessage}</p> : null}
            <div className="damage-report-list damage-server-report-list">
              {serverReports.map((report) => (
                <button className="damage-report-card damage-server-open-card" type="button" key={report.id} onClick={() => openServerReport(report)}>
                  <span className={`damage-entry-type ${isFreeServerReport(report) ? "is-free" : ""}`}>
                    {isFreeServerReport(report) ? "Nicht in Liste" : "Listenartikel"}
                  </span>
                  <strong>{report.article_no} / {report.anlagenbezeichnung || "Artikel ohne Bezeichnung"}</strong>
                  {report.free_reference ? <span>Hinweis: {report.free_reference}</span> : null}
                  <span>{report.team_name || "Team offen"} / {formatDateTime(report.updated_at || report.captured_at || undefined)}</span>
                  <span>{Number(report.photo_count || 0)} Fotos / UVV {report.uvv_sticker_present || "unklar"}</span>
                  {report.photo_types?.length ? <span>Vorhanden: {report.photo_types.map((type) => photoSlots.find((slot) => slot.type === type)?.label || type).join(", ")}</span> : null}
                  {report.damage_description ? <small>{report.damage_description}</small> : null}
                  <i className="status pruefen">Nachbearbeiten</i>
                </button>
              ))}
              {!serverReports.length && !serverReportsMessage ? <p className="muted">Noch kein synchronisierter Schaden.</p> : null}
            </div>
          </section>
        </div>

        <aside className="damage-side-panel">
          <div className="damage-qr-section">
            <div className="damage-section-head">
              <div>
                <h2>Handys koppeln</h2>
                <span>QR öffnet direkt diese Schadenerfassung.</span>
              </div>
            </div>
            {selectedQrOption ? (
              <>
                {qrOptions.length > 1 ? (
                  <label className="field damage-qr-select">
                    <span>Session</span>
                    <select value={selectedQrOption.id} onChange={(event) => setSelectedQrSessionId(event.target.value)}>
                      {qrOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <strong className="damage-qr-session">{selectedQrOption.label}</strong>
                )}
                <div className="damage-qr-box">
                  <QRCodeSVG value={joinUrl(selectedQrOption.token, "damage")} size={156} />
                </div>
                <small>{selectedQrExpired ? "QR abgelaufen" : selectedQrOption.detail}</small>
                {selectedQrOption.source === "server" ? (
                  <button className="btn secondary" type="button" disabled={qrBusy} onClick={() => void renewSelectedQr()}>
                    QR erneuern
                  </button>
                ) : null}
                {qrMessage ? <span className="damage-qr-note">{qrMessage}</span> : null}
              </>
            ) : (
              <>
                <div className="damage-qr-empty">
                  <strong>Keine offene Session</strong>
                  <span>Session starten, dann erscheint hier der QR.</span>
                </div>
                {qrMessage ? <span className="damage-qr-note">{qrMessage}</span> : null}
              </>
            )}
          </div>

          <div className="damage-server-section">
            <div className="damage-section-head damage-section-head-action">
              <div>
                <h2>Erfasste Schäden</h2>
                <span>Synchronisierte Handy-Aufnahmen vom Server.</span>
              </div>
              <button className="btn secondary damage-mini-button" type="button" disabled={serverReportsBusy} onClick={() => void refreshServerReports()}>
                {serverReportsBusy ? "Lädt" : "Aktualisieren"}
              </button>
            </div>
            <div className="damage-summary-grid">
              <span><b>{serverReports.length}</b>Server</span>
              <span><b>{serverPhotoCount}</b>Fotos</span>
              <span><b>{serverTeamCount}</b>Teams</span>
            </div>
            {serverReportsMessage ? <p className="damage-server-message">{serverReportsMessage}</p> : null}
            <div className="damage-report-list damage-server-report-list">
              {serverReports.slice(0, 18).map((report) => (
                <article className="damage-report-card" key={report.id}>
                  <span className={`damage-entry-type ${isFreeServerReport(report) ? "is-free" : ""}`}>
                    {isFreeServerReport(report) ? "Nicht in Liste" : "Listenartikel"}
                  </span>
                  <strong>{report.article_no} / {report.anlagenbezeichnung || "Artikel ohne Bezeichnung"}</strong>
                  {report.free_reference ? <span>Hinweis: {report.free_reference}</span> : null}
                  <span>{report.team_name || "Team offen"} / {formatDateTime(report.updated_at || report.captured_at || undefined)}</span>
                  <span>{Number(report.photo_count || 0)} Fotos / UVV {report.uvv_sticker_present || "unklar"}</span>
                  {report.damage_description ? <small>{report.damage_description}</small> : null}
                </article>
              ))}
              {!serverReports.length && !serverReportsMessage ? <p className="muted">Noch kein synchronisierter Schaden.</p> : null}
            </div>
          </div>

          <div className="damage-section-head">
            <div>
              <h2>Lokaler Stand</h2>
              <span>Nur dieses Gerät: wichtig für Offline-Aufnahmen.</span>
            </div>
          </div>
          <div className="damage-summary-grid">
            <span><b>{summary.total}</b>Schäden</span>
            <span><b>{summary.synced}</b>Sync ok</span>
            <span><b>{summary.failed + summary.conflict}</b>Prüfen</span>
          </div>
          <button className="btn accent" type="button" disabled={busy || !summary.pending} onClick={() => void syncAll()}>
            Alle offenen synchronisieren
          </button>
          <div className="damage-report-list">
            {reports.slice(0, 16).map((report) => (
              <button key={report.local_report_id} type="button" onClick={() => openReport(report)}>
                {report.entry_type === "free" ? <span className="damage-entry-type is-free">Nicht in Liste</span> : null}
                <strong>{report.article_no} / {report.article.anlagenbezeichnung}</strong>
                {report.free_reference ? <span>Hinweis: {report.free_reference}</span> : null}
                <span>{report.team_name} / {formatDateTime(report.updated_at)}</span>
                <i className={`status ${statusTone(report.sync_status)}`}>{statusLabel(report.sync_status)}</i>
                {report.last_error ? <small>{report.last_error}</small> : null}
              </button>
            ))}
            {!reports.length ? <p className="muted">Noch kein Schaden lokal gespeichert.</p> : null}
          </div>
        </aside>
      </section>
    </main>
  );
}
