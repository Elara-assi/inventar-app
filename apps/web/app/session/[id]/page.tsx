"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { ItemReviewCard } from "@/components/ItemReviewCard";
import { API_BASE, Bootstrap, api, joinUrl } from "@/lib/api";

type Session = {
  id: string;
  join_token: string;
  location_name: string;
  building_name: string;
  room_name: string;
  status: string;
};

type Item = {
  id: string;
  inventory_id?: string;
  object_type?: string;
  review_status?: string;
  has_object_photo?: boolean;
  object_class_id?: string;
  blockers?: string[];
  open_tasks?: Array<{ id: string; assigned_role: string; missing_field?: string }>;
};

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [sessionId, setSessionId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [items, setItems] = useState<Item[]>([]);
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
      api<Item[]>(`/sessions/${sessionId}/items`),
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

      <section className="grid grid-3">
        {!items.length ? (
          <div className="empty-state">
            <strong>Warte auf mobile Erfassung</strong>
            <span>QR-Code mit dem Handy öffnen, Foto aufnehmen und Sprachnotiz speichern.</span>
          </div>
        ) : null}
        {items.map((item) => (
          <ItemReviewCard
            item={item}
            key={item.id}
            objectClasses={bootstrap?.object_classes ?? []}
            onChanged={load}
          />
        ))}
      </section>
    </main>
  );
}
