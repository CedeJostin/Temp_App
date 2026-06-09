from sqlalchemy import Column, Integer, Float, Text, Numeric, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from app.db.database import Base


class CombinedStats(Base):
    __tablename__ = "combined_stats"

    station_id        = Column(UUID(as_uuid=True), ForeignKey("stations.id"),  primary_key=True)
    variable_id_temp  = Column(UUID(as_uuid=True), ForeignKey("variables.id"), primary_key=True)
    variable_id_hr    = Column(UUID(as_uuid=True), ForeignKey("variables.id"), primary_key=True)
    altitude_meters   = Column(Numeric, nullable=False, default=0)
    density_json      = Column(Text)
    humect_pct        = Column(Float)
    humect_count      = Column(Integer)
    total_paired      = Column(Integer)
    habs_monthly_json = Column(Text)
    mobility_json     = Column(Text)
    scatter_json      = Column(Text)
    calculated_at     = Column(DateTime)
