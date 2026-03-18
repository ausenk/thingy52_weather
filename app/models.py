from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(slots=True)
class Measurement:
    device_id: str
    metric: str
    value: float
    unit: str
    captured_at: datetime
    source: str


@dataclass(slots=True)
class ForecastMeasurement:
    location_key: str
    metric: str
    value: float
    unit: str
    valid_at: datetime
    fetched_at: datetime
    source: str
