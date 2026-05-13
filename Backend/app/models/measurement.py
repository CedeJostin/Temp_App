from sqlalchemy import (
    Column,
    ForeignKey,
    TIMESTAMP,
    Double,
    BigInteger
)

from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.db.database import Base


class Measurement(Base):
    __tablename__ = "measurements"

    id = Column(BigInteger, primary_key=True)

    station_id = Column(
        UUID(as_uuid=True),
        ForeignKey("stations.id", ondelete="CASCADE"),
        nullable=False
    )

    variable_id = Column(
        UUID(as_uuid=True),
        ForeignKey("variables.id", ondelete="CASCADE"),
        nullable=False
    )

    file_id = Column(
        UUID(as_uuid=True),
        ForeignKey("uploaded_files.id", ondelete="SET NULL")
    )

    measured_at = Column(TIMESTAMP, nullable=False)

    value = Column(Double)

    created_at = Column(TIMESTAMP, server_default=func.now())