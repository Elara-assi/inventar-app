"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioRecorder } from "@/components/AudioRecorder";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { Bootstrap, FieldRequirement, api, apiWithRetry } from "@/lib/api";

/**
 * Gefuehrte Mobile-Erfassung (Phase-1-Haertung).
 *
 * Vorher: eine lange Scroll-Seite, Aktionen in beliebiger Reihenfolge,
 * Code-Scan und Sprachaufnahme nur simuliert.
 *
 * Jetzt: ein Schritt pro Bildschirm – Klasse, Foto, Code, Nachweise,
 * Zustand/Sprache, Bestaetigen. Pflicht-Nachweise kommen dynamisch aus
 * field_requirements der gewaehlten Objektklasse. Gespeichert wird erst
 * am Ende in einer Upload-Pipeline mit Retry; ein Abbruch hinterlaesst
 * keine halbfertigen Objekte.
 */

type Joined = {
  session: { id: string; location_id: string; building_id: string; room_id: string };
  device: { id: string };
};

type Item = { id: string; inventory_id: string; temporary_id: string };

type StepId = "klasse" | "foto" | "code" | "nachweise" | "details" | "pruefen";

type UploadState = "wartet" | "laeuft" | "fertig" | "fehler";

type UploadStep = { key: string; label: string; state: UploadState; detail?: string };

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
  transcript: "",
  audioBlob: null,
  audioMime: "",
  brand: "",
  model: "",
};

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
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        />
      </label>
    </div>
  );
}

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [joinError, setJoinError] = useState("");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [requirements, setRequirements] = useState<FieldRequirement[]>([]);
  const [capture, setCapture] = useState<Capture>(emptyCapture);
  const [stepIndex, setStepIndex] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [lastInventoryId, setLastInventoryId] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [uploadSteps, setUploadSteps] = useState<UploadStep[]>([]);
  const [uploading, setUploading] = useState(false);
  const createdItemRef = useRef<Item | null>(null);
  const uploadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

  useEffect(() => {
    api<Bootstrap>("/meta/bootstrap").then(setBootstrap).catch(() => setBootstrap(null));
  }, []);

  useEffect(() => {
    if (!token) return;
    api<Joined>("/sessions/join", {
      method: "POST",
      body: JSON.stringify({ token, device_name: "Handy-Erfassung" }),
    })
      .then((value) => {
        setJoined(value);
        setJoinError("");
      })
      .catch((err) => setJoinError(err instanceof Error ? err.message : "Join fehlgeschlagen"));
  }, [token]);

  // Pflicht-Nachweise der gewaehlten Klasse laden (steuert den Wizard).
  useEffect(() => {
    if (!capture.objectClassId) {
      setRequirements([]);
      return;
    }
    api<FieldRequirement[]>(`/object-classes/${capture.objectClassId}/requirements`)
      .then(setRequirements)
      .catch(() => setRequirements([]));
  }, [capture.objectClassId]);

  const roomName = useMemo(() => {
    const room = bootstrap?.rooms.find((entry) => entry.id === joined?.session.room_id);
    return room?.name ?? "Raum";
  }, [bootstrap, joined]);

  const selectedClass = useMemo(
    () => bootstrap?.object_classes.find((entry) => entry.id === capture.objectClassId) ?? null,
    [bootstrap, capture.objectClassId],
  );

  const evidenceTypes = useMemo(() => {
    const types = requirements
      .filter((req) => req.evidence_photo_type && req.evidence_photo_type !== "object")
      .map((req) => req.evidence_photo_type as string);
    return [...new Set(types)];
  }, [requirements]);

  const steps: StepId[] = useMemo(() => {
    const base: StepId[] = ["klasse", "foto", "code"];
    if (evidenceTypes.length) base.push("nachweise");
    base.push("details", "pruefen");
    return base;
  }, [evidenceTypes]);

  const step = steps[Math.min(stepIndex, steps.length - 1)];

  const goNext = useCallback(() => setStepIndex((value) => Math.min(value + 1, steps.length - 1)), [steps.length]);
  const goBack = useCallback(() => setStepIndex((value) => Math.max(value - 1, 0)), []);

  function update<K extends keyof Capture>(key: K, value: Capture[K]) {
    setCapture((prev) => ({ ...prev, [key]: value }));
  }

  function applyScannedCode(code: string) {
    const isInventoryLabel = /^SHR-/i.test(code);
    setCapture((prev) => ({ ...prev, code, codeTarget: isInventoryLabel ? "inventory" : "serial" }));
    setScannerOpen(false);
  }

  function resetForNext() {
    setCapture(emptyCapture);
    setRequirements([]);
    setUploadSteps([]);
    createdItemRef.current = null;
    uploadedRef.current = new Set();
    setStepIndex(0);
  }

  function buildUploadPlan(): UploadStep[] {
    const plan: UploadStep[] = [{ key: "item", label: "Objekt anlegen", state: "wartet" }];
    if (capture.objectPhoto) plan.push({ key: "photo:object", label: "Objektfoto hochladen", state: "wartet" });
    for (const type of Object.keys(capture.evidencePhotos)) {
      plan.push({ key: `photo:${type}`, label: `${EVIDENCE_LABELS[type] ?? type} hochladen`, state: "wartet" });
    }
    if (capture.audioBlob || capture.transcript.trim()) {
      plan.push({ key: "audio", label: "Sprachnotiz speichern", state: "wartet" });
    }
    plan.push({ key: "ai", label: "KI-Vorschlag anstossen", state: "wartet" });
    return plan;
  }

  function setStepState(key: string, state: UploadState, detail?: string) {
    setUploadSteps((prev) => prev.map((entry) => (entry.key === key ? { ...entry, state, detail } : entry)));
  }

  async function runUpload() {
    if (!joined || uploading) return;
    setUploading(true);
    const plan = uploadSteps.length ? uploadSteps : buildUploadPlan();
    if (!uploadSteps.length) setUploadSteps(plan);
    try {
      // 1) Objekt anlegen (einmalig; bei Retry wird das vorhandene genutzt)
      if (!createdItemRef.current) {
        setStepState("item", "laeuft");
        const body: Record<string, unknown> = {
          session_id: joined.session.id,
          object_class_id: capture.objectClassId || null,
          condition: capture.condition,
          brand: capture.brand.trim() || null,
          model: capture.model.trim() || null,
        };
        if (capture.code) {
          if (capture.codeTarget === "inventory") body.inventory_id = capture.code;
          else body.serial_number = capture.code;
        }
        createdItemRef.current = await apiWithRetry<Item>("/items", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      const item = createdItemRef.current;
      setStepState("item", "fertig", item.inventory_id || item.temporary_id);

      // 2) Fotos
      const photoJobs: Array<[string, File]> = [];
      if (capture.objectPhoto) photoJobs.push(["object", capture.objectPhoto]);
      for (const [type, file] of Object.entries(capture.evidencePhotos)) photoJobs.push([type, file]);
      for (const [type, file] of photoJobs) {
        const key = `photo:${type}`;
        if (uploadedRef.current.has(key)) continue;
        setStepState(key, "laeuft");
        const form = new FormData();
        form.append("file", file, file.name || `${type}.jpg`);
        await apiWithRetry(`/items/${item.id}/photos?photo_type=${type}`, { method: "POST", body: form });
        uploadedRef.current.add(key);
        setStepState(key, "fertig");
      }

      // 3) Sprachnotiz (Audio und/oder Transkript)
      if ((capture.audioBlob || capture.transcript.trim()) && !uploadedRef.current.has("audio")) {
        setStepState("audio", "laeuft");
        const form = new FormData();
        if (capture.audioBlob) {
          const ext = capture.audioMime.includes("mp4") ? "m4a" : capture.audioMime.includes("ogg") ? "ogg" : "webm";
          form.append("file", new File([capture.audioBlob], `notiz.${ext}`, { type: capture.audioMime || "audio/webm" }));
        }
        if (capture.transcript.trim()) form.append("transcript", capture.transcript.trim());
        await apiWithRetry(`/items/${item.id}/audio`, { method: "POST", body: form });
        uploadedRef.current.add("audio");
        setStepState("audio", "fertig");
      }

      // 4) KI anstossen
      if (!uploadedRef.current.has("ai")) {
        setStepState("ai", "laeuft");
        await apiWithRetry(`/items/${item.id}/ai/run`, { method: "POST", body: "{}" });
        uploadedRef.current.add("ai");
        setStepState("ai", "fertig");
      }

      setDoneCount((value) => value + 1);
      setLastInventoryId(item.inventory_id || item.temporary_id);
      resetForNext();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload fehlgeschlagen";
      setUploadSteps((prev) => prev.map((entry) => (entry.state === "laeuft" ? { ...entry, state: "fehler", detail: message } : entry)));
    } finally {
      setUploading(false);
    }
  }

  // ----- Renderzweige -----

  if (joinError) {
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

  const hasUploadError = uploadSteps.some((entry) => entry.state === "fehler");

  return (
    <main className="page mobile-shell">
      <header className="wizard-head">
        <div>
          <strong>{roomName}</strong>
          <span className="muted"> · {doneCount} erfasst</span>
        </div>
        <span className="status pruefen">Schritt {Math.min(stepIndex + 1, steps.length)}/{steps.length}</span>
      </header>
      <div className="wizard-progress" aria-hidden>
        <div className="wizard-progress-fill" style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} />
      </div>
      {lastInventoryId && step === "klasse" ? (
        <p className="status finalisierbar">Gespeichert: {lastInventoryId}</p>
      ) : null}

      {step === "klasse" ? (
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
              className={`tile muted-tile${capture.objectClassId === "" ? "" : ""}`}
              onClick={() => {
                update("objectClassId", "");
                goNext();
              }}
            >
              Unbekannt – KI klaert
            </button>
          </div>
        </section>
      ) : null}

      {step === "foto" ? (
        <section className="panel grid wizard-step">
          <h1>Objektfoto</h1>
          <p className="muted">{selectedClass ? selectedClass.name : "Objekt"} komplett aufnehmen.</p>
          <PhotoInput label="Foto aufnehmen" file={capture.objectPhoto} onFile={(file) => update("objectPhoto", file)} />
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

      {step === "code" ? (
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

      {step === "nachweise" ? (
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

      {step === "details" ? (
        <section className="panel grid wizard-step">
          <h1>Zustand & Notiz</h1>
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
          <AudioRecorder onChange={(blob, mime) => {
            update("audioBlob", blob);
            update("audioMime", mime);
          }} />
          <label className="field">
            <span>Notiz / Transkript (hilft der KI)</span>
            <textarea
              value={capture.transcript}
              rows={2}
              placeholder="z. B. Dell Monitor, Serviceannahme, Zustand gut"
              onChange={(event) => update("transcript", event.target.value)}
            />
          </label>
          <div className="grid grid-2">
            <label className="field">
              <span>Marke (optional)</span>
              <input value={capture.brand} onChange={(event) => update("brand", event.target.value)} />
            </label>
            <label className="field">
              <span>Modell (optional)</span>
              <input value={capture.model} onChange={(event) => update("model", event.target.value)} />
            </label>
          </div>
          <div className="wizard-nav">
            <button className="btn ghost" onClick={goBack}>Zurueck</button>
            <button className="btn accent big" onClick={goNext}>Weiter</button>
          </div>
        </section>
      ) : null}

      {step === "pruefen" ? (
        <section className="panel grid wizard-step">
          <h1>Speichern?</h1>
          <ul className="summary-list">
            <li><span>Klasse</span><strong>{selectedClass?.name ?? "Unbekannt – KI klaert"}</strong></li>
            <li><span>Objektfoto</span><strong>{capture.objectPhoto ? "vorhanden" : "fehlt"}</strong></li>
            {evidenceTypes.map((type) => (
              <li key={type}>
                <span>{EVIDENCE_LABELS[type] ?? type}</span>
                <strong>{capture.evidencePhotos[type] ? "vorhanden" : "fehlt"}</strong>
              </li>
            ))}
            <li><span>Code</span><strong>{capture.code ? `${capture.code} (${capture.codeTarget === "inventory" ? "Inventar-Nr." : "S/N"})` : "ohne"}</strong></li>
            <li><span>Zustand</span><strong>{CONDITIONS.find((entry) => entry.value === capture.condition)?.label}</strong></li>
            <li><span>Sprachnotiz</span><strong>{capture.audioBlob ? "Audio" : capture.transcript.trim() ? "Text" : "keine"}</strong></li>
            {capture.brand || capture.model ? (
              <li><span>Marke/Modell</span><strong>{[capture.brand, capture.model].filter(Boolean).join(" ")}</strong></li>
            ) : null}
          </ul>

          {uploadSteps.length ? (
            <div className="upload-list">
              {uploadSteps.map((entry) => (
                <div key={entry.key} className={`upload-step ${entry.state}`}>
                  <span>{entry.label}</span>
                  <strong>
                    {entry.state === "wartet" ? "…" : entry.state === "laeuft" ? "laeuft" : entry.state === "fertig" ? "OK" : "Fehler"}
                  </strong>
                  {entry.detail && entry.state === "fehler" ? <em>{entry.detail}</em> : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="wizard-nav">
            <button className="btn ghost" onClick={goBack} disabled={uploading}>Zurueck</button>
            <button className="btn accent big" onClick={runUpload} disabled={uploading}>
              {uploading ? "Speichert…" : hasUploadError ? "Erneut versuchen" : "Speichern & Naechstes"}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
