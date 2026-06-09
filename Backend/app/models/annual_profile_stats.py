from sqlalchemy import Column, Integer, Float, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from app.db.database import Base


class AnnualProfileStats(Base):
    __tablename__ = "annual_profile_stats"

    station_id   = Column(UUID(as_uuid=True), ForeignKey("stations.id"),  primary_key=True)
    variable_id  = Column(UUID(as_uuid=True), ForeignKey("variables.id"), primary_key=True)
    doy          = Column(Integer, primary_key=True)
    avg_value    = Column(Float)
    min_value    = Column(Float)
    max_value    = Column(Float)
    q25_value    = Column(Float)
    q75_value    = Column(Float)
    n_years      = Column(Integer, nullable=False, default=1)
