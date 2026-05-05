"use client";

const rows = [
  {
    id: "SHR-2026-0184",
    photo: "MON",
    object: "Dell P2422H",
    type: "Monitor",
    state: "gut",
    value: "180 EUR",
    status: "Finalisierbar",
    note: "Spätere Auswertung",
    ai: "92%",
  },
  {
    id: "TMP-A12",
    photo: "DOT",
    object: "Michelin Primacy 4",
    type: "Reifen",
    state: "gut",
    value: "74 EUR",
    status: "Vor Ort offen",
    note: "Profiltiefe fehlt",
    ai: "81%",
  },
  {
    id: "SHR-2026-0185",
    photo: "LIFT",
    object: "Nussbaum Power Lift",
    type: "Hebebühne",
    state: "gut",
    value: "4.200 EUR",
    status: "Technik",
    note: "Typenschild prüfen",
    ai: "88%",
  },
];

export default function DesignPreviewPage() {
  return (
    <main className="design-preview-shell">
      <aside className="preview-sidebar">
        <div className="preview-logo">
          <span>IM</span>
          <strong>Inventar Maschine</strong>
          <small>Design Template</small>
        </div>
        <nav>
          <a className="active">Dashboard</a>
          <a>Räume</a>
          <a>Inventarliste</a>
          <a>Export</a>
        </nav>
        <div className="preview-user">Demo Prüfer · Betrieb Muster</div>
      </aside>

      <section className="preview-workspace">
        <header className="preview-topbar">
          <div>
            <span>Inventur / Prüfansicht</span>
            <h1>Serviceannahme</h1>
          </div>
          <div className="preview-live-pill">
            <i />
            Handy verbunden
          </div>
        </header>

        <section className="preview-hero">
          <div>
            <h2>Raumtest läuft</h2>
            <p>4 Gegenstände erfasst · KI prüft im Hintergrund · letzte Aktualisierung 22:31</p>
          </div>
          <button>Raum abschließen</button>
        </section>

        <section className="preview-metrics">
          {[
            ["4", "Erfasst", "blue"],
            ["1", "KI läuft", "orange"],
            ["2", "Hinweise", "amber"],
            ["1", "Finalisierbar", "green"],
          ].map(([value, label, tone]) => (
            <div className={`preview-metric ${tone}`} key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </section>

        <section className="preview-main-grid">
          <div className="preview-list-panel">
            <div className="preview-panel-head">
              <div>
                <span className="preview-dot" />
                <strong>Gegenstände im Raum</strong>
              </div>
              <small>kompakte Prüfliste</small>
            </div>

            <div className="preview-table">
              {rows.map((row, index) => (
                <article className="preview-row" key={row.id} style={{ animationDelay: `${index * 120}ms` }}>
                  <button className="preview-photo">{row.photo}</button>
                  <div className="preview-row-main">
                    <div className="preview-row-title">
                      <strong>{row.object}</strong>
                      <span>{row.id} · {row.type}</span>
                    </div>
                    <div className="preview-row-cells">
                      <span><b>Zustand</b>{row.state}</span>
                      <span><b>Wert</b>{row.value}</span>
                      <span><b>KI</b>{row.ai}</span>
                      <span><b>Hinweis</b>{row.note}</span>
                    </div>
                  </div>
                  <div className="preview-row-actions">
                    <span className="preview-status">{row.status}</span>
                    <button>Bearbeiten</button>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <aside className="preview-phone">
            <div className="phone-frame">
              <div className="phone-head">
                <span>RV</span>
                <div>
                  <strong>Serviceannahme</strong>
                  <small>live</small>
                </div>
              </div>
              <div className="phone-camera">
                <span>Objektfoto</span>
                <i />
              </div>
              <input readOnly value="SHR-2026-0189" />
              <div className="phone-audio">Sprachnotiz · 00:08 · KI läuft</div>
              <button>Speichern · Nächstes Objekt</button>
            </div>
          </aside>
        </section>
      </section>
    </main>
  );
}
