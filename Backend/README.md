# Meteorological API — Backend

API REST (FastAPI + SQLAlchemy + PostgreSQL) para ingerir archivos CSV/Excel
meteorológicos, almacenarlos y servir análisis estadísticos y gráficas
(temperatura, humedad relativa, radiación y viento).

## Inicio rápido

```bash
cd Backend
python -m venv .venv
.venv/Scripts/activate            # Windows (Linux/Mac: source .venv/bin/activate)
pip install -r requirements.txt
cp .env.example .env              # editar DATABASE_URL
uvicorn app.main:app --reload --port 8000
```

- Swagger UI: http://localhost:8000/docs
- Healthcheck: http://localhost:8000/

## Documentación

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — arquitectura, estructura,
  diagramas (capas, modelo de datos ER, flujo de ingesta).
- [docs/API.md](docs/API.md) — referencia completa de endpoints.

## Variables de entorno

Ver [.env.example](.env.example). La única obligatoria es `DATABASE_URL`; el
arranque falla con un mensaje claro si no está definida.
