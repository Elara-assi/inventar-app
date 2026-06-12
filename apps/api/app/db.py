"""Datenbankzugriff mit Connection-Pool und Transaktionssupport.

Phase-1-Haertung: Vorher oeffnete jede Query eine eigene Verbindung; unter
Polling-Last (Pruefansicht) fuehrte das zu Verbindungsabbruechen. Der Pool
haelt Verbindungen vor, `transaction()` buendelt mehrschrittige Operationen
atomar (Commit beim Verlassen, Rollback bei Exception).
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .settings import settings

log = logging.getLogger("inventar.db")

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.database_url,
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
            kwargs={"row_factory": dict_row},
            timeout=10,
            open=True,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        try:
            _pool.close()
        except Exception:  # pragma: no cover - defensiv beim Shutdown
            log.exception("Pool close failed")
        _pool = None


@contextmanager
def transaction() -> Iterator[psycopg.Connection]:
    """Eine Verbindung, eine Transaktion: alles oder nichts."""
    with get_pool().connection() as conn:
        with conn.transaction():
            yield conn


def _run(query: str, params: tuple[Any, ...], conn: psycopg.Connection):
    cur = conn.execute(query, params)
    return cur


def fetch_one(
    query: str, params: tuple[Any, ...] = (), conn: psycopg.Connection | None = None
) -> dict[str, Any] | None:
    if conn is not None:
        return _run(query, params, conn).fetchone()
    with get_pool().connection() as c:
        return _run(query, params, c).fetchone()


def fetch_all(
    query: str, params: tuple[Any, ...] = (), conn: psycopg.Connection | None = None
) -> list[dict[str, Any]]:
    if conn is not None:
        return list(_run(query, params, conn).fetchall())
    with get_pool().connection() as c:
        return list(_run(query, params, c).fetchall())


def execute(
    query: str, params: tuple[Any, ...] = (), conn: psycopg.Connection | None = None
) -> dict[str, Any] | None:
    """Schreibende Query; gibt die RETURNING-Zeile zurueck, falls vorhanden.

    Ausserhalb einer expliziten Transaktion committet der Pool-Kontext beim
    Verlassen automatisch (Rollback bei Exception).
    """
    if conn is not None:
        cur = _run(query, params, conn)
        return cur.fetchone() if cur.description else None
    with get_pool().connection() as c:
        cur = _run(query, params, c)
        return cur.fetchone() if cur.description else None
