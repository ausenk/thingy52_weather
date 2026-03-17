from __future__ import annotations

from abc import ABC, abstractmethod

from app.models import Measurement


class SensorConnector(ABC):
    @abstractmethod
    async def read_measurements(self) -> list[Measurement]:
        raise NotImplementedError
