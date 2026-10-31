-- Applied automatically at API start-up. Every statement is idempotent,
-- so restarting the container never changes existing data.

CREATE TABLE IF NOT EXISTS devices (
    node_id       text PRIMARY KEY,
    name          text,
    api_key_hash  text NOT NULL UNIQUE,      -- sha256 of the key; the key itself is never stored
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz,
    notes         text
);

-- Every upload request, stored verbatim. Lets you re-process data if the
-- field mapping ever turns out to be wrong.
CREATE TABLE IF NOT EXISTS raw_batches (
    id            bigserial PRIMARY KEY,
    node_id       text NOT NULL REFERENCES devices (node_id),
    received_at   timestamptz NOT NULL DEFAULT now(),
    remote_addr   text,
    record_count  integer NOT NULL DEFAULT 0,
    inserted      integer NOT NULL DEFAULT 0,
    duplicates    integer NOT NULL DEFAULT 0,
    rejected      integer NOT NULL DEFAULT 0,
    payload       jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
    id                 bigserial PRIMARY KEY,
    node_id            text NOT NULL REFERENCES devices (node_id),
    boot_count         bigint,
    sample_seq         bigint NOT NULL,
    timestamp_utc      timestamptz,          -- NULL allowed when the RTC was invalid (boot_count identifies the record)
    received_at        timestamptz NOT NULL DEFAULT now(),
    batch_id           bigint REFERENCES raw_batches (id),
    fw_version         text,

    -- diagnostics
    rtc_ok             boolean,
    uptime_s           bigint,
    voltage_v          double precision,

    -- measurements (NULL = no valid reading)
    ph                 double precision,
    temp_c             double precision,
    ec_us_cm           double precision,
    do_mg_l            double precision,
    nh4_reported_mg_l  double precision,
    no3_reported_mg_l  double precision,
    flow_l_min         double precision,
    depth_m            double precision,

    -- sensor status flags
    do_ok              boolean,
    ph_ok              boolean,
    ec_ok              boolean,
    nh4_ok             boolean,
    no3_ok             boolean,
    temp_ok            boolean,
    temp_source        text,
    flow_placeholder   boolean,
    test_mode          boolean NOT NULL DEFAULT false,

    -- any fields the firmware sends that are not columns yet
    extra              jsonb
);

-- Databases created before timestamp_utc became nullable.
ALTER TABLE readings ALTER COLUMN timestamp_utc DROP NOT NULL;

-- De-duplication. Preferred key: node_id + boot_count + sample_seq.
-- Fallback while boot_count is not sent: node_id + timestamp_utc.
CREATE UNIQUE INDEX IF NOT EXISTS readings_uniq_boot_seq
    ON readings (node_id, boot_count, sample_seq) WHERE boot_count IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS readings_uniq_timestamp
    ON readings (node_id, timestamp_utc) WHERE boot_count IS NULL;

CREATE INDEX IF NOT EXISTS readings_node_time ON readings (node_id, timestamp_utc DESC);

-- Records that could not be parsed. They are acknowledged to the device
-- (so one bad record never blocks the upload queue) and kept here for debugging.
CREATE TABLE IF NOT EXISTS rejected_records (
    id           bigserial PRIMARY KEY,
    batch_id     bigint REFERENCES raw_batches (id),
    node_id      text NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    error        text NOT NULL,
    record       jsonb NOT NULL
);
