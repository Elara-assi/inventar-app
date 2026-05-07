"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, RefObject } from "react";
import { API_BASE, Bootstrap, api, inventoryTypeLabel } from "@/lib/api";

type Joined = {
  session: {
    id: string;
    location_id: string;
    building_id: string;
    room_id: string;
    inventory_type?: string | null;
  };
  device: { id: string };
};

type Item = {
  id: string;
  inventory_id: string;
  temporary_id: string;
  sequence_number?: number;
};

type PhotoType = "object_front" | "object_back" | "type_plate" | "uvv_label" | "condition_detail" | "other";
type FunctionOk = "ja" | "nein" | "nicht_geprueft";
type UvvStatus = "vorhanden" | "nicht_vorhanden" | "nicht_uvv_pflichtig" | "unklar";
type InspectionBook = "ja" | "nein" | "nicht_erforderlich" | "unklar";

const steps = [
  "Objektfoto",
  "Bezeichnung",
  "Typ / Spezifikation",
  "Typenschild",
  "Baujahr",
  "Zustand",
  "Funktion",
  "UVV",
  "Prüfbuch",
  "Bemerkung",
  "Zusammenfassung",
];

const photoLabels: Record<PhotoType, string> = {
  object_front: "Objektfoto",
  object_back: "Rückseite / Detailansicht",
  type_plate: "Typenschild",
  uvv_label: "UVV-Siegel",
  condition_detail: "Zustandsdetail",
  other: "Sonstiges Foto",
};

const photoMaxSide: Record<PhotoType, number> = {
  object_front: 1600,
  object_back: 1600,
  condition_detail: 2400,
  other: 1200,
  type_plate: 2400,
  uvv_label: 2400,
};

type BgaForm = {
  object_type: string;
  specification: string;
  construction_year: string;
  condition: string;
  condition_note: string;
  function_ok: FunctionOk;
  uvv_status: UvvStatus;
  uvv_valid_until: string;
  inspection_book_available: InspectionBook;
  remark: string;
  type_plate_status: "vorhanden" | "nicht_vorhanden" | "uebersprungen" | "nicht_geprueft";
};

const emptyForm: BgaForm = {
  object_type: "",
  specification: "",
  construction_year: "",
  condition: "gebraucht",
  condition_note: "",
  function_ok: "nicht_geprueft",
  uvv_status: "unklar",
  uvv_valid_until: "",
  inspection_book_available: "unklar",
  remark: "",
  type_plate_status: "nicht_geprueft",
};

