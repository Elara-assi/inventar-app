"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { PushToTalk } from "@/components/PushToTalk";
import { Bootstrap, FieldRequirement, api } from "@/lib/api";
import { parseDictation } from "@/lib/dictation";
import { compressImage } from "@/lib/image";
import {
  CachedSession,
  CaptureRecord,
  ensurePersistentStorage,
  getCachedSession,
  kvGet,
  kvSet,
  onOfflineChange,
  outboxAll,
  outboxAdd,
  outboxCount,
  storageUsageRatio,
} from "@/lib/offline";
import { processOutbox, retryQuarantined, startSyncLoop } from "@/lib/sync";

/**
 * Gefuehrte Mobile-Erfassung – Offline-First (O1/O2) + Diktat (D1/D2).
 *
 * Lokal zuerst: "Speichern" schreibt die komplette Erfassung in < 100 ms in
 * die IndexedDB-Outbox – mit und ohne Netz identisch. Die Sync-Engine
 * uebertraegt im Hintergrund (idempotent, fortsetzbar, Quarantaene statt
 * Datenverlust). Der fruehere KI-Aufruf im Erfassungspfad ist entfernt;
 * Felder kommen sofort aus dem Diktat-Parser (offline) und spaeter, falls
 * noetig, vom Transkriptions-Worker.
 */

type Joined = { sessionId: string; deviceId: string; roomName: string };

type StepId = "klasse" | "foto" | "code" | "nachweise" | "details" | "pruefen";

const CONDITIONS = [
  { value: "neu", label: "Neu" },
  { value: "sehr_gut", label: "Sehr gut" },
  { value: "gut", label: "Gut" },
  { value: "gebraucht", label: "Gebraucht" },
  { value: "reparaturbeduerftig", label: "Reparatur noetig" },
  { value: "defekt", label: "Defekt" },
  { value: "aussondern", label: "Aussondern" },
];

const EVIDENCE_LABELS: Record<string, string> = {
  nameplate: "Typenschild fotografieren",
  dot: "DOT-Nummer fotografieren",
  serial: "Seriennummer fotografieren",
  condition: "Zustand fotografieren",
  other: "Zusatzfoto",
};

type Capture = {
  objectClassId: string;
  objectPhoto: File | null;
  evidencePhotos: Record<string, File>;
  code: string;
  codeTarget: "serial" | "inventory";
  condition: string;
  manufacturingYear: string;
  transcript: string;
  audioBlob: Blob | null;
  audioMime: string;
  brand: string;
  model: string;
};

const emptyCapture: Capture = {
  objectClassId: "",
  objectPhoto: null,
  evidencePhotos: {},
  code: "",
  codeTarget: "serial",
  condition: "gebraucht",
  manufacturingYear: "",
  transcript: "",
  audioBlob: null,
  audioMime: "",
  brand: "",
  model: "",
};

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

function PhotoInput({
  label,
  file,
  onFile,
}: {
  label: string;
  file: File | null;
  onFile: (file: File | null) => void;
}) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="photo-input">
      {preview ? (
        <div className="photo-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={label} />
        </div>
      ) : null}
      <label className={`btn ${preview ? "secondary" : "accent"} big file-btn`}>
        {preview ? "Foto wiederholen" : label}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={async (event) => {
            const selected = event.target.files?.[0] ?? null;
            onFile(selected ? await compressImage(selected) : null);
          }}
        />
      </label>
    </div>
  );
}

