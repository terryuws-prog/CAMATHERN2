import csv
import io
import json
import logging
import math
import os
import zlib
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional

import psycopg
from fastapi import FastAPI, Query, Request, Security
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from fastapi.security import APIKeyHeader
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ValidationError

from . import db
from .models import COLUMNS, Record

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ingest")

MAX_BATCH_RECORDS = int(os.environ.get("MAX_BATCH_RECORDS", "200"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", "1000000"))
DOCS_ENABLED = os.environ.get("DOCS_ENABLED", "true").lower() in ("1", "true", "yes")
# Public path prefix stripped by the reverse proxy, e.g. "/cam" or "/cam/dev".
ROOT_PATH = os.environ.get("ROOT_PATH", "").rstrip("/")

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False,
                              description="Per-device key issued with `python -m app.manage add-device`.")

INSERT_READING = (
    f"INSERT INTO readings ({', '.join(COLUMNS)}) "
    f"VALUES ({', '.join(['%s'] * len(COLUMNS))}) "
    "ON CONFLICT DO NOTHING"
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await run_in_threadpool(db.wait_for_db)
    await run_in_threadpool(db.init_schema)
    await run_in_threadpool(db.pool.open, True)
    log.info("ready (max %d records per batch)", MAX_BATCH_RECORDS)
    yield
    db.pool.close()


app = FastAPI(
    title="Sensor ingestion API",
    version="0.1.0",
    description="Receives batches of readings from field nodes over cellular. See API.md.",
    lifespan=lifespan,
    root_path=ROOT_PATH,
    docs_url="/docs" if DOCS_ENABLED else None,
    redoc_url=None,
    openapi_url="/openapi.json" if DOCS_ENABLED else None,
)


# ---------- response models (used for the /docs page) ----------

class IngestResponse(BaseModel):
    status: str
    batch_id: Optional[int]
    received: int
    inserted: int
    duplicates: int
    rejected: int
    server_time_utc: str


class ErrorResponse(BaseModel):
    status: str
    error: str
    message: str
    server_time_utc: str


BATCH_SCHEMA = {
    "type": "object",
    "required": ["records"],
    "properties": {
        "node_id": {"type": "string", "description": "Optional. Must match the device the API key belongs to."},
        "fw_version": {"type": "string", "description": "Optional. Stored on every record in the batch."},
        "records": {"type": "array", "maxItems": MAX_BATCH_RECORDS, "items": Record.model_json_schema()},
    },
    "example": {
        "node_id": "node-01",
        "fw_version": "1.0.3",
        "records": [{
            "boot_count": 17, "sample_seq": 42, "timestamp_utc": "2026-10-27T15:00:00Z",
            "rtc_ok": True, "uptime_s": 3600, "ph": 7.12, "temp_c": 11.4, "ec_us_cm": 412.0,
            "do_mg_l": 9.8, "nh4_reported_mg_l": 0.12, "no3_reported_mg_l": 2.4,
            "flow_l_min": None, "depth_m": 0.35, "voltage_v": 3.92,
            "do_ok": True, "ph_ok": True, "ec_ok": True, "nh4_ok": True, "no3_ok": True, "temp_ok": True,
            "temp_source": "ec_probe", "flow_placeholder": True, "test_mode": False,
        }],
    },
}


# ---------- helpers ----------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={
        "status": "error", "error": code, "message": message, "server_time_utc": now_iso(),
    })


def parse_float(text: str) -> Optional[float]:
    value = float(text)
    return value if math.isfinite(value) else None


def sanitize(value: Any) -> Any:
    """Postgres text/jsonb cannot hold NUL characters; strip them so a corrupted
    string can never make a whole batch fail."""
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, dict):
        return {sanitize(k): sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def short_error(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or 'record'}: {e['msg']}" for e in exc.errors()
        )[:1000]
    return str(exc)[:1000]


async def read_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise BodyTooLarge()
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise BodyTooLarge()
        chunks.append(chunk)
    body = b"".join(chunks)

    encoding = request.headers.get("content-encoding", "").lower()
    if encoding in ("gzip", "deflate"):
        wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
        decompressor = zlib.decompressobj(wbits)
        body = decompressor.decompress(body, MAX_BODY_BYTES * 10)
        if decompressor.unconsumed_tail:
            raise BodyTooLarge()
    return body


