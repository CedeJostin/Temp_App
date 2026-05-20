"""
analysis.py
===========
Endpoints de análisis de calidad y estadísticas de datos crudos.

  GET /stations/{station_id}/analysis          Análisis completo T y HR
  GET /stations/{station_id}/analysis/gaps     Huecos continuos > 5 días
"""

from datetime import datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.measurement import Measurement
from app.models.station import Station
from app.models.variable import Variable

router = APIRouter()


# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────

def _completeness_band(pct: float) -> dict:
    """Devuelve banda e indicador de color según porcentaje de completitud."""
    if pct >= 98:
        return {"band": "[100, 98)", "color": "green",  "label": "Excelente"}
    elif pct >= 95:
        return {"band": "[98, 95)",  "color": "blue",   "label": "Muy bueno"}
    elif pct >= 90:
        return {"band": "[95, 90)",  "color": "yellow", "label": "Bueno"}
    elif pct >= 85:
        return {"band": "[90, 85)",  "color": "orange", "label": "Regular"}
    else:
        return {"band": "[85, <)",   "color": "red",    "label": "Deficiente"}


def _find_gaps(series: pd.Series, max_gap_hours: int = 24 * 5) -> list[dict]:
    """
    Detecta huecos continuos mayores a max_gap_hours horas en una serie temporal.
    series: índice DatetimeIndex con frecuencia horaria ideal, valores NaN donde faltan.
    Devuelve lista de {start, end, hours, days}.
    """
    gaps = []
    in_gap = False
    gap_start = None

    for ts in series.index:
        is_missing = pd.isna(series[ts])
        if is_missing and not in_gap:
            in_gap = True
            gap_start = ts
        elif not is_missing and in_gap:
            gap_end = ts
            gap_hours = int((gap_end - gap_start).total_seconds() / 3600)
            if gap_hours > max_gap_hours:
                gaps.append({
                    "start": str(gap_start),
                    "end":   str(gap_end),
                    "hours": gap_hours,
                    "days":  round(gap_hours / 24, 1),
                })
            in_gap = False

    # Si el hueco llega hasta el final
    if in_gap and gap_start is not None:
        gap_end = series.index[-1]
        gap_hours = int((gap_end - gap_start).total_seconds() / 3600)
        if gap_hours > max_gap_hours:
            gaps.append({
                "start": str(gap_start),
                "end":   str(gap_end),
                "hours": gap_hours,
                "days":  round(gap_hours / 24, 1),
            })

    return gaps


def _stats_for_values(values: np.ndarray, variable_code: str) -> dict:
    """Calcula estadísticos completos sobre un array de valores limpios."""
    if len(values) == 0:
        return {}

    step = 0.1 if variable_code.upper() == "TEMP" else 1.0
    bins_mode = np.round(values / step) * step
    unique, counts = np.unique(bins_mode, return_counts=True)
    mode = float(unique[np.argmax(counts)])

    return {
        "n":     int(len(values)),
        "mean":  round(float(np.mean(values)),              4),
        "std":   round(float(np.std(values)),               4),
        "min":   round(float(np.min(values)),               4),
        "max":   round(float(np.max(values)),               4),
        "q25":   round(float(np.percentile(values, 25)),    4),
        "q50":   round(float(np.percentile(values, 50)),    4),
        "q75":   round(float(np.percentile(values, 75)),    4),
        "mode":  round(mode,                                4),
    }


def _analyse_variable(
    db: Session,
    station_id: str,
    variable_code: str,
    date_from: Optional[str],
    date_to: Optional[str],
) -> dict:
    """Realiza análisis completo para una variable en una estación."""

    # ── Cargar datos ──────────────────────────────────────────
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
            raise HTTPException(422, f"date_from inválido: '{date_from}'")
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to).replace(hour=23, minute=59, second=59)
            q = q.filter(Measurement.measured_at <= dt_to)
        except ValueError:
            raise HTTPException(422, f"date_to inválido: '{date_to}'")

    rows = q.order_by(Measurement.measured_at.asc()).all()

    if not rows:
        return {
            "variable_code": variable_code.upper(),
            "status": "no_data",
            "n_raw": 0,
            "n_clean": 0,
        }

    # ── Construir DataFrame con todos los registros ───────────
    df_raw = pd.DataFrame([
        {"measured_at": r.measured_at, "value": float(r.value)}
        for r in rows
    ])
    df_raw["measured_at"] = pd.to_datetime(df_raw["measured_at"]).dt.floor("h")
    df_raw = df_raw.drop_duplicates("measured_at").set_index("measured_at").sort_index()

    n_raw = len(df_raw)

    # ── Depuración: eliminar negativos y NaN ──────────────────
    df_clean = df_raw.copy()
    df_clean.loc[df_clean["value"] < 0, "value"] = np.nan   # negativos → vacío
    df_clean = df_clean.dropna()

    n_clean = len(df_clean)

    # ── Rango temporal completo (horas ideales) ───────────────
    t_start = df_raw.index.min()
    t_end   = df_raw.index.max()
    ideal_index = pd.date_range(start=t_start, end=t_end, freq="h")
    n_ideal = len(ideal_index)

    # Serie reindexada para detectar huecos (NaN = faltante)
    series_full = df_clean["value"].reindex(ideal_index)

    # ── Completitud ───────────────────────────────────────────
    completeness_pct = round(n_clean / n_ideal * 100, 4) if n_ideal > 0 else 0.0
    band_info = _completeness_band(completeness_pct)

    # ── Huecos > 5 días ───────────────────────────────────────
    gaps = _find_gaps(series_full, max_gap_hours=24 * 5)
    has_large_gaps = len(gaps) > 0

    # ── Estadísticos ──────────────────────────────────────────
    values_arr = df_clean["value"].values
    stats = _stats_for_values(values_arr, variable_code)

    # ── Datos crudos (primeros 50 000 registros) ──────────────
    raw_records = []
    for i, (ts, row) in enumerate(
        df_clean.reset_index().rename(columns={"measured_at": "ts"}).iterrows()
    ):
        if i >= 50_000:
            break
        raw_records.append({
            "n":    i + 1,
            "year": int(row["ts"].year),
            "month": int(row["ts"].month),
            "day":   int(row["ts"].day),
            "hour":  int(row["ts"].hour),
            "value": round(float(row["value"]), 4),
        })

    return {
        "variable_code":    variable_code.upper(),
        "date_start":       str(t_start),
        "date_end":         str(t_end),
        "n_raw":            n_raw,
        "n_clean":          n_clean,
        "n_ideal":          n_ideal,
        "completeness_pct": completeness_pct,
        "completeness_band": band_info,
        "has_large_gaps":   has_large_gaps,
        "large_gaps":       gaps,          # lista de huecos > 5 días
        "stats":            stats,
        "raw_data":         raw_records,   # # dato, año, mes, día, hora, valor
    }


