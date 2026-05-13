from fastapi import APIRouter, UploadFile, File, Depends
from sqlalchemy.orm import Session
import pandas as pd
import io

from app.db.database import get_db
from app.models.uploaded_file import UploadedFile
from app.models.measurement import Measurement

router = APIRouter()


@router.post("/")
async def upload_file(

    station_id: str,
    variable_id: str,

    file: UploadFile = File(...),

    db: Session = Depends(get_db)

):

    contents = await file.read()

    df = pd.read_csv(io.BytesIO(contents))

    uploaded = UploadedFile(
        filename=file.filename,
        source="manual",
        rows_imported=len(df),
        status="processed"
    )

    db.add(uploaded)

    db.commit()

    db.refresh(uploaded)

    measurements = []

    for _, row in df.iterrows():

        measurement = Measurement(
            station_id=station_id,
            variable_id=variable_id,
            file_id=uploaded.id,
            measured_at=row["measured_at"],
            value=row["value"]
        )

        measurements.append(measurement)

    db.bulk_save_objects(measurements)

    db.commit()

    return {
        "message": "Archivo procesado",
        "rows": len(measurements)
    }