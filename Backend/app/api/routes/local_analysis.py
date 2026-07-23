"""
local_analysis.py
=================
Análisis local de archivos CSV/Excel SIN guardar nada en la base de datos.

POST /local-analysis/file — analiza un archivo individual (temperatura,
humedad o viento) y devuelve las mismas estructuras que consumen las
secciones de la pantalla de Análisis, calculadas con la MISMA matemática
que el flujo de carga de datos:

  a)   Visualización general → estadísticos + serie diaria
       (misma lógica que analytics_service._calc_distribution)
  b)   FDP                   → app.services.distribution_fitting
       (gaussianas para T, betas generalizadas para HR, Weibull para viento)
  c.2) Perfil diario         → misma lógica que GET /measurements/daily-profile
  c.3) Perfil anual          → misma lógica que GET /measurements/annual-profile
  e)   Viento                → rosa general, rosa por viento y dirección×año/hora
       (misma lógica que /wind-rose y /wind-directional; el archivo IMN trae
       velocidad + dirección y se cruza con parse_wind_imn)
"""

from collections import defaultdict

import numpy as np
import pandas as pd
from fastapi import APIRouter, UploadFile, File, Form, HTTPException

from app.api.routes._shared import _completitud_color
from app.services.file_parser import parse_file, parse_wind_imn
from app.services.distribution_fitting import (
    _build_fdp,
    _fit_gaussian_components,
    _fit_beta_components,
    _fit_weibull_components,
    _quality_flags,
)

router = APIRouter()

DIR16_LABELS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"]


# ══════════════════════════════════════════════════════════════
# PARSEO
# ══════════════════════════════════════════════════════════════

def _df_from_file(contenido: bytes, filename: str) -> pd.DataFrame:
    df_raw, vtype, logs = parse_file(contenido, filename)
    if df_raw.empty:
        raise ValueError(f"No se pudo parsear '{filename}'. Logs: {logs}")
    df = df_raw.copy()
    df = df[df["value"] >= 0].copy()
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    df = df.sort_values("measured_at").reset_index(drop=True)
    if df.empty:
        raise ValueError(f"Sin valores válidos en '{filename}'")
    return df


# ══════════════════════════════════════════════════════════════
# a) VISUALIZACIÓN GENERAL — estadísticos y serie diaria
# ══════════════════════════════════════════════════════════════

def _estadisticos(df: pd.DataFrame, paso: float) -> dict:
    """Mismos estadísticos que analytics_service._calc_distribution."""
    values = df["value"].values

    n    = len(values)
    mean = float(np.mean(values))
    std  = float(np.std(values))
    mn   = float(np.min(values))
    mx   = float(np.max(values))
    q25  = float(np.percentile(values, 25))
    q50  = float(np.percentile(values, 50))
    q75  = float(np.percentile(values, 75))

    bins_mode = np.round(values / paso) * paso
    unique, counts = np.unique(bins_mode, return_counts=True)
    mode = float(unique[np.argmax(counts)])

    anomaly_threshold = 3 * std
    anom = values[np.abs(values - mean) > anomaly_threshold]
    anomaly_values = [round(float(v), 4) for v in anom[:50]]

    date_start = df["measured_at"].min()
    date_end   = df["measured_at"].max()
    horas_totales = max(int((date_end - date_start).total_seconds() / 3600) + 1, 1)
    completitud = round(n / horas_totales * 100, 2)

    return {
        "n":                 n,
        "mean":              round(mean, 4),
        "std":               round(std,  4),
        "min":               round(mn,   4),
        "max":               round(mx,   4),
        "q25":               round(q25,  4),
        "q50":               round(q50,  4),
        "q75":               round(q75,  4),
        "mode":              round(mode, 4),
        "anomalies_count":   int(len(anom)),
        "anomaly_values":    anomaly_values,
        "anomaly_threshold": round(anomaly_threshold, 4),
        "date_start":        str(date_start),
        "date_end":          str(date_end),
        "completitud_pct":   completitud,
        "completitud_color": _completitud_color(completitud),
    }


def _serie_diaria(df: pd.DataFrame) -> list[dict]:
    d = df.copy()
    d["period"] = d["measured_at"].dt.date
    agg = d.groupby("period")["value"].agg(avg="mean", min="min", max="max").reset_index()
    return [
        {"period": str(r["period"]),
         "avg":    round(float(r["avg"]), 3),
         "min":    round(float(r["min"]), 3),
         "max":    round(float(r["max"]), 3)}
        for _, r in agg.iterrows()
    ]


