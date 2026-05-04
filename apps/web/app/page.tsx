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
  created_at?: string;
  item_count?: number;
};

export default function DashboardPage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedRoom, setSelectedRoom] = useState("");
  const [freeRoomName, setFreeRoomName] = useState("");
  const [selectedBuilding, setSelectedBuilding] = useState("");
  const [freeBuildingName, setFreeBuildingName] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [roomDrafts, setRoomDrafts] = useState<Record<string, string>>({});
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
      setRoomDrafts((current) => {
        const next = { ...current };
        for (const room of boot.rooms) next[room.id] = next[room.id] ?? room.name;
        return next;
      });
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

  async function createRoom() {
    const name = newRoomName.trim();
    const buildingId = selectedBuilding || bootstrap?.buildings[0]?.id;
    if (!name || !buildingId) {
      setError("Bitte Raumname und Gebäude auswählen.");
      return;
    }
    try {
      setError("");
      await api("/rooms", {
        method: "POST",
        body: JSON.stringify({ building_id: buildingId, name }),
      });
      setNewRoomName("");
      setMessage("Raum angelegt");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Raum konnte nicht angelegt werden");
    }
  }

  async function updateRoom(roomId: string) {
    const name = roomDrafts[roomId]?.trim();
    if (!name) {
      setError("Raumname darf nicht leer sein.");
      return;
    }
    try {
      setError("");
      await api(`/rooms/${roomId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setMessage("Raum gespeichert");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Raum konnte nicht gespeichert werden");
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

      <section className="panel grid">
        <div>
          <h2>Räume bearbeiten</h2>
          <p className="muted">Räume können hier für die Auswahl vorbereitet oder umbenannt werden.</p>
        </div>
        <div className="grid grid-2">
          <label className="field">
            <span>Gebäude für neuen Raum</span>
            <select value={selectedBuilding} onChange={(event) => setSelectedBuilding(event.target.value)}>
              {bootstrap?.buildings.map((building) => (
                <option key={building.id} value={building.id}>{building.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Neuer Raum</span>
            <input
              value={newRoomName}
              onChange={(event) => setNewRoomName(event.target.value)}
              placeholder="z. B. Reifenlager, Werkstattplatz 4"
            />
          </label>
        </div>
        <button className="btn accent room-action" onClick={createRoom}>Raum anlegen</button>
        <div className="room-list">
          {bootstrap?.rooms.map((room) => {
            const building = bootstrap.buildings.find((entry) => entry.id === room.building_id);
            return (
              <div className="room-row" key={room.id}>
                <div>
                  <strong>{building?.name || "Gebäude"}</strong>
                  <span className="muted">{room.code || "ohne Code"}</span>
                </div>
                <input
                  value={roomDrafts[room.id] ?? room.name}
                  onChange={(event) => setRoomDrafts((current) => ({ ...current, [room.id]: event.target.value }))}
                />
                <button className="btn secondary" onClick={() => updateRoom(room.id)}>Speichern</button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid">
        <div>
          <h2>Raum-Sessions</h2>
          <p className="muted">Hier stehen gestartete Räume. Test-Sessions bleiben sichtbar, bis sie abgeschlossen oder später bereinigt werden.</p>
        </div>
        <div className="grid grid-3">
        {sessions.map((session) => (
          <article className="card" key={session.id}>
            <div className="card-body grid">
              <StatusBadgeShim value={session.status} />
              <strong>{session.room_name || "Raum"}</strong>
              <span className="muted">{session.location_name} / {session.building_name}</span>
              <div className="session-meta">
                <span>{session.item_count ?? 0} Objekte</span>
                <span>{formatDateTime(session.created_at)}</span>
              </div>
              <a className="btn secondary" href={`/session/${session.id}`}>Prüfung öffnen</a>
            </div>
          </article>
        ))}
        </div>
      </section>
    </main>
  );
}

function StatusBadgeShim({ value }: { value: string }) {
  return <span className={`status ${value === "closed" ? "finalisiert" : "pruefen"}`}>{value === "closed" ? "Abgeschlossen" : "Offen"}</span>;
}

function formatDateTime(value?: string) {
  if (!value) return "Startzeit offen";
  return new Date(value).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
