"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { API_BASE, Bootstrap, api, joinUrl } from "@/lib/api";

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
  started_by_name?: string | null;
};

type SessionSummary = {
  sessions: number;
  items: number;
  open: number;
  closed: number;
};

type RoomDraft = {
  name: string;
  building_id: string;
  code: string;
};

function cleanText(value?: string | null) {
  return value || "";
}

function sameName(left?: string | null, right?: string | null) {
  return cleanText(left).trim().toLowerCase() === cleanText(right).trim().toLowerCase();
}

function slugEmail(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/gi, ".").replace(/^\.+|\.+$/g, "");
  return `${slug || "erfasser"}@example.local`;
}

export default function DashboardPage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [freeUserName, setFreeUserName] = useState("");
  const [selectedLocation, setSelectedLocation] = useState("");
  const [selectedBuilding, setSelectedBuilding] = useState("");
  const [selectedRoom, setSelectedRoom] = useState("");
  const [freeLocationName, setFreeLocationName] = useState("");
  const [freeBuildingName, setFreeBuildingName] = useState("");
  const [freeRoomName, setFreeRoomName] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newLocationName, setNewLocationName] = useState("");
  const [newBuildingName, setNewBuildingName] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [roomDrafts, setRoomDrafts] = useState<Record<string, RoomDraft>>({});
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [showRoomSuggestions, setShowRoomSuggestions] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
      setSelectedUser((current) => current || boot.users.find((user) => user.roles?.includes("erfasser"))?.id || boot.users[0]?.id || "");
      setSelectedLocation((current) => current || boot.locations[0]?.id || "");
      setSelectedBuilding((current) => current || boot.buildings[0]?.id || "");
      setRoomDrafts((current) => {
        const next = { ...current };
        for (const room of boot.rooms) {
          next[room.id] = next[room.id] ?? { name: room.name, building_id: room.building_id, code: room.code ?? "" };
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

  async function createUser(nameOverride?: string) {
    const name = (nameOverride ?? newUserName).trim();
    if (!name) {
      setError("Bitte Erfassername eingeben.");
      return null;
    }
    try {
      setError("");
      const user = await api<{ id: string }>("/users", {
        method: "POST",
        body: JSON.stringify({ display_name: name, email: slugEmail(name), role_slug: "erfasser" }),
      });
      if (nameOverride !== undefined) setFreeUserName("");
      else setNewUserName("");
      setSelectedUser(user.id);
      setMessage("Erfasser gespeichert");
      await load();
      return user;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erfasser konnte nicht gespeichert werden");
      return null;
    }
  }

  async function createLocation(nameOverride?: string) {
    const name = (nameOverride ?? newLocationName).trim();
    if (!name) {
      setError("Bitte Betriebsname eingeben.");
      return null;
    }
    try {
      setError("");
      const location = await api<{ id: string }>("/locations", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      if (nameOverride !== undefined) setFreeLocationName("");
      else setNewLocationName("");
      setSelectedLocation(location.id);
      setSelectedBuilding("");
      setSelectedRoom("");
      setMessage("Betrieb gespeichert");
      await load();
      return location;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Betrieb konnte nicht gespeichert werden");
      return null;
    }
  }

  async function startSession() {
    setError("");
    setMessage("Session wird gestartet...");
    const userName = freeUserName.trim();
    const locationName = freeLocationName.trim();
    const buildingName = freeBuildingName.trim();
    const roomName = freeRoomName.trim();

    const exactUser = bootstrap?.users.find((entry) => sameName(entry.display_name, userName));
    const user = exactUser || bootstrap?.users.find((entry) => entry.id === selectedUser);
    const exactLocation = bootstrap?.locations.find((entry) => sameName(entry.name, locationName));
    const location = exactLocation || bootstrap?.locations.find((entry) => entry.id === selectedLocation);
    const exactBuilding = bootstrap?.buildings.find((entry) => sameName(entry.name, buildingName) && (!location?.id || entry.location_id === location.id));
    const building = exactBuilding || bootstrap?.buildings.find((entry) => entry.id === selectedBuilding && (!location?.id || entry.location_id === location.id));
    const exactRoom = bootstrap?.rooms.find((entry) => {
      const candidateBuilding = bootstrap.buildings.find((buildingEntry) => buildingEntry.id === entry.building_id);
      return sameName(entry.name, roomName) && (!location?.id || candidateBuilding?.location_id === location.id);
    });
    const room = exactRoom || bootstrap?.rooms.find((entry) => entry.id === selectedRoom);

    if (!userName && !user) {
      setError("Bitte Erfasser aus den Vorschlägen wählen oder frei eingeben.");
      setMessage("");
      return;
    }
    if (!roomName && !room) {
      setError("Bitte Raum aus den Vorschlägen wählen oder frei eingeben.");
      setMessage("");
      return;
    }
    if (!roomName && (!building || !location)) {
      setError("Kein Gebäude/Betrieb für den Raum gefunden.");
      setMessage("");
      return;
    }

    try {
      let starterId = user?.id;
      if (userName && !exactUser) {
        const created = await createUser(userName);
        starterId = created?.id;
      }
      const session = await api<Session>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          started_by: starterId,
          location_id: locationName && !exactLocation ? undefined : location?.id,
          location_name: locationName && !exactLocation ? locationName : undefined,
          building_id: buildingName && !exactBuilding ? undefined : building?.id,
          building_name: buildingName && !exactBuilding ? buildingName : undefined,
          room_id: exactRoom ? exactRoom.id : roomName ? undefined : room?.id,
          room_name: exactRoom ? undefined : roomName || undefined,
        }),
      });
      setActiveSession(session);
      setFreeUserName("");
      setFreeLocationName("");
      setFreeBuildingName("");
      setFreeRoomName("");
      setSelectedRoom("");
      setMessage("Session gestartet");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Session konnte nicht gestartet werden");
      setMessage("");
    }
  }

  async function createRoom() {
    const name = newRoomName.trim();
    const buildingName = newBuildingName.trim();
    const buildingId = buildingName ? "" : selectedBuilding;
    if (!name || (!buildingId && !buildingName)) {
      setError("Bitte Raumname und Gebäude auswählen oder neues Gebäude eingeben.");
      return;
    }
    try {
      setError("");
      await api("/rooms", {
        method: "POST",
        body: JSON.stringify({ building_id: buildingId || undefined, location_id: selectedLocation || undefined, building_name: buildingName || undefined, name }),
      });
      setNewRoomName("");
      setNewBuildingName("");
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
        body: JSON.stringify({ name, building_id: draft.building_id, code: draft.code.trim() || undefined }),
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
    const confirmed = window.confirm(`Raum "${room.name}" wirklich löschen?\n\nDabei werden ${relatedSessions.length} Session(s) und ${itemCount} Gegenstand/Gegenstände dieses Raums aus der Datenbank entfernt.`);
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

  async function exportAll() {
    try {
      setError("");
      const result = await api<{ id: string }>("/exports/excel", { method: "POST", body: "{}" });
      window.location.href = `${API_BASE}/exports/${result.id}/download`;
      setMessage("Gesamtaufstellung als Excel erstellt");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gesamtaufstellung konnte nicht exportiert werden");
    }
  }

  async function exportSession(session: Session) {
    try {
      setError("");
      const result = await api<{ id: string }>(`/sessions/${session.id}/export/excel`, { method: "POST", body: "{}" });
      window.location.href = `${API_BASE}/exports/${result.id}/download`;
      setMessage("Raumaufnahme als Excel erstellt");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Raumaufnahme konnte nicht exportiert werden");
    }
  }

  function startRoomEdit(roomId: string) {
    const room = bootstrap?.rooms.find((entry) => entry.id === roomId);
    if (!room) return;
    setRoomDrafts((current) => ({ ...current, [roomId]: { name: room.name, building_id: room.building_id, code: room.code ?? "" } }));
    setEditingRoomId(roomId);
  }

  const selectedLocationBuildings = bootstrap?.buildings.filter((building) => !selectedLocation || building.location_id === selectedLocation) ?? [];
  const buildingOptions = selectedLocation ? selectedLocationBuildings : (bootstrap?.buildings ?? []);
  const selectedLocationRooms = bootstrap?.rooms.filter((room) => {
    const building = bootstrap.buildings.find((entry) => entry.id === room.building_id);
    return !selectedLocation || building?.location_id === selectedLocation;
  }) ?? [];
  const roomOptions = selectedLocation ? selectedLocationRooms : (bootstrap?.rooms ?? []);
  const erfasserOptions = bootstrap?.users.filter((user) => user.roles?.includes("erfasser")) ?? [];
  const selectedUserLabel = freeUserName || erfasserOptions.find((user) => user.id === selectedUser)?.display_name || "Erfasser offen";
  const selectedLocationLabel = freeLocationName || bootstrap?.locations.find((location) => location.id === selectedLocation)?.name || "Betrieb offen";
  const selectedBuildingLabel = freeBuildingName || bootstrap?.buildings.find((building) => building.id === selectedBuilding)?.name || "Gebäude offen";
  const selectedRoomLabel = freeRoomName || roomOptions.find((room) => room.id === selectedRoom)?.name || "Raum offen";
  const summary: SessionSummary = {
    sessions: sessions.length,
    items: sessions.reduce((sum, session) => sum + (session.item_count ?? 0), 0),
    open: sessions.filter((session) => session.status !== "closed").length,
    closed: sessions.filter((session) => session.status === "closed").length,
  };

  return (
    <main className="page grid">
      <datalist id="user-suggestions">
        {erfasserOptions.map((user) => <option key={user.id} value={user.display_name} />)}
      </datalist>
      <datalist id="location-suggestions">
        {bootstrap?.locations.map((location) => <option key={location.id} value={location.name} />)}
      </datalist>
      <datalist id="building-suggestions">
        {buildingOptions.map((building) => <option key={building.id} value={building.name} />)}
      </datalist>
      <datalist id="room-suggestions">
        {roomOptions.map((room) => <option key={room.id} value={room.name} />)}
      </datalist>

      <section className="hero-strip">
        <div>
          <h1>Inventur starten</h1>
          <p>Raum-Session anlegen, QR-Code anzeigen, Handy koppeln. Erfasser arbeitet mobil, Prüfer sieht Objekte live.</p>
        </div>
        <div className="today-meta">
          <span>Heute</span>
          <strong>{summary.open} aktive Räume · {summary.items} Objekte erfasst</strong>
        </div>
      </section>

      <section className="start-shell">
        <div className="start-card">
          <div className="section-title">
            <div>
              <h2>Session-Konfiguration</h2>
              <p className="muted">Freie Eingaben werden als Vorschlag gespeichert.</p>
            </div>
            <span className="status erfasst">Raumtest v0.1</span>
          </div>
          {error ? <p className="status upload_fehler">{error}</p> : null}
          {message ? <p className="muted">{message}</p> : null}

          <div className="flow-grid">
            <label className="field flow-field">
              <span><b>1</b> Erfasser</span>
              <input
                list="user-suggestions"
                value={freeUserName}
                onChange={(event) => {
                  const name = event.target.value;
                  setFreeUserName(name);
                  const exact = erfasserOptions.find((user) => sameName(user.display_name, name));
                  if (exact) setSelectedUser(exact.id);
                }}
                placeholder="z. B. Vorname Nachname oder neuer Erfasser"
              />
            </label>

            <label className="field flow-field">
              <span><b>2</b> Betrieb</span>
              <input
                list="location-suggestions"
                value={freeLocationName}
                onChange={(event) => {
                  const name = event.target.value;
                  setFreeLocationName(name);
                  const exact = bootstrap?.locations.find((location) => sameName(location.name, name));
                  if (exact) {
                    setSelectedLocation(exact.id);
                    const firstBuilding = bootstrap?.buildings.find((building) => building.location_id === exact.id);
                    setSelectedBuilding(firstBuilding?.id || "");
                  }
                }}
                placeholder="z. B. Betrieb Beispiel oder neuer Betrieb"
              />
            </label>

            <label className="field flow-field">
              <span><b>3</b> Gebäude</span>
              <input
                list="building-suggestions"
                value={freeBuildingName}
                onChange={(event) => {
                  const name = event.target.value;
                  setFreeBuildingName(name);
                  const exact = buildingOptions.find((building) => sameName(building.name, name));
                  if (exact) setSelectedBuilding(exact.id);
                }}
                placeholder="z. B. Hauptgebäude, Werkstatt, Lagerhalle oder Büro"
              />
            </label>

            <label className="field flow-field">
              <span><b>4</b> Raum</span>
              <input
                list="room-suggestions"
                value={freeRoomName}
                onChange={(event) => {
                  const name = event.target.value;
                  setFreeRoomName(name);
                  const exact = roomOptions.find((room) => sameName(room.name, name));
                  if (exact) {
                    setSelectedRoom(exact.id);
                    setSelectedBuilding(exact.building_id);
                  } else {
                    setSelectedRoom("");
                  }
                }}
                placeholder="z. B. Reifenlager, Werkstattplatz 4 oder Serviceannahme"
              />
            </label>
          </div>

          <div className="start-footer">
            <button className="btn accent primary-action" onClick={startSession}>+ Session starten</button>
            <button className="btn secondary" onClick={() => setShowSettings((current) => !current)}>
              {showSettings ? "Einstellungen ausblenden" : "Vorschläge verwalten"}
            </button>
            <span>Freie Eingaben werden beim Start automatisch als Vorschlag gespeichert.</span>
          </div>
        </div>
        <aside className="qr-panel">
          <div className="session-preview">
            <strong>Aktuelle Vorbereitung</strong>
            <span>{selectedUserLabel}</span>
            <span>{selectedLocationLabel}</span>
            <span>{selectedBuildingLabel}</span>
            <span>{selectedRoomLabel}</span>
          </div>
          <div className="qr-box">
            {activeSession ? <QRCodeSVG value={joinUrl(activeSession.join_token)} size={220} /> : <strong>QR erscheint nach Session-Start</strong>}
          </div>
          {activeSession ? <a className="btn secondary" href={`/session/${activeSession.id}`}>Live-Prüfung öffnen</a> : null}
        </aside>
      </section>

      {showSettings ? <section className="panel setup-panel">
        <div className="section-title">
          <div>
            <h2>Einstellungen</h2>
            <p className="muted">Vorschlagslisten pflegen, damit der Start im Raum schnell bleibt.</p>
          </div>
          <span className="status finalisierbar">{(bootstrap?.users.length ?? 0) + (bootstrap?.rooms.length ?? 0)} Einträge</span>
        </div>
        <div className="grid grid-3">
          <label className="field">
            <span>Neuer Erfasser</span>
            <input value={newUserName} onChange={(event) => setNewUserName(event.target.value)} placeholder="z. B. Vorname Nachname" />
          </label>
          <label className="field">
            <span>Neuer Betrieb</span>
            <input value={newLocationName} onChange={(event) => setNewLocationName(event.target.value)} placeholder="z. B. Betrieb Beispiel" />
          </label>
          <div className="settings-actions">
            <button className="btn accent" onClick={() => createUser()}>Erfasser anlegen</button>
            <button className="btn accent" onClick={() => createLocation()}>Betrieb anlegen</button>
          </div>
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
                setSelectedRoom("");
              }}
            >
              {bootstrap?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Gebäude für neuen Raum</span>
            <select value={selectedBuilding} onChange={(event) => setSelectedBuilding(event.target.value)}>
              <option value="">Gebäude auswählen</option>
              {buildingOptions.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Neues Gebäude für neuen Raum</span>
            <input value={newBuildingName} onChange={(event) => setNewBuildingName(event.target.value)} placeholder="z. B. Werkstatt oder Lager" />
          </label>
          <label className="field">
            <span>Neuer Raum</span>
            <input value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} placeholder="z. B. Reifenlager" />
          </label>
        </div>
        <button className="btn accent room-action" onClick={createRoom}>Raum anlegen</button>

        <div className="suggestion-note">
          <div>
            <strong>{bootstrap?.rooms.length ?? 0} Raumvorschläge hinterlegt</strong>
            <span>Räume aus alter Aufnahme oder Stammdaten werden nur als Vorschläge beim Start verwendet.</span>
          </div>
          <button className="btn secondary compact-btn" onClick={() => setShowRoomSuggestions((current) => !current)}>
            {showRoomSuggestions ? "Vorschläge ausblenden" : "Vorschläge bearbeiten"}
          </button>
        </div>

        {showRoomSuggestions ? (
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
                    {roomSession ? <a className="btn accent compact-btn" href={`/session/${roomSession.id}`}>Inventarliste</a> : null}
                    <button className="btn secondary compact-btn" onClick={() => startRoomEdit(room.id)}>Bearbeiten</button>
                    <button className="btn danger icon-btn" onClick={() => deleteRoom(room.id)} title="Raum löschen" aria-label={`Raum ${room.name} löschen`}>
                      ×
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="room-edit-panel">
                    <label className="field">
                      <span>Raumname</span>
                      <input value={draft.name} onChange={(event) => setRoomDrafts((current) => ({ ...current, [room.id]: { ...draft, name: event.target.value } }))} />
                    </label>
                    <label className="field">
                      <span>Gebäude</span>
                      <select value={draft.building_id} onChange={(event) => setRoomDrafts((current) => ({ ...current, [room.id]: { ...draft, building_id: event.target.value } }))}>
                        {bootstrap.buildings.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>Code</span>
                      <input value={draft.code} onChange={(event) => setRoomDrafts((current) => ({ ...current, [room.id]: { ...draft, code: event.target.value } }))} placeholder="optional" />
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
        ) : null}
      </section> : null}

      <section className="panel session-board">
        <div className="section-title">
          <div>
            <h2>Aktive Raum-Sessions</h2>
            <p className="muted">Gestartete Räume bleiben sichtbar, bis sie abgeschlossen oder bereinigt werden.</p>
          </div>
          <button className="btn secondary compact-btn" onClick={exportAll}>Excel Gesamt</button>
        </div>

        <div className="session-table-wrap">
          <table className="session-table">
            <thead>
              <tr>
                <th>Raum</th>
                <th>Betrieb / Gebäude</th>
                <th>Objekte</th>
                <th>Status</th>
                <th>Start</th>
                <th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <strong>{session.room_name || "Raum"}</strong>
                    <span title={session.id}>erfasst durch: {session.started_by_name || "nicht angegeben"}</span>
                  </td>
                  <td>
                    <strong>{session.location_name || "Betrieb"}</strong>
                    <span>{session.building_name || "Gebäude"}</span>
                  </td>
                  <td className="count-cell">{session.item_count ?? 0}</td>
                  <td><StatusBadgeShim value={session.status} /></td>
                  <td>{formatDateTime(session.created_at)}</td>
                  <td>
                    <div className="table-actions">
                      <a className="btn secondary compact-btn" href={`/session/${session.id}`}>Inventarliste</a>
                      <button className="btn secondary compact-btn" onClick={() => exportSession(session)}>Excel</button>
                      <button
                        className="btn danger icon-btn"
                        onClick={() => deleteSession(session)}
                        title="Session löschen"
                        aria-label={`Session ${session.room_name || "Raum"} löschen`}
                      >
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!sessions.length ? (
                <tr>
                  <td colSpan={6} className="empty-table">Noch keine Raum-Session gestartet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="metric-grid">
          <MetricCard label="Aktive Räume" value={summary.open} hint={`${summary.closed} abgeschlossen`} />
          <MetricCard label="Heute erfasst" value={summary.items} hint="über alle offenen Räume" />
          <MetricCard label="Vorschläge" value={bootstrap?.rooms.length ?? 0} hint="Räume aus Stammdaten/Altaufnahme" />
        </div>
      </section>
    </main>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
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
