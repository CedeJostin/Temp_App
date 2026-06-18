"""
config.py
=========
Configuración central de la aplicación.

Lee todo desde variables de entorno (cargadas desde .env en desarrollo) y
valida lo imprescindible al arrancar, para fallar rápido y con un mensaje
claro en vez de explotar más adelante con un error críptico.
"""

import os

from dotenv import load_dotenv

load_dotenv()


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    def __init__(self) -> None:
        self.DATABASE_URL: str | None = os.getenv("DATABASE_URL")
        if not self.DATABASE_URL:
            raise RuntimeError(
                "DATABASE_URL no está definida. "
                "Copia .env.example a .env y configúrala antes de arrancar."
            )

        # En desarrollo mostramos detalles de error; en cualquier otro entorno
        # NO se filtran stacktraces al cliente.
        self.DEBUG: bool = _as_bool(os.getenv("DEBUG"), default=False)

        # Orígenes permitidos para CORS, separados por coma.
        origins = os.getenv("CORS_ORIGINS", "http://localhost:5173")
        self.CORS_ORIGINS: list[str] = [
            o.strip() for o in origins.split(",") if o.strip()
        ]

        self.LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()


settings = Settings()

# Compatibilidad: varios módulos importan DATABASE_URL directamente.
DATABASE_URL = settings.DATABASE_URL
