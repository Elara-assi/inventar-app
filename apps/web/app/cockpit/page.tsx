"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Inventur-Cockpit: Live-Steuerstand ueber alle Raeume (Roadmap Sprint 1).
 *  Gedacht fuer den grossen Bildschirm waehrend des Inventurtags. */

type CockpitDevice = { device_name: string; last_seen_at?: string | null; pending_count?: number };

type CockpitRoom = {
  session_id: string;
  status: string;
  room_name: string;
  building_name: string;
  location_name: string;
  items: number;
  finalized: number;
  rework: number;
  last_hour: number;
  last_capture_at?: string | null;
  value_sum: number;
  with_photo: number;
  per_hour: number;
  devices: CockpitDevice[];
};

type CockpitData = {
  totals: { today: number; last_hour: number; value_today: number; open_rooms: number; devices_online: number };
  rooms: CockpitRoom[];
  feed: Array<{ captured_at: string; object_type?: string | null; sequence_number?: number | null; room_name: string }>;
};

function relTime(value?: string | null): string {
  if (!value) return "–";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 90) return "gerade eben";
  if (seconds < 3600) return `vor ${Math.round(seconds / 60)} min`;
  return `vor ${Math.round(seconds / 3600)} h`;
}

function deviceOnline(device: CockpitDevice): boolean {
  if (!device.last_seen_at) return false;
  return Date.now() - new Date(device.last_seen_at).getTime() < 90_000;
}

function euro(value: number): string {
  return value ? value.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " €" : "–";
}

export default function CockpitPage() {
  const [data, setData] = useState<CockpitData | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<CockpitData>("/cockpit/overview"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cockpit nicht erreichbar");
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [load]);

  const totals = data?.totals;

  return (
    <main className="cockpit">
      <div className="premium-orbit premium-orbit-a" />
      <div className="premium-orbit premium-orbit-b" />
      <header className="cockpit-head">
        <div>
          <span className="cockpit-kicker">Inventar Maschine · Live</span>
          <h1>Inventur-Cockpit</h1>
        </div>
        <a className="cockpit-back" href="/">Dashboard</a>
      </header>

      {error ? <p className="cockpit-error">{error} – Anmeldung im Dashboard noetig?</p> : null}

      <section className="cockpit-kpis">
        <article><b>{totals?.today ?? "–"}</b><span>Heute erfasst</span></article>
        <article><b>{totals?.last_hour ?? "–"}</b><span>Letzte Stunde</span></article>
        <article><b>{totals?.open_rooms ?? "–"}</b><span>Offene Raeume</span></article>
        <article><b>{totals?.devices_online ?? "–"}</b><span>Geraete aktiv</span></article>
        <article><b>{totals ? euro(totals.value_today) : "–"}</b><span>Wert heute (Schaetzung)</span></article>
      </section>

      <div className="cockpit-grid">
        <section className="cockpit-rooms">
          {(data?.rooms ?? []).map((room) => {
            const progress = room.items ? Math.round((room.finalized / room.items) * 100) : 0;
            return (
              <a key={room.session_id} className={`cockpit-room ${room.status}`} href={`/session/${room.session_id}`}>
                <div className="cockpit-room-head">
                  <div>
                    <b>{room.room_name}</b>
                    <small>{room.location_name} · {room.building_name}</small>
                  </div>
                  <span className={`cockpit-pill ${room.status === "open" ? "live" : "done"}`}>
                    {room.status === "open" ? "LIVE" : "Abgeschlossen"}
                  </span>
                </div>
                <div className="cockpit-room-stats">
                  <span><b>{room.items}</b> Objekte</span>
                  <span><b>{room.per_hour}</b>/h</span>
                  <span><b>{room.with_photo}</b> mit Foto</span>
                  {room.rework ? <span className="warn"><b>{room.rework}</b> Nacharbeit</span> : null}
                  {room.value_sum ? <span><b>{euro(room.value_sum)}</b></span> : null}
                </div>
                <div className="cockpit-bar"><i style={{ width: `${progress}%` }} /></div>
                <div className="cockpit-room-foot">
                  <span>{room.finalized}/{room.items} finalisiert</span>
                  <span>Aktivitaet: {relTime(room.last_capture_at)}</span>
                </div>
                {room.devices.length ? (
                  <div className="cockpit-devices">
                    {room.devices.map((device, index) => (
                      <span key={index} className={deviceOnline(device) ? "on" : "off"}>
                        ● {device.device_name}{device.pending_count ? ` · ${device.pending_count} offen` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </a>
            );
          })}
          {data && !data.rooms.length ? <p className="cockpit-empty">Keine aktiven Raeume. Session im Dashboard starten.</p> : null}
        </section>

        <aside className="cockpit-feed">
          <h2>Live-Verlauf</h2>
          {(data?.feed ?? []).map((entry, index) => (
            <div key={index} className="cockpit-feed-row">
              <span>{relTime(entry.captured_at)}</span>
              <b>{entry.object_type || `Objekt ${entry.sequence_number ?? ""}`}</b>
              <small>{entry.room_name}</small>
            </div>
          ))}
        </aside>
      </div>
    </main>
  );
}
