# Roadmap: Die naechsten Ausbaustufen

Stand: 2026-06-12. Prinzip: Wirkung pro Personentag. Jeder Vorschlag baut auf
Code auf, der bereits existiert – nichts davon startet bei null.

## Sprint 1 – "Der Inventurtag, der sich selbst verkauft"

### 1. Etiketten + Blitz-Wiederholungsinventur  (~3-4 PT)
Nach dem Finalisieren druckt die App QR-Etikettenboegen (PDF fuer Brother/
Zebra/Avery). Naechste Inventur: Etikett scannen -> Objekt ist bestaetigt,
weiter. Ein Raum, der heute 2 Stunden kostet, dauert beim zweiten Mal 15
Minuten. Tabelle `label_batches` existiert seit Tag 1, der Scanner ist live.
**Begeisterung: Die Inventur 2027 erledigt sich im Vorbeigehen.**

### 2. Inventur-Cockpit fuer die Steuerung  (~3 PT)
Das Premium-Design als echtes Live-Cockpit ueber alle Raeume/Standorte:
Fortschritt in Echtzeit, Objekte/Stunde je Erfasser, offene Nacharbeiten,
geschaetzter Gesamtwert – auf dem Beamer im Buero waehrend des Inventurtags.
Heartbeat, Live-Polling und Premium-CSS sind vorhanden; es fehlt nur die
Aggregations-Seite. **Begeisterung: Die GF sieht der Inventur live zu.**

### 3. Raum-Radar (Soll-Ist beim Abschluss)  (~3-4 PT)
Altbestand (Excel der letzten Inventur) einmal importieren; beim
Raumabschluss meldet die App: "14 erwartet, 12 gefunden – fehlend:
Hebebuehne 0042, Werkbank 0017". Tabellen `target_inventory_*` existieren
seit Tag 1. **Begeisterung: Revisionssicherheit auf Knopfdruck – nichts
verschwindet mehr unbemerkt.**

## Sprint 2 – "Mehr Wert aus jedem Objekt"

### 4. Wert-Dossier pro Raum/Standort  (~2-3 PT)
Die vorhandene Einzelobjekt-Wertschaetzung (Web-Recherche, 97 Codestellen)
aggregiert als PDF-Report: Gesamtzeitwert mit Spanne, Top-10-Werte,
Ausreisser zum Pruefen. Fuer Versicherung, Bilanzgespraech, Standort-
vergleich. **Begeisterung: "Was ist die Werkstatt wert?" – eine Seite, eine
Zahl, belegte Quellen.**

### 5. Foto-Qualitaets-Coach  (~1-2 PT)
Sofort-Check direkt nach der Aufnahme (Schaerfe/Helligkeit, on-device):
"Typenschild unscharf – bitte nochmal." Spart die haeufigste Nacharbeit,
bevor sie entsteht. **Begeisterung: Die App coacht den Erfasser, nicht der
Pruefer am naechsten Tag.**

### 6. ELARA-Anbindung  (~1-2 PT)
Webhook bei Raumabschluss/Export -> n8n: Raum-Report automatisch nach
Notion, Kurzmeldung an die Verantwortlichen. Die Inventur-App wird Baustein
des persoenlichen Betriebssystems. **Begeisterung: Raum fertig -> Bericht
liegt in Notion, bevor du im Auto sitzt.**

## Sprint 3 – "Vom Werkzeug zur Plattform"

### 7. Reifen/Raeder-Modul scharf schalten  (~4-5 PT)
Das Backend ist zu grossen Teilen da (71 Codestellen, eigene Migration),
die Kachel steht auf "in Vorbereitung". Mobile-Flow ergaenzen: DOT per
Kamera, Profiltiefen-Schnelleingabe, Kundenware-Kennzeichnung. After-Sales-
Kerngeschaeft. **Begeisterung: Reifenlager-Inventur mit DOT-Alterspruefung
im selben Werkzeug.**

### 8. Anlagenbuchhaltungs-Bruecke (DATEV-Export)  (~3-4 PT)
Export im Anlagenbuchhaltungs-Format + Abgleichliste Anlagennummern
("erfasst, aber nicht in der Anlagenliste" / umgekehrt). Macht das Tool
fuer die kaufmaennische Seite offiziell. **Begeisterung: Die Buchhaltung
bekommt zum ersten Mal eine Inventur, die zu ihren Zahlen passt.**

### 9. Team-Modus mit Erfasser-Tacho  (~2-3 PT)
Mehrere Handys pro Raum laufen heute schon konfliktfrei. Sichtbar machen:
wer hat was erfasst, Objekte/Stunde, dezenter Team-Vergleich am Cockpit.
Fuehrung ueber Zahlen statt Zuruf. **Begeisterung: Der Inventurtag bekommt
einen Punktestand.**

## Fundament (parallel, je <1 PT)
- On-Device-Whisper-Spike (Diktat-Transkript sofort, auch offline)
- Backup-Automatik (Skripte vorhanden) + Uptime-Kuma aktivieren
- PWA-Feinschliff: Install-Hinweis, Splash, Haptik durchgaengig
