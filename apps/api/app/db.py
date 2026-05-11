from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row
try:
    from psycopg_pool import ConnectionPool
except Exception:  # pragma: no cover - local fallback if the optional package is not installed yet.
    ConnectionPool = None  # type: ignore[assignment]

from .settings import settings


_pool: Any | None = None


def _get_pool() -> Any | None:
    global _pool
    if ConnectionPool is None:
        return None
    if _pool is None:
        _pool = ConnectionPool(
            conninfo=settings.database_url,
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
            timeout=settings.db_pool_timeout_seconds,
            kwargs={"row_factory": dict_row, "connect_timeout": 2},
            open=True,
        )
    return _pool


def db_pool_status() -> dict[str, Any]:
    pool = _get_pool()
    if pool is None:
        return {"enabled": False, "available": False}
    try:
        stats = pool.get_stats()
    except Exception:
        stats = {}
    return {
        "enabled": True,
        "available": True,
        "min_size": settings.db_pool_min_size,
        "max_size": settings.db_pool_max_size,
        "stats": stats,
    }


@contextmanager
def get_conn():
    pool = _get_pool()
    if pool is not None:
        with pool.connection() as conn:
            yield conn
        return
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
