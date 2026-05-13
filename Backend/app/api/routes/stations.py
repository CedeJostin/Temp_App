from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.station import Station
from app.schemas.station import StationCreate

router = APIRouter()


@router.post("/")
def create_station(
    station: StationCreate,
    db: Session = Depends(get_db)
):

    db_station = Station(**station.model_dump())

    db.add(db_station)

    db.commit()

    db.refresh(db_station)

    return db_station


@router.get("/")
def get_stations(db: Session = Depends(get_db)):

    return db.query(Station).all()