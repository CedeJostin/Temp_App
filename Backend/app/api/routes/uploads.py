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

import logging
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
from app.services.file_parser import parse_file, parse_wind_imn
from app.services.measurement_service import insert_measurements

router = APIRouter()

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# MAPEO ENTRE VARIABLE DETECTADA Y CÓDIGO EN BD
# ─────────────────────────────────────────────────────────────
VTYPE_TO_CODE = {
    "Temperatura": "TEMP",
    "Humedad":     "HR",
    "Radiacion":   "RAD",
    "Viento":      "VIENTO",
}


def _get_or_create_variable(db: Session, code: str, name: str, unit: str) -> str:
    var = db.query(Variable).filter(Variable.code == code).first()
    if var:
        return str(var.id)
    var = Variable(code=code, name=name, unit=unit)
    db.add(var)
    db.commit()
    db.refresh(var)
    return str(var.id)


def _process_wind_upload(db, filename, station_id, wind_df, logs):
    """Flujo del viento IMN: inserta las DOS series (VIENTO velocidad +
    VIENTO_DIR dirección) desde un solo archivo y precalcula el ajuste Weibull
    sobre la velocidad. La dirección solo alimenta la rosa/análisis direccional
    (se lee cruda), así que solo se le hace summary."""
    vel_id = _get_or_create_variable(db, "VIENTO",     "Velocidad del viento", "m/s")
    dir_id = _get_or_create_variable(db, "VIENTO_DIR", "Dirección del viento", "°")

    uploaded = UploadedFile(
        filename=filename, source="streamlit_upload",
        rows_imported=len(wind_df), status="processing",
    )
    db.add(uploaded)
    db.commit()
    db.refresh(uploaded)
    file_id = str(uploaded.id)

    vel_df = (wind_df[["measured_at", "velocidad"]]
              .rename(columns={"velocidad": "value"}).dropna(subset=["value"]))
    dir_df = (wind_df[["measured_at", "direccion"]]
              .rename(columns={"direccion": "value"}).dropna(subset=["value"]))

    rows_vel = insert_measurements(db=db, df=vel_df, station_id=station_id,
                                   variable_id=vel_id, file_id=file_id)
    rows_dir = insert_measurements(db=db, df=dir_df, station_id=station_id,
                                   variable_id=dir_id, file_id=file_id)
    logs.append(f"✅ Insertados VIENTO: {rows_vel:,} · VIENTO_DIR: {rows_dir:,}")

    uploaded.status = "processed"
    uploaded.rows_imported = rows_vel + rows_dir
    db.commit()

    # Weibull sobre la velocidad; la dirección solo summary (es circular)
    try:
        from app.services.analytics_service import run_analytics, upsert_summary_stats
        res = run_analytics(db=db, station_id=station_id,
                            variable_id=vel_id, variable_code="VIENTO")
        logs += res.get("logs", [])
        upsert_summary_stats(db=db, station_id=station_id, variable_id=vel_id)
        upsert_summary_stats(db=db, station_id=station_id, variable_id=dir_id)
        logs.append("✅ Summary stats actualizados (viento)")
    except Exception as e:
        db.rollback()
        logs.append(f"⚠️ Analytics de viento falló: {e}")

    try:
        from app.services.stats_service import recalculate_derived_stats
        derived = recalculate_derived_stats(db=db, station_id=station_id,
                                            variable_id=vel_id, variable_code="VIENTO")
        logs += derived.get("logs", [])
    except Exception as e:
        db.rollback()
        logs.append(f"⚠️ Estadísticas derivadas del viento fallaron: {e}")

    return {
        "message":         "Archivo de viento procesado correctamente",
        "file_id":         file_id,
        "filename":        filename,
        "variable_type":   "Viento",
        "variable_id":     vel_id,
        "variable_dir_id": dir_id,
        "rows_parsed":     len(wind_df),
        "rows_inserted":   rows_vel + rows_dir,
        "logs":            logs,
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
    # 1b. VIENTO: formato IMN con dos series (velocidad + dirección)
    # Se intenta primero; si el archivo no es de viento devuelve vacío
    # y sigue el flujo normal de una sola variable.
    # ─────────────────────────────────────────────────────────
    wind_df, wind_logs = parse_wind_imn(contents, filename)
    if not wind_df.empty:
        try:
            return _process_wind_upload(db, filename, station_id, wind_df, wind_logs)
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail={"message": "Error procesando archivo de viento",
                        "error": str(e), "logs": wind_logs},
            )


    # ─────────────────────────────────────────────────────────
    # 2. PARSEAR ARCHIVO
    # ─────────────────────────────────────────────────────────
    df, vtype_detected, logs = parse_file(contents, filename)

    logs.append(f"📄 Archivo parseado: {len(df)} registros, tipo detectado: {vtype_detected}")

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
        # Diagnóstico — borrar después
        logger.debug(f"🔍 DF shape: {df.shape}")
        logger.debug(f"🔍 Primeras filas:\n{df.head()}")
        logger.debug(f"🔍 Últimas filas:\n{df.tail()}")
        logger.debug(f"🔍 Rango fechas: {df['measured_at'].min()} → {df['measured_at'].max()}")
        logger.debug(f"🔍 Nulos en value: {df['value'].isna().sum()}")
        rows_inserted = insert_measurements(
            db=db,
            df=df,
            station_id=station_id,
            variable_id=variable_id,
            file_id=file_id,
        )

        uploaded.status = "processed"
        uploaded.rows_imported = rows_inserted
        db.commit()

    except Exception as e:
        uploaded.status = f"error: {str(e)}"
        db.commit()

        raise HTTPException(
            status_code=500,
            detail={
                "message": "Error al insertar mediciones",
                "error":   str(e),
            }
        )

    # ─────────────────────────────────────────────────────────
    # 5b. CALCULAR ANALYTICS (separado del try anterior)
    # ─────────────────────────────────────────────────────────
    try:
        from app.services.analytics_service import run_analytics, upsert_summary_stats
        analytics_result = run_analytics(
            db=db,
            station_id=station_id,
            variable_id=variable_id,
            variable_code=VTYPE_TO_CODE.get(vtype_detected, ""),
        )
        logs += analytics_result.get("logs", [])
 
        upsert_summary_stats(db=db, station_id=station_id, variable_id=variable_id)
        logs.append("✅ Summary stats actualizados")
 
    except Exception as e:
        db.rollback()
        logs.append(f"⚠️ Analytics falló pero el archivo se subió: {str(e)}")
 
    # ── NUEVO: precalcular by_date, annual_profile y combined ──
    try:
        from app.services.stats_service import recalculate_derived_stats
        derived = recalculate_derived_stats(
            db=db,
            station_id=station_id,
            variable_id=variable_id,
            variable_code=VTYPE_TO_CODE.get(vtype_detected, ""),
            # altitude se toma internamente de la tabla stations
        )
        logs += derived.get("logs", [])
 
    except Exception as e:
        db.rollback()
        logs.append(f"⚠️ Estadísticas derivadas fallaron: {str(e)}")
    # ── FIN NUEVO ──────────────────────────────────────────────
 
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