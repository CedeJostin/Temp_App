from sqlalchemy import Column, ForeignKey, DateTime, Float, BigInteger
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.db.database import Base
import uuid

class Measurement(Base):
    __tablename__ = "measurements"

    id          = Column(BigInteger, primary_key=True, autoincrement=True)  # ← bigint
    station_id  = Column(UUID(as_uuid=True), ForeignKey("stations.id"),         nullable=False)
    variable_id = Column(UUID(as_uuid=True), ForeignKey("variables.id"),        nullable=False)
    file_id     = Column(UUID(as_uuid=True), ForeignKey("uploaded_files.id"),   nullable=True)
    measured_at = Column(DateTime, nullable=False)
    value       = Column(Float,    nullable=False)

    station  = relationship("Station",  back_populates="measurements")
    variable = relationship("Variable", back_populates="measurements")