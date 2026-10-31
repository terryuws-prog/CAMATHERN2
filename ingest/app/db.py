import hashlib
import logging
import os
import time
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg_pool import ConnectionPool

log = logging.getLogger("ingest.db")

SCHEMA_LOCK_ID = 727_001  # arbitrary constant for pg_advisory_lock


def conninfo() -> str:
    """DATABASE_URL wins if set; otherwise build from separate variables,
    which avoids URL-escaping problems with special characters in passwords."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    return make_conninfo(
        host=os.environ.get("DB_HOST", "db"),
        port=os.environ.get("DB_PORT", "5432"),
        dbname=os.environ.get("DB_NAME", "sensors"),
        user=os.environ.get("DB_USER", "sensors"),
        password=os.environ.get("DB_PASSWORD", ""),
    )


pool = ConnectionPool(conninfo(), min_size=1, max_size=10, open=False)


def hash_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def create_database() -> None:
    """Create the configured database. Lets one Postgres container hold both
    the production and the dev database without an init script."""
    target = conninfo_to_dict(conninfo())["dbname"]
    with psycopg.connect(make_conninfo(conninfo(), dbname="postgres"), autocommit=True) as conn:
        try:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(target)))
            log.info("created database %s", target)
        except psycopg.errors.DuplicateDatabase:
            pass


def wait_for_db(timeout_s: float = 60) -> None:
    target = conninfo_to_dict(conninfo()).get("dbname")
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            with psycopg.connect(conninfo(), connect_timeout=5) as conn:
                conn.execute("SELECT 1")
            return
        except psycopg.OperationalError as exc:
            if f'database "{target}" does not exist' in str(exc):
                create_database()
                continue
            if time.monotonic() > deadline:
                raise
            log.warning("database not ready yet (%s), retrying", exc)
            time.sleep(2)


def init_schema() -> None:
    sql = (Path(__file__).parent / "schema.sql").read_text()
    with psycopg.connect(conninfo(), autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (SCHEMA_LOCK_ID,))
        try:
            conn.execute(sql)
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (SCHEMA_LOCK_ID,))
