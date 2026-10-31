"""Device administration. Run inside the api container, e.g. from the
Portainer container console:

    python -m app.manage add-device node-01 --name "River site A"
    python -m app.manage list
    python -m app.manage rotate-key node-01
    python -m app.manage disable node-01
    python -m app.manage enable node-01
"""
import argparse
import secrets
import sys

import psycopg

from . import db


def new_key() -> str:
    return "sk_" + secrets.token_urlsafe(32)


def print_key(node_id: str, key: str) -> None:
    print(f"\nAPI key for {node_id} (shown once, only its hash is stored):\n\n    {key}\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.manage")
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add-device", help="register a node and print its API key")
    add.add_argument("node_id")
    add.add_argument("--name")
    add.add_argument("--notes")

    for name, help_text in (("rotate-key", "issue a new key; the old one stops working"),
                            ("disable", "reject uploads from this node"),
                            ("enable", "accept uploads from this node again")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("node_id")

    sub.add_parser("list", help="list registered nodes")
    args = parser.parse_args(argv)

    db.wait_for_db(timeout_s=10)
    db.init_schema()
    with psycopg.connect(db.conninfo()) as conn:
        if args.command == "add-device":
            key = new_key()
            try:
                conn.execute(
                    "INSERT INTO devices (node_id, name, notes, api_key_hash) VALUES (%s, %s, %s, %s)",
                    (args.node_id, args.name, args.notes, db.hash_key(key)),
                )
            except psycopg.errors.UniqueViolation:
                print(f"{args.node_id} already exists; use rotate-key for a new key.", file=sys.stderr)
                return 1
            print_key(args.node_id, key)

        elif args.command == "rotate-key":
            key = new_key()
            cur = conn.execute("UPDATE devices SET api_key_hash = %s WHERE node_id = %s",
                               (db.hash_key(key), args.node_id))
            if cur.rowcount == 0:
                print(f"No device called {args.node_id}.", file=sys.stderr)
                return 1
            print_key(args.node_id, key)

        elif args.command in ("disable", "enable"):
            cur = conn.execute("UPDATE devices SET active = %s WHERE node_id = %s",
                               (args.command == "enable", args.node_id))
            if cur.rowcount == 0:
                print(f"No device called {args.node_id}.", file=sys.stderr)
                return 1
            print(f"{args.node_id} {args.command}d.")

        elif args.command == "list":
            rows = conn.execute(
                "SELECT d.node_id, d.name, d.active, d.last_seen_at, "
                "(SELECT count(*) FROM readings r WHERE r.node_id = d.node_id) "
                "FROM devices d ORDER BY d.node_id"
            ).fetchall()
            if not rows:
                print("No devices registered yet.")
            for node_id, name, active, last_seen, count in rows:
                state = "active" if active else "DISABLED"
                seen = last_seen.strftime("%Y-%m-%d %H:%M:%SZ") if last_seen else "never"
                print(f"{node_id:<16} {state:<9} last seen {seen:<21} {count:>8} readings  {name or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
