import io
import warnings
 
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots
from scipy.optimize import minimize
from scipy.stats import beta as beta_dist
from scipy.stats import norm
 
warnings.filterwarnings("ignore")
 
# ═══════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════
 
st.set_page_config(
    page_title="Análisis Meteorológico",
    page_icon="🌤️",
    layout="wide"
)
 
st.markdown("""
<style>
.main-header{
    font-size:2rem; font-weight:700;
    background:linear-gradient(90deg,#1a6fa8,#2ecc71);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent;
}
.stTabs [data-baseweb="tab"]{ font-size:0.9rem; font-weight:600; }
</style>
""", unsafe_allow_html=True)
 
# Columnas de hora – Formato B (01:00 … 24:00)
HOUR_COLS_B = [f"{i:02d}:00" for i in range(1, 25)]
# Variantes sin cero inicial o con ":00:00" al final (24:00:00 aparece a veces)
HOUR_COLS_B_ALT = [f"{i}:00" for i in range(1, 25)] + ["24:00:00"]
 
# Columnas de hora – Formato A (H1 … H24)
HOUR_COLS_A = [f"H{i}" for i in range(1, 25)]
 
MONTH_NAMES = ["Ene","Feb","Mar","Abr","May","Jun",
               "Jul","Ago","Sep","Oct","Nov","Dic"]
 
# ═══════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════
 
def norm_text(txt):
    return (str(txt).lower()
            .replace("á","a").replace("é","e").replace("í","i")
            .replace("ó","o").replace("ú","u").replace("ñ","n")
            .replace("°","").replace("º","").strip())
 
def completeness_badge(pct):
    if pct >= 98: return "🟢 Excelente [98-100%)"
    if pct >= 95: return "🔵 Bueno [95-98%)"
    if pct >= 90: return "🟡 Aceptable [90-95%)"
    if pct >= 85: return "🟠 Bajo [85-90%)"
    return             "🔴 Crítico (<85%)"
 
def to_float_col(series):
    """Convierte una columna a float manejando coma decimal."""
    return pd.to_numeric(
        series.astype(str).str.replace(",", ".", regex=False).str.strip(),
        errors="coerce"
    )
 
# ═══════════════════════════════════════════════════════════════════════
# DETECCIÓN DE TIPO
# ═══════════════════════════════════════════════════════════════════════
 
def detect_type_from_text(text):
    t = norm_text(text)
    if "temperatura" in t:                        return "Temperatura"
    if "humedad" in t:                            return "Humedad"
    if "radiaci" in t or "mj" in t:              return "Radiacion"
    if "viento" in t or "velocidad" in t or "direccion" in t: return "Viento"
    if "lluvia" in t or "precipit" in t:          return "Lluvia"
    # nombres de hoja conocidos (Formato A)
    if "temp" in t:                               return "Temperatura"
    if "hum" in t:                                return "Humedad"
    if "rad" in t:                                return "Radiacion"
    if "lluv" in t or "prec" in t:               return "Lluvia"
    return "UNKNOWN"
 
def detect_type_from_cols(df):
    t = norm_text(" ".join(str(c) for c in df.columns))
    return detect_type_from_text(t)
 
# ═══════════════════════════════════════════════════════════════════════
# NORMALIZAR NOMBRES DE COLUMNAS DE FECHA
# ═══════════════════════════════════════════════════════════════════════
 
def rename_date_cols(df):
    rename = {}
    for c in df.columns:
        cl = norm_text(c).replace(" ", "")
        if cl in ["ano","anio","year","a","año"]: rename[c] = "_year"
        elif cl in ["mes","month","m"]:           rename[c] = "_month"
        elif cl in ["dia","day","d","día"]:       rename[c] = "_day"
    return df.rename(columns=rename)
 
# ═══════════════════════════════════════════════════════════════════════
# DETECTAR FORMATO Y COLUMNAS DE HORA
# ═══════════════════════════════════════════════════════════════════════
 
def detect_hour_cols(df):
    """
    Retorna (hour_cols, formato) donde formato es 'A' o 'B'.
    Formato A: H1…H24
    Formato B: 01:00…24:00  (con variantes sin cero o con :00 extra)
    """
    cols_upper = {c: str(c).strip() for c in df.columns}
 
    # Formato A: H1…H24 (case-insensitive)
    found_a = [c for c, v in cols_upper.items()
               if v.upper() in [f"H{i}" for i in range(1, 25)]]
    if len(found_a) >= 12:
        # Ordenar por número
        found_a.sort(key=lambda c: int(str(c).upper().replace("H","")))
        return found_a, "A"
 
    # Formato B: 01:00 / 1:00 / 24:00:00
    all_b = set(HOUR_COLS_B + HOUR_COLS_B_ALT)
    found_b = [c for c, v in cols_upper.items() if v in all_b]
    if len(found_b) >= 12:
        def sort_key(c):
            v = str(c).replace(":00:00","").replace(":00","")
            try: return int(v)
            except: return 99
        found_b.sort(key=sort_key)
        return found_b, "B"
 
    return [], "UNKNOWN"
 
# ═══════════════════════════════════════════════════════════════════════
# PARSER ANCHO → LARGO  (soporta Formato A y B)
# ═══════════════════════════════════════════════════════════════════════
 
def wide_to_long(df, value_name):
    hour_cols, fmt = detect_hour_cols(df)
    if not hour_cols:
        return None
 
    df = rename_date_cols(df)
    missing = [c for c in ["_year","_month","_day"] if c not in df.columns]
    if missing:
        return None
 
    # Convertir columnas de fecha a numérico
    for fc in ["_year","_month","_day"]:
        df[fc] = pd.to_numeric(df[fc], errors="coerce")
    df = df.dropna(subset=["_year","_month","_day"]).copy()
    df[["_year","_month","_day"]] = df[["_year","_month","_day"]].astype(int)
 
    melted = df.melt(
        id_vars=["_year","_month","_day"],
        value_vars=hour_cols,
        var_name="_hora_str",
        value_name=value_name
    )
 
    melted[value_name] = to_float_col(melted[value_name])
 
    # Extraer número de hora según formato
    def hora_num(s):
        s = str(s).strip().upper()
        if fmt == "A":
            # H1 → 1, H24 → 24
            return int(s.replace("H",""))
        else:
            # 01:00, 1:00, 24:00:00 → número
            s = s.replace(":00:00","").replace(":00","")
            return int(s)
 
    hora_int  = melted["_hora_str"].apply(hora_num)
    extra_day = (hora_int == 24).astype(int)
    hora_int  = hora_int % 24
 
    base = pd.to_datetime(dict(
        year  = melted["_year"],
        month = melted["_month"],
        day   = melted["_day"]
    ), errors="coerce")
 
    melted["_dt"] = (base
                     + pd.to_timedelta(hora_int, "h")
                     + pd.to_timedelta(extra_day, "d"))
 
    return (melted[["_dt", value_name]]
            .dropna(subset=["_dt"])
            .sort_values("_dt")
            .reset_index(drop=True))
 
