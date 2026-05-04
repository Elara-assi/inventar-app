from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .settings import settings


@contextmanager
def get_conn():
    with psycopg.connect(settings.database_url, row_factory=dict_row, connect_timeout=2) as conn:
        yield conn


def fetch_one(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            return cur.fetchone()


def fetch_all(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            return list(cur.fetchall())


def execute(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            row = cur.fetchone() if cur.description else None
            conn.commit()
            return row
