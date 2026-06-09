from sqlalchemy import Column, Integer, Float, DateTime, String, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from app.db.database import Base


class ByDateStats(Base):
    __tablename__ = "by_date_stats"

    station_id   = Column(UUID(as_uuid=True), ForeignKey("stations.id"),   primary_key=True)
    variable_id  = Column(UUID(as_uuid=True), ForeignKey("variables.id"),  primary_key=True)
    period_type  = Column(String(5),    primary_key=True)
    period_start = Column(DateTime,     primary_key=True)
    avg_value    = Column(Float)
    min_value    = Column(Float)
    max_value    = Column(Float)
    record_count = Column(Integer,      nullable=False, default=0)
