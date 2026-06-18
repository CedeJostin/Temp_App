# Referencia de API — Meteorological API

Todas las rutas están prefijadas con `/api`. Salvo que se indique, las respuestas
son JSON. La documentación interactiva (Swagger UI) está en `/docs`.

> **Nota:** la API no implementa autenticación. Pensada para uso interno/local.

---

## Estaciones y variables — `/api/stations`

| Método | Ruta                          | Descripción                                  |
|--------|-------------------------------|----------------------------------------------|
| GET    | `/stations/variables/all`     | Lista todas las variables (TEMP, HR, …)      |
| GET    | `/stations/`                  | Lista todas las estaciones                   |
| POST   | `/stations/`                  | Crea una estación (valida código duplicado)  |
| GET    | `/stations/{station_id}`      | Obtiene una estación por UUID                |

**POST `/stations/`** — body:
```json
{
  "station_code": "EST001",
  "name": "Estación Central",
  "latitude": 9.93,
  "longitude": -84.08,
  "altitude_meters": 1150,
  "institution": "IMN"
}
```

---

## Carga de archivos — `/api/uploads`

| Método | Ruta                | Descripción                                            |
|--------|---------------------|--------------------------------------------------------|
| POST   | `/uploads/`         | Sube y procesa un CSV/Excel (ver pipeline de ingesta)  |
| GET    | `/uploads/history`  | Historial de archivos cargados (`?limit=1..100`)       |

**POST `/uploads/`** — `multipart/form-data`:
- Query: `station_id` (UUID, requerido), `variable_id` (UUID, opcional — si se
  omite se detecta automáticamente del contenido del archivo).
- Form: `file` (CSV o Excel).

Respuesta `200`:
```json
{
  "message": "Archivo procesado correctamente",
  "file_id": "…",
  "variable_type": "Temperatura",
  "rows_parsed": 8760,
  "rows_inserted": 8760,
  "logs": ["…"]
}
```
Errores: `422` si no se puede parsear o detectar la variable; `500` si falla la
inserción.

---

## Mediciones (CRUD/datos) — `/api/measurements`

| Método | Ruta                    | Descripción                                        |
|--------|-------------------------|----------------------------------------------------|
| GET    | `/measurements/`        | Lista con filtros y paginación                     |
| GET    | `/measurements/summary` | Resumen por estación + variable (desde summary_stats) |
| GET    | `/measurements/by-date` | Agregado por `hour`/`day`/`month`/`year`           |
| GET    | `/measurements/{id}`    | Una medición por ID                                |
| POST   | `/measurements/`        | Inserta una medición manual                        |
| DELETE | `/measurements/{id}`    | Elimina una medición                               |
| DELETE | `/measurements/`        | Elimina un rango (estación + variable + fechas)    |

**GET `/measurements/`** — query params:

| Param           | Tipo   | Default | Notas                              |
|-----------------|--------|---------|------------------------------------|
| `station_id`    | UUID   | —       | opcional                           |
| `variable_id`   | UUID   | —       | opcional                           |
| `variable_code` | string | —       | TEMP/HR/… (case-insensitive)       |
| `date_from`     | ISO    | —       | inclusive                          |
| `date_to`       | ISO    | —       | inclusive (hasta 23:59:59)         |
| `limit`         | int    | 1000    | 1–50000                            |
| `offset`        | int    | 0       | paginación                         |
| `order`         | string | asc     | `asc` / `desc`                     |

---

## Gráficas y análisis — `/api/measurements`

| Método | Ruta                                | Descripción                                          |
|--------|-------------------------------------|------------------------------------------------------|
| GET    | `/measurements/stats`               | Estadísticos + FDP + Gaussianas (T) o Betas (HR)     |
| POST   | `/measurements/stats/recalculate`   | Recalcula el ajuste desde las mediciones guardadas   |
| GET    | `/measurements/stats/summary-table` | Tabla de ajustes por estación (exportable)           |
| GET    | `/measurements/heatmap`             | Matriz mes × hora (o mes × semana)                   |
| GET    | `/measurements/daily-profile`       | Perfil diario promedio por mes (24h × 12 meses)      |
| GET    | `/measurements/annual-profile`      | Perfil anual promedio por día del año                |
| GET    | `/measurements/combined`            | Densidad T×HR, humedad absoluta, humectación         |

Parámetros comunes: `station_id` (requerido), `variable_code`, `date_from`,
`date_to`. `stats` y `summary-table` aceptan `n_components` (1–8). `combined`
acepta `altitude` (m).

> El orden de montaje en `api.py` registra `charts.py` **antes** que
> `measurements.py` para que estas rutas específicas no sean capturadas por el
> catch-all `GET /measurements/{measurement_id}`.

---

## Análisis de calidad — `/api/stations`

| Método | Ruta                                    | Descripción                                 |
|--------|-----------------------------------------|---------------------------------------------|
| GET    | `/stations/{station_id}/analysis`       | Análisis de calidad de T y HR               |
| GET    | `/stations/{station_id}/analysis/gaps`  | Huecos continuos > 5 días                   |

---

## Análisis local (sin persistir) — `/api/local-analysis`

| Método | Ruta                     | Descripción                                          |
|--------|--------------------------|------------------------------------------------------|
| POST   | `/local-analysis/file`   | Analiza un archivo individual (no guarda en BD)      |
| POST   | `/local-analysis/multi`  | Analiza T + HR + viento juntos (no guarda en BD)     |

---

## Salud

| Método | Ruta | Descripción            |
|--------|------|------------------------|
| GET    | `/`  | Healthcheck básico     |
