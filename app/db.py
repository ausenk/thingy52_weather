from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from .models import ForecastMeasurement, Measurement


def _dict_factory(cursor: sqlite3.Cursor, row: tuple[object, ...]) -> dict[str, object]:
    return {column[0]: row[index] for index, column in enumerate(cursor.description)}


def _parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = _dict_factory
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS measurements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    value REAL NOT NULL,
                    unit TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    source TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS forecast_measurements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    location_key TEXT NOT NULL,
                    metric TEXT NOT NULL,
                    value REAL NOT NULL,
                    unit TEXT NOT NULL,
                    valid_at TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    source TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_measurements_metric_time
                ON measurements(metric, captured_at)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_forecast_metric_time
                ON forecast_measurements(location_key, metric, valid_at)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_forecast_fetched
                ON forecast_measurements(location_key, fetched_at)
                """
            )
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_unique_snapshot
                ON forecast_measurements(location_key, metric, valid_at, fetched_at)
                """
            )
            connection.commit()

    def insert_measurements(self, measurements: list[Measurement]) -> None:
        if not measurements:
            return

        with self.connect() as connection:
            connection.executemany(
                """
                INSERT INTO measurements (
                    device_id,
                    metric,
                    value,
                    unit,
                    captured_at,
                    source
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item.device_id,
                        item.metric,
                        item.value,
                        item.unit,
                        item.captured_at.isoformat(),
                        item.source,
                    )
                    for item in measurements
                ],
            )
            connection.commit()

    def insert_forecast_measurements(
        self,
        location_key: str,
        measurements: list[ForecastMeasurement],
        retention_days: int = 21,
    ) -> None:
        if not measurements:
            return

        prune_before = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()

        with self.connect() as connection:
            connection.executemany(
                """
                INSERT OR IGNORE INTO forecast_measurements (
                    location_key,
                    metric,
                    value,
                    unit,
                    valid_at,
                    fetched_at,
                    source
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item.location_key,
                        item.metric,
                        item.value,
                        item.unit,
                        item.valid_at.isoformat(),
                        item.fetched_at.isoformat(),
                        item.source,
                    )
                    for item in measurements
                ],
            )
            connection.execute(
                "DELETE FROM forecast_measurements WHERE location_key = ? AND valid_at < ?",
                (location_key, prune_before),
            )
            connection.commit()

    def fetch_latest(self) -> list[dict[str, object]]:
        with self.connect() as connection:
            return connection.execute(
                """
                SELECT m1.metric, m1.value, m1.unit, m1.captured_at, m1.source
                FROM measurements m1
                JOIN (
                    SELECT metric, MAX(captured_at) AS max_captured_at
                    FROM measurements
                    GROUP BY metric
                ) latest
                ON m1.metric = latest.metric AND m1.captured_at = latest.max_captured_at
                ORDER BY m1.metric ASC
                """
            ).fetchall()

    def fetch_metrics(self) -> list[str]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT DISTINCT metric FROM measurements ORDER BY metric ASC"
            ).fetchall()
            return [str(row["metric"]) for row in rows]

    def fetch_measurements(
        self,
        metrics: list[str] | None = None,
        since_hours: int = 24,
        limit: int = 500,
    ) -> list[dict[str, object]]:
        since = datetime.now(timezone.utc) - timedelta(hours=since_hours)
        query = """
            SELECT device_id, metric, value, unit, captured_at, source
            FROM measurements
            WHERE captured_at >= ?
        """
        params: list[object] = [since.isoformat()]

        if metrics:
            placeholders = ", ".join("?" for _ in metrics)
            query += f" AND metric IN ({placeholders})"
            params.extend(metrics)

        query += " ORDER BY captured_at DESC LIMIT ?"
        params.append(limit)

        with self.connect() as connection:
            return connection.execute(query, params).fetchall()

    def fetch_forecast_measurements(
        self,
        location_key: str,
        metrics: list[str] | None = None,
        hours: int = 168,
        mode: str = "future",
        limit: int = 5000,
    ) -> list[dict[str, object]]:
        now = datetime.now(timezone.utc)
        if mode == "compare":
            window_start = now - timedelta(hours=hours)
            window_end = now
        else:
            window_start = now
            window_end = now + timedelta(hours=hours)

        metric_filter = ""
        params: list[object] = [location_key, window_start.isoformat(), window_end.isoformat()]
        if metrics:
            placeholders = ", ".join("?" for _ in metrics)
            metric_filter = f" AND metric IN ({placeholders})"
            params.extend(metrics)

        query = f"""
            SELECT latest.metric, latest.value, latest.unit, latest.valid_at, latest.fetched_at, latest.source
            FROM forecast_measurements latest
            JOIN (
                SELECT metric, valid_at, MAX(fetched_at) AS max_fetched_at
                FROM forecast_measurements
                WHERE location_key = ?
                  AND valid_at >= ?
                  AND valid_at <= ?
                  {metric_filter}
                GROUP BY metric, valid_at
            ) selected
            ON latest.metric = selected.metric
            AND latest.valid_at = selected.valid_at
            AND latest.fetched_at = selected.max_fetched_at
            WHERE latest.location_key = ?
            ORDER BY latest.valid_at ASC
            LIMIT ?
        """
        params.extend([location_key, limit])

        with self.connect() as connection:
            return connection.execute(query, params).fetchall()

    def latest_forecast_fetched_at(self, location_key: str) -> datetime | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT MAX(fetched_at) AS fetched_at
                FROM forecast_measurements
                WHERE location_key = ?
                """,
                (location_key,),
            ).fetchone()
        return _parse_iso8601(None if row is None else row["fetched_at"])

    def latest_forecast_valid_at(self, location_key: str) -> datetime | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT MAX(valid_at) AS valid_at
                FROM forecast_measurements
                WHERE location_key = ?
                """,
                (location_key,),
            ).fetchone()
        return _parse_iso8601(None if row is None else row["valid_at"])