# ═══════════════════════════════════════════════════════════════════════
# PARSER VIENTO  (Fecha;Hora;Dir;Velocidad;Grados)
# ═══════════════════════════════════════════════════════════════════════
 
def parse_wind(df):
    fecha_col = None
    for c in df.columns:
        try:
            p = pd.to_datetime(df[c], dayfirst=True, errors="coerce")
            if p.notna().mean() > 0.5:
                fecha_col = c
                break
        except: pass
    if fecha_col is None:
        return None
 
    fechas = pd.to_datetime(df[fecha_col], dayfirst=True, errors="coerce")
 
    hora_col = None
    for c in df.columns:
        if c == fecha_col: continue
        nc = norm_text(c)
        if nc in ("hora","hour"):
            hora_col = c; break
        if df[c].astype(str).str.match(r"^\d{1,2}:\d{2}$").mean() > 0.5:
            hora_col = c; break
 
    if hora_col:
        horas = (df[hora_col].astype(str)
                 .str.replace(":00","",regex=False).str.strip())
        horas = pd.to_numeric(horas, errors="coerce").fillna(0).astype(int) % 24
        dt = fechas + pd.to_timedelta(horas, unit="h")
    else:
        dt = fechas
 
    out = pd.DataFrame({"_dt": dt})
 
    for c in df.columns:
        nc = norm_text(c).replace(" ","")
        if "veloc" in nc or "m/s" in nc:
            out["velocidad"] = to_float_col(df[c])
        if "grado" in nc or ("direcc" in nc and "grado" in nc):
            out["dir_grados"] = to_float_col(df[c])
        if "predomin" in nc or ("direcc" in nc and "grado" not in nc and "velocidad" not in nc):
            out["dir_texto"] = df[c].astype(str)
 
    return out.dropna(subset=["_dt"]).sort_values("_dt").reset_index(drop=True)
 
# ═══════════════════════════════════════════════════════════════════════
# LEER CSV  –  detecta Formato A y Formato B automáticamente
# ═══════════════════════════════════════════════════════════════════════
 
def read_csv_file(file_bytes, filename):
    results = {}
    logs    = []
 
    for enc in ["latin1","utf-8","cp1252"]:
        try:
            # ── Intentar leer fila 0 para detectar tipo (Formato B) ──────
            row0 = pd.read_csv(
                io.BytesIO(file_bytes), sep=";", encoding=enc,
                header=None, nrows=1
            )
            row0_text = " ".join(str(v) for v in row0.iloc[0].values if pd.notna(v))
            vtype = detect_type_from_text(row0_text)
 
            # Si no detectado, intentar por nombre de archivo
            if vtype == "UNKNOWN":
                vtype = detect_type_from_text(filename)
 
            # ── Leer con header=1 (Formato B) y probar ───────────────────
            df_b = pd.read_csv(
                io.BytesIO(file_bytes), sep=";", encoding=enc,
                header=1, decimal=","
            )
            _, fmt_b = detect_hour_cols(df_b)
 
            # ── Leer con header=0 (Formato A) y probar ───────────────────
            df_a = pd.read_csv(
                io.BytesIO(file_bytes), sep=";", encoding=enc,
                header=0, decimal=","
            )
            _, fmt_a = detect_hour_cols(df_a)
 
            # Elegir el formato que tenga columnas de hora válidas
            if fmt_b in ("A","B"):
                df_use = df_b
                fmt_use = fmt_b
            elif fmt_a in ("A","B"):
                df_use = df_a
                fmt_use = fmt_a
                # Re-detectar tipo con columnas reales (Formato A no tiene fila de tipo)
                if vtype == "UNKNOWN":
                    vtype = detect_type_from_cols(df_use)
                # También re-intentar por nombre si sigue UNKNOWN
                if vtype == "UNKNOWN":
                    vtype = detect_type_from_text(filename)
            else:
                # Puede ser viento
                df_use = df_b
                fmt_use = "WIND"
 
            if vtype in ("Temperatura","Humedad","Radiacion","Lluvia"):
                parsed = wide_to_long(df_use, vtype)
            elif vtype == "Viento":
                df_wind = pd.read_csv(
                    io.BytesIO(file_bytes), sep=";", encoding=enc, header=0)
                parsed = parse_wind(df_wind)
            else:
                logs.append(f"⚠️ {filename}: tipo no detectado (row0='{row0_text[:60]}')")
                return results, logs
 
            if parsed is not None and len(parsed) > 0:
                results[vtype] = parsed
                logs.append(f"✅ {filename} → {vtype} fmt={fmt_use} ({len(parsed):,} registros)")
            else:
                logs.append(f"⚠️ {filename}: parseado vacío (vtype={vtype}, fmt={fmt_use})")
            break
 
        except Exception as e:
            logs.append(f"⚠️ {filename} enc={enc}: {e}")
            continue
 
    return results, logs
 
# ═══════════════════════════════════════════════════════════════════════
# LEER EXCEL  –  soporta Formato A y B por hoja
# ═══════════════════════════════════════════════════════════════════════
 
