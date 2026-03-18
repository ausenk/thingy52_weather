from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import Settings
from app.db import Database
from app.models import ForecastMeasurement


class NwsForecastService:
    def __init__(self, settings: Settings, database: Database) -> None:
        self.settings = settings
        self.database = database
        self.location_key = self._build_location_key(
            settings.nws_latitude,
            settings.nws_longitude,
        )

    @property
    def is_configured(self) -> bool:
        return self.location_key is not None

    def payload(
        self,
        items: list[dict[str, object]],
    ) -> dict[str, object]:
        return {
            "configured": self.is_configured,
            "location_key": self.location_key,
            "latitude": self.settings.nws_latitude,
            "longitude": self.settings.nws_longitude,
            "items": items,
            "last_fetched_at": (
                self.database.latest_forecast_fetched_at(self.location_key).isoformat()
                if self.location_key and self.database.latest_forecast_fetched_at(self.location_key)
                else None
            ),
            "available_until": (
                self.database.latest_forecast_valid_at(self.location_key).isoformat()
                if self.location_key and self.database.latest_forecast_valid_at(self.location_key)
                else None
            ),
        }

    async def get_forecast(
        self,
        metrics: list[str] | None,
        hours_ahead: int,
    ) -> dict[str, object]:
        if not self.is_configured or self.location_key is None:
            return {
                "configured": False,
                "location_key": None,
                "latitude": self.settings.nws_latitude,
                "longitude": self.settings.nws_longitude,
                "items": [],
                "last_fetched_at": None,
                "available_until": None,
            }

        await self.ensure_fresh()
        items = self.database.fetch_forecast_measurements(
            location_key=self.location_key,
            metrics=metrics,
            hours_ahead=hours_ahead,
        )
        return self.payload(items)

    async def ensure_fresh(self) -> None:
        if self.location_key is None:
            return

        latest = self.database.latest_forecast_fetched_at(self.location_key)
        if latest is not None:
            age = datetime.now(timezone.utc) - latest
            if age < timedelta(minutes=self.settings.weather_refresh_minutes):
                return

        await self.refresh_forecast()

    async def refresh_forecast(self) -> int:
        if not self.is_configured or self.location_key is None:
            raise RuntimeError("NWS forecast is not configured. Set THINGY52_NWS_LATITUDE and THINGY52_NWS_LONGITUDE.")

        points_url = (
            f"https://api.weather.gov/points/{self.settings.nws_latitude:.4f},"
            f"{self.settings.nws_longitude:.4f}"
        )
        points_payload = await asyncio.to_thread(self._fetch_json, points_url)
        forecast_grid_url = points_payload["properties"].get("forecastGridData")
        if not forecast_grid_url:
            raise RuntimeError("NWS did not return a forecast grid URL for the configured location.")

        grid_payload = await asyncio.to_thread(self._fetch_json, forecast_grid_url)
        properties = grid_payload.get("properties", {})
        fetched_at = self._parse_datetime(properties.get("updateTime")) or datetime.now(timezone.utc)
        measurements = self._build_measurements(properties, fetched_at)
        if not measurements:
            raise RuntimeError("NWS forecast response did not contain usable forecast values.")

        self.database.replace_forecast_measurements(self.location_key, measurements)
        return len(measurements)

    def _fetch_json(self, url: str) -> dict[str, Any]:
        request = Request(
            url,
            headers={
                "User-Agent": self.settings.nws_user_agent,
                "Accept": "application/geo+json, application/ld+json, application/json",
            },
        )
        try:
            with urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:  # pragma: no cover
            raise RuntimeError(f"NWS request failed with HTTP {exc.code}.") from exc
        except URLError as exc:  # pragma: no cover
            raise RuntimeError("Could not reach the NWS API.") from exc

    def _build_measurements(
        self,
        properties: dict[str, Any],
        fetched_at: datetime,
    ) -> list[ForecastMeasurement]:
        metric_specs = [
            ("temperature", "temperature", self._normalize_temperature, "C"),
            ("relativeHumidity", "humidity", self._normalize_percent, "%"),
            ("pressure", "pressure", self._normalize_pressure_hpa, "hPa"),
            ("barometricPressure", "pressure", self._normalize_pressure_hpa, "hPa"),
        ]

        measurements: list[ForecastMeasurement] = []
        seen_pressure = False

        for property_name, metric_name, normalizer, unit in metric_specs:
            payload = properties.get(property_name)
            if not payload or not isinstance(payload, dict):
                continue
            if metric_name == "pressure" and seen_pressure:
                continue

            values = payload.get("values") or []
            uom = str(payload.get("uom") or "")
            added = 0
            for value_payload in values:
                raw_value = value_payload.get("value")
                valid_time = value_payload.get("validTime")
                if raw_value is None or not valid_time:
                    continue
                valid_at = self._parse_valid_time(valid_time)
                if valid_at is None:
                    continue
                measurements.append(
                    ForecastMeasurement(
                        location_key=self.location_key or "",
                        metric=metric_name,
                        value=normalizer(float(raw_value), uom),
                        unit=unit,
                        valid_at=valid_at,
                        fetched_at=fetched_at,
                        source="nws-gridpoint",
                    )
                )
                added += 1

            if metric_name == "pressure" and added:
                seen_pressure = True

        return measurements

    @staticmethod
    def _build_location_key(latitude: float | None, longitude: float | None) -> str | None:
        if latitude is None or longitude is None:
            return None
        return f"{latitude:.4f},{longitude:.4f}"

    @staticmethod
    def _parse_datetime(value: str | None) -> datetime | None:
        if not value:
            return None
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed

    @classmethod
    def _parse_valid_time(cls, value: str) -> datetime | None:
        start, _, _duration = value.partition("/")
        return cls._parse_datetime(start)

    @staticmethod
    def _normalize_temperature(value: float, uom: str) -> float:
        if "degf" in uom.lower():
            return (value - 32.0) * 5.0 / 9.0
        return value

    @staticmethod
    def _normalize_percent(value: float, _uom: str) -> float:
        return value

    @staticmethod
    def _normalize_pressure_hpa(value: float, uom: str) -> float:
        lowered = uom.lower()
        if lowered.endswith(":hpa") or lowered.endswith("/hpa") or lowered == "hpa":
            return value
        if lowered.endswith(":pa") or lowered.endswith("/pa") or lowered == "pa":
            return value / 100.0
        return value

