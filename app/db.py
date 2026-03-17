from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from .models import Measurement


def _dict_factory(cursor: sqlite3.Cursor, row: tuple[object, ...]) -> dict[str, object]:
    return {column[0]: row[index] for index, column in enumerate(cursor.description)}


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
                CREATE INDEX IF NOT EXISTS idx_measurements_metric_time
                ON measurements(metric, captured_at)
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
