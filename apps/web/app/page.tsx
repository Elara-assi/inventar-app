"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Bootstrap, api, joinUrl } from "@/lib/api";

type Session = {
  id: string;
  join_token: string;
  room_id?: string;
  location_name?: string;
  building_name?: string;
  room_name?: string;
  status: string;
  created_at?: string;
  item_count?: number;
};

type RoomDraft = {
  name: string;
  building_id: string;
  code: string;
};

export default function DashboardPage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [freeLocationName, setFreeLocationName] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("");
  const [freeRoomName, setFreeRoomName] = useState("");
  const [selectedBuilding, setSelectedBuilding] = useState("");
  const [freeBuildingName, setFreeBuildingName] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [roomDrafts, setRoomDrafts] = useState<Record<string, RoomDraft>>({});
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
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
      setSelectedLocation((current) => current || boot.locations[0]?.id || "");
      setSelectedRoom((current) => current || boot.rooms[0]?.id || "");
      setSelectedBuilding((current) => current || boot.buildings[0]?.id || "");
      setRoomDrafts((current) => {
        const next = { ...current };
        for (const room of boot.rooms) {
          next[room.id] = next[room.id] ?? {
            name: room.name,
            building_id: room.building_id,
            code: room.code ?? "",
          };
        }
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
    const trimmedLocationName = freeLocationName.trim();
    const trimmedRoomName = freeRoomName.trim();
    const trimmedBuildingName = freeBuildingName.trim();
    const room = bootstrap?.rooms.find((entry) => entry.id === selectedRoom);
    const building = bootstrap?.buildings.find((entry) => entry.id === (trimmedRoomName ? selectedBuilding : room?.building_id));
    const location = bootstrap?.locations.find((entry) => entry.id === (building?.location_id || selectedLocation));
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
          location_id: trimmedLocationName ? undefined : location?.id,
          location_name: trimmedLocationName || undefined,
          building_id: trimmedBuildingName ? undefined : building?.id,
          building_name: trimmedBuildingName || undefined,
          room_id: trimmedRoomName ? undefined : room?.id,
          room_name: trimmedRoomName || undefined,
        }),
      });
      setActiveSession(session);
      setFreeLocationName("");
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
    const draft = roomDrafts[roomId];
    const name = draft?.name.trim();
    if (!draft || !name) {
      setError("Raumname darf nicht leer sein.");
      return;
    }
    try {
      setError("");
      await api(`/rooms/${roomId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          building_id: draft.building_id,
          code: draft.code.trim() || undefined,
        }),
      });
      setMessage("Raum gespeichert");
      setEditingRoomId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Raum konnte nicht gespeichert werden");
    }
  }

  async function deleteRoom(roomId: string) {
    const room = bootstrap?.rooms.find((entry) => entry.id === roomId);
    if (!room) return;
    const relatedSessions = sessions.filter((session) => session.room_id === roomId);
    const itemCount = relatedSessions.reduce((sum, session) => sum + (session.item_count ?? 0), 0);
    const confirmed = window.confirm(
      `Raum "${room.name}" wirklich löschen?\n\nDabei werden ${relatedSessions.length} Session(s) und ${itemCount} Gegenstand/Gegenstände dieses Raums aus der Datenbank entfernt.`
    );
    if (!confirmed) return;
    try {
      setError("");
      await api(`/rooms/${roomId}?force=true`, { method: "DELETE" });
      setMessage("Raum gelöscht");
      setEditingRoomId((current) => (current === roomId ? null : current));
      setSelectedRoom((current) => (current === roomId ? "" : current));
      setActiveSession((current) => (relatedSessions.some((session) => session.id === current?.id) ? null : current));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Raum konnte nicht gelöscht werden");
    }
  }

  async function deleteSession(session: Session) {
    const label = session.room_name || "Raum";
    const confirmed = window.confirm(`Session "${label}" wirklich löschen? Dabei werden die erfassten Gegenstände dieser Test-Session aus der Datenbank entfernt.`);
    if (!confirmed) return;
    try {
      setError("");
      await api(`/sessions/${session.id}`, { method: "DELETE" });
      setMessage("Session gelöscht");
      setActiveSession((current) => (current?.id === session.id ? null : current));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session konnte nicht gelöscht werden");
    }
  }

  function startRoomEdit(roomId: string) {
    const room = bootstrap?.rooms.find((entry) => entry.id === roomId);
    if (!room) return;
    setRoomDrafts((current) => ({
      ...current,
      [roomId]: {
        name: room.name,
        building_id: room.building_id,
        code: room.code ?? "",
      },
    }));
    setEditingRoomId(roomId);
  }

  const selectedLocationBuildings = bootstrap?.buildings.filter((building) => !selectedLocation || building.location_id === selectedLocation) ?? [];
  const buildingOptions = selectedLocationBuildings.length ? selectedLocationBuildings : (bootstrap?.buildings ?? []);
  const selectedLocationRooms = bootstrap?.rooms.filter((room) => {
    const building = bootstrap.buildings.find((entry) => entry.id === room.building_id);
    return !selectedLocation || building?.location_id === selectedLocation;
  }) ?? [];
  const roomOptions = selectedLocationRooms.length ? selectedLocationRooms : (bootstrap?.rooms ?? []);

  return (
    <main className="page grid">
      <section className="panel grid grid-2">
        <div className="grid">
          <h1>Raum-Session starten</h1>
          <p className="muted">Prüfer startet den Raum, Erfasser koppeln ihr Handy per QR-Link.</p>
          {error ? <p className="status upload_fehler">{error}</p> : null}
          {message ? <p className="muted">{message}</p> : null}
          <label className="field">
            <span>Betrieb aus Liste</span>
            <select
              value={selectedLocation}
              onChange={(event) => {
                const locationId = event.target.value;
                setSelectedLocation(locationId);
                const firstBuilding = bootstrap?.buildings.find((building) => building.location_id === locationId);
                setSelectedBuilding(firstBuilding?.id || "");
              }}
            >
              <option value="">Kein Betrieb aus Liste</option>
              {bootstrap?.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Freier Betrieb / neuer Betrieb</span>
            <input
              value={freeLocationName}
              onChange={(event) => setFreeLocationName(event.target.value)}
              placeholder="z. B. Autohaus Simmern oder Autohaus Mainz"
            />
          </label>
          <label className="field">
            <span>Raum aus Liste</span>
            <select value={selectedRoom} onChange={(event) => setSelectedRoom(event.target.value)}>
              <option value="">Kein Raum aus Liste</option>
              {roomOptions.map((room) => (
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
              {buildingOptions.map((building) => (
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
            <span>Betrieb für neuen Raum</span>
            <select
              value={selectedLocation}
              onChange={(event) => {
                const locationId = event.target.value;
                setSelectedLocation(locationId);
                const firstBuilding = bootstrap?.buildings.find((building) => building.location_id === locationId);
                setSelectedBuilding(firstBuilding?.id || "");
              }}
            >
              {bootstrap?.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Gebäude für neuen Raum</span>
            <select value={selectedBuilding} onChange={(event) => setSelectedBuilding(event.target.value)}>
              {buildingOptions.map((building) => (
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
            const location = bootstrap.locations.find((entry) => entry.id === building?.location_id);
            const draft = roomDrafts[room.id] ?? { name: room.name, building_id: room.building_id, code: room.code ?? "" };
            const isEditing = editingRoomId === room.id;
            const roomSession = sessions.find((session) => session.room_id === room.id);
            return (
              <div className={`room-row ${isEditing ? "is-editing" : ""}`} key={room.id}>
                <div className="room-summary">
                  <div>
                    <strong>{room.name}</strong>
                    <span>{location?.name || "Betrieb"} / {building?.name || "Gebäude"} / {room.code || "ohne Code"}</span>
                  </div>
                  <div className="room-summary-actions">
                    {roomSession ? (
                      <a className="btn accent compact-btn" href={`/session/${roomSession.id}`}>Inventarliste</a>
                    ) : null}
                    <button className="btn secondary compact-btn" onClick={() => startRoomEdit(room.id)}>Bearbeiten</button>
                    <button
                      className="btn danger icon-btn"
                      onClick={() => deleteRoom(room.id)}
                      title="Raum löschen"
                      aria-label={`Raum ${room.name} löschen`}
                    >
                      🗑
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="room-edit-panel">
                    <label className="field">
                      <span>Raumname</span>
                      <input
                        value={draft.name}
                        onChange={(event) => setRoomDrafts((current) => ({
                          ...current,
                          [room.id]: { ...draft, name: event.target.value },
                        }))}
                      />
                    </label>
                    <label className="field">
                      <span>Gebäude</span>
                      <select
                        value={draft.building_id}
                        onChange={(event) => setRoomDrafts((current) => ({
                          ...current,
                          [room.id]: { ...draft, building_id: event.target.value },
                        }))}
                      >
                        {bootstrap.buildings.map((entry) => (
                          <option key={entry.id} value={entry.id}>{entry.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Code</span>
                      <input
                        value={draft.code}
                        onChange={(event) => setRoomDrafts((current) => ({
                          ...current,
                          [room.id]: { ...draft, code: event.target.value },
                        }))}
                        placeholder="optional"
                      />
                    </label>
                    <div className="room-edit-actions">
                      <button className="btn accent compact-btn" onClick={() => updateRoom(room.id)}>Speichern</button>
                      <button className="btn secondary compact-btn" onClick={() => setEditingRoomId(null)}>Abbrechen</button>
                    </div>
                  </div>
                ) : null}
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
            <article
              className="card clickable-card"
              key={session.id}
              onClick={() => { window.location.href = `/session/${session.id}`; }}
            >
              <div className="card-body grid">
                <StatusBadgeShim value={session.status} />
                <strong>{session.room_name || "Raum"}</strong>
                <span className="muted">{session.location_name || "Betrieb"} / {session.building_name || "Gebäude"}</span>
                <div className="session-meta">
                  <span>{session.item_count ?? 0} Objekte</span>
                  <span>{formatDateTime(session.created_at)}</span>
                </div>
                <div className="session-actions">
                  <span className="btn secondary">Inventarliste öffnen</span>
                  <button
                    className="btn danger icon-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteSession(session);
                    }}
                    title="Session löschen"
                    aria-label={`Session ${session.room_name || "Raum"} löschen`}
                  >
                    🗑
                  </button>
                </div>
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
