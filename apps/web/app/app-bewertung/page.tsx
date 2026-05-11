const capabilitySections = [
  {
    title: "BGA-Praxiserfassung",
    score: "8.5/10",
    verdict: "Für einen kontrollierten BGA-Pilot sehr gut nutzbar.",
    points: [
      "Geführter 5-Schritte-Handyprozess für Fotos, KI-Vorschlag, Stammdaten, Zustand/Prüfung und Zusammenfassung.",
      "Objektfoto, Typenschild, UVV-Siegel, Zustandsfoto und weitere Nachweise werden fachlich getrennt erfasst.",
      "Pflichtangaben blockieren den lokalen Entwurf nicht; Nacharbeit und Raumabschluss bleiben fachlich streng.",
      "Offline-Entwürfe, lokale Fotoablage und Bundle-Sync sind als robuste Basis umgesetzt.",
      "Für den endgültigen Rollout bleibt ein wiederholter echter iPhone-Feldtest mit mehreren Geräten Pflicht.",
    ],
  },
  {
    title: "Prüfer-Desktop",
    score: "8.5/10",
    verdict: "Die Nacharbeit ist inzwischen deutlich smoother und praxisnäher.",
    points: [
      "Aktive Sessions, Erfassungsart, Erfasser, Raum und Status sind übersichtlich sichtbar.",
      "Prüferliste unterstützt schnelle Nacharbeit mit Filtern für Nacharbeit, fehlende Fotos, Funktion, UVV und Finalisierung.",
      "Wichtige Felder sind gruppiert, Nebenaktionen sind reduziert, Fotos/Nachweise bleiben im Kontext.",
      "Raumabschluss und Wiederöffnung sind fachlich abgesichert.",
      "Noch offen für Enterprise: Rollenrechte je Aktion und Audit-Transparenz direkt in der Oberfläche.",
    ],
  },
  {
    title: "Excel & Nachweise",
    score: "9.5/10",
    verdict: "Die BGA-Papierliste ist sehr nah an der ursprünglichen Vorlage.",
    points: [
      "Inventurliste startet mit Titel, Standort, Erfasser, Datum und der papiernahen BGA-Tabelle.",
      "Hauptspalten bleiben exakt: lfd. Nr. / Foto, Bezeichnung, Typ / Spezifikation, Baujahr, Zustand, Funktion i. O. Ja, Funktion i. O. Nein, UVV bis, Bemerkung.",
      "Keine Prüfbuch-Spalten im BGA-Haupttab.",
      "Weitere Tabs für Nacharbeit, Fotos/Nachweise, Übersicht und Protokoll sind fachlich sinnvoll.",
      "Optimierung später: noch stärkere Drucklayout-Profile für unterschiedliche Papierformate und Freigabevermerke.",
    ],
  },
  {
    title: "KI-Unterstützung",
    score: "7/10",
    verdict: "Hilfreich als Vorschlagssystem, aber nicht als ungeprüfte Wahrheit.",
    points: [
      "BGA-Objektklassenliste führt die Erkennung weg vom freien Raten hin zu praxisnahen Klassen.",
      "Computermaus, Tastatur, Monitor, Bürostuhl, Werkzeugwagen und unklare Objekte werden gezielter behandelt.",
      "KI-Vorschläge werden als Vorschläge angezeigt und müssen übernommen werden; manuelle Eingaben bleiben führend.",
      "Tiefensuche nutzt eine Search-Provider-Schicht mit SearXNG und Fallback, wenn Quellen erreichbar sind.",
      "Preise, Alter und Werte bleiben prüfpflichtig. Ohne belastbare Quelle darf kein Fantasiewert als Fakt landen.",
    ],
  },
  {
    title: "SaaS-Reife",
    score: "6.5/10",
    verdict: "Solide technische Basis, aber noch kein fertiges öffentliches SaaS.",
    points: [
      "Auth-Grundlage, Tenant-Felder, Migrationen, Healthchecks und Upload-Härtung sind vorbereitet.",
      "Mandantenfähigkeit ist strukturell angelegt, aber harte Berechtigungsprüfung muss konsequent an allen Routen sitzen.",
      "Uploads und Exporte brauchen vor externem SaaS-Betrieb vollständige Zugriffskontrolle, Ablaufregeln und Audit-Auswertung.",
      "CORS, Secrets, Backups und Restore-Prozess sind vorbereitet, müssen aber betrieblich dauerhaft überwacht werden.",
      "Für SaaS fehlen noch Self-Service-Onboarding, Benutzerverwaltung, Einladungen, Rollenpflege und Abrechnung/Vertragslogik.",
    ],
  },
  {
    title: "Enterprise-Reife",
    score: "6/10",
    verdict: "Für interne Pilotierung gut, für Enterprise-Verkauf noch nicht hart genug.",
    points: [
      "Docker-Stack, Postgres, strukturierte Migrationen und Healthchecks sind eine gute Grundlage.",
      "Backup-/Restore-Skripte und Stresssimulationen existieren, müssen aber als wiederholbarer Betriebsprozess laufen.",
      "Monitoring, Alerts, Request-IDs, Speicherplatzwarnungen und Sync-Metriken müssen produktionsreif werden.",
      "Sicherheitsniveau braucht Rollenrechte, Export-/Foto-Rechte, Passwort-/Token-Lifecycle, optional SSO/OIDC und Protokollprüfung.",
      "Für große Kundenszenarien fehlen noch formale Datenschutz-, Lösch-, Aufbewahrungs- und Incident-Prozesse.",
    ],
  },
];

