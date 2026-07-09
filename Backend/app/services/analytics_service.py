"""
analytics_service.py
====================
Calcula y guarda estadísticas precalculadas en:
  - daily_stats
  - monthly_stats
  - heatmap_stats
  - distribution_analysis

Se llama después de cada carga de CSV exitosa.
"""

import json
import logging

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session
from sqlalchemy import text

logger = logging.getLogger(__name__)

from app.models.daily_stats import DailyStats
from app.models.monthly_stats import MonthlyStats
from app.models.heatmap_stats import HeatmapStats
from app.models.distribution_analysis import DistributionAnalysis
from app.services.distribution_fitting import (
    _build_fdp,
    _fit_gaussian_components,
    _fit_beta_components,
    _fit_weibull_components,
)


# ═══════════════════════════════════════════════════════════════
# ENTRADA PRINCIPAL
# ═══════════════════════════════════════════════════════════════

def run_analytics(
    db:          Session,
    station_id:  str,
    variable_id: str,
    variable_code: str,   # "TEMP" o "HR"
) -> dict:
    """
    Recalcula todas las tablas analíticas para una estación+variable.
    Retorna un resumen de lo que se calculó.
    """
    logs = []

    # Cargar datos de measurements una sola vez
    rows = db.execute(text("""
        SELECT measured_at, value
        FROM measurements
        WHERE station_id  = :sid
          AND variable_id = :vid
          AND value IS NOT NULL
        ORDER BY measured_at ASC
    """), {"sid": station_id, "vid": variable_id}).fetchall()

    if not rows:
        return {"status": "sin_datos", "logs": logs}

    df = pd.DataFrame(rows, columns=["measured_at", "value"])
    df["measured_at"] = pd.to_datetime(df["measured_at"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["value"])

    if df.empty:
        return {"status": "sin_datos_validos", "logs": logs}

    # Calcular cada tabla
    logs += _calc_daily_stats(db, df, station_id, variable_id)
    logs += _calc_monthly_stats(db, df, station_id, variable_id)
    logs += _calc_heatmap_stats(db, df, station_id, variable_id)
    logs += _calc_distribution(db, df, station_id, variable_id, variable_code)

    return {"status": "ok", "logs": logs}


# ═══════════════════════════════════════════════════════════════
# DAILY STATS
# ═══════════════════════════════════════════════════════════════

def _calc_daily_stats(
    db: Session, df: pd.DataFrame,
    station_id: str, variable_id: str,
) -> list[str]:

    df["day"] = df["measured_at"].dt.date

    agg = (
        df.groupby("day")["value"]
        .agg(
            avg_value="mean",
            min_value="min",
            max_value="max",
            std_value="std",
            record_count="count",
        )
        .reset_index()
    )

    # Borrar los días existentes para esta estación+variable y reinsertarlos
    db.execute(text("""
        DELETE FROM daily_stats
        WHERE station_id  = :sid
          AND variable_id = :vid
    """), {"sid": station_id, "vid": variable_id})

    records = [
        DailyStats(
            station_id   = station_id,
            variable_id  = variable_id,
            day          = row["day"],
            avg_value    = round(float(row["avg_value"]), 4),
            min_value    = round(float(row["min_value"]), 4),
            max_value    = round(float(row["max_value"]), 4),
            std_value    = round(float(row["std_value"]), 4) if not np.isnan(row["std_value"]) else None,
            record_count = int(row["record_count"]),
        )
        for _, row in agg.iterrows()
    ]

    db.bulk_save_objects(records)
    db.commit()

    return [f"✅ daily_stats: {len(records)} días calculados"]


# ═══════════════════════════════════════════════════════════════
# MONTHLY STATS
# ═══════════════════════════════════════════════════════════════

def _calc_monthly_stats(
    db: Session, df: pd.DataFrame,
    station_id: str, variable_id: str,
) -> list[str]:

    df["year"]  = df["measured_at"].dt.year
    df["month"] = df["measured_at"].dt.month

    agg = (
        df.groupby(["year", "month"])["value"]
        .agg(
            avg_value="mean",
            min_value="min",
            max_value="max",
            std_value="std",
            record_count="count",
        )
        .reset_index()
    )

    db.execute(text("""
        DELETE FROM monthly_stats
        WHERE station_id  = :sid
          AND variable_id = :vid
    """), {"sid": station_id, "vid": variable_id})

    records = [
        MonthlyStats(
            station_id   = station_id,
            variable_id  = variable_id,
            year         = int(row["year"]),
            month        = int(row["month"]),
            avg_value    = round(float(row["avg_value"]), 4),
            min_value    = round(float(row["min_value"]), 4),
            max_value    = round(float(row["max_value"]), 4),
            std_value    = round(float(row["std_value"]), 4) if not np.isnan(row["std_value"]) else None,
            record_count = int(row["record_count"]),
        )
        for _, row in agg.iterrows()
    ]

    db.bulk_save_objects(records)
    db.commit()

    return [f"✅ monthly_stats: {len(records)} meses calculados"]


# ═══════════════════════════════════════════════════════════════
# HEATMAP STATS
# ═══════════════════════════════════════════════════════════════

def _calc_heatmap_stats(
    db: Session, df: pd.DataFrame,
    station_id: str, variable_id: str,
) -> list[str]:

    df["month"] = df["measured_at"].dt.month
    df["hour"]  = df["measured_at"].dt.hour

    agg = (
        df.groupby(["month", "hour"])["value"]
        .mean()
        .round(4)
        .reset_index()
        .rename(columns={"value": "avg_value"})
    )

    db.execute(text("""
        DELETE FROM heatmap_stats
        WHERE station_id  = :sid
          AND variable_id = :vid
    """), {"sid": station_id, "vid": variable_id})

    records = [
        HeatmapStats(
            station_id  = station_id,
            variable_id = variable_id,
            month       = int(row["month"]),
            hour        = int(row["hour"]),
            avg_value   = float(row["avg_value"]),
        )
        for _, row in agg.iterrows()
    ]

    db.bulk_save_objects(records)
    db.commit()

    return [f"✅ heatmap_stats: {len(records)} celdas calculadas"]


# ═══════════════════════════════════════════════════════════════
# DISTRIBUTION ANALYSIS
# ═══════════════════════════════════════════════════════════════

def _calc_distribution(
    db: Session, df: pd.DataFrame,
    station_id: str, variable_id: str,
    variable_code: str,
) -> list[str]:
    logger.debug(f">>> _calc_distribution iniciado: variable_code={variable_code}")

    vc = variable_code.strip().upper()

    # La dirección del viento es circular: no se ajusta a una distribución.
    if vc == "VIENTO_DIR":
        return ["ℹ️ distribution_analysis: VIENTO_DIR es direccional, sin ajuste"]

    values  = df["value"].values
    is_hr   = vc == "HR"
    is_wind = vc == "VIENTO"
    paso    = 1.0 if is_hr else 0.1

    logger.debug(f">>> valores: {len(values)}, is_hr={is_hr}, is_wind={is_wind}")

    n    = len(values)
    mean = float(np.mean(values))
    std  = float(np.std(values))
    mn   = float(np.min(values))
    mx   = float(np.max(values))
    q25  = float(np.percentile(values, 25))
    q50  = float(np.percentile(values, 50))
    q75  = float(np.percentile(values, 75))

    step = 1.0 if is_hr else 0.1
    bins_mode = np.round(values / step) * step
    unique, counts = np.unique(bins_mode, return_counts=True)
    mode = float(unique[np.argmax(counts)])

    anomaly_threshold = 3 * std
    anomaly_values = [
        round(float(v), 4)
        for v in values if abs(v - mean) > anomaly_threshold
    ]

    date_start = df["measured_at"].min().to_pydatetime()
    date_end   = df["measured_at"].max().to_pydatetime()
    horas_totales = max(
        int((date_end - date_start).total_seconds() / 3600) + 1, 1
    )
    completitud = round(n / horas_totales * 100, 2)

    # El viento excluye las calmas (v=0) del ajuste de la FDP (Ugalde et al.)
    # y usa bins alineados a la rejilla de 0.1 m/s (evita el aliasing que
    # aparece con datos cuantizados a un decimal y hunde el R²).
    fit_values = values[values > 0] if is_wind else values
    fdp = _build_fdp(fit_values, paso, align_grid=is_wind)
    logger.debug(f">>> fdp bins: {len(fdp)}")

    if len(fdp) <= 4:
        return ["⚠️ distribution_analysis: muy pocos bins para ajustar"]

    dist_label = "weibull" if is_wind else ("beta" if is_hr else "gaussian")
    logger.debug(f">>> iniciando ajuste {dist_label}...")
    try:
        if is_wind:
            # Deconvolución de curvas Weibull ponderadas (Ugalde et al. 2025):
            # 3 vientos por defecto (comercial, valle-montaña, mixto débil).
            components, r2, mse, fdp_fitted = _fit_weibull_components(fdp, n_components=3)
            dist_type = "weibull"
        elif is_hr:
            # free_support libera el "entorno" [A,B] de cada beta (paso 1 del
            # feedback); censor_sat añade la censura XBX del spike de saturación
            # en HR=100. Sobre la HR real: err_acum −30 %, R² 0.995, área 1.000.
            # Ver distribution_fitting._fit_beta_components.
            components, r2, mse, fdp_fitted = _fit_beta_components(
                fdp, n_components=5, free_support=True, censor_sat=True,
            )
            dist_type = "beta"
        else:
            components, r2, mse, fdp_fitted = _fit_gaussian_components(fdp, n_components=2)  # ← 2 como antes
            dist_type = "gaussian"
        logger.debug(f">>> ajuste completado: {dist_type}, r2={r2}")
    except Exception as e:
        logger.error(f">>> ERROR en ajuste: {e}")
        return [f"❌ distribution_analysis: error en ajuste: {e}"]

    logger.debug(f">>> guardando en BD...")
    try:
        db.execute(text("""
            DELETE FROM distribution_analysis
            WHERE station_id        = :sid
              AND variable_id       = :vid
              AND distribution_type = :dtype
        """), {"sid": station_id, "vid": variable_id, "dtype": dist_type})

        db.execute(text("""
            INSERT INTO distribution_analysis (
                id, station_id, variable_id, distribution_type,
                n_components, components_json, fdp_json,
                n_records, mean_val, std_val, min_val, max_val,
                q25_val, q50_val, q75_val, mode_val,
                anomaly_threshold, anomalies_json, completitud_pct,
                date_start, date_end, r2, mse
            ) VALUES (
                gen_random_uuid(), :sid, :vid, :dtype,
                :n_components, :components_json, :fdp_json,
                :n_records, :mean_val, :std_val, :min_val, :max_val,
                :q25_val, :q50_val, :q75_val, :mode_val,
                :anomaly_threshold, :anomalies_json, :completitud_pct,
                :date_start, :date_end, :r2, :mse
            )
        """), {
            "sid":               station_id,
            "vid":               variable_id,
            "dtype":             dist_type,
            "n_components":      len(components),
            "components_json":   json.dumps(components),
            "fdp_json":          json.dumps(fdp_fitted),
            "n_records":         n,
            "mean_val":          round(mean, 4),
            "std_val":           round(std,  4),
            "min_val":           round(mn,   4),
            "max_val":           round(mx,   4),
            "q25_val":           round(q25,  4),
            "q50_val":           round(q50,  4),
            "q75_val":           round(q75,  4),
            "mode_val":          round(mode, 4),
            "anomaly_threshold": round(anomaly_threshold, 4),
            "anomalies_json":    json.dumps(anomaly_values[:50]),
            "completitud_pct":   completitud,
            "date_start":        date_start,
            "date_end":          date_end,
            "r2":                round(r2,  4) if r2  is not None else None,
            "mse":               round(mse, 8) if mse is not None else None,
        })

        db.commit()
        logger.debug(f">>> ✅ guardado exitosamente")

    except Exception as e:
        db.rollback()
        logger.error(f">>> ERROR al guardar: {e}")
        return [f"❌ distribution_analysis: error al guardar: {e}"]

    return [f"✅ distribution_analysis: {dist_type} con {len(components)} componentes (R²={r2})"]


def upsert_summary_stats(db: Session, station_id: str, variable_id: str):
    result = db.execute(text("""
        INSERT INTO summary_stats
            (station_id, variable_id, count, min_value, max_value,
             avg_value, std_value, date_start, date_end, updated_at)
        SELECT
            station_id, variable_id,
            COUNT(*), MIN(value), MAX(value),
            AVG(value), STDDEV(value),
            MIN(measured_at), MAX(measured_at),
            now()
        FROM measurements
        WHERE station_id = :sid AND variable_id = :vid
          AND value IS NOT NULL
        GROUP BY station_id, variable_id
        ON CONFLICT (station_id, variable_id) DO UPDATE SET
            count      = EXCLUDED.count,
            min_value  = EXCLUDED.min_value,
            max_value  = EXCLUDED.max_value,
            avg_value  = EXCLUDED.avg_value,
            std_value  = EXCLUDED.std_value,
            date_start = EXCLUDED.date_start,
            date_end   = EXCLUDED.date_end,
            updated_at = now()
    """), {"sid": station_id, "vid": variable_id})
    db.commit()