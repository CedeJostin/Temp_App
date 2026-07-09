"""
charts.py
=========
Endpoints de análisis y visualización (gráficas) sobre las mediciones.

  GET  /stats                 Estadísticos + FDP + Gaussianas (T) o Beta (HR)
  POST /stats/recalculate     Recalcula el ajuste desde las mediciones guardadas
  GET  /stats/summary-table   Tabla exportable de ajustes por estación (b.1)
  GET  /heatmap               Matriz mes × hora / mes × semana (stat=avg|mode)
  GET  /daily-peaks           Hora y valor del máximo diario (+ por gaussiana)
  GET  /daily-profile         Perfil diario promedio por mes (c.2)
  GET  /annual-profile        Perfil anual promedio (c.3)
  GET  /combined              Densidad T×HR, humedad absoluta, humectación

La matemática de ajuste vive en app.services.distribution_fitting.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.measurement import Measurement
from app.models.station import Station
from app.models.variable import Variable

from app.api.routes._shared import _apply_date_filters, _completitud_color
from app.services.distribution_fitting import (
    _build_fdp,
    _fit_gaussian_components,
    _fit_beta_components,
    _quality_flags,
)

router = APIRouter()


@router.get("/stats")
def get_stats(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    n_components:  int           = Query(2, ge=1, le=8),
    db: Session = Depends(get_db),
):
    import json
    from app.models.distribution_analysis import DistributionAnalysis

    vc      = variable_code.strip().upper()
    is_hr   = vc == "HR"
    is_wind = vc == "VIENTO"

    variable = db.query(Variable).filter(
        func.upper(Variable.code) == vc
    ).first()

    if not variable:
        raise HTTPException(status_code=404, detail=f"Variable '{vc}' no encontrada")

    dist_type   = "weibull" if is_wind else ("beta" if is_hr else "gaussian")
    dist_record = (
        db.query(DistributionAnalysis)
        .filter(
            DistributionAnalysis.station_id        == station_id,
            DistributionAnalysis.variable_id       == str(variable.id),
            DistributionAnalysis.distribution_type == dist_type,
        )
        .order_by(DistributionAnalysis.calculated_at.desc())
        .first()
    )

    if (dist_record
            and dist_record.components_json
            and dist_record.fdp_json
            and dist_record.n_records is not None):

        components = json.loads(dist_record.components_json)
        fdp_fitted = json.loads(dist_record.fdp_json)
        anomalies  = json.loads(dist_record.anomalies_json or "[]")
        r2         = dist_record.r2
        mse        = dist_record.mse
        quality    = _quality_flags(mse, r2, fdp_fitted, error_target=(2e-3 if is_wind else 1e-3))
        w_sum      = round(sum(c.get("w", 0) for c in components), 4)
        quality["weights_sum"]    = w_sum
        quality["weights_sum_ok"] = abs(w_sum - 1.0) < 0.01

        gaussians = components if dist_type == "gaussian" else []
        betas     = components if dist_type == "beta"     else []
        weibulls  = components if dist_type == "weibull"  else []

        return {
            "n":                  int(dist_record.n_records),
            "mean":               dist_record.mean_val,
            "std":                dist_record.std_val,
            "min":                dist_record.min_val,
            "max":                dist_record.max_val,
            "q25":                dist_record.q25_val,
            "q50":                dist_record.q50_val,
            "q75":                dist_record.q75_val,
            "mode":               dist_record.mode_val,
            "completitud_pct":    dist_record.completitud_pct,
            "completitud_color":  _completitud_color(dist_record.completitud_pct or 0),
            "anomalies_count":    len(anomalies),
            "anomaly_values":     anomalies,
            "anomaly_threshold":  dist_record.anomaly_threshold,
            "date_start":         str(dist_record.date_start),
            "date_end":           str(dist_record.date_end),
            "distribution":       dist_type,
            "n_components":       len(components),
            "fdp_resolution":     1.0 if is_hr else 0.1,
            "fdp":                fdp_fitted,
            "gaussians":          gaussians,
            "betas":              betas,
            "weibulls":           weibulls,
            "r2":                 r2,
            "mse":                mse,
            "quality":            quality,
            "source":             "precalculado",
        }

    raise HTTPException(
        status_code=404,
        detail="Sin datos precalculados. Sube un archivo CSV primero."
    )


@router.post("/stats/recalculate")
def recalculate_stats(
    station_id:    str           = Query(..., description="UUID de la estación"),
    variable_code: Optional[str] = Query(None, description="TEMP o HR. Si se omite, recalcula ambas."),
    db: Session = Depends(get_db),
):
    import pandas as pd
    from app.services.analytics_service import _calc_distribution

    # Variables a recalcular
    if variable_code:
        codes = [variable_code.strip().upper()]
    else:
        codes = ["TEMP", "HR", "VIENTO"]

    resultados = []
    for vc in codes:
        variable = db.query(Variable).filter(func.upper(Variable.code) == vc).first()
        if not variable:
            resultados.append({"variable": vc, "ok": False, "msg": f"Variable '{vc}' no encontrada"})
            continue

        rows = (
            db.query(Measurement)
            .filter(Measurement.station_id  == station_id)
            .filter(Measurement.variable_id == str(variable.id))
            .order_by(Measurement.measured_at.asc())
            .all()
        )
        if not rows:
            resultados.append({"variable": vc, "ok": False, "msg": "Sin mediciones para esta estación"})
            continue

        df = pd.DataFrame([
            {"measured_at": r.measured_at, "value": float(r.value)}
            for r in rows
        ])
        df["measured_at"] = pd.to_datetime(df["measured_at"])

        try:
            logs = _calc_distribution(db, df, station_id, str(variable.id), vc)
            resultados.append({"variable": vc, "ok": True, "n": len(df), "msg": "; ".join(logs)})
        except Exception as e:
            db.rollback()
            resultados.append({"variable": vc, "ok": False, "msg": f"Error: {e}"})

    return {
        "station_id": station_id,
        "recalculado": resultados,
    }


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
            # free_support: libera el "entorno" [A,B] de cada beta (paso 1 del
            # feedback). censor_sat: censura tipo XBX (JRSS-C 2026) para el
            # spike de saturación en HR=100. Verificado sobre la HR real de
            # Belén: err_acum −30 %, R² 0.989→0.995, área modelo 1.000 y el
            # bin de 100 % clavado (resid 1.4e-4); elimina el bache en ~82-85.
            betas, r2, mse, fdp_fit = _fit_beta_components(
                fdp, n_components=n_components,
                free_support=True, censor_sat=True,
            )
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


@router.get("/heatmap")
def get_heatmap(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    group_by:      str           = Query("hour", pattern="^(hour|week)$"),
    stat:          str           = Query("avg", pattern="^(avg|mode)$"),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    from app.models.heatmap_stats import HeatmapStats
    from app.models.variable import Variable

    vc = variable_code.strip().upper()

    variable = db.query(Variable).filter(
        func.upper(Variable.code) == vc
    ).first()

    if not variable:
        raise HTTPException(status_code=404, detail=f"Variable '{vc}' no encontrada")

    if stat == "mode":
        # Moda por celda (RF-10): la media aplana la HR; se binea el valor a la
        # resolución de la FDP (1 % HR, 0.1 °C TEMP) y se toma el más frecuente.
        # Se calcula siempre desde las mediciones crudas (el precalculado solo
        # guarda promedios).
        import pandas as pd

        q = (
            db.query(Measurement)
            .join(Measurement.variable)
            .filter(Measurement.station_id == station_id)
            .filter(func.upper(Variable.code) == vc)
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

        if group_by == "hour":
            df["eje"] = df["measured_at"].dt.hour
            eje_label, eje_range = "hora", list(range(0, 24))
        else:
            df["eje"] = ((df["measured_at"].dt.day - 1) // 7 + 1)
            eje_label, eje_range = "semana_mes", list(range(1, 6))

        step = 1.0 if vc == "HR" else 0.1
        df["bin"] = (df["value"] / step).round() * step

        agg = (
            df.groupby(["mes", "eje"])["bin"]
            .agg(lambda s: float(s.mode().iloc[0]))
            .round(2)
            .reset_index()
            .rename(columns={"bin": "avg", "eje": eje_label})
        )
        matrix = agg.to_dict(orient="records")
        vals   = [r["avg"] for r in matrix if r["avg"] is not None]

        return {
            "matrix":    matrix,
            "eje_label": eje_label,
            "eje_range": eje_range,
            "group_by":  group_by,
            "stat":      "mode",
            "min":       round(min(vals), 2) if vals else None,
            "max":       round(max(vals), 2) if vals else None,
            "source":    "calculado",
        }

    if group_by == "hour":
        rows = (
            db.query(HeatmapStats)
            .filter(
                HeatmapStats.station_id  == station_id,
                HeatmapStats.variable_id == str(variable.id),
            )
            .order_by(HeatmapStats.month, HeatmapStats.hour)
            .all()
        )

        if rows:
            matrix = [
                {"mes": r.month, "hora": r.hour, "avg": r.avg_value}
                for r in rows
            ]
            all_vals = [r.avg_value for r in rows if r.avg_value is not None]
            return {
                "matrix":    matrix,
                "eje_label": "hora",
                "eje_range": list(range(0, 24)),
                "group_by":  "hour",
                "min":       round(min(all_vals), 2) if all_vals else None,
                "max":       round(max(all_vals), 2) if all_vals else None,
                "source":    "precalculado",
            }

    import pandas as pd

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
        .filter(func.upper(Variable.code) == vc)
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
    df["eje"] = ((df["measured_at"].dt.day - 1) // 7 + 1)

    matrix = (
        df.groupby(["mes", "eje"])["value"]
        .mean().round(2).reset_index()
        .rename(columns={"value": "avg", "eje": "semana_mes"})
        .to_dict(orient="records")
    )

    all_vals = df["value"].dropna()
    return {
        "matrix":    matrix,
        "eje_label": "semana_mes",
        "eje_range": list(range(1, 6)),
        "group_by":  "week",
        "min":       round(float(all_vals.min()), 2),
        "max":       round(float(all_vals.max()), 2),
        "source":    "calculado",
    }


@router.get("/daily-peaks")
def get_daily_peaks(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Máximo diario de la variable (RF-03/RF-04): para cada día devuelve la hora
    y el valor del máximo — un punto por día, sin promediar. Para TEMP, además
    asigna cada medición a su componente gaussiana más probable (según el
    ajuste precalculado) y devuelve el máximo diario dentro de cada componente.
    """
    import json

    import numpy as np
    import pandas as pd

    from app.models.distribution_analysis import DistributionAnalysis

    vc    = variable_code.strip().upper()
    is_hr = vc == "HR"

    variable = db.query(Variable).filter(
        func.upper(Variable.code) == vc
    ).first()
    if not variable:
        raise HTTPException(status_code=404, detail=f"Variable '{vc}' no encontrada")

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
        .filter(func.upper(Variable.code) == vc)
    )
    q = _apply_date_filters(q, date_from, date_to)
    rows = q.all()

    if not rows:
        raise HTTPException(status_code=404, detail="Sin datos para los filtros indicados")

    df = pd.DataFrame({
        "measured_at": [r.measured_at for r in rows],
        "value":       [float(r.value) for r in rows],
    })
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    df["date"] = df["measured_at"].dt.date
    df["doy"]  = df["measured_at"].dt.dayofyear
    df["hour"] = df["measured_at"].dt.hour
    df["year"] = df["measured_at"].dt.year

    def _peaks(sub):
        idx = sub.groupby("date")["value"].idxmax()
        top = sub.loc[idx]
        return [
            {
                "date":  str(r.date),
                "year":  int(r.year),
                "doy":   int(r.doy),
                "hour":  int(r.hour),
                "value": round(float(r.value), 2),
            }
            for r in top.itertuples()
        ]

    daily_max = _peaks(df)

    # Descomposición por componente gaussiana (solo TEMP, ajuste precalculado):
    # cada medición se asigna a la componente de mayor densidad ponderada
    # w·N(x; μ, σ) y se toma el máximo diario dentro de cada grupo.
    components_out = []
    if not is_hr:
        dist_record = (
            db.query(DistributionAnalysis)
            .filter(
                DistributionAnalysis.station_id        == station_id,
                DistributionAnalysis.variable_id       == str(variable.id),
                DistributionAnalysis.distribution_type == "gaussian",
            )
            .order_by(DistributionAnalysis.calculated_at.desc())
            .first()
        )
        comps = (
            json.loads(dist_record.components_json)
            if dist_record and dist_record.components_json else []
        )
        if len(comps) >= 2:
            mus  = np.array([float(c.get("mu")    or 0.0) for c in comps])
            sigs = np.array([max(float(c.get("sigma") or 0.0), 1e-9) for c in comps])
            ws   = np.array([float(c.get("w")     or 0.0) for c in comps])

            vals = df["value"].to_numpy()
            dens = (
                ws[:, None] / sigs[:, None]
                * np.exp(-0.5 * ((vals[None, :] - mus[:, None]) / sigs[:, None]) ** 2)
            )
            df["comp"] = dens.argmax(axis=0)

            for k, c in enumerate(comps):
                sub = df[df["comp"] == k]
                if sub.empty:
                    continue
                components_out.append({
                    "comp":   k + 1,
                    "mu":     c.get("mu"),
                    "sigma":  c.get("sigma"),
                    "w":      c.get("w"),
                    "points": _peaks(sub),
                })

    return {
        "daily_max":  daily_max,
        "components": components_out,
        "n_days":     len(daily_max),
    }


