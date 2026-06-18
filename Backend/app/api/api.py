from fastapi import APIRouter

from app.api.routes import (
    stations,
    uploads,
    measurements,
    charts,
    analysis,
    local_analysis
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

# charts va ANTES que measurements: sus rutas específicas (/stats, /heatmap, …)
# deben registrarse antes del catch-all GET /{measurement_id} de measurements.
api_router.include_router(
    charts.router,
    prefix="/measurements",
    tags=["Charts"]
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

api_router.include_router(
    local_analysis.router,   
    prefix="/local-analysis", 
    tags=["local-analysis"]
)