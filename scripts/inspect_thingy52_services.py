from __future__ import annotations

import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bleak import BleakClient

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

    async with BleakClient(device, timeout=settings.ble_connect_timeout_seconds) as client:
        print("Connected. Enumerating services and characteristics...\n")
        for service in client.services:
            print(f"Service: {service.uuid} | {service.description}")
            for characteristic in service.characteristics:
                props = ", ".join(characteristic.properties)
                print(
                    f"  Characteristic: {characteristic.uuid} | handle={characteristic.handle} | properties=[{props}]"
                )
            print()


if __name__ == "__main__":
    asyncio.run(main())
