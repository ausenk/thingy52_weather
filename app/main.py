from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import get_settings
from .db import Database
from .services.poller import Poller

settings = get_settings()
database = Database(settings.database_path)
poller = Poller(settings, database)


class PollerModeUpdate(BaseModel):
    enabled: bool


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.initialize()
    if settings.autopoll_enabled:
        await poller.start()
    try:
        yield
    finally:
        await poller.stop()


app = FastAPI(title="Thingy:52 Dashboard", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")


@app.get("/", response_class=FileResponse)
async def index() -> FileResponse:
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/poller")
async def get_poller_status() -> dict[str, object]:
    return {
        "enabled": poller.is_running,
        "interval_seconds": settings.poll_interval_seconds,
        "connector": settings.connector,
        "device_id": settings.device_id,
        "ble_address": settings.ble_address,
        "last_poll_at": poller.last_poll_at.isoformat() if poller.last_poll_at else None,
        "last_success_at": poller.last_success_at.isoformat() if poller.last_success_at else None,
        "last_error": poller.last_error,
        "last_measurement_count": poller.last_measurement_count,
    }


@app.post("/api/poller")
async def set_poller_status(update: PollerModeUpdate) -> dict[str, object]:
    enabled = await poller.set_enabled(update.enabled)
    return {
        "enabled": enabled,
        "interval_seconds": settings.poll_interval_seconds,
        "connector": settings.connector,
        "device_id": settings.device_id,
        "ble_address": settings.ble_address,
        "last_poll_at": poller.last_poll_at.isoformat() if poller.last_poll_at else None,
        "last_success_at": poller.last_success_at.isoformat() if poller.last_success_at else None,
        "last_error": poller.last_error,
        "last_measurement_count": poller.last_measurement_count,
    }


@app.post("/api/poll")
async def manual_poll() -> dict[str, int]:
    try:
        count = await poller.poll_once()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"stored": count}


@app.get("/api/metrics")
async def metrics() -> dict[str, list[str]]:
    return {"metrics": database.fetch_metrics()}


@app.get("/api/latest")
async def latest() -> dict[str, list[dict[str, object]]]:
    return {"items": database.fetch_latest()}


@app.get("/api/measurements")
async def measurements(
    metric: list[str] = Query(default=[]),
    since_hours: int = Query(default=24, ge=1, le=24 * 30),
    limit: int = Query(default=500, ge=10, le=5000),
) -> dict[str, list[dict[str, object]]]:
    metrics_filter = metric or None
    return {
        "items": database.fetch_measurements(
            metrics=metrics_filter,
            since_hours=since_hours,
            limit=limit,
        )
    }