def read_excel_file(file_bytes, filename):
    results = {}
    logs    = []
    xl = pd.ExcelFile(io.BytesIO(file_bytes))
 
    for sname in xl.sheet_names:
        try:
            raw = xl.parse(sname, header=None)
            if raw.empty or len(raw) < 3:
                continue
 
            row0_text = " ".join(str(v) for v in raw.iloc[0].values if pd.notna(v))
            vtype = detect_type_from_text(row0_text)
 
            # ── Probar Formato B: encabezado en fila 1 ───────────────────
            df_b = xl.parse(sname, header=1).dropna(how="all").reset_index(drop=True)
            _, fmt_b = detect_hour_cols(df_b)
 
            # ── Probar Formato A: encabezado en fila 0 ───────────────────
            df_a = xl.parse(sname, header=0).dropna(how="all").reset_index(drop=True)
            _, fmt_a = detect_hour_cols(df_a)
 
            # Elegir formato con columnas de hora detectadas
            if fmt_b in ("A","B"):
                df_use = df_b
                fmt_use = fmt_b
            elif fmt_a in ("A","B"):
                df_use = df_a
                fmt_use = fmt_a
                if vtype == "UNKNOWN":
                    vtype = detect_type_from_cols(df_use)
                if vtype == "UNKNOWN":
                    vtype = detect_type_from_text(sname)
            else:
                # Buscar la fila que contiene Año/Mes (Formato B con offset)
                header_row = 1
                for i, row in raw.iterrows():
                    rt = norm_text(" ".join(str(v) for v in row.values if pd.notna(v)))
                    if any(k in rt for k in ["ano","mes","fecha","year","month"]):
                        header_row = i
                        break
                df_use = xl.parse(sname, header=header_row).dropna(how="all").reset_index(drop=True)
                _, fmt_use = detect_hour_cols(df_use)
 
            if vtype == "UNKNOWN":
                vtype = detect_type_from_text(sname)
 
            if vtype in ("Temperatura","Humedad","Radiacion","Lluvia"):
                parsed = wide_to_long(df_use, vtype)
            elif vtype == "Viento":
                parsed = parse_wind(df_use)
            else:
                logs.append(f"⚠️ '{sname}': tipo desconocido (intentando por nombre...)")
                continue
 
            if parsed is not None and len(parsed) > 0:
                results[vtype] = parsed
                logs.append(f"✅ '{sname}' → {vtype} fmt={fmt_use} ({len(parsed):,} registros)")
            else:
                logs.append(f"⚠️ '{sname}': parseado vacío (vtype={vtype}, fmt={fmt_use})")
 
        except Exception as e:
            logs.append(f"❌ '{sname}': {e}")
 
    return results, logs
 
# ═══════════════════════════════════════════════════════════════════════
# FDP – GAUSSIANAS
# ═══════════════════════════════════════════════════════════════════════
 
def gaussian(x, mu, sig, w):
    return w * norm.pdf(x, mu, sig)
 
def fit_gaussians(series, n=2):
    v = series.dropna()
    counts, edges = np.histogram(v, bins=80, density=True)
    xc = (edges[:-1] + edges[1:]) / 2
 
    p0 = []
    for mu in np.linspace(v.quantile(0.2), v.quantile(0.8), n):
        p0 += [float(mu), float(v.std()/n), 1.0/n]
 
    def loss(p):
        y = sum(gaussian(xc, p[3*i], abs(p[3*i+1]), abs(p[3*i+2])) for i in range(n))
        return float(np.sqrt(np.mean((counts - y)**2)))
 
    bounds = [(float(v.min()), float(v.max())),
              (0.01, float(v.std()*3)),
              (0.001, 1.0)] * n
    cons = [{"type":"eq","fun": lambda p: sum(p[2::3]) - 1}]
    res  = minimize(loss, p0, bounds=bounds, constraints=cons, method="SLSQP",
                    options={"maxiter":500})
    return xc, counts, res.x, res.fun
 
# ═══════════════════════════════════════════════════════════════════════
# FDP – BETA
# ═══════════════════════════════════════════════════════════════════════
 
def beta_pdf(x, a, b, w, lo=0, hi=100):
    xs = np.clip((x - lo) / (hi - lo), 1e-6, 1-1e-6)
    return w * beta_dist.pdf(xs, a, b) / (hi - lo)
 
def fit_betas(series, n=2):
    v = series.dropna()
    counts, edges = np.histogram(v, bins=100, range=(0,100), density=True)
    xc = (edges[:-1] + edges[1:]) / 2
    p0 = [3.0, 3.0, 1.0/n] * n
 
    def loss(p):
        y = sum(beta_pdf(xc, abs(p[3*i]), abs(p[3*i+1]), abs(p[3*i+2])) for i in range(n))
        return float(np.sqrt(np.mean((counts - y)**2)))
 
    bounds = [(0.1, 50), (0.1, 50), (0.001, 1.0)] * n
    cons   = [{"type":"eq","fun": lambda p: sum(p[2::3]) - 1}]
    res    = minimize(loss, p0, bounds=bounds, constraints=cons, method="SLSQP",
                      options={"maxiter":500})
    return xc, counts, res.x, res.fun
 
# ═══════════════════════════════════════════════════════════════════════
# SESSION STATE
# ═══════════════════════════════════════════════════════════════════════
 
if "sheets" not in st.session_state:
    st.session_state.sheets = {}
if "loaded_names" not in st.session_state:
    st.session_state.loaded_names = set()
 
# ═══════════════════════════════════════════════════════════════════════
# SIDEBAR
# ═══════════════════════════════════════════════════════════════════════
 
