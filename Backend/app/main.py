from fastapi import FastAPI

from app.api.api import api_router

app = FastAPI(
    title="Meteorological API",
    version="1.0.0"
)

app.include_router(api_router)


@app.get("/")
def root():

    return {
        "message": "Meteorological API Running"
    }