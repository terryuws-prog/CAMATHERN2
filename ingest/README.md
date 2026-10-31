# Sensor ingestion API

Receives batches of readings from the cellular field nodes and stores them in
PostgreSQL. Runs as three extra services in this repository's `docker-compose.yml`,
behind the existing nginx proxy:

| Public URL | Service | Database |
|---|---|---|
| `https://rivermonitor.aber.ac.uk/cam/api/v1/readings` | `ingest-api` (production) | `sensors` |
| `https://rivermonitor.aber.ac.uk/cam/dev/api/v1/readings` | `ingest-api-dev` (testing, `/cam/dev/docs` enabled) | `sensors_dev` |
| – (internal only) | `ingest-db` (Postgres 16, volume `ingest-pgdata`) | |

`API.md` is the interface spec for the firmware.

The proxy resolves the API containers at request time, so if they are stopped or
fail, `/cam/` and the EMWAC site keep working; only `/cam/api/` and `/cam/dev/`
return 502.

## Deploy (Portainer)

1. Push these changes to the repository.
2. Portainer → `local` → **Stacks** → the stack that runs this repository.
3. Under **Environment variables**, add `INGEST_DB_PASSWORD` with a long random
   value (letters and digits only is simplest). Without it the deploy stops with a
   clear error and nothing is changed.
4. **Pull and redeploy** (tick "re-pull image" / rebuild if offered). The proxy
   and dashboard containers are rebuilt too, so the site may blink for a few
   seconds; pick a quiet moment.
5. Check `https://rivermonitor.aber.ac.uk/cam/dev/healthz` returns `{"status":"ok", ...}`
   and `https://rivermonitor.aber.ac.uk/cam/dev/docs` shows the API page.

If you deploy from a shell instead: `INGEST_DB_PASSWORD=... docker compose up -d --build`.

## Issue API keys

Portainer → **Containers** → the `ingest-api-dev` container → **Console** →
Connect (`/bin/sh`):

```sh
python -m app.manage add-device node-01 --name "River site A"
```

The key is printed once; only its hash is stored. Use the `ingest-api` container
for production keys. Dev and production keys are separate.

Other commands: `list`, `rotate-key node-01`, `disable node-01`, `enable node-01`.

## Data

| Table | Contents |
|---|---|
| `devices` | registered nodes, key hash, last seen |
| `readings` | one row per record; de-duplicated on `node_id + boot_count + sample_seq` (fallback `node_id + timestamp_utc`) |
| `raw_batches` | every request body exactly as received |
| `rejected_records` | records that failed validation, with the reason |

The data lives in the `ingest-pgdata` Docker volume on this server. Redeploying
keeps it. **Never tick "remove volumes" when deleting or recreating the stack.**

Backup (from the `ingest-db` container console):

```sh
pg_dump -U sensors sensors > /var/lib/postgresql/data/backup-$(date +%F).sql
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `db`, `5432`, `sensors`, `sensors`, – | database is created if missing |
| `ROOT_PATH` | empty | public path prefix the proxy strips (`/cam`, `/cam/dev`) |
| `MAX_BATCH_RECORDS` | `200` | larger batches get `413` |
| `MAX_BODY_BYTES` | `1000000` | nginx already limits bodies to 900 KB |
| `DOCS_ENABLED` | `true` | `false` on production |
| `LOG_LEVEL` | `INFO` | |

## Tests

Needs a throw-away Postgres database (the tests drop all tables):

```sh
cd ingest
pip install -r requirements.txt pytest httpx
DB_HOST=127.0.0.1 DB_NAME=sensors_test DB_USER=... DB_PASSWORD=... pytest tests/
```
