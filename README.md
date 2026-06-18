# 🌤️ Aplicación de Análisis Meteorológico

Plataforma para **depurar, modelar y visualizar** datos de estaciones
meteorológicas (temperatura, humedad relativa, radiación y viento) a partir de
archivos CSV/Excel.

El proyecto es un **monorepo** con dos partes:

| Carpeta     | Qué es                | Stack                                            |
|-------------|-----------------------|--------------------------------------------------|
| `Backend/`  | API REST              | FastAPI · SQLAlchemy · PostgreSQL · NumPy/SciPy  |
| `Frontend/` | Interfaz web (SPA)    | React 19 · Vite · TailwindCSS · Recharts/Plotly  |

```
Temp_App/
├── Backend/    → API, parseo de archivos, cálculo y persistencia
├── Frontend/   → Dashboard, carga de archivos y gráficas
└── README.md   → este archivo
```

---

## ✅ Requisitos previos

- **Python** 3.12+ y **PostgreSQL** (para el backend)
- **Node.js** 18+ (para el frontend)

---

## 🚀 Puesta en marcha

### 1. Backend (puerto 8000)

```bash
cd Backend
python -m venv .venv
.venv/Scripts/activate            # Windows (Linux/Mac: source .venv/bin/activate)
pip install -r requirements.txt
cp .env.example .env              # editar DATABASE_URL
uvicorn app.main:app --reload --port 8000
```

Documentación detallada del backend: [Backend/docs/ARCHITECTURE.md](Backend/docs/ARCHITECTURE.md)
y referencia de endpoints en [Backend/docs/API.md](Backend/docs/API.md).
Swagger interactivo en `http://localhost:8000/docs`.

### 2. Frontend (puerto 5173)

```bash
cd Frontend
npm install
npm run dev
```

Se abre en `http://localhost:5173`. Por defecto consume la API en
`http://localhost:8000/api`; configurable con `VITE_API_URL` (ver
[Frontend/README.md](Frontend/README.md)).

---

## 📋 Formato del archivo de datos

El backend detecta el formato automáticamente. El archivo (CSV o Excel) debe
incluir columnas de fecha y horarias, o una columna de fecha-hora completa.

| Columna     | Nombres aceptados                    | Descripción              |
|-------------|--------------------------------------|--------------------------|
| Año         | `año`, `anio`, `year`                | Año (ej: 2015)           |
| Mes         | `mes`, `month`                       | Mes (1–12)               |
| Día         | `dia`, `día`, `day`                  | Día (1–31)               |
| Horas       | `H1`…`H24`, `01:00`…`24:00`, `1:00`… | Una columna por hora     |
| Fecha/Hora  | `fecha` + `hora`                     | Alternativa a lo anterior|

La **variable** (Temperatura, Humedad, Radiación o Viento) se detecta a partir
del nombre del archivo o de los encabezados. También se acepta una columna con
fecha completa tipo `2015-01-15 08:00:00`.

---

## 📊 Funcionalidades

### Depuración de datos
- Eliminación de valores negativos de T y HR
- Cálculo de % de completitud con indicador de color
- Detección de huecos continuos > 5 días
- Estadísticos: media, desviación, mín, máx, Q25, Q75, moda

### Gráficos de control
- Serie temporal de T y HR con límites ±3σ y marcado de anomalías

### FDP de Temperatura
- Ajuste por suma de curvas **Gaussianas** (N configurable), con R² y MSE
- Tabla de parámetros (μ, σ, peso) por curva

### FDP de Humedad Relativa
- Ajuste por suma de curvas **Beta generalizadas** (incluye saturación a 100%)
- Tabla de parámetros (α, β, moda, varianza, peso) por curva

### Mapas de calor y perfiles
- Mapa de calor Mes × Hora para T y HR
- Perfil diario promedio por mes y perfil anual por día del año

### Análisis combinado T–HR
- Densidad 2D con isolíneas
- Humedad absoluta y tiempo de humectación (T > 10 °C, HR > 79 %)
- Variación mensual

---

## 🗄️ Persistencia

Los datos se almacenan en **PostgreSQL**. Tras cada carga, el backend precalcula
tablas de estadísticas (diarias, mensuales, mapa de calor, distribución, perfiles
y combinadas) para servir las gráficas de forma instantánea. Ver el
[modelo de datos](Backend/docs/ARCHITECTURE.md#3-modelo-de-datos).

---

## 🛠️ Próximas funcionalidades
- Análisis de viento (Weibull multimodal)
- Gráfico psicrométrico
- Exportación de resultados a Excel
- Comparación entre estaciones
