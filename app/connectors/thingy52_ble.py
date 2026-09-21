from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from app.models import Measurement

from .base import SensorConnector

try:
    from bleak import BleakClient, BleakScanner
except ImportError:  # pragma: no cover
    BleakClient = None
    BleakScanner = None


class Thingy52BleConnector(SensorConnector):
    TEMPERATURE_CHARACTERISTIC = "ef680201-9b35-4933-9b10-52ffa9740042"
    PRESSURE_CHARACTERISTIC = "ef680202-9b35-4933-9b10-52ffa9740042"
    HUMIDITY_CHARACTERISTIC = "ef680203-9b35-4933-9b10-52ffa9740042"
    LIGHT_INTENSITY_CHARACTERISTIC = "ef680205-9b35-4933-9b10-52ffa9740042"
    BATTERY_CHARACTERISTIC = "00002a19-0000-1000-8000-00805f9b34fb"
    RETRY_ATTEMPTS = 3
    RETRY_BACKOFF_SECONDS = 3.0

    def __init__(
        self,
        device_id: str,
        ble_address: str | None,
        connect_timeout_seconds: float = 20.0,
    ) -> None:
        self.device_id = device_id
        self.ble_address = ble_address
        self.connect_timeout_seconds = connect_timeout_seconds

    @staticmethod
    def _is_transient_ble_error(exc: Exception) -> bool:
        message = str(exc).lower()
        transient_markers = (
            "device disconnected",
            "failed to discover services",
            "eoferror",
            "operation was cancelled",
            "connection reset",
            "resource temporarily unavailable",
            "connection aborted",
            "timed out waiting for thingy:52 environment notifications",
            "no matching connection for device",
        )
        return any(marker in message for marker in transient_markers)

    async def read_measurements(self) -> list[Measurement]:
        if BleakClient is None or BleakScanner is None:
            raise RuntimeError("bleak is not installed; install requirements before using BLE mode.")
        if not self.ble_address:
            raise RuntimeError("THINGY52_BLE_ADDRESS is required when THINGY52_CONNECTOR=ble.")

        last_error: Exception | None = None
        for attempt in range(1, self.RETRY_ATTEMPTS + 1):
            try:
                device = await self._resolve_device()
                async with BleakClient(device, timeout=self.connect_timeout_seconds) as client:
                    samples = await self._collect_environment_notifications(client)
                    battery_level = await self._read_battery_level(client)

                now = datetime.now(timezone.utc)
                measurements = [
                    Measurement(self.device_id, "temperature", samples["temperature"], "C", now, "thingy52-ble"),
                    Measurement(self.device_id, "pressure", samples["pressure"], "hPa", now, "thingy52-ble"),
                    Measurement(self.device_id, "humidity", samples["humidity"], "%", now, "thingy52-ble"),
                    Measurement(self.device_id, "battery_level", battery_level, "%", now, "thingy52-ble"),
                ]

                if "light_intensity" in samples:
                    measurements.append(
                        Measurement(self.device_id, "light_intensity", samples["light_intensity"], "counts", now, "thingy52-ble")
                    )

                return measurements
            except Exception as exc:
                last_error = exc
                if not self._is_transient_ble_error(exc):
                    raise
                if attempt < self.RETRY_ATTEMPTS:
                    await asyncio.sleep(self.RETRY_BACKOFF_SECONDS * attempt)
                    continue

        if last_error is not None:
            raise RuntimeError(
                "Thingy:52 is sleeping or disconnected. The device could not complete a BLE read after retries. "
                f"Last error: {last_error}"
            ) from last_error

        raise RuntimeError("Thingy:52 BLE read failed for an unknown reason.")

    async def _resolve_device(self):
        try:
            matches = await BleakScanner.discover(timeout=6.0)
        except Exception as exc:
            message = str(exc).lower()
            if "bluetooth" in message and ("turned on" in message or "off" in message or "disabled" in message):
                raise RuntimeError("Bluetooth is turned off. Turn on Bluetooth on the device or Pi, then retry.") from exc
            raise RuntimeError(f"BLE scan failed: {exc}") from exc

        target_address = self.ble_address.lower()
        thingy_candidates = []

        for device in matches:
            name = (device.name or "").lower()
            address = device.address.lower()
            if address == target_address:
                return device
            if "thingy" in name or "nordic" in name:
                thingy_candidates.append(device)

        if len(thingy_candidates) == 1:
            return thingy_candidates[0]

        available = [
            f"{device.name or 'Unknown'} ({device.address})"
            for device in thingy_candidates[:5]
        ]
        detail = "; ".join(available) if available else "no Thingy-like devices found in the latest scan"
        raise RuntimeError(
            "Thingy:52 was not discoverable for connection. "
            f"Configured address: {self.ble_address}. Scan result: {detail}."
        )

    async def _collect_environment_notifications(self, client: BleakClient) -> dict[str, float]:
        loop = asyncio.get_running_loop()
        received: dict[str, float] = {}
        required_metrics = {"temperature", "pressure", "humidity"}
        desired_metrics = required_metrics | {"light_intensity"}
        required_ready = loop.create_future()

        def build_handler(decoder):
            def handler(_: object, payload: bytearray) -> None:
                decoded = decoder(payload)
                received.update(decoded)
                if required_metrics.issubset(received) and not required_ready.done():
                    required_ready.set_result(True)

            return handler

        subscriptions = [
            (self.TEMPERATURE_CHARACTERISTIC, self._decode_temperature),
            (self.PRESSURE_CHARACTERISTIC, self._decode_pressure),
            (self.HUMIDITY_CHARACTERISTIC, self._decode_humidity),
            (self.LIGHT_INTENSITY_CHARACTERISTIC, self._decode_light_intensity),
        ]

        try:
            for characteristic, decoder in subscriptions:
                await client.start_notify(characteristic, build_handler(decoder))

            try:
                await asyncio.wait_for(required_ready, timeout=self.connect_timeout_seconds)
            except TimeoutError as exc:
                raise RuntimeError(
                    "Timed out waiting for Thingy:52 environment notifications. "
                    "The device connected, but the core sensor samples did not arrive."
                ) from exc

            optional_deadline = loop.time() + min(2.0, self.connect_timeout_seconds / 5)
            while loop.time() < optional_deadline and set(received) != desired_metrics:
                await asyncio.sleep(0.1)

            return dict(received)
        finally:
            for characteristic, _ in subscriptions:
                try:
                    await client.stop_notify(characteristic)
                except Exception:
                    pass

    async def _read_battery_level(self, client: BleakClient) -> float:
        payload = await client.read_gatt_char(self.BATTERY_CHARACTERISTIC)
        return float(int.from_bytes(payload[0:1], byteorder="little", signed=False))

    @staticmethod
    def _decode_temperature(payload: bytearray) -> dict[str, float]:
        integer = int.from_bytes(payload[0:1], byteorder="little", signed=True)
        decimal = int.from_bytes(payload[1:2], byteorder="little", signed=False)
        return {"temperature": integer + (decimal / 100.0)}

    @staticmethod
    def _decode_pressure(payload: bytearray) -> dict[str, float]:
        integer = int.from_bytes(payload[0:4], byteorder="little", signed=False)
        decimal = int.from_bytes(payload[4:5], byteorder="little", signed=False)
        return {"pressure": integer + (decimal / 100.0)}

    @staticmethod
    def _decode_humidity(payload: bytearray) -> dict[str, float]:
        return {"humidity": float(int.from_bytes(payload[0:1], byteorder="little", signed=False))}

    @staticmethod
    def _decode_light_intensity(payload: bytearray) -> dict[str, float]:
        clear = int.from_bytes(payload[6:8], byteorder="little", signed=False)
        return {"light_intensity": float(clear)}