class BodyTooLarge(Exception):
    pass


def device_for_key(api_key: str) -> Optional[str]:
    with db.pool.connection() as conn:
        row = conn.execute(
            "SELECT node_id FROM devices WHERE api_key_hash = %s AND active",
            (db.hash_key(api_key),),
        ).fetchone()
    return row[0] if row else None


def reading_values(rec: Record, node_id: str, batch_id: int, batch_fw: Optional[str]) -> tuple:
    fields = rec.model_dump()
    fields.update(
        node_id=node_id,
        batch_id=batch_id,
        fw_version=rec.fw_version or batch_fw,
        extra=Jsonb(rec.model_extra) if rec.model_extra else None,
    )
    return tuple(fields[c] for c in COLUMNS)


def store_batch(node_id: str, payload: dict, remote_addr: Optional[str]) -> dict:
    records = payload["records"]
    batch_fw = payload.get("fw_version")
    batch_fw = str(batch_fw) if batch_fw is not None else None
    counts = {"inserted": 0, "duplicates": 0, "rejected": 0}

    with db.pool.connection() as conn:  # one transaction; commits on success
        conn.execute("UPDATE devices SET last_seen_at = now() WHERE node_id = %s", (node_id,))
        if not records:  # empty batch = heartbeat / clock sync
            return {"batch_id": None, "received": 0, **counts}

        batch_id = conn.execute(
            "INSERT INTO raw_batches (node_id, remote_addr, record_count, payload) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (node_id, remote_addr, len(records), Jsonb(payload)),
        ).fetchone()[0]

        for raw in records:
            try:
                if not isinstance(raw, dict):
                    raise ValueError("record is not a JSON object")
                rec = Record.model_validate(raw)
                if rec.node_id is not None and rec.node_id != node_id:
                    raise ValueError(f"node_id '{rec.node_id}' does not match this API key ('{node_id}')")
                with conn.transaction():  # savepoint: a DB error affects only this record
                    cur = conn.execute(INSERT_READING, reading_values(rec, node_id, batch_id, batch_fw))
                counts["inserted" if cur.rowcount == 1 else "duplicates"] += 1
            except (ValidationError, ValueError, psycopg.DataError) as exc:
                conn.execute(
                    "INSERT INTO rejected_records (batch_id, node_id, error, record) VALUES (%s, %s, %s, %s)",
                    (batch_id, node_id, short_error(exc), Jsonb(raw)),
                )
                counts["rejected"] += 1

        conn.execute(
            "UPDATE raw_batches SET inserted = %s, duplicates = %s, rejected = %s WHERE id = %s",
            (counts["inserted"], counts["duplicates"], counts["rejected"], batch_id),
        )
    return {"batch_id": batch_id, "received": len(records), **counts}


def latest_readings(node_id: str, limit: int) -> list[dict]:
    with db.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(
            "SELECT * FROM readings WHERE node_id = %s ORDER BY received_at DESC, id DESC LIMIT %s",
            (node_id, limit),
        ).fetchall()
    for row in rows:
        for key, value in row.items():
            if isinstance(value, datetime):
                row[key] = value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return rows


# ---------- endpoints ----------

COMMON_ERRORS = {
    400: {"model": ErrorResponse, "description": "Body is not valid JSON or has no `records` array. Do not retry unchanged."},
    401: {"model": ErrorResponse, "description": "Missing, unknown or disabled API key."},
    403: {"model": ErrorResponse, "description": "Batch `node_id` does not match the API key."},
    413: {"model": ErrorResponse, "description": "Too many records or body too large. Split the batch."},
}


