# Thingy:52 Pi Dashboard

This project provides:

- a background collector that polls a Thingy:52 at a configurable cadence
- a local SQLite database for durable storage on-device
- a lightweight dashboard for browsing recent metrics and filtering what is shown
- deployment guidance for running on a Raspberry Pi Zero-class device

## Stack

- Python 3.12
- FastAPI for the API and static app hosting
- SQLite for local persistence
- Vanilla JavaScript and Canvas for the dashboard

## Project layout

- `app/main.py`: FastAPI app and API routes
- `app/services/poller.py`: polling loop and connector selection
- `app/connectors/mock.py`: mock data source for local development
- `app/connectors/thingy52_ble.py`: BLE connector for a Nordic Thingy:52
- `app/db.py`: SQLite storage helpers
- `app/static/`: dashboard assets

## Local run

1. Create a virtual environment.
2. Install dependencies with `pip install -r requirements.txt`.
3. Copy `.env.example` to `.env` and adjust values.
4. Start the app with `python run.py`.
5. Open `http://localhost:8000`.

## Configuration

Environment variables:

- `THINGY52_DEVICE_ID`: logical device id stored with each measurement
- `THINGY52_CONNECTOR`: `mock` or `ble`
- `THINGY52_POLL_INTERVAL_SECONDS`: cadence for background polling
- `THINGY52_DATABASE_PATH`: SQLite file location
- `THINGY52_BLE_ADDRESS`: BLE address for the Thingy:52 when using BLE mode

## Raspberry Pi Zero deployment

For a Pi Zero, the realistic target is a Raspberry Pi Zero W or Zero 2 W so BLE and Wi-Fi are onboard. If you have a non-wireless Pi Zero, you will need external networking and a BLE adapter.

1. Install Raspberry Pi OS Lite.
2. Install system packages:
   - `sudo apt update`
   - `sudo apt install -y python3 python3-venv python3-pip bluez sqlite3`
3. Copy this project to `/home/pi/thingy52-dashboard`.
4. Create a venv and install dependencies:
   - `python3 -m venv .venv`
   - `. .venv/bin/activate`
   - `pip install -r requirements.txt`
5. Create `.env` from `.env.example`, set `THINGY52_CONNECTOR=ble`, and provide `THINGY52_BLE_ADDRESS`.
6. Install the service:
   - `sudo cp deploy/thingy52-dashboard.service /etc/systemd/system/`
   - `sudo systemctl daemon-reload`
   - `sudo systemctl enable --now thingy52-dashboard`
7. Check logs:
   - `sudo journalctl -u thingy52-dashboard -f`

## API endpoints

- `GET /api/health`
- `POST /api/poll`
- `GET /api/metrics`
- `GET /api/latest`
- `GET /api/measurements?metric=temperature&since_hours=24`

## Notes on Thingy:52 integration

The BLE connector is built around the Nordic environmental service characteristics for temperature, pressure, and humidity. If your device setup uses different services, update the UUIDs or decoding logic in `app/connectors/thingy52_ble.py`.

## Testing on Windows before deployment

You can test the full app on Windows first.

1. Run with `THINGY52_CONNECTOR=mock` to verify the dashboard, database, and polling flow.
2. Scan for the real device with:
   - `python scripts/discover_thingy52.py`
3. Copy the discovered address into `.env` as `THINGY52_BLE_ADDRESS`.
4. Set `THINGY52_CONNECTOR=ble`.
5. Restart the app and use the dashboard `Poll now` button or `POST /api/poll`.

If the scanner does not find the device, check that:

- Bluetooth is enabled on Windows
- the Thingy:52 is powered on and advertising
- no other app already has an exclusive connection open to the device
