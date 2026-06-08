from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import traceback

from app.db.database import engine, Base
import app.db.db  # noqa: F401 — registra todos los modelos
from app.api.api import api_router

app = FastAPI(
    title="Meteorological API",
    version="1.0.0"
)

# Crear tablas al arrancar
Base.metadata.create_all(bind=engine)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": traceback.format_exc()}
    )

app.include_router(api_router, prefix="/api")

@app.get("/")
def root():
    return {"message": "Meteorological API Running"}