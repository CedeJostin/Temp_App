import uuid
import pandas as pd
from sqlalchemy.orm import Session

from app.models.measurement import Measurement


CHUNK = 10_000


def insert_measurements(
    db: Session,
    df: pd.DataFrame,
    station_id: str,
    variable_id: str,
    file_id: str,
) -> int:
    # Eliminar filas sin valor
    df = df.dropna(subset=["value"]).copy()

    if df.empty:
        return 0

    # Convertir UUIDs una sola vez
    sid = uuid.UUID(station_id)
    vid = uuid.UUID(variable_id)
    fid = uuid.UUID(file_id)

    # Crear registros usando itertuples (más rápido que iterrows)
    records = [
        {
            "station_id": sid,
            "variable_id": vid,
            "file_id": fid,
            "measured_at": row.measured_at,
            "value": float(row.value),
        }
        for row in df.itertuples(index=False)
    ]

    # Insertar en lotes para evitar problemas de memoria
    for i in range(0, len(records), CHUNK):
        batch = records[i:i + CHUNK]
        db.bulk_insert_mappings(Measurement, batch)

    db.commit()

    return len(records)