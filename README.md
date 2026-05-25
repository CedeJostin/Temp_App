# 🌤️ Aplicación de Análisis Meteorológico

Herramienta de depuración, modelado y visualización de datos de estaciones
meteorológicas.
---

## Instalación rápida

```bash
pip install -r requirements.txt

uvicorn app.main:app --reload

```

---

## ▶️ Ejecutar la aplicación

```bash
cd Frontend
npm install
npm run dev
```

Se abrirá en el localhost

---

## 📋 Formato del archivo de datos

El archivo (CSV o Excel) debe tener columnas con nombres que contengan:

| Columna    | Nombres aceptados                    | Descripción              |
|------------|--------------------------------------|--------------------------|
| Año        | `año`, `anio`, `year`                | Año (ej: 2015)           |
| Mes        | `mes`, `month`                       | Mes (1–12)               |
| Día        | `dia`, `día`, `day`                  | Día (1–31)               |
| Hora       | `hora`, `hour`, `hh`                 | Hora (0–23)              |
| Temperatura| `temp`, `T`                          | °C                       |
| Humedad    | `hum`, `HR`, `RH`                    | % (0–100)                |

También acepta una columna con fecha completa tipo `2015-01-15 08:00:00`.

---

## 📊 Funcionalidades implementadas

### 1. Depuración de datos
- Eliminación de valores negativos de T y HR
- Cálculo de % de completitud con indicador de color
- Detección de huecos continuos > 5 días
- Estadísticos: media, desv, mín, máx, Q25, Q75

### 2. Gráficos de control
- Serie temporal T y HR con límites ±3σ
- Marcado automático de valores anómalos

### 3. FDP de Temperatura
- Ajuste por suma de curvas Gaussianas (N configurable)
- Métricas: RMSE, R²
- Tabla de parámetros (μ, σ, peso) por curva

### 4. FDP de Humedad Relativa
- Ajuste por suma de curvas Beta (N configurable)
- Métricas: RMSE, R²
- Tabla de parámetros (α, β, moda, varianza, peso) por curva

### 5. Mapas de calor
- Mapa de calor Hora × Mes para T y HR
- Gráfico de variación diaria promedio con rangos

### 6. Análisis combinado T–HR
- Densidad 2D con isolíneas
- Tiempo de humectación (T>10°C, HR>79%)
- Correlación Pearson T–HR
- Variación mensual doble eje

---

## 🛠️ Próximas funcionalidades (v2)
- Análisis de viento (Weibull multimodal)
- Gráfico psicrométrico
- Exportación de resultados a Excel
- Comparación entre estaciones
- Base de datos SQLite para múltiples estaciones