with st.sidebar:
    st.markdown("## 🌤️ Análisis Meteorológico")
    st.markdown("---")
 
    uploaded_files = st.file_uploader(
        "Sube archivos CSV o Excel",
        type=["csv","xlsx","xls"],
        accept_multiple_files=True
    )
 
    process_btn = st.button("📥 Cargar datos", type="primary")
 
    if process_btn and uploaded_files:
        all_sheets = {}
        all_logs   = []
 
        with st.spinner("Procesando archivos..."):
            for f in uploaded_files:
                fbytes = f.read()
                if f.name.lower().endswith(".csv"):
                    data, logs = read_csv_file(fbytes, f.name)
                else:
                    data, logs = read_excel_file(fbytes, f.name)
                all_logs.extend(logs)
 
                for key, val in data.items():
                    if val is None or len(val) == 0: continue
                    if key in all_sheets:
                        all_sheets[key] = pd.concat(
                            [all_sheets[key], val], ignore_index=True)
                    else:
                        all_sheets[key] = val
 
        # Deduplicar y ordenar
        for key in all_sheets:
            all_sheets[key] = (all_sheets[key]
                               .drop_duplicates(subset=["_dt"])
                               .sort_values("_dt")
                               .reset_index(drop=True))
 
        st.session_state.sheets = all_sheets
 
        for msg in all_logs:
            if msg.startswith("✅"): st.success(msg)
            elif msg.startswith("⚠️"): st.warning(msg)
            else: st.error(msg)
 
    st.markdown("---")
    st.markdown("### ⚙️ Configuración")
    n_gauss = st.slider("Curvas Gaussianas (T)",  1, 4, 2)
    n_beta  = st.slider("Curvas Beta (HR)",        1, 4, 2)
    alt_z   = st.number_input("Altitud estación (m)", value=926.0, step=1.0)
 
# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════
 
st.markdown('<div class="main-header">🌤️ Análisis de Datos Meteorológicos</div>',
            unsafe_allow_html=True)
 
sheets = st.session_state.sheets
 
if not sheets:
    st.info("👈 Sube tus archivos y presiona **'Cargar datos'**")
    st.markdown("""
| Formato | Encabezado | Columnas de hora | Ejemplo hoja/archivo |
|---|---|---|---|
| **A** (nuevo) | `año mes dia H1 H2 … H24` | `H1`–`H24` | `temp_prom_horaria` |
| **B** (original) | Fila 0: tipo; Fila 1: `Año Mes Día 01:00…24:00` | `01:00`–`24:00` | cualquier CSV anterior |
| **Viento** | `Fecha;Hora;Dirección;Velocidad;Grados` | — | columna por columna |
 
La app detecta el tipo por: nombre de hoja, nombre de archivo o contenido de la primera fila.
""")
    st.stop()
 
df_T    = sheets.get("Temperatura")
df_HR   = sheets.get("Humedad")
df_RAD  = sheets.get("Radiacion")
df_WIND = sheets.get("Viento")
has_T    = df_T    is not None and len(df_T) > 0
has_HR   = df_HR   is not None and len(df_HR) > 0
has_RAD  = df_RAD  is not None and len(df_RAD) > 0
has_WIND = df_WIND is not None and len(df_WIND) > 0
 
COLORS_G = ["#e74c3c","#e67e22","#9b59b6","#1abc9c"]
COLORS_B = ["#2980b9","#27ae60","#8e44ad","#e67e22"]
 
# Debug
with st.expander("📂 Datos cargados"):
    for k, v in sheets.items():
        st.write(f"**{k}**: {len(v):,} filas | cols: {list(v.columns)}")
        st.dataframe(v.head(4))
 
# ═══════════════════════════════════════════════════════════════════════
# TABS
# ═══════════════════════════════════════════════════════════════════════
 
tabs = st.tabs([
    "📊 Depuración",
    "📈 Control",
    "🔔 FDP Temperatura",
    "💧 FDP Humedad",
    "🗺️ Mapas de Calor",
    "💨 Viento",
    "🔗 Combinado T–HR"
])
 
# ─────────────────────────────────────────────────────────────────────
# TAB 0 – DEPURACIÓN
# ─────────────────────────────────────────────────────────────────────
with tabs[0]:
    st.markdown("## 📊 Depuración y Estadísticos")
    st.markdown("""
Eliminación de valores negativos o inválidos,
cálculo de completitud por rangos de color, y detección de huecos > 5 días.
""")
 
    for label, dv, col, lo, hi, units in [
        ("Temperatura",     df_T,   "Temperatura", -5,  60,  "°C"),
        ("Humedad Relativa",df_HR,  "Humedad",      0, 100,  "%"),
        ("Radiación Global",df_RAD, "Radiacion",    0, None, "MJ/m²"),
    ]:
        if dv is None or col not in dv.columns: continue
        st.markdown(f"### {label}")
 
        s = pd.to_numeric(dv[col], errors="coerce").copy()
        s[s < lo] = np.nan
        if hi: s[s > hi] = np.nan
 
        valid  = int(s.notna().sum())
        total  = len(s)
        dt_min = dv["_dt"].min()
        dt_max = dv["_dt"].max()
        ideal  = int((dt_max - dt_min).total_seconds() / 3600) + 1
        pct    = min(valid / ideal * 100, 100) if ideal > 0 else 0.0
 
        c1,c2,c3,c4,c5 = st.columns(5)
        c1.metric("Válidos",       f"{valid:,}")
        c2.metric("Faltantes",     f"{total-valid:,}")
        c3.metric("% Completitud", f"{pct:.1f}%")
        c4.metric("Período",       f"{dt_min.year}–{dt_max.year}")
        c5.metric("Estado",        completeness_badge(pct))
 
        if valid > 0:
            sv = s.dropna()
            c1b,c2b,c3b,c4b,c5b,c6b = st.columns(6)
            c1b.metric("Mínimo",   f"{sv.min():.2f} {units}")
            c2b.metric("Q25",      f"{sv.quantile(.25):.2f}")
            c3b.metric("Media",    f"{sv.mean():.2f}")
            c4b.metric("Mediana",  f"{sv.median():.2f}")
            c5b.metric("Q75",      f"{sv.quantile(.75):.2f}")
            c6b.metric("Máximo",   f"{sv.max():.2f} {units}")
 
        # Detección huecos > 5 días
        tmp = dv[["_dt"]].copy()
        tmp[col] = s.values
        tmp = tmp.dropna(subset=[col]).sort_values("_dt")
        diffs = tmp["_dt"].diff()
        big   = diffs[diffs > pd.Timedelta(days=5)]
        if len(big):
            st.warning(f"⚠️ {len(big)} hueco(s) > 5 días detectado(s)")
            rows = []
            for idx in big.index:
                start = tmp["_dt"].iloc[idx-1]
                end   = tmp["_dt"].iloc[idx]
                rows.append({"Inicio":str(start.date()),
                             "Fin":str(end.date()),
                             "Días perdidos":(end-start).days})
            st.dataframe(pd.DataFrame(rows), use_container_width=True)
        else:
            st.success(f"✅ Sin huecos continuos > 5 días en {label}")
        st.markdown("---")
 