@app.post(
    "/api/v1/readings",
    response_model=IngestResponse,
    responses=COMMON_ERRORS,
    summary="Upload a batch of readings",
    openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": BATCH_SCHEMA}}}},
)
async def ingest(request: Request, x_api_key: Optional[str] = Security(api_key_header)):
    """A 200 response means the **whole batch is handled**: every record was stored,
    was already stored (duplicate), or was permanently rejected. Mark all of them as
    uploaded. On 5xx or a timeout, keep them and retry later."""
    if not x_api_key:
        return error(401, "missing_api_key", "Send the device key in the X-API-Key header.")
    try:
        body = await read_body(request)
    except BodyTooLarge:
        return error(413, "body_too_large", f"Body larger than {MAX_BODY_BYTES} bytes. Send fewer records.")
    except zlib.error:
        return error(400, "bad_compression", "Content-Encoding header does not match the body.")

    node_id = await run_in_threadpool(device_for_key, x_api_key)
    if node_id is None:
        return error(401, "invalid_api_key", "API key is unknown or the device is disabled.")

    try:
        payload = json.loads(body, parse_float=parse_float, parse_constant=lambda _c: None)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return error(400, "invalid_json", f"Body is not valid JSON: {exc}")
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        return error(400, "missing_records", "Body must be a JSON object with a 'records' array.")
    if payload.get("node_id") is not None and payload["node_id"] != node_id:
        return error(403, "node_mismatch", f"node_id '{payload['node_id']}' does not match this API key.")
    if len(payload["records"]) > MAX_BATCH_RECORDS:
        return error(413, "too_many_records", f"At most {MAX_BATCH_RECORDS} records per request.")

    remote = request.client.host if request.client else None
    result = await run_in_threadpool(store_batch, node_id, sanitize(payload), remote)
    log.info("node=%s batch=%s received=%d inserted=%d duplicates=%d rejected=%d",
             node_id, result["batch_id"], result["received"],
             result["inserted"], result["duplicates"], result["rejected"])
    return {"status": "ok", **result, "server_time_utc": now_iso()}


@app.get("/api/v1/readings", summary="Latest readings stored for this device (for integration testing)")
async def recent(limit: int = Query(20, ge=1, le=500),
                 x_api_key: Optional[str] = Security(api_key_header)):
    node_id = await run_in_threadpool(device_for_key, x_api_key) if x_api_key else None
    if node_id is None:
        return error(401, "invalid_api_key", "API key is missing, unknown or the device is disabled.")
    return {"node_id": node_id, "readings": await run_in_threadpool(latest_readings, node_id, limit)}


# ---------- public dashboard (read-only, no key) ----------
#
# Shapes the data the way the CAMATHERN dashboard expects it: frontend field
# names, flow in m3/s, readings whose sensor flag is false (or a placeholder
# flow) shown as null, and test_mode records left out unless asked for.

# Time of observation: the device clock when it was valid, else arrival time.
OBS_TIME = "coalesce(CASE WHEN rtc_ok IS NOT FALSE THEN timestamp_utc END, received_at)"

DASHBOARD_SAMPLES = {
    # frontend key: SQL expression
    "ph": "CASE WHEN ph_ok IS NOT FALSE THEN ph END",
    "temperature": "CASE WHEN temp_ok IS NOT FALSE THEN temp_c END",
    "conductivity": "CASE WHEN ec_ok IS NOT FALSE THEN ec_us_cm END",
    "dissolvedOxygen": "CASE WHEN do_ok IS NOT FALSE THEN do_mg_l END",
    "nitrate": "CASE WHEN no3_ok IS NOT FALSE THEN no3_reported_mg_l END",
    "ammonium": "CASE WHEN nh4_ok IS NOT FALSE THEN nh4_reported_mg_l END",
    "flow": "CASE WHEN flow_placeholder IS NOT TRUE THEN flow_l_min / 60000.0 END",  # L/min -> m3/s
}

DASHBOARD_FILTER = "d.active AND (%(include_test)s OR NOT r.test_mode)"

DASHBOARD_LATEST_SQL = f"""
    SELECT DISTINCT ON (r.node_id)
           r.node_id, d.name, r.received_at, {OBS_TIME} AS observed_at, r.rtc_ok,
           r.voltage_v, r.depth_m, r.test_mode,
           {", ".join(f'{expr} AS "{key}"' for key, expr in DASHBOARD_SAMPLES.items())}
    FROM readings r JOIN devices d ON d.node_id = r.node_id
    WHERE {DASHBOARD_FILTER}
    ORDER BY r.node_id, {OBS_TIME} DESC, r.id DESC
"""

