from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.config import get_settings
from app.connectors.thingy52_ble import Thingy52BleConnector


async def main() -> None:
    settings = get_settings()
    connector = Thingy52BleConnector(
        settings.device_id,
        settings.ble_address,
        settings.ble_connect_timeout_seconds,
    )

    print(f"Resolving Thingy:52 at {settings.ble_address}...")
    device = await connector._resolve_device()
    print(f"Found: {device.name or 'Unknown'} [{device.address}]")
    print(f"Connecting with timeout {settings.ble_connect_timeout_seconds:.0f}s...")

    from bleak import BleakClient

    async with BleakClient(device, timeout=settings.ble_connect_timeout_seconds) as client:
        print("Connected. Waiting for environment notifications...")
        samples = await connector._collect_environment_notifications(client)
        samples["battery_level"] = await connector._read_battery_level(client)

    print(samples)


if __name__ == "__main__":
    asyncio.run(main())
