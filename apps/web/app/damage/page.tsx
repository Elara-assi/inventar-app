"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadApiFile } from "@/lib/api";
import {
  DamageArticle,
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
  const [articleNo, setArticleNo] = useState("");
  const [article, setArticle] = useState<DamageArticle | null>(null);
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
  const fileInputs = useRef<Partial<Record<DamagePhotoType, HTMLInputElement | null>>>({});

  const photoMap = useMemo(() => {
    const map = new Map<DamagePhotoType, DamagePhoto>();
    for (const photo of photos) map.set(photo.photo_type, photo);
    return map;
  }, [photos]);

  const uvvPhotoRequired = uvvStickerPresent === "ja";
  const missingRequiredPhotos = photoSlots
    .filter((slot) => slot.required || (slot.type === "uvv_sticker" && uvvPhotoRequired))
    .filter((slot) => !photoMap.has(slot.type))
    .map((slot) => slot.label);
  const canSave = Boolean(article)
    && Boolean(localReportId)
    && teamName.trim().length > 0
    && description.trim().length >= 3
    && missingRequiredPhotos.length === 0;

  const refreshReports = useCallback(async () => {
    const nextReports = await listDamageReports();
    setReports(nextReports);
    setSummary({
      total: nextReports.length,
      pending: nextReports.filter((report) => ["local", "pending", "uploading"].includes(report.sync_status)).length,
      synced: nextReports.filter((report) => report.sync_status === "synced").length,
      failed: nextReports.filter((report) => report.sync_status === "failed").length,
      conflict: nextReports.filter((report) => report.sync_status === "conflict").length,
    });
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

  useEffect(() => {
    registerDamageServiceWorker();
    setIsOnline(getDamageOnlineStatus());
    const onOnline = () => setIsOnline(true);
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
  }, [refreshReports]);

  useEffect(() => {
    setStoredDamageTeamName(teamName);
  }, [teamName]);

  useEffect(() => {
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
      const existing = await getDamageReportByArticle(normalized);
      if (ignore) return;
      if (existing) {
        setLocalReportId(existing.local_report_id);
        setDescription(existing.description);
        setUvvStickerPresent(existing.uvv_sticker_present);
        setTeamName(existing.team_name || getStoredDamageTeamName());
        setExistingHint("Artikel ist bereits lokal erfasst und wurde zum Bearbeiten geoeffnet.");
        await loadPhotosForReport(existing.local_report_id);
      } else {
        const nextId = createDamageReportId();
        setLocalReportId(nextId);
        setDescription("");
        setUvvStickerPresent("unklar");
        await loadPhotosForReport(nextId);
      }
    }
    resolveArticle().catch((err) => setError(err instanceof Error ? err.message : "Artikel konnte nicht geprueft werden"));
    return () => {
      ignore = true;
    };
  }, [articleNo, catalogReady, loadPhotosForReport]);

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
      setError("Bitte zuerst eine gueltige Artikelnummer eingeben.");
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
      article_no: article.article_no,
      article,
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

  async function saveAndSync() {
    setBusy(true);
    setError("");
    try {
      const saved = await saveCurrentReport();
      if (!saved) return;
      const result = await syncPendingDamageReports(deviceId);
      setMessage(`Sync fertig: ${result.synced} synchronisiert, ${result.failed} Fehler, ${result.conflict} Doppelung`);
      if (result.lastError) setError(result.lastError);
      await refreshReports();
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

  function openReport(report: DamageReport) {
    setArticleNo(report.article_no);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="damage-page">
      <section className="damage-hero">
        <div>
          <a className="damage-back-link" href="/">Zurueck</a>
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

          <div className="damage-form-grid">
            <label className="field damage-team-field">
              <span>Team</span>
              <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Team 1" />
            </label>
            <label className="field damage-number-field">
              <span>Artikel-Nr. aus Spalte A</span>
              <input
                inputMode="numeric"
                value={articleNo}
                onChange={(event) => setArticleNo(event.target.value.replace(/[^\d]/g, ""))}
                placeholder="z. B. 811"
                autoFocus
              />
            </label>
          </div>

          <div className={`damage-article-box ${article ? "is-found" : ""}`}>
            {article ? (
              <>
                <strong>{article.anlagenbezeichnung}</strong>
                <span>Nr. {article.nr} / Buchungskreis {article.buchungskreis}</span>
                <span>Aktivdatum {articleDate(article) || "offen"} / Alter {article.alter ?? "offen"}</span>
              </>
            ) : (
              <>
                <strong>Artikel suchen</strong>
                <span>Die App gleicht die Nummer mit dem lokalen Excel-Katalog ab.</span>
              </>
            )}
          </div>

          <div className="damage-photo-grid">
            {photoSlots.map((slot) => {
              const photo = photoMap.get(slot.type);
              const required = slot.required || (slot.type === "uvv_sticker" && uvvPhotoRequired);
              return (
                <div className={`damage-photo-slot ${photo ? "has-photo" : ""} ${required ? "is-required" : ""}`} key={slot.type}>
                  <button
                    type="button"
                    disabled={!article || busy}
                    onClick={() => fileInputs.current[slot.type]?.click()}
                  >
                    {photoPreviews[slot.type] ? <img src={photoPreviews[slot.type]} alt={slot.label} /> : <span>+</span>}
                  </button>
                  <div>
                    <strong>{slot.label}</strong>
                    <small>{required ? "Pflicht" : slot.hint}</small>
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
            <span>Ausfuehrliche Schadensbeschreibung</span>
            <textarea
              rows={7}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="z. B. Gehaeuse rechts gerissen, Bedienfeld lose, Nutzung nur eingeschraenkt moeglich..."
            />
          </label>

          <div className="damage-save-bar">
            <button className="btn accent" type="button" disabled={!canSave || busy} onClick={() => void saveCurrentReport()}>
              Lokal sichern
            </button>
            <button className="btn accent" type="button" disabled={!canSave || busy} onClick={() => void saveAndSync()}>
              Speichern & Sync
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => {
              setArticleNo("");
              setMessage("Neue Schadensaufnahme bereit");
            }}>
              Neuer Artikel
            </button>
          </div>
        </div>

        <aside className="damage-side-panel">
          <div className="damage-section-head">
            <div>
              <h2>Lokaler Stand</h2>
              <span>Export erst nach Sync vollstaendig auf dem Server.</span>
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
          <button className="btn secondary" type="button" disabled={busy} onClick={() => void exportExcel()}>
            Excel-Schadensliste
          </button>
          <div className="damage-report-list">
            {reports.slice(0, 16).map((report) => (
              <button key={report.local_report_id} type="button" onClick={() => openReport(report)}>
                <strong>{report.article_no} / {report.article.anlagenbezeichnung}</strong>
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
