"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ItemReviewCard, ReviewItem } from "@/components/ItemReviewCard";
import { API_BASE, Bootstrap, api, joinUrl } from "@/lib/api";

type Session = {
  id: string;
  join_token: string;
  location_name: string;
  building_name: string;
  room_name: string;
  status: string;
};

type Filter = "alle" | "blocker" | "offen" | "finalisiert";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const [sessionId, setSessionId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [message, setMessage] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("alle");
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const loadingRef = useRef(false);

  useEffect(() => {
    params.then((value) => setSessionId(value.id));
  }, [params]);

  useEffect(() => {
    api<Bootstrap>("/meta/bootstrap").then(setBootstrap).catch(() => setBootstrap(null));
  }, []);

  const load = useCallback(async () => {
    if (!sessionId || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [sessionData, itemData] = await Promise.all([
        api<Session>(`/sessions/${sessionId}`),
        api<ReviewItem[]>(`/sessions/${sessionId}/items`),
      ]);
      setSession(sessionData);
      setItems(itemData);
      setConnectionError("");
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : "Verbindung verloren");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [sessionId]);

  // Polling: pausiert bei verstecktem Tab (Akku/Last), laeuft sonst alle 3s.
  useEffect(() => {
    if (!sessionId) return;
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 3000);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, load]);

  async function exportExcel() {
    try {
      const result = await api<{ id: string }>(`/sessions/${sessionId}/export/excel`, { method: "POST", body: "{}" });
      setExportUrl(`${API_BASE}/exports/${result.id}/download`);
      setMessage("Export erstellt");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Export fehlgeschlagen");
    }
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
  const finalCount = items.filter((item) => item.review_status === "finalisiert").length;

  const visibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "blocker" && !(item.blockers?.length)) return false;
      if (filter === "finalisiert" && item.review_status !== "finalisiert") return false;
      if (filter === "offen" && item.review_status === "finalisiert") return false;
      if (!term) return true;
      const haystack = [
        item.inventory_id, item.temporary_id, item.object_type, item.object_class_name,
        item.brand, item.model, item.serial_number,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [items, search, filter]);

  return (
    <main className="page grid">
      <section className="panel grid grid-2">
        <div className="grid">
          <h1>{session?.room_name || "Live-Pruefung"}</h1>
          <p className="muted">{session?.location_name} / {session?.building_name}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span className="status pruefen">{items.length} Objekte</span>
            <span className={blockerCount ? "status upload_fehler" : "status finalisierbar"}>{blockerCount} Blocker</span>
            <span className="status finalisiert">{finalCount} finalisiert</span>
            {session?.status === "closed" ? <span className="status finalisiert">Raum abgeschlossen</span> : null}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn accent" onClick={exportExcel}>Excel-Export</button>
            {session?.status !== "closed" ? <button className="btn" onClick={closeRoom}>Raum abschliessen</button> : null}
            {exportUrl ? <a className="btn secondary" href={exportUrl}>Export herunterladen</a> : null}
          </div>
          {message ? <p className="status pruefen">{message}</p> : null}
          {connectionError ? <p className="status upload_fehler">{connectionError}</p> : null}
        </div>
        <div className="qr-box">
          {session && session.status !== "closed" ? (
            <>
              <QRCodeSVG value={joinUrl(session.join_token)} size={190} />
              <span className="muted" style={{ fontSize: 12 }}>Mit dem Handy scannen, um zu erfassen</span>
            </>
          ) : null}
        </div>
      </section>

      <section className="panel filter-bar">
        <input
          className="search-input"
          value={search}
          placeholder="Suchen: ID, Marke, Modell, Seriennummer…"
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="segmented">
          {(["alle", "offen", "blocker", "finalisiert"] as Filter[]).map((entry) => (
            <button
              key={entry}
              className={`segment${filter === entry ? " active" : ""}`}
              onClick={() => setFilter(entry)}
            >
              {entry === "alle" ? `Alle (${items.length})`
                : entry === "offen" ? `Offen (${items.length - finalCount})`
                : entry === "blocker" ? `Mit Blocker (${items.filter((i) => i.blockers?.length).length})`
                : `Finalisiert (${finalCount})`}
            </button>
          ))}
        </div>
      </section>

      {loading ? <p className="muted">Lade Objekte…</p> : null}
      {!loading && !visibleItems.length ? (
        <p className="muted">{items.length ? "Keine Treffer fuer Suche/Filter." : "Noch keine Objekte erfasst. QR-Code mit dem Handy scannen und loslegen."}</p>
      ) : null}

      <section className="grid grid-3">
        {visibleItems.map((item) => (
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
