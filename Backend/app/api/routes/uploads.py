"""
uploads.py
==========
Endpoint POST /uploads/

Flujo completo:
  1. Recibe el archivo (CSV o Excel) + station_id + variable_id
  2. Parsea el archivo con file_parser (detecta formato automáticamente)
  3. Registra el archivo en uploaded_files
  4. Inserta las mediciones en measurements (bulk)
  5. Retorna resumen del proceso
"""

from typing import Optional

from fastapi import (
    APIRouter,
    UploadFile,
    File,
    Depends,
    HTTPException,
    Query,
)

from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.uploaded_file import UploadedFile
from app.models.variable import Variable
from app.services.file_parser import parse_file
from app.services.measurement_service import insert_measurements

router = APIRouter()


# ─────────────────────────────────────────────────────────────
# MAPEO ENTRE VARIABLE DETECTADA Y CÓDIGO EN BD
# ─────────────────────────────────────────────────────────────
VTYPE_TO_CODE = {
    "Temperatura": "TEMP",
    "Humedad":     "HR",
    "Radiacion":   "RAD",
    "Viento":      "VIENTO",
}


@router.post("/")
async def upload_file(
    station_id: str = Query(
        ...,
        description="UUID de la estación"
    ),

    variable_id: Optional[str] = Query(
        None,
        description="UUID de la variable (opcional)"
    ),

    file: UploadFile = File(...),

    db: Session = Depends(get_db),
):

    # ─────────────────────────────────────────────────────────
    # 1. LEER ARCHIVO
    # ─────────────────────────────────────────────────────────
    contents = await file.read()
    filename = file.filename or "archivo_sin_nombre"


    # ─────────────────────────────────────────────────────────
    # 2. PARSEAR ARCHIVO
    # ─────────────────────────────────────────────────────────
    df, vtype_detected, logs = parse_file(contents, filename)

    if df.empty:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "No se pudo parsear el archivo",
                "logs": logs,
            }
        )


    # ─────────────────────────────────────────────────────────
    # 3. RESOLVER VARIABLE_ID AUTOMÁTICAMENTE
    # ─────────────────────────────────────────────────────────
    if not variable_id:

        # Convertir tipo detectado -> código BD
        code = VTYPE_TO_CODE.get(vtype_detected)

        if not code:
            raise HTTPException(
                status_code=422,
                detail={
                    "message":
                        f"Tipo de variable no detectado: "
                        f"'{vtype_detected}'",

                    "logs": logs,
                }
            )

        # Buscar variable en BD
        variable = (
            db.query(Variable)
            .filter(Variable.code == code)
            .first()
        )

        if not variable:
            raise HTTPException(
                status_code=404,
                detail={
                    "message":
                        f"Variable con código '{code}' "
                        f"no encontrada en la BD.",

                    "solution":
                        "Ejecuta el INSERT inicial "
                        "de variables.",

                    "required_code": code,
                }
            )

        variable_id = str(variable.id)


    # ─────────────────────────────────────────────────────────
    # 4. REGISTRAR ARCHIVO
    # ─────────────────────────────────────────────────────────
    uploaded = UploadedFile(
        filename=filename,
        source="streamlit_upload",
        rows_imported=len(df),
        status="processing",
    )

    db.add(uploaded)
    db.commit()
    db.refresh(uploaded)

    file_id = str(uploaded.id)


    # ─────────────────────────────────────────────────────────
    # 5. INSERTAR MEDICIONES
    # ─────────────────────────────────────────────────────────
    try:

        rows_inserted = insert_measurements(
            db=db,
            df=df,
            station_id=station_id,
            variable_id=variable_id,
            file_id=file_id,
        )

        # Actualizar estado
        uploaded.status = "processed"
        uploaded.rows_imported = rows_inserted

        db.commit()

    except Exception as e:

        uploaded.status = f"error: {str(e)}"
        db.commit()

        raise HTTPException(
            status_code=500,
            detail={
                "message":
                    "Error al insertar mediciones",

                "error":
                    str(e),
            }
        )


    # ─────────────────────────────────────────────────────────
    # 6. RESPUESTA
    # ─────────────────────────────────────────────────────────
    return {
        "message": "Archivo procesado correctamente",

        "file_id": file_id,

        "filename": filename,

        "variable_type": vtype_detected,

        "variable_id": variable_id,

        "rows_parsed": len(df),

        "rows_inserted": rows_inserted,

        "logs": logs,
    }


# ─────────────────────────────────────────────────────────────
# HISTORIAL DE ARCHIVOS
# ─────────────────────────────────────────────────────────────
@router.get("/history")
def get_upload_history(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):

    files = (
        db.query(UploadedFile)
        .order_by(UploadedFile.uploaded_at.desc())
        .limit(limit)
        .all()
    )

    return [
        {
            "id": str(f.id),

            "filename": f.filename,

            "source": f.source,

            "rows_imported": f.rows_imported,

            "status": f.status,

            "uploaded_at": str(f.uploaded_at),
        }
        for f in files
    ]