from sqlalchemy import Column, Integer, Float, Date, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from app.db.database import Base

class DailyStats(Base):
    __tablename__ = "daily_stats"

    station_id   = Column(UUID(as_uuid=True), ForeignKey("stations.id"),  primary_key=True)
    variable_id  = Column(UUID(as_uuid=True), ForeignKey("variables.id"), primary_key=True)
    day          = Column(Date,    primary_key=True)

    avg_value    = Column(Float,   nullable=True)
    min_value    = Column(Float,   nullable=True)
    max_value    = Column(Float,   nullable=True)
    std_value    = Column(Float,   nullable=True)
    record_count = Column(Integer, nullable=False)