const worksWell = [
  "BGA-Raum-Session starten und per QR-Code mit iPhone koppeln.",
  "Betriebs- und Geschäftsausstattung mobil erfassen, auch wenn Pflichtfelder noch fehlen.",
  "Fotos lokal sichern und als Objektpaket mit dem Datensatz synchronisieren.",
  "Prüfer sieht Objekte, Fotos, Nacharbeit und kann Felder am Laptop/iPad korrigieren.",
  "Raum abschließen, Bearbeitung sperren und bei Bedarf mit Grund wieder öffnen.",
  "Excel-Export im Stil der manuellen BGA-Zählliste erzeugen.",
  "KI-Vorschläge für Bezeichnung, Klasse, Typ/Spezifikation, Zustand und Bemerkung anbieten.",
  "KI-Tiefensuche mit Webquellen vorbereiten, ohne Schätzwerte als geprüfte Fakten zu verkaufen.",
  "BGA bleibt geschützt: keine Reifen/Räder- oder Spezialwerkzeug-Logik im aktiven BGA-Workflow.",
];

const limitations = [
  "Echter iPhone-Massenbetrieb mit 10 bis 15 Personen muss vor dem produktiven Rollout nochmals live wiederholt werden.",
  "iOS-PWA-Hintergrundsync ist systembedingt nicht garantiert; die App muss zum Synchronisieren zuverlässig geöffnet werden.",
  "Mandantenfähigkeit ist technisch vorbereitet, aber für externes SaaS noch nicht vollständig hart durchgesetzt.",
  "Berechtigungen für alle Foto-, Export- und Adminpfade müssen vor KundensaaS vollständig geschlossen werden.",
  "Monitoring und Alerting sind noch kein 24/7-Betriebssystem.",
  "KI erkennt besser, bleibt aber probabilistisch. Jeder Vorschlag braucht menschliche Prüfung.",
  "Reifen/Räder und Spezialwerkzeuge sind bewusst nicht produktiv aktiv.",
  "Die aktuelle Bewertung ist eine technische Momentaufnahme und ersetzt keine finale Datenschutz-/Security-Abnahme.",
];

const nextSteps = [
  "Echter End-to-End-iPhone-Test: offline erfassen, App schließen, online synchronisieren, Fotos in Prüferliste prüfen, Doppel-Sync prüfen.",
  "Rollen-/Tenant-Rechte konsequent an jeder API-Route, jedem Export und jedem Fotozugriff erzwingen.",
  "Backup, Restore und Speicherplatzalarm als wiederkehrenden VPS-Betriebsprozess dokumentieren und testen.",
  "Monitoring für Sync-Fehler, Uploadgrößen, API-Fehler, DB-Verbindungen und freien Plattenplatz ergänzen.",
  "Aftersales-Pilot-Anbindung über klare externe IDs, API-Kontrakte und spätere Webhooks vorbereiten.",
];

