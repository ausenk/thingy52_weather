from __future__ import annotations

import asyncio
from dataclasses import dataclass

from bleak import BleakScanner


@dataclass(slots=True)
class DiscoveredDevice:
    name: str
    address: str
    rssi: int | None


def looks_like_thingy52(name: str) -> bool:
    normalized = name.lower()
    return "thingy" in normalized or "nordic" in normalized


async def discover(timeout: float = 8.0) -> list[DiscoveredDevice]:
    devices = await BleakScanner.discover(timeout=timeout)
    matches: list[DiscoveredDevice] = []

    for device in devices:
        name = device.name or "Unknown"
        if looks_like_thingy52(name):
            matches.append(
                DiscoveredDevice(
                    name=name,
                    address=device.address,
                    rssi=getattr(device, "rssi", None),
                )
            )

    return sorted(matches, key=lambda item: (item.rssi is None, -(item.rssi or -999)))


async def main() -> None:
    print("Scanning for nearby Nordic Thingy:52 devices...")
    matches = await discover()

    if not matches:
        print("No likely Thingy:52 devices found.")
        print("Make sure Bluetooth is enabled and the device is powered on and advertising.")
        return

    print()
    print("Possible matches:")
    for item in matches:
        rssi_label = "unknown" if item.rssi is None else str(item.rssi)
        print(f"- {item.name} | address: {item.address} | RSSI: {rssi_label}")

    print()
    print("Use the address above as THINGY52_BLE_ADDRESS in your .env file.")


if __name__ == "__main__":
    asyncio.run(main())