# ─────────────────────────────────────────────────────────────
# GET /stations/{station_id}/analysis
# ─────────────────────────────────────────────────────────────

@router.get("/{station_id}/analysis")
def get_station_analysis(
    station_id: str,
    date_from:  Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_to:    Optional[str] = Query(None, description="YYYY-MM-DD"),
    db: Session = Depends(get_db),
):
    """
    Análisis completo de calidad de datos para T y HR en una estación.

    Devuelve para cada variable:
    - Datos primarios crudos depurados (negativos eliminados)
    - Número total de datos y porcentaje sobre el total ideal
    - Indicador de completitud con banda de color
    - Alerta si existen huecos continuos > 5 días
    - Estadísticos: min, max, mean, std, mode, Q25, Q50, Q75
    """
    station = db.query(Station).filter(Station.id == station_id).first()
    if not station:
        raise HTTPException(404, f"Estación '{station_id}' no encontrada.")

    results = {}
    for code in ("TEMP", "HR"):
        results[code.lower()] = _analyse_variable(
            db, station_id, code, date_from, date_to
        )

    return {
        "station_id":   station_id,
        "station_code": station.station_code,
        "station_name": station.name,
        "date_from":    date_from,
        "date_to":      date_to,
        "variables":    results,
    }


# ─────────────────────────────────────────────────────────────
# GET /stations/{station_id}/analysis/gaps
# ─────────────────────────────────────────────────────────────

@router.get("/{station_id}/analysis/gaps")
def get_station_gaps(
    station_id:    str,
    variable_code: str           = Query("TEMP", regex="^(TEMP|HR)$"),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    min_gap_days:  float         = Query(5.0, ge=0.5),
    db: Session = Depends(get_db),
):
    """
    Lista detallada de huecos continuos en el registro para la variable indicada.
    min_gap_days: umbral mínimo en días para reportar un hueco (por defecto 5).
    """
    station = db.query(Station).filter(Station.id == station_id).first()
    if not station:
        raise HTTPException(404, f"Estación '{station_id}' no encontrada.")

    result = _analyse_variable(db, station_id, variable_code, date_from, date_to)

    # Refiltrar por umbral personalizado si difiere del default
    if min_gap_days != 5.0:
        # Re-calcular con umbral ajustado
        q = (
            db.query(Measurement)
            .join(Measurement.variable)
            .filter(Measurement.station_id == station_id)
            .filter(func.upper(Variable.code) == variable_code.strip().upper())
        )
        rows = q.order_by(Measurement.measured_at.asc()).all()
        if rows:
            df = pd.DataFrame([
                {"measured_at": r.measured_at, "value": float(r.value)}
                for r in rows
            ])
            df["measured_at"] = pd.to_datetime(df["measured_at"]).dt.floor("h")
            df = df.drop_duplicates("measured_at").set_index("measured_at").sort_index()
            df.loc[df["value"] < 0, "value"] = np.nan
            df = df.dropna()
            ideal = pd.date_range(df.index.min(), df.index.max(), freq="h")
            series = df["value"].reindex(ideal)
            gaps = _find_gaps(series, max_gap_hours=int(min_gap_days * 24))
        else:
            gaps = []
    else:
        gaps = result.get("large_gaps", [])

    return {
        "station_id":   station_id,
        "station_name": station.name,
        "variable_code": variable_code.upper(),
        "min_gap_days": min_gap_days,
        "gaps_count":   len(gaps),
        "gaps":         gaps,
    }