#!/usr/bin/env bash
# Revisionslauf: ALLE Pruefungen, Abbruch beim ersten Fehler (Exit != 0).
# Abnahmekriterium: zwei aufeinanderfolgende Laeufe mit 0 Fehlern.
# Voraussetzung: DATABASE_URL zeigt auf eine Test-Datenbank (wird GELEERT!).
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH="$PWD/apps/api"

echo "[1/7] Python-Kompilierung"
python3 -m py_compile apps/api/app/*.py

echo "[2/7] Datenbank frisch aufbauen (alle Migrationen + Seeds)"
python3 - << 'PY'
import psycopg, os
from pathlib import Path
conn = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)
cur = conn.cursor()
cur.execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;")
for f in sorted(Path("db/migrations").glob("*.sql")):
    sql = f.read_text(encoding="utf-8-sig").replace(
        "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
        "-- pgcrypto optional (gen_random_uuid ist ab PG13 nativ)")
    cur.execute(sql)
for f in sorted(Path("db/seeds").glob("*.sql")):
    cur.execute(f.read_text(encoding="utf-8-sig"))
print(f"   {len(list(Path('db/migrations').glob('*.sql')))} Migrationen + Seeds OK")
PY

echo "[3/7] Backend-Testsuite"
python3 -m pytest apps/api/tests/ -q

echo "[4/7] Diktat-Parser (Python)"
python3 apps/api/tests/test_dictation.py

echo "[5/7] TypeScript-Typecheck + Diktat-Parser (TS)"
npx tsc --noEmit -p apps/web/tsconfig.json
rm -rf /tmp/dictation-build
npx tsc apps/web/lib/dictation.ts --outDir /tmp/dictation-build --module esnext --target es2022 --moduleResolution bundler --skipLibCheck
node scripts/test-dictation.mjs

echo "[6/7] End-to-End: Erfassung, Worker-Diktat, Cockpit, Excel-Export mit SKR51-Blatt"
python3 - << 'PY'
import secrets
from app.db import execute, fetch_one
from app import main
from app.worker import apply_dictation_fields
from openpyxl import load_workbook

loc = fetch_one("SELECT * FROM locations LIMIT 1")
b = fetch_one("SELECT * FROM buildings LIMIT 1")
r = fetch_one("SELECT * FROM rooms LIMIT 1")
session = execute(
    "INSERT INTO inventory_sessions (location_id, building_id, room_id, join_token) VALUES (%s,%s,%s,%s) RETURNING *",
    (loc["id"], b["id"], r["id"], secrets.token_urlsafe(12)))
sid = str(session["id"])
oc = fetch_one("SELECT * FROM object_classes WHERE slug = 'hebebuehne'")
execute("UPDATE accounting_profiles SET default_skr51_account = '0420' WHERE object_class_id = %s RETURNING id", (oc["id"],))
item = execute(
    """INSERT INTO inventory_items (temporary_id, session_id, location_id, building_id, room_id,
       condition, object_type, object_class_id, value_estimate)
       VALUES ('TEMP-REV', %s, %s, %s, %s, 'gebraucht', 'Hebebuehne', %s, 4200) RETURNING *""",
    (sid, loc["id"], b["id"], r["id"], oc["id"]))
apply_dictation_fields(str(item["id"]), "Marke Nussbaum Typ Smart Lift Baujahr 2018 Zustand gut")
after = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item["id"],))
assert after["specification"] == "Nussbaum Smart Lift" and after["construction_year"] == "2018", "Worker-Diktat"
assert len(main.session_items(sid)) == 1, "session_items"
overview = main.cockpit_overview()
assert overview["totals"]["today"] >= 1, "cockpit"
export = main.export_excel(sid)
wb = load_workbook(fetch_one("SELECT file_path FROM exports WHERE id = %s", (export["id"],))["file_path"])
assert "Buchhaltung (SKR51)" in wb.sheetnames, "SKR51-Blatt fehlt"
acc = wb["Buchhaltung (SKR51)"]
data = [[cell.value for cell in row] for row in acc.iter_rows(min_row=5, max_row=5)][0]
assert data[4] == "0420", f"SKR51-Konto: {data[4]}"
assert data[8] == 4200.0, f"Zeitwert: {data[8]}"
assert isinstance(data[9], str) and data[9].startswith("=IF"), "GWG-Formel fehlt"
assert data[7] == 8.0, f"Nutzungsdauer: {data[7]}"
print("   Worker-Diktat, session_items, Cockpit, SKR51-Export: OK")
PY

echo "[7/7] Struktur-Smoke"
node scripts/smoke-check.mjs
echo ""
echo "REVISION BESTANDEN: 0 Fehler."
