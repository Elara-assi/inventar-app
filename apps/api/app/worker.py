"""Worker: Transkriptions-Queue + Diktat-Feld-Nachtrag (D3).

Verarbeitet Audionotizen mit transcript_status='pending':
1. Transkription mit faster-whisper (on-prem, DSGVO-sauber; Modell 'small').
2. Slot-Parser (dictation.py) extrahiert Felder.
3. Nachtrag NUR leerer Felder am Item + Audit-Eintrag; der Pruefer entscheidet.

Graceful degradation: Ist faster-whisper nicht installiert oder das Modell
nicht ladbar, bleibt die Notiz 'pending' (kein Datenverlust) und der Worker
verarbeitet weiterhin Diktate, deren Transkript bereits vorliegt.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from .db import execute, fetch_all, fetch_one
from .logic import audit
from .dictation import parse_dictation
from .settings import settings

log = logging.getLogger("inventar.worker")
logging.basicConfig(level=logging.INFO)

_whisper_model = None
_whisper_failed = False


def get_whisper():
    """Laedt das Whisper-Modell einmalig; None, wenn nicht verfuegbar."""
    global _whisper_model, _whisper_failed
    if _whisper_model is not None or _whisper_failed:
        return _whisper_model
    if not settings.whisper_enabled:
        _whisper_failed = True
        return None
    try:
        from faster_whisper import WhisperModel  # optionale Abhaengigkeit

        log.info("Lade Whisper-Modell '%s' ...", settings.whisper_model)
        _whisper_model = WhisperModel(
            settings.whisper_model,
            device="cpu",
            compute_type="int8",
            download_root=settings.whisper_model_dir,
        )
        log.info("Whisper-Modell geladen.")
    except Exception:
        log.exception("faster-whisper nicht verfuegbar – Audio bleibt 'pending', Parser laeuft nur auf vorhandene Transkripte")
        _whisper_failed = True
    return _whisper_model


def transcribe(audio_path: str) -> str | None:
    model = get_whisper()
    if model is None:
        return None
    path = Path(audio_path)
    if not path.exists() or path.suffix == ".txt":
        return None
    segments, _info = model.transcribe(str(path), language="de", vad_filter=True)
    return " ".join(segment.text.strip() for segment in segments).strip() or None


def apply_dictation_fields(item_id: str, transcript: str) -> None:
    """Fuellt NUR leere Felder – diktierte Angaben ueberschreiben nie Eingaben."""
    item = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not item or item.get("locked_at"):
        return
    brands = [row["name"] for row in fetch_all("SELECT name FROM brand_lexicon")]
    parsed = parse_dictation(transcript, brands)
    if not parsed:
        return
    updates: dict[str, object] = {}
    for field in ("brand", "model", "serial_number", "object_type"):
        if parsed.get(field) and not item.get(field):
            updates[field] = parsed[field]
    if parsed.get("manufacturing_year") and not item.get("manufacturing_date"):
        updates["manufacturing_date"] = f"{parsed['manufacturing_year']}-01-01"
    if parsed.get("condition") and item.get("condition") in (None, "", "gebraucht"):
        updates["condition"] = parsed["condition"]
    if parsed.get("note") and not item.get("condition_note"):
        updates["condition_note"] = parsed["note"]
    if parsed.get("object_class_slug") and not item.get("object_class_id"):
        oc = fetch_one("SELECT id FROM object_classes WHERE slug = %s", (parsed["object_class_slug"],))
        if oc:
            updates["object_class_id"] = oc["id"]
    if not updates:
        return
    columns = ", ".join(f"{key} = %s" for key in updates)
    execute(
        f"UPDATE inventory_items SET {columns}, review_status = 'ki_vorgefuellt', updated_at = now() "
        "WHERE id = %s AND locked_at IS NULL RETURNING id",
        tuple(updates.values()) + (item_id,),
    )
    audit("fields_from_dictation", "inventory_item", item_id, {"fields": list(updates), "source": "worker"})


def process_pending_note() -> bool:
    """Verarbeitet eine wartende Audionotiz. True, wenn etwas zu tun war."""
    note = fetch_one(
        """
        SELECT * FROM item_audio_notes
        WHERE transcript_status = 'pending'
        ORDER BY uploaded_at
        LIMIT 1
        """
    )
    if not note:
        return False
    note_id = note["id"]
    try:
        transcript = transcribe(note["audio_path"])
        if transcript is None:
            if get_whisper() is None:
                return False  # Whisper fehlt: pending lassen, spaeter erneut
            execute(
                "UPDATE item_audio_notes SET transcript_status = 'failed' WHERE id = %s RETURNING id",
                (note_id,),
            )
            return True
        execute(
            "UPDATE item_audio_notes SET transcript = %s, transcript_status = 'completed' WHERE id = %s RETURNING id",
            (transcript, note_id),
        )
        apply_dictation_fields(str(note["item_id"]), transcript)
        log.info("Transkribiert: Notiz %s (%d Zeichen)", note_id, len(transcript))
    except Exception:
        log.exception("Transkription fehlgeschlagen fuer Notiz %s", note_id)
        execute(
            "UPDATE item_audio_notes SET transcript_status = 'failed' WHERE id = %s RETURNING id",
            (note_id,),
        )
    return True


def process_parsed_backlog() -> None:
    """Diktate mit vorhandenem Transkript, deren Items noch leer sind
    (z. B. Texteingabe ohne Audio): Felder einmalig nachtragen."""
    rows = fetch_all(
        """
        SELECT n.id, n.item_id, n.transcript
        FROM item_audio_notes n
        JOIN inventory_items i ON i.id = n.item_id
        WHERE n.transcript_status = 'completed'
          AND n.transcript IS NOT NULL AND n.transcript <> ''
          AND i.locked_at IS NULL
          AND i.brand IS NULL AND i.model IS NULL AND i.serial_number IS NULL
        ORDER BY n.uploaded_at
        LIMIT 20
        """
    )
    for row in rows:
        apply_dictation_fields(str(row["item_id"]), row["transcript"])


def main() -> None:
    log.info("Inventar-Worker gestartet (Transkription + Diktat-Felder). Whisper: %s", settings.whisper_model)
    backlog_counter = 0
    while True:
        try:
            worked = process_pending_note()
            backlog_counter += 1
            if backlog_counter >= 12:  # ca. alle 60 s
                process_parsed_backlog()
                backlog_counter = 0
            if not worked:
                time.sleep(5)
        except Exception:
            log.exception("Worker-Schleife: unerwarteter Fehler")
            time.sleep(10)


if __name__ == "__main__":
    main()
