from __future__ import annotations

import math
import random
from datetime import datetime, timezone

from app.models import Measurement

from .base import SensorConnector


class MockThingy52Connector(SensorConnector):
    def __init__(self, device_id: str) -> None:
        self.device_id = device_id

    async def read_measurements(self) -> list[Measurement]:
        now = datetime.now(timezone.utc)
        phase = now.timestamp() / 60.0

        return [
            Measurement(
                device_id=self.device_id,
                metric="temperature",
                value=22.0 + math.sin(phase) * 3 + random.uniform(-0.2, 0.2),
                unit="C",
                captured_at=now,
                source="mock",
            ),
            Measurement(
                device_id=self.device_id,
                metric="humidity",
                value=45.0 + math.cos(phase / 2) * 10 + random.uniform(-0.5, 0.5),
                unit="%",
                captured_at=now,
                source="mock",
            ),
            Measurement(
                device_id=self.device_id,
                metric="pressure",
                value=1013.0 + math.sin(phase / 3) * 6 + random.uniform(-0.5, 0.5),
                unit="hPa",
                captured_at=now,
                source="mock",
            ),
            Measurement(
                device_id=self.device_id,
                metric="air_quality_eco2",
                value=550.0 + math.sin(phase / 4) * 45 + random.uniform(-5, 5),
                unit="ppm",
                captured_at=now,
                source="mock",
            ),
            Measurement(
                device_id=self.device_id,
                metric="air_quality_tvoc",
                value=120.0 + math.cos(phase / 5) * 35 + random.uniform(-3, 3),
                unit="ppb",
                captured_at=now,
                source="mock",
            ),
            Measurement(
                device_id=self.device_id,
                metric="light_intensity",
                value=800.0 + math.sin(phase / 6) * 120 + random.uniform(-10, 10),
                unit="counts",
                captured_at=now,
                source="mock",
            ),
            Measurement(
                device_id=self.device_id,
                metric="battery_level",
                value=91.0 + math.sin(phase / 12) * 2,
                unit="%",
                captured_at=now,
                source="mock",
            ),
        ]
