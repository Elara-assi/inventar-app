"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Bootstrap, api, joinUrl } from "@/lib/api";

type Session = {
  id: string;
  join_token: string;
  location_name?: string;
  building_name?: string;
  room_name?: string;
  status: string;
  item_count?: number;
};

export default function DashboardPage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedRoom, setSelectedRoom] = useState("");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  async function load() {
    try {
      const boot = await api<Bootstrap>("/meta/bootstrap");
      const list = await api<Session[]>("/sessions");
      setBootstrap(boot);
      setSessions(list);
      // Fix F5: Raumauswahl nur initial setzen, nicht bei jedem Reload
      // zuruecksetzen (vorher sprang die Auswahl immer auf Raum 1).
      setSelectedRoom((current) => current || (boot.rooms[0]?.id ?? ""));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "API nicht erreichbar");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function startSession() {
    if (!bootstrap || !selectedRoom || starting) return;
    const room = bootstrap.rooms.find((entry) => entry.id === selectedRoom);
    const building = bootstrap.buildings.find((entry) => entry.id === room?.building_id);
    const location = bootstrap.locations.find((entry) => entry.id === building?.location_id);
    if (!room || !building || !location) {
      setError("Raumzuordnung unvollstaendig – Stammdaten pruefen");
      return;
    }
    setStarting(true);
    try {
      const session = await api<Session>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          location_id: location.id,
          building_id: building.id,
          room_id: room.id,
        }),
      });
      setActiveSession(session);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session konnte nicht gestartet werden");
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="page grid">
      <section className="panel grid grid-2">
        <div className="grid">
          <h1>Raum-Session starten</h1>
          <p className="muted">Pruefer startet den Raum, Erfasser koppeln ihr Handy per QR-Link.</p>
          {error ? <p className="status upload_fehler">{error}</p> : null}
          <label className="field">
            <span>Raum</span>
            <select value={selectedRoom} onChange={(event) => setSelectedRoom(event.target.value)}>
              {bootstrap?.rooms.map((room) => (
                <option key={room.id} value={room.id}>{room.name}</option>
              ))}
            </select>
          </label>
          <button className="btn accent" onClick={startSession} disabled={starting}>
            {starting ? "Startet…" : "Session starten"}
          </button>
        </div>
        <div className="grid">
          <div className="qr-box">
            {activeSession ? (
              <QRCodeSVG value={joinUrl(activeSession.join_token)} size={220} />
            ) : (
              <strong>QR erscheint nach Session-Start</strong>
            )}
          </div>
          {activeSession ? (
            <a className="btn secondary" href={`/session/${activeSession.id}`}>Live-Pruefung oeffnen</a>
          ) : null}
        </div>
      </section>

      <section className="grid grid-3">
        {sessions.map((session) => (
          <article className="card" key={session.id}>
            <div className="card-body grid">
              <span className={`status ${session.status === "closed" ? "finalisiert" : "pruefen"}`}>
                {session.status === "closed" ? "abgeschlossen" : "offen"}
              </span>
              <strong>{session.room_name || "Raum"}</strong>
              <span className="muted">{session.location_name} / {session.building_name}</span>
              <span className="muted">{session.item_count ?? 0} Objekte</span>
              <a className="btn secondary" href={`/session/${session.id}`}>Pruefen</a>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
