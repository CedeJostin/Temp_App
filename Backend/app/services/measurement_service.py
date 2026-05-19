"""
measurement_service.py
======================
Inserta mediciones en bulk en la BD.
Usa bulk_insert_mappings para máximo rendimiento con miles de filas.
"""

import uuid
from sqlalchemy.orm import Session
import pandas as pd

from app.models.measurement import Measurement


def insert_measurements(
    db:          Session,
    df:          pd.DataFrame,   # columnas: measured_at, value
    station_id:  str,
    variable_id: str,
    file_id:     str,
) -> int:
    """
    Inserta el DataFrame df como mediciones en la BD.
    Retorna la cantidad de filas insertadas.
    """
    if df.empty:
        return 0
    records = [
    {
        "station_id":  uuid.UUID(station_id),
        "variable_id": uuid.UUID(variable_id),
        "file_id":     uuid.UUID(file_id),
        "measured_at": row["measured_at"],
        "value":       float(row["value"]),
    }
    for _, row in df.iterrows()
    if pd.notna(row["value"])
]

    if not records:
        return 0

    db.bulk_insert_mappings(Measurement, records)
    db.commit()
    return len(records)