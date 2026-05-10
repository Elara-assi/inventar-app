# Inventar-App Enterprise-Haertung

Stand: Phase "enterprise-foundation"

## Umgesetzt

- Reproduzierbarer Migration Runner ueber `schema_migrations`.
- Neue Migration `008_enterprise_foundation.sql` fuer Default-Mandant, Tenant-Spalten und Aftersales-Anbindungsfelder.
- Eigenstaendige Auth-Grundlage mit PBKDF2-Passworthash und HMAC/JWT-kompatiblem Bearer Token.
- CORS wird ueber `CORS_ORIGINS` konfiguriert und ist nicht mehr pauschal `*`.
- Upload-Haertung fuer Foto-Uploads: Groessenlimit, erlaubte Bildtypen und einfache Signaturpruefung.
- `/health` prueft Datenbank, Migrationstabelle, Upload-Schreibbarkeit und freien Speicher.
- PWA-Manifest enthaelt ein sichtbares App-Icon.
- Mobile Diagnose enthaelt Queue-Schema-Version und lokalen Speicherhinweis.
- Backup-/Restore-Skripte fuer Postgres und Upload-Dateien liegen unter `scripts/`.

## Noch offen fuer volle SaaS-Reife

- Web-Login-Flow und Auth-Header in allen Dashboard-/Pruefer-Requests.
- Harte Rechtepruefung auf alle Sessions, Fotos und Exporte nach Tenant/Rolle.
- Automatischer Backup-Job per Cron/Systemd Timer und dokumentierter Restore-Probelauf.
- Monitoring/Alerts fuer Sync-Fehler, freien Speicher, API-Fehler und Backup-Alter.
- Lasttest mit 10-15 parallelen iPhones.
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
