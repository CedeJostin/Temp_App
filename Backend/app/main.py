from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import traceback

from app.api.api import api_router

app = FastAPI(
    title="Meteorological API",
    version="1.0.0"
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