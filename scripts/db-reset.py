from __future__ import annotations

import os
from pathlib import Path

import psycopg


ROOT = Path(__file__).resolve().parents[1]
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://inventar:inventar@localhost:5432/inventar")


def run_sql(conn: psycopg.Connection, path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)


def main() -> None:
    upload_root = Path(os.environ.get("UPLOAD_ROOT", ROOT / "storage" / "uploads"))
    for folder in ["originals", "stamped", "audio", "exports", "temp"]:
        (upload_root / folder).mkdir(parents=True, exist_ok=True)

    with psycopg.connect(DATABASE_URL, autocommit=True, connect_timeout=5) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP SCHEMA IF EXISTS public CASCADE")
            cur.execute("CREATE SCHEMA public")
            cur.execute("GRANT ALL ON SCHEMA public TO public")
        run_sql(conn, ROOT / "db" / "migrations" / "001_init.sql")
        run_sql(conn, ROOT / "db" / "seeds" / "001_seed.sql")

    print("Database reset complete: migrations and seeds applied.")


if __name__ == "__main__":
    main()
