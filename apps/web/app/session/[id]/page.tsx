"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { ItemReviewList, ReviewItem } from "@/components/ItemReviewList";
import { API_BASE, Bootstrap, api, joinUrl } from "@/lib/api";

type Session = {
  id: string;
  join_token: string;
  location_name: string;
  building_name: string;
  room_name: string;
  status: string;
};

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [sessionId, setSessionId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [message, setMessage] = useState("");
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
    const [sessionData, itemData] = await Promise.all([
      api<Session>(`/sessions/${sessionId}`),
      api<ReviewItem[]>(`/sessions/${sessionId}/items`),
    ]);
    setSession(sessionData);
    setItems(itemData);
    setLastUpdated(new Date());
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

  const blockerCount = items.reduce((sum, item) => sum + (item.blockers?.length ?? 0), 0);
  const hintCount = items.reduce((sum, item) => sum + (item.process_hints?.length ?? 0), 0);
  const technicalCount = items.filter((item) =>
    item.process_hints?.some((hint) => hint.kind.includes("technical") || hint.kind === "uvv" || hint.kind === "maintenance" || hint.kind === "inspection_book"),
  ).length;
  const aiRunningCount = items.filter((item) => item.status === "ki_wartet" || item.status === "ki_laeuft").length;
  const finalCount = items.filter((item) => item.review_status === "finalisiert" || item.status === "finalisiert").length;
  const roomStatus = session?.status === "closed" ? "Abgeschlossen" : "Live";

  return (
    <main className="page grid">
      <section className="room-hero">
        <div className="room-hero-main">
          <Link className="btn secondary back-link compact-btn" href="/">← Dashboard</Link>
          <div>
            <span className="eyebrow">{session?.location_name || "Betrieb"} · {session?.building_name || "Gebäude"}</span>
            <h1>{session?.room_name || "Live-Prüfung"}</h1>
            <p className="muted">
              {items.length
                ? `Automatische Aktualisierung · zuletzt ${lastUpdated?.toLocaleTimeString("de-DE") ?? "-"}`
                : "Noch keine Objekte. Sobald das Handy speichert, füllt sich die Liste automatisch."}
            </p>
          </div>
        </div>
        <div className="room-hero-actions">
          <span className={session?.status === "closed" ? "status finalisiert" : "live-indicator"}>{roomStatus}</span>
          <button className="btn secondary" onClick={exportExcel}>Excel-Export</button>
          <button className="btn accent" onClick={closeRoom}>Raum abschließen</button>
        </div>
      </section>

      <section className="room-workbench">
        <div className="room-main-panel">
          <div className="room-process-grid">
            <ProcessCard label="Erfasst" value={items.length} tone="info" />
            <ProcessCard label="KI läuft" value={aiRunningCount} tone={aiRunningCount ? "warn" : "ok"} />
            <ProcessCard label="Hinweise" value={hintCount} tone={hintCount ? "warn" : "ok"} />
            <ProcessCard label="Technik" value={technicalCount} tone={technicalCount ? "warn" : "ok"} />
            <ProcessCard label="Blocker" value={blockerCount} tone={blockerCount ? "danger" : "ok"} />
            <ProcessCard label="Finalisiert" value={finalCount} tone="ok" />
          </div>
          {message ? <p className="status pruefen">{message}</p> : null}

          <div className="inventory-list-head">
            <div>
              <span className="live-indicator">Live</span>
              <strong>Gegenstände im Raum</strong>
              <small>{items.length} sichtbar</small>
            </div>
            <p className="muted">Direkt bearbeiten, Nacharbeit setzen, exportieren oder finalisieren.</p>
          </div>

          <ItemReviewList
            items={items}
            objectClasses={bootstrap?.object_classes ?? []}
            onChanged={load}
          />
        </div>

        <aside className="pairing-panel">
          <div>
            <strong>Handy koppeln</strong>
            <span>QR-Code scannen und sofort erfassen.</span>
          </div>
          <div className="qr-box pairing-qr">
            {session ? <QRCodeSVG value={joinUrl(session.join_token)} size={178} /> : null}
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
