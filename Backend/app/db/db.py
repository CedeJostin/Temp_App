# Este archivo importa todos los modelos para que SQLAlchemy
# los registre en el metadata de Base antes de crear tablas.
from app.models.station import Station        # noqa: F401
from app.models.variable import Variable      # noqa: F401
from app.models.uploaded_file import UploadedFile  # noqa: F401
from app.models.measurement import Measurement     # noqa: F401