# ─────────────────────────────────────────────────────────────────────
# TAB 1 – GRÁFICOS DE CONTROL
# ─────────────────────────────────────────────────────────────────────
with tabs[1]:
    st.markdown("## 📈 Gráficos de Control – Serie Temporal")
    st.markdown("Serie temporal con límites ±3σ. Puntos rojos = valores anómalos.")
 
    for label, dv, col, color, units in [
        ("Temperatura",     df_T,   "Temperatura","#e74c3c","°C"),
        ("Humedad Relativa",df_HR,  "Humedad",    "#2980b9","%"),
        ("Radiación Global",df_RAD, "Radiacion",  "#f39c12","MJ/m²"),
    ]:
        if dv is None or col not in dv.columns: continue
 
        s  = dv.dropna(subset=[col]).sort_values("_dt")
        mu  = s[col].mean()
        sig = s[col].std()
        an  = s[np.abs(s[col] - mu) > 3*sig]
 
        fig = go.Figure()
        fig.add_trace(go.Scatter(
            x=s["_dt"], y=s[col], mode="lines", name=label,
            line=dict(color=color, width=0.8), opacity=0.75))
        fig.add_hline(y=mu,         line_dash="dash", line_color="gray",
                      annotation_text=f"Media={mu:.1f}")
        fig.add_hline(y=mu + 3*sig, line_dash="dot",  line_color="orange",
                      annotation_text=f"+3σ={mu+3*sig:.1f}")
        fig.add_hline(y=mu - 3*sig, line_dash="dot",  line_color="orange",
                      annotation_text=f"−3σ={mu-3*sig:.1f}")
        if len(an):
            fig.add_trace(go.Scatter(
                x=an["_dt"], y=an[col], mode="markers",
                name=f"Anómalos ({len(an)})",
                marker=dict(color="red", size=5, symbol="x")))
        fig.update_layout(
            title=f"{label} vs Tiempo  |  Anómalos >3σ: {len(an)}",
            xaxis_title="Fecha", yaxis_title=f"{label} ({units})",
            height=420, template="plotly_white",
            legend=dict(orientation="h", y=1.08))
        st.plotly_chart(fig, use_container_width=True)
 
# ─────────────────────────────────────────────────────────────────────
# TAB 2 – FDP TEMPERATURA
# ─────────────────────────────────────────────────────────────────────
with tabs[2]:
    st.markdown("## 🔔 FDP – Temperatura (Curvas Gaussianas)")
    st.markdown("""
La FDP de T se modela como suma de curvas gaussianas.
Se optimizan: media (μ), desviación (σ) y peso (w) de cada curva.
Criterios: **RMSE < 1E-3**, **R² > 0.95**, **Σpesos = 1**.
""")
 
    if not has_T:
        st.info("No se cargaron datos de Temperatura.")
    else:
        with st.spinner("Ajustando gaussianas..."):
            try:
                xc, yc, params, rmse = fit_gaussians(df_T["Temperatura"], n=n_gauss)
 
                fig = go.Figure()
                fig.add_trace(go.Bar(x=xc, y=yc, name="FDP observada",
                    marker_color="lightsteelblue", opacity=0.65))
 
                y_sum = np.zeros_like(xc, dtype=float)
                rows  = []
                for i in range(n_gauss):
                    mu_i  = params[3*i]
                    sig_i = abs(params[3*i+1])
                    w_i   = abs(params[3*i+2])
                    yg    = gaussian(xc, mu_i, sig_i, w_i)
                    y_sum += yg
                    fig.add_trace(go.Scatter(
                        x=xc, y=yg, mode="lines",
                        name=f"G{i+1}: μ={mu_i:.2f}°C  σ={sig_i:.2f}  w={w_i:.3f}",
                        line=dict(color=COLORS_G[i%4], width=2.5)))
                    rows.append({
                        "Curva": f"G{i+1}",
                        "Media μ (°C)": f"{mu_i:.3f}",
                        "Desv σ (°C)":  f"{sig_i:.3f}",
                        "Peso w":        f"{w_i:.4f}",
                    })
 
                fig.add_trace(go.Scatter(
                    x=xc, y=y_sum, mode="lines", name="Suma gaussianas",
                    line=dict(color="black", width=2.5, dash="dash")))
 
                r2 = 1 - np.sum((yc - y_sum)**2) / np.sum((yc - yc.mean())**2)
                sum_w = sum(abs(params[3*i+2]) for i in range(n_gauss))
 
                fig.update_layout(
                    title=f"FDP Temperatura | RMSE={rmse:.2e} | R²={r2:.4f} | Σw={sum_w:.4f}",
                    xaxis_title="Temperatura (°C)", yaxis_title="Densidad de probabilidad",
                    height=500, template="plotly_white",
                    legend=dict(orientation="h", y=1.08))
                st.plotly_chart(fig, use_container_width=True)
 
                c1, c2, c3 = st.columns(3)
                c1.metric("RMSE", f"{rmse:.2e}",
                    delta="✅ OK" if rmse < 1e-3 else "⚠️ Alto", delta_color="off")
                c2.metric("R²", f"{r2:.4f}",
                    delta="✅ OK" if r2 > 0.95 else "⚠️ Bajo", delta_color="off")
                c3.metric("Σ pesos", f"{sum_w:.4f}",
                    delta="✅ OK" if abs(sum_w-1) < 0.01 else "⚠️", delta_color="off")
 
                st.markdown("#### Parámetros por curva")
                st.dataframe(pd.DataFrame(rows), use_container_width=True)
 
            except Exception as e:
                st.error(f"Error en ajuste gaussiano: {e}")
 
