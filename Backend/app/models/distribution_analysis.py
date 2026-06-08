from sqlalchemy import Column, Float, DateTime, String, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
from app.db.database import Base
import uuid

class DistributionAnalysis(Base):
    __tablename__ = "distribution_analysis"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id        = Column(UUID(as_uuid=True), ForeignKey("stations.id"),  nullable=False)
    variable_id       = Column(UUID(as_uuid=True), ForeignKey("variables.id"), nullable=False)

    distribution_type = Column(String, nullable=False)
    n_components      = Column(Float,  nullable=True)
    components_json   = Column(Text,   nullable=True)
    fdp_json          = Column(Text,   nullable=True)

    # ── Estadísticos precalculados ── nuevos ──
    n_records         = Column(Float,  nullable=True)
    mean_val          = Column(Float,  nullable=True)
    std_val           = Column(Float,  nullable=True)
    min_val           = Column(Float,  nullable=True)
    max_val           = Column(Float,  nullable=True)
    q25_val           = Column(Float,  nullable=True)
    q50_val           = Column(Float,  nullable=True)
    q75_val           = Column(Float,  nullable=True)
    mode_val          = Column(Float,  nullable=True)
    anomaly_threshold = Column(Float,  nullable=True)
    anomalies_json    = Column(Text,   nullable=True)
    completitud_pct   = Column(Float,  nullable=True)
    date_start        = Column(DateTime, nullable=True)
    date_end          = Column(DateTime, nullable=True)
    # ─────────────────────────────────────────

    r2                = Column(Float,    nullable=True)
    mse               = Column(Float,    nullable=True)
    calculated_at     = Column(DateTime, server_default=func.now())