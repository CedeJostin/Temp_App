"""
local_analysis.py
=================
Endpoint POST /local-analysis/file

Recibe hasta 3 archivos CSV (temperatura, humedad, viento),
realiza el análisis completo del instructivo de Javier y devuelve
todos los resultados al frontend. NO guarda nada en la BD.

Endpoints:
  POST /local-analysis/file   — analiza un archivo individual
  POST /local-analysis/multi  — analiza los 3 archivos juntos (T+HR+viento)
"""

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query
from typing import Optional
import numpy as np
import pandas as pd

from app.services.file_parser import parse_file

router = APIRouter()


# ══════════════════════════════════════════════════════════════
# HELPERS — estadísticos y modelos
# ══════════════════════════════════════════════════════════════

def _moda(values: np.ndarray, paso: float) -> float:
    bins = np.round(values / paso) * paso
    unique, counts = np.unique(bins, return_counts=True)
    return float(unique[np.argmax(counts)])


def _completitud_color(pct: float) -> str:
    if pct >= 98: return "green"
    if pct >= 95: return "blue"
    if pct >= 90: return "yellow"
    if pct >= 85: return "orange"
    return "red"


def _estadisticos(values: np.ndarray, paso: float) -> dict:
    n    = len(values)
    mean = float(np.mean(values))
    std  = float(np.std(values))
    mn   = float(np.min(values))
    mx   = float(np.max(values))
    q25  = float(np.percentile(values, 25))
    q50  = float(np.percentile(values, 50))
    q75  = float(np.percentile(values, 75))
    mode = _moda(values, paso)

    anomaly_threshold = 3 * std
    anomaly_mask      = np.abs(values - mean) > anomaly_threshold
    anomaly_values    = sorted(set(np.round(values[anomaly_mask], 2).tolist()))[:20]

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
        "anomalies_count":    int(anomaly_mask.sum()),
        "anomaly_threshold":  round(anomaly_threshold, 4),
        "anomaly_values":     anomaly_values,
    }


def _fdp(values: np.ndarray, paso: float) -> list[dict]:
    mn   = float(np.min(values))
    mx   = float(np.max(values))
    bins = np.arange(mn, mx + paso, paso)
    counts, edges = np.histogram(values, bins=bins, density=True)
    centers = ((edges[:-1] + edges[1:]) / 2).round(3)
    return [
        {"x": float(c), "freq": round(float(f) * paso, 6)}
        for c, f in zip(centers, counts)
    ]