export default function AppAssessmentPage() {
  return (
    <main className="assessment-page">
      <section className="assessment-hero">
        <div>
          <p className="assessment-kicker">Temporäre Abnahme-Seite · Stand 11.05.2026</p>
          <h1>Inventar-App Bewertung</h1>
          <p>
            Diese Seite ist bewusst ehrlich: Die App ist für einen kontrollierten BGA-Praxiseinsatz weit,
            aber noch nicht auf dem Niveau eines öffentlichen Multi-Tenant-SaaS oder einer vollständig
            enterprise-zertifizierten Plattform.
          </p>
        </div>
        <div className="assessment-status-card">
          <span>Status</span>
          <strong>Kontrollierter BGA-Pilot: bereit</strong>
          <p>Externes SaaS/Enterprise-Rollout: erst nach Security-, Rechte-, Backup- und Monitoring-Härtung.</p>
        </div>
      </section>

      <section className="assessment-scoreboard" aria-label="Bewertung">
        <div>
          <span>BGA Praxis</span>
          <strong>8.5/10</strong>
        </div>
        <div>
          <span>SaaS Niveau</span>
          <strong>6.5/10</strong>
        </div>
        <div>
          <span>Enterprise Niveau</span>
          <strong>6/10</strong>
        </div>
        <div>
          <span>Gesamturteil</span>
          <strong>Pilotfähig</strong>
        </div>
      </section>

      <section className="assessment-section">
        <div className="assessment-section-heading">
          <p className="assessment-kicker">Fähigkeiten</p>
          <h2>Was die App heute konkret kann</h2>
        </div>
        <div className="assessment-grid">
          {capabilitySections.map((section) => (
            <article className="assessment-card" key={section.title}>
              <div className="assessment-card-head">
                <h3>{section.title}</h3>
                <span>{section.score}</span>
              </div>
              <p className="assessment-verdict">{section.verdict}</p>
              <ul>
                {section.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="assessment-band">
        <div>
          <p className="assessment-kicker">BGA-Export-Schutz</p>
          <h2>Excel-Haupttab bleibt papiernah</h2>
          <p>
            Der BGA-Haupttab ist nicht als technische Datenbankansicht gedacht, sondern als Ersatz für die
            ursprüngliche manuelle Zählliste. Ergänzende Prüf-, Foto- und Protokollinformationen liegen in
            eigenen Tabs und stören die Papierlistenstruktur nicht.
          </p>
        </div>
        <ol className="assessment-columns">
          <li>lfd. Nr. / Foto</li>
          <li>Bezeichnung</li>
          <li>Typ / Spezifikation</li>
          <li>Baujahr</li>
          <li>Zustand</li>
          <li>Funktion i. O. Ja</li>
          <li>Funktion i. O. Nein</li>
          <li>UVV bis</li>
          <li>Bemerkung</li>
        </ol>
      </section>

      <section className="assessment-two-col">
        <div className="assessment-panel">
          <p className="assessment-kicker">Stärken</p>
          <h2>Was schon stark ist</h2>
          <ul>
            {worksWell.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
        <div className="assessment-panel warning">
          <p className="assessment-kicker">Grenzen</p>
          <h2>Was noch nicht als 10/10 gilt</h2>
          <ul>
            {limitations.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="assessment-section">
        <div className="assessment-section-heading">
          <p className="assessment-kicker">Entscheidung</p>
          <h2>Go / No-Go</h2>
        </div>
        <div className="assessment-decision">
          <div>
            <strong>Go</strong>
            <p>
              Kontrollierter BGA-Praxistest mit geschulten Erfassern, vorbereiteten iPhones, sichtbarer
              Sync-Diagnose und Prüfer am Laptop/iPad.
            </p>
          </div>
          <div>
            <strong>No-Go</strong>
            <p>
              Öffentlicher SaaS-Verkauf, mehrere externe Mandanten, sensible Kundendaten oder unbeaufsichtigter
              Masseneinsatz ohne zusätzliche Security-, Backup- und Monitoring-Härtung.
            </p>
          </div>
        </div>
      </section>

      <section className="assessment-section">
        <div className="assessment-section-heading">
          <p className="assessment-kicker">Weg zu 10/10</p>
          <h2>Nächste sinnvolle Schritte</h2>
        </div>
        <div className="assessment-roadmap">
          {nextSteps.map((step, index) => (
            <div key={step}>
              <span>{index + 1}</span>
              <p>{step}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="assessment-final">
        <h2>Fazit</h2>
        <p>
          Die Inventar-App ist aktuell stark genug, um den BGA-Prozess kontrolliert in die Praxis zu bringen.
          Sie ersetzt die manuelle BGA-Zählliste fachlich sauber, fühlt sich am Desktop deutlich reifer an
          und hat die richtige technische Richtung für Offline-Sync und spätere Aftersales-Anbindung. Für ein
          echtes SaaS-/Enterprise-Produkt fehlen noch harte Rechteprüfung, Betriebsmonitoring, Restore-Nachweis
          und ein wiederholbarer iPhone-Massentest. Genau dort entscheidet sich die 10/10.
        </p>
        <a className="btn accent" href="/">
          Zurück zum Homescreen
        </a>
      </section>
    </main>
  );
}
