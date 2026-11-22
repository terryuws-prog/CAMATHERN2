"""Re-import readings that were wrongly counted as duplicates.

Before record_uuid, readings without one are matched on node_id + boot_count +
sample_seq. If a node's boot counter resets (for example after an SD card
swap), new readings can share that key with old ones and get dropped as
duplicates. Every upload is kept verbatim in raw_batches, so this script finds
those readings and stores them.

A record is re-imported only if a stored reading has the same key but a
different time or different values. Genuine retries (identical content) are
skipped, and running the script again imports nothing new.

Run it inside the api container (it uses that container's database):

    python -m app.reimport                       # dry run: list what would be imported
    python -m app.reimport --apply               # import
    python -m app.reimport --node node-01 --since 2026-11-15 --apply
"""
import argparse
import sys
import uuid
from datetime import datetime
from typing import Optional

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from . import db
from .models import COLUMNS, Record

# Fields that tell two readings apart. A real retry is identical on all of them.
COMPARE = (
    "timestamp_utc", "uptime_s", "ph", "temp_c", "ec_us_cm", "do_mg_l",
    "nh4_reported_mg_l", "no3_reported_mg_l", "flow_l_min", "depth_m", "voltage_v",
)

# Fixed namespace, so the UUID given to a re-imported record is the same on every run.
NAMESPACE = uuid.UUID("3f6c1d2e-9a4b-4c8d-b1e2-7f0a5c9d8e61")

BATCHES_SQL = """
    SELECT id, node_id, received_at, payload FROM raw_batches
    WHERE duplicates > 0
      AND (%(node)s::text IS NULL OR node_id = %(node)s)
      AND (%(since)s::timestamptz IS NULL OR received_at >= %(since)s)
    ORDER BY id
"""

INSERT_SQL = (
    f"INSERT INTO readings ({', '.join(COLUMNS)}) "
    f"VALUES ({', '.join(['%s'] * len(COLUMNS))}) ON CONFLICT DO NOTHING"
)


def same_content(stored: dict, rec: Record) -> bool:
    return all(stored.get(f) == getattr(rec, f) for f in COMPARE)


def stored_with_same_key(conn, node_id: str, rec: Record) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        if rec.boot_count is not None:
            return cur.execute(
                f"SELECT {', '.join(COMPARE)} FROM readings "
                "WHERE node_id = %s AND boot_count = %s AND sample_seq = %s",
                (node_id, rec.boot_count, rec.sample_seq)).fetchall()
        return cur.execute(
            f"SELECT {', '.join(COMPARE)} FROM readings WHERE node_id = %s AND timestamp_utc = %s",
            (node_id, rec.timestamp_utc)).fetchall()


def run(node: Optional[str], since: Optional[datetime], apply: bool, out=print) -> dict:
    db.wait_for_db(timeout_s=10)
    db.init_schema()
    summary = {"examined": 0, "identical": 0, "imported" if apply else "to_import": 0,
               "no_match": 0, "invalid": 0}
    key_import = "imported" if apply else "to_import"
    planned: dict[tuple, list[dict]] = {}   # dry run: what this run would have added

    with psycopg.connect(db.conninfo()) as conn:
        batches = conn.execute(BATCHES_SQL, {"node": node, "since": since}).fetchall()
        for batch_id, node_id, received_at, payload in batches:
            records = payload.get("records") if isinstance(payload, dict) else None
            if not isinstance(records, list):
                continue
            batch_fw = payload.get("fw_version")
            for index, raw in enumerate(records):
                summary["examined"] += 1
                try:
                    rec = Record.model_validate(raw)
                except (ValidationError, ValueError, TypeError):
                    summary["invalid"] += 1      # these are already in rejected_records
                    continue
                if rec.node_id is not None and rec.node_id != node_id:
                    summary["invalid"] += 1
                    continue
                if rec.record_uuid is not None:
                    summary["identical"] += 1    # matched on its own UUID: a real duplicate
                    continue

                key = (node_id, rec.boot_count, rec.sample_seq, rec.timestamp_utc if rec.boot_count is None else None)
                matches = stored_with_same_key(conn, node_id, rec) + planned.get(key, [])
                if not matches:
                    summary["no_match"] += 1     # nothing stored under this key (e.g. deleted on purpose)
                    continue
                if any(same_content(m, rec) for m in matches):
                    summary["identical"] += 1
                    continue

                summary[key_import] += 1
                out(f"{'import' if apply else 'would import'}: node={node_id} batch={batch_id} "
                    f"received={received_at:%Y-%m-%d %H:%M} boot={rec.boot_count} seq={rec.sample_seq} "
                    f"time={rec.timestamp_utc} ph={rec.ph}")
                if apply:
                    fields = rec.model_dump()
                    fields.update(
                        node_id=node_id,
                        batch_id=batch_id,
                        fw_version=rec.fw_version or (str(batch_fw) if batch_fw is not None else None),
                        record_uuid=uuid.uuid5(NAMESPACE, f"{node_id}/{batch_id}/{index}"),
                        extra=Jsonb({**(rec.model_extra or {}), "reimported_from_batch": batch_id}),
                    )
                    conn.execute(INSERT_SQL, tuple(fields[c] for c in COLUMNS))
                else:
                    planned.setdefault(key, []).append({f: getattr(rec, f) for f in COMPARE})
        if apply:
            conn.commit()

    out(", ".join(f"{k.replace('_', ' ')}: {v}" for k, v in summary.items()))
    if not apply and summary["to_import"]:
        out("Dry run, nothing written. Add --apply to import.")
    return summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.reimport", description=__doc__.splitlines()[0])
    parser.add_argument("--node", help="only this node_id")
    parser.add_argument("--since", type=datetime.fromisoformat, help="only uploads received on or after this date, e.g. 2026-11-15")
    parser.add_argument("--apply", action="store_true", help="write to the database (default is a dry run)")
    args = parser.parse_args(argv)
    run(args.node, args.since, args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
