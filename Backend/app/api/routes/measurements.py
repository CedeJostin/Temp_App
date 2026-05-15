"""
measurements.py
===============
Endpoints GET/POST/DELETE  /measurements/

Endpoints disponibles:
  GET    /measurements/              Lista mediciones con filtros
  GET    /measurements/summary       Resumen estadístico por estación + variable
  GET    /measurements/by-date       Agrupado por día / mes / año
  GET    /measurements/{id}          Una medición por ID
  POST   /measurements/              Insertar una medición manual
  DELETE /measurements/{id}          Eliminar una medición
  DELETE /measurements/              Eliminar rango (estación + variable + fechas)
"""

from datetime import datetime
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
)
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.measurement import Measurement
from app.models.station import Station
from app.models.variable import Variable

router = APIRouter()


# ═════════════════════════════════════════════════════════════
# SCHEMAS
# ═════════════════════════════════════════════════════════════

class MeasurementIn(BaseModel):
    station_id:   str   = Field(..., description="UUID de la estación")
    variable_id:  str   = Field(..., description="UUID de la variable")
    measured_at:  datetime = Field(..., description="Fecha y hora de la medición")
    value:        float = Field(..., description="Valor numérico medido")
    file_id:      Optional[str] = Field(None, description="UUID del archivo origen (opcional)")


class MeasurementOut(BaseModel):
    id:           str
    station_id:   str
    variable_id:  str
    measured_at:  str
    value:        float
    variable_code: Optional[str] = None
    variable_name: Optional[str] = None
    station_code:  Optional[str] = None

    class Config:
        from_attributes = True


# ═════════════════════════════════════════════════════════════
# HELPERS
# ═════════════════════════════════════════════════════════════

def _serialize(m: Measurement) -> dict:
    """Convierte un objeto Measurement a dict serializable."""
    return {
        "id":           str(m.id),
        "station_id":   str(m.station_id),
        "variable_id":  str(m.variable_id),
        "measured_at":  str(m.measured_at),
        "value":        float(m.value),
        "variable_code": m.variable.code  if m.variable else None,
        "variable_name": m.variable.name  if m.variable else None,
        "variable_unit": m.variable.unit  if m.variable else None,
        "station_code":  m.station.station_code if m.station else None,
        "station_name":  m.station.name         if m.station else None,
    }


# ═════════════════════════════════════════════════════════════
# GET /  — listar mediciones con filtros
# ═════════════════════════════════════════════════════════════

@router.get("/")
def list_measurements(
    station_id:    Optional[str] = Query(None, description="UUID de la estación"),
    variable_id:   Optional[str] = Query(None, description="UUID de la variable"),
    variable_code: Optional[str] = Query(None, description="Código de variable: TEMP, HR, RAD, VIENTO"),
    date_from:     Optional[str] = Query(None, description="Fecha inicio  YYYY-MM-DD"),
    date_to:       Optional[str] = Query(None, description="Fecha fin     YYYY-MM-DD"),
    limit:         int           = Query(1000, ge=1, le=50000, description="Máx. registros a devolver"),
    offset:        int           = Query(0,    ge=0,           description="Registros a saltar (paginación)"),
    order:         str           = Query("asc", regex="^(asc|desc)$", description="Orden por measured_at"),
    db: Session = Depends(get_db),
):
    """
    Devuelve mediciones con filtros opcionales.

    - Filtra por estación, variable (UUID o código), y rango de fechas.
    - Soporta paginación con `limit` y `offset`.
    - Ordena por `measured_at` ascendente o descendente.
    """

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .join(Measurement.station)
    )

    # ── Filtros ────────────────────────────────────────────────
    if station_id:
        q = q.filter(Measurement.station_id == station_id)

    if variable_id:
        q = q.filter(Measurement.variable_id == variable_id)

    if variable_code:
        q = q.filter(
            func.upper(Variable.code) == variable_code.strip().upper()
        )

    if date_from:
        try:
            q = q.filter(Measurement.measured_at >= datetime.fromisoformat(date_from))
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"date_from inválido: '{date_from}'. Use formato YYYY-MM-DD."
            )

    if date_to:
        try:
            # Incluir todo el día final
            dt_to = datetime.fromisoformat(date_to).replace(
                hour=23, minute=59, second=59
            )
            q = q.filter(Measurement.measured_at <= dt_to)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"date_to inválido: '{date_to}'. Use formato YYYY-MM-DD."
            )

    # ── Orden ──────────────────────────────────────────────────
    if order == "desc":
        q = q.order_by(Measurement.measured_at.desc())
    else:
        q = q.order_by(Measurement.measured_at.asc())

    # ── Paginación ─────────────────────────────────────────────
    total = q.count()
    rows  = q.offset(offset).limit(limit).all()

    return {
        "total":   total,
        "offset":  offset,
        "limit":   limit,
        "count":   len(rows),
        "data":    [_serialize(m) for m in rows],
    }


