"""Lasttest: N parallele Handys erfassen gleichzeitig, Pruefer pollen live.

Simuliert den Volllast-Fall (z. B. 15 Erfasser im Gebaeude) inklusive
Sync-Burst nach einer Offline-Phase (alle Geraete senden ohne Pause).

Start:  DATABASE_URL=... uvicorn laeuft auf API_URL
Aufruf: python scripts/load-test.py [Handys=15] [Objekte je Handy=10]
"""
from __future__ import annotations

import os
import random
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

API = os.environ.get("API_URL", "http://localhost:8000")
PHONES = int(sys.argv[1]) if len(sys.argv) > 1 else 15
ITEMS_PER_PHONE = int(sys.argv[2]) if len(sys.argv) > 2 else 10
PHOTO_BYTES = 150 * 1024  # ~150 KB je Foto (komprimiertes Handyfoto)

JPEG_HEAD = bytes.fromhex("ffd8ffe000104a46494600")

lat: dict[str, list[float]] = {"item": [], "photo": [], "audio": [], "poll": []}
errors: list[str] = []
lock = threading.Lock()
stop_polling = threading.Event()


def record(kind: str, start: float, response: httpx.Response) -> None:
    ms = (time.perf_counter() - start) * 1000
    with lock:
        lat[kind].append(ms)
        if response.status_code != 200:
            errors.append(f"{kind}: HTTP {response.status_code} {response.text[:120]}")


def fake_photo() -> bytes:
    return JPEG_HEAD + random.randbytes(PHOTO_BYTES)


def phone(session_id: str, class_id: str, phone_no: int) -> list[str]:
    """Ein Handy: erfasst Objekte ohne Pause (Worst Case / Sync-Burst)."""
    ids: list[str] = []
    with httpx.Client(base_url=API, timeout=60) as c:
        for _ in range(ITEMS_PER_PHONE):
            t = time.perf_counter()
            r = c.post("/items", json={
                "session_id": session_id,
                "object_class_id": class_id,
                "condition": "gebraucht",
                "created_by": None,
            })
            record("item", t, r)
            if r.status_code != 200:
                continue
            item = r.json()
            ids.append(item["inventory_id"])
            for photo_type in ("object", "nameplate"):
                t = time.perf_counter()
                r2 = c.post(f"/items/{item['id']}/photos?photo_type={photo_type}",
                            files={"file": (f"{photo_type}.jpg", fake_photo(), "image/jpeg")})
                record("photo", t, r2)
            t = time.perf_counter()
            r3 = c.post(f"/items/{item['id']}/audio",
                        data={"transcript": f"Monitor Dell, Handy {phone_no}, Zustand gut"})
            record("audio", t, r3)
    return ids


def reviewer(session_id: str) -> None:
    """Pruefer-Dashboard: pollt die Item-Liste wie das echte Frontend."""
    with httpx.Client(base_url=API, timeout=60) as c:
        while not stop_polling.is_set():
            t = time.perf_counter()
            r = c.get(f"/sessions/{session_id}/items")
            record("poll", t, r)
            stop_polling.wait(2.5)


def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    return values[min(int(len(values) * p), len(values) - 1)]


def main() -> None:
    client = httpx.Client(base_url=API, timeout=30)
    boot = client.get("/meta/bootstrap").json()
    room = boot["rooms"][0]
    building = next(b for b in boot["buildings"] if b["id"] == room["building_id"])
    location = next(l for l in boot["locations"] if l["id"] == building["location_id"])
    monitor = next(c for c in boot["object_classes"] if c["slug"] == "monitor")
    session = client.post("/sessions", json={
        "location_id": location["id"], "building_id": building["id"], "room_id": room["id"],
    }).json()

    print(f"Lasttest: {PHONES} Handys x {ITEMS_PER_PHONE} Objekte (je 1 Item + 2 Fotos a {PHOTO_BYTES//1024} KB + 1 Audio), 2 Pruefer pollen alle 2,5 s")
    started = time.perf_counter()
    pollers = [threading.Thread(target=reviewer, args=(session["id"],), daemon=True) for _ in range(2)]
    for p in pollers:
        p.start()

    with ThreadPoolExecutor(max_workers=PHONES) as pool:
        results = list(pool.map(lambda i: phone(session["id"], monitor["id"], i), range(PHONES)))

    stop_polling.set()
    for p in pollers:
        p.join(timeout=5)
    wall = time.perf_counter() - started

    all_ids = [x for sub in results for x in sub]
    total_requests = sum(len(v) for v in lat.values())
    print(f"\nDauer: {wall:.1f} s | Requests: {total_requests} | Durchsatz: {total_requests/wall:.0f} req/s")
    print(f"Objekte: {len(all_ids)} erzeugt, {len(set(all_ids))} eindeutige Inventar-IDs")
    print(f"Fehler: {len(errors)}")
    for e in errors[:10]:
        print("  !", e)
    print(f"\n{'Operation':<10}{'Anz.':>6}{'p50 ms':>10}{'p95 ms':>10}{'max ms':>10}")
    for kind, values in lat.items():
        if values:
            print(f"{kind:<10}{len(values):>6}{statistics.median(values):>10.0f}{pct(values, 0.95):>10.0f}{max(values):>10.0f}")

    # Pruefansicht-Worst-Case nach dem Test: ein Poll auf den vollen Raum
    t = time.perf_counter()
    r = client.get(f"/sessions/{session['id']}/items")
    full_ms = (time.perf_counter() - t) * 1000
    print(f"\nPruefansicht bei {len(r.json())} Objekten im Raum: {full_ms:.0f} ms")

    okay = not errors and len(set(all_ids)) == PHONES * ITEMS_PER_PHONE
    print("\nERGEBNIS:", "STABIL – keine Fehler, alle IDs eindeutig" if okay else "INSTABIL – siehe Fehler")
    sys.exit(0 if okay else 1)


if __name__ == "__main__":
    main()
