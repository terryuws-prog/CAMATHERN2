import math
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

BIGINT_MAX = 2**63 - 1

FLOAT_FIELDS = (
    "voltage_v", "ph", "temp_c", "ec_us_cm", "do_mg_l",
    "nh4_reported_mg_l", "no3_reported_mg_l", "flow_l_min", "depth_m",
)


class Record(BaseModel):
    """One row of the SD logging schema, plus boot_count.

    Lenient on purpose: 0/1 and "true"/"false" are accepted for booleans,
    blank strings and NaN/inf become NULL, and unknown fields are kept in
    readings.extra.

    Identity is node_id + boot_count + sample_seq, so timestamp_utc may be
    null (e.g. RTC invalid) as long as boot_count is sent.
    """

    model_config = ConfigDict(extra="allow")

    # identity
    node_id: Optional[str] = None          # optional per record; must match the API key's device
    fw_version: Optional[str] = None       # optional per record; overrides the batch-level value
    boot_count: Optional[int] = Field(default=None, ge=0, le=BIGINT_MAX)
    sample_seq: int = Field(ge=0, le=BIGINT_MAX)
    timestamp_utc: Optional[datetime] = None  # ISO 8601 ("2026-10-27T15:00:00Z") or Unix seconds

    # diagnostics
    rtc_ok: Optional[bool] = None
    uptime_s: Optional[int] = Field(default=None, ge=0, le=BIGINT_MAX)
    voltage_v: Optional[float] = None

    # measurements
    ph: Optional[float] = None
    temp_c: Optional[float] = None
    ec_us_cm: Optional[float] = None
    do_mg_l: Optional[float] = None
    nh4_reported_mg_l: Optional[float] = None
    no3_reported_mg_l: Optional[float] = None
    flow_l_min: Optional[float] = None
    depth_m: Optional[float] = None

    # flags
    do_ok: Optional[bool] = None
    ph_ok: Optional[bool] = None
    ec_ok: Optional[bool] = None
    nh4_ok: Optional[bool] = None
    no3_ok: Optional[bool] = None
    temp_ok: Optional[bool] = None
    temp_source: Optional[str] = None
    flow_placeholder: Optional[bool] = None
    test_mode: bool = False

    @model_validator(mode="before")
    @classmethod
    def blank_is_null(cls, data):
        """Blank CSV cells ("" or spaces) mean "no value"."""
        if isinstance(data, dict):
            return {k: (None if isinstance(v, str) and not v.strip() else v) for k, v in data.items()}
        return data

    @model_validator(mode="after")
    def needs_identity(self):
        if self.timestamp_utc is None and self.boot_count is None:
            raise ValueError("timestamp_utc is required when boot_count is not sent")
        return self

    @field_validator("timestamp_utc")
    @classmethod
    def assume_utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    @field_validator(*FLOAT_FIELDS)
    @classmethod
    def finite_or_null(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and not math.isfinite(value):
            return None
        return value

    @field_validator("test_mode", mode="before")
    @classmethod
    def null_test_mode_is_false(cls, value):
        return False if value is None else value


COLUMNS = (
    "node_id", "boot_count", "sample_seq", "timestamp_utc", "batch_id", "fw_version",
    "rtc_ok", "uptime_s", "voltage_v",
    "ph", "temp_c", "ec_us_cm", "do_mg_l", "nh4_reported_mg_l", "no3_reported_mg_l",
    "flow_l_min", "depth_m",
    "do_ok", "ph_ok", "ec_ok", "nh4_ok", "no3_ok", "temp_ok",
    "temp_source", "flow_placeholder", "test_mode", "extra",
)