@router.get("/daily-profile")
def get_daily_profile(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    date_from:     Optional[str] = Query(None),
    date_to:       Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    import numpy as np
    from collections import defaultdict

    vc    = variable_code.strip().upper()
    is_hr = vc == "HR"
    step  = 1.0 if is_hr else 0.1

    variable = db.query(Variable).filter(
        func.upper(Variable.code) == vc
    ).first()
    if not variable:
        raise HTTPException(status_code=404, detail=f"Variable '{vc}' no encontrada")

    q = (
        db.query(Measurement)
        .join(Measurement.variable)
        .filter(Measurement.station_id == station_id)
        .filter(func.upper(Variable.code) == vc)
    )
    q = _apply_date_filters(q, date_from, date_to)
    rows = q.order_by(Measurement.measured_at.asc()).all()

    if not rows:
        raise HTTPException(status_code=404, detail="Sin datos para los filtros indicados")

    # ── Helper: moda por bins de paso ────────────────────────
    def _mode_val(arr: np.ndarray) -> float | None:
        if len(arr) == 0:
            return None
        bins = np.round(arr / step) * step
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    # ── Helper: diccionario de estadísticos ──────────────────
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

    # ── Agrupar por (mes, hora) y por (hora) para anual ──────
    by_month_hour: dict[tuple, list] = defaultdict(list)
    by_hour:       dict[int,   list] = defaultdict(list)

    for r in rows:
        h = r.measured_at.hour
        m = r.measured_at.month
        v = float(r.value)
        by_month_hour[(m, h)].append(v)
        by_hour[h].append(v)

    # ── Perfil anual: stats de todos los registros por hora ──
    # Siempre 24 puntos (hora 0–23), con None si no hay datos
    annual = [
        {"hora": h, **_stats(by_hour[h])}
        for h in range(24)
    ]

    # ── Perfil mensual: stats por mes y hora ─────────────────
    # Siempre 12 meses × 24 horas, con None donde no hay datos
    monthly: dict[str, list] = {}
    for m in range(1, 13):
        monthly[str(m)] = [
            {"hora": h, **_stats(by_month_hour.get((m, h), []))}
            for h in range(24)
        ]

    return {
        "variable_code": vc,
        "is_hr":         is_hr,
        "annual":        annual,
        "monthly":       monthly,
        "source":        "calculado",
    }


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
    import math

    # ── Helpers psicrométricos (Velázquez Martí, UPV) ─────────────
    # Coherentes con el diagrama psicrométrico Carrier. Todas las
    # presiones en pascales (Pa).
    #
    #   Presión de vapor saturado (Antoine, inversa exacta de la
    #   fórmula de temperatura de rocío de más abajo):
    #     log10(P_sat) = (10.2858·T_K − 2148.49)/(T_K − 35.85)
    #
    #   Presión atmosférica según altitud (modelo barométrico ISA):
    #     P_tot = 101325·(1 − 2.25577e-5·z)^5.2559
    #
    #   Humedad absoluta (relación de humedad):
    #     ω = 0.622·P_vapor/(P_tot − P_vapor)   [kg vapor/kg aire seco]
    #
    #   Temperatura de rocío:
    #     T_r = (35.85·log10(P_v) − 2148.49)/(log10(P_v) − 10.2858) − 273.15
    #
    #   Entalpía específica del aire húmedo:
    #     h = 1.005·T + ω·(2503 + 1.86·T)        [kJ/kg aire seco]
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
        HR    = float(r.value)
        p_vap = (HR / 100.0) * _p_sat_pa(T)
        w     = _humidity_ratio(T, HR, p_tot)
        h_abs = None if w is None else 1000.0 * w                 # g/kg aire seco
        tr    = _dew_point_c(p_vap)                               # °C
        h_ent = None if w is None else 1.005 * T + w * (2503 + 1.86 * T)  # kJ/kg as
        ts    = r.measured_at
        joined.append({
            "measured_at": ts,
            "T":    T,
            "HR":   HR,
            "habs": round(h_abs, 4) if h_abs is not None else None,
            "tr":   round(tr, 2)    if tr    is not None else None,
            "h":    round(h_ent, 2) if h_ent is not None else None,
            "mes":  ts.month,
            "hora": ts.hour,
        })

    if not joined:
        raise HTTPException(status_code=404, detail="Sin datos cruzados T+HR")

    df = pd.DataFrame(joined)
    df["measured_at"] = pd.to_datetime(df["measured_at"])

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

    scatter_cols = [c for c in ["T", "HR", "habs", "tr", "h", "mes", "hora"] if c in df.columns]
    scatter_sample = (
        df[scatter_cols].dropna(subset=["T", "HR", "habs"]).head(2000).to_dict(orient="records")
    )

    # Curvas de HR constante para el diagrama psicrométrico (Carrier),
    # cubriendo el rango de temperatura observado.
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


# ═════════════════════════════════════════════════════════════
# VIENTO — rosa de vientos y análisis direccional/temporal
# Cruza en vivo las series VIENTO (velocidad) y VIENTO_DIR (dirección)
# por measured_at. Bineo a 16 sectores de 22.5° (Ugalde et al. 2025).
# ═════════════════════════════════════════════════════════════

DIR16_LABELS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"]


def _load_wind_pairs(db, station_id, date_from, date_to):
    """DataFrame [measured_at, speed, direction] cruzando VIENTO y VIENTO_DIR."""
    import pandas as pd

    vel = db.query(Variable).filter(func.upper(Variable.code) == "VIENTO").first()
    dr  = db.query(Variable).filter(func.upper(Variable.code) == "VIENTO_DIR").first()
    if not vel or not dr:
        return None

    def _load(vid, col):
        q = (db.query(Measurement.measured_at, Measurement.value)
             .filter(Measurement.station_id == station_id,
                     Measurement.variable_id == str(vid),
                     Measurement.value.isnot(None)))
        q = _apply_date_filters(q, date_from, date_to)
        return pd.DataFrame(q.all(), columns=["measured_at", col])

    sp = _load(vel.id, "speed")
    di = _load(dr.id,  "direction")
    if sp.empty or di.empty:
        return None

    m = sp.merge(di, on="measured_at", how="inner")
    m["measured_at"] = pd.to_datetime(m["measured_at"])
    m["speed"]     = pd.to_numeric(m["speed"], errors="coerce")
    m["direction"] = pd.to_numeric(m["direction"], errors="coerce")
    return m.dropna(subset=["speed", "direction"])


def _load_weibull_components(db, station_id):
    import json
    from app.models.distribution_analysis import DistributionAnalysis
    vel = db.query(Variable).filter(func.upper(Variable.code) == "VIENTO").first()
    if not vel:
        return []
    rec = (db.query(DistributionAnalysis)
           .filter(DistributionAnalysis.station_id == station_id,
                   DistributionAnalysis.variable_id == str(vel.id),
                   DistributionAnalysis.distribution_type == "weibull")
           .order_by(DistributionAnalysis.calculated_at.desc())
           .first())
    return json.loads(rec.components_json) if rec and rec.components_json else []


@router.get("/wind-rose")
def get_wind_rose(
    station_id: str           = Query(...),
    date_from:  Optional[str] = Query(None),
    date_to:    Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Rosa de vientos general (16 sectores × bandas de velocidad) y una rosa
    por cada viento del modelo Weibull (registros en vmax ± σ)."""
    import numpy as np
    import pandas as pd

    m = _load_wind_pairs(db, station_id, date_from, date_to)
    if m is None or m.empty:
        raise HTTPException(status_code=404, detail="Sin datos de viento (velocidad + dirección)")

    n = len(m)
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
            "pct":        round(len(sub) / n * 100, 2),
            "mean_speed": round(float(sub["speed"].mean()), 2) if len(sub) else 0.0,
            "bins":       [int((sub["sbin"] == lb).sum()) for lb in speed_labels],
        })

    comps = _load_weibull_components(db, station_id)
    by_wind = []
    for k, c in enumerate(comps):
        vmax = c.get("vmax")
        sig  = c.get("sigma") or 0.0
        if vmax is None:
            continue
        sub = m[(m["speed"] >= vmax - sig) & (m["speed"] <= vmax + sig)]
        nn  = len(sub)
        by_wind.append({
            "comp":  k + 1,
            "vmax":  vmax,
            "sigma": c.get("sigma"),
            "w":     c.get("w"),
            "n":     int(nn),
            "sectors": [
                {
                    "sector":  s,
                    "label":   DIR16_LABELS[s],
                    "dir_deg": round(s * 22.5, 1),
                    "count":   int((sub["sector"] == s).sum()),
                    "pct":     round(int((sub["sector"] == s).sum()) / nn * 100, 2) if nn else 0.0,
                }
                for s in range(16)
            ],
        })

    return {"n": n, "speed_bins": speed_labels, "general": general, "by_wind": by_wind}


@router.get("/wind-directional")
def get_wind_directional(
    station_id: str           = Query(...),
    date_from:  Optional[str] = Query(None),
    date_to:    Optional[str] = Query(None),
    max_points: int           = Query(4000, ge=200, le=20000),
    db: Session = Depends(get_db),
):
    """Para cada viento (vmax ± σ) devuelve los registros con su día del año,
    hora y dirección — insumo de los gráficos dirección×año y dirección×hora."""
    import numpy as np  # noqa: F401

    m = _load_wind_pairs(db, station_id, date_from, date_to)
    if m is None or m.empty:
        raise HTTPException(status_code=404, detail="Sin datos de viento (velocidad + dirección)")

    m["doy"]   = m["measured_at"].dt.dayofyear
    m["hour"]  = m["measured_at"].dt.hour
    m["month"] = m["measured_at"].dt.month

    comps = _load_weibull_components(db, station_id)
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

