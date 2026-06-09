"""
stats_service.py
================
Precalcula y persiste en BD los resultados de los tres endpoints
que antes calculaban en tiempo real con Pandas/NumPy:

    _recalc_by_date_stats()      → tabla by_date_stats
    _recalc_annual_profile()     → tabla annual_profile_stats
    _recalc_combined_stats()     → tabla combined_stats

Punto de entrada único:
    recalculate_derived_stats(db, station_id, variable_id, variable_code)

Se llama desde uploads.py justo después de run_analytics(), en el
bloque 5b. No lanza excepciones al exterior: loguea y continúa.
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.measurement import Measurement
from app.models.variable import Variable

log = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════
# HELPERS INTERNOS
# ════════════════════════════════════════════════════════════

def _fetch_measurements(
    db: Session,
    station_id: str,
    variable_id: str,
) -> pd.DataFrame:
    """Carga todas las mediciones de una estación+variable como DataFrame."""
    rows = (
        db.query(Measurement.measured_at, Measurement.value)
        .filter(
            Measurement.station_id  == station_id,
            Measurement.variable_id == variable_id,
        )
        .order_by(Measurement.measured_at)
        .all()
    )
    if not rows:
        return pd.DataFrame(columns=["measured_at", "value"])
    df = pd.DataFrame(rows, columns=["measured_at", "value"])
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    df["value"]       = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["value"]).reset_index(drop=True)


def _upsert(db: Session, table: str, pk_cols: list[str], row: dict) -> None:
    """
    INSERT … ON CONFLICT (pk_cols) DO UPDATE SET …
    Compatible con PostgreSQL.
    """
    cols        = list(row.keys())
    values_ph   = ", ".join(f":{c}" for c in cols)
    conflict_ph = ", ".join(pk_cols)
    update_ph   = ", ".join(
        f"{c} = EXCLUDED.{c}"
        for c in cols if c not in pk_cols
    )
    sql = text(f"""
        INSERT INTO public.{table} ({", ".join(cols)})
        VALUES ({values_ph})
        ON CONFLICT ({conflict_ph})
        DO UPDATE SET {update_ph}
    """)
    db.execute(sql, row)


# ════════════════════════════════════════════════════════════
# 1.  by_date_stats
# ════════════════════════════════════════════════════════════

def _recalc_by_date_stats(
    db: Session,
    station_id: str,
    variable_id: str,
) -> list[str]:
    """
    Precalcula las 4 granularidades (hour/day/month/year) y las persiste
    en by_date_stats para la estación+variable dada.

    Borra los registros anteriores de esa estación+variable antes de
    insertar, para que un re-upload no duplique datos.
    """
    logs: list[str] = []

    df = _fetch_measurements(db, station_id, variable_id)
    if df.empty:
        logs.append(f"⚠️  by_date_stats [{station_id}]: sin mediciones")
        return logs

    # Borrar registros previos de esta estación+variable
    db.execute(
        text("""
            DELETE FROM public.by_date_stats
            WHERE station_id  = :sid
              AND variable_id = :vid
        """),
        {"sid": station_id, "vid": variable_id},
    )

    TRUNC: dict[str, str] = {
        "hour":  "h",
        "day":   "D",
        "month": "MS",
        "year":  "YS",
    }

    all_records: list[dict] = []
    for period_type, freq in TRUNC.items():
        df["period"] = df["measured_at"].dt.floor(freq) if freq in ("h", "D") \
                       else df["measured_at"].dt.to_period(
                           "M" if freq == "MS" else "Y"
                       ).dt.to_timestamp()

        agg = (
            df.groupby("period")["value"]
            .agg(avg="mean", min="min", max="max", count="count")
            .reset_index()
        )

        for _, r in agg.iterrows():
            all_records.append({
                "station_id":   station_id,
                "variable_id":  variable_id,
                "period_type":  period_type,
                "period_start": r["period"].to_pydatetime(),
                "avg_value":    round(float(r["avg"]),   4),
                "min_value":    round(float(r["min"]),   4),
                "max_value":    round(float(r["max"]),   4),
                "record_count": int(r["count"]),
            })

    from app.models.by_date_stats import ByDateStats
    db.bulk_insert_mappings(ByDateStats, all_records)
    db.commit()
    logs.append(
        f"✅ by_date_stats [{station_id}]: {len(all_records)} períodos escritos"
    )
    return logs


# ════════════════════════════════════════════════════════════
# 2.  annual_profile_stats
# ════════════════════════════════════════════════════════════

def _recalc_annual_profile(
    db: Session,
    station_id: str,
    variable_id: str,
    is_hr: bool = False,
) -> list[str]:
    """
    Precalcula el perfil anual (por día-del-año) y lo persiste en
    annual_profile_stats.  Lógica idéntica al endpoint /annual-profile
    pero escribe en BD en lugar de retornar JSON.
    """
    logs: list[str] = []
    step = 1.0 if is_hr else 0.1

    df = _fetch_measurements(db, station_id, variable_id)
    if df.empty:
        logs.append(f"⚠️  annual_profile [{station_id}]: sin mediciones")
        return logs

    # Borrar previos
    db.execute(
        text("""
            DELETE FROM public.annual_profile_stats
            WHERE station_id  = :sid
              AND variable_id = :vid
        """),
        {"sid": station_id, "vid": variable_id},
    )

    df["doy"]  = df["measured_at"].dt.dayofyear
    df["date"] = df["measured_at"].dt.date

    def _mode_val(arr: np.ndarray) -> float:
        bins = np.round(arr / step) * step
        u, c = np.unique(bins, return_counts=True)
        return round(float(u[np.argmax(c)]), 2)

    # Agregar por fecha
    daily_records: list[dict] = []
    for date, grp in df.groupby("date"):
        vals = grp["value"].dropna().values
        if len(vals) == 0:
            continue
        doy     = int(grp["doy"].iloc[0])
        primary = _mode_val(vals) if is_hr else round(float(np.mean(vals)), 3)
        daily_records.append({
            "doy":     doy,
            "primary": primary,
            "min":     round(float(np.min(vals)),          3),
            "max":     round(float(np.max(vals)),          3),
            "q25":     round(float(np.percentile(vals, 25)), 3),
            "q75":     round(float(np.percentile(vals, 75)), 3),
        })

    if not daily_records:
        logs.append(f"⚠️  annual_profile [{station_id}]: sin días válidos")
        return logs

    daily_df = pd.DataFrame(daily_records)

    all_records: list[dict] = []
    for doy in range(1, 367):
        subset = daily_df[daily_df["doy"] == doy]
        if len(subset) == 0:
            continue
        all_records.append({
            "station_id":  station_id,
            "variable_id": variable_id,
            "doy":         doy,
            "avg_value":   round(float(subset["primary"].mean()), 3),
            "min_value":   round(float(subset["min"].mean()),      3),
            "max_value":   round(float(subset["max"].mean()),      3),
            "q25_value":   round(float(subset["q25"].mean()),      3),
            "q75_value":   round(float(subset["q75"].mean()),      3),
            "n_years":     int(len(subset)),
        })

    from app.models.annual_profile_stats import AnnualProfileStats
    db.bulk_insert_mappings(AnnualProfileStats, all_records)
    db.commit()
    logs.append(
        f"✅ annual_profile [{station_id}]: {len(all_records)} días escritos"
    )
    return logs


# ════════════════════════════════════════════════════════════
# 3.  combined_stats
# ════════════════════════════════════════════════════════════

def _recalc_combined_stats(
    db: Session,
    station_id: str,
    altitude: float = 0.0,
) -> list[str]:
    """
    Precalcula el cruce T×HR (densidad, humectación, humedad absoluta,
    movilidad, scatter) y lo persiste en combined_stats.

    Solo se ejecuta cuando la variable subida es TEMP o HR, ya que
    ambas tienen que estar presentes en measurements.
    """
    logs: list[str] = []

    # Buscar IDs de TEMP y HR
    temp_var = db.query(Variable).filter(Variable.code == "TEMP").first()
    hr_var   = db.query(Variable).filter(Variable.code == "HR").first()

    if not temp_var or not hr_var:
        logs.append("⚠️  combined_stats: variables TEMP o HR no encontradas en BD")
        return logs

    df_t = _fetch_measurements(db, station_id, str(temp_var.id))
    df_h = _fetch_measurements(db, station_id, str(hr_var.id))

    if df_t.empty or df_h.empty:
        logs.append(
            f"⚠️  combined_stats [{station_id}]: "
            f"faltan mediciones de TEMP o HR"
        )
        return logs

    # Cruce por timestamp exacto
    t_map  = dict(zip(df_t["measured_at"].astype(str), df_t["value"]))
    joined = []
    for _, row in df_h.iterrows():
        T = t_map.get(str(row["measured_at"]))
        if T is None:
            continue
        HR      = float(row["value"])
        # Humedad absoluta (fórmula del endpoint original)
        p_sat   = 9.066 * np.exp(0.0641 * T) - 1.796 * np.exp(0.0805 * T)
        p_tot   = 1013.25 * (1 - 2.25577e-5 * altitude) ** 5.2559
        hr_frac = HR / 100
        denom   = p_tot - hr_frac * p_sat
        h_abs   = (18000 / 29) * (hr_frac * p_sat) / denom if denom > 0 else None
        ts      = row["measured_at"]
        joined.append({
            "measured_at": ts,
            "T":    float(T),
            "HR":   HR,
            "habs": round(h_abs, 4) if h_abs is not None else None,
            "mes":  ts.month,
            "hora": ts.hour,
        })

    if not joined:
        logs.append(f"⚠️  combined_stats [{station_id}]: sin pares T+HR coincidentes")
        return logs

    df = pd.DataFrame(joined)
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    total_pts = len(df)

    # ── Densidad T×HR ─────────────────────────────────────────
    df["T_bin"]  = (df["T"]  / 0.1).round() * 0.1
    df["HR_bin"] = (df["HR"] / 1.0).round() * 1.0
    density_raw = (
        df.groupby(["T_bin", "HR_bin"])
        .size().reset_index(name="count")
        .rename(columns={"T_bin": "T", "HR_bin": "HR"})
    )
    density_raw["pct"] = (density_raw["count"] / total_pts * 100).round(3)

    density_sorted = density_raw.sort_values("count", ascending=False).copy()
    density_sorted["cum_pct"] = (
        density_sorted["count"].cumsum() / total_pts * 100
    )
    density_raw = density_raw.merge(
        density_sorted[["T", "HR", "cum_pct"]], on=["T", "HR"], how="left"
    )

    def _contour_level(cum: float) -> str:
        if cum <= 90:  return "90"
        if cum <= 95:  return "95"
        if cum <= 99:  return "99"
        return "out"

    density_raw["contour"] = density_raw["cum_pct"].apply(_contour_level)
    density_json = density_raw.to_dict(orient="records")

    # ── Humectación ───────────────────────────────────────────
    humect_mask  = (df["T"] > 10) & (df["HR"] > 79)
    humect_count = int(humect_mask.sum())
    humect_pct   = round(humect_count / total_pts * 100, 2)

    # ── Humedad absoluta mensual ──────────────────────────────
    df_habs = df.dropna(subset=["habs"]).copy()
    df_habs["period"] = (
        df_habs["measured_at"].dt.to_period("M").dt.to_timestamp()
    )
    habs_monthly = (
        df_habs.groupby("period")["habs"]
        .mean().round(4).reset_index().rename(columns={"habs": "avg"})
    )
    habs_json = [
        {
            "period": str(r["period"].date())[:7] + "-01",
            "avg":    float(r["avg"]),
        }
        for _, r in habs_monthly.iterrows()
    ]

    # ── Movilidad mes×hora ────────────────────────────────────
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

    # ── Scatter sample ────────────────────────────────────────
    scatter = (
        df[["T", "HR", "habs", "mes", "hora"]]
        .dropna()
        .head(2000)
        .to_dict(orient="records")
    )

    # ── Upsert en BD ─────────────────────────────────────────
    _upsert(
        db, "combined_stats",
        ["station_id", "variable_id_temp", "variable_id_hr"],
        {
            "station_id":        station_id,
            "variable_id_temp":  str(temp_var.id),
            "variable_id_hr":    str(hr_var.id),
            "altitude_meters":   altitude,
            "density_json":      json.dumps(density_json),
            "humect_pct":        humect_pct,
            "humect_count":      humect_count,
            "total_paired":      total_pts,
            "habs_monthly_json": json.dumps(habs_json),
            "mobility_json":     json.dumps(mobility),
            "scatter_json":      json.dumps(scatter),
            "calculated_at":     datetime.utcnow(),
        },
    )
    db.commit()

    logs.append(
        f"✅ combined_stats [{station_id}]: "
        f"{total_pts} pares T×HR procesados"
    )
    return logs


# ════════════════════════════════════════════════════════════
# PUNTO DE ENTRADA ÚNICO
# ════════════════════════════════════════════════════════════

def recalculate_derived_stats(
    db:            Session,
    station_id:    str,
    variable_id:   str,
    variable_code: str,     # "TEMP" | "HR" | "RAD" | "VIENTO"
    altitude:      float = 0.0,
) -> dict:
    """
    Llamar desde uploads.py después de run_analytics().

    Ejecuta los tres recalculados que correspondan según la variable
    recién subida:
      - by_date_stats      → siempre (cualquier variable)
      - annual_profile     → siempre
      - combined_stats     → solo si variable es TEMP o HR
                             (necesita ambas para hacer el cruce)

    Retorna {"logs": [...]} para que uploads.py los agregue al response.
    """
    logs: list[str] = []
    vc = variable_code.strip().upper()

    try:
        logs += _recalc_by_date_stats(db, station_id, variable_id)
    except Exception as e:
        db.rollback()
        logs.append(f"⚠️  by_date_stats falló: {e}")

    try:
        is_hr = (vc == "HR")
        logs += _recalc_annual_profile(db, station_id, variable_id, is_hr=is_hr)
    except Exception as e:
        db.rollback()
        logs.append(f"⚠️  annual_profile falló: {e}")

    if vc in ("TEMP", "HR"):
        # Buscar la altitud de la estación si no se pasó explícitamente
        try:
            from app.models.station import Station
            st = db.query(Station).filter(Station.id == station_id).first()
            alt = float(st.altitude_meters or 0) if st else altitude
            logs += _recalc_combined_stats(db, station_id, altitude=alt)
        except Exception as e:
            db.rollback()
            logs.append(f"⚠️  combined_stats falló: {e}")

    return {"logs": logs}