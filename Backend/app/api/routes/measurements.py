"""
measurements.py
===============
Endpoints GET/POST/DELETE  /measurements/

Endpoints disponibles:
  GET    /measurements/              Lista mediciones con filtros
  GET    /measurements/summary       Resumen estadístico por estación + variable
  GET    /measurements/by-date       Agrupado por día / mes / año
  GET    /measurements/stats         Estadísticos + FDP + Gaussianas (T) o Beta (HR)
  GET    /measurements/stats/summary-table  Tabla exportable de ajustes por estación (b.1)
  GET    /measurements/heatmap       Matriz mes × hora (o mes × semana) para mapa de calor
  GET    /measurements/daily-profile Perfil diario promedio por mes (c.2)
  GET    /measurements/annual-profile Perfil anual promedio (c.3)
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


def _completitud_color(pct: float) -> str:
    if pct >= 98:  return "green"
    if pct >= 95:  return "blue"
    if pct >= 90:  return "yellow"
    if pct >= 85:  return "orange"
    return "red"


# ═════════════════════════════════════════════════════════════
# HELPER INTERNO: construir FDP como fracción simple
# (igual que la columna "Fracción" del Excel de referencia)
# ═════════════════════════════════════════════════════════════

def _build_fdp(values, paso: float) -> list[dict]:
    """
    Construye la FDP como fracción simple:
        freq[i] = count_en_bin[i] / total_datos

    Esto es equivalente a la columna "Fracción" del Excel de Javier,
    donde cada barra representa la proporción de datos en ese bin.

    NO usa density=True de numpy (que devuelve densidad de probabilidad),
    sino conteo directo dividido por el total.
    """
    import numpy as np

    mn = float(np.min(values))
    mx = float(np.max(values))
    bins = np.arange(mn, mx + paso, paso)

    counts_hist, edges = np.histogram(values, bins=bins, density=False)
    centers = ((edges[:-1] + edges[1:]) / 2).round(4)
    total = counts_hist.sum()

    return [
        {"x": float(c), "freq": round(float(f) / total, 6)}
        for c, f in zip(centers, counts_hist)
    ]


# ═════════════════════════════════════════════════════════════
# AJUSTE GAUSSIANO (para T)
# Detección de picos por primera derivada (cambio de signo + → -)
# según indicaciones del coordinador (método del instructivo).
# ═════════════════════════════════════════════════════════════

def _fit_gaussian_components(
    fdp: list[dict],
    n_components: int = 2,
) -> tuple[list[dict], float | None, float | None, list[dict]]:
    """
    Ajusta n_components gaussianas a la FDP de T.

    FDP esperada: fracción simple (freq = count/total), escala [0,1].

    Detección de picos:
      - Se calcula la primera derivada numérica: dy[i] = y[i+1] - y[i]
      - Un pico real es donde dy cambia de positivo a negativo (subida → bajada)
      - Esto evita depender de find_peaks y sus parámetros arbitrarios

    Modelo: suma ponderada de gaussianas × paso (para que integre a fracción)
      model(x) = Σ w_i · N(x | mu_i, sigma_i) · paso

    Criterios del instructivo:
      EMC ≤ 1E-5 · R² ≥ 0.95 · Error punto a punto ±1E-3 · Σw = 1

    Retorna:
      gaussians : lista de dicts {mu, sigma, w}
      r2        : coeficiente de determinación
      mse       : error medio cuadrático
      fdp_out   : fdp con columnas "model" y "error_range" agregadas
    """
    import numpy as np
    from scipy.optimize import minimize

    x_arr  = np.array([d["x"]    for d in fdp])
    y_real = np.array([d["freq"] for d in fdp])

    # paso real entre bins (no asumido, calculado desde los datos)
    paso = float(x_arr[1] - x_arr[0]) if len(x_arr) > 1 else 0.1

    # ── DETECCIÓN DE PICOS POR PRIMERA DERIVADA ───────────────
    # dy[i] > 0 → subiendo; dy[i] <= 0 → bajando o plano
    # Pico donde dy cambia de + a - (índice i+1)
    dy = np.diff(y_real)
    peak_candidates = []
    for i in range(len(dy) - 1):
        if dy[i] > 0 and dy[i + 1] <= 0:
            peak_candidates.append(i + 1)

    # Si no hay suficientes picos, completar con los máximos globales restantes
    if len(peak_candidates) < n_components:
        mask = np.ones(len(y_real), dtype=bool)
        for idx in peak_candidates:
            mask[max(0, idx - 2):min(len(mask), idx + 3)] = False
        remaining = np.where(mask)[0]
        if len(remaining) > 0:
            extra = remaining[np.argsort(y_real[remaining])[::-1]]
            for e in extra:
                peak_candidates.append(int(e))
                if len(peak_candidates) >= n_components:
                    break

    # Quedarse con los n_components de mayor amplitud, ordenados por posición
    peak_candidates = sorted(
        peak_candidates,
        key=lambda i: y_real[i],
        reverse=True,
    )[:n_components]
    peak_candidates = sorted(peak_candidates)

    # ── PARÁMETROS INICIALES ──────────────────────────────────
    p0 = []
    for k, idx in enumerate(peak_candidates):
        mu = float(x_arr[idx])
        if k + 1 < len(peak_candidates):
            sigma = float(abs(x_arr[peak_candidates[k + 1]] - mu) / 2.5)
        else:
            sigma = float((x_arr[-1] - x_arr[0]) / (4 * n_components))
        sigma = max(sigma, 0.3)
        p0.extend([mu, sigma, 1.0 / n_components])
    p0 = np.array(p0, dtype=float)

    # ── MODELO: Σ w_i · N(x|mu_i,sigma_i) · paso ─────────────
    # Multiplicar por paso convierte densidad → fracción,
    # igual que en el Excel: Gauss_i = w_i · norm.pdf(x, mu, sigma) · 0.1
    def gauss_pdf(x, mu, sigma):
        return np.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * np.sqrt(2 * np.pi))

    def model(x, params):
        total = np.zeros_like(x, dtype=float)
        n = len(params) // 3
        for i in range(n):
            mu, sigma, w = params[3 * i], params[3 * i + 1], params[3 * i + 2]
            total += w * gauss_pdf(x, mu, sigma) * paso
        return total

    # ── FUNCIÓN DE COSTO: MSE ─────────────────────────────────
    def cost(params):
        sigmas  = params[1::3]
        weights = params[2::3]
        if np.any(sigmas < 0.1) or np.any(weights < 0.001):
            return 1e9
        y_hat = model(x_arr, params)
        return float(np.mean((y_real - y_hat) ** 2))

    # ── RESTRICCIÓN: Σ pesos = 1 ─────────────────────────────
    constraints = [{"type": "eq", "fun": lambda p: np.sum(p[2::3]) - 1.0}]

    x_min, x_max = float(x_arr.min()), float(x_arr.max())
    bounds = [(x_min - 5, x_max + 5), (0.1, 20.0), (0.001, 1.0)] * n_components

    result = minimize(
        cost, p0, method="SLSQP",
        bounds=bounds,
        constraints=constraints,
        options={"maxiter": 2000, "ftol": 1e-12},
    )

    params_opt = result.x

    # ── NORMALIZAR PESOS ──────────────────────────────────────
    weights = params_opt[2::3].copy()
    weights = np.clip(weights, 0, None)
    weights /= weights.sum()

    # ── CONSTRUIR GAUSSIANAS ──────────────────────────────────
    gaussians = []
    for i in range(n_components):
        mu    = float(params_opt[3 * i])
        sigma = float(abs(params_opt[3 * i + 1]))
        w     = float(weights[i])
        gaussians.append({
            "mu":    round(mu,    3),
            "sigma": round(sigma, 3),
            "w":     round(w,     4),
        })

    # ── MÉTRICAS ──────────────────────────────────────────────
    params_norm = params_opt.copy()
    for i in range(n_components):
        params_norm[3 * i + 2] = float(weights[i])

    y_model = model(x_arr, params_norm)

    mse    = float(np.mean((y_real - y_model) ** 2))
    ss_tot = float(np.sum((y_real - np.mean(y_real)) ** 2))
    ss_res = float(np.sum((y_real - y_model) ** 2))
    r2     = round(1 - ss_res / ss_tot, 4) if ss_tot > 0 else None

    fdp_out = [
        {
            **d,
            "model":       round(float(y_model[i]), 6),
            "error_range": round(float(y_real[i] - y_model[i]), 6),
        }
        for i, d in enumerate(fdp)
    ]

    return gaussians, r2, round(mse, 8), fdp_out


# ═════════════════════════════════════════════════════════════
# AJUSTE BETA (para HR)
# Detección de picos por primera derivada (igual que gaussianas).
# FDP en fracción simple; modelo × paso_01 para integrar correctamente.
# ═════════════════════════════════════════════════════════════

def _fit_beta_components(
    fdp: list[dict],
    n_components: int = 2,
) -> tuple[list[dict], float | None, float | None, list[dict]]:
    """
    Ajusta n_components distribuciones Beta a la FDP de HR.

    HR está en [0,100] → se normaliza a [0,1] para scipy.stats.beta.
    FDP esperada: fracción simple (freq = count/total).

    Modelo: Σ w_i · Beta(x|alpha_i,beta_i) · paso_01
      donde paso_01 = 0.01 (1% en escala [0,1])

    n_components es configurable (hasta 8 para clima tropical).
    """
    import numpy as np
    from scipy.stats import beta as beta_dist
    from scipy.optimize import minimize

    x_pct  = np.array([d["x"]    for d in fdp])   # escala 0-100
    y_real = np.array([d["freq"] for d in fdp])
    x_01   = x_pct / 100.0

    # paso en escala [0,1]
    paso_01 = float(x_01[1] - x_01[0]) if len(x_01) > 1 else 0.01

    # ── DETECCIÓN DE PICOS POR PRIMERA DERIVADA ───────────────
    dy = np.diff(y_real)
    peak_candidates = []
    for i in range(len(dy) - 1):
        if dy[i] > 0 and dy[i + 1] <= 0:
            peak_candidates.append(i + 1)

    if len(peak_candidates) < n_components:
        mask = np.ones(len(y_real), dtype=bool)
        for idx in peak_candidates:
            mask[max(0, idx - 2):min(len(mask), idx + 3)] = False
        remaining = np.where(mask)[0]
        if len(remaining) > 0:
            extra = remaining[np.argsort(y_real[remaining])[::-1]]
            for e in extra:
                peak_candidates.append(int(e))
                if len(peak_candidates) >= n_components:
                    break

    peak_candidates = sorted(
        peak_candidates,
        key=lambda i: y_real[i],
        reverse=True,
    )[:n_components]
    peak_candidates = sorted(peak_candidates)

    # ── PARÁMETROS INICIALES α, β a partir de moda estimada ───
    p0 = []
    for k, idx in enumerate(peak_candidates):
        mode_01 = float(np.clip(x_01[idx], 0.01, 0.99))
        if k + 1 < len(peak_candidates):
            dist = abs(x_01[peak_candidates[k + 1]] - mode_01)
        else:
            dist = 0.15
        var_01  = max((dist / 2.5) ** 2, 0.005)
        inv_var = max(1.0 / var_01, 4.0)
        alpha0  = max(mode_01 * inv_var, 1.1)
        beta0   = max((1 - mode_01) * inv_var, 1.1)
        p0.extend([alpha0, beta0, 1.0 / n_components])
    p0 = np.array(p0, dtype=float)

    # ── MODELO: Σ w_i · Beta(x|a,b) · paso_01 ────────────────
    # Multiplicar por paso_01 convierte densidad → fracción
    def model(x, params):
        total = np.zeros_like(x, dtype=float)
        n = len(params) // 3
        for i in range(n):
            a, b, w = params[3 * i], params[3 * i + 1], params[3 * i + 2]
            total += w * beta_dist.pdf(x, a, b) * paso_01
        return total

    def cost(params):
        alphas  = params[0::3]
        betas_p = params[1::3]
        weights = params[2::3]
        if np.any(alphas < 1.001) or np.any(betas_p < 1.001) or np.any(weights < 0.001):
            return 1e9
        y_hat = model(x_01, params)
        return float(np.mean((y_real - y_hat) ** 2))

    constraints = [{"type": "eq", "fun": lambda p: sum(p[2::3]) - 1.0}]
    bounds = [(1.001, 500), (1.001, 500), (0.001, 1.0)] * n_components

    result = minimize(
        cost, p0, method="SLSQP",
        bounds=bounds,
        constraints=constraints,
        options={"maxiter": 500, "ftol": 1e-9},
    )

    params_opt = result.x

    # ── NORMALIZAR PESOS ──────────────────────────────────────
    weights = params_opt[2::3].copy()
    weights = np.clip(weights, 0, None)
    weights /= weights.sum()

    # ── CONSTRUIR COMPONENTES BETA ────────────────────────────
    betas_out = []
    for i in range(n_components):
        a = float(params_opt[3 * i])
        b = float(params_opt[3 * i + 1])
        w = float(weights[i])

        mode_01  = (a - 1) / (a + b - 2) if (a > 1 and b > 1) else 0.5
        mode_pct = round(float(mode_01 * 100), 2)
        var_01   = (a * b) / ((a + b) ** 2 * (a + b + 1))
        var_pct  = round(float(var_01 * 10000), 4)

        betas_out.append({
            "alpha":    round(a, 4),
            "beta":     round(b, 4),
            "mode":     mode_pct,
            "variance": var_pct,
            "w":        round(w, 4),
        })

    # ── MÉTRICAS ──────────────────────────────────────────────
    params_norm = params_opt.copy()
    for i in range(n_components):
        params_norm[3 * i + 2] = float(weights[i])

    y_model = model(x_01, params_norm)

    mse    = float(np.mean((y_real - y_model) ** 2))
    ss_tot = float(np.sum((y_real - np.mean(y_real)) ** 2))
    ss_res = float(np.sum((y_real - y_model) ** 2))
    r2     = round(1 - ss_res / ss_tot, 4) if ss_tot > 0 else None

    fdp_out = [
        {
            **d,
            "model":       round(float(y_model[i]), 6),
            "error_range": round(float(y_real[i] - y_model[i]), 6),
        }
        for i, d in enumerate(fdp)
    ]

    return betas_out, r2, round(mse, 8), fdp_out


# ─── Verificación de umbrales del instructivo ─────────────────
def _quality_flags(mse, r2, fdp_data):
    errors  = [abs(d.get("error_range", 0)) for d in fdp_data if "error_range" in d]
    max_err = max(errors) if errors else None
    return {
        "mse_ok":           mse is not None and mse <= 1e-5,
        "r2_ok":            r2  is not None and r2  >= 0.95,
        "error_range_ok":   max_err is not None and max_err <= 1e-3,
        "max_error_range":  round(max_err, 6) if max_err is not None else None,
        "mse_target":       "≤ 1E-5",
        "r2_target":        "≥ 0.95",
        "error_target":     "± 1E-3",
    }


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
    n_components:  int           = Query(2, ge=1, le=8,
                                         description="Número de componentes gaussianas/beta (hasta 8 para clima tropical)"),
    db: Session = Depends(get_db),
):
    import numpy as np

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

    anomaly_threshold = 3 * std
    anomalies_count   = int(np.sum(np.abs(values - mean) > anomaly_threshold))
    anomaly_values    = [
        round(float(v), 4)
        for v in values
        if abs(v - mean) > anomaly_threshold
    ]

    # ── FDP como fracción simple ──────────────────────────────
    # Resolución: 0.1°C para T, 1% para HR (según instructivo)
    paso = 0.1 if is_temp else 1.0
    fdp  = _build_fdp(values, paso)

    # ── Completitud ───────────────────────────────────────────
    date_start    = rows[0].measured_at
    date_end      = rows[-1].measured_at
    horas_totales = max(int((date_end - date_start).total_seconds() / 3600) + 1, 1)
    completitud   = round(n / horas_totales * 100, 2)
    completitud_color = _completitud_color(completitud)

    # ═══════════════════════════════════════════════════════════
    # RAMA HR — ajuste Beta
    # ═══════════════════════════════════════════════════════════
    if is_hr:
        betas, r2, mse, fdp_fitted = ([], None, None, fdp) if len(fdp) <= 4 else \
            _fit_beta_components(fdp, n_components=n_components)

        w_sum = round(sum(b["w"] for b in betas), 4)
        w_ok  = abs(w_sum - 1.0) < 0.01

        quality = _quality_flags(mse, r2, fdp_fitted)
        quality["weights_sum"]    = w_sum
        quality["weights_sum_ok"] = w_ok

        return {
            "n":                  n,
            "mean":               round(mean, 4),
            "std":                round(std,  4),
            "min":                round(mn,   4),
            "max":                round(mx,   4),
            "q25":                round(q25,  4),
            "q50":                round(q50,  4),
            "q75":                round(q75,  4),
            "mode":               round(mode, 4),
            "completitud_pct":    completitud,
            "completitud_color":  completitud_color,
            "anomalies_count":    anomalies_count,
            "anomaly_values":     anomaly_values[:50],
            "anomaly_threshold":  round(anomaly_threshold, 4),
            "date_start":         str(date_start),
            "date_end":           str(date_end),
            "distribution":       "beta",
            "n_components":       n_components,
            "fdp_resolution":     paso,           # resolución visible en frontend
            "fdp":                fdp_fitted,
            "betas":              betas,
            "gaussians":          [],
            "r2":                 r2,
            "mse":                mse,
            "quality":            quality,
        }

    # ═══════════════════════════════════════════════════════════
    # RAMA TEMP — ajuste Gaussiano
    # ═══════════════════════════════════════════════════════════
    gaussians, r2, mse, fdp_fitted = ([], None, None, fdp) if len(fdp) <= 4 else \
        _fit_gaussian_components(fdp, n_components=n_components)

    w_sum = round(sum(g["w"] for g in gaussians), 4)
    w_ok  = abs(w_sum - 1.0) < 0.01

    quality = _quality_flags(mse, r2, fdp_fitted)
    quality["weights_sum"]    = w_sum
    quality["weights_sum_ok"] = w_ok

    return {
        "n":                  n,
        "mean":               round(mean, 4),
        "std":                round(std,  4),
        "min":                round(mn,   4),
        "max":                round(mx,   4),
        "q25":                round(q25,  4),
        "q50":                round(q50,  4),
        "q75":                round(q75,  4),
        "mode":               round(mode, 4),
        "completitud_pct":    completitud,
        "completitud_color":  completitud_color,
        "anomalies_count":    anomalies_count,
        "anomaly_values":     anomaly_values[:50],
        "anomaly_threshold":  round(anomaly_threshold, 4),
        "date_start":         str(date_start),
        "date_end":           str(date_end),
        "distribution":       "gaussian",
        "n_components":       n_components,
        "fdp_resolution":     paso,               # resolución visible en frontend
        "fdp":                fdp_fitted,
        "gaussians":          gaussians,
        "betas":              [],
        "r2":                 r2,
        "mse":                mse,
        "quality":            quality,
    }


# ═════════════════════════════════════════════════════════════
# GET /stats/summary-table
# ═════════════════════════════════════════════════════════════

@router.get("/stats/summary-table")
def get_stats_summary_table(
    variable_code: str           = Query(..., description="TEMP o HR"),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    n_components:  int           = Query(2, ge=1, le=8),
    db: Session = Depends(get_db),
):
    import numpy as np

    stations = db.query(Station).order_by(Station.station_code).all()
    vc    = variable_code.strip().upper()
    is_hr = vc == "HR"
    paso  = 1.0 if is_hr else 0.1

    rows_out = []
    for station in stations:
        q = (
            db.query(Measurement)
            .join(Measurement.variable)
            .filter(Measurement.station_id == station.id)
            .filter(func.upper(Variable.code) == vc)
        )
        q = _apply_date_filters(q, date_from, date_to)
        meas = q.order_by(Measurement.measured_at.asc()).all()

        if not meas:
            continue

        values = np.array([float(r.value) for r in meas])
        values = values[~np.isnan(values)]
        if len(values) < 10:
            continue

        n      = len(values)
        mean_v = float(np.mean(values))
        std_v  = float(np.std(values))

        # FDP como fracción simple (igual que en /stats)
        fdp = _build_fdp(values, paso)

        date_start    = meas[0].measured_at
        date_end      = meas[-1].measured_at
        horas_totales = max(int((date_end - date_start).total_seconds() / 3600) + 1, 1)
        completitud   = round(n / horas_totales * 100, 2)

        row = {
            "station_code":      station.station_code,
            "station_name":      station.name,
            "latitude":          float(station.latitude)         if station.latitude         else None,
            "longitude":         float(station.longitude)        if station.longitude        else None,
            "altitude_m":        float(station.altitude_meters)  if station.altitude_meters  else None,
            "date_start":        str(date_start),
            "date_end":          str(date_end),
            "n":                 n,
            "completitud_pct":   completitud,
            "completitud_color": _completitud_color(completitud),
            "mean":              round(mean_v, 4),
            "std":               round(std_v,  4),
            "fdp_resolution":    paso,
        }

        if len(fdp) <= 4:
            row.update({"r2": None, "mse": None, "components": [], "quality": None})
        elif is_hr:
            betas, r2, mse, fdp_fit = _fit_beta_components(fdp, n_components=n_components)
            quality = _quality_flags(mse, r2, fdp_fit)
            w_sum   = round(sum(b["w"] for b in betas), 4)
            quality["weights_sum"]    = w_sum
            quality["weights_sum_ok"] = abs(w_sum - 1.0) < 0.01
            row.update({"r2": r2, "mse": mse, "components": betas,
                        "quality": quality, "distribution": "beta"})
        else:
            gaussians, r2, mse, fdp_fit = _fit_gaussian_components(fdp, n_components=n_components)
            quality = _quality_flags(mse, r2, fdp_fit)
            w_sum   = round(sum(g["w"] for g in gaussians), 4)
            quality["weights_sum"]    = w_sum
            quality["weights_sum_ok"] = abs(w_sum - 1.0) < 0.01
            row.update({"r2": r2, "mse": mse, "components": gaussians,
                        "quality": quality, "distribution": "gaussian"})

        rows_out.append(row)

    return {
        "variable_code": vc,
        "n_components":  n_components,
        "stations":      rows_out,
    }


# ═════════════════════════════════════════════════════════════
# GET /heatmap
# ═════════════════════════════════════════════════════════════

@router.get("/heatmap")
def get_heatmap(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    group_by:      str           = Query("hour", regex="^(hour|week)$"),
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
    df["mes"] = df["measured_at"].dt.month

    if group_by == "week":
        df["eje"] = ((df["measured_at"].dt.day - 1) // 7 + 1)
        eje_label = "semana_mes"
        eje_range = list(range(1, 6))
    else:
        df["eje"] = df["measured_at"].dt.hour
        eje_label = "hora"
        eje_range = list(range(0, 24))

    matrix = (
        df.groupby(["mes", "eje"])["value"]
        .mean().round(2).reset_index()
        .rename(columns={"value": "avg", "eje": eje_label})
        .to_dict(orient="records")
    )

    all_vals = df["value"].dropna()
    return {
        "matrix":    matrix,
        "eje_label": eje_label,
        "eje_range": eje_range,
        "group_by":  group_by,
        "min":       round(float(all_vals.min()), 2),
        "max":       round(float(all_vals.max()), 2),
    }


# ═════════════════════════════════════════════════════════════
# GET /daily-profile
# ═════════════════════════════════════════════════════════════

@router.get("/daily-profile")
def get_daily_profile(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    import numpy as np
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
        raise HTTPException(status_code=404, detail="Sin datos para los filtros indicados")

    is_hr = variable_code.strip().upper() == "HR"
    step  = 1.0 if is_hr else 0.1

    df = pd.DataFrame([
        {"measured_at": r.measured_at, "value": float(r.value)}
        for r in rows
    ])
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    df["mes"]  = df["measured_at"].dt.month
    df["hora"] = df["measured_at"].dt.hour

    def _mode(series):
        vals = series.dropna()
        if len(vals) == 0:
            return None
        bins = np.round(vals.values / step) * step
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    def _profile(subset: pd.DataFrame) -> list[dict]:
        result = []
        for h in range(24):
            grp = subset[subset["hora"] == h]["value"]
            if len(grp) == 0:
                result.append({"hora": h, "avg": None, "min": None,
                                "max": None, "mode": None, "q25": None, "q75": None})
                continue
            result.append({
                "hora": h,
                "avg":  round(float(grp.mean()),         3),
                "min":  round(float(grp.min()),          3),
                "max":  round(float(grp.max()),          3),
                "mode": _mode(grp),
                "q25":  round(float(grp.quantile(0.25)), 3),
                "q75":  round(float(grp.quantile(0.75)), 3),
            })
        return result

    annual  = _profile(df)
    monthly = {str(m): _profile(df[df["mes"] == m]) for m in range(1, 13)}

    return {
        "variable_code": variable_code.strip().upper(),
        "is_hr":         is_hr,
        "annual":        annual,
        "monthly":       monthly,
    }


# ═════════════════════════════════════════════════════════════
# GET /annual-profile
# ═════════════════════════════════════════════════════════════

@router.get("/annual-profile")
def get_annual_profile(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    import numpy as np
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
        raise HTTPException(status_code=404, detail="Sin datos para los filtros indicados")

    is_hr = variable_code.strip().upper() == "HR"
    step  = 1.0 if is_hr else 0.1

    df = pd.DataFrame([
        {"measured_at": r.measured_at, "value": float(r.value)}
        for r in rows
    ])
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    df["doy"]  = df["measured_at"].dt.dayofyear
    df["date"] = df["measured_at"].dt.date

    def _mode_val(arr):
        if len(arr) == 0:
            return None
        bins = np.round(np.array(arr) / step) * step
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    daily_records = []
    for date, grp in df.groupby("date"):
        vals = grp["value"].dropna().values
        if len(vals) == 0:
            continue
        doy     = grp["doy"].iloc[0]
        primary = _mode_val(vals) if is_hr else round(float(np.mean(vals)), 3)
        daily_records.append({
            "doy":     doy,
            "primary": primary,
            "min":     round(float(np.min(vals)), 3),
            "max":     round(float(np.max(vals)), 3),
            "q25":     round(float(np.percentile(vals, 25)), 3),
            "q75":     round(float(np.percentile(vals, 75)), 3),
        })

    daily_df = pd.DataFrame(daily_records)

    result = []
    for doy in range(1, 367):
        subset = daily_df[daily_df["doy"] == doy]
        if len(subset) == 0:
            continue
        result.append({
            "doy":     doy,
            "avg":     round(float(subset["primary"].mean()), 3),
            "min":     round(float(subset["min"].mean()),     3),
            "max":     round(float(subset["max"].mean()),     3),
            "q25":     round(float(subset["q25"].mean()),     3),
            "q75":     round(float(subset["q75"].mean()),     3),
            "n_years": int(len(subset)),
        })

    return {
        "variable_code": variable_code.strip().upper(),
        "is_hr":         is_hr,
        "primary_stat":  "mode" if is_hr else "mean",
        "series":        result,
        "date_start":    str(rows[0].measured_at),
        "date_end":      str(rows[-1].measured_at),
    }


# ═════════════════════════════════════════════════════════════
# GET /combined
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
        HR      = float(r.value)
        p_sat   = 9.066 * np.exp(0.0641 * T) - 1.796 * np.exp(0.0805 * T)
        p_tot   = 1013.25 * (1 - 2.25577e-5 * altitude) ** 5.2559
        hr_frac = HR / 100
        denom   = p_tot - hr_frac * p_sat
        h_abs   = (18000 / 29) * (hr_frac * p_sat) / denom if denom > 0 else None
        ts      = r.measured_at
        joined.append({
            "measured_at": ts,
            "T":    T,
            "HR":   HR,
            "habs": round(h_abs, 4) if h_abs is not None else None,
            "mes":  ts.month,
            "hora": ts.hour,
        })

    if not joined:
        raise HTTPException(status_code=404, detail="Sin datos cruzados T+HR")

    df = pd.DataFrame(joined)
    df["measured_at"] = pd.to_datetime(df["measured_at"])

    # Densidad T×HR con resolución 0.1°C × 1%
    df["T_bin"]  = (df["T"]  / 0.1).round() * 0.1
    df["HR_bin"] = (df["HR"] / 1.0).round() * 1.0
    density_raw = (
        df.groupby(["T_bin", "HR_bin"]).size().reset_index(name="count")
        .rename(columns={"T_bin": "T", "HR_bin": "HR"})
    )
    total_pts = len(df)
    density_raw["pct"] = (density_raw["count"] / total_pts * 100).round(3)

    density_sorted = density_raw.sort_values("count", ascending=False).copy()
    density_sorted["cum_pct"] = density_sorted["count"].cumsum() / total_pts * 100
    density_raw_merged = density_raw.merge(
        density_sorted[["T", "HR", "cum_pct"]], on=["T", "HR"], how="left"
    )

    def _contour_level(cum):
        if cum <= 90:  return "90"
        if cum <= 95:  return "95"
        if cum <= 99:  return "99"
        return "out"

    density_raw_merged["contour"] = density_raw_merged["cum_pct"].apply(_contour_level)
    density = density_raw_merged.to_dict(orient="records")

    humect_mask  = (df["T"] > 10) & (df["HR"] > 79)
    humect_count = int(humect_mask.sum())
    humect_pct   = round(humect_count / total_pts * 100, 2)

    mobility = []
    for mes in range(1, 13):
        sub = df[df["mes"] == mes]
        if len(sub) == 0:
            continue
        for hora in range(24):
            h_sub = sub[sub["hora"] == hora]
            if len(h_sub) == 0:
                continue
            mobility.append({
                "mes":    mes,
                "hora":   hora,
                "T_avg":  round(float(h_sub["T"].mean()),  2),
                "T_max":  round(float(h_sub["T"].max()),   2),
                "HR_avg": round(float(h_sub["HR"].mean()), 2),
                "HR_max": round(float(h_sub["HR"].max()),  2),
            })

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
        df[["T", "HR", "habs", "mes", "hora"]].dropna().head(2000).to_dict(orient="records")
    )

    return {
        "density":      density,
        "humect_pct":   humect_pct,
        "humect_count": humect_count,
        "habs_monthly": habs_series,
        "scatter":      scatter_sample,
        "mobility":     mobility,
        "total_paired": total_pts,
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