from fastapi import APIRouter

from app.api.routes import (
    stations,
    uploads,
    measurements,
    analysis
)

api_router = APIRouter()

api_router.include_router(
    stations.router,
    prefix="/stations",
    tags=["Stations"]
)

api_router.include_router(
    uploads.router,
    prefix="/uploads",
    tags=["Uploads"]
)

api_router.include_router(
    measurements.router,
    prefix="/measurements",
    tags=["Measurements"]
)

api_router.include_router(
    analysis.router,
    prefix="/stations",
    tags=["analysis"]
)