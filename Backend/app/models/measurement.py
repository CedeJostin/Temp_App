
from sqlalchemy import Column, ForeignKey, DateTime, Float
from sqlalchemy.dialects.postgresql import UUID   # o String si usas SQLite
from sqlalchemy.orm import relationship
from app.db.database import Base
import uuid

class Measurement(Base):
    __tablename__ = "measurements"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id  = Column(UUID(as_uuid=True), ForeignKey("stations.id"),  nullable=False)
    variable_id = Column(UUID(as_uuid=True), ForeignKey("variables.id"), nullable=False)
    file_id     = Column(UUID(as_uuid=True), ForeignKey("files.id"),     nullable=True)
    measured_at = Column(DateTime, nullable=False)
    value       = Column(Float,    nullable=False)

    # ── Relationships ──────────────────────────────────────────
    station  = relationship("Station",  back_populates="measurements")
    variable = relationship("Variable", back_populates="measurements")