# ══════════════════════════════════════════════════════════════
# c.2) PERFIL DIARIO — misma lógica que GET /measurements/daily-profile
# ══════════════════════════════════════════════════════════════

def _daily_profile(df: pd.DataFrame, is_hr: bool) -> dict:
    step = 1.0 if is_hr else 0.1

    def _mode_val(arr: np.ndarray) -> float | None:
        if len(arr) == 0:
            return None
        bins = np.round(arr / step) * step
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    def _stats(vals: list) -> dict:
        if not vals:
            return {
                "avg": None, "min": None, "max": None,
                "mode": None, "q25": None, "q75": None,
            }
        a = np.array(vals, dtype=float)
        return {
            "avg":  round(float(np.mean(a)),           3),
            "min":  round(float(np.min(a)),            3),
            "max":  round(float(np.max(a)),            3),
            "mode": _mode_val(a),
            "q25":  round(float(np.percentile(a, 25)), 3),
            "q75":  round(float(np.percentile(a, 75)), 3),
        }

    by_month_hour: dict[tuple, list] = defaultdict(list)
    by_hour:       dict[int,   list] = defaultdict(list)

    hours  = df["measured_at"].dt.hour.values
    months = df["measured_at"].dt.month.values
    vals   = df["value"].values
    for h, m, v in zip(hours, months, vals):
        by_month_hour[(int(m), int(h))].append(float(v))
        by_hour[int(h)].append(float(v))

    annual = [{"hora": h, **_stats(by_hour[h])} for h in range(24)]
    monthly: dict[str, list] = {}
    for m in range(1, 13):
        monthly[str(m)] = [
            {"hora": h, **_stats(by_month_hour.get((m, h), []))}
            for h in range(24)
        ]

    return {"is_hr": is_hr, "annual": annual, "monthly": monthly}


# ══════════════════════════════════════════════════════════════
# c.3) PERFIL ANUAL — misma lógica que GET /measurements/annual-profile
# ══════════════════════════════════════════════════════════════

def _annual_profile(df: pd.DataFrame, is_hr: bool) -> dict:
    step = 1.0 if is_hr else 0.1

    d = df.copy()
    d["doy"]  = d["measured_at"].dt.dayofyear
    d["date"] = d["measured_at"].dt.date

    def _mode_val(arr) -> float | None:
        if len(arr) == 0:
            return None
        bins = np.round(np.array(arr) / step) * step
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    daily_records = []
    for _, grp in d.groupby("date"):
        vals = grp["value"].dropna().values
        if len(vals) == 0:
            continue
        primary = _mode_val(vals) if is_hr else round(float(np.mean(vals)), 3)
        daily_records.append({
            "doy":     int(grp["doy"].iloc[0]),
            "primary": primary,
            "min":     round(float(np.min(vals)), 3),
            "max":     round(float(np.max(vals)), 3),
            "q25":     round(float(np.percentile(vals, 25)), 3),
            "q75":     round(float(np.percentile(vals, 75)), 3),
        })

    daily_df = pd.DataFrame(daily_records)

    series = []
    for doy in range(1, 367):
        subset = daily_df[daily_df["doy"] == doy]
        if len(subset) == 0:
            continue
        series.append({
            "doy":     doy,
            "avg":     round(float(subset["primary"].mean()), 3),
            "min":     round(float(subset["min"].mean()),     3),
            "max":     round(float(subset["max"].mean()),     3),
            "q25":     round(float(subset["q25"].mean()),     3),
            "q75":     round(float(subset["q75"].mean()),     3),
            "n_years": int(len(subset)),
        })

    return {
        "is_hr":        is_hr,
        "primary_stat": "mode" if is_hr else "mean",
        "series":       series,
        "date_start":   str(df["measured_at"].min()),
        "date_end":     str(df["measured_at"].max()),
    }


# ══════════════════════════════════════════════════════════════
# e) VIENTO — rosa de vientos y análisis direccional
# Misma lógica que GET /measurements/wind-rose y /wind-directional
# (charts.py), pero sobre el DataFrame del archivo en vez de la BD.
# ══════════════════════════════════════════════════════════════