function OutboxRow({ record, onRetry }: { record: CaptureRecord; onRetry: () => void }) {
  const [thumb, setThumb] = useState("");
  useEffect(() => {
    const photo = record.photos.find((entry) => entry.type === "object");
    if (!photo) return;
    const url = URL.createObjectURL(photo.blob);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [record]);
  return (
    <div className={`outbox-row ${record.state}`}>
      {thumb ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={thumb} alt="" />
      ) : (
        <div className="outbox-thumb-empty" />
      )}
      <div className="outbox-info">
        <strong>{record.label}</strong>
        <span className="muted">
          {record.state === "wartet" ? "Wartet auf Uebertragung"
            : record.state === "sync" ? "Wird uebertragen…"
            : `Abgelehnt: ${record.error ?? "unbekannt"}`}
        </span>
      </div>
      {record.state === "quarantaene" ? (
        <button className="btn secondary" onClick={onRetry}>Erneut</button>
      ) : null}
    </div>
  );
}

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const online = useOnline();
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [joinError, setJoinError] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [requirements, setRequirements] = useState<FieldRequirement[]>([]);
  const [capture, setCapture] = useState<Capture>(emptyCapture);
  const [stepIndex, setStepIndex] = useState(0);
  const [syncedCount, setSyncedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastInventoryId, setLastInventoryId] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [outboxRecords, setOutboxRecords] = useState<CaptureRecord[]>([]);
  const [storageWarning, setStorageWarning] = useState(false);
  const [saving, setSaving] = useState(false);
  const manualEdits = useRef<Set<string>>(new Set());

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

  // ---- Join: erst Cache (offline-faehig), sonst online koppeln ------------
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const cached = await getCachedSession(token);
      if (cached && !cancelled) {
        setJoined({ sessionId: cached.sessionId, deviceId: cached.deviceId, roomName: cached.roomName });
      }
      if (!navigator.onLine) {
        if (!cached && !cancelled) setJoinError("Offline und noch nie gekoppelt – einmal mit Netz oeffnen.");
        return;
      }
      try {
        const result = await api<{ session: { id: string; room_id: string }; device: { id: string } }>(
          "/sessions/join",
          { method: "POST", body: JSON.stringify({ token, device_name: "Handy-Erfassung" }) },
        );
        const boot = await api<Bootstrap>("/meta/bootstrap");
        const reqs = await api<FieldRequirement[]>("/meta/field-requirements");
        const roomName = boot.rooms.find((room) => room.id === result.session.room_id)?.name ?? "Raum";
        const session: CachedSession = {
          token,
          sessionId: result.session.id,
          deviceId: result.device.id,
          roomName,
          joinedAt: Date.now(),
        };
        await Promise.all([kvSet("session", session), kvSet("bootstrap", boot), kvSet("requirements", reqs)]);
        if (!cancelled) {
          setJoined({ sessionId: session.sessionId, deviceId: session.deviceId, roomName });
          setBootstrap(boot);
          setRequirements(reqs);
          setJoinError("");
        }
      } catch (err) {
        if (!cached && !cancelled) {
          setJoinError(err instanceof Error ? err.message : "Join fehlgeschlagen");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ---- Stammdaten aus dem Cache (offline) ----------------------------------
  useEffect(() => {
    (async () => {
      if (!bootstrap) {
        const cachedBoot = await kvGet<Bootstrap>("bootstrap");
        if (cachedBoot) setBootstrap(cachedBoot);
      }
      if (!requirements.length) {
        const cachedReqs = await kvGet<FieldRequirement[]>("requirements");
        if (cachedReqs) setRequirements(cachedReqs);
      }
      setSyncedCount((await kvGet<number>("syncedCount")) ?? 0);
    })();
    ensurePersistentStorage();
  }, [bootstrap, requirements.length]);

  // ---- Outbox-Status + Sync-Engine -----------------------------------------
  const refreshOutbox = useCallback(async () => {
    setPendingCount(await outboxCount());
    setOutboxRecords(await outboxAll());
    setSyncedCount((await kvGet<number>("syncedCount")) ?? 0);
    const ratio = await storageUsageRatio();
    setStorageWarning(ratio !== null && ratio > 0.8);
  }, []);

  useEffect(() => {
    refreshOutbox();
    const unsubscribe = onOfflineChange(refreshOutbox);
    return unsubscribe;
  }, [refreshOutbox]);

  useEffect(() => {
    if (!joined) return;
    const stopSync = startSyncLoop({
      onRecordSynced: (_record, inventoryId) => setLastInventoryId(inventoryId),
    });
    return stopSync;
  }, [joined]);

  // ---- Geraete-Heartbeat (Vertrauens-UI beim Pruefer) -----------------------
  useEffect(() => {
    if (!joined) return;
    const send = () => {
      if (!navigator.onLine) return;
      outboxCount().then((pending) =>
        api(`/sessions/${joined.sessionId}/devices/${joined.deviceId}/heartbeat`, {
          method: "POST",
          body: JSON.stringify({ pending_count: pending }),
        }).catch(() => undefined),
      );
    };
    send();
    const interval = setInterval(send, 30000);
    return () => clearInterval(interval);
  }, [joined]);

  const selectedClass = useMemo(
    () => bootstrap?.object_classes.find((entry) => entry.id === capture.objectClassId) ?? null,
    [bootstrap, capture.objectClassId],
  );

  const evidenceTypes = useMemo(() => {
    if (!capture.objectClassId) return [];
    const types = requirements
      .filter((req) => req.object_class_id === capture.objectClassId)
      .filter((req) => req.evidence_photo_type && req.evidence_photo_type !== "object")
      .map((req) => req.evidence_photo_type as string);
    return [...new Set(types)];
  }, [requirements, capture.objectClassId]);

  const steps: StepId[] = useMemo(() => {
    const base: StepId[] = ["klasse", "foto", "code"];
    if (evidenceTypes.length) base.push("nachweise");
    base.push("details", "pruefen");
    return base;
  }, [evidenceTypes]);

  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const goNext = useCallback(() => setStepIndex((value) => Math.min(value + 1, steps.length - 1)), [steps.length]);
  const goBack = useCallback(() => setStepIndex((value) => Math.max(value - 1, 0)), []);

  function update<K extends keyof Capture>(key: K, value: Capture[K], manual = true) {
    if (manual) manualEdits.current.add(key);
    setCapture((prev) => ({ ...prev, [key]: value }));
  }

  // ---- Diktat-Parser: fuellt leere Felder live aus dem Transkript -----------
  const parsed = useMemo(
    () => (capture.transcript.trim() ? parseDictation(capture.transcript, bootstrap?.brands ?? []) : null),
    [capture.transcript, bootstrap],
  );

  useEffect(() => {
    if (!parsed) return;
    setCapture((prev) => {
      const next = { ...prev };
      if (parsed.brand && !manualEdits.current.has("brand")) next.brand = parsed.brand;
      if (parsed.model && !manualEdits.current.has("model")) next.model = parsed.model;
      if (parsed.serial_number && !manualEdits.current.has("code") && !prev.code) {
        next.code = parsed.serial_number;
        next.codeTarget = "serial";
      }
      if (parsed.manufacturing_year && !manualEdits.current.has("manufacturingYear")) {
        next.manufacturingYear = String(parsed.manufacturing_year);
      }
      if (parsed.condition && !manualEdits.current.has("condition")) next.condition = parsed.condition;
      if (parsed.object_class_slug && !manualEdits.current.has("objectClassId") && !prev.objectClassId) {
        const match = bootstrap?.object_classes.find((entry) => entry.slug === parsed.object_class_slug);
        if (match) next.objectClassId = match.id;
      }
      return next;
    });
  }, [parsed, bootstrap]);

  function applyScannedCode(code: string) {
    const isInventoryLabel = /^SHR-/i.test(code);
    update("code", code);
    update("codeTarget", isInventoryLabel ? "inventory" : "serial");
    setScannerOpen(false);
  }

  // ---- Speichern: lokal zuerst (< 100 ms), Sync laeuft im Hintergrund -------
  async function saveCapture() {
    if (!joined || saving) return;
    setSaving(true);
    try {
      const photos: CaptureRecord["photos"] = [];
      if (capture.objectPhoto) photos.push({ type: "object", blob: capture.objectPhoto, name: capture.objectPhoto.name || "object.jpg" });
      for (const [type, file] of Object.entries(capture.evidencePhotos)) {
        photos.push({ type, blob: file, name: file.name || `${type}.jpg` });
      }
      const record: CaptureRecord = {
        clientCaptureId: crypto.randomUUID(),
        sessionId: joined.sessionId,
        createdAt: Date.now(),
        state: "wartet",
        attempts: 0,
        objectClassId: capture.objectClassId || null,
        condition: capture.condition,
        brand: capture.brand.trim() || null,
        model: capture.model.trim() || null,
        serialNumber: capture.codeTarget === "serial" && capture.code ? capture.code : null,
        inventoryId: capture.codeTarget === "inventory" && capture.code ? capture.code : null,
        manufacturingYear: capture.manufacturingYear ? parseInt(capture.manufacturingYear, 10) : null,
        transcript: capture.transcript.trim() || null,
        audio: capture.audioBlob ? { blob: capture.audioBlob, mime: capture.audioMime } : null,
        photos,
        progress: { itemId: null, photosDone: [], audioDone: false },
        label: selectedClass?.name ?? "Objekt",
      };
      await outboxAdd(record);
      setLastInventoryId("");
      setCapture(emptyCapture);
      manualEdits.current = new Set();
      setStepIndex(0);
      if (navigator.onLine) void processOutbox();
    } finally {
      setSaving(false);
    }
  }

  // ---- Renderzweige ----------------------------------------------------------

  if (joinError && !joined) {
    return (
      <main className="page mobile-shell">
        <section className="panel grid">
          <h1>Kopplung fehlgeschlagen</h1>
          <p className="status upload_fehler">{joinError}</p>
          <p className="muted">QR-Code auf dem Pruefer-Bildschirm neu scannen oder neuen Join-Link anfordern.</p>
        </section>
      </main>
    );
  }

  if (!joined) {
    return (
      <main className="page mobile-shell">
        <section className="panel grid">
          <h1>Verbinde…</h1>
          <p className="muted">Handy wird mit der Raum-Session gekoppelt.</p>
        </section>
      </main>
    );
  }

  const quarantined = outboxRecords.filter((record) => record.state === "quarantaene").length;

  return (
    <main className="page mobile-shell">
      <header className="wizard-head">
        <div>
          <strong>{joined.roomName}</strong>
          <span className="muted"> · {syncedCount} uebertragen</span>
        </div>
        <button className={`net-pill ${online ? "online" : "offline"}`} onClick={() => setOutboxOpen((value) => !value)}>
          <span className="net-dot" aria-hidden />
          {online ? "Online" : "Offline"}{pendingCount ? ` · ${pendingCount} warten` : ""}
        </button>
      </header>
      <div className="wizard-progress" aria-hidden>
        <div className="wizard-progress-fill" style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} />
      </div>

      {storageWarning ? (
        <p className="status upload_fehler">Speicher fast voll – bei naechster Gelegenheit synchronisieren.</p>
      ) : null}
      {quarantined && !outboxOpen ? (
        <button className="status upload_fehler" onClick={() => setOutboxOpen(true)} style={{ border: 0, cursor: "pointer" }}>
          {quarantined} Erfassung(en) abgelehnt – antippen zum Pruefen
        </button>
      ) : null}
      {lastInventoryId && step === "klasse" && !outboxOpen ? (
        <p className="status finalisierbar">Uebertragen: {lastInventoryId}</p>
      ) : null}

      {outboxOpen ? (
        <section className="panel grid wizard-step">
          <h1>Warteschlange</h1>
          <p className="muted">
            {pendingCount
              ? "Diese Objekte sind lokal gesichert und werden automatisch uebertragen, sobald Netz da ist."
              : "Alles uebertragen. Nichts wartet."}
          </p>
          {outboxRecords.map((record) => (
            <OutboxRow key={record.clientCaptureId} record={record} onRetry={() => retryQuarantined(record)} />
          ))}
          <div className="wizard-nav">
            <button className="btn ghost" onClick={() => setOutboxOpen(false)}>Zurueck zur Erfassung</button>
            <button className="btn accent" onClick={() => void processOutbox()} disabled={!online || !pendingCount}>
              Jetzt synchronisieren
            </button>
          </div>
        </section>
      ) : null}

      {!outboxOpen && step === "klasse" ? (
        <section className="panel grid wizard-step">
          <h1>Was erfasst du?</h1>
          <div className="tile-grid">
            {bootstrap?.object_classes.map((entry) => (
              <button
                key={entry.id}
                className={`tile${capture.objectClassId === entry.id ? " active" : ""}`}
                onClick={() => {
                  update("objectClassId", entry.id);
                  goNext();
                }}
              >
                {entry.name}
              </button>
            ))}
            <button
              className="tile muted-tile"
              onClick={() => {
                update("objectClassId", "", false);
                goNext();
              }}
            >
              Unbekannt – spaeter klaeren
            </button>
          </div>
        </section>
      ) : null}

      {!outboxOpen && step === "foto" ? (
        <section className="panel grid wizard-step">
          <h1>Objektfoto</h1>
          <p className="muted">{selectedClass ? selectedClass.name : "Objekt"} komplett aufnehmen.</p>
          <PhotoInput label="Foto aufnehmen" file={capture.objectPhoto} onFile={(file) => update("objectPhoto", file, false)} />
          <div className="wizard-nav">
            <button className="btn ghost" onClick={goBack}>Zurueck</button>
            {capture.objectPhoto ? (
              <button className="btn accent big" onClick={goNext}>Weiter</button>
            ) : (
              <button className="btn secondary" onClick={goNext}>Ohne Foto weiter</button>
            )}
          </div>
        </section>
      ) : null}

      {!outboxOpen && step === "code" ? (
        <section className="panel grid wizard-step">
          <h1>Code scannen</h1>
          <p className="muted">Inventaretikett oder Seriennummer-Barcode. Ohne Code einfach weiter.</p>
          {scannerOpen ? (
            <BarcodeScanner onDetected={applyScannedCode} onClose={() => setScannerOpen(false)} />
          ) : (
            <button className="btn accent big" onClick={() => setScannerOpen(true)}>Scanner starten</button>
          )}
          <label className="field">
            <span>Code (gescannt oder manuell)</span>
            <input
              value={capture.code}
              inputMode="text"
              autoCapitalize="characters"
              placeholder="z. B. SHR-SIM-2026-000123 oder S/N"
              onChange={(event) => update("code", event.target.value)}
            />
          </label>
          {capture.code ? (
            <div className="segmented">
              <button
                className={`segment${capture.codeTarget === "serial" ? " active" : ""}`}
                onClick={() => update("codeTarget", "serial")}
              >
                Seriennummer
              </button>
              <button
                className={`segment${capture.codeTarget === "inventory" ? " active" : ""}`}
                onClick={() => update("codeTarget", "inventory")}
              >
                Inventar-Nr.
              </button>
            </div>
          ) : null}
          <div className="wizard-nav">
            <button className="btn ghost" onClick={goBack}>Zurueck</button>
            <button className="btn accent big" onClick={goNext}>{capture.code ? "Weiter" : "Ohne Code weiter"}</button>
          </div>
        </section>
      ) : null}

      {!outboxOpen && step === "nachweise" ? (
        <section className="panel grid wizard-step">
          <h1>Pflicht-Nachweise</h1>
          <p className="muted">{selectedClass?.name}: diese Fotos verlangt die Pruefung.</p>
          {evidenceTypes.map((type) => (
            <div key={type} className="grid">
              <strong>{EVIDENCE_LABELS[type] ?? type}</strong>
              <PhotoInput
                label="Foto aufnehmen"
                file={capture.evidencePhotos[type] ?? null}
                onFile={(file) => {
                  setCapture((prev) => {
                    const next = { ...prev.evidencePhotos };
                    if (file) next[type] = file;
                    else delete next[type];
                    return { ...prev, evidencePhotos: next };
                  });
                }}
              />
            </div>
          ))}
          <div className="wizard-nav">
            <button className="btn ghost" onClick={goBack}>Zurueck</button>
            <button className="btn accent big" onClick={goNext}>
              {evidenceTypes.every((type) => capture.evidencePhotos[type]) ? "Weiter" : "Weiter (fehlende werden Blocker)"}
            </button>
          </div>
        </section>
      ) : null}

      {!outboxOpen && step === "details" ? (
        <section className="panel grid wizard-step">
          <h1>Diktat & Zustand</h1>
          <p className="muted dictation-hint">
            Diktiere: Marke … Typ … Baujahr … Seriennummer … Zustand …
          </p>
          <PushToTalk onChange={(blob, mime) => {
            update("audioBlob", blob, false);
            update("audioMime", mime, false);
          }} />
          <label className="field">
            <span>Transkript / Notiz (fuellt Felder automatisch)</span>
            <textarea
              value={capture.transcript}
              rows={2}
              placeholder="z. B. Hebebuehne Marke Nussbaum Typ Smart Lift Baujahr 2018 Zustand gut"
              onChange={(event) => update("transcript", event.target.value, false)}
            />
          </label>
          {parsed && Object.keys(parsed).length ? (
            <div className="parsed-chips">
              {parsed.object_class_slug ? <span className="status ki_vorgefuellt">Klasse erkannt</span> : null}
              {parsed.brand ? <span className="status ki_vorgefuellt">Marke: {parsed.brand}</span> : null}
              {parsed.model ? <span className="status ki_vorgefuellt">Typ: {parsed.model}</span> : null}
              {parsed.manufacturing_year ? <span className="status ki_vorgefuellt">Baujahr: {parsed.manufacturing_year}</span> : null}
              {parsed.serial_number ? <span className="status ki_vorgefuellt">S/N: {parsed.serial_number}</span> : null}
              {parsed.condition ? <span className="status ki_vorgefuellt">Zustand: {parsed.condition.replaceAll("_", " ")}</span> : null}
            </div>
          ) : null}
          <div className="segmented wrap">
            {CONDITIONS.map((entry) => (
              <button
                key={entry.value}
                className={`segment${capture.condition === entry.value ? " active" : ""}`}
                onClick={() => update("condition", entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="grid grid-2">
            <label className="field">
              <span>Marke</span>
              <input value={capture.brand} onChange={(event) => update("brand", event.target.value)} />
            </label>
            <label className="field">
              <span>Modell/Typ</span>
              <input value={capture.model} onChange={(event) => update("model", event.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Baujahr</span>
            <input
              value={capture.manufacturingYear}
              inputMode="numeric"
              placeholder="z. B. 2018"
              onChange={(event) => update("manufacturingYear", event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            />
          </label>
          <div className="wizard-nav">
            <button className="btn ghost" onClick={goBack}>Zurueck</button>
            <button className="btn accent big" onClick={goNext}>Weiter</button>
          </div>
        </section>
      ) : null}

      {!outboxOpen && step === "pruefen" ? (
        <section className="panel grid wizard-step">
          <h1>Speichern?</h1>
          <ul className="summary-list">
            <li><span>Klasse</span><strong>{selectedClass?.name ?? "Unbekannt"}</strong></li>
            <li><span>Objektfoto</span><strong>{capture.objectPhoto ? "vorhanden" : "fehlt"}</strong></li>
            {evidenceTypes.map((type) => (
              <li key={type}>
                <span>{EVIDENCE_LABELS[type] ?? type}</span>
                <strong>{capture.evidencePhotos[type] ? "vorhanden" : "fehlt"}</strong>
              </li>
            ))}
            <li><span>Code</span><strong>{capture.code ? `${capture.code} (${capture.codeTarget === "inventory" ? "Inventar-Nr." : "S/N"})` : "ohne"}</strong></li>
            {capture.brand || capture.model ? (
              <li><span>Marke/Typ</span><strong>{[capture.brand, capture.model].filter(Boolean).join(" ")}</strong></li>
            ) : null}
            {capture.manufacturingYear ? (
              <li><span>Baujahr</span><strong>{capture.manufacturingYear}</strong></li>
            ) : null}
            <li><span>Zustand</span><strong>{CONDITIONS.find((entry) => entry.value === capture.condition)?.label}</strong></li>
            <li><span>Diktat</span><strong>{capture.audioBlob ? "Audio" : capture.transcript.trim() ? "Text" : "keins"}</strong></li>
          </ul>
          <p className="muted">
            Speichert sofort auf dem Geraet – Uebertragung laeuft automatisch im Hintergrund{online ? "" : ", sobald wieder Netz da ist"}.
          </p>
          <div className="wizard-nav">
            <button className="btn ghost" onClick={goBack} disabled={saving}>Zurueck</button>
            <button className="btn accent big" onClick={saveCapture} disabled={saving}>
              {saving ? "Speichert…" : "Speichern & Naechstes"}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