export default function MobileJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState<Joined | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [objectClassId, setObjectClassId] = useState("");
  const [step, setStep] = useState(0);
  const [activeItem, setActiveItem] = useState<Item | null>(null);
  const [form, setForm] = useState<BgaForm>(emptyForm);
  const [photos, setPhotos] = useState<Array<{ type: PhotoType; id?: string; name: string; size: number; previewUrl?: string }>>([]);
  const [savedItem, setSavedItem] = useState<{ label: string } | null>(null);
  const [message, setMessage] = useState("Bereit");
  const [busy, setBusy] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);

  const fileInputRefs: Record<PhotoType, RefObject<HTMLInputElement | null>> = {
    object_front: useRef<HTMLInputElement>(null),
    object_back: useRef<HTMLInputElement>(null),
    type_plate: useRef<HTMLInputElement>(null),
    uvv_label: useRef<HTMLInputElement>(null),
    condition_detail: useRef<HTMLInputElement>(null),
    other: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    params.then((value) => setToken(value.token));
  }, [params]);

  useEffect(() => {
    api<Bootstrap>("/meta/bootstrap").then((boot) => {
      setBootstrap(boot);
      setObjectClassId(boot.object_classes.find((entry) => entry.slug === "bga")?.id ?? boot.object_classes[0]?.id ?? "");
    }).catch((err) => setMessage(err instanceof Error ? err.message : "Stammdaten nicht erreichbar"));
  }, []);

  useEffect(() => {
    if (!token) return;
    api<Joined>("/sessions/join", {
      method: "POST",
      body: JSON.stringify({ token, device_name: "Handy-Erfassung BGA" }),
    }).then(setJoined).catch((err) => setMessage(err instanceof Error ? err.message : "Join fehlgeschlagen"));
  }, [token]);

  const roomName = useMemo(() => {
    const room = bootstrap?.rooms.find((entry) => entry.id === joined?.session.room_id);
    return room?.name ?? "Raum";
  }, [bootstrap, joined]);
  const inventoryType = joined?.session.inventory_type || "bga";
  const isBgaSession = inventoryType === "bga";

  const canSave = Boolean(activeItem && photos.some((photo) => photo.type === "object_front") && form.object_type.trim());

  async function ensureItem() {
    if (activeItem) return activeItem;
    if (!joined) throw new Error("Session noch nicht gekoppelt");
    if (!isBgaSession) throw new Error(`${inventoryTypeLabel(inventoryType)} ist vorbereitet, aber noch nicht aktiv.`);
    const item = await api<Item>("/items", {
      method: "POST",
      body: JSON.stringify({
        session_id: joined.session.id,
        inventory_type: "bga",
        object_class_id: objectClassId || null,
        object_type: form.object_type || null,
        specification: form.specification || null,
        condition: form.condition,
        function_ok: form.function_ok,
        uvv_status: form.uvv_status,
        inspection_book_available: form.inspection_book_available,
        type_plate_status: form.type_plate_status,
      }),
    });
    setActiveItem(item);
    return item;
  }

  function openCamera(type: PhotoType) {
    if (busy) return;
    const input = fileInputRefs[type].current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  async function compressPhoto(file: File, photoType: PhotoType) {
    if (!file.type.startsWith("image/")) return file;
    const maxSide = photoMaxSide[photoType];
    const quality = photoType === "type_plate" || photoType === "uvv_label" || photoType === "condition_detail" ? 0.9 : 0.86;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }
    const scale = Math.min(maxSide / Math.max(bitmap.width, bitmap.height), 1);
    if (scale >= 1 && file.size <= 1_200_000) {
      bitmap.close?.();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return file;
    const name = `${file.name.replace(/\.[^.]+$/, "") || photoType}.jpg`;
    return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
  }

  function uploadWithProgress(itemId: string, photoType: PhotoType, file: File): Promise<{ id?: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append("file", file);
      xhr.open("POST", `${API_BASE}/items/${itemId}/photos?photo_type=${photoType}`);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve({});
          }
          return;
        }
        reject(new Error(xhr.responseText || `Upload fehlgeschlagen (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Upload fehlgeschlagen"));
      xhr.send(formData);
    });
  }

  async function handlePhotoSelected(type: PhotoType, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    event.target.value = "";
    if (photos.length >= 5) {
      setMessage("Maximal 5 Fotos pro Gegenstand möglich");
      return;
    }
    setBusy(true);
    setUploadProgress(0);
    try {
      setUploadState("Foto wird verkleinert");
      const item = await ensureItem();
      const prepared = await compressPhoto(file, type);
      setUploadState("Foto wird hochgeladen");
      const uploaded = await uploadWithProgress(item.id, type, prepared);
      setPhotos((current) => [...current, { type, id: uploaded.id, name: prepared.name, size: prepared.size, previewUrl: URL.createObjectURL(prepared) }]);
      setMessage(`${photoLabels[type]} gespeichert. KI-Schnellcheck startet im Hintergrund.`);
      api(`/items/${item.id}/ai/run`, { method: "POST", body: "{}" }).catch(() => undefined);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Foto konnte nicht gespeichert werden");
    } finally {
      setBusy(false);
      setUploadState("");
      setUploadProgress(0);
    }
  }

  async function saveObject() {
    if (!canSave || !activeItem || busy) {
      setMessage("Objektfoto und Bezeichnung sind erforderlich.");
      return;
    }
    setBusy(true);
    try {
      await api(`/items/${activeItem.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          inventory_type: "bga",
          object_class_id: objectClassId || null,
          object_type: form.object_type || null,
          specification: form.specification || null,
          construction_year: form.construction_year || null,
          condition: form.condition,
          condition_note: form.condition_note || null,
          function_ok: form.function_ok,
          uvv_status: form.uvv_status,
          uvv_valid_until: form.uvv_valid_until || null,
          inspection_book_available: form.inspection_book_available,
          remark: form.remark || null,
          type_plate_status: form.type_plate_status,
          review_status: "erfasst",
        }),
      });
      const note = [form.object_type, form.specification, form.remark].filter(Boolean).join(" | ");
      if (note) {
        await api(`/items/${activeItem.id}/audio?transcript=${encodeURIComponent(note)}`, { method: "POST" });
      }
      await api(`/items/${activeItem.id}/ai/run?mode=review`, { method: "POST", body: "{}" }).catch(() => undefined);
      const savedLabel = form.object_type || activeItem.inventory_id || activeItem.temporary_id || "Objekt";
      setSavedItem({ label: savedLabel });
      setActiveItem(null);
      setForm(emptyForm);
      setPhotos([]);
      setStep(0);
      setMessage(`${savedLabel} gespeichert. Bereit für nächstes Objekt.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Objekt konnte nicht gespeichert werden");
    } finally {
      setBusy(false);
    }
  }

  function update<K extends keyof BgaForm>(key: K, value: BgaForm[K]) {
    setSavedItem(null);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startNextObject() {
    setSavedItem(null);
    setActiveItem(null);
    setForm(emptyForm);
    setPhotos([]);
    setStep(0);
    setMessage("Bereit für nächstes Objekt");
  }

  const hasObjectPhoto = photos.some((photo) => photo.type === "object_front");
  const summaryBlockers = [
    !hasObjectPhoto ? "Objektfoto fehlt" : "",
    !form.object_type.trim() ? "Bezeichnung fehlt" : "",
  ].filter(Boolean);
  const summaryRework = [
    form.condition === "unklar" ? "Zustand unklar" : "",
    form.function_ok === "nein" ? "Funktion nicht in Ordnung" : "",
    form.function_ok === "nicht_geprueft" ? "Funktion nicht geprüft" : "",
    form.uvv_status === "nicht_vorhanden" ? "UVV nicht vorhanden" : "",
    form.uvv_status === "unklar" ? "UVV klären" : "",
    form.uvv_status === "vorhanden" && !form.uvv_valid_until ? "UVV-Datum offen" : "",
    form.inspection_book_available === "nein" ? "Prüfbuch fehlt" : "",
    form.inspection_book_available === "unklar" ? "Prüfbuch unklar" : "",
    form.type_plate_status === "vorhanden" && !photos.some((photo) => photo.type === "type_plate") ? "Typenschildfoto fehlt" : "",
  ].filter(Boolean);

  return (
    <main className="page grid mobile-capture-page bga-wizard-page">
      <section className="mobile-capture-shell bga-wizard">
        <div className="mobile-room-bar">
          <div>
            <strong>{roomName}</strong>
            <span>{inventoryTypeLabel(inventoryType)}</span>
          </div>
          <span className="live-indicator">Live</span>
        </div>

        {joined && !isBgaSession ? (
          <section className="wizard-card saved-card">
            <h1>{inventoryTypeLabel(inventoryType)}</h1>
            <p>{inventoryTypeLabel(inventoryType)}-Erfassung ist vorbereitet, aber in der Handy-Erfassung noch nicht aktiv.</p>
            <a className="btn secondary" href={`/session/${joined.session.id}`}>Zur Session-Ansicht</a>
          </section>
        ) : null}

        {isBgaSession ? <div className={`capture-status ${busy ? "is-busy" : savedItem ? "is-done" : ""}`}>
          <strong>{busy ? uploadState || "Bitte warten" : savedItem ? "Objekt gespeichert" : `Schritt ${step + 1} von ${steps.length}: ${steps[step]}`}</strong>
          <span>{busy && uploadProgress ? `${uploadProgress}% hochgeladen` : message}</span>
        </div> : null}

        {isBgaSession && busy && uploadProgress ? (
          <div className="upload-meter" aria-label="Upload-Fortschritt">
            <span style={{ width: `${uploadProgress}%` }} />
          </div>
        ) : null}

        {isBgaSession && savedItem ? (
          <section className="wizard-card saved-card">
            <div className="saved-mark">✓</div>
            <h1>Objekt gespeichert</h1>
            <p>{savedItem.label} ist in der Prüfliste sichtbar.</p>
            <button className="btn accent" type="button" onClick={startNextObject}>Nächstes Objekt erfassen</button>
            {joined ? <a className="btn secondary" href={`/session/${joined.session.id}`}>Zur Prüfliste</a> : null}
          </section>
        ) : null}

        {isBgaSession && !savedItem ? <div className="wizard-progress">
          {steps.map((label, index) => (
            <button
              key={label}
              className={index === step ? "is-active" : index < step ? "is-done" : ""}
              type="button"
              onClick={() => setStep(index)}
            >
              {index + 1}
            </button>
          ))}
        </div> : null}

        {isBgaSession && !savedItem && step === 0 ? (
          <WizardCard title="Objektfoto aufnehmen" hint="Objekt vollständig fotografieren. Pflichtfoto.">
            <button className="mobile-photo-stage" type="button" disabled={busy} onClick={() => openCamera("object_front")}>
              <span>Objektfoto aufnehmen</span>
              <small>{photos.filter((photo) => photo.type === "object_front").length ? "Objektfoto gespeichert" : "Pflichtfoto"}</small>
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("object_back")}>
              Rückseite/Detail ergänzen
            </button>
            {photos.length ? <PhotoPreviewList photos={photos} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 1 ? (
          <WizardCard title="Bezeichnung erfassen" hint="Kurz eintragen oder diktieren.">
            <label className="field">
              <span>Bezeichnung</span>
              <input value={form.object_type} onChange={(event) => update("object_type", event.target.value)} placeholder="z. B. Ölschlucker" />
            </label>
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 2 ? (
          <WizardCard title="Typ / Spezifikation" hint="Modell, Hersteller oder technische Daten erfassen.">
            <label className="field">
              <span>Typ / Spezifikation</span>
              <textarea rows={4} value={form.specification} onChange={(event) => update("specification", event.target.value)} placeholder="z. B. Hersteller, Modell, Größe, Traglast, technische Daten" />
            </label>
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 3 ? (
          <WizardCard title="Typenschild fotografieren" hint="Typenschild fotografieren, falls vorhanden.">
            <div className="segmented">
              <button className={form.type_plate_status === "vorhanden" ? "is-active" : ""} onClick={() => update("type_plate_status", "vorhanden")} type="button">vorhanden</button>
              <button className={form.type_plate_status === "nicht_vorhanden" ? "is-active" : ""} onClick={() => update("type_plate_status", "nicht_vorhanden")} type="button">keines</button>
              <button className={form.type_plate_status === "uebersprungen" ? "is-active" : ""} onClick={() => update("type_plate_status", "uebersprungen")} type="button">überspringen</button>
            </div>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("type_plate")}>Typenschildfoto aufnehmen</button>
            {photos.some((photo) => photo.type === "type_plate") ? <PhotoPreviewList photos={photos.filter((photo) => photo.type === "type_plate")} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 4 ? (
          <WizardCard title="Baujahr erfassen" hint="Eintragen, wenn bekannt. Sonst leer lassen.">
            <label className="field">
              <span>Baujahr</span>
              <input inputMode="numeric" value={form.construction_year} onChange={(event) => update("construction_year", event.target.value)} placeholder="z. B. 2018 oder unbekannt" />
            </label>
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 5 ? (
          <WizardCard title="Zustand erfassen" hint="Sichtbaren Zustand auswählen.">
            <label className="field">
              <span>Zustand</span>
              <select value={form.condition} onChange={(event) => update("condition", event.target.value)}>
                <option value="sehr_gut">sehr gut</option>
                <option value="gut">gut</option>
                <option value="gebraucht">gebraucht</option>
                <option value="reparaturbeduerftig">reparaturbedürftig</option>
                <option value="defekt">defekt</option>
                <option value="unklar">unklar</option>
              </select>
            </label>
            <label className="field">
              <span>Zustandsbemerkung</span>
              <textarea rows={3} value={form.condition_note} onChange={(event) => update("condition_note", event.target.value)} placeholder="z. B. stark verschmutzt, beschädigt, funktionsfähig laut Nutzer" />
            </label>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("condition_detail")}>Zustandsfoto ergänzen</button>
            {photos.some((photo) => photo.type === "condition_detail") ? <PhotoPreviewList photos={photos.filter((photo) => photo.type === "condition_detail")} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 6 ? (
          <WizardCard title="Funktion i. O." hint="Funktion kurz bewerten.">
            <div className="choice-grid">
              {[
                ["ja", "Ja"],
                ["nein", "Nein"],
                ["nicht_geprueft", "Nicht geprüft"],
              ].map(([value, label]) => (
                <button key={value} className={form.function_ok === value ? "is-active" : ""} type="button" onClick={() => update("function_ok", value as FunctionOk)}>{label}</button>
              ))}
            </div>
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 7 ? (
          <WizardCard title="UVV / Prüffrist" hint="UVV-Siegel gut lesbar fotografieren.">
            <label className="field">
              <span>UVV Status</span>
              <select value={form.uvv_status} onChange={(event) => update("uvv_status", event.target.value as UvvStatus)}>
                <option value="vorhanden">UVV vorhanden</option>
                <option value="nicht_vorhanden">UVV nicht vorhanden</option>
                <option value="nicht_uvv_pflichtig">nicht UVV-pflichtig</option>
                <option value="unklar">unklar</option>
              </select>
            </label>
            <label className="field">
              <span>UVV gültig bis</span>
              <input type="date" value={form.uvv_valid_until} onChange={(event) => update("uvv_valid_until", event.target.value)} />
            </label>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("uvv_label")}>UVV-Siegel fotografieren</button>
            {photos.some((photo) => photo.type === "uvv_label") ? <PhotoPreviewList photos={photos.filter((photo) => photo.type === "uvv_label")} labels={photoLabels} /> : null}
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 8 ? (
          <WizardCard title="Prüfbuch vorhanden" hint="Prüfbuchstatus auswählen.">
            <label className="field">
              <span>Prüfbuch</span>
              <select value={form.inspection_book_available} onChange={(event) => update("inspection_book_available", event.target.value as InspectionBook)}>
                <option value="ja">Ja</option>
                <option value="nein">Nein</option>
                <option value="nicht_erforderlich">Nicht erforderlich</option>
                <option value="unklar">Unklar</option>
              </select>
            </label>
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 9 ? (
          <WizardCard title="Bemerkung / Diktat" hint="Bemerkung diktieren oder eingeben.">
            <label className="field">
              <span>Bemerkung</span>
              <textarea rows={5} value={form.remark} onChange={(event) => update("remark", event.target.value)} placeholder="z. B. Standortdetail, Zubehör, auffällige Schäden, Nutzerhinweis" />
            </label>
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem && step === 10 ? (
          <WizardCard title="Zusammenfassung" hint="Prüfen, dann speichern.">
            <div className="summary-list">
              <span><b>Bezeichnung</b>{form.object_type || "fehlt"}</span>
              <span><b>Typ/Spezifikation</b>{form.specification || "offen"}</span>
              <span><b>Baujahr</b>{form.construction_year || "offen"}</span>
              <span><b>Zustand</b>{form.condition}</span>
              <span><b>Funktion</b>{form.function_ok}</span>
              <span><b>UVV</b>{form.uvv_status}{form.uvv_valid_until ? ` bis ${form.uvv_valid_until}` : ""}</span>
              <span><b>Prüfbuch</b>{form.inspection_book_available}</span>
              <span><b>Fotos</b>{photos.length}/5</span>
            </div>
            {photos.length ? (
              <div className="photo-summary">
                {photos.map((photo, index) => <span key={`${photo.type}-${index}`}>{photoLabels[photo.type]}</span>)}
              </div>
            ) : null}
            <div className="summary-checks">
              {summaryBlockers.length ? (
                <div className="summary-box danger">
                  <strong>Blockiert Speichern</strong>
                  {summaryBlockers.map((entry) => <span key={entry}>{entry}</span>)}
                </div>
              ) : <div className="summary-box ok"><strong>Speichern möglich</strong><span>Pflichtfoto und Bezeichnung sind vorhanden.</span></div>}
              {summaryRework.length ? (
                <div className="summary-box warn">
                  <strong>Erzeugt Nacharbeit</strong>
                  {summaryRework.map((entry) => <span key={entry}>{entry}</span>)}
                </div>
              ) : <div className="summary-box ok"><strong>Keine automatische Nacharbeit</strong><span>Keine kritischen Hinweise in dieser Aufnahme.</span></div>}
            </div>
            <button className="btn accent" type="button" disabled={!canSave || busy} onClick={saveObject}>Objekt speichern</button>
            <button className="btn secondary" type="button" onClick={() => setStep(0)}>Zurück bearbeiten</button>
          </WizardCard>
        ) : null}

        {isBgaSession && !savedItem ? <div className="wizard-nav">
          <button className="btn secondary" type="button" disabled={step === 0 || busy} onClick={() => setStep((value) => Math.max(0, value - 1))}>Zurück</button>
          <button className="btn" type="button" disabled={step === steps.length - 1 || busy} onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>Weiter</button>
        </div> : null}

        {isBgaSession ? (["object_front", "object_back", "type_plate", "uvv_label", "condition_detail", "other"] as PhotoType[]).map((type) => (
          <input
            key={type}
            ref={fileInputRefs[type]}
            className="visually-hidden-file"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => handlePhotoSelected(type, event)}
          />
        )) : null}

        {isBgaSession && !savedItem && joined ? <a className="btn secondary" href={`/session/${joined.session.id}`}>Tablet-Liste bearbeiten</a> : null}
      </section>
    </main>
  );
}

function WizardCard({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="wizard-card">
      <div>
        <h1>{title}</h1>
        <p>{hint}</p>
      </div>
      {children}
    </section>
  );
}

function PhotoPreviewList({ photos, labels }: { photos: Array<{ type: PhotoType; previewUrl?: string; name: string }>; labels: Record<PhotoType, string> }) {
  return (
    <div className="mobile-photo-previews">
      {photos.map((photo, index) => (
        <div key={`${photo.type}-${photo.name}-${index}`}>
          {photo.previewUrl ? <img src={photo.previewUrl} alt={labels[photo.type]} /> : null}
          <span>{labels[photo.type]}</span>
        </div>
      ))}
    </div>
  );
}