def _wind_rose(m: pd.DataFrame, comps: list[dict]) -> dict:
    """m: DataFrame [measured_at, speed, direction]. comps: weibulls del ajuste."""
    n = len(m)
    m = m.copy()
    m["sector"] = (np.round(m["direction"] / 22.5).astype(int) % 16)

    speed_edges  = [0, 2, 4, 6, 8, 10, np.inf]
    speed_labels = ["0–2", "2–4", "4–6", "6–8", "8–10", "10+"]
    m["sbin"] = pd.cut(m["speed"], bins=speed_edges, labels=speed_labels,
                       right=False, include_lowest=True)

    general = []
    for s in range(16):
        sub = m[m["sector"] == s]
        general.append({
            "sector":     s,
            "label":      DIR16_LABELS[s],
            "dir_deg":    round(s * 22.5, 1),
            "total":      int(len(sub)),
            "pct":        round(len(sub) / n * 100, 2) if n else 0.0,
            "mean_speed": round(float(sub["speed"].mean()), 2) if len(sub) else 0.0,
            "bins":       [int((sub["sbin"] == lb).sum()) for lb in speed_labels],
        })

    # Bandas compartidas de 1 m/s para las rosas por viento (Fig. 7 del
    # artículo): una sola leyenda de velocidades para todas las rosas.
    by_wind = []
    wb_edges: list[int] = []
    wind_speed_bins: list[str] = []
    if comps:
        hi  = max(float(c.get("vmax") or 0) + float(c.get("sigma") or 0) for c in comps)
        top = max(int(np.ceil(hi)), 1)
        wb_edges        = list(range(0, top + 1))
        wind_speed_bins = [f"{a}–{a + 1}" for a in wb_edges[:-1]]

    for k, c in enumerate(comps):
        vmax = c.get("vmax")
        sig  = c.get("sigma") or 0.0
        if vmax is None:
            continue
        sub = m[(m["speed"] >= vmax - sig) & (m["speed"] <= vmax + sig)]
        nn  = len(sub)
        sectors_out = []
        for s in range(16):
            sec_speeds = sub.loc[sub["sector"] == s, "speed"]
            cnt = int(len(sec_speeds))
            bins_counts, _ = np.histogram(sec_speeds, bins=wb_edges) if len(wb_edges) >= 2 else (np.array([]), None)
            sectors_out.append({
                "sector":  s,
                "label":   DIR16_LABELS[s],
                "dir_deg": round(s * 22.5, 1),
                "count":   cnt,
                "pct":     round(cnt / nn * 100, 2) if nn else 0.0,
                "bins":    [int(x) for x in bins_counts],
            })
        by_wind.append({
            "comp":    k + 1,
            "vmax":    vmax,
            "sigma":   c.get("sigma"),
            "w":       c.get("w"),
            "n":       int(nn),
            "sectors": sectors_out,
        })

    return {
        "n":               n,
        "speed_bins":      speed_labels,
        "wind_speed_bins": wind_speed_bins,
        "general":         general,
        "by_wind":         by_wind,
    }


def _wind_directional(m: pd.DataFrame, comps: list[dict], max_points: int = 4000) -> dict:
    """Para cada viento (vmax ± σ): registros con día del año, hora y dirección."""
    m = m.copy()
    m["doy"]   = m["measured_at"].dt.dayofyear
    m["hour"]  = m["measured_at"].dt.hour
    m["month"] = m["measured_at"].dt.month

    out = []
    for k, c in enumerate(comps):
        vmax = c.get("vmax")
        sig  = c.get("sigma") or 0.0
        if vmax is None:
            continue
        sub = m[(m["speed"] >= vmax - sig) & (m["speed"] <= vmax + sig)]
        n_total = int(len(sub))
        if n_total > max_points:
            sub = sub.sample(max_points, random_state=0)
        out.append({
            "comp":    k + 1,
            "vmax":    vmax,
            "sigma":   c.get("sigma"),
            "w":       c.get("w"),
            "n_total": n_total,
            "points": [
                {"doy": int(r.doy), "hour": int(r.hour),
                 "dir": round(float(r.direction), 1), "month": int(r.month)}
                for r in sub.itertuples()
            ],
        })

    return {"components": out}


# ══════════════════════════════════════════════════════════════
# ANÁLISIS COMPLETO DE UNA VARIABLE
# ══════════════════════════════════════════════════════════════

