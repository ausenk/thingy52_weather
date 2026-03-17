from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def load_dotenv(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(slots=True)
class Settings:
    device_id: str = field(
        default_factory=lambda: os.getenv("THINGY52_DEVICE_ID", "THINGY52-001")
    )
    connector: str = field(
        default_factory=lambda: os.getenv("THINGY52_CONNECTOR", "mock")
    )
    poll_interval_seconds: int = field(
        default_factory=lambda: int(os.getenv("THINGY52_POLL_INTERVAL_SECONDS", "30"))
    )
    autopoll_enabled: bool = field(
        default_factory=lambda: env_flag("THINGY52_AUTOPOLL_ENABLED", True)
    )
    database_path: Path = field(
        default_factory=lambda: Path(os.getenv("THINGY52_DATABASE_PATH", "data/thingy52.db"))
    )
    host: str = field(default_factory=lambda: os.getenv("THINGY52_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.getenv("THINGY52_PORT", "8000")))
    ble_address: str | None = field(
        default_factory=lambda: os.getenv("THINGY52_BLE_ADDRESS") or None
    )
    ble_connect_timeout_seconds: float = field(
        default_factory=lambda: float(os.getenv("THINGY52_BLE_CONNECT_TIMEOUT_SECONDS", "20"))
    )


def get_settings() -> Settings:
    load_dotenv()
    return Settings()
