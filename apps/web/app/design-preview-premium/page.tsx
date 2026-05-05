"use client";

const items = [
  {
    id: "SHR-SIM-2026-000184",
    mark: "MON",
    title: "Dell P2422H",
    className: "Monitor",
    room: "Serviceannahme",
    condition: "Gut",
    evidence: "2/5",
    ai: "92",
    value: "180 EUR",
    state: "Finalisierbar",
    priority: "ok",
    open: "Auswertung",
  },
  {
    id: "TMP-A12",
    mark: "DOT",
    title: "Michelin Primacy 4",
    className: "Reifen",
    room: "Reifenlager",
    condition: "Gut",
    evidence: "3/5",
    ai: "81",
    value: "74 EUR",
    state: "Vor Ort offen",
    priority: "warn",
    open: "Profiltiefe",
  },
  {
    id: "SHR-SIM-2026-000185",
    mark: "LIFT",
    title: "Nussbaum Power Lift HL 2.40",
    className: "Hebebühne",
    room: "Werkstattplatz 4",
    condition: "Gut",
    evidence: "2/5",
    ai: "88",
    value: "4.200 EUR",
    state: "Technik prüfen",
    priority: "tech",
    open: "Typenschild",
  },
  {
    id: "SHR-SIM-2026-000188",
    mark: "TOOL",
    title: "Hazet Assistent 179NXL",
    className: "Werkzeugwagen",
    room: "Werkstatt",
    condition: "Gebraucht",
    evidence: "1/5",
    ai: "76",
    value: "950 EUR",
    state: "Ergänzen",
    priority: "warn",
    open: "Inhalt prüfen",
  },
];

export default function PremiumDesignPreviewPage() {
  return (
    <main className="premium-preview">
      <div className="premium-orbit premium-orbit-a" />
      <div className="premium-orbit premium-orbit-b" />

      <header className="premium-command">
        <div className="premium-brandmark">
          <span>IM</span>
          <div>
            <strong>Inventar Maschine</strong>
            <small>Raumtest v0.1 · Premium Designstudie</small>
          </div>
        </div>
        <nav>
          <a className="active">Prüfansicht</a>
          <a>Räume</a>
          <a>Audit</a>
          <a>Export</a>
        </nav>
        <div className="premium-sync">
          <i />
          Live · Handy verbunden
        </div>
      </header>

      <section className="premium-stage">
        <div className="premium-room-head">
          <div>
            <span>Betrieb Muster · Werkstatt</span>
            <h1>Serviceannahme</h1>
            <p>Prüferliste mit Live-Erfassung, Belegbildern, KI-Hinweisen und Abschlusskontrolle.</p>
          </div>
          <div className="premium-room-actions">
            <button className="ghost">QR koppeln</button>
            <button className="primary">Raum abschließen</button>
          </div>
        </div>

        <div className="premium-kpis">
          <article>
            <small>Erfasst</small>
            <strong>47</strong>
            <span>+4 seit 22:00</span>
          </article>
          <article>
            <small>KI läuft</small>
            <strong>3</strong>
            <span>automatisch</span>
          </article>
          <article>
            <small>Offen</small>
            <strong>11</strong>
            <span>vor Abschluss</span>
          </article>
          <article>
            <small>Finalisierbar</small>
            <strong>28</strong>
            <span>bereit</span>
          </article>
        </div>

        <section className="premium-grid">
          <div className="premium-inventory">
            <div className="premium-list-head">
              <div>
                <span className="premium-dot" />
                <strong>Gegenstände im Raum</strong>
                <small>{items.length} sichtbar · automatische Aktualisierung</small>
              </div>
              <label>
                <span>Suche</span>
                <input placeholder="ID, Marke, Klasse ..." />
              </label>
            </div>

            <div className="premium-rows">
              {items.map((item, index) => (
                <article className={`premium-item ${item.priority}`} key={item.id} style={{ animationDelay: `${index * 90}ms` }}>
                  <button className="premium-photo">
                    <span>{item.mark}</span>
                  </button>
                  <div className="premium-item-main">
                    <div className="premium-item-title">
                      <strong>{item.title}</strong>
                      <span>{item.id} · {item.className} · {item.room}</span>
                    </div>
                    <div className="premium-facts">
                      <span><b>Zustand</b>{item.condition}</span>
                      <span><b>Belege</b>{item.evidence}</span>
                      <span><b>KI</b>{item.ai}%</span>
                      <span><b>Wert</b>{item.value}</span>
                      <span><b>Offen</b>{item.open}</span>
                    </div>
                  </div>
                  <div className="premium-state">
                    <span>{item.state}</span>
                    <button>Öffnen</button>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <aside className="premium-inspector">
            <div className="premium-qr-card">
              <div className="premium-qr">
                {Array.from({ length: 49 }).map((_, index) => (
                  <i key={index} className={(index * 7 + index) % 5 < 2 ? "on" : ""} />
                ))}
              </div>
              <strong>Handy koppeln</strong>
              <span>Token aktiv · 01:42</span>
            </div>

            <div className="premium-timeline">
              <strong>Live-Verlauf</strong>
              {[
                ["22:31", "Foto eingegangen"],
                ["22:31", "KI klassifiziert Monitor"],
                ["22:29", "Nacharbeit Profiltiefe"],
                ["22:26", "Objekt finalisiert"],
              ].map(([time, label]) => (
                <p key={`${time}-${label}`}><span>{time}</span>{label}</p>
              ))}
            </div>

            <div className="premium-phone-mini">
              <div>
                <span>RV</span>
                <strong>Mobiler Erfasser</strong>
              </div>
              <section>
                <b>Objektfoto</b>
              </section>
              <button>Speichern · nächstes Objekt</button>
            </div>
          </aside>
        </section>
      </section>
    </main>
  );
}