DASHBOARD_HISTORY_SQL = f"""
    SELECT r.node_id, date_trunc('hour', {OBS_TIME}) AS hour,
           {", ".join(f'avg({expr}) AS "{key}"' for key, expr in DASHBOARD_SAMPLES.items())}
    FROM readings r JOIN devices d ON d.node_id = r.node_id
    WHERE {DASHBOARD_FILTER}
      AND {OBS_TIME} >= now() - make_interval(hours => %(hours)s)
    GROUP BY 1, 2
    ORDER BY 1, 2
"""


def iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def dashboard_data(hours: int, include_test: bool) -> dict:
    params = {"hours": hours, "include_test": include_test}
    with db.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        latest = cur.execute(DASHBOARD_LATEST_SQL, params).fetchall()
        history_rows = cur.execute(DASHBOARD_HISTORY_SQL, params).fetchall()

    history = defaultdict(list)
    for row in history_rows:
        history[row["node_id"]].append(
            {"hour": iso(row["hour"]), **{key: row[key] for key in DASHBOARD_SAMPLES}}
        )

    nodes = [{
        "deviceId": row["node_id"],
        "name": row["name"],
        "observedAt": iso(row["observed_at"]),
        "receivedAt": iso(row["received_at"]),
        "rtcOk": row["rtc_ok"],
        "voltageV": row["voltage_v"],
        "sensorDepthM": row["depth_m"],
        "tideState": "unknown",
        "testMode": row["test_mode"],
        "samples": {key: row[key] for key in DASHBOARD_SAMPLES},
        "history": history.get(row["node_id"], []),
    } for row in latest]
    return {"generatedAt": now_iso(), "hours": hours, "includeTest": include_test, "nodes": nodes}


@app.get("/api/v1/dashboard", summary="Latest reading and hourly history per node, for the public dashboard")
async def dashboard(hours: int = Query(24, ge=1, le=168, description="History window in hours"),
                    include_test: bool = Query(False, description="Include records sent with test_mode=true")):
    """Read-only and public (no API key). Only active nodes with at least one
    reading are listed. Flow is in m3/s; values whose sensor flag is false are null."""
    data = await run_in_threadpool(dashboard_data, hours, include_test)
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=30"})


# ---------- public history (read-only, no key) ----------
#
# Every stored reading for one node, raw values plus the sensor flags, newest
# first. Used by /cam/history.html. Capped so nobody can pull the whole table
# in one go.

HISTORY_FIELDS = (
    "boot_count", "sample_seq", "rtc_ok", "uptime_s", "voltage_v",
    "ph", "temp_c", "ec_us_cm", "do_mg_l", "nh4_reported_mg_l", "no3_reported_mg_l",
    "flow_l_min", "depth_m",
    "do_ok", "ph_ok", "ec_ok", "nh4_ok", "no3_ok", "temp_ok",
    "temp_source", "flow_placeholder", "test_mode", "batch_id", "fw_version",
)
HISTORY_MAX_ROWS = 5000
HISTORY_MAX_HOURS = 24 * 366

HISTORY_RANGE = "(%(hours)s::int IS NULL OR {t} >= now() - make_interval(hours => %(hours)s::int))"

HISTORY_NODES_SQL = """
    SELECT d.node_id, d.name FROM devices d
    WHERE d.active AND EXISTS (
        SELECT 1 FROM readings r WHERE r.node_id = d.node_id AND (%(include_test)s OR NOT r.test_mode))
    ORDER BY d.node_id
"""

HISTORY_READINGS_SQL = f"""
    SELECT {OBS_TIME} AS observed_at, r.timestamp_utc, r.received_at,
           {", ".join("r." + f for f in HISTORY_FIELDS)}
    FROM readings r JOIN devices d ON d.node_id = r.node_id
    WHERE r.node_id = %(node_id)s AND {DASHBOARD_FILTER}
      AND {HISTORY_RANGE.format(t=OBS_TIME)}
    ORDER BY {OBS_TIME} DESC, r.id DESC
    LIMIT %(limit)s
"""

