"""End-to-end tests against a real PostgreSQL.

    cd ingest && DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=sensors_test DB_USER=... DB_PASSWORD=... \
        pytest tests/

WARNING: drops and recreates all tables in the target database.
"""
import contextlib
import gzip
import io
import json
import os
import sys

import psycopg
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import db, manage  # noqa: E402
from app.main import app  # noqa: E402

URL = "/api/v1/readings"


def record(seq, boot=1, **overrides):
    rec = {
        "node_id": "node-01", "boot_count": boot, "sample_seq": seq,
        "timestamp_utc": f"2026-10-27T15:{seq % 60:02d}:00Z", "rtc_ok": 1, "uptime_s": 60 * seq,
        "ph": 7.1, "temp_c": 11.4, "ec_us_cm": 412, "do_mg_l": 9.8,
        "nh4_reported_mg_l": 0.12, "no3_reported_mg_l": 2.4, "flow_l_min": None,
        "depth_m": 0.35, "voltage_v": 3.92, "do_ok": 1, "ph_ok": 1, "ec_ok": 1,
        "nh4_ok": 1, "no3_ok": 1, "temp_ok": 1, "temp_source": "ec_probe",
        "flow_placeholder": 1, "test_mode": 0,
    }
    rec.update(overrides)
    return rec


def query(sql, params=()):
    with psycopg.connect(db.conninfo()) as conn:
        return conn.execute(sql, params).fetchall()


def new_device(node_id):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        assert manage.main(["add-device", node_id, "--name", "test"]) == 0
    return [ln.strip() for ln in out.getvalue().splitlines() if ln.strip().startswith("sk_")][0]


@pytest.fixture(scope="module")
def client():
    with psycopg.connect(db.conninfo(), autocommit=True) as conn:
        conn.execute("DROP TABLE IF EXISTS rejected_records, readings, raw_batches, devices CASCADE")
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def key(client):
    return new_device("node-01")


def post(client, key, body, **headers):
    data = body if isinstance(body, (bytes, str)) else json.dumps(body)
    return client.post(URL, content=data, headers={"X-API-Key": key, "Content-Type": "application/json", **headers})


def test_auth_required(client, key):
    assert client.post(URL, json={"records": []}).status_code == 401
    r = post(client, "sk_wrong", {"records": []})
    assert r.status_code == 401 and r.json()["error"] == "invalid_api_key"


def test_good_batch_then_resend_is_duplicate(client, key):
    batch = {"node_id": "node-01", "fw_version": "1.0.3", "records": [record(i) for i in range(1, 4)]}
    r = post(client, key, batch)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["received"], body["inserted"], body["duplicates"], body["rejected"]) == (3, 3, 0, 0)
    assert body["server_time_utc"].endswith("Z")

    r = post(client, key, batch)  # device never got the first response and retries
    body = r.json()
    assert r.status_code == 200
    assert (body["inserted"], body["duplicates"]) == (0, 3)

    rows = query("SELECT rtc_ok, do_ok, test_mode, fw_version, ec_us_cm FROM readings WHERE boot_count = 1 AND sample_seq = 1")
    assert rows == [(True, True, False, "1.0.3", 412.0)]


def test_same_seq_after_reboot_is_new_record(client, key):
    r = post(client, key, {"records": [record(1, boot=2)]})
    assert r.json()["inserted"] == 1


def test_bad_record_does_not_block_batch(client, key):
    bad = record(10)
    del bad["sample_seq"]
    bad["ph"] = "abc"
    r = post(client, key, {"records": [bad, record(11)]})
    body = r.json()
    assert r.status_code == 200
    assert (body["inserted"], body["rejected"]) == (1, 1)
    errors = query("SELECT error FROM rejected_records")
    assert any("sample_seq" in e[0] and "ph" in e[0] for e in errors)


def test_nan_and_infinity_become_null(client, key):
    raw = json.dumps({"records": [record(20)]}).replace('"ph": 7.1', '"ph": NaN').replace('"temp_c": 11.4', '"temp_c": 1e999')
    r = post(client, key, raw)
    assert r.json()["inserted"] == 1
    assert query("SELECT ph, temp_c FROM readings WHERE sample_seq = 20") == [(None, None)]


def test_fallback_dedupe_without_boot_count(client, key):
    rec = record(30)
    del rec["boot_count"]
    assert post(client, key, {"records": [rec]}).json()["inserted"] == 1
    assert post(client, key, {"records": [rec]}).json()["duplicates"] == 1


def test_duplicate_inside_one_batch(client, key):
    body = post(client, key, {"records": [record(40), record(40)]}).json()
    assert (body["inserted"], body["duplicates"]) == (1, 1)


def test_node_mismatch(client, key):
    r = post(client, key, {"node_id": "node-99", "records": [record(50)]})
    assert r.status_code == 403
    body = post(client, key, {"records": [record(51, node_id="node-99")]}).json()
    assert body["rejected"] == 1


def test_limits_and_malformed_bodies(client, key):
    r = post(client, key, {"records": [record(i, boot=9) for i in range(201)]})
    assert r.status_code == 413 and r.json()["error"] == "too_many_records"
    assert post(client, key, "{not json").status_code == 400
    assert post(client, key, {"rows": []}).status_code == 400
    assert post(client, key, b"x" * 1_000_001).status_code == 413


