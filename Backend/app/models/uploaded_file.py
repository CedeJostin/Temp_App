from sqlalchemy import Column, Text, String, Integer, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid

from app.db.database import Base


class UploadedFile(Base):
    __tablename__ = "uploaded_files"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    filename = Column(Text, nullable=False)

    source = Column(String(100))

    rows_imported = Column(Integer)

    status = Column(String(50))

    uploaded_at = Column(TIMESTAMP, server_default=func.now())