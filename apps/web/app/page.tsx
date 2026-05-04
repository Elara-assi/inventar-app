"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { API_BASE, Bootstrap, api, joinUrl } from "@/lib/api";

type Session = {
  id: string;
  join_token: string;
  location_name?: string;
  building_name?: string;
  room_name?: string;
  status: string;
};

export default function DashboardPage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedRoom, setSelectedRoom] = useState("");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      const boot = await api<Bootstrap>("/meta/bootstrap");
      const list = await api<Session[]>("/sessions");
      setBootstrap(boot);
      setSessions(list);
      setSelectedRoom(boot.rooms[0]?.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "API nicht erreichbar");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function startSession() {
    if (!bootstrap || !selectedRoom) return;
    const room = bootstrap.rooms.find((entry) => entry.id === selectedRoom);
    const building = bootstrap.buildings.find((entry) => entry.id === room?.building_id);
    const location = bootstrap.locations.find((entry) => entry.id === building?.location_id);
    const session = await api<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        location_id: location?.id,
        building_id: building?.id,
        room_id: room?.id,
      }),
    });
    setActiveSession(session);
    await load();
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
          <button className="btn accent" onClick={startSession}>Session starten</button>
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
              <StatusBadgeShim value={session.status} />
              <strong>{session.room_name || "Raum"}</strong>
              <span className="muted">{session.location_name} / {session.building_name}</span>
              <a className="btn secondary" href={`/session/${session.id}`}>Pruefen</a>
              <a className="btn secondary" href={`${API_BASE}/sessions/${session.id}/events`}>Live-Feed</a>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function StatusBadgeShim({ value }: { value: string }) {
  return <span className={`status ${value === "closed" ? "finalisiert" : "pruefen"}`}>{value}</span>;
}
