"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { ItemReviewList, ReviewItem } from "@/components/ItemReviewList";
import { API_BASE, Bootstrap, api, inventoryTypeLabel, joinUrl } from "@/lib/api";

type Session = {
  id: string;
  join_token: string;
  location_name: string;
  building_name: string;
  room_name: string;
  status: string;
  inventory_type?: string | null;
};

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [sessionId, setSessionId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    params.then((value) => setSessionId(value.id));
  }, [params]);

  useEffect(() => {
    api<Bootstrap>("/meta/bootstrap").then(setBootstrap).catch(() => setBootstrap(null));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [sessionId]);

  async function load() {
    try {
      setError("");
      const [sessionData, itemData] = await Promise.all([
        api<Session>(`/sessions/${sessionId}`),
        api<ReviewItem[]>(`/sessions/${sessionId}/items`),
      ]);
      setSession(sessionData);
      setItems(itemData);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session konnte nicht geladen werden");
    }
  }

  async function exportExcel() {
    const result = await api<{ id: string }>(`/sessions/${sessionId}/export/excel`, { method: "POST", body: "{}" });
    window.location.href = `${API_BASE}/exports/${result.id}/download`;
    setMessage("Raumaufnahme als Excel erstellt");
  }

  async function closeRoom() {
    try {
      await api(`/sessions/${sessionId}/close`, { method: "POST", body: "{}" });
      setMessage("Raum abgeschlossen");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Raumabschluss blockiert");
    }
  }

  async function reopenRoom() {
    const reason = window.prompt("Grund für das Wiederöffnen", "Korrektur/Nachtrag nach Raumabschluss");
    if (!reason) return;
    try {
      await api(`/sessions/${sessionId}/reopen`, { method: "POST", body: JSON.stringify({ reason }) });
      setMessage("Raum wieder geöffnet");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Raum konnte nicht wieder geöffnet werden");
    }
  }

  async function runReviewAi() {
    if (session?.status === "closed") {
      setMessage("Raum ist abgeschlossen. Für KI-Prüfung zuerst wieder öffnen.");
      return;
    }
    try {
      const result = await api<{ queued: number }>(`/sessions/${sessionId}/ai/review`, { method: "POST", body: "{}" });
      setMessage(`Prüf-KI für ${result.queued} Gegenstände gestartet`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Prüf-KI konnte nicht gestartet werden");
    }
  }

  const blockerCount = items.reduce((sum, item) => sum + (item.blockers?.length ?? 0), 0);
  const hintCount = items.reduce((sum, item) => sum + (item.process_hints?.length ?? 0), 0);
  const technicalCount = items.filter((item) =>
    item.process_hints?.some((hint) => hint.kind.includes("technical") || hint.kind === "uvv" || hint.kind === "maintenance" || hint.kind === "inspection_book"),
  ).length;
  const aiRunningCount = items.filter((item) =>
    ["ki_wartet", "ki_laeuft", "ki_schnell_wartet", "ki_schnell_laeuft", "ki_pruefung_wartet", "ki_pruefung_laeuft"].includes(item.status ?? ""),
  ).length;
  const aiReviewOpenCount = items.filter((item) => item.status === "ki_pruefung_offen").length;
  const finalCount = items.filter((item) => item.review_status === "finalisiert" || item.status === "finalisiert").length;
  const isClosed = session?.status === "closed";
  const roomStatus = session?.status === "closed" ? "Abgeschlossen" : "Live";

  return (
    <main className="page grid premium-session-page">
      <section className="room-hero">
        <div className="room-hero-main">
          <Link className="btn secondary back-link compact-btn" href="/">← Dashboard</Link>
          {error ? <p className="status upload_fehler">{error}</p> : null}
          <div>
            <span className="eyebrow">{session?.location_name || "Betrieb"} · {session?.building_name || "Gebäude"}</span>
            <h1>{session?.room_name || "Live-Prüfung"}</h1>
            <p className="module-label">Erfassungsart: {inventoryTypeLabel(session?.inventory_type)}</p>
            <p className="muted">
              {items.length
                ? `Automatische Aktualisierung · zuletzt ${lastUpdated?.toLocaleTimeString("de-DE") ?? "-"}`
                : "Noch keine Objekte. Sobald das Handy speichert, füllt sich die Liste automatisch."}
            </p>
            <div className="ai-process-strip" aria-label="KI-Ablauf">
              <span>Upload: Schnellcheck</span>
              <span>danach: automatischer KI-Check</span>
              <span>Prüf-KI: Webrecherche & Schätzung</span>
            </div>
          </div>
        </div>
        <div className="room-hero-actions">
          <span className={isClosed ? "status finalisiert" : "live-indicator"}>{roomStatus}</span>
          <span className="action-help">
            <button className="btn secondary" onClick={runReviewAi} disabled={isClosed}>Prüf-KI starten</button>
            <small>Startet die intensive Prüfung: Webrecherche, Alterslogik und konservative Schätzung. Normale KI-Prüfung läuft nach Upload automatisch.</small>
          </span>
          <span className="action-help">
            <button className="btn secondary" onClick={exportExcel}>Excel-Export</button>
            <small>Erzeugt die Raumaufnahme mit Fotos, Zeitpunkten, Aufnehmer, Prüfer, KI-Herkunft und Nacharbeiten.</small>
          </span>
          {isClosed ? (
            <span className="action-help">
              <button className="btn accent" onClick={reopenRoom}>Raum wieder öffnen</button>
              <small>Hebt die Sperre auf, damit Gegenstände wieder bearbeitet und Handys erneut gekoppelt werden können.</small>
            </span>
          ) : (
            <span className="action-help">
              <button className="btn accent" onClick={closeRoom}>Raum abschließen</button>
              <small>Sperrt den Raum gegen weitere Bearbeitung. Abschluss ist nur sinnvoll, wenn blockierende Vor-Ort-Punkte erledigt sind.</small>
            </span>
          )}
        </div>
      </section>

      <section className="room-workbench">
        <div className="room-main-panel">
          <div className="room-process-grid">
            <ProcessCard label="Erfasst" value={items.length} tone="info" />
            <ProcessCard label="KI läuft" value={aiRunningCount} tone={aiRunningCount ? "warn" : "ok"} />
            <ProcessCard label="Prüf-KI offen" value={aiReviewOpenCount} tone={aiReviewOpenCount ? "warn" : "ok"} />
            <ProcessCard label="Hinweise" value={hintCount} tone={hintCount ? "warn" : "ok"} />
            <ProcessCard label="Technik" value={technicalCount} tone={technicalCount ? "warn" : "ok"} />
            <ProcessCard label="Vor Ort offen" value={blockerCount} tone={blockerCount ? "danger" : "ok"} />
            <ProcessCard label="Finalisiert" value={finalCount} tone="ok" />
          </div>
          {message ? <p className="status pruefen">{message}</p> : null}

          <div className="inventory-list-head">
            <div>
              <span className="live-indicator">Live</span>
              <strong>Gegenstände im Raum</strong>
              <small>{items.length} sichtbar</small>
            </div>
            <p className="muted">
              {isClosed ? "Schreibgeschützt. Für Änderungen den Raum wieder öffnen." : "Direkt bearbeiten, Nacharbeit setzen, exportieren oder finalisieren."}
            </p>
          </div>

          <ItemReviewList
            items={items}
            objectClasses={bootstrap?.object_classes ?? []}
            onChanged={load}
            readOnly={isClosed}
          />
        </div>

        <aside className="pairing-panel">
          <div>
            <strong>Handy koppeln</strong>
            <span>{isClosed ? "Raum ist abgeschlossen. Kopplung ist deaktiviert." : "QR-Code scannen und sofort erfassen."}</span>
          </div>
          <div className="qr-box pairing-qr">
            {session && !isClosed ? <QRCodeSVG value={joinUrl(session.join_token)} size={178} /> : <strong>Gesperrt</strong>}
          </div>
          <div className="pairing-meta">
            <span>Token</span>
            <strong>{session?.join_token || "-"}</strong>
            <span>Raum</span>
            <strong>{session?.room_name || "-"}</strong>
          </div>
        </aside>
      </section>
    </main>
  );
}

function ProcessCard({ label, value, tone }: { label: string; value: number; tone: "info" | "ok" | "warn" | "danger" }) {
  return (
    <div className={`process-card ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
