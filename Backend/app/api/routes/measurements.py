"""
measurements.py
===============
Endpoints GET/POST/DELETE  /measurements/

Endpoints disponibles:
  GET    /measurements/              Lista mediciones con filtros
  GET    /measurements/summary       Resumen estadístico por estación + variable
  GET    /measurements/by-date       Agrupado por día / mes / año
  GET    /measurements/stats         Estadísticos + FDP + Gaussianas (T) o Beta (HR)
  GET    /measurements/heatmap       Matriz mes × hora para mapa de calor
  GET    /measurements/combined      Densidad T×HR, humedad absoluta, humectación
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


# ═════════════════════════════════════════════════════════════
# HELPERS
# ═════════════════════════════════════════════════════════════

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


def _apply_date_filters(q, date_from, date_to):
    if date_from:
        try:
            q = q.filter(Measurement.measured_at >= datetime.fromisoformat(date_from))
        except ValueError:
            raise HTTPException(status_code=422, detail=f"date_from inválido: '{date_from}'")
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to).replace(hour=23, minute=59, second=59)
            q = q.filter(Measurement.measured_at <= dt_to)
        except ValueError:
            raise HTTPException(status_code=422, detail=f"date_to inválido: '{date_to}'")
    return q


# ═════════════════════════════════════════════════════════════
# AJUSTE BETA (para HR)
# ═════════════════════════════════════════════════════════════

def _fit_beta_components(fdp: list[dict], n_components: int = 2) -> tuple[list[dict], float | None]:
    """
    Ajusta n_components distribuciones Beta a la FDP de HR.

    HR está en [0, 100] así que normalizamos a [0, 1] para scipy.stats.beta,
    luego devolvemos moda, varianza y peso en la escala original (%).

    Retorna:
      - betas: lista de dicts con {alpha, beta, mode, variance, w}
      - r2:    coeficiente de determinación del modelo suma vs FDP real
    """
    import numpy as np
    from scipy.stats import beta as beta_dist
    from scipy.signal import find_peaks
    from scipy.optimize import minimize

    x_pct  = np.array([d["x"]    for d in fdp])   # escala 0-100
    y_real = np.array([d["freq"] for d in fdp])

    # Normalizar x a [0, 1] para Beta
    x_01 = x_pct / 100.0

    # ── Estimación inicial de picos ───────────────────────────
    peaks_idx, _ = find_peaks(y_real, distance=max(1, len(y_real) // (n_components + 1)))
    if len(peaks_idx) == 0:
        peaks_idx = np.argsort(y_real)[-n_components:]
    peaks_idx = sorted(peaks_idx[np.argsort(y_real[peaks_idx])[-n_components:]])

    # ── Parámetros iniciales α, β a partir de moda y varianza estimada ──
    p0 = []
    for i, idx in enumerate(peaks_idx):
        mode_01 = float(np.clip(x_01[idx], 0.01, 0.99))
        # Distancia al siguiente pico o al borde → estima varianza
        if i + 1 < len(peaks_idx):
            dist = abs(x_01[peaks_idx[i + 1]] - mode_01)
        else:
            dist = 0.15
        var_01 = max((dist / 2.5) ** 2, 0.005)
        # Momento-método inverso: α, β desde moda + varianza aproximados
        # Usamos la relación: mode = (α-1)/(α+β-2) y var ≈ αβ/((α+β)²(α+β+1))
        # Aproximación inicial: α ≈ mode*(1/var) , β ≈ (1-mode)*(1/var)
        inv_var = max(1.0 / var_01, 4.0)
        alpha0  = max(mode_01 * inv_var, 1.1)
        beta0   = max((1 - mode_01) * inv_var, 1.1)
        p0.extend([alpha0, beta0, 1.0 / n_components])   # α, β, peso

    p0 = np.array(p0, dtype=float)

    # ── Función modelo ─────────────────────────────────────────
    def model(x, params):
        total = np.zeros_like(x)
        n = len(params) // 3
        for i in range(n):
            a, b, w = params[3*i], params[3*i+1], params[3*i+2]
            # pdf de Beta en escala [0,1], luego dividimos por 100 para escala %
            total += w * beta_dist.pdf(x, a, b) / 100.0
        return total

    # ── Función de costo: MSE ──────────────────────────────────
    def cost(params):
        n = len(params) // 3
        # Restricciones suaves: α,β > 1 y pesos > 0
        alphas = params[0::3]
        betas  = params[1::3]
        weights = params[2::3]
        if np.any(alphas < 1.001) or np.any(betas < 1.001) or np.any(weights < 0.001):
            return 1e9
        y_model = model(x_01, params)
        return float(np.mean((y_real - y_model) ** 2))

    # Restricción: suma de pesos = 1
    constraints = [{
        "type": "eq",
        "fun":  lambda p: sum(p[2::3]) - 1.0,
    }]
    bounds = [(1.001, 500), (1.001, 500), (0.001, 1.0)] * n_components

    result = minimize(cost, p0, method="SLSQP", bounds=bounds, constraints=constraints,
                      options={"maxiter": 500, "ftol": 1e-9})

    params_opt = result.x

    # ── Normalizar pesos para que sumen exactamente 1 ─────────
    weights = params_opt[2::3]
    weights = np.clip(weights, 0, None)
    weights /= weights.sum()

    # ── Construir lista de componentes ─────────────────────────
    betas_out = []
    for i in range(n_components):
        a = float(params_opt[3*i])
        b = float(params_opt[3*i+1])
        w = float(weights[i])

        # Moda en escala % : mode_01 = (α-1)/(α+β-2) si α,β>1
        mode_01  = (a - 1) / (a + b - 2) if (a > 1 and b > 1) else 0.5
        mode_pct = round(float(mode_01 * 100), 2)

        # Varianza en escala % : var_01 = αβ/((α+β)²(α+β+1))
        var_01   = (a * b) / ((a + b) ** 2 * (a + b + 1))
        var_pct  = round(float(var_01 * 10000), 4)   # (×100)² para escala %

        betas_out.append({
            "alpha":    round(a, 4),
            "beta":     round(b, 4),
            "mode":     mode_pct,
            "variance": var_pct,
            "w":        round(w, 4),
        })

    # ── R² ────────────────────────────────────────────────────
    y_model = model(x_01, params_opt)
    # Renormalizamos pesos en el modelo final
    y_model_norm = np.zeros_like(x_01)
    for i in range(n_components):
        a = float(params_opt[3*i])
        b = float(params_opt[3*i+1])
        y_model_norm += float(weights[i]) * beta_dist.pdf(x_01, a, b) / 100.0

    ss_tot = float(np.sum((y_real - np.mean(y_real)) ** 2))
    ss_res = float(np.sum((y_real - y_model_norm) ** 2))
    r2     = round(1 - ss_res / ss_tot, 4) if ss_tot > 0 else None

    # Agregar columna model a fdp
    fdp_out = [
        {**d, "model": round(float(y_model_norm[i]), 6)}
        for i, d in enumerate(fdp)
    ]

    return betas_out, r2, fdp_out


# ═════════════════════════════════════════════════════════════
# GET /  — listar mediciones con filtros
# ═════════════════════════════════════════════════════════════

@router.get("/")
def list_measurements(
    station_id:    Optional[str] = Query(None),
    variable_id:   Optional[str] = Query(None),
    variable_code: Optional[str] = Query(None),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    limit:         int           = Query(1000, ge=1, le=50000),
    offset:        int           = Query(0, ge=0),
    order:         str           = Query("asc", regex="^(asc|desc)$"),
    db: Session = Depends(get_db),
):
    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .join(Measurement.station)
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


# ═════════════════════════════════════════════════════════════
# GET /summary
# ═════════════════════════════════════════════════════════════

@router.get("/summary")
def get_summary(
    station_id:    Optional[str] = Query(None),
    variable_code: Optional[str] = Query(None),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
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
        .join(Station,  Measurement.station_id  == Station.id)
        .join(Variable, Measurement.variable_id == Variable.id)
    )

    if station_id:    q = q.filter(Measurement.station_id == station_id)
    if variable_code: q = q.filter(func.upper(Variable.code) == variable_code.strip().upper())

    q = _apply_date_filters(q, date_from, date_to)

    q = q.group_by(
        Station.station_code, Station.name,
        Variable.code, Variable.name, Variable.unit,
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
            "min":           round(float(r.min), 4) if r.min  is not None else None,
            "max":           round(float(r.max), 4) if r.max  is not None else None,
            "avg":           round(float(r.avg), 4) if r.avg  is not None else None,
            "date_start":    str(r.date_start)       if r.date_start else None,
            "date_end":      str(r.date_end)         if r.date_end   else None,
        }
        for r in rows
    ]


# ═════════════════════════════════════════════════════════════
# GET /by-date
# ═════════════════════════════════════════════════════════════

@router.get("/by-date")
def get_by_date(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    group_by:      str           = Query("day", regex="^(hour|day|month|year)$"),
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


# ═════════════════════════════════════════════════════════════
# GET /stats  — estadísticos + FDP + Gaussianas (T) o Beta (HR)
# ═════════════════════════════════════════════════════════════

@router.get("/stats")
def get_stats(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    import numpy as np
    from scipy.signal import find_peaks

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
        .filter(func.upper(Variable.code) == variable_code.strip().upper())
    )
    q = _apply_date_filters(q, date_from, date_to)
    rows = q.order_by(Measurement.measured_at.asc()).all()

    if not rows:
        raise HTTPException(status_code=404, detail="Sin datos para los filtros indicados")

    values = np.array([float(r.value) for r in rows])
    values = values[~np.isnan(values)]

    if len(values) == 0:
        raise HTTPException(status_code=404, detail="Sin valores válidos")

    is_hr   = variable_code.strip().upper() == "HR"
    is_temp = variable_code.strip().upper() == "TEMP"

    # ── Estadísticos ──────────────────────────────────────────
    n    = len(values)
    mean = float(np.mean(values))
    std  = float(np.std(values))
    mn   = float(np.min(values))
    mx   = float(np.max(values))
    q25  = float(np.percentile(values, 25))
    q50  = float(np.percentile(values, 50))
    q75  = float(np.percentile(values, 75))

    step = 0.1 if is_temp else 1.0
    bins_mode = np.round(values / step) * step
    unique, counts = np.unique(bins_mode, return_counts=True)
    mode = float(unique[np.argmax(counts)])

    anomalies_count = int(np.sum(np.abs(values - mean) > 3 * std))

    # ── FDP ───────────────────────────────────────────────────
    paso = 0.1 if is_temp else 1.0
    bins = np.arange(mn, mx + paso, paso)
    counts_hist, edges = np.histogram(values, bins=bins, density=True)
    centers = ((edges[:-1] + edges[1:]) / 2).round(2)

    fdp = [
        {"x": float(c), "freq": round(float(f) * paso, 6)}
        for c, f in zip(centers, counts_hist)
    ]

    # ── Completitud ───────────────────────────────────────────
    date_start    = rows[0].measured_at
    date_end      = rows[-1].measured_at
    horas_totales = max(int((date_end - date_start).total_seconds() / 3600) + 1, 1)
    completitud   = round(n / horas_totales * 100, 2)

    # ═══════════════════════════════════════════════════════════
    # RAMA HR — ajuste Beta
    # ═══════════════════════════════════════════════════════════
    if is_hr:
        if len(fdp) > 4:
            betas, r2, fdp = _fit_beta_components(fdp, n_components=2)
        else:
            betas, r2 = [], None

        return {
            "n":               n,
            "mean":            round(mean, 4),
            "std":             round(std,  4),
            "min":             round(mn,   4),
            "max":             round(mx,   4),
            "q25":             round(q25,  4),
            "q50":             round(q50,  4),
            "q75":             round(q75,  4),
            "mode":            round(mode, 4),
            "completitud_pct": completitud,
            "anomalies_count": anomalies_count,
            "date_start":      str(date_start),
            "date_end":        str(date_end),
            "distribution":    "beta",          # ← indica al frontend el tipo
            "fdp":             fdp,
            "betas":           betas,           # ← {alpha, beta, mode, variance, w}
            "gaussians":       [],              # vacío para compatibilidad
            "r2":              r2,
        }

    # ═══════════════════════════════════════════════════════════
    # RAMA TEMP — ajuste Gaussiano (sin cambios)
    # ═══════════════════════════════════════════════════════════
    gaussians = []
    r2 = None

    if len(fdp) > 4:
        fdp_arr = np.array([d["freq"] for d in fdp])
        x_arr   = np.array([d["x"]   for d in fdp])
        n_gauss = 2

        peaks_idx, _ = find_peaks(fdp_arr, distance=max(1, int(len(fdp_arr) / (n_gauss + 1))))
        if len(peaks_idx) == 0:
            peaks_idx = np.argsort(fdp_arr)[-n_gauss:]
        peaks_idx = peaks_idx[np.argsort(fdp_arr[peaks_idx])[-n_gauss:]]

        for i, idx in enumerate(sorted(peaks_idx)):
            mu       = float(x_arr[idx])
            next_idx = peaks_idx[i + 1] if i + 1 < len(peaks_idx) else None
            sigma    = float(abs(x_arr[next_idx] - mu) / 2.5) if next_idx is not None else 2.0
            sigma    = max(sigma, 0.5)
            gaussians.append({"mu": round(mu, 2), "sigma": round(sigma, 2), "w": round(1.0 / n_gauss, 4)})

        def gauss_sum(x, gs):
            return sum(
                g["w"] * np.exp(-0.5 * ((x - g["mu"]) / g["sigma"]) ** 2)
                / (g["sigma"] * np.sqrt(2 * np.pi))
                for g in gs
            )

        y_real  = np.array([d["freq"] for d in fdp])
        y_model = np.array([gauss_sum(d["x"], gaussians) for d in fdp])
        y_mean  = np.mean(y_real)
        ss_tot  = np.sum((y_real - y_mean) ** 2)
        ss_res  = np.sum((y_real - y_model) ** 2)
        r2      = round(float(1 - ss_res / ss_tot), 4) if ss_tot > 0 else None

        fdp = [
            {**d, "model": round(float(y_model[i]), 6)}
            for i, d in enumerate(fdp)
        ]

    return {
        "n":               n,
        "mean":            round(mean, 4),
        "std":             round(std,  4),
        "min":             round(mn,   4),
        "max":             round(mx,   4),
        "q25":             round(q25,  4),
        "q50":             round(q50,  4),
        "q75":             round(q75,  4),
        "mode":            round(mode, 4),
        "completitud_pct": completitud,
        "anomalies_count": anomalies_count,
        "date_start":      str(date_start),
        "date_end":        str(date_end),
        "distribution":    "gaussian",      # ← indica al frontend el tipo
        "fdp":             fdp,
        "gaussians":       gaussians,
        "betas":           [],              # vacío para compatibilidad
        "r2":              r2,
    }


# ═════════════════════════════════════════════════════════════
# GET /heatmap  — matriz mes × hora
# ═════════════════════════════════════════════════════════════

@router.get("/heatmap")
def get_heatmap(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
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
    rows = q.all()

    if not rows:
        raise HTTPException(status_code=404, detail="Sin datos para los filtros indicados")

    df = pd.DataFrame([
        {"measured_at": r.measured_at, "value": float(r.value)}
        for r in rows
    ])
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    df["mes"]  = df["measured_at"].dt.month
    df["hora"] = df["measured_at"].dt.hour

    matrix = (
        df.groupby(["mes", "hora"])["value"]
        .mean().round(2).reset_index()
        .rename(columns={"value": "avg"})
        .to_dict(orient="records")
    )

    all_vals = df["value"].dropna()
    return {
        "matrix": matrix,
        "min":    round(float(all_vals.min()), 2),
        "max":    round(float(all_vals.max()), 2),
    }


# ═════════════════════════════════════════════════════════════
# GET /combined  — densidad T×HR, humedad absoluta, humectación
# ═════════════════════════════════════════════════════════════

@router.get("/combined")
def get_combined(
    station_id: str           = Query(...),
    altitude:   float         = Query(0),
    date_from:  Optional[str] = Query(None),
    date_to:    Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    import pandas as pd
    import numpy as np

    def _q(code):
        q = (
            db.query(Measurement)
            .join(Measurement.variable)
            .filter(Measurement.station_id == station_id)
            .filter(func.upper(Variable.code) == code)
        )
        return _apply_date_filters(q, date_from, date_to).all()

    t_rows = _q("TEMP")
    h_rows = _q("HR")

    if not t_rows or not h_rows:
        raise HTTPException(status_code=404, detail="Sin datos de T o HR para los filtros indicados")

    t_map  = {str(r.measured_at): float(r.value) for r in t_rows}
    joined = []

    for r in h_rows:
        T = t_map.get(str(r.measured_at))
        if T is None:
            continue
        HR     = float(r.value)
        p_sat  = 9.066 * np.exp(0.0641 * T) - 1.796 * np.exp(0.0805 * T)
        p_tot  = 1013.25 * (1 - 2.25577e-5 * altitude) ** 5.2559
        hr_frac = HR / 100
        denom   = p_tot - hr_frac * p_sat
        h_abs   = (18000 / 29) * (hr_frac * p_sat) / denom if denom > 0 else None
        joined.append({
            "measured_at": r.measured_at,
            "T":    T,
            "HR":   HR,
            "habs": round(h_abs, 4) if h_abs is not None else None,
        })

    if not joined:
        raise HTTPException(status_code=404, detail="Sin datos cruzados T+HR")

    df = pd.DataFrame(joined)
    df["measured_at"] = pd.to_datetime(df["measured_at"])

    # Densidad T×HR
    df["T_bin"]  = (df["T"]  / 1).round() * 1
    df["HR_bin"] = (df["HR"] / 5).round() * 5
    density = (
        df.groupby(["T_bin", "HR_bin"]).size().reset_index(name="count")
        .rename(columns={"T_bin": "T", "HR_bin": "HR"})
        .to_dict(orient="records")
    )

    # Tiempo de humectación
    humect_count = int(((df["T"] > 10) & (df["HR"] > 79)).sum())
    humect_pct   = round(humect_count / len(df) * 100, 2)

    # Serie mensual H_abs
    df_habs = df.dropna(subset=["habs"]).copy()
    df_habs["period"] = df_habs["measured_at"].dt.to_period("M").dt.to_timestamp()
    habs_monthly = (
        df_habs.groupby("period")["habs"]
        .mean().round(4).reset_index()
        .rename(columns={"habs": "avg"})
    )
    habs_series = [
        {"period": str(row["period"].date())[:7] + "-01", "avg": float(row["avg"])}
        for _, row in habs_monthly.iterrows()
    ]

    scatter_sample = (
        df[["T", "HR", "habs"]].dropna().head(2000).to_dict(orient="records")
    )

    return {
        "density":      density,
        "humect_pct":   humect_pct,
        "habs_monthly": habs_series,
        "scatter":      scatter_sample,
        "total_paired": len(df),
    }


# ═════════════════════════════════════════════════════════════
# GET /{id}
# ═════════════════════════════════════════════════════════════

@router.get("/{measurement_id}")
def get_measurement(
    measurement_id: str,
    db: Session = Depends(get_db),
):
    m = db.query(Measurement).filter(Measurement.id == measurement_id).first()
    if not m:
        raise HTTPException(status_code=404, detail=f"Medición '{measurement_id}' no encontrada.")
    return _serialize(m)


# ═════════════════════════════════════════════════════════════
# POST /
# ═════════════════════════════════════════════════════════════

@router.post("/", status_code=201)
def create_measurement(
    payload: MeasurementIn,
    db: Session = Depends(get_db),
):
    station  = db.query(Station).filter(Station.id == payload.station_id).first()
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


# ═════════════════════════════════════════════════════════════
# DELETE /{id}
# ═════════════════════════════════════════════════════════════

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


# ═════════════════════════════════════════════════════════════
# DELETE /  — eliminar rango
# ═════════════════════════════════════════════════════════════

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