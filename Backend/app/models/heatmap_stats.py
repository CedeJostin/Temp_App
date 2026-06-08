from sqlalchemy import Column, Integer, Float, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from app.db.database import Base

class HeatmapStats(Base):
    __tablename__ = "heatmap_stats"

    station_id  = Column(UUID(as_uuid=True), ForeignKey("stations.id"),  primary_key=True)
    variable_id = Column(UUID(as_uuid=True), ForeignKey("variables.id"), primary_key=True)
    month       = Column(Integer, primary_key=True)
    hour        = Column(Integer, primary_key=True)

    avg_value   = Column(Float, nullable=True)