# ─────────────────────────────────────────────────────────────────────
# TAB 3 – FDP HUMEDAD
# ─────────────────────────────────────────────────────────────────────
with tabs[3]:
    st.markdown("## 💧 FDP – Humedad Relativa (Curvas Beta)")
    st.markdown("""
La HR es acotada [0-100%] y usa distribuciones **Beta(α, β)**.
Se estiman: α, β, moda, varianza y peso de cada curva.
""")
 
    if not has_HR:
        st.info("No se cargaron datos de Humedad Relativa.")
    else:
        with st.spinner("Ajustando curvas Beta..."):
            try:
                xc, yc, params, rmse = fit_betas(df_HR["Humedad"], n=n_beta)
 
                fig = go.Figure()
                fig.add_trace(go.Bar(x=xc, y=yc, name="FDP observada",
                    marker_color="lightblue", opacity=0.65))
 
                y_sum = np.zeros_like(xc, dtype=float)
                rows  = []
                for i in range(n_beta):
                    a_i = abs(params[3*i])
                    b_i = abs(params[3*i+1])
                    w_i = abs(params[3*i+2])
                    yb  = beta_pdf(xc, a_i, b_i, w_i)
                    y_sum += yb
                    mode_i = (a_i-1)/(a_i+b_i-2)*100 if (a_i>1 and b_i>1) else np.nan
                    var_i  = (a_i*b_i)/((a_i+b_i)**2*(a_i+b_i+1))*10000
                    fig.add_trace(go.Scatter(
                        x=xc, y=yb, mode="lines",
                        name=f"B{i+1}: α={a_i:.2f}  β={b_i:.2f}  w={w_i:.3f}",
                        line=dict(color=COLORS_B[i%4], width=2.5)))
                    rows.append({
                        "Curva": f"B{i+1}",
                        "α (alfa)":    f"{a_i:.3f}",
                        "β (beta)":    f"{b_i:.3f}",
                        "Moda (%)":    f"{mode_i:.1f}" if not np.isnan(mode_i) else "—",
                        "Varianza":    f"{var_i:.2f}",
                        "Peso w":      f"{w_i:.4f}",
                    })
 
                fig.add_trace(go.Scatter(
                    x=xc, y=y_sum, mode="lines", name="Suma Beta",
                    line=dict(color="navy", width=2.5, dash="dash")))
 
                r2    = 1 - np.sum((yc-y_sum)**2) / np.sum((yc-yc.mean())**2)
                sum_w = sum(abs(params[3*i+2]) for i in range(n_beta))
 
                fig.update_layout(
                    title=f"FDP Humedad Relativa | RMSE={rmse:.2e} | R²={r2:.4f} | Σw={sum_w:.4f}",
                    xaxis_title="Humedad Relativa (%)", yaxis_title="Densidad de probabilidad",
                    height=500, template="plotly_white",
                    legend=dict(orientation="h", y=1.08))
                st.plotly_chart(fig, use_container_width=True)
 
                c1, c2, c3 = st.columns(3)
                c1.metric("RMSE", f"{rmse:.2e}",
                    delta="✅ OK" if rmse < 1e-3 else "⚠️ Alto", delta_color="off")
                c2.metric("R²", f"{r2:.4f}",
                    delta="✅ OK" if r2 > 0.95 else "⚠️ Bajo", delta_color="off")
                c3.metric("Σ pesos", f"{sum_w:.4f}",
                    delta="✅ OK" if abs(sum_w-1)<0.01 else "⚠️", delta_color="off")
 
                st.markdown("#### Parámetros por curva")
                st.dataframe(pd.DataFrame(rows), use_container_width=True)
 
            except Exception as e:
                st.error(f"Error en ajuste Beta: {e}")
 
# ─────────────────────────────────────────────────────────────────────
# TAB 4 – MAPAS DE CALOR
# ─────────────────────────────────────────────────────────────────────
with tabs[4]:
    st.markdown("## 🗺️ Mapas de Calor y Variación Temporal")
 
    for label, dv, col, cscale, units in [
        ("Temperatura",     df_T,   "Temperatura","RdYlBu_r","°C"),
        ("Humedad Relativa",df_HR,  "Humedad",    "Blues_r", "%"),
        ("Radiación Global",df_RAD, "Radiacion",  "YlOrRd",  "MJ/m²"),
    ]:
        if dv is None or col not in dv.columns: continue
 
        st.markdown(f"### {label}")
        d = dv.dropna(subset=[col]).copy()
        d["_mes"]  = d["_dt"].dt.month
        d["_hora"] = d["_dt"].dt.hour
 
        pivot = d.groupby(["_hora","_mes"])[col].mean().unstack()
        pivot.columns = [MONTH_NAMES[m-1] for m in pivot.columns]
 
        fig_hm = go.Figure(go.Heatmap(
            z=pivot.values,
            x=pivot.columns,
            y=[f"{h:02d}:00" for h in pivot.index],
            colorscale=cscale,
            colorbar=dict(title=units),
            hovertemplate="Mes: %{x}<br>Hora: %{y}<br>%{z:.2f} " + units + "<extra></extra>"
        ))
        fig_hm.update_layout(
            title=f"Mapa de calor – {label} promedio por hora y mes",
            xaxis_title="Mes", yaxis_title="Hora del día",
            height=480, template="plotly_white")
        st.plotly_chart(fig_hm, use_container_width=True)
 
        col1, col2 = st.columns(2)
 
        with col1:
            st.markdown("**Variación diaria promedio**")
            daily = d.groupby("_hora")[col].agg([
                "mean","min","max",
                lambda x: x.quantile(.25),
                lambda x: x.quantile(.75)
            ])
            daily.columns = ["media","min","max","q25","q75"]
            clr = "#e74c3c" if col=="Temperatura" else ("#2980b9" if col=="Humedad" else "#f39c12")
 
            fig_d = go.Figure()
            fig_d.add_trace(go.Scatter(x=daily.index, y=daily["max"], mode="lines",
                line=dict(color="rgba(180,180,180,0.3)"), showlegend=False))
            fig_d.add_trace(go.Scatter(x=daily.index, y=daily["min"], mode="lines",
                fill="tonexty", fillcolor="rgba(180,180,180,0.15)",
                line=dict(color="rgba(180,180,180,0.3)"), name="Min–Max"))
            fig_d.add_trace(go.Scatter(x=daily.index, y=daily["q75"], mode="lines",
                line=dict(color="rgba(100,100,200,0.2)"), showlegend=False))
            fig_d.add_trace(go.Scatter(x=daily.index, y=daily["q25"], mode="lines",
                fill="tonexty", fillcolor="rgba(100,100,200,0.12)",
                line=dict(color="rgba(100,100,200,0.2)"), name="Q25–Q75"))
            fig_d.add_trace(go.Scatter(x=daily.index, y=daily["media"],
                mode="lines+markers", name="Media",
                line=dict(color=clr, width=2.5)))
            fig_d.update_layout(
                xaxis=dict(title="Hora", tickvals=list(range(0,24,2)),
                           ticktext=[f"{h:02d}:00" for h in range(0,24,2)]),
                yaxis_title=f"{label} ({units})",
                height=380, template="plotly_white")
            st.plotly_chart(fig_d, use_container_width=True)
 
        with col2:
            st.markdown("**Variación mensual promedio**")
            monthly = d.groupby("_mes")[col].agg([
                "mean","min","max",
                lambda x: x.quantile(.25),
                lambda x: x.quantile(.75)
            ])
            monthly.columns = ["media","min","max","q25","q75"]
            monthly.index = [MONTH_NAMES[m-1] for m in monthly.index]
 
            fig_m = go.Figure()
            fig_m.add_trace(go.Scatter(x=monthly.index, y=monthly["max"], mode="lines",
                line=dict(color="rgba(180,180,180,0.3)"), showlegend=False))
            fig_m.add_trace(go.Scatter(x=monthly.index, y=monthly["min"], mode="lines",
                fill="tonexty", fillcolor="rgba(180,180,180,0.15)",
                line=dict(color="rgba(180,180,180,0.3)"), name="Min–Max"))
            fig_m.add_trace(go.Scatter(x=monthly.index, y=monthly["q75"], mode="lines",
                line=dict(color="rgba(100,100,200,0.2)"), showlegend=False))
            fig_m.add_trace(go.Scatter(x=monthly.index, y=monthly["q25"], mode="lines",
                fill="tonexty", fillcolor="rgba(100,100,200,0.12)",
                line=dict(color="rgba(100,100,200,0.2)"), name="Q25–Q75"))
            fig_m.add_trace(go.Scatter(x=monthly.index, y=monthly["media"],
                mode="lines+markers", name="Media",
                line=dict(color=clr, width=2.5)))
            fig_m.update_layout(
                xaxis_title="Mes", yaxis_title=f"{label} ({units})",
                height=380, template="plotly_white")
            st.plotly_chart(fig_m, use_container_width=True)
 
        st.markdown("---")
 