# ═════════════════════════════════════════════════════════════
# GET /summary  — estadísticas agregadas
# ═════════════════════════════════════════════════════════════

@router.get("/summary")
def get_summary(
    station_id:    Optional[str] = Query(None),
    variable_code: Optional[str] = Query(None),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Resumen estadístico: mín, máx, promedio, conteo, fecha inicio/fin.
    Se puede filtrar por estación, variable y rango de fechas.
    """

    q = (
        db.query(
            Station.station_code.label("station_code"),
            Station.name.label("station_name"),
            Variable.code.label("variable_code"),
            Variable.name.label("variable_name"),
            Variable.unit.label("unit"),
            func.count(Measurement.id).label("count"),
            func.min(Measurement.value).label("min"),
            func.max(Measurement.value).label("max"),
            func.avg(Measurement.value).label("avg"),
            func.min(Measurement.measured_at).label("date_start"),
            func.max(Measurement.measured_at).label("date_end"),
        )
        .join(Station,   Measurement.station_id  == Station.id)
        .join(Variable,  Measurement.variable_id == Variable.id)
    )

    if station_id:
        q = q.filter(Measurement.station_id == station_id)

    if variable_code:
        q = q.filter(
            func.upper(Variable.code) == variable_code.strip().upper()
        )

    if date_from:
        try:
            q = q.filter(Measurement.measured_at >= datetime.fromisoformat(date_from))
        except ValueError:
            raise HTTPException(status_code=422,
                                detail=f"date_from inválido: '{date_from}'")

    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to).replace(hour=23, minute=59, second=59)
            q = q.filter(Measurement.measured_at <= dt_to)
        except ValueError:
            raise HTTPException(status_code=422,
                                detail=f"date_to inválido: '{date_to}'")

    q = q.group_by(
        Station.station_code,
        Station.name,
        Variable.code,
        Variable.name,
        Variable.unit,
    ).order_by(Station.station_code, Variable.code)

    rows = q.all()

    return [
        {
            "station_code":  r.station_code,
            "station_name":  r.station_name,
            "variable_code": r.variable_code,
            "variable_name": r.variable_name,
            "unit":          r.unit,
            "count":         r.count,
            "min":           round(float(r.min),  4) if r.min  is not None else None,
            "max":           round(float(r.max),  4) if r.max  is not None else None,
            "avg":           round(float(r.avg),  4) if r.avg  is not None else None,
            "date_start":    str(r.date_start)        if r.date_start else None,
            "date_end":      str(r.date_end)          if r.date_end   else None,
        }
        for r in rows
    ]


# ═════════════════════════════════════════════════════════════
# GET /by-date  — agrupado por día / mes / año
# ═════════════════════════════════════════════════════════════

@router.get("/by-date")
def get_by_date(
    station_id:    str            = Query(..., description="UUID de la estación"),
    variable_code: str            = Query(..., description="Código: TEMP, HR, RAD, VIENTO"),
    group_by:      str            = Query("day", regex="^(hour|day|month|year)$",
                                          description="Agrupación temporal"),
    date_from:     Optional[str]  = Query(None),
    date_to:       Optional[str]  = Query(None),
    db: Session = Depends(get_db),
):
    """
    Devuelve el promedio de la variable agrupado por hora, día, mes o año.
    Útil para construir gráficas de tendencia temporal directamente.
    """

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
        .filter(func.upper(Variable.code) == variable_code.strip().upper())
    )

    if date_from:
        try:
            q = q.filter(Measurement.measured_at >= datetime.fromisoformat(date_from))
        except ValueError:
            raise HTTPException(status_code=422,
                                detail=f"date_from inválido: '{date_from}'")
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to).replace(hour=23, minute=59, second=59)
            q = q.filter(Measurement.measured_at <= dt_to)
        except ValueError:
            raise HTTPException(status_code=422,
                                detail=f"date_to inválido: '{date_to}'")

    rows = q.order_by(Measurement.measured_at.asc()).all()

    if not rows:
        return []

    # ── Agrupar en Python (compatible con cualquier BD) ────────
    import pandas as pd
    import numpy as np

    df = pd.DataFrame([
        {"measured_at": r.measured_at, "value": float(r.value)}
        for r in rows
    ])
    df["measured_at"] = pd.to_datetime(df["measured_at"])

    if group_by == "hour":
        df["period"] = df["measured_at"].dt.floor("h")
    elif group_by == "day":
        df["period"] = df["measured_at"].dt.date
    elif group_by == "month":
        df["period"] = df["measured_at"].dt.to_period("M").dt.to_timestamp()
    else:  # year
        df["period"] = df["measured_at"].dt.to_period("Y").dt.to_timestamp()

    agg = (
        df.groupby("period")["value"]
        .agg(avg="mean", min="min", max="max", count="count")
        .reset_index()
    )

    return [
        {
            "period": str(row["period"]),
            "avg":    round(float(row["avg"]),   4),
            "min":    round(float(row["min"]),   4),
            "max":    round(float(row["max"]),   4),
            "count":  int(row["count"]),
        }
        for _, row in agg.iterrows()
    ]


# ═════════════════════════════════════════════════════════════
# GET /{id}  — una medición por ID
# ═════════════════════════════════════════════════════════════

@router.get("/{measurement_id}")
def get_measurement(
    measurement_id: str,
    db: Session = Depends(get_db),
):
    """Devuelve una medición por su UUID."""

    m = db.query(Measurement).filter(Measurement.id == measurement_id).first()

    if not m:
        raise HTTPException(
            status_code=404,
            detail=f"Medición '{measurement_id}' no encontrada."
        )

    return _serialize(m)


# ═════════════════════════════════════════════════════════════
# POST /  — insertar una medición manual
# ═════════════════════════════════════════════════════════════

@router.post("/", status_code=201)
def create_measurement(
    payload: MeasurementIn,
    db: Session = Depends(get_db),
):
    """
    Inserta una medición individual de forma manual.
    Para carga masiva usar POST /uploads/.
    """

    # Validar que la estación existe
    station = db.query(Station).filter(Station.id == payload.station_id).first()
    if not station:
        raise HTTPException(
            status_code=404,
            detail=f"Estación '{payload.station_id}' no encontrada."
        )

    # Validar que la variable existe
    variable = db.query(Variable).filter(Variable.id == payload.variable_id).first()
    if not variable:
        raise HTTPException(
            status_code=404,
            detail=f"Variable '{payload.variable_id}' no encontrada."
        )

    # Crear medición
    m = Measurement(
        station_id  = payload.station_id,
        variable_id = payload.variable_id,
        measured_at = payload.measured_at,
        value       = payload.value,
        file_id     = payload.file_id,
    )

    db.add(m)
    db.commit()
    db.refresh(m)

    return {
        "message": "Medición creada correctamente",
        **_serialize(m),
    }


# ═════════════════════════════════════════════════════════════
# DELETE /{id}  — eliminar una medición por ID
# ═════════════════════════════════════════════════════════════

@router.delete("/{measurement_id}", status_code=200)
def delete_measurement(
    measurement_id: str,
    db: Session = Depends(get_db),
):
    """Elimina una medición por su UUID."""

    m = db.query(Measurement).filter(Measurement.id == measurement_id).first()

    if not m:
        raise HTTPException(
            status_code=404,
            detail=f"Medición '{measurement_id}' no encontrada."
        )

    db.delete(m)
    db.commit()

    return {"message": f"Medición '{measurement_id}' eliminada correctamente."}


# ═════════════════════════════════════════════════════════════
# DELETE /  — eliminar rango de mediciones
# ═════════════════════════════════════════════════════════════

@router.delete("/")
def delete_measurements_range(
    station_id:    str           = Query(..., description="UUID de la estación"),
    variable_code: Optional[str] = Query(None, description="Código de variable (opcional)"),
    date_from:     Optional[str] = Query(None, description="Fecha inicio YYYY-MM-DD"),
    date_to:       Optional[str] = Query(None, description="Fecha fin    YYYY-MM-DD"),
    db: Session = Depends(get_db),
):
    """
    Elimina un rango de mediciones para una estación.
    Se puede acotar por variable y/o fechas.
    PRECAUCIÓN: sin date_from ni date_to borra TODAS las mediciones de la estación.
    """

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
    )

    if variable_code:
        q = q.filter(
            func.upper(Variable.code) == variable_code.strip().upper()
        )

    if date_from:
        try:
            q = q.filter(Measurement.measured_at >= datetime.fromisoformat(date_from))
        except ValueError:
            raise HTTPException(status_code=422,
                                detail=f"date_from inválido: '{date_from}'")

    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to).replace(hour=23, minute=59, second=59)
            q = q.filter(Measurement.measured_at <= dt_to)
        except ValueError:
            raise HTTPException(status_code=422,
                                detail=f"date_to inválido: '{date_to}'")

    count = q.count()
    q.delete(synchronize_session=False)
    db.commit()

    return {
        "message":  f"{count} medición(es) eliminadas correctamente.",
        "deleted":  count,
    }