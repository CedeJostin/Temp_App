from pydantic import BaseModel
from datetime import datetime


class MeasurementCreate(BaseModel):
    station_id:  str
    variable_id: str
    measured_at: datetime
    value:       float


class MeasurementResponse(MeasurementCreate):
    id:      int
    file_id: str | None = None

    class Config:
        from_attributes = True