def _analizar_variable(df: pd.DataFrame, variable: str, n_components: int) -> dict:
    is_hr   = variable == "humedad"
    is_wind = variable == "viento"
    paso    = 1.0 if is_hr else 0.1

    values = df["value"].dropna().values
    stats  = _estadisticos(df, paso)

    # ── b) FDP: misma matemática que la carga de datos ────────
    # El viento excluye las calmas (v=0) del ajuste y usa bins alineados
    # a la rejilla de 0.1 m/s (analytics_service._calc_distribution).
    fit_values = values[values > 0] if is_wind else values
    fdp = _build_fdp(fit_values, paso, align_grid=is_wind)
    if len(fdp) <= 4:
        raise ValueError("Muy pocos bins para ajustar la FDP")

    if is_wind:
        components, r2, mse, fdp_fitted = _fit_weibull_components(fdp, n_components=3)
        dist_type = "weibull"
    elif is_hr:
        components, r2, mse, fdp_fitted = _fit_beta_components(
            fdp, n_components=5, free_support=True, censor_sat=True,
        )
        dist_type = "beta"
    else:
        components, r2, mse, fdp_fitted = _fit_gaussian_components(fdp, n_components=n_components)
        dist_type = "gaussian"

    quality = _quality_flags(mse, r2, fdp_fitted, error_target=(2e-3 if is_wind else 1e-3))
    w_sum   = round(sum(c.get("w", 0) for c in components), 4)
    quality["weights_sum"]    = w_sum
    quality["weights_sum_ok"] = abs(w_sum - 1.0) < 0.01

    result = {
        "variable":       variable,
        "distribution":   dist_type,
        "n_components":   len(components),
        "fdp_resolution": paso,
        "stats":          stats,
        "fdp":            fdp_fitted,
        "gaussians":      components if dist_type == "gaussian" else [],
        "betas":          components if dist_type == "beta"     else [],
        "weibulls":       components if dist_type == "weibull"  else [],
        "r2":             r2,
        "mse":            mse,
        "quality":        quality,
        "serie":          _serie_diaria(df),
    }

    # ── c.2 / c.3) Perfiles: solo T y HR ──────────────────────
    if variable in ("temperatura", "humedad"):
        result["daily_profile"]  = _daily_profile(df, is_hr)
        result["annual_profile"] = _annual_profile(df, is_hr)

    return result


# ══════════════════════════════════════════════════════════════
# ENDPOINT
# ══════════════════════════════════════════════════════════════

@router.post("/file")
async def analizar_archivo_local(
    variable:     str        = Form(..., description="temperatura | humedad | viento"),
    n_components: int        = Form(2,   description="Gaussianas para T (HR usa 5 betas y viento 3 Weibull, fijos como en la carga de datos)"),
    archivo:      UploadFile = File(...),
):
    """
    Analiza un archivo CSV/Excel individual con la misma matemática que el
    flujo de carga + pantalla de Análisis. Devuelve visualización general,
    FDP, perfiles diario/anual (T y HR) y rosa/dirección de viento.
    NO guarda nada en la BD.
    """
    contenido  = await archivo.read()
    wind_pairs = None

    try:
        if variable == "viento":
            # El archivo IMN de viento trae DOS series (velocidad + dirección);
            # se intenta primero, igual que en uploads.py.
            wind_df, _wind_logs = parse_wind_imn(contenido, archivo.filename)
            if not wind_df.empty:
                df = (wind_df[["measured_at", "velocidad"]]
                      .rename(columns={"velocidad": "value"})
                      .dropna(subset=["value"])
                      .sort_values("measured_at").reset_index(drop=True))
                df["measured_at"] = pd.to_datetime(df["measured_at"])
                if df.empty:
                    raise ValueError(f"Sin velocidades válidas en '{archivo.filename}'")

                pairs = wind_df.dropna(subset=["velocidad", "direccion"])
                if not pairs.empty:
                    wind_pairs = (pairs[["measured_at", "velocidad", "direccion"]]
                                  .rename(columns={"velocidad": "speed", "direccion": "direction"})
                                  .reset_index(drop=True))
                    wind_pairs["measured_at"] = pd.to_datetime(wind_pairs["measured_at"])
            else:
                # Fallback: archivo de una sola serie (solo velocidad, sin rosa)
                df = _df_from_file(contenido, archivo.filename)
        else:
            df = _df_from_file(contenido, archivo.filename)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    try:
        result = _analizar_variable(df, variable, n_components)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en el análisis: {str(e)}")

    if variable == "viento":
        if wind_pairs is not None and len(wind_pairs):
            comps = result["weibulls"]
            try:
                result["wind"] = {
                    "rose":        _wind_rose(wind_pairs, comps),
                    "directional": _wind_directional(wind_pairs, comps),
                }
            except Exception as e:
                result["wind"] = None
                result["wind_error"] = f"Error en el análisis direccional: {e}"
        else:
            result["wind"] = None

    return result
