# Inventar-App Enterprise-Haertung

Stand: Phase "enterprise-foundation"

## Umgesetzt

- Reproduzierbarer Migration Runner ueber `schema_migrations`.
- Neue Migration `008_enterprise_foundation.sql` fuer Default-Mandant, Tenant-Spalten und Aftersales-Anbindungsfelder.
- Eigenstaendige Auth-Grundlage mit PBKDF2-Passworthash und HMAC/JWT-kompatiblem Bearer Token.
- CORS wird ueber `CORS_ORIGINS` konfiguriert und ist nicht mehr pauschal `*`.
- Upload-Haertung fuer Foto-Uploads: Groessenlimit, erlaubte Bildtypen und einfache Signaturpruefung.
- `/health` prueft Datenbank, Migrationstabelle, Upload-Schreibbarkeit und freien Speicher.
- `/health` meldet zusaetzlich DB-Pool-Status und ob ein produktives Auth-Secret gesetzt ist.
- DB-Zugriffe nutzen im Container einen Psycopg-Connection-Pool mit direktem Fallback fuer lokale Entwicklung.
- Die Prueferansicht priorisiert offene Nacharbeit und zeigt QR-Kopplung nach Eingang erster Objekte nur noch eingeklappt.
- Der BGA-Excel-Haupttab bleibt papiernah, hat aber Druckbereich, wiederholte Kopfzeilen und A4-Querformat erhalten.
- PWA-Manifest enthaelt ein sichtbares App-Icon.
- Mobile Diagnose enthaelt Queue-Schema-Version und lokalen Speicherhinweis.
- Backup-/Restore-Skripte fuer Postgres und Upload-Dateien liegen unter `scripts/`.
- Stresstest mit 15 parallelen simulierten Erfassern wurde bestanden: 75 Objekte, 150 Fotos, keine Duplikate.

## Noch offen fuer volle SaaS-Reife

- Harte Rechtepruefung auf alle Sessions, Fotos und Exporte nach Tenant/Rolle.
- Automatischer Backup-Job per Cron/Systemd Timer und dokumentierter Restore-Probelauf.
- Monitoring/Alerts fuer Sync-Fehler, freien Speicher, API-Fehler und Backup-Alter.
- Lasttest mit echten iPhone-Fotos in Zielaufloesung 1600/2400px.
- Weitere Performance-Haertung: Bildverarbeitung asynchronisieren und Poolwerte nach Echttest feinjustieren.
- Spaetere Aftersales-Pilot-Anbindung ueber externe IDs, SSO oder Webhooks.

## Betriebsbefehle

Backup:

```bash
scripts/backup-inventar.sh /opt/stacks/inventar-app
```

Restore:

```bash
scripts/restore-inventar.sh /opt/stacks/inventar-app /pfad/inventar-db.dump /pfad/inventar-uploads.tgz
```

Health:

```bash
curl -s http://127.0.0.1:8000/health
```