# ─────────────────────────────────────────────────────────────────────
# TAB 5 – VIENTO
# ─────────────────────────────────────────────────────────────────────
with tabs[5]:
    st.markdown("## 💨 Análisis de Viento")
 
    if not has_WIND:
        st.info("No se detectaron datos de viento.")
    else:
        dw = df_WIND.dropna(subset=["velocidad"]).copy()
        st.metric("Registros de viento válidos", f"{len(dw):,}")
 
        c1, c2 = st.columns(2)
 
        with c1:
            st.markdown("### PDF Velocidad")
            counts, edges = np.histogram(dw["velocidad"], bins=140, density=True)
            xv = (edges[:-1] + edges[1:]) / 2
            fig = go.Figure(go.Bar(x=xv, y=counts * 0.1,
                marker_color="steelblue", opacity=0.75, name="PDF observada"))
            fig.update_layout(xaxis_title="Velocidad (m/s)", yaxis_title="Probabilidad",
                height=380, template="plotly_white")
            st.plotly_chart(fig, use_container_width=True)
 
        with c2:
            st.markdown("### Rosa de Vientos")
            if "dir_grados" in dw.columns:
                bins16 = np.arange(0, 361, 22.5)
                labs16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                          "S","SSO","SO","OSO","O","ONO","NO","NNO"]
                dw["_dbin"] = pd.cut(dw["dir_grados"], bins=bins16,
                                     labels=labs16[:16], include_lowest=True)
                rose = dw.groupby("_dbin", observed=True)["velocidad"].mean().reset_index()
                freq = dw["_dbin"].value_counts(normalize=True).reset_index()
                freq.columns = ["_dbin","freq"]
                rose = rose.merge(freq, on="_dbin")
                fig2 = go.Figure(go.Barpolar(
                    r=rose["freq"]*100,
                    theta=rose["_dbin"].astype(str),
                    marker_color=rose["velocidad"],
                    marker_colorscale="Viridis",
                    marker_colorbar=dict(title="Vel. media (m/s)"),
                    opacity=0.85))
                fig2.update_layout(
                    polar=dict(radialaxis=dict(ticksuffix="%")),
                    height=380)
                st.plotly_chart(fig2, use_container_width=True)
            else:
                st.info("No hay columna de dirección en grados")
 
        dw["_hora"] = dw["_dt"].dt.hour
        dw["_mes"]  = dw["_dt"].dt.month
 
        c3, c4 = st.columns(2)
        with c3:
            st.markdown("### Vel. media por hora del día")
            bh = dw.groupby("_hora")["velocidad"].mean()
            fig3 = go.Figure(go.Scatter(x=bh.index, y=bh.values,
                mode="lines+markers", line=dict(color="#2ecc71", width=2.5)))
            fig3.update_layout(
                xaxis=dict(title="Hora", tickvals=list(range(0,24,2)),
                           ticktext=[f"{h:02d}:00" for h in range(0,24,2)]),
                yaxis_title="Vel. media (m/s)",
                height=320, template="plotly_white")
            st.plotly_chart(fig3, use_container_width=True)
 
        with c4:
            st.markdown("### Vel. media por mes")
            bm = dw.groupby("_mes")["velocidad"].mean()
            bm.index = [MONTH_NAMES[m-1] for m in bm.index]
            fig4 = go.Figure(go.Bar(x=bm.index, y=bm.values, marker_color="#1a6fa8"))
            fig4.update_layout(xaxis_title="Mes", yaxis_title="Vel. media (m/s)",
                height=320, template="plotly_white")
            st.plotly_chart(fig4, use_container_width=True)
 
        if "dir_grados" in dw.columns:
            st.markdown("### Dirección vs hora del día")
            fig5 = go.Figure(go.Scatter(
                x=dw["_hora"] + np.random.uniform(-0.3,0.3,len(dw)),
                y=dw["dir_grados"],
                mode="markers",
                marker=dict(color=dw["velocidad"], colorscale="Viridis",
                            size=3, opacity=0.5,
                            colorbar=dict(title="Vel (m/s)"))))
            fig5.update_layout(
                title="Dirección del viento vs hora del día",
                xaxis=dict(title="Hora", tickvals=list(range(0,24)),
                           ticktext=[f"{h}" for h in range(0,24)]),
                yaxis_title="Dirección (°)",
                height=400, template="plotly_white")
            st.plotly_chart(fig5, use_container_width=True)
 
        if "dir_grados" in dw.columns:
            st.markdown("### Dirección vs mes del año")
            mes_labels = [MONTH_NAMES[m-1] for m in dw["_mes"]]
            fig6 = go.Figure(go.Scatter(
                x=mes_labels,
                y=dw["dir_grados"],
                mode="markers",
                marker=dict(color=dw["velocidad"], colorscale="Viridis",
                            size=3, opacity=0.4,
                            colorbar=dict(title="Vel (m/s)"))))
            fig6.update_layout(
                title="Dirección del viento vs mes",
                xaxis_title="Mes", yaxis_title="Dirección (°)",
                height=400, template="plotly_white")
            st.plotly_chart(fig6, use_container_width=True)
 
