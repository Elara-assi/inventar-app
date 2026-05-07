# UI Guidelines

## Design Intent

The interface must feel clear, industrial, quick and inspection-safe. It is used in workshops, storage rooms and offices, often under time pressure.

Avoid playful UI. Avoid marketing sections. Avoid long explanation text inside the app.

## Mobile Capture

Mobile capture has only three primary actions:

1. Foto
2. Code scannen
3. Sprache aufnehmen

Allowed quick secondary actions:

- Typenschildfoto
- Zustandsfoto
- DOT-Foto

Do not add long forms to the mobile flow.

Do not ask the capturer for:

- SKR51 account.
- book value.
- acquisition date.
- asset number.
- full accounting category decisions.

Mobile may ask for:

- object class if AI cannot infer it.
- condition.
- evidence photos.
- inventory ID or temporary ID.

## Reviewer Dashboard

Reviewer view should show:

- object cards.
- evidence/photo signal.
- AI suggestion.
- required fields.
- status.
- rework.
- approval/finalization controls.

Use cards for repeated objects only. Do not nest cards inside cards.

## Status Colors

- Erfasst: gray.
- KI-vorgefuellt: blue.
- Nacharbeit nötig: orange.
- Prüfen: yellow.
- Geprüft: green.
- Finalisiert: dark green.
- Abweichung: red.
- Dublette: violet.
- Upload-Fehler: red.

## Layout Rules

- First screen should be a working dashboard.
- Buttons must be large enough for workshop use.
- Text should be short and scannable.
- Use clear status badges.
- Keep photo/evidence state highly visible.
- Preserve responsive layouts for mobile and tablet.
- Do not use a decorative landing page.
- Do not hide critical blockers behind deep navigation.

## App Views

Expected views:

- Login.
- Dashboard.
- Session starten.
- QR-Kopplung.
- Mobile Erfassung.
- Live-Prüfung.
- Objektakte.
- Raumabschluss.
- Export.
- Buchhaltungs-Nacharbeit.

## Frontend Implementation Notes

- Frontend lives in `apps/web`.
- Use TypeScript.
- Keep reusable UI in `apps/web/components`.
- Keep API helper logic in `apps/web/lib`.
- Use `NEXT_PUBLIC_API_URL` for API base URL.
- Preserve the existing industrial base palette unless deliberately redesigning.

## Copywriting Rules

- Use German labels in the UI.
- Keep operational text short.
- Avoid explanatory paragraphs inside working screens.
- README/docs can explain; app screens should guide through layout and controls.
