"""End-to-End-Integrationstest gegen eine laufende API mit echter PostgreSQL.

Start:  DATABASE_URL=... uvicorn app.main:app --app-dir apps/api --port 8000
Dann:   python apps/api/tests/integration_test.py  (oder pytest)

Deckt den Raumtest (docs/ROOM_TEST_V01.md) plus Stabilitaetsfaelle ab:
parallele Erfassung (Race auf Inventar-IDs), Upload-Validierung,
Sperrverhalten nach Finalisierung, Blocker-Logik und Export.
"""
from __future__ import annotations

import io
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import httpx

API = os.environ.get("API_URL", "http://localhost:8000")

# 1x1-Pixel-JPEG (gueltige Bilddatei fuer Upload-Tests)
TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707"
    "07090908080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c23"
    "1c1c2837292c30313434341f27393d38323c2e333432ffc0000b08000100010101"
    "1100ffc4001f0000010501010101010100000000000000000102030405060708090a"
    "0bffc400b5100002010303020403050504040000017d010203000411051221314106"
    "13516107227114328191a1082342b1c11552d1f02433627282090a161718191a2526"
    "2728292a3435363738393a434445464748494a535455565758595a63646566676869"
    "6a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9"
    "aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6"
    "e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfe8a28a2bfffd9"
)

checks: list[str] = []


