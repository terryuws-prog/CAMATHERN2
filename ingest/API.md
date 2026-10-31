# Sensor ingestion API — firmware integration spec (v1, draft)

This is the interface the node firmware uploads to. Live, browsable docs (with a
"Try it out" button) are at `https://rivermonitor.aber.ac.uk/cam/dev/docs`.

| | |
|---|---|
| Dev endpoint | `https://rivermonitor.aber.ac.uk/cam/dev/api/v1/readings` |
| Dev docs (try it in the browser) | `https://rivermonitor.aber.ac.uk/cam/dev/docs` |
| Production endpoint | `https://rivermonitor.aber.ac.uk/cam/api/v1/readings` |
| Method | `POST` |
| Body | JSON, UTF-8. Optionally gzip-compressed (`Content-Encoding: gzip`) |
| Auth | `X-API-Key: <key>` header. One key per node, issued by Terry |
| Batch size | Up to **200 records** per request (50 recommended). Body ≤ 900 KB |

## Request

```http
POST /cam/api/v1/readings HTTP/1.1
Host: rivermonitor.aber.ac.uk
X-API-Key: sk_...
Content-Type: application/json
```

```json
{
  "node_id": "node-01",
  "fw_version": "1.0.3",
  "records": [
    {
      "boot_count": 17,
      "sample_seq": 42,
      "timestamp_utc": "2026-10-27T15:00:00Z",
      "rtc_ok": true,
      "uptime_s": 3600,
      "ph": 7.12,
      "temp_c": 11.4,
      "ec_us_cm": 412.0,
      "do_mg_l": 9.8,
      "nh4_reported_mg_l": 0.12,
      "no3_reported_mg_l": 2.4,
      "flow_l_min": null,
      "depth_m": 0.35,
      "voltage_v": 3.92,
      "do_ok": true, "ph_ok": true, "ec_ok": true,
      "nh4_ok": true, "no3_ok": true, "temp_ok": true,
      "temp_source": "ec_probe",
      "flow_placeholder": true,
      "test_mode": false
    }
  ]
}
```

Top level:

| Field | Required | Notes |
|---|---|---|
| `records` | yes | Array of records, oldest first. Empty array is allowed (see *Heartbeat*). |
| `node_id` | no | If sent, must match the node the API key belongs to (else `403`). |
| `fw_version` | no | Stored on every record in the batch. |

Each record follows the current SD logging schema, plus `boot_count`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `boot_count` | integer ≥ 0 | **requested** | Persistent counter incremented on every boot (EEPROM/SD). See *Record identity*. |
| `sample_seq` | integer ≥ 0 | yes | Resets on reboot — that is fine with `boot_count`. |
| `timestamp_utc` | string or integer | yes | ISO 8601 UTC, e.g. `2026-10-27T15:00:00Z`. Unix seconds also accepted. No timezone = UTC. |
| `rtc_ok` | bool | no | |
| `uptime_s` | integer | no | |
| `ph`, `temp_c`, `ec_us_cm`, `do_mg_l`, `nh4_reported_mg_l`, `no3_reported_mg_l`, `flow_l_min`, `depth_m`, `voltage_v` | number or `null` | no | **Use `null` for "no valid reading"**, not a sentinel such as -999. `NaN` is also turned into `null`. |
| `do_ok`, `ph_ok`, `ec_ok`, `nh4_ok`, `no3_ok`, `temp_ok`, `flow_placeholder` | bool | no | `true`/`false` or `1`/`0`. |
| `temp_source` | string | no | |
| `test_mode` | bool | no | Default `false`. Test data is stored but hidden from the dashboard. |
| `node_id`, `fw_version` | string | no | Allowed per record (so SD rows can be sent as-is). `node_id` must match the key. |

Unknown extra fields are accepted and kept, so adding a field in firmware never breaks uploads.

## Record identity and retries

The server de-duplicates on **`node_id + boot_count + sample_seq`**. If a record
without `boot_count` arrives, it falls back to `node_id + timestamp_utc`, which is
unreliable when `rtc_ok` is false — so please send `boot_count`.

Re-sending records is always safe: duplicates are counted, not stored twice.

## Response

A `200` means **the whole batch has been handled**. Every record was stored, was
already stored (duplicate), or was permanently rejected as malformed. The firmware
should mark **all records in the batch as uploaded**.

```json
{
  "status": "ok",
  "batch_id": 1234,
  "received": 50,
  "inserted": 48,
  "duplicates": 2,
  "rejected": 0,
  "server_time_utc": "2026-10-27T15:05:12Z"
}
```

- Rejected records are kept server-side for debugging, so one corrupt line on the SD
  card can never block the upload queue.
- `server_time_utc` can be used to check or correct the RTC.

## Errors and what the firmware should do

| Status | `error` | Meaning | Firmware action |
|---|---|---|---|
| `200` | – | Handled | Mark the batch as uploaded |
| `400` | `invalid_json`, `missing_records`, `bad_compression` | Body could not be parsed (a firmware bug) | Keep the data, log it, retry rarely (e.g. next day) |
| `401` | `missing_api_key`, `invalid_api_key` | Key missing, wrong or node disabled | Keep the data, retry rarely (e.g. hourly) |
| `403` | `node_mismatch` | Batch `node_id` ≠ key's node | Keep the data, fix configuration |
| `413` | `too_many_records`, `body_too_large` | Batch too big | Retry with a smaller batch |
| `5xx`, timeout, no response | – | Server or network problem | Keep the data, retry with increasing back-off |

Error bodies look like:

```json
{"status": "error", "error": "invalid_api_key", "message": "...", "server_time_utc": "..."}
```

## Heartbeat / clock sync

`POST` with `{"records": []}` returns `200` with `server_time_utc` and updates the
node's "last seen" time. Useful after boot when `rtc_ok` is false.

## Data volume

About 400 bytes per record as compact JSON (no spaces). 50 records ≈ 20 KB.
Because the field names repeat, gzip shrinks this to a few KB (about 1 KB in a
synthetic test), so it is worth using if the modem library makes it easy.

## Testing

Dev and production have separate databases and separate API keys.

```bash
HOST=https://rivermonitor.aber.ac.uk/cam/dev

# Upload
curl -X POST "$HOST/api/v1/readings" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  --data @examples/sample_batch.json

# Read back the latest records stored for your key
curl "$HOST/api/v1/readings?limit=5" -H "X-API-Key: $KEY"
```

Uploading the same file twice should return `inserted: 0, duplicates: 2` the second time.

## To confirm

1. Can the firmware add a persistent `boot_count`?
2. `null` for missing readings (instead of sentinel values)?
3. Does the cellular module handle HTTPS/TLS and custom headers reliably?
4. Planned sampling and upload intervals, and the largest backlog after an outage.