def _fit_gaussians(fdp: list[dict], n_components: int = 2):
    from scipy.signal import find_peaks
    from scipy.optimize import minimize

    x_arr  = np.array([d["x"]    for d in fdp])
    y_real = np.array([d["freq"] for d in fdp])

    peaks_idx, _ = find_peaks(y_real, distance=max(1, len(y_real) // (n_components + 1)))
    if len(peaks_idx) == 0:
        peaks_idx = np.argsort(y_real)[-n_components:]
    peaks_idx = sorted(peaks_idx[np.argsort(y_real[peaks_idx])[-n_components:]])

    p0 = []
    for i, idx in enumerate(peaks_idx):
        mu    = float(x_arr[idx])
        sigma = float(abs(x_arr[peaks_idx[i+1]] - mu) / 2.5) if i+1 < len(peaks_idx) else float((x_arr[-1]-x_arr[0])/(4*n_components))
        p0.extend([mu, max(sigma, 0.3), 1.0 / n_components])
    p0 = np.array(p0, dtype=float)

    def gauss_pdf(x, mu, sigma):
        return np.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * np.sqrt(2 * np.pi))

    def model(x, params):
        total = np.zeros_like(x, dtype=float)
        n = len(params) // 3
        for i in range(n):
            mu, sigma, w = params[3*i], params[3*i+1], params[3*i+2]
            total += w * gauss_pdf(x, mu, sigma)
        return total

    def cost(params):
        if np.any(params[1::3] < 0.1) or np.any(params[2::3] < 0.001):
            return 1e9
        return float(np.mean((y_real - model(x_arr, params)) ** 2))

    constraints = [{"type": "eq", "fun": lambda p: np.sum(p[2::3]) - 1.0}]
    x_min, x_max = float(x_arr.min()), float(x_arr.max())
    bounds = [(x_min-5, x_max+5), (0.1, 20.0), (0.001, 1.0)] * n_components

    try:
        result = minimize(cost, p0, method="SLSQP", bounds=bounds,
                          constraints=constraints, options={"maxiter": 2000, "ftol": 1e-12})
        params = result.x
    except Exception:
        params = p0

    gaussians = []
    for i in range(n_components):
        gaussians.append({
            "mu":    round(float(params[3*i]),   4),
            "sigma": round(float(params[3*i+1]), 4),
            "w":     round(float(params[3*i+2]), 4),
        })

    y_model = model(x_arr, params)
    mse     = float(np.mean((y_real - y_model) ** 2))
    y_mean  = float(np.mean(y_real))
    ss_tot  = float(np.sum((y_real - y_mean) ** 2))
    ss_res  = float(np.sum((y_real - y_model) ** 2))
    r2      = round(1 - ss_res / ss_tot, 4) if ss_tot > 0 else None
    weights_sum = float(sum(g["w"] for g in gaussians))

    error_range = float(np.max(np.abs(y_real - y_model)))

    quality = {
        "mse_ok":          mse <= 1e-5,
        "r2_ok":           r2 is not None and r2 > 0.95,
        "error_range_ok":  error_range <= 1e-3,
        "weights_sum_ok":  abs(weights_sum - 1.0) < 0.01,
        "mse_target":      "≤1E-5",
        "r2_target":       ">0.95",
        "error_target":    "±1E-3",
        "weights_sum":     round(weights_sum, 4),
    }

    fdp_out = [
        {**d, "model": round(float(y_model[i]), 6),
               "error_range": round(float(y_real[i] - y_model[i]), 6)}
        for i, d in enumerate(fdp)
    ]

    return gaussians, r2, round(mse, 10), fdp_out, quality


def _fit_beta(fdp: list[dict], n_components: int = 5):
    from scipy.optimize import minimize
    from scipy.stats import beta as beta_dist

    x_arr  = np.array([d["x"]    for d in fdp], dtype=float)
    y_real = np.array([d["freq"] for d in fdp], dtype=float)
    n      = len(x_arr)

    # Suavizado leve para estabilizar las derivadas 1ra y 2da
    if n >= 5:
        kernel   = np.array([1, 2, 3, 2, 1], dtype=float)
        kernel  /= kernel.sum()
        y_smooth = np.convolve(y_real, kernel, mode="same")
    else:
        y_smooth = y_real.copy()

    d2 = np.gradient(np.gradient(y_smooth, x_arr), x_arr)

    # Puntos de cambio de signo de la 2da derivada -> limites A/B de cada pico
    sign       = np.sign(d2)
    change_idx = np.where(np.diff(sign) != 0)[0]
    bound_x    = sorted(set([float(x_arr[0])] + [float(x_arr[i]) for i in change_idx] + [float(x_arr[-1])]))

    # Cada segmento [A, B] entre limites consecutivos es un candidato a curva Beta
    segments = []
    for i in range(len(bound_x) - 1):
        A, B = bound_x[i], bound_x[i + 1]
        mask = (x_arr >= A) & (x_arr <= B)
        if not mask.any():
            continue
        mass     = float(y_real[mask].sum())
        peak_idx = int(np.argmax(y_smooth[mask]))
        moda     = float(x_arr[mask][peak_idx])
        segments.append({"A": A, "B": B, "mass": mass, "moda": moda})

    # Se conservan los n_components segmentos con mayor masa de datos
    segments.sort(key=lambda s: s["mass"], reverse=True)
    segments = segments[:n_components]
    while len(segments) < n_components:
        segments.append({"A": 0.0, "B": 100.0, "mass": 0.001, "moda": 50.0})
    segments.sort(key=lambda s: s["moda"])

    A_arr = np.array([s["A"] for s in segments], dtype=float)
    B_arr = np.array([s["B"] for s in segments], dtype=float)

    def moda_a_params(moda_n, is_last_saturated):
        if is_last_saturated:
            return 4.0, 0.5
        alfa  = max(moda_n * 8 + 1, 1.1)
        beta_ = max((1 - moda_n) * 8 + 1, 1.1)
        return alfa, beta_

    p0 = []
    for i, seg in enumerate(segments):
        A, B   = seg["A"], seg["B"]
        moda_n = (seg["moda"] - A) / (B - A) if B > A else 0.5
        moda_n = min(max(moda_n, 0.01), 0.99)
        is_last_saturated = (i == n_components - 1) and B >= x_arr[-1] - 1e-6
        a, b = moda_a_params(moda_n, is_last_saturated)
        p0.extend([a, b])
    total_mass = sum(s["mass"] for s in segments) or 1.0
    p0.extend([max(s["mass"] / total_mass, 0.01) for s in segments])
    p0 = np.array(p0, dtype=float)

    def beta_sum(x, params):
        result = np.zeros_like(x, dtype=float)
        for i in range(n_components):
            alfa  = max(params[2*i],   1.001)
            beta_ = max(params[2*i+1], 1.001)
            w     = params[2*n_components + i]
            A, B  = A_arr[i], B_arr[i]
            result += w * beta_dist.pdf(x, alfa, beta_, loc=A, scale=B - A)
        return result

    def cost(params):
        return float(np.sqrt(np.mean((y_real - beta_sum(x_arr, params)) ** 2)))

    constraints = [{"type": "eq", "fun": lambda p: 1.0 - sum(p[2*n_components:])}]
    bounds = [(1.001, 50)] * (2*n_components) + [(0.0, 1.0)] * n_components

    try:
        result = minimize(cost, p0, method="SLSQP", bounds=bounds,
                          constraints=constraints, options={"maxiter": 1000, "ftol": 1e-9})
        params = result.x
    except Exception:
        params = p0

    betas = []
    for i in range(n_components):
        alfa  = float(max(params[2*i],   1.001))
        beta_ = float(max(params[2*i+1], 1.001))
        w     = float(params[2*n_components+i])
        A, B  = float(A_arr[i]), float(B_arr[i])
        mode  = A + (alfa - 1) / (alfa + beta_ - 2) * (B - A) if alfa > 1 and beta_ > 1 else A
        var   = alfa * beta_ / ((alfa + beta_)**2 * (alfa + beta_ + 1)) * (B - A)**2
        betas.append({
            "alpha":    round(alfa,  4),
            "beta":     round(beta_, 4),
            "w":        round(w,     4),
            "mode":     round(mode,  2),
            "variance": round(var,   4),
            "A":        round(A, 2),
            "B":        round(B, 2),
        })

    y_model = beta_sum(x_arr, params)
    mse     = float(np.mean((y_real - y_model) ** 2))
    y_mean  = float(np.mean(y_real))
    ss_tot  = float(np.sum((y_real - y_mean) ** 2))
    ss_res  = float(np.sum((y_real - y_model) ** 2))
    r2      = round(1 - ss_res / ss_tot, 4) if ss_tot > 0 else None
    weights_sum = float(sum(b["w"] for b in betas))
    error_range = float(np.max(np.abs(y_real - y_model)))

    quality = {
        "mse_ok":          mse <= 1e-5,
        "r2_ok":           r2 is not None and r2 > 0.95,
        "error_range_ok":  error_range <= 1e-3,
        "weights_sum_ok":  abs(weights_sum - 1.0) < 0.01,
        "mse_target":      "≤1E-5",
        "r2_target":       ">0.95",
        "error_target":    "±1E-3",
        "weights_sum":     round(weights_sum, 4),
    }

    fdp_out = [
        {**d, "model": round(float(y_model[i]), 6),
               "error_range": round(float(y_real[i] - y_model[i]), 6)}
        for i, d in enumerate(fdp)
    ]

    return betas, r2, round(mse, 10), fdp_out, quality


def _fit_weibull(fdp: list[dict], n_components: int = 3):
    import math
    from scipy.signal import find_peaks
    from scipy.optimize import minimize
    from scipy.stats import weibull_min

    x_arr  = np.array([d["x"]    for d in fdp])
    y_real = np.array([d["freq"] for d in fdp])

    mask   = x_arr > 0
    x_use  = x_arr[mask]
    y_use  = y_real[mask]

    if len(x_use) < 4:
        return [], None, None, fdp, {}

    slopes = np.convolve(y_use, np.ones(5)/5, mode='same')
    peaks_idx, _ = find_peaks(slopes, distance=max(1, len(slopes) // (n_components + 1)))
    if len(peaks_idx) < n_components:
        peaks_idx = np.argsort(y_use)[-n_components:]
    peaks_idx = np.sort(peaks_idx[np.argsort(y_use[peaks_idx])[-n_components:]])[:n_components]

    lambdas = [float(x_use[i]) for i in peaks_idx]
    ks      = [2.5] * n_components
    pesos   = [1.0 / n_components] * n_components
    p0      = np.array(lambdas + ks + pesos)

    def wb_sum(x, params):
        result = np.zeros_like(x, dtype=float)
        for i in range(n_components):
            lam = max(params[i],              0.01)
            k   = max(params[n_components+i], 1.01)
            w   = params[2*n_components+i]
            result += w * weibull_min.pdf(x, k, scale=lam)
        return result

    def cost(params):
        return float(np.sqrt(np.mean((y_use - wb_sum(x_use, params)) ** 2)))

    constraints = [{"type": "eq", "fun": lambda p: 1.0 - sum(p[2*n_components:])}]
    bounds = [(0.01, None)] * n_components + [(1.01, None)] * n_components + [(0.01, 1.0)] * n_components

    try:
        result = minimize(cost, p0, method="SLSQP", bounds=bounds,
                          constraints=constraints, options={"maxiter": 2000, "ftol": 1e-9})
        params = result.x
    except Exception:
        params = p0

    weibulls = []
    for i in range(n_components):
        lam  = float(max(params[i],              0.01))
        k    = float(max(params[n_components+i], 1.01))
        w    = float(params[2*n_components+i])
        vmax = lam * ((k - 1) / k) ** (1 / k) if k > 1 else lam
        try:
            sigma_wb = lam * math.sqrt(math.gamma(1+2/k) - math.gamma(1+1/k)**2)
        except Exception:
            sigma_wb = lam
        weibulls.append({
            "lambda": round(lam,          4),
            "k":      round(k,            4),
            "w":      round(w,            4),
            "vmax":   round(float(vmax),  4),
            "sigma":  round(float(sigma_wb), 4),
        })

    y_model_use = wb_sum(x_use, params)
    y_model_all = wb_sum(x_arr, params)
    mse         = float(np.mean((y_use - y_model_use) ** 2))
    y_mean      = float(np.mean(y_use))
    ss_tot      = float(np.sum((y_use - y_mean) ** 2))
    ss_res      = float(np.sum((y_use - y_model_use) ** 2))
    r2          = round(1 - ss_res / ss_tot, 4) if ss_tot > 0 else None
    weights_sum = float(sum(wb["w"] for wb in weibulls))
    error_range = float(np.max(np.abs(y_use - y_model_use)))

    quality = {
        "mse_ok":         mse <= 1e-5,
        "r2_ok":          r2 is not None and r2 > 0.95,
        "error_range_ok": error_range <= 1e-3,
        "weights_sum_ok": abs(weights_sum - 1.0) < 0.01,
        "mse_target":     "≤1E-5",
        "r2_target":      ">0.95",
        "error_target":   "±1E-3",
        "weights_sum":    round(weights_sum, 4),
    }

    fdp_out = [
        {**d, "model": round(float(y_model_all[i]), 6),
               "error_range": round(float(y_real[i] - y_model_all[i]), 6)}
        for i, d in enumerate(fdp)
    ]

    return weibulls, r2, round(mse, 10), fdp_out, quality


def _huecos(df: pd.DataFrame) -> list[dict]:
    huecos = []
    fechas = df["measured_at"].sort_values().reset_index(drop=True)
    for i in range(1, len(fechas)):
        diff = (fechas[i] - fechas[i-1]).total_seconds() / 3600
        if diff > 120:
            huecos.append({
                "inicio": str(fechas[i-1].date()),
                "fin":    str(fechas[i].date()),
                "horas":  int(diff),
            })
    return huecos


def _serie_diaria(df: pd.DataFrame) -> list[dict]:
    df = df.copy()
    df["period"] = df["measured_at"].dt.date
    agg = df.groupby("period")["value"].agg(avg="mean", min="min", max="max").reset_index()
    return [
        {"period": str(r["period"]),
         "avg":    round(float(r["avg"]), 3),
         "min":    round(float(r["min"]), 3),
         "max":    round(float(r["max"]), 3)}
        for _, r in agg.iterrows()
    ]


def _mapa_calor(df: pd.DataFrame, group_by: str = "hour") -> dict:
    df = df.copy()
    df["mes"] = df["measured_at"].dt.month

    if group_by == "week":
        df["eje"] = df["measured_at"].dt.isocalendar().week.astype(int)
        eje_label = "semana"
        eje_range = list(range(1, 54))
    else:
        df["eje"] = df["measured_at"].dt.hour
        eje_label = "hora"
        eje_range = list(range(24))

    matrix = (
        df.groupby(["mes", "eje"])["value"]
        .mean().round(2).reset_index()
        .rename(columns={"value": "avg", "eje": eje_label})
        .to_dict(orient="records")
    )
    vals = df["value"].dropna()
    return {
        "matrix":    matrix,
        "eje_label": eje_label,
        "eje_range": eje_range,
        "min":       round(float(vals.min()), 2),
        "max":       round(float(vals.max()), 2),
    }


def _daily_profile(df: pd.DataFrame, is_hr: bool, paso: float) -> dict:
    df = df.copy()
    df["mes"]  = df["measured_at"].dt.month
    df["hora"] = df["measured_at"].dt.hour

    def _mode(series):
        vals = series.dropna()
        if len(vals) == 0: return None
        bins = np.round(vals.values / paso) * paso
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    def _profile(subset):
        result = []
        for h in range(24):
            grp = subset[subset["hora"] == h]["value"]
            if len(grp) == 0:
                result.append({"hora": h, "avg": None, "min": None, "max": None, "mode": None, "q25": None, "q75": None})
                continue
            result.append({
                "hora": h,
                "avg":  round(float(grp.mean()), 3),
                "min":  round(float(grp.min()),  3),
                "max":  round(float(grp.max()),  3),
                "mode": _mode(grp),
                "q25":  round(float(grp.quantile(0.25)), 3),
                "q75":  round(float(grp.quantile(0.75)), 3),
            })
        return result

    return {
        "annual":  _profile(df),
        "monthly": {str(m): _profile(df[df["mes"] == m]) for m in range(1, 13)},
        "is_hr":   is_hr,
    }


def _annual_profile(df: pd.DataFrame, is_hr: bool, paso: float) -> list[dict]:
    df = df.copy()
    df["doy"]  = df["measured_at"].dt.dayofyear
    df["date"] = df["measured_at"].dt.date

    def _mode_val(arr):
        if len(arr) == 0: return None
        bins = np.round(np.array(arr) / paso) * paso
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    daily = []
    for date, grp in df.groupby("date"):
        vals = grp["value"].dropna().values
        if len(vals) == 0: continue
        primary = _mode_val(vals) if is_hr else round(float(np.mean(vals)), 3)
        daily.append({
            "doy":     int(grp["doy"].iloc[0]),
            "primary": primary,
            "min":     round(float(np.min(vals)), 3),
            "max":     round(float(np.max(vals)), 3),
            "q25":     round(float(np.percentile(vals, 25)), 3),
            "q75":     round(float(np.percentile(vals, 75)), 3),
        })

    daily_df = pd.DataFrame(daily)
    result   = []
    for doy in range(1, 367):
        sub = daily_df[daily_df["doy"] == doy]
        if len(sub) == 0: continue
        result.append({
            "doy":  doy,
            "avg":  round(float(sub["primary"].mean()), 3),
            "min":  round(float(sub["min"].mean()),     3),
            "max":  round(float(sub["max"].mean()),     3),
            "q25":  round(float(sub["q25"].mean()),     3),
            "q75":  round(float(sub["q75"].mean()),     3),
        })
    return result


def _analizar_variable(df: pd.DataFrame, variable: str, n_components: int) -> dict:
    """Corre el análisis completo sobre un DataFrame ya limpio."""
    is_hr   = variable == "humedad"
    is_wind = variable == "viento"
    paso    = 0.1 if variable == "temperatura" else (1.0 if is_hr else 0.1)

    values = df["value"].dropna().values

    # Estadísticos
    stats = _estadisticos(values, paso)
    stats["fecha_inicio"]      = str(df["measured_at"].min().date())
    stats["fecha_fin"]         = str(df["measured_at"].max().date())
    inicio                     = df["measured_at"].min()
    fin                        = df["measured_at"].max()
    horas_esperadas            = max(int((fin - inicio).total_seconds() / 3600) + 1, 1)
    completitud_pct            = round(len(df) / horas_esperadas * 100, 2)
    stats["completitud_pct"]   = completitud_pct
    stats["completitud_color"] = _completitud_color(completitud_pct)
    stats["huecos"]            = _huecos(df)

    # FDP
    fdp_raw = _fdp(values, paso)

    # Ajuste de curvas
    if variable == "temperatura":
        gaussians, r2, mse, fdp_out, quality = _fit_gaussians(fdp_raw, n_components)
        result = {
            "variable":    variable,
            "tipo_curva":  "gaussiana",
            "stats":       stats,
            "fdp":         fdp_out,
            "gaussians":   gaussians,
            "betas":       [],
            "weibulls":    [],
            "r2":          r2,
            "mse":         mse,
            "quality":     quality,
        }
    elif is_hr:
        vals_hr = values[(values >= 0) & (values <= 100)]
        fdp_hr  = _fdp(vals_hr, 1.0)
        betas, r2, mse, fdp_out, quality = _fit_beta(fdp_hr, 5)
        result = {
            "variable":   variable,
            "tipo_curva": "beta",
            "stats":      stats,
            "fdp":        fdp_out,
            "gaussians":  [],
            "betas":      betas,
            "weibulls":   [],
            "r2":         r2,
            "mse":        mse,
            "quality":    quality,
        }
    else:
        weibulls, r2, mse, fdp_out, quality = _fit_weibull(fdp_raw, n_components)
        result = {
            "variable":   variable,
            "tipo_curva": "weibull",
            "stats":      stats,
            "fdp":        fdp_out,
            "gaussians":  [],
            "betas":      [],
            "weibulls":   weibulls,
            "r2":         r2,
            "mse":        mse,
            "quality":    quality,
        }

    # Gráficos temporales
    result["serie"]          = _serie_diaria(df)
    result["heatmap_hour"]   = _mapa_calor(df, "hour")
    result["heatmap_week"]   = _mapa_calor(df, "week")
    result["daily_profile"]  = _daily_profile(df, is_hr, paso)
    result["annual_profile"] = _annual_profile(df, is_hr, paso)

    return result


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
# ENDPOINTS
# ══════════════════════════════════════════════════════════════

@router.post("/file")
async def analizar_archivo_local(
    variable:     str       = Form(..., description="temperatura | humedad | viento"),
    n_components: int       = Form(2,   description="Número de componentes para el ajuste"),
    archivo:      UploadFile = File(...),
):
    """
    Analiza un archivo CSV/Excel individual.
    Devuelve estadísticos, FDP con ajuste, serie temporal,
    mapa de calor, perfil diario y perfil anual.
    NO guarda nada en la BD.
    """
    contenido = await archivo.read()
    try:
        df = _df_from_file(contenido, archivo.filename)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    try:
        result = _analizar_variable(df, variable, n_components)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en el análisis: {str(e)}")

    return result


@router.post("/multi")
async def analizar_multi_local(
    n_components:  int                    = Form(2),
    temperatura:   Optional[UploadFile]   = File(None),
    humedad:       Optional[UploadFile]   = File(None),
    viento:        Optional[UploadFile]   = File(None),
):
    """
    Analiza hasta 3 archivos CSV/Excel (T, HR, viento) en una sola llamada.
    También calcula el análisis combinado T×HR si ambos están presentes.
    NO guarda nada en la BD.
    """
    archivos = {
        "temperatura": temperatura,
        "humedad":     humedad,
        "viento":      viento,
    }

    resultados = {}
    dfs        = {}

    for variable, archivo in archivos.items():
        if archivo is None:
            continue
        contenido = await archivo.read()
        try:
            df = _df_from_file(contenido, archivo.filename)
            dfs[variable] = df
            resultados[variable] = _analizar_variable(df, variable, n_components)
        except Exception as e:
            resultados[variable] = {"error": str(e)}

    # Análisis combinado T×HR si ambos presentes
    combined = None
    if "temperatura" in dfs and "humedad" in dfs:
        try:
            combined = _analizar_combinado(dfs["temperatura"], dfs["humedad"], altitude=0)
        except Exception as e:
            combined = {"error": str(e)}

    return {"resultados": resultados, "combined": combined}


def _analizar_combinado(df_t: pd.DataFrame, df_h: pd.DataFrame, altitude: float = 0) -> dict:
    """
    Análisis combinado T×HR. Replica EXACTAMENTE la lógica y las fórmulas del
    endpoint GET /combined de charts.py (usado por Analysis.jsx), para que los
    gráficos generados desde archivo sean idénticos a los de la base de datos.

    Variables psicrométricas (Velázquez Martí, UPV) — coherentes con Carrier,
    presiones en pascales (Pa):
      P_sat:  log10(P_sat) = (10.2858·T_K − 2148.49)/(T_K − 35.85)
      P_tot:  101325·(1 − 2.25577e-5·z)^5.2559
      ω:      0.622·P_vap/(P_tot − P_vap)           [kg vapor/kg aire seco]
      T_roc:  (35.85·log10(P_v) − 2148.49)/(log10(P_v) − 10.2858) − 273.15
      h:      1.005·T + ω·(2503 + 1.86·T)           [kJ/kg aire seco]
    """
    import math

    def _p_sat_pa(t_c):
        t_k = t_c + 273.15
        return 10.0 ** ((10.2858 * t_k - 2148.49) / (t_k - 35.85))

    def _humidity_ratio(t_c, hr_pct, p_total):
        """ω en kg vapor/kg aire seco. None si no es físico."""
        p_vap = (hr_pct / 100.0) * _p_sat_pa(t_c)
        denom = p_total - p_vap
        if denom <= 0:
            return None
        return 0.622 * p_vap / denom

    def _dew_point_c(p_vap_pa):
        if p_vap_pa is None or p_vap_pa <= 0:
            return None
        log_pv = math.log10(p_vap_pa)
        denom = log_pv - 10.2858
        if denom == 0:
            return None
        return (35.85 * log_pv - 2148.49) / denom - 273.15

    def _iso_rh_curves(t_min, t_max, p_total, rh_levels, n=80):
        """Curvas de HR constante: ω(T) sobre [t_min, t_max] para cada HR."""
        curves = []
        span = max(t_max - t_min, 1e-6)
        for rh in rh_levels:
            pts = []
            for i in range(n + 1):
                t = t_min + span * i / n
                w = _humidity_ratio(t, rh, p_total)
                if w is None:
                    continue
                pts.append({"T": round(t, 2), "habs": round(1000.0 * w, 4)})
            if pts:
                curves.append({"rh": rh, "points": pts})
        return curves

    p_tot = 101325.0 * (1 - 2.25577e-5 * altitude) ** 5.2559

    t_map  = {str(r["measured_at"]): float(r["value"]) for _, r in df_t.iterrows()}
    joined = []

    for _, row in df_h.iterrows():
        T = t_map.get(str(row["measured_at"]))
        if T is None:
            continue
        HR    = float(row["value"])
        p_vap = (HR / 100.0) * _p_sat_pa(T)
        w     = _humidity_ratio(T, HR, p_tot)
        h_abs = None if w is None else 1000.0 * w                 # g/kg aire seco
        tr    = _dew_point_c(p_vap)                               # °C
        h_ent = None if w is None else 1.005 * T + w * (2503 + 1.86 * T)  # kJ/kg as
        ts    = row["measured_at"]
        joined.append({
            "measured_at": ts, "T": T, "HR": HR,
            "habs": round(h_abs, 4) if h_abs is not None else None,
            "tr":   round(tr, 2)    if tr    is not None else None,
            "h":    round(h_ent, 2) if h_ent is not None else None,
            "mes":  ts.month, "hora": ts.hour,
        })

    if not joined:
        raise ValueError("Sin datos cruzados T+HR en el período")

    df = pd.DataFrame(joined)
    df["measured_at"] = pd.to_datetime(df["measured_at"])

    # Densidad T×HR (binning 0.1°C / 1%) con contornos 90/95/99%
    df["T_bin"]  = (df["T"]  / 0.1).round() * 0.1
    df["HR_bin"] = (df["HR"] / 1.0).round() * 1.0
    density_raw  = (
        df.groupby(["T_bin", "HR_bin"]).size().reset_index(name="count")
        .rename(columns={"T_bin": "T", "HR_bin": "HR"})
    )
    total_pts = len(df)
    density_raw["pct"] = (density_raw["count"] / total_pts * 100).round(3)
    density_sorted = density_raw.sort_values("count", ascending=False).copy()
    density_sorted["cum_pct"] = density_sorted["count"].cumsum() / total_pts * 100
    density_raw = density_raw.merge(density_sorted[["T", "HR", "cum_pct"]], on=["T", "HR"], how="left")

    def _contour(cum):
        if cum <= 90: return "90"
        if cum <= 95: return "95"
        if cum <= 99: return "99"
        return "out"

    density_raw["contour"] = density_raw["cum_pct"].apply(_contour)
    density = density_raw.to_dict(orient="records")

    humect_mask  = (df["T"] > 10) & (df["HR"] > 79)
    humect_count = int(humect_mask.sum())
    humect_pct   = round(humect_count / total_pts * 100, 2)

    # Movilidad mes × hora
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
                "mes": mes, "hora": hora,
                "T_avg":  round(float(h_sub["T"].mean()),  2),
                "T_max":  round(float(h_sub["T"].max()),   2),
                "HR_avg": round(float(h_sub["HR"].mean()), 2),
                "HR_max": round(float(h_sub["HR"].max()),  2),
            })

    # H_abs mensual
    df_habs = df.dropna(subset=["habs"]).copy()
    df_habs["period"] = df_habs["measured_at"].dt.to_period("M").dt.to_timestamp()
    habs_monthly = (
        df_habs.groupby("period")["habs"].mean().round(4).reset_index().rename(columns={"habs": "avg"})
    )
    habs_series  = [
        {"period": str(row["period"].date())[:7] + "-01", "avg": float(row["avg"])}
        for _, row in habs_monthly.iterrows()
    ]

    scatter_cols = [c for c in ["T", "HR", "habs", "tr", "h", "mes", "hora"] if c in df.columns]
    scatter_sample = (
        df[scatter_cols].dropna(subset=["T", "HR", "habs"]).head(2000).to_dict(orient="records")
    )

    # Curvas de HR constante para el diagrama psicrométrico (Carrier)
    t_lo = math.floor(float(df["T"].min())) - 1
    t_hi = math.ceil(float(df["T"].max())) + 1
    iso_rh       = _iso_rh_curves(t_lo, t_hi, p_tot, rh_levels=[10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    humect_curve = _iso_rh_curves(t_lo, t_hi, p_tot, rh_levels=[79])

    return {
        "density":      density,
        "humect_pct":   humect_pct,
        "humect_count": humect_count,
        "habs_monthly": habs_series,
        "scatter":      scatter_sample,
        "mobility":     mobility,
        "total_paired": total_pts,
        "iso_rh":       iso_rh,
        "humect_curve": humect_curve,
        "p_tot_pa":     round(p_tot, 1),
        "altitude":     altitude,
    }