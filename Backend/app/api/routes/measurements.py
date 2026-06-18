"""
measurements.py
===============
Endpoints CRUD y de acceso a datos de mediciones.

  GET    /              Lista mediciones con filtros (paginado)
  GET    /summary       Resumen estadístico por estación + variable
  GET    /by-date       Agrupado por hora / día / mes / año
  GET    /{id}          Una medición por ID
  POST   /              Insertar una medición manual
  DELETE /{id}          Eliminar una medición
  DELETE /              Eliminar rango (estación + variable + fechas)

Los endpoints de análisis/gráficas viven en charts.py.
"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, contains_eager

from app.db.database import get_db
from app.models.measurement import Measurement
from app.models.station import Station
from app.models.variable import Variable
from app.models.summary_stats import SummaryStats

from app.api.routes._shared import _apply_date_filters

router = APIRouter()


class MeasurementIn(BaseModel):
    station_id:   str      = Field(..., description="UUID de la estación")
    variable_id:  str      = Field(..., description="UUID de la variable")
    measured_at:  datetime = Field(..., description="Fecha y hora de la medición")
    value:        float    = Field(..., description="Valor numérico medido")
    file_id:      Optional[str] = Field(None, description="UUID del archivo origen (opcional)")


class MeasurementOut(BaseModel):
    id:            str
    station_id:    str
    variable_id:   str
    measured_at:   str
    value:         float
    variable_code: Optional[str] = None
    variable_name: Optional[str] = None
    station_code:  Optional[str] = None

    class Config:
        from_attributes = True


def _serialize(m: Measurement) -> dict:
    return {
        "id":            str(m.id),
        "station_id":    str(m.station_id),
        "variable_id":   str(m.variable_id),
        "measured_at":   str(m.measured_at),
        "value":         float(m.value),
        "variable_code": m.variable.code        if m.variable else None,
        "variable_name": m.variable.name        if m.variable else None,
        "variable_unit": m.variable.unit        if m.variable else None,
        "station_code":  m.station.station_code if m.station  else None,
        "station_name":  m.station.name         if m.station  else None,
    }


@router.get("/")
def list_measurements(
    station_id:    Optional[str] = Query(None),
    variable_id:   Optional[str] = Query(None),
    variable_code: Optional[str] = Query(None),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    limit:         int           = Query(1000, ge=1, le=50000),
    offset:        int           = Query(0, ge=0),
    order:         str           = Query("asc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_db),
):
    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .join(Measurement.station)
        # Eager-load de las relaciones ya unidas: evita un N+1 (2 SELECT por
        # fila en _serialize) que con limit=50000 implicaba ~100k consultas.
        .options(
            contains_eager(Measurement.variable),
            contains_eager(Measurement.station),
        )
    )

    if station_id:    q = q.filter(Measurement.station_id == station_id)
    if variable_id:   q = q.filter(Measurement.variable_id == variable_id)
    if variable_code: q = q.filter(func.upper(Variable.code) == variable_code.strip().upper())

    q = _apply_date_filters(q, date_from, date_to)

    if order == "desc":
        q = q.order_by(Measurement.measured_at.desc())
    else:
        q = q.order_by(Measurement.measured_at.asc())

    total = q.count()
    rows  = q.offset(offset).limit(limit).all()

    return {
        "total":  total,
        "offset": offset,
        "limit":  limit,
        "count":  len(rows),
        "data":   [_serialize(m) for m in rows],
    }


@router.get("/summary")
def get_summary(
    station_id:    Optional[str] = Query(None),
    variable_code: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = (
        db.query(
            Station.station_code, Station.name.label("station_name"),
            Variable.code.label("variable_code"),
            Variable.name.label("variable_name"), Variable.unit,
            SummaryStats.count, SummaryStats.min_value,
            SummaryStats.max_value, SummaryStats.avg_value,
            SummaryStats.date_start, SummaryStats.date_end,
        )
        .join(Station,  SummaryStats.station_id  == Station.id)
        .join(Variable, SummaryStats.variable_id == Variable.id)
    )
    if station_id:    q = q.filter(SummaryStats.station_id == station_id)
    if variable_code: q = q.filter(
        func.upper(Variable.code) == variable_code.strip().upper()
    )
    rows = q.all()

    def _round(v):
        return round(float(v), 4) if v is not None else None

    return [
        {
            "station_code":  r.station_code,
            "station_name":  r.station_name,
            "variable_code": r.variable_code,
            "variable_name": r.variable_name,
            "unit":          r.unit,
            "count":         r.count,
            "min":           _round(r.min_value),
            "max":           _round(r.max_value),
            "avg":           _round(r.avg_value),
            "date_start":    str(r.date_start) if r.date_start else None,
            "date_end":      str(r.date_end)   if r.date_end   else None,
        }
        for r in rows
    ]


@router.get("/by-date")
def get_by_date(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    group_by:      str           = Query("day", pattern="^(hour|day|month|year)$"),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    import pandas as pd

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
        .filter(func.upper(Variable.code) == variable_code.strip().upper())
    )
    q = _apply_date_filters(q, date_from, date_to)
    rows = q.order_by(Measurement.measured_at.asc()).all()

    if not rows:
        return []

    df = pd.DataFrame([
        {"measured_at": r.measured_at, "value": float(r.value)}
        for r in rows
    ])
    df["measured_at"] = pd.to_datetime(df["measured_at"])

    if   group_by == "hour":  df["period"] = df["measured_at"].dt.floor("h")
    elif group_by == "day":   df["period"] = df["measured_at"].dt.date
    elif group_by == "month": df["period"] = df["measured_at"].dt.to_period("M").dt.to_timestamp()
    else:                     df["period"] = df["measured_at"].dt.to_period("Y").dt.to_timestamp()

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


@router.get("/{measurement_id}")
def get_measurement(
    measurement_id: str,
    db: Session = Depends(get_db),
):
    m = db.query(Measurement).filter(Measurement.id == measurement_id).first()
    if not m:
        raise HTTPException(status_code=404, detail=f"Medición '{measurement_id}' no encontrada.")
    return _serialize(m)


@router.post("/", status_code=201)
def create_measurement(
    payload: MeasurementIn,
    db: Session = Depends(get_db),
):
    station = db.query(Station).filter(Station.id == payload.station_id).first()
    if not station:
        raise HTTPException(status_code=404, detail=f"Estación '{payload.station_id}' no encontrada.")

    variable = db.query(Variable).filter(Variable.id == payload.variable_id).first()
    if not variable:
        raise HTTPException(status_code=404, detail=f"Variable '{payload.variable_id}' no encontrada.")

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

    return {"message": "Medición creada correctamente", **_serialize(m)}


@router.delete("/{measurement_id}", status_code=200)
def delete_measurement(
    measurement_id: str,
    db: Session = Depends(get_db),
):
    m = db.query(Measurement).filter(Measurement.id == measurement_id).first()
    if not m:
        raise HTTPException(status_code=404, detail=f"Medición '{measurement_id}' no encontrada.")
    db.delete(m)
    db.commit()
    return {"message": f"Medición '{measurement_id}' eliminada correctamente."}


@router.delete("/")
def delete_measurements_range(
    station_id:    str           = Query(...),
    variable_code: Optional[str] = Query(None),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
    )

    if variable_code:
        q = q.filter(func.upper(Variable.code) == variable_code.strip().upper())

    q = _apply_date_filters(q, date_from, date_to)

    count = q.count()
    q.delete(synchronize_session=False)
    db.commit()

    return {"message": f"{count} medición(es) eliminadas correctamente.", "deleted": count}

