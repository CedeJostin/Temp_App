from sqlalchemy import Column, String, DECIMAL, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid

from app.db.database import Base


class Station(Base):
    __tablename__ = "stations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    station_code = Column(String(50), unique=True, nullable=False)

    name = Column(String(150), nullable=False)

    latitude = Column(DECIMAL(9, 6), nullable=False)

    longitude = Column(DECIMAL(9, 6), nullable=False)

    altitude_meters = Column(DECIMAL(8, 2))

    institution = Column(String(100))

    created_at = Column(TIMESTAMP, server_default=func.now())