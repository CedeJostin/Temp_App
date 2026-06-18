# Frontend — Análisis Meteorológico

Interfaz web (SPA) en **React 19 + Vite** para cargar archivos, explorar
mediciones y visualizar el análisis estadístico que expone el
[backend](../Backend/README.md).

## Stack

| Área         | Tecnología                                  |
|--------------|---------------------------------------------|
| UI           | React 19                                    |
| Bundler/dev  | Vite 8                                       |
| Routing      | React Router 7                              |
| Estilos      | TailwindCSS 4                               |
| Gráficas     | Recharts · Plotly.js · D3                   |
| Iconos       | lucide-react                                |
| Carga archivos | react-dropzone                            |

El cliente HTTP vive en [`src/services/api.js`](src/services/api.js) y usa `fetch`.

## Requisitos

- Node.js 18+
- El [backend](../Backend/README.md) corriendo (por defecto en `http://localhost:8000`).

## Puesta en marcha

```bash
npm install
npm run dev          # arranca en http://localhost:5173
```

## Scripts

| Comando           | Descripción                          |
|-------------------|--------------------------------------|
| `npm run dev`     | Servidor de desarrollo con HMR       |
| `npm run build`   | Build de producción en `dist/`       |
| `npm run preview` | Sirve el build de producción         |
| `npm run lint`    | Linter (ESLint)                      |

## Configuración

La URL base de la API se toma de la variable de entorno `VITE_API_URL`
(con fallback a `http://localhost:8000/api`). Para apuntar a otro backend,
crea un archivo `.env` en `Frontend/`:

```
VITE_API_URL=http://mi-servidor:8000/api
```

> El backend solo permite CORS desde los orígenes definidos en su `CORS_ORIGINS`
> (por defecto `http://localhost:5173`). Si cambias el puerto del frontend,
> actualiza también esa variable en el backend.

## Estructura y rutas

```
src/
├── App.jsx              # Define el enrutado
├── components/layout/   # Sidebar y layout
├── pages/               # Una vista por ruta
└── services/api.js      # Llamadas a la API del backend
```

| Ruta             | Página         | Descripción                              |
|------------------|----------------|------------------------------------------|
| `/`              | Dashboard      | Resumen y series por estación            |
| `/upload`        | Upload         | Carga de archivos CSV/Excel              |
| `/stations`      | Stations       | Gestión de estaciones                    |
| `/measurements`  | Measurements   | Exploración de mediciones                |
| `/analysis`      | Analysis       | FDP, mapas de calor, perfiles, combinado |
| `/Dataanalysis`  | Dataanalysis   | Análisis local (sin persistir en BD)     |