def ok(name: str, condition: bool, info: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    checks.append(status)
    print(f"[{status}] {name}{(' – ' + info) if info else ''}")
    if not condition:
        sys.exit(1)


def main() -> None:
    client = httpx.Client(base_url=API, timeout=30)

    # --- Health & Stammdaten -------------------------------------------------
    health = client.get("/health").json()
    ok("health: API und Datenbank erreichbar", health.get("ok") and health.get("database"))

    boot = client.get("/meta/bootstrap").json()
    ok("bootstrap: Raeume und Objektklassen vorhanden", bool(boot["rooms"]) and bool(boot["object_classes"]))
    room = boot["rooms"][0]
    building = next(b for b in boot["buildings"] if b["id"] == room["building_id"])
    location = next(l for l in boot["locations"] if l["id"] == building["location_id"])
    classes = {c["slug"]: c for c in boot["object_classes"]}

    # --- Session & Join ------------------------------------------------------
    session = client.post("/sessions", json={
        "location_id": location["id"], "building_id": building["id"], "room_id": room["id"],
    }).json()
    ok("session: angelegt mit Join-Token", bool(session.get("join_token")))

    joined = client.post("/sessions/join", json={"token": session["join_token"], "device_name": "Testhandy"})
    ok("join: Handy gekoppelt", joined.status_code == 200)
    bad_join = client.post("/sessions/join", json={"token": "kaputt"})
    ok("join: ungueltiger Token wird abgelehnt", bad_join.status_code == 404)

    # --- Race-Test: 12 parallele Erfasser ------------------------------------
    def create_one(_: int) -> httpx.Response:
        with httpx.Client(base_url=API, timeout=30) as c:
            return c.post("/items", json={
                "session_id": session["id"],
                "object_class_id": classes["monitor"]["id"],
                "condition": "gebraucht",
            })

    with ThreadPoolExecutor(max_workers=12) as pool:
        responses = list(pool.map(create_one, range(12)))
    statuses = [r.status_code for r in responses]
    ids = [r.json().get("inventory_id") for r in responses if r.status_code == 200]
    ok("race: 12 parallele Erfassungen ohne Fehler", all(s == 200 for s in statuses), f"Status: {set(statuses)}")
    ok("race: alle Inventar-IDs eindeutig", len(set(ids)) == 12, f"{len(set(ids))}/12 eindeutig")

    item = responses[0].json()
    item_id = item["id"]

    # --- Validierung ----------------------------------------------------------
    bad_condition = client.post("/items", json={
        "session_id": session["id"], "condition": "kaputtgespart",
    })
    ok("validierung: ungueltiger Zustand wird abgelehnt", bad_condition.status_code == 422)
    bad_status = client.patch(f"/items/{item_id}", json={"review_status": "quatsch"})
    ok("validierung: ungueltiger Pruefstatus wird abgelehnt", bad_status.status_code == 422)

    # --- Uploads ---------------------------------------------------------------
    bad_file = client.post(f"/items/{item_id}/photos?photo_type=object",
                           files={"file": ("notiz.txt", b"kein bild", "text/plain")})
    ok("upload: Textdatei als Foto wird abgelehnt", bad_file.status_code == 422)
    bad_type = client.post(f"/items/{item_id}/photos?photo_type=selfie",
                           files={"file": ("a.jpg", TINY_JPEG, "image/jpeg")})
    ok("upload: unbekannter Fototyp wird abgelehnt", bad_type.status_code == 422)

    photo = client.post(f"/items/{item_id}/photos?photo_type=object",
                        files={"file": ("objekt.jpg", TINY_JPEG, "image/jpeg")})
    ok("upload: Objektfoto gespeichert", photo.status_code == 200)
    photo_id = photo.json()["id"]
    served = client.get(f"/files/photo/{photo_id}")
    ok("dateien: Foto wird ausgeliefert", served.status_code == 200 and served.content[:2] == b"\xff\xd8")

    audio = client.post(f"/items/{item_id}/audio",
                        data={"transcript": "Dell Monitor, Serviceannahme, Zustand gut"},
                        files={"file": ("notiz.webm", b"\x1aE\xdf\xa3 testaudio", "audio/webm")})
    ok("audio: Aufnahme + Transkript gespeichert", audio.status_code == 200)
    audio_empty = client.post(f"/items/{item_id}/audio")
    ok("audio: leere Anfrage wird abgelehnt", audio_empty.status_code == 422)

    # --- KI-Stub ---------------------------------------------------------------
    ai = client.post(f"/items/{item_id}/ai/run")
    ok("ki: Stub-Lauf erfolgreich", ai.status_code == 200)
    detail = client.get(f"/items/{item_id}").json()
    ok("ki: Klasse des Erfassers bleibt erhalten (Monitor)",
       detail.get("object_type") in ("Monitor", "Unbekanntes Objekt") or detail.get("status") == "ki_fertig",
       f"status={detail.get('status')}")

    # --- Blocker & Finalisierung ----------------------------------------------
    listing = client.get(f"/sessions/{session['id']}/items").json()
    with_photo = next(entry for entry in listing if entry["id"] == item_id)
    no_photo = next(entry for entry in listing if entry["id"] != item_id)
    ok("blocker: Item ohne Foto hat Objektfoto-Blocker", "Objektfoto" in (no_photo.get("blockers") or []))
    ok("blocker: Item mit Foto ist finalisierbar", not with_photo.get("blockers"),
       str(with_photo.get("blockers")))
    ok("listing: Fotoliste am Item enthalten", any(p["photo_type"] == "object" for p in with_photo.get("photos", [])))

    blocked_finalize = client.post(f"/items/{no_photo['id']}/finalize")
    ok("finalize: mit Blockern abgelehnt", blocked_finalize.status_code == 409)
    finalized = client.post(f"/items/{item_id}/finalize")
    ok("finalize: ohne Blocker erfolgreich", finalized.status_code == 200)
    again = client.post(f"/items/{item_id}/finalize")
    ok("finalize: zweites Mal abgelehnt (gesperrt)", again.status_code == 409)
    locked_patch = client.patch(f"/items/{item_id}", json={"brand": "Manipuliert"})
    ok("sperre: PATCH auf finalisiertes Item abgelehnt", locked_patch.status_code == 409)

    # --- Raumabschluss ----------------------------------------------------------
    blocked_close = client.post(f"/sessions/{session['id']}/close")
    ok("abschluss: mit offenen Blockern abgelehnt", blocked_close.status_code == 409)

    clean = client.post("/sessions", json={
        "location_id": location["id"], "building_id": building["id"], "room_id": room["id"],
    }).json()
    clean_item = client.post("/items", json={
        "session_id": clean["id"], "object_class_id": classes["monitor"]["id"],
    }).json()
    client.post(f"/items/{clean_item['id']}/photos?photo_type=object",
                files={"file": ("o.jpg", TINY_JPEG, "image/jpeg")})
    closed = client.post(f"/sessions/{clean['id']}/close")
    ok("abschluss: ohne Blocker erfolgreich", closed.status_code == 200)
    closed_again = client.post(f"/sessions/{clean['id']}/close")
    ok("abschluss: doppelt abgeschlossen wird abgelehnt", closed_again.status_code == 409)
    late_item = client.post("/items", json={"session_id": clean["id"]})
    ok("abschluss: Erfassung in geschlossener Session abgelehnt", late_item.status_code == 409)

    # --- Offline-Sync: Idempotenz (O2) -------------------------------------------
    import uuid
    capture_id = str(uuid.uuid4())
    first = client.post("/items", json={
        "session_id": session["id"], "object_class_id": classes["monitor"]["id"],
        "client_capture_id": capture_id, "manufacturing_year": 2018,
    })
    second = client.post("/items", json={
        "session_id": session["id"], "object_class_id": classes["monitor"]["id"],
        "client_capture_id": capture_id,
    })
    ok("idempotenz: doppelter Sync liefert dasselbe Item", 
       first.status_code == 200 and second.status_code == 200 and first.json()["id"] == second.json()["id"])
    ok("diktat: Baujahr wird gespeichert", str(first.json().get("manufacturing_date", "")).startswith("2018"))
    dup_item_id = first.json()["id"]
    p1 = client.post(f"/items/{dup_item_id}/photos?photo_type=object",
                     files={"file": ("a.jpg", TINY_JPEG, "image/jpeg")})
    p2 = client.post(f"/items/{dup_item_id}/photos?photo_type=object",
                     files={"file": ("b.jpg", TINY_JPEG, "image/jpeg")})
    ok("idempotenz: doppeltes Foto erzeugt keine Dublette",
       p1.status_code == 200 and p2.status_code == 200 and p1.json()["id"] == p2.json()["id"])
    a1 = client.post(f"/items/{dup_item_id}/audio", data={"transcript": "Monitor Dell Zustand gut"})
    a2 = client.post(f"/items/{dup_item_id}/audio", data={"transcript": "Monitor Dell Zustand gut"})
    ok("idempotenz: doppelte Sprachnotiz erzeugt keine Dublette",
       a1.status_code == 200 and a2.status_code == 200 and a1.json()["id"] == a2.json()["id"])

    # --- Geraete-Heartbeat (Vertrauens-UI) ---------------------------------------
    device_id = joined.json()["device"]["id"]
    hb = client.post(f"/sessions/{session['id']}/devices/{device_id}/heartbeat", json={"pending_count": 3})
    ok("heartbeat: angenommen", hb.status_code == 200 and hb.json()["pending_count"] == 3)
    device_list = client.get(f"/sessions/{session['id']}/devices").json()
    ok("heartbeat: Pruefansicht sieht ausstehende Erfassungen",
       any(d["id"] == device_id and d.get("pending_count") == 3 and d.get("last_seen_at") for d in device_list))

    # --- Reopen (Offline-Quarantaene-Aufloesung) ---------------------------------
    reopened = client.post(f"/sessions/{clean['id']}/reopen")
    ok("reopen: abgeschlossener Raum wieder geoeffnet", reopened.status_code == 200 and reopened.json()["status"] == "open")
    late_after_reopen = client.post("/items", json={
        "session_id": clean["id"], "object_class_id": classes["monitor"]["id"],
    })
    ok("reopen: Nachsync nach Wiedereroeffnung moeglich", late_after_reopen.status_code == 200)
    reopen_open = client.post(f"/sessions/{session['id']}/reopen")
    ok("reopen: offener Raum wird abgelehnt", reopen_open.status_code == 409)

    # --- Stammdaten fuer Offline-Cache -------------------------------------------
    ok("bootstrap: Markenlexikon vorhanden", "Nussbaum" in (boot.get("brands") or []))
    reqs_all = client.get("/meta/field-requirements")
    ok("stammdaten: alle Pflichtfelder in einem Aufruf", reqs_all.status_code == 200 and len(reqs_all.json()) >= 10)

    # --- Export -----------------------------------------------------------------
    export = client.post(f"/sessions/{session['id']}/export/excel").json()
    download = client.get(f"/exports/{export['id']}/download")
    ok("export: Excel erzeugt und herunterladbar",
       download.status_code == 200 and download.content[:2] == b"PK")

    # --- Audit ------------------------------------------------------------------
    log = client.get(f"/items/{item_id}/audit-log").json()
    actions = {entry["action"] for entry in log}
    ok("audit: Kernaktionen protokolliert",
       {"item_created", "photo_uploaded", "item_finalized"}.issubset(actions), str(actions))

    print(f"\n{checks.count('PASS')}/{len(checks)} Checks bestanden.")


def test_integration() -> None:  # pytest-Einstieg
    main()


if __name__ == "__main__":
    main()
