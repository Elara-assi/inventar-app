from __future__ import annotations

from pathlib import Path

import psycopg

from .settings import settings


LEGACY_BASELINE = {
    "001_init.sql",
    "002_export_scope.sql",
    "003_ai_learning_examples.sql",
    "004_bga_capture.sql",
    "005_tires_wheels.sql",
    "006_session_inventory_type.sql",
    "007_offline_queue_ids.sql",
}


def _migration_dir() -> Path:
    configured = Path(settings.migrations_path)
    if configured.exists():
        return configured
    return Path(__file__).resolve().parents[3] / "db" / "migrations"


def run_migrations() -> list[str]:
    if not settings.enable_migration_runner:
        return []
    migration_dir = _migration_dir()
    files = sorted(migration_dir.glob("*.sql"))
    if not files:
        return []

    applied_now: list[str] = []
    with psycopg.connect(settings.database_url, connect_timeout=5) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                  filename TEXT PRIMARY KEY,
                  checksum TEXT NOT NULL,
                  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            cur.execute("SELECT to_regclass('public.inventory_sessions') IS NOT NULL")
            has_legacy_schema = bool(cur.fetchone()[0])
            cur.execute("SELECT count(*) FROM schema_migrations")
            has_records = int(cur.fetchone()[0]) > 0
            if has_legacy_schema and not has_records:
                for file in files:
                    if file.name in LEGACY_BASELINE:
                        cur.execute(
                            """
                            INSERT INTO schema_migrations (filename, checksum)
                            VALUES (%s, %s)
                            ON CONFLICT (filename) DO NOTHING
                            """,
                            (file.name, "legacy-baseline"),
                        )
                conn.commit()

            cur.execute("SELECT filename FROM schema_migrations")
            applied = {row[0] for row in cur.fetchall()}
            for file in files:
                if file.name in applied:
                    continue
                sql = file.read_text(encoding="utf-8")
                checksum = __import__("hashlib").sha256(sql.encode("utf-8")).hexdigest()
                cur.execute(sql)
                cur.execute(
                    """
                    INSERT INTO schema_migrations (filename, checksum)
                    VALUES (%s, %s)
                    ON CONFLICT (filename) DO NOTHING
                    """,
                    (file.name, checksum),
                )
                applied_now.append(file.name)
            conn.commit()
    return applied_now