HISTORY_UPLOADS_SQL = f"""
    SELECT b.id, b.received_at, b.record_count, b.inserted, b.duplicates, b.rejected
    FROM raw_batches b JOIN devices d ON d.node_id = b.node_id
    WHERE b.node_id = %(node_id)s AND d.active AND {HISTORY_RANGE.format(t="b.received_at")}
    ORDER BY b.id DESC
    LIMIT 500
"""

CSV_COLUMNS = ("observed_at_utc", "timestamp_utc", "received_at_utc") + HISTORY_FIELDS


class UnknownNode(Exception):
    pass


def history_data(node_id: Optional[str], hours: Optional[int], include_test: bool) -> dict:
    params = {"hours": hours, "include_test": include_test, "limit": HISTORY_MAX_ROWS}
    with db.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        nodes = [{"deviceId": r["node_id"], "name": r["name"]}
                 for r in cur.execute(HISTORY_NODES_SQL, params).fetchall()]
        if node_id is None:
            if not nodes:
                return {"generatedAt": now_iso(), "nodeId": None, "name": None, "hours": hours,
                        "includeTest": include_test, "truncated": False, "nodes": [],
                        "readings": [], "uploads": []}
            node_id = nodes[0]["deviceId"]
        match = next((n for n in nodes if n["deviceId"] == node_id), None)
        if match is None:
            raise UnknownNode(node_id)
        params["node_id"] = node_id
        rows = cur.execute(HISTORY_READINGS_SQL, params).fetchall()
        uploads = cur.execute(HISTORY_UPLOADS_SQL, params).fetchall()

    readings = []
    for row in rows:
        item = {"observedAt": iso(row.pop("observed_at")),
                "timestampUtc": iso(row.pop("timestamp_utc")),
                "receivedAt": iso(row.pop("received_at"))}
        item.update(row)
        readings.append(item)
    return {
        "generatedAt": now_iso(),
        "nodeId": node_id,
        "name": match["name"],
        "hours": hours,
        "includeTest": include_test,
        "truncated": len(readings) >= HISTORY_MAX_ROWS,
        "nodes": nodes,
        "readings": readings,
        "uploads": [{"batchId": u["id"], "receivedAt": iso(u["received_at"]), "records": u["record_count"],
                     "inserted": u["inserted"], "duplicates": u["duplicates"], "rejected": u["rejected"]}
                    for u in uploads],
    }


def csv_cell(value: Any) -> Any:
    """Stop spreadsheet apps treating device text as a formula."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return "'" + value
    return "" if value is None else value


def history_csv(data: dict) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(CSV_COLUMNS)
    for r in data["readings"]:
        writer.writerow([csv_cell(v) for v in
                         (r["observedAt"], r["timestampUtc"], r["receivedAt"], *(r[f] for f in HISTORY_FIELDS))])
    return out.getvalue()


@app.get("/api/v1/history", summary="Every stored reading for one node (raw values and flags), newest first")
async def history(node_id: Optional[str] = Query(None, description="Defaults to the first node with data"),
                  hours: Optional[int] = Query(None, ge=1, le=HISTORY_MAX_HOURS,
                                               description="Only the last N hours; omit for everything"),
                  include_test: bool = Query(False, description="Include records sent with test_mode=true"),
                  format: str = Query("json", pattern="^(json|csv)$")):
    """Read-only and public (no API key). Raw values are returned with their
    sensor flags; nothing is hidden or corrected. At most 5000 readings."""
    try:
        data = await run_in_threadpool(history_data, node_id, hours, include_test)
    except UnknownNode:
        return error(404, "unknown_node", f"No active node '{node_id}' with readings.")
    if format == "csv":
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
        filename = f"{data['nodeId'] or 'no-data'}-history-{stamp}.csv"
        return Response(history_csv(data), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"',
                                 "Cache-Control": "no-store"})
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=30"})


@app.get("/healthz", include_in_schema=False)
async def healthz():
    try:
        def ping():
            with db.pool.connection(timeout=5) as conn:
                conn.execute("SELECT 1")
        await run_in_threadpool(ping)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=503, content={"status": "error", "detail": str(exc)})
    return {"status": "ok", "server_time_utc": now_iso()}
