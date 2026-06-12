"""Zentrale Statuswerte. Quelle: docs/DATA_MODEL.md.

Vorher waren diese Werte nur im Frontend hartkodiert; die API akzeptierte
beliebige Strings. Jetzt validieren alle Endpoints gegen diese Whitelists.
"""

CAPTURE_STATUSES = {
    "lokal_erfasst", "upload_laeuft", "hochgeladen", "ki_wartet", "ki_laeuft",
    "ki_fertig", "upload_fehler", "ki_fehler", "nacharbeit_noetig", "pruefen",
    "geprueft", "finalisiert", "gesperrt",
}

REVIEW_STATUSES = {
    "erfasst", "ki_vorgefuellt", "nacharbeit_erfasser", "nacharbeit_pruefer",
    "nacharbeit_buchhaltung", "nacharbeit_technik", "finalisierbar",
    "finalisiert", "abweichung", "dublette",
}

LIFECYCLE_STATUSES = {
    "aktiv", "neu_gefunden", "nicht_gefunden", "umgezogen", "ausser_betrieb",
    "verkauft", "verschrottet", "verloren", "ersetzt", "zusammengefuehrt",
    "archiviert",
}

ACCOUNTING_STATUSES = {
    "nicht_relevant", "offen", "buchhaltung_pruefen", "bestaetigt",
    "abweichung", "ausgebucht_pruefen",
}

CONDITIONS = {
    "neu", "sehr_gut", "gut", "gebraucht", "reparaturbeduerftig", "defekt",
    "aussondern",
}

COMMERCIAL_CATEGORIES = {
    "anlagevermoegen", "gwg_pruefen", "betriebsmittel", "ware", "kundenware",
    "verbrauchsmaterial", "it_ausstattung", "bueroausstattung",
    "werkstattausstattung", "nicht_relevant", "ungeklaert",
}

PHOTO_TYPES = {"object", "nameplate", "serial", "condition", "dot", "other"}

TASK_STATUSES = {"open", "in_progress", "completed", "cancelled"}

ASSIGNED_ROLES = {"Erfasser", "Pruefer", "Buchhaltung", "Technik"}

ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp"}
ALLOWED_AUDIO_SUFFIXES = {".webm", ".mp4", ".m4a", ".mp3", ".ogg", ".wav", ".aac", ".opus", ".txt"}
