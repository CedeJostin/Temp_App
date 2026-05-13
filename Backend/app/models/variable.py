from sqlalchemy import Column, String, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid

from app.db.database import Base


class Variable(Base):
    __tablename__ = "variables"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    code = Column(String(20), unique=True, nullable=False)

    name = Column(String(100), nullable=False)

    unit = Column(String(50), nullable=False)

    created_at = Column(TIMESTAMP, server_default=func.now())