def test_empty_batch_is_heartbeat(client, key):
    r = post(client, key, {"records": []})
    assert r.status_code == 200 and r.json()["batch_id"] is None
    assert query("SELECT last_seen_at IS NOT NULL FROM devices WHERE node_id = 'node-01'") == [(True,)]


def test_gzip_body(client, key):
    raw = gzip.compress(json.dumps({"records": [record(60)]}).encode())
    r = post(client, key, raw, **{"Content-Encoding": "gzip"})
    assert r.status_code == 200 and r.json()["inserted"] == 1


def test_extra_fields_and_odd_values(client, key):
    recs = [
        record(70, new_sensor_x=1.5, temp_source="ec\u0000probe"),
        record(71, timestamp_utc="2026-10-27T15:00:00"),   # no timezone -> UTC
        record(72, timestamp_utc=1793113200),               # Unix seconds
        record(73, sample_seq=2**70),                       # out of range
        "not an object",
    ]
    body = post(client, key, {"records": recs}).json()
    assert (body["inserted"], body["rejected"]) == (3, 2)
    assert query("SELECT extra->>'new_sensor_x', temp_source FROM readings WHERE sample_seq = 70") == [("1.5", "ecprobe")]
    ts = query("SELECT to_char(timestamp_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') FROM readings WHERE sample_seq IN (71, 72) ORDER BY sample_seq")
    assert ts == [("2026-10-27 15:00",), ("2026-10-27 15:00",)]


def test_blank_csv_fields_are_null(client, key):
    body = post(client, key, {"records": [record(80, ph="", do_ok="  ", temp_source="")]}).json()
    assert body["inserted"] == 1, body
    assert query("SELECT ph, do_ok, temp_source FROM readings WHERE sample_seq = 80") == [(None, None, None)]


def test_missing_timestamp_ok_with_boot_count(client, key):
    body = post(client, key, {"records": [record(81, boot=5, timestamp_utc="", rtc_ok=0),
                                          record(82, boot=5, timestamp_utc=None, rtc_ok=0)]}).json()
    assert (body["inserted"], body["rejected"]) == (2, 0), body
    assert post(client, key, {"records": [record(81, boot=5, timestamp_utc="", rtc_ok=0)]}).json()["duplicates"] == 1
    no_identity = record(83, timestamp_utc=None)
    del no_identity["boot_count"]
    assert post(client, key, {"records": [no_identity]}).json()["rejected"] == 1


def test_read_back_and_disable(client, key):
    r = client.get(URL + "?limit=5", headers={"X-API-Key": key})
    assert r.status_code == 200 and len(r.json()["readings"]) == 5
    assert manage.main(["disable", "node-01"]) == 0
    assert post(client, key, {"records": []}).status_code == 401
    assert manage.main(["enable", "node-01"]) == 0
    assert post(client, key, {"records": []}).status_code == 200


def test_dashboard_endpoint(client, key):
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc).replace(microsecond=0)
    def at(minutes_ago):
        return (now - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")
    dash_key = new_device("node-dash")
    def rec(seq, **kw):
        return record(seq, node_id="node-dash", **kw)
    post(client, dash_key, {"records": [
        rec(900, boot=50, timestamp_utc=at(150), ph=7.0, flow_l_min=120, flow_placeholder=0),
        rec(901, boot=50, timestamp_utc=at(90), ph=7.2, flow_l_min=120, flow_placeholder=0),
        rec(902, boot=50, timestamp_utc=at(30), ph=7.4, ph_ok=1, do_mg_l=9.0, do_ok=0,
               flow_l_min=60, flow_placeholder=1),
        rec(903, boot=50, timestamp_utc=at(5), ph=9.9, test_mode=1),
    ]})
    body = client.get("/api/v1/dashboard").json()
    node = next(n for n in body["nodes"] if n["deviceId"] == "node-dash")
    assert node["name"] == "test"
    assert node["samples"]["ph"] == 7.4                 # test_mode record (9.9) excluded
    assert node["samples"]["dissolvedOxygen"] is None   # do_ok = 0
    assert node["samples"]["flow"] is None              # placeholder flow
    assert node["observedAt"] == at(30)
    assert node["tideState"] == "unknown" and node["testMode"] is False
    hours = [h["hour"] for h in node["history"]]
    assert hours == sorted(hours) and len(hours) >= 2
    assert any(h["flow"] is not None and abs(h["flow"] - 0.002) < 1e-9 for h in node["history"])  # 120 L/min
    assert "api_key" not in json.dumps(body) and "boot_count" not in json.dumps(body)

    with_test = client.get("/api/v1/dashboard?include_test=true").json()
    assert next(n for n in with_test["nodes"] if n["deviceId"] == "node-dash")["samples"]["ph"] == 9.9
    assert manage.main(["disable", "node-dash"]) == 0
    assert all(n["deviceId"] != "node-dash" for n in client.get("/api/v1/dashboard").json()["nodes"])
    assert client.get("/api/v1/dashboard?hours=0").status_code == 422


def test_raw_batches_kept(client, key):
    n_batches, n_records = query("SELECT count(*), sum(record_count) FROM raw_batches")[0]
    assert n_batches > 5 and n_records > 10


def test_health_and_docs(client):
    assert client.get("/healthz").json()["status"] == "ok"
    spec = client.get("/openapi.json").json()
    assert "X-API-Key" in json.dumps(spec)
    assert client.get("/docs").status_code == 200
