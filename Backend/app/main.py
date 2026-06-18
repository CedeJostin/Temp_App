import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.db.database import engine, Base
import app.db.db  # noqa: F401 — registra todos los modelos
from app.api.api import api_router

# ── Logging ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=settings.LOG_LEVEL,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("app")

app = FastAPI(
    title="Meteorological API",
    version="1.0.0",
)

# Crear tablas al arrancar
Base.metadata.create_all(bind=engine)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Siempre se registra el stacktrace completo en el servidor...
    logger.exception("Error no controlado en %s %s", request.method, request.url.path)

    # ...pero solo se expone al cliente cuando DEBUG está activo.
    if settings.DEBUG:
        import traceback
        return JSONResponse(
            status_code=500,
            content={"detail": traceback.format_exc()},
        )

    return JSONResponse(
        status_code=500,
        content={"detail": "Error interno del servidor"},
    )


app.include_router(api_router, prefix="/api")


@app.get("/")
def root():
    return {"message": "Meteorological API Running"}
