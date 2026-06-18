"""
_shared.py
==========
Helpers compartidos entre los routers de mediciones (measurements.py) y de
gráficas (charts.py). Solo utilidades sin estado.
"""

from datetime import datetime

from fastapi import HTTPException

from app.models.measurement import Measurement


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
