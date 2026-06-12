"""Worker: Transkriptions-Queue + Diktat-Feld-Nachtrag.

Verarbeitet Audionotizen mit transcript_status='pending':
1. Transkription mit faster-whisper (on-prem, DSGVO-sauber; Modell 'small').
2. Slot-Parser (dictation.py) extrahiert Felder, BGA-Mapping fuellt NUR
   leere Felder am Item nach (Audit: fields_from_dictation). Statusfelder
   der bestehenden BGA-/KI-Logik werden bewusst nicht angefasst.

Graceful degradation: Ist faster-whisper nicht installiert oder das Modell
nicht ladbar, bleiben Audio-Notizen 'pending' (kein Datenverlust).
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from .db import execute, fetch_all, fetch_one
from .dictation import parse_dictation, to_bga_fields
from .logic import audit
from .settings import settings

log = logging.getLogger("inventar.worker")
logging.basicConfig(level=logging.INFO)

_whisper_model = None
_whisper_failed = False

# Vom Diktat befuellbare Items-Spalten (nur wenn leer; nie Status/Review).
_FILLABLE = ("object_type", "specification", "serial_number", "construction_year", "remark")


def get_whisper():
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
        log.exception("faster-whisper nicht verfuegbar – Audio bleibt 'pending'")
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
    """Fuellt NUR leere Felder – Diktat ueberschreibt nie Eingaben."""
    item = fetch_one("SELECT * FROM inventory_items WHERE id = %s", (item_id,))
    if not item or item.get("locked_at"):
        return
    brands = [row["name"] for row in fetch_all("SELECT name FROM brand_lexicon")]
    fields = to_bga_fields(parse_dictation(transcript, brands))
    updates: dict[str, object] = {
        key: value for key, value in fields.items()
        if key in _FILLABLE and value and not item.get(key)
    }
    if fields.get("condition") and item.get("condition") in (None, "", "gebraucht"):
        updates["condition"] = fields["condition"]
    if not updates:
        return
    columns = ", ".join(f"{key} = %s" for key in updates)
    execute(
        f"UPDATE inventory_items SET {columns}, updated_at = now() "
        "WHERE id = %s AND locked_at IS NULL RETURNING id",
        tuple(updates.values()) + (item_id,),
    )
    audit("fields_from_dictation", "inventory_item", item_id, {"fields": list(updates), "source": "worker"})


def process_pending_note() -> bool:
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


def main() -> None:
    log.info("Inventar-Worker gestartet (Transkription + Diktat-Felder). Whisper: %s", settings.whisper_model)
    while True:
        try:
            if not process_pending_note():
                time.sleep(5)
        except Exception:
            log.exception("Worker-Schleife: unerwarteter Fehler")
            time.sleep(10)


if __name__ == "__main__":
    main()
