## Summary

- harden mobile offline capture with session capsules, queue repair, reconcile/status sync, and an app shell service worker
- turn mobile capture into a faster scanner-style flow with photo previews, field autofill, speech input, and fast AI handoff
- add AI job control, including item cancel and room-wide `Alle KI stoppen`
- make value research strict: only exact used-market matches can become a reference price; similar hits stay review-only
- add Ollama-backed nameplate/object extraction guardrails and tests
- harden security findings from review: safe audio upload filenames, no demo password for new users, ephemeral dev auth secret, DB-backed item AI cancel, production API start without `--reload`

## Verification

- `npm run smoke`
- `npm run build`
- `python -m py_compile apps/api/app/main.py apps/api/app/security.py apps/api/app/settings.py apps/api/app/logic.py`
- `PYTHONPATH=apps/api python -m pytest apps/api/tests`
- `python scripts/ai-guardrail-test.py`
- live VPS deploy: `security-hardening-20260610102303`
- live health check: `https://inventar-api.elarahub.cloud/health`
- live health field: `auth_secret_configured: true`
- live DB verification: `password_reset_required`, `ai_cancel_generation`, `ai_cancelled_at`, migration `011_security_hardening.sql`
- live container command: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- live browser check: app title `Inventar Maschine`, no console errors

## Notes

- The deployed app is already running this branch state on the VPS.
