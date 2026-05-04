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
  const [freeRoomName, setFreeRoomName] = useState("");
  const [selectedBuilding, setSelectedBuilding] = useState("");
  const [freeBuildingName, setFreeBuildingName] = useState("");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    try {
      setError("");
      const boot = await api<Bootstrap>("/meta/bootstrap");
      const list = await api<Session[]>("/sessions");
      setBootstrap(boot);
      setSessions(list);
      setSelectedRoom((current) => current || boot.rooms[0]?.id || "");
      setSelectedBuilding((current) => current || boot.buildings[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "API nicht erreichbar");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function startSession() {
    setError("");
    setMessage("Session wird gestartet...");
    const trimmedRoomName = freeRoomName.trim();
    const trimmedBuildingName = freeBuildingName.trim();
    const room = bootstrap?.rooms.find((entry) => entry.id === selectedRoom);
    const building = bootstrap?.buildings.find((entry) => entry.id === (trimmedRoomName ? selectedBuilding : room?.building_id));
    const location = bootstrap?.locations.find((entry) => entry.id === building?.location_id);
    if (!trimmedRoomName && !room) {
      setError("Bitte Raum auswählen oder freien Raum eingeben.");
      setMessage("");
      return;
    }
    if (!trimmedRoomName && (!building || !location)) {
      setError("Kein Gebäude/Standort für den Raum gefunden.");
      setMessage("");
      return;
    }
    try {
      const session = await api<Session>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          location_id: location?.id,
          building_id: building?.id,
          building_name: trimmedBuildingName || undefined,
          room_id: trimmedRoomName ? undefined : room?.id,
          room_name: trimmedRoomName || undefined,
        }),
      });
      setActiveSession(session);
      setFreeRoomName("");
      setFreeBuildingName("");
      setMessage("Session gestartet");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session konnte nicht gestartet werden");
      setMessage("");
    }
  }

  return (
    <main className="page grid">
      <section className="panel grid grid-2">
        <div className="grid">
          <h1>Raum-Session starten</h1>
          <p className="muted">Prüfer startet den Raum, Erfasser koppeln ihr Handy per QR-Link.</p>
          {error ? <p className="status upload_fehler">{error}</p> : null}
          {message ? <p className="muted">{message}</p> : null}
          <label className="field">
            <span>Raum aus Liste</span>
            <select value={selectedRoom} onChange={(event) => setSelectedRoom(event.target.value)}>
              <option value="">Kein Raum aus Liste</option>
              {bootstrap?.rooms.map((room) => (
                <option key={room.id} value={room.id}>{room.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Freier Raum / neuer Raum</span>
            <input
              value={freeRoomName}
              onChange={(event) => setFreeRoomName(event.target.value)}
              placeholder="z. B. Werkstattplatz 4 oder Serviceannahme"
            />
          </label>
          <label className="field">
            <span>Gebäude aus Liste</span>
            <select value={selectedBuilding} onChange={(event) => setSelectedBuilding(event.target.value)}>
              <option value="">Standard-Gebäude verwenden</option>
              {bootstrap?.buildings.map((building) => (
                <option key={building.id} value={building.id}>{building.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Freies Gebäude / neues Gebäude</span>
            <input
              value={freeBuildingName}
              onChange={(event) => setFreeBuildingName(event.target.value)}
              placeholder="z. B. Werkstatt, Lagerhalle oder Büro"
            />
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
            <a className="btn secondary" href={`/session/${activeSession.id}`}>Live-Prüfung öffnen</a>
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
              <a className="btn secondary" href={`/session/${session.id}`}>Prüfen</a>
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