# ─────────────────────────────────────────────────────────────────────
# TAB 6 – COMBINADO T–HR
# ─────────────────────────────────────────────────────────────────────
with tabs[6]:
    st.markdown("## 🔗 Análisis Combinado T – HR")
 
    if not has_T or not has_HR:
        st.info("Se requieren datos de T y HR cargados.")
    else:
        merged = pd.merge(
            df_T[["_dt","Temperatura"]].dropna(),
            df_HR[["_dt","Humedad"]].dropna(),
            on="_dt", how="inner"
        )
        st.metric("Pares válidos T–HR", f"{len(merged):,}")
 
        st.markdown("### Densidad T vs HR con isolíneas")
        fig = go.Figure()
        fig.add_trace(go.Histogram2dContour(
            x=merged["Temperatura"], y=merged["Humedad"],
            colorscale="Blues", showscale=True,
            contours=dict(showlabels=True, coloring="heatmap"),
            name="Densidad"))
 
        samp = merged.sample(min(3000, len(merged)), random_state=42)
        fig.add_trace(go.Scatter(
            x=samp["Temperatura"], y=samp["Humedad"],
            mode="markers",
            marker=dict(color="rgba(50,50,150,0.08)", size=3),
            name="Datos (muestra)"))
 
        wet     = merged[(merged["Temperatura"] > 10) & (merged["Humedad"] > 79)]
        pct_wet = len(wet) / len(merged) * 100
        tmax    = merged["Temperatura"].max()
        fig.add_trace(go.Scatter(
            x=[10, 10, tmax, tmax, 10],
            y=[79, 100, 100, 79, 79],
            mode="lines", fill="toself",
            fillcolor="rgba(231,76,60,0.08)",
            line=dict(color="red", dash="dash", width=1.5),
            name=f"Humectación (T>10°C, HR>79%) = {pct_wet:.1f}%"))
 
        fig.update_layout(
            title="Densidad T–HR con zona de humectación",
            xaxis_title="Temperatura (°C)",
            yaxis_title="Humedad Relativa (%)",
            height=520, template="plotly_white",
            legend=dict(orientation="h", y=1.06))
        st.plotly_chart(fig, use_container_width=True)
 
        c1, c2 = st.columns(2)
        c1.metric("Tiempo de humectación (T>10°C, HR>79%)", f"{pct_wet:.1f}%")
        c2.metric("Correlación Pearson T–HR",
                  f"{merged['Temperatura'].corr(merged['Humedad']):.3f}")
 
        st.markdown("### Gráfico Psicrométrico T vs H_abs")
        Z       = float(alt_z)
        P_total = 1013.25 * (1 - 2.25577e-5 * Z)**5.2559
        P_sat   = (9.066 * np.exp(0.0641 * merged["Temperatura"])
                   - 1.796 * np.exp(0.0805 * merged["Temperatura"]))
        HR_f    = merged["Humedad"] / 100.0
        merged["H_abs"] = ((18000/29)
                           * (HR_f * P_sat)
                           / (P_total - HR_f * P_sat))
 
        samp2 = merged.sample(min(4000, len(merged)), random_state=2)
        fig3 = go.Figure(go.Scatter(
            x=samp2["Temperatura"], y=samp2["H_abs"],
            mode="markers",
            marker=dict(
                color=samp2["Humedad"], colorscale="Blues",
                size=3, opacity=0.6, showscale=True,
                colorbar=dict(title="HR (%)")),
            name="H_abs"))
        fig3.update_layout(
            title=f"Psicrométrico T vs H_abs  (Z={Z:.0f} m)",
            xaxis_title="Temperatura (°C)",
            yaxis_title="Humedad Absoluta (g agua / kg aire seco)",
            height=460, template="plotly_white")
        st.plotly_chart(fig3, use_container_width=True)
 
        st.markdown("### Variación mensual T y HR")
        merged["_mes"] = merged["_dt"].dt.month
        monthly = merged.groupby("_mes")[["Temperatura","Humedad"]].mean()
        monthly.index = [MONTH_NAMES[m-1] for m in monthly.index]
 
        fig4 = make_subplots(specs=[[{"secondary_y": True}]])
        fig4.add_trace(go.Scatter(
            x=monthly.index, y=monthly["Temperatura"],
            mode="lines+markers", name="T media (°C)",
            line=dict(color="#e74c3c", width=2.5)), secondary_y=False)
        fig4.add_trace(go.Scatter(
            x=monthly.index, y=monthly["Humedad"],
            mode="lines+markers", name="HR media (%)",
            line=dict(color="#2980b9", width=2.5)), secondary_y=True)
        fig4.update_yaxes(title_text="Temperatura (°C)", secondary_y=False)
        fig4.update_yaxes(title_text="Humedad Relativa (%)", secondary_y=True)
        fig4.update_layout(title="Variación mensual T y HR",
            height=380, template="plotly_white",
            legend=dict(orientation="h", y=1.08))
        st.plotly_chart(fig4, use_container_width=True)