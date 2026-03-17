from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from app.connectors import MockThingy52Connector, SensorConnector, Thingy52BleConnector
from app.config import Settings
from app.db import Database

logger = logging.getLogger(__name__)


def build_connector(settings: Settings) -> SensorConnector:
    if settings.connector == "ble":
        return Thingy52BleConnector(
            settings.device_id,
            settings.ble_address,
            settings.ble_connect_timeout_seconds,
        )
    return MockThingy52Connector(settings.device_id)


class Poller:
    def __init__(self, settings: Settings, database: Database) -> None:
        self.settings = settings
        self.database = database
        self.connector = build_connector(settings)
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._poll_lock = asyncio.Lock()
        self.last_poll_at: datetime | None = None
        self.last_success_at: datetime | None = None
        self.last_error: str | None = None
        self.last_measurement_count: int = 0

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def set_enabled(self, enabled: bool) -> bool:
        if enabled:
            await self.start()
        else:
            await self.stop()
        return self.is_running

    async def start(self) -> None:
        if self.is_running:
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="thingy52-poller")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._stop_event.set()
        await self._task
        self._task = None

    async def poll_once(self) -> int:
        async with self._poll_lock:
            self.last_poll_at = datetime.now(timezone.utc)
            try:
                measurements = await self.connector.read_measurements()
                self.database.insert_measurements(measurements)
                self.last_success_at = datetime.now(timezone.utc)
                self.last_error = None
                self.last_measurement_count = len(measurements)
                return len(measurements)
            except Exception as exc:
                self.last_error = str(exc)
                raise

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                count = await self.poll_once()
                logger.info("Stored %s measurements", count)
            except Exception as exc:  # pragma: no cover
                logger.exception("Polling failed: %s", exc)

            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self.settings.poll_interval_seconds,
                )
            except TimeoutError:
                continue
