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
    setMessage(`Export bereit: ${API_BASE}/exports/${result.id}/download`);
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

  return (
    <main className="page grid">
      <section className="panel grid grid-2">
        <div className="grid">
          <Link className="btn secondary back-link" href="/">Zurück zum Dashboard</Link>
          <h1>{session?.room_name || "Live-Prüfung"}</h1>
          <p className="muted">{session?.location_name} / {session?.building_name}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span className="live-indicator">Live</span>
            <span className="status pruefen">{items.length} Objekte</span>
            <span className={blockerCount ? "status upload_fehler" : "status finalisierbar"}>{blockerCount} Blocker</span>
            <button className="btn accent" onClick={exportExcel}>Excel-Export</button>
            <button className="btn" onClick={closeRoom}>Raum abschließen</button>
          </div>
          <div className="room-process-grid">
            <ProcessCard label="Erfasst" value={items.length} tone="info" />
            <ProcessCard label="KI läuft" value={aiRunningCount} tone={aiRunningCount ? "warn" : "ok"} />
            <ProcessCard label="Hinweise" value={hintCount} tone={hintCount ? "warn" : "ok"} />
            <ProcessCard label="Technik" value={technicalCount} tone={technicalCount ? "warn" : "ok"} />
            <ProcessCard label="Blocker" value={blockerCount} tone={blockerCount ? "danger" : "ok"} />
            <ProcessCard label="Finalisiert" value={finalCount} tone="ok" />
          </div>
          <p className="muted">
            {items.length
              ? `Liste aktualisiert sich automatisch. Zuletzt: ${lastUpdated?.toLocaleTimeString("de-DE") ?? "-"}`
              : "Noch keine Objekte. Sobald das Handy ein Objekt speichert, erscheint es hier automatisch."}
          </p>
          {message ? <p className="status pruefen">{message}</p> : null}
        </div>
        <div className="qr-box">
          {session ? <QRCodeSVG value={joinUrl(session.join_token)} size={190} /> : null}
        </div>
      </section>

      <section className="panel grid">
        <div>
          <h2>Gegenstände im Raum</h2>
          <p className="muted">Liste direkt bearbeiten, speichern, Nacharbeit setzen oder finalisieren.</p>
        </div>
        <ItemReviewList
          items={items}
          objectClasses={bootstrap?.object_classes ?? []}
          onChanged={load}
        />
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
