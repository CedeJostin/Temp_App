"""
charts.py
=========
Endpoints de análisis y visualización (gráficas) sobre las mediciones.

  GET  /stats                 Estadísticos + FDP + Gaussianas (T) o Beta (HR)
  POST /stats/recalculate     Recalcula el ajuste desde las mediciones guardadas
  GET  /stats/summary-table   Tabla exportable de ajustes por estación (b.1)
  GET  /heatmap               Matriz mes × hora / mes × semana
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

    vc    = variable_code.strip().upper()
    is_hr = vc == "HR"

    variable = db.query(Variable).filter(
        func.upper(Variable.code) == vc
    ).first()

    if not variable:
        raise HTTPException(status_code=404, detail=f"Variable '{vc}' no encontrada")

    dist_type   = "beta" if is_hr else "gaussian"
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
        quality    = _quality_flags(mse, r2, fdp_fitted)
        w_sum      = round(sum(c.get("w", 0) for c in components), 4)
        quality["weights_sum"]    = w_sum
        quality["weights_sum_ok"] = abs(w_sum - 1.0) < 0.01

        gaussians = components if not is_hr else []
        betas     = components if is_hr     else []

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
        codes = ["TEMP", "HR"]

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


@router.get("/heatmap")
def get_heatmap(
    station_id:    str           = Query(...),
    variable_code: str           = Query(...),
    group_by:      str           = Query("hour", pattern="^(hour|week)$"),
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

