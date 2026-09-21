import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.connectors.thingy52_ble import Thingy52BleConnector


class Thingy52BleConnectorRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_measurements_retries_transient_disconnect_and_succeeds(self):
        connector = Thingy52BleConnector("THINGY52-001", "EA:69:47:1D:5B:BD", connect_timeout_seconds=1.0)
        connector._resolve_device = AsyncMock(return_value=object())

        fake_client = Mock()
        fake_client.__aenter__ = AsyncMock(side_effect=[RuntimeError("failed to discover services, device disconnected"), None])
        fake_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.connectors.thingy52_ble.BleakClient", return_value=fake_client), \
             patch("app.connectors.thingy52_ble.asyncio.sleep", new=AsyncMock()) as sleep_mock, \
             patch.object(
                 connector,
                 "_collect_environment_notifications",
                 AsyncMock(side_effect=[
                     RuntimeError("failed to discover services, device disconnected"),
                     {"temperature": 21.0, "pressure": 1010.0, "humidity": 50.0},
                 ]),
             ), \
             patch.object(connector, "_read_battery_level", AsyncMock(return_value=50.0)):
            values = await connector.read_measurements()

        self.assertEqual(len(values), 4)
        self.assertEqual(values[0].metric, "temperature")
        self.assertEqual(values[3].metric, "battery_level")
        self.assertEqual(sleep_mock.await_count, 1)

    async def test_read_measurements_raises_after_retry_budget_is_exhausted(self):
        connector = Thingy52BleConnector("THINGY52-001", "EA:69:47:1D:5B:BD", connect_timeout_seconds=1.0)
        connector._resolve_device = AsyncMock(return_value=object())

        fake_client = Mock()
        fake_client.__aenter__ = AsyncMock(side_effect=RuntimeError("failed to discover services, device disconnected"))
        fake_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.connectors.thingy52_ble.BleakClient", return_value=fake_client), \
             patch("app.connectors.thingy52_ble.asyncio.sleep", new=AsyncMock()):
            with self.assertRaises(RuntimeError) as exc:
                await connector.read_measurements()

        self.assertIn("sleeping", str(exc.exception).lower())


if __name__ == "__main__":
    unittest.main()
