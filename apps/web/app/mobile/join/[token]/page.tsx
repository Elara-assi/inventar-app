"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, RefObject } from "react";
import { API_BASE, Bootstrap, api } from "@/lib/api";

type Joined = {
  session: {
    id: string;
    location_id: string;
    building_id: string;
    room_id: string;
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
  object_front: 1200,
  object_back: 1200,
  condition_detail: 1200,
  other: 1200,
  type_plate: 1600,
  uvv_label: 1600,
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
  const [photos, setPhotos] = useState<Array<{ type: PhotoType; id?: string; name: string; size: number }>>([]);
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

  const canSave = Boolean(activeItem && photos.some((photo) => photo.type === "object_front") && form.object_type.trim());

  async function ensureItem() {
    if (activeItem) return activeItem;
    if (!joined) throw new Error("Session noch nicht gekoppelt");
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
    const quality = photoType === "type_plate" || photoType === "uvv_label" ? 0.82 : 0.72;
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
      setPhotos((current) => [...current, { type, id: uploaded.id, name: prepared.name, size: prepared.size }]);
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
      const savedLabel = activeItem.inventory_id || activeItem.temporary_id || "Objekt";
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
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <main className="page grid mobile-capture-page bga-wizard-page">
      <section className="mobile-capture-shell bga-wizard">
        <div className="mobile-room-bar">
          <div>
            <strong>{roomName}</strong>
            <span>Betriebs- und Geschäftsausstattung</span>
          </div>
          <span className="live-indicator">Live</span>
        </div>

        <div className={`capture-status ${busy ? "is-busy" : ""}`}>
          <strong>{busy ? uploadState || "Bitte warten" : `Schritt ${step + 1} von ${steps.length}: ${steps[step]}`}</strong>
          <span>{busy && uploadProgress ? `${uploadProgress}% hochgeladen` : message}</span>
        </div>

        <div className="wizard-progress">
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
        </div>

        {step === 0 ? (
          <WizardCard title="Objektfoto aufnehmen" hint="Fotografiere das Objekt vollständig und gut erkennbar. Das Foto ist Pflicht.">
            <button className="mobile-photo-stage" type="button" disabled={busy} onClick={() => openCamera("object_front")}>
              <span>Objektfoto aufnehmen</span>
              <small>{photos.filter((photo) => photo.type === "object_front").length ? "Objektfoto gespeichert" : "Pflichtfoto"}</small>
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("object_back")}>
              Rückseite / Detailansicht ergänzen
            </button>
          </WizardCard>
        ) : null}

        {step === 1 ? (
          <WizardCard title="Bezeichnung erfassen" hint="Sprich oder schreibe kurz, was erfasst wird, z. B. Ölschlucker, Hebebühne, Werkzeugwagen.">
            <label className="field">
              <span>Bezeichnung</span>
              <input value={form.object_type} onChange={(event) => update("object_type", event.target.value)} placeholder="z. B. Ölschlucker" />
            </label>
          </WizardCard>
        ) : null}

        {step === 2 ? (
          <WizardCard title="Typ / Spezifikation" hint="Falls vorhanden: Modell, Hersteller, Größe, technische Daten oder interne Bezeichnung erfassen.">
            <label className="field">
              <span>Typ / Spezifikation</span>
              <textarea rows={4} value={form.specification} onChange={(event) => update("specification", event.target.value)} placeholder="z. B. Hersteller, Modell, Größe, Traglast, technische Daten" />
            </label>
          </WizardCard>
        ) : null}

        {step === 3 ? (
          <WizardCard title="Typenschild fotografieren" hint="Falls ein Typenschild vorhanden ist, bitte fotografieren. Wenn keines vorhanden ist, überspringen.">
            <div className="segmented">
              <button className={form.type_plate_status === "vorhanden" ? "is-active" : ""} onClick={() => update("type_plate_status", "vorhanden")} type="button">vorhanden</button>
              <button className={form.type_plate_status === "nicht_vorhanden" ? "is-active" : ""} onClick={() => update("type_plate_status", "nicht_vorhanden")} type="button">keines</button>
              <button className={form.type_plate_status === "uebersprungen" ? "is-active" : ""} onClick={() => update("type_plate_status", "uebersprungen")} type="button">überspringen</button>
            </div>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => openCamera("type_plate")}>Typenschildfoto aufnehmen</button>
          </WizardCard>
        ) : null}

        {step === 4 ? (
          <WizardCard title="Baujahr erfassen" hint="Falls unbekannt, leer lassen oder „unbekannt“ auswählen.">
            <label className="field">
              <span>Baujahr</span>
              <input inputMode="numeric" value={form.construction_year} onChange={(event) => update("construction_year", event.target.value)} placeholder="z. B. 2018 oder unbekannt" />
            </label>
          </WizardCard>
        ) : null}

        {step === 5 ? (
          <WizardCard title="Zustand erfassen" hint="Wähle den sichtbaren Zustand. Ergänze eine Bemerkung, wenn etwas auffällt.">
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
          </WizardCard>
        ) : null}

        {step === 6 ? (
          <WizardCard title="Funktion i. O." hint="Wenn Nein oder Nicht geprüft gewählt wird, erzeugt die App automatisch einen Prüfhinweis.">
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

        {step === 7 ? (
          <WizardCard title="UVV / Prüffrist" hint="Fotografiere das UVV-Siegel oder die Prüfplakette gut lesbar, wenn UVV vorhanden ist.">
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
          </WizardCard>
        ) : null}

        {step === 8 ? (
          <WizardCard title="Prüfbuch vorhanden" hint="Wenn Nein oder Unklar gewählt wird, erzeugt die App automatisch einen Prüfhinweis.">
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

        {step === 9 ? (
          <WizardCard title="Bemerkung / Diktat" hint="Ergänze alles, was später für Bewertung, Prüfung oder Nacharbeit wichtig ist.">
            <label className="field">
              <span>Bemerkung</span>
              <textarea rows={5} value={form.remark} onChange={(event) => update("remark", event.target.value)} placeholder="z. B. Standortdetail, Zubehör, auffällige Schäden, Nutzerhinweis" />
            </label>
          </WizardCard>
        ) : null}

        {step === 10 ? (
          <WizardCard title="Zusammenfassung vor Speichern" hint="Prüfe die Angaben. Du kannst jeden Schritt oben korrigieren.">
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
            <button className="btn accent" type="button" disabled={!canSave || busy} onClick={saveObject}>Objekt speichern</button>
            <button className="btn secondary" type="button" onClick={() => setStep(0)}>Zurück bearbeiten</button>
          </WizardCard>
        ) : null}

        <div className="wizard-nav">
          <button className="btn secondary" type="button" disabled={step === 0 || busy} onClick={() => setStep((value) => Math.max(0, value - 1))}>Zurück</button>
          <button className="btn" type="button" disabled={step === steps.length - 1 || busy} onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>Weiter</button>
        </div>

        {(["object_front", "object_back", "type_plate", "uvv_label", "condition_detail", "other"] as PhotoType[]).map((type) => (
          <input
            key={type}
            ref={fileInputRefs[type]}
            className="visually-hidden-file"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => handlePhotoSelected(type, event)}
          />
        ))}

        {joined ? <a className="btn secondary" href={`/session/${joined.session.id}`}>Tablet-Liste bearbeiten</a> : null}
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
