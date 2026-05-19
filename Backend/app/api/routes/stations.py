from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.station import Station
from app.models.variable import Variable
from app.schemas.station import StationCreate, StationResponse

router = APIRouter()

# ── Variables ─────────────────────────────────────────────────────────

@router.get("/variables/all")
def get_variables(db: Session = Depends(get_db)):
    variables = db.query(Variable).order_by(Variable.code).all()
    return [
        {
            "id":   str(v.id),
            "code": v.code,
            "name": v.name,
            "unit": v.unit,
        }
        for v in variables
    ]

# ── Estaciones ────────────────────────────────────────────────────────

@router.get("/", response_model=list[StationResponse])
def get_stations(db: Session = Depends(get_db)):
    stations = db.query(Station).order_by(Station.name).all()
    # Convertir UUID a str para el schema
    for s in stations:
        s.id = str(s.id)
    return stations


@router.post("/", response_model=StationResponse, status_code=201)
def create_station(
    station: StationCreate,
    db: Session = Depends(get_db)
):
    # Verificar código duplicado
    exists = db.query(Station).filter(
        Station.station_code == station.station_code
    ).first()
    if exists:
        raise HTTPException(
            status_code=400,
            detail=f"Ya existe una estación con código '{station.station_code}'"
        )

    db_station = Station(**station.model_dump())
    db.add(db_station)
    db.commit()
    db.refresh(db_station)
    db_station.id = str(db_station.id)
    return db_station


@router.get("/{station_id}", response_model=StationResponse)
def get_station(station_id: str, db: Session = Depends(get_db)):
    station = db.query(Station).filter(Station.id == station_id).first()
    if not station:
        raise HTTPException(status_code=404, detail="Estación no encontrada")
    station.id = str(station.id)
    return station


