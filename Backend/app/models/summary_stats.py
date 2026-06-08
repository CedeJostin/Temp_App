from sqlalchemy import Column, BigInteger, Float, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from app.db.database import Base

class SummaryStats(Base):
    __tablename__ = "summary_stats"

    station_id  = Column(UUID(as_uuid=True), ForeignKey("stations.id"),  primary_key=True)
    variable_id = Column(UUID(as_uuid=True), ForeignKey("variables.id"), primary_key=True)
    count       = Column(BigInteger)
    min_value   = Column(Float)
    max_value   = Column(Float)
    avg_value   = Column(Float)
    std_value   = Column(Float)
    date_start  = Column(DateTime)
    date_end    = Column(DateTime)
    updated_at  = Column(DateTime)