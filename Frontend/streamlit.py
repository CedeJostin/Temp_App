import io
import warnings

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import requests
import streamlit as st
from plotly.subplots import make_subplots
from scipy.optimize import minimize
from scipy.stats import beta as beta_dist
from scipy.stats import norm

warnings.filterwarnings("ignore")

# ═══════════════════════════════════════════════════════════════════════
# CONFIG PÁGINA
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

# ═══════════════════════════════════════════════════════════════════════
# CONSTANTES
# ═══════════════════════════════════════════════════════════════════════

VALID_RANGES = {
    "Temperatura": (-5,   60),
    "Humedad":     (0,   100),
    "Radiacion":   (0,  None),
}
UNITS = {
    "Temperatura": "°C",
    "Humedad":     "%",
    "Radiacion":   "MJ/m²",
}

EMC_THRESHOLD   = 1e-5
HOUR_COLS_B     = [f"{i:02d}:00" for i in range(1, 25)]
HOUR_COLS_B_ALT = [f"{i}:00" for i in range(1, 25)] + ["24:00:00"]
MONTH_NAMES     = ["Ene","Feb","Mar","Abr","May","Jun",
                   "Jul","Ago","Sep","Oct","Nov","Dic"]
COLORS_G = ["#e74c3c","#e67e22","#9b59b6","#1abc9c"]
COLORS_B = ["#2980b9","#27ae60","#8e44ad","#e67e22"]

# ═══════════════════════════════════════════════════════════════════════
# CLIENTE API  —  todas las llamadas al backend FastAPI
# ═══════════════════════════════════════════════════════════════════════

def api_url(path: str) -> str:
    base = st.session_state.get("api_base", "http://localhost:8000").rstrip("/")
    return f"{base}{path}"


def api_get_stations():
    try:
        r = requests.get(api_url("/stations/"), timeout=8)
        r.raise_for_status()
        return r.json(), None
    except Exception as e:
        return [], str(e)


def api_create_station(payload: dict):
    try:
        r = requests.post(api_url("/stations/"), json=payload, timeout=8)
        r.raise_for_status()
        return r.json(), None
    except Exception as e:
        return None, str(e)


def api_get_variables():
    """Intenta /stations/variables/all primero, luego /variables/ como fallback."""
    for path in ("/stations/variables/all", "/variables/"):
        try:
            r = requests.get(api_url(path), timeout=8)
            r.raise_for_status()
            return r.json(), None
        except Exception:
            pass
    return [], "No se pudo obtener la lista de variables"


def api_upload_file(
    file_bytes:  bytes,
    filename:    str,
    station_id:  str,
    variable_id: str | None = None,
) -> tuple:
    """
    Sube un archivo al backend.
    - variable_id es opcional: si no se pasa, el backend detecta la variable
      automáticamente desde el nombre del archivo o su contenido.
    - Devuelve (result_dict, error_str).  result_dict incluye:
      variable_type, rows_parsed, rows_inserted, logs.
    """
    try:
        params = {"station_id": station_id}
        if variable_id:
            params["variable_id"] = variable_id

        r = requests.post(
            api_url("/uploads/"),
            params=params,
            files={"file": (filename, io.BytesIO(file_bytes), "application/octet-stream")},
            timeout=120,
        )
        r.raise_for_status()
        return r.json(), None
    except requests.HTTPError as e:
        try:
            detail = e.response.json().get("detail", str(e))
        except Exception:
            detail = str(e)
        return None, str(detail)
    except Exception as e:
        return None, str(e)


def api_get_upload_history() -> tuple:
    """Devuelve el historial de archivos subidos desde /uploads/history."""
    try:
        r = requests.get(api_url("/uploads/history"), timeout=8)
        r.raise_for_status()
        return r.json(), None
    except Exception as e:
        return [], str(e)


def api_get_measurements(station_id: str, variable_code: str,
                         date_from: str = None, date_to: str = None) -> tuple:
    """Consulta mediciones desde /measurements/ filtrando por estación y variable."""
    try:
        params = {"station_id": station_id, "variable_code": variable_code, "limit": 50000}
        if date_from:
            params["date_from"] = date_from
        if date_to:
            params["date_to"] = date_to
        r = requests.get(api_url("/measurements/"), params=params, timeout=30)
        r.raise_for_status()
        return r.json(), None
    except Exception as e:
        try:
            params2 = {"station_id": station_id, "limit": 50000}
            r2 = requests.get(api_url("/measurements/"), params=params2, timeout=30)
            r2.raise_for_status()
            data = r2.json()
            if isinstance(data, list):
                data = [d for d in data if
                        str(d.get("variable_code","")).upper() == variable_code.upper() or
                        str((d.get("variable") or {}).get("code","")).upper() == variable_code.upper()]
            return data, None
        except Exception as e2:
            return [], str(e2)


# ═══════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════

def norm_text(txt):
    return (str(txt).lower()
            .replace("á","a").replace("é","e").replace("í","i")
            .replace("ó","o").replace("ú","u").replace("ñ","n")
            .replace("°","").replace("º","").strip())

def detect_db_columns(df):
    """
    Detecta automáticamente las columnas de fecha y valor en un DataFrame
    proveniente de la API de mediciones. Devuelve (dt_col, val_col) o (None, None).
    Estrategia: 1) coincidencia de nombre conocido, 2) columna parseable como datetime,
    3) columna numérica que no sea id/año/mes/hora.
    """
    dt_col = val_col = None

    # ── Candidatos por nombre ────────────────────────────────────────
    DATE_KEYWORDS = ["measured_at","datetime","fecha","date","timestamp","time",
                     "created_at","recorded_at","at","dt","ts"]
    VAL_KEYWORDS  = ["value","valor","val","reading","medicion","dato","data",
                     "measurement","amount","quantity","result"]

    cols_norm = {c: norm_text(str(c)).replace(" ","").replace("_","") for c in df.columns}

    for c, cn in cols_norm.items():
        if any(kw.replace("_","") in cn for kw in DATE_KEYWORDS):
            dt_col = c; break

    for c, cn in cols_norm.items():
        if any(kw.replace("_","") in cn for kw in VAL_KEYWORDS):
            val_col = c; break

    # ── Fallback 1: buscar columna parseable como datetime ───────────
    if dt_col is None:
        for c in df.columns:
            try:
                parsed = pd.to_datetime(df[c], errors="coerce")
                if parsed.notna().mean() > 0.7:
                    dt_col = c; break
            except Exception:
                pass

    # ── Fallback 2: buscar primera columna numérica que no sea id/año/mes ──
    if val_col is None:
        skip_patterns = ["id","year","ano","mes","month","hour","hora","day","dia",
                         "station","variable","code","status","flag"]
        for c in df.columns:
            if c == dt_col: continue
            cn = cols_norm.get(c, "")
            if any(p in cn for p in skip_patterns): continue
            try:
                s = pd.to_numeric(df[c], errors="coerce")
                if s.notna().mean() > 0.5:
                    val_col = c; break
            except Exception:
                pass

    return dt_col, val_col

def completeness_badge(pct):
    if pct >= 98: return "🟢 Excelente [98-100%)"
    if pct >= 95: return "🔵 Bueno [95-98%)"
    if pct >= 90: return "🟡 Aceptable [90-95%)"
    if pct >= 85: return "🟠 Bajo [85-90%)"
    return             "🔴 Crítico (<85%)"

def to_float_col(series):
    return pd.to_numeric(
        series.astype(str).str.replace(",", ".", regex=False).str.strip(),
        errors="coerce"
    )

# ═══════════════════════════════════════════════════════════════════════
# DETECCIÓN DE TIPO
# ═══════════════════════════════════════════════════════════════════════

def detect_type_from_text(text):
    t = norm_text(text)
    if "temperatura" in t:                                   return "Temperatura"
    if "humedad" in t:                                       return "Humedad"
    if "radiaci" in t or "mj" in t:                         return "Radiacion"
    if "viento" in t or "velocidad" in t or "direccion" in t: return "Viento"
    if "lluvia" in t or "precipit" in t:                    return "Lluvia"
    if "temp" in t:                                          return "Temperatura"
    if "hum" in t:                                           return "Humedad"
    if "rad" in t:                                           return "Radiacion"
    if "lluv" in t or "prec" in t:                          return "Lluvia"
    return "UNKNOWN"

def detect_type_from_cols(df):
    t = norm_text(" ".join(str(c) for c in df.columns))
    return detect_type_from_text(t)

# ═══════════════════════════════════════════════════════════════════════
# NORMALIZAR COLUMNAS DE FECHA
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
# DETECTAR COLUMNAS DE HORA
# ═══════════════════════════════════════════════════════════════════════

def detect_hour_cols(df):
    cols_upper = {c: str(c).strip() for c in df.columns}

    found_a = [c for c, v in cols_upper.items()
               if v.upper() in [f"H{i}" for i in range(1, 25)]]
    if len(found_a) >= 12:
        found_a.sort(key=lambda c: int(str(c).upper().replace("H","")))
        return found_a, "A"

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
# PARSER ANCHO → LARGO
# ═══════════════════════════════════════════════════════════════════════

def wide_to_long(df, value_name):
    hour_cols, fmt = detect_hour_cols(df)
    if not hour_cols:
        return None

    df = rename_date_cols(df)
    if any(c not in df.columns for c in ["_year","_month","_day"]):
        return None

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

    def hora_num(s):
        s = str(s).strip().upper()
        if fmt == "A":
            return int(s.replace("H",""))
        s = s.replace(":00:00","").replace(":00","")
        return int(s)

    hora_int  = melted["_hora_str"].apply(hora_num)
    extra_day = (hora_int == 24).astype(int)
    hora_int  = hora_int % 24

    base = pd.to_datetime(dict(
        year=melted["_year"], month=melted["_month"], day=melted["_day"]
    ), errors="coerce")

    melted["_dt"] = (base
                     + pd.to_timedelta(hora_int, "h")
                     + pd.to_timedelta(extra_day, "d"))

    return (melted[["_dt", value_name]]
            .dropna(subset=["_dt"])
            .sort_values("_dt")
            .reset_index(drop=True))

# ═══════════════════════════════════════════════════════════════════════
# PARSER VIENTO
# ═══════════════════════════════════════════════════════════════════════

def parse_wind(df):
    fecha_col = None
    for c in df.columns:
        try:
            p = pd.to_datetime(df[c], dayfirst=True, errors="coerce")
            if p.notna().mean() > 0.5:
                fecha_col = c; break
        except: pass
    if fecha_col is None:
        return None

    fechas   = pd.to_datetime(df[fecha_col], dayfirst=True, errors="coerce")
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
        if "predomin" in nc or ("direcc" in nc and "grado" not in nc
                                 and "velocidad" not in nc):
            out["dir_texto"] = df[c].astype(str)

    return out.dropna(subset=["_dt"]).sort_values("_dt").reset_index(drop=True)

# ═══════════════════════════════════════════════════════════════════════
# LEER CSV
# ═══════════════════════════════════════════════════════════════════════

@st.cache_data(show_spinner=False)
def read_csv_file(file_bytes, filename):
    results, logs = {}, []
    for enc in ["latin1","utf-8","cp1252"]:
        try:
            row0 = pd.read_csv(io.BytesIO(file_bytes), sep=";",
                               encoding=enc, header=None, nrows=1)
            row0_text = " ".join(str(v) for v in row0.iloc[0].values if pd.notna(v))
            vtype = detect_type_from_text(row0_text)
            if vtype == "UNKNOWN":
                vtype = detect_type_from_text(filename)

            df_b = pd.read_csv(io.BytesIO(file_bytes), sep=";",
                               encoding=enc, header=1, decimal=",")
            _, fmt_b = detect_hour_cols(df_b)
            df_a = pd.read_csv(io.BytesIO(file_bytes), sep=";",
                               encoding=enc, header=0, decimal=",")
            _, fmt_a = detect_hour_cols(df_a)

            if fmt_b in ("A","B"):
                df_use, fmt_use = df_b, fmt_b
            elif fmt_a in ("A","B"):
                df_use, fmt_use = df_a, fmt_a
                if vtype == "UNKNOWN": vtype = detect_type_from_cols(df_use)
                if vtype == "UNKNOWN": vtype = detect_type_from_text(filename)
            else:
                df_use, fmt_use = df_b, "WIND"

            if vtype in ("Temperatura","Humedad","Radiacion","Lluvia"):
                parsed = wide_to_long(df_use, vtype)
            elif vtype == "Viento":
                df_wind = pd.read_csv(io.BytesIO(file_bytes), sep=";",
                                      encoding=enc, header=0)
                parsed = parse_wind(df_wind)
            else:
                logs.append(f"⚠️ {filename}: tipo no detectado")
                return results, logs

            if parsed is not None and len(parsed) > 0:
                parsed["_dt"] = parsed["_dt"].dt.round("h")
                results[vtype] = parsed
                logs.append(f"✅ {filename} → {vtype} ({len(parsed):,} registros)")
            else:
                logs.append(f"⚠️ {filename}: parseado vacío")
            break
        except Exception as e:
            logs.append(f"⚠️ {filename} enc={enc}: {e}")
    return results, logs

# ═══════════════════════════════════════════════════════════════════════
# LEER EXCEL
# ═══════════════════════════════════════════════════════════════════════

@st.cache_data(show_spinner=False)
def read_excel_file(file_bytes, filename):
    results, logs = {}, []
    xl = pd.ExcelFile(io.BytesIO(file_bytes))
    for sname in xl.sheet_names:
        try:
            raw = xl.parse(sname, header=None)
            if raw.empty or len(raw) < 3: continue

            row0_text = " ".join(str(v) for v in raw.iloc[0].values if pd.notna(v))
            vtype = detect_type_from_text(row0_text)

            df_b = xl.parse(sname, header=1).dropna(how="all").reset_index(drop=True)
            _, fmt_b = detect_hour_cols(df_b)
            df_a = xl.parse(sname, header=0).dropna(how="all").reset_index(drop=True)
            _, fmt_a = detect_hour_cols(df_a)

            if fmt_b in ("A","B"):
                df_use, fmt_use = df_b, fmt_b
            elif fmt_a in ("A","B"):
                df_use, fmt_use = df_a, fmt_a
                if vtype == "UNKNOWN": vtype = detect_type_from_cols(df_use)
                if vtype == "UNKNOWN": vtype = detect_type_from_text(sname)
            else:
                header_row = 1
                for i, row in raw.iterrows():
                    rt = norm_text(" ".join(str(v) for v in row.values if pd.notna(v)))
                    if any(k in rt for k in ["ano","mes","fecha","year","month"]):
                        header_row = i; break
                df_use = xl.parse(sname, header=header_row).dropna(how="all").reset_index(drop=True)
                _, fmt_use = detect_hour_cols(df_use)

            if vtype == "UNKNOWN":
                vtype = detect_type_from_text(sname)

            if vtype in ("Temperatura","Humedad","Radiacion","Lluvia"):
                parsed = wide_to_long(df_use, vtype)
            elif vtype == "Viento":
                parsed = parse_wind(df_use)
            else:
                logs.append(f"⚠️ '{sname}': tipo desconocido"); continue

            if parsed is not None and len(parsed) > 0:
                parsed["_dt"] = parsed["_dt"].dt.round("h")
                results[vtype] = parsed
                logs.append(f"✅ '{sname}' → {vtype} ({len(parsed):,} registros)")
            else:
                logs.append(f"⚠️ '{sname}': parseado vacío")
        except Exception as e:
            logs.append(f"❌ '{sname}': {e}")
    return results, logs

# ═══════════════════════════════════════════════════════════════════════
# FDP – GAUSSIANAS
# ═══════════════════════════════════════════════════════════════════════

@st.cache_data(show_spinner=False)
def fit_gaussians(values_tuple, n=2):
    v = pd.Series(values_tuple).dropna()
    counts, edges = np.histogram(v, bins=80, density=True)
    xc = (edges[:-1] + edges[1:]) / 2
    p0 = []
    for mu in np.linspace(float(v.quantile(0.2)), float(v.quantile(0.8)), n):
        p0 += [float(mu), float(v.std()/n), 1.0/n]

    def loss(p):
        y = sum(p[3*i+2] * norm.pdf(xc, p[3*i], abs(p[3*i+1])) for i in range(n))
        return float(np.sqrt(np.mean((counts - y)**2)))

    bounds = [(float(v.min()), float(v.max())),
              (0.01, float(v.std()*3)), (0.001, 1.0)] * n
    cons = [{"type":"eq","fun": lambda p: sum(p[2::3]) - 1}]
    res  = minimize(loss, p0, bounds=bounds, constraints=cons,
                    method="SLSQP", options={"maxiter":500})
    return xc, counts, res.x, res.fun, res.success

def gaussian_pdf(x, mu, sig, w):
    return w * norm.pdf(x, mu, sig)

# ═══════════════════════════════════════════════════════════════════════
# FDP – BETA
# ═══════════════════════════════════════════════════════════════════════

def beta_pdf(x, a, b, w, lo=0, hi=100):
    xs = np.clip((x - lo) / (hi - lo), 1e-6, 1-1e-6)
    return w * beta_dist.pdf(xs, a, b) / (hi - lo)

@st.cache_data(show_spinner=False)
def fit_betas(values_tuple, n=2):
    v = pd.Series(values_tuple).dropna()
    counts, edges = np.histogram(v, bins=100, range=(0,100), density=True)
    xc = (edges[:-1] + edges[1:]) / 2
    p0 = [3.0, 3.0, 1.0/n] * n

    def loss(p):
        y = sum(beta_pdf(xc, abs(p[3*i]), abs(p[3*i+1]), abs(p[3*i+2])) for i in range(n))
        return float(np.sqrt(np.mean((counts - y)**2)))

    bounds = [(0.1, 50), (0.1, 50), (0.001, 1.0)] * n
    cons   = [{"type":"eq","fun": lambda p: sum(p[2::3]) - 1}]
    res    = minimize(loss, p0, bounds=bounds, constraints=cons,
                      method="SLSQP", options={"maxiter":500})
    return xc, counts, res.x, res.fun, res.success

# ═══════════════════════════════════════════════════════════════════════
# SESSION STATE
# ═══════════════════════════════════════════════════════════════════════

if "sheets" not in st.session_state:
    st.session_state.sheets = {}
if "station_meta" not in st.session_state:
    st.session_state.station_meta = {"nombre":"","lat":0.0,"lon":0.0,"alt":926.0}
if "api_base" not in st.session_state:
    st.session_state.api_base = "http://localhost:8000"
if "raw_file_bytes" not in st.session_state:
    st.session_state.raw_file_bytes = {}
if "show_db_query" not in st.session_state:
    st.session_state.show_db_query = False
if "db_query_results" not in st.session_state:
    st.session_state.db_query_results = None

# ═══════════════════════════════════════════════════════════════════════
# SIDEBAR
# ═══════════════════════════════════════════════════════════════════════

with st.sidebar:
    st.markdown("## 🌤️ Análisis Meteorológico")
    st.markdown("---")

    # URL del backend
    st.markdown("### 🔌 Backend")
    st.session_state.api_base = st.text_input(
        "URL del backend FastAPI",
        value=st.session_state.api_base,
        placeholder="http://localhost:8000"
    )

    st.markdown("---")

    # Upload de archivos
    st.markdown("### 📂 Archivos de datos")
    uploaded_files = st.file_uploader(
        "Sube archivos CSV o Excel",
        type=["csv","xlsx","xls"],
        accept_multiple_files=True
    )

    process_btn = st.button("📥 Cargar datos", type="primary")

    if process_btn and uploaded_files:
        all_sheets, all_logs, raw_bytes = {}, [], {}
        with st.spinner("Procesando archivos..."):
            for f in uploaded_files:
                fbytes = f.read()
                raw_bytes[f.name] = fbytes
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

        for key in all_sheets:
            all_sheets[key] = (all_sheets[key]
                               .drop_duplicates(subset=["_dt"])
                               .sort_values("_dt")
                               .reset_index(drop=True))

        st.session_state.sheets         = all_sheets
        st.session_state.raw_file_bytes = raw_bytes

        for msg in all_logs:
            if msg.startswith("✅"):   st.success(msg)
            elif msg.startswith("⚠️"): st.warning(msg)
            else:                       st.error(msg)

    st.markdown("---")

    # Consultar BD desde sidebar
    st.markdown("### 🗄️ Consultar Base de Datos")
    st.caption("Visualiza datos de Supabase sin cargar archivos.")

    _sb_stations, _ = api_get_stations()

    if not _sb_stations:
        st.info("⚠️ Sin conexión al backend o sin estaciones.")
    else:
        _sb_st_opts = {f"{s['station_code']} — {s['name']}": s for s in _sb_stations}
        _sb_st_sel  = st.selectbox("🏔️ Estación", list(_sb_st_opts.keys()), key="sb_q_station")
        _sb_station = _sb_st_opts[_sb_st_sel]

        _sb_var_sel = st.selectbox(
            "📈 Variable",
            ["Temperatura (TEMP)", "Humedad (HR)", "Radiación (RAD)", "Viento (VIENTO)"],
            key="sb_q_var"
        )
        _VAR_MAP = {
            "Temperatura (TEMP)": ("TEMP",   "Temperatura", "°C",    "#e74c3c"),
            "Humedad (HR)":       ("HR",     "Humedad",     "%",     "#2980b9"),
            "Radiación (RAD)":    ("RAD",    "Radiacion",   "MJ/m²", "#f39c12"),
            "Viento (VIENTO)":    ("VIENTO", "Viento",      "m/s",   "#27ae60"),
        }
        _sb_code, _sb_label, _sb_unit, _sb_color = _VAR_MAP[_sb_var_sel]

        _sb_d1 = st.date_input("Desde", value=None, key="sb_q_from")
        _sb_d2 = st.date_input("Hasta",  value=None, key="sb_q_to")

        if st.button("📊 Ver gráficas desde BD", type="primary",
                     use_container_width=True, key="btn_sb_query"):
            with st.spinner(f"Consultando {_sb_label}…"):
                _raw, _err = api_get_measurements(
                    station_id    = str(_sb_station["id"]),
                    variable_code = _sb_code,
                    date_from     = str(_sb_d1) if _sb_d1 else None,
                    date_to       = str(_sb_d2) if _sb_d2 else None,
                )
            st.session_state.db_query_results = {
                "data":    _raw,
                "error":   _err,
                "label":   _sb_label,
                "unit":    _sb_unit,
                "color":   _sb_color,
                "code":    _sb_code,
                "station": _sb_st_sel,
            }
            st.session_state.show_db_query = True
            st.rerun()

# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

# Valores por defecto para FDP (antes configurables en sidebar)
n_gauss = 2
n_beta  = 2


# ═══════════════════════════════════════════════════════════════════════
# PANEL: CONSULTA DESDE BD (activado desde el sidebar)
# ═══════════════════════════════════════════════════════════════════════

if st.session_state.get("show_db_query") and st.session_state.get("db_query_results"):
    _res = st.session_state.db_query_results
    _MONTH_NAMES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]

    st.markdown("---")
    _col_h, _col_close = st.columns([8, 1])
    _col_h.markdown(f"## 📊 Datos desde BD — {_res['label']} | {_res['station']}")
    if _col_close.button("✖ Cerrar", key="btn_close_dbq"):
        st.session_state.show_db_query = False
        st.session_state.db_query_results = None
        st.rerun()

    if _res["error"]:
        st.error(f"❌ Error al consultar: {_res['error']}")
    elif not _res["data"]:
        st.info("ℹ️ No se encontraron mediciones con esos filtros.")
    else:
        import pandas as _pd
        import plotly.graph_objects as _go
        import numpy as _np

        _df = _pd.DataFrame(_res["data"])
        _dt_col, _val_col = detect_db_columns(_df)

        if _dt_col and _val_col:
            _df["_dt"]  = _pd.to_datetime(_df[_dt_col], errors="coerce")
            _df["_val"] = _pd.to_numeric(_df[_val_col], errors="coerce")
            _df = _df.dropna(subset=["_dt","_val"]).sort_values("_dt").reset_index(drop=True)
            _lbl, _unit, _clr = _res["label"], _res["unit"], _res["color"]
            _pal = ["#e74c3c","#2980b9","#27ae60","#9b59b6","#f39c12","#1abc9c","#e67e22","#e91e63"]

            st.success(f"✅ {len(_df):,} registros — "
                       f"{_df['_dt'].min().strftime('%Y-%m-%d')} → "
                       f"{_df['_dt'].max().strftime('%Y-%m-%d')}")

            _m1,_m2,_m3,_m4 = st.columns(4)
            _m1.metric("Promedio",  f"{_df['_val'].mean():.2f} {_unit}")
            _m2.metric("Máximo",    f"{_df['_val'].max():.2f} {_unit}")
            _m3.metric("Mínimo",    f"{_df['_val'].min():.2f} {_unit}")
            _m4.metric("Registros", f"{len(_df):,}")

            _df["_year"]  = _df["_dt"].dt.year
            _df["_month"] = _df["_dt"].dt.month
            _df["_hour"]  = _df["_dt"].dt.hour

            # Gráfica 1: Serie temporal
            st.markdown("#### 📉 Serie temporal completa")
            _fig1 = _go.Figure(_go.Scatter(x=_df["_dt"], y=_df["_val"],
                mode="lines", name=_lbl,
                line=dict(color=_clr, width=1.2), opacity=0.85))
            _fig1.update_layout(height=320, template="plotly_white",
                xaxis_title="Fecha", yaxis_title=f"{_lbl} ({_unit})",
                hovermode="x unified")
            st.plotly_chart(_fig1, use_container_width=True)

            # Gráfica 2: Promedio mensual por año
            st.markdown("#### 📅 Promedio mensual por año")
            _mo_yr = _df.groupby(["_year","_month"])["_val"].mean().reset_index()
            _fig2  = _go.Figure()
            for _i, _yr in enumerate(sorted(_mo_yr["_year"].unique())):
                _s = _mo_yr[_mo_yr["_year"]==_yr]
                _fig2.add_trace(_go.Scatter(x=_s["_month"], y=_s["_val"],
                    mode="lines+markers", name=str(_yr),
                    line=dict(color=_pal[_i%len(_pal)], width=2)))
            _fig2.update_layout(height=320, template="plotly_white",
                xaxis=dict(tickmode="array", tickvals=list(range(1,13)),
                           ticktext=_MONTH_NAMES),
                yaxis_title=f"{_lbl} ({_unit})", hovermode="x unified",
                legend=dict(orientation="h", y=1.08))
            st.plotly_chart(_fig2, use_container_width=True)

            # Gráfica 3: Ciclo diurno
            st.markdown("#### 🕓 Ciclo diurno promedio")
            _hrly = _df.groupby("_hour")["_val"].agg(["mean","std"]).reset_index()
            _r, _g, _b = int(_clr[1:3],16), int(_clr[3:5],16), int(_clr[5:7],16)
            _fig3 = _go.Figure()
            _fig3.add_trace(_go.Scatter(x=_hrly["_hour"],
                y=_hrly["mean"]+_hrly["std"], mode="lines",
                line=dict(width=0), showlegend=False,
                fill=None, fillcolor=f"rgba({_r},{_g},{_b},0.15)"))
            _fig3.add_trace(_go.Scatter(x=_hrly["_hour"],
                y=_hrly["mean"]-_hrly["std"], mode="lines",
                line=dict(width=0), fill="tonexty",
                fillcolor=f"rgba({_r},{_g},{_b},0.15)", name="±1σ"))
            _fig3.add_trace(_go.Scatter(x=_hrly["_hour"], y=_hrly["mean"],
                mode="lines+markers", name="Promedio",
                line=dict(color=_clr, width=2.5)))
            _fig3.update_layout(height=300, template="plotly_white",
                xaxis=dict(title="Hora", tickmode="linear", tick0=0, dtick=2),
                yaxis_title=f"{_lbl} ({_unit})")
            st.plotly_chart(_fig3, use_container_width=True)

            # Gráfica 4: Boxplot mensual
            st.markdown("#### 📦 Distribución mensual")
            _fig4 = _go.Figure()
            for _mo in range(1,13):
                _sub = _df[_df["_month"]==_mo]["_val"].dropna()
                if len(_sub) == 0: continue
                _fig4.add_trace(_go.Box(y=_sub, name=_MONTH_NAMES[_mo-1],
                    marker_color=_pal[(_mo-1)%len(_pal)],
                    boxmean="sd", showlegend=False))
            _fig4.update_layout(height=320, template="plotly_white",
                yaxis_title=f"{_lbl} ({_unit})")
            st.plotly_chart(_fig4, use_container_width=True)

            # Gráfica 5: Mapa de calor Hora x Mes
            st.markdown("#### 🗺️ Mapa de calor Hora × Mes")
            _heat = _df.groupby(["_month","_hour"])["_val"].mean().unstack(level=0)
            _heat.columns = [_MONTH_NAMES[c-1] for c in _heat.columns]
            _fig5 = _go.Figure(_go.Heatmap(
                z=_heat.values, x=_heat.columns.tolist(),
                y=[f"{h:02d}:00" for h in _heat.index],
                colorscale="RdYlGn" if _res["code"]=="TEMP" else "Blues",
                colorbar=dict(title=_unit)))
            _fig5.update_layout(height=400, template="plotly_white",
                xaxis_title="Mes", yaxis_title="Hora")
            st.plotly_chart(_fig5, use_container_width=True)

            # Gráfica 6: Promedio anual
            st.markdown("#### 📆 Promedio anual")
            _ann = _df.groupby("_year")["_val"].mean().reset_index()
            _fig6 = _go.Figure()
            _fig6.add_trace(_go.Bar(x=_ann["_year"], y=_ann["_val"],
                marker_color=_clr, opacity=0.85, name="Promedio anual"))
            _fig6.add_trace(_go.Scatter(x=_ann["_year"], y=_ann["_val"],
                mode="lines+markers", name="Tendencia",
                line=dict(color="#2c3e50", width=2, dash="dash")))
            _fig6.update_layout(height=300, template="plotly_white",
                xaxis_title="Año", yaxis_title=f"{_lbl} ({_unit})",
                hovermode="x unified")
            st.plotly_chart(_fig6, use_container_width=True)

            with st.expander("📋 Ver tabla de datos"):
                st.dataframe(
                    _df[["_dt","_val"]].rename(columns={"_dt":"Fecha/Hora",
                        "_val":f"{_lbl} ({_unit})"}),
                    use_container_width=True, hide_index=True)
        else:
            st.warning("⚠️ No se pudo identificar columnas de fecha/valor.")
            st.caption(f"Columnas recibidas: `{list(_df.columns)}`")
            st.json(_res["data"][:3] if isinstance(_res["data"],list) else _res["data"])

    st.markdown("---")

# ═══════════════════════════════════════════════════════════════════════
# ROUTER – session_state
# ═══════════════════════════════════════════════════════════════════════

if "current_page" not in st.session_state:
    st.session_state.current_page = "home"

def go_to(page):
    st.session_state.current_page = page

sheets = st.session_state.sheets
meta   = st.session_state.station_meta

# ── Estilos globales de navegación ──────────────────────────────────
st.markdown("""
<style>
/* ── Nav card ── */
.nav-card {
    background: #fff;
    border: 1.5px solid #e2eaf1;
    border-radius: 14px;
    padding: 1.4rem 1rem 1.1rem;
    text-align: center;
    transition: transform .15s, box-shadow .15s, border-color .15s;
    cursor: pointer;
    height: 100%;
}
.nav-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 6px 20px rgba(26,111,168,.13);
    border-color: #1a6fa8;
}
.nav-card.disabled {
    opacity: .42; pointer-events: none;
}
.nav-card .nc-icon  { font-size: 2.2rem; margin-bottom: .45rem; }
.nav-card .nc-title { font-size: 1rem; font-weight: 700; color: #1a2b3c; margin-bottom:.25rem; }
.nav-card .nc-sub   { font-size: .76rem; color: #8fa3b1; }
.nav-card .nc-badge {
    display:inline-block; margin-top:.4rem;
    font-size:.7rem; font-weight:600; padding:.15rem .55rem;
    border-radius:20px; background:#eaf3fb; color:#1a6fa8;
}
.nav-card .nc-badge.ok  { background:#f0fdf4; color:#2ecc71; }
.nav-card .nc-badge.off { background:#fef3f2; color:#e74c3c; }
/* ── Page header ── */
.page-header {
    display:flex; align-items:center; gap:.8rem;
    margin-bottom:1.2rem;
}
.page-back-btn { font-size:.85rem; }
.page-title { font-size:1.5rem; font-weight:700; color:#1a2b3c; }
/* ── Section divider ── */
.sec-divider {
    border: none; border-top: 1.5px solid #e2eaf1;
    margin: 1.4rem 0;
}
/* ── Compact metric row ── */
.metric-strip {
    display:flex; gap:.8rem; margin:.6rem 0 1rem;
    flex-wrap: wrap;
}
</style>
""", unsafe_allow_html=True)

# ── Helper: botón "← Inicio" ────────────────────────────────────────
def back_button(label="← Volver al inicio"):
    if st.button(label, key=f"back_{st.session_state.current_page}"):
        go_to("home")
        st.rerun()

# ── Datos base (se computan sólo si hay sheets) ──────────────────────
df_T = df_HR = df_RAD = df_WIND = None
has_T = has_HR = has_RAD = has_WIND = False
yr_lo = yr_hi = None

if sheets:
    df_T    = sheets.get("Temperatura")
    df_HR   = sheets.get("Humedad")
    df_RAD  = sheets.get("Radiacion")
    df_WIND = sheets.get("Viento")
    has_T    = df_T    is not None and len(df_T)    > 0
    has_HR   = df_HR   is not None and len(df_HR)   > 0
    has_RAD  = df_RAD  is not None and len(df_RAD)  > 0
    has_WIND = df_WIND is not None and len(df_WIND) > 0

# ═══════════════════════════════════════════════════════════════════════
# PÁGINA: HOME
# ═══════════════════════════════════════════════════════════════════════
if st.session_state.current_page == "home":
    st.markdown('<div class="main-header">🌤️ Análisis de Datos Meteorológicos</div>',
                unsafe_allow_html=True)
    station_name = meta.get("nombre") or "—"
    st.caption(f"Estación activa: **{station_name}** &nbsp;|&nbsp; Backend: `{st.session_state.api_base}`")

    st.markdown("---")

    # ── Bloque de carga de archivos si no hay datos ──────────────────
    if not sheets:
        col_info, col_fmt = st.columns([1, 1])
        with col_info:
            st.info("👈 Sube tus archivos en el **sidebar** y presiona **'Cargar datos'** para comenzar.")
        with col_fmt:
            with st.expander("📋 Formatos aceptados"):
                st.markdown("""
| Formato | Encabezado | Horas |
|---|---|---|
| **A** | `año mes dia H1…H24` | `H1`–`H24` |
| **B** | Fila 0: tipo · Fila 1: `Año Mes Día 01:00…24:00` | `01:00`–`24:00` |
| **Viento** | `Fecha;Hora;Dirección;Velocidad;Grados` | — |
""")

    # ── Filtro de años (visible en home si hay datos) ────────────────
    if sheets:
        all_dts = []
        for k, v in sheets.items():
            if "_dt" in v.columns:
                all_dts.extend(v["_dt"].dropna().tolist())
        if all_dts:
            year_min = int(pd.Timestamp(min(all_dts)).year)
            year_max = int(pd.Timestamp(max(all_dts)).year)
            if year_min < year_max:
                yr_lo, yr_hi = st.select_slider(
                    "📅 Rango de años",
                    options=list(range(year_min, year_max + 1)),
                    value=(year_min, year_max),
                    key="home_yr_slider"
                )
            else:
                yr_lo, yr_hi = year_min, year_max
            st.session_state["yr_lo"] = yr_lo
            st.session_state["yr_hi"] = yr_hi

        # KPIs rápidos
        kpi_cols = st.columns(4)
        total_rows = sum(len(v) for v in sheets.values())
        kpi_cols[0].metric("📦 Registros totales", f"{total_rows:,}")
        kpi_cols[1].metric("🗂️ Variables cargadas", len(sheets))
        if has_T:
            kpi_cols[2].metric("🌡️ Rango T",
                f"{df_T['Temperatura'].min():.1f}–{df_T['Temperatura'].max():.1f} °C")
        if has_HR:
            kpi_cols[3].metric("💧 HR promedio",
                f"{df_HR['Humedad'].mean():.1f} %")

        with st.expander("📂 Datos cargados en memoria"):
            for k, v in sheets.items():
                st.write(f"**{k}**: {len(v):,} filas | cols: {list(v.columns)}")
                st.dataframe(v.head(4))

    st.markdown("---")

    # ── Cards de navegación ──────────────────────────────────────────
    st.markdown("### 🗺️ ¿A dónde quieres ir?")

    st.markdown("#### ⚙️ Gestión")
    r3 = st.columns(4)
    cards_row3 = [
        ("base_datos", "🗄️", "Base de Datos",  "Subir datos a Supabase", True),
        ("graficos",   "📊", "Gráficos",        "Visualizar todos los gráficos", True),
        (None, None, None, None, False),
        (None, None, None, None, False),
    ]
    for col, (page, icon, title, sub, active) in zip(r3, cards_row3):
        with col:
            if page is None:
                st.empty()
                continue
            st.markdown(f"""
<div class="nav-card">
  <div class="nc-icon">{icon}</div>
  <div class="nc-title">{title}</div>
  <div class="nc-sub">{sub}</div>
  <span class="nc-badge">Disponible</span>
</div>
""", unsafe_allow_html=True)
            if st.button("Abrir →", key=f"nav_{page}", use_container_width=True):
                go_to(page)
                st.rerun()

    st.stop()

# ── Fuera de home: preparar datos con filtro de años ────────────────
yr_lo = st.session_state.get("yr_lo")
yr_hi = st.session_state.get("yr_hi")

if sheets and yr_lo and yr_hi:
    def filter_years(dv):
        if dv is None: return None
        mask = (dv["_dt"].dt.year >= yr_lo) & (dv["_dt"].dt.year <= yr_hi)
        return dv[mask].reset_index(drop=True)
    df_T    = filter_years(df_T)
    df_HR   = filter_years(df_HR)
    df_RAD  = filter_years(df_RAD)
    df_WIND = filter_years(df_WIND)
    has_T    = df_T    is not None and len(df_T)    > 0
    has_HR   = df_HR   is not None and len(df_HR)   > 0
    has_RAD  = df_RAD  is not None and len(df_RAD)  > 0
    has_WIND = df_WIND is not None and len(df_WIND) > 0

# ── Breadcrumb común ────────────────────────────────────────────────
_PAGE_LABELS = {
    "resumen":    "🗂️ Resumen General",
    "depuracion": "📊 Depuración",
    "control":    "📈 Control de Calidad",
    "fdp_temp":   "🔔 FDP Temperatura",
    "fdp_hum":    "💧 FDP Humedad",
    "mapas":      "🗺️ Mapas de Calor",
    "viento":     "💨 Viento",
    "combinado":  "🔗 Combinado T–HR",
    "base_datos": "🗄️ Base de Datos",
    "graficos":   "📊 Gráficos",
}
_cur = st.session_state.current_page
_lbl = _PAGE_LABELS.get(_cur, _cur)

col_bc1, col_bc2 = st.columns([1, 6])
with col_bc1:
    if st.button("🏠 Inicio", key="global_back"):
        go_to("home")
        st.rerun()
col_bc2.markdown(f'<span style="font-size:1.35rem;font-weight:700;color:#1a2b3c;">{_lbl}</span>',
                 unsafe_allow_html=True)
st.markdown('<hr class="sec-divider">', unsafe_allow_html=True)

# ═══════════════════════════════════════════════════════════════════════
# PÁGINAS internas — sustituyen los tabs
# Cada bloque es  if _cur == "nombre": ... y al final hace st.stop()
# ═══════════════════════════════════════════════════════════════════════

_PAGE_ORDER = [
    "resumen","depuracion","control",
    "fdp_temp","fdp_hum","mapas",
    "viento","combinado","base_datos","graficos",
]

def _show(idx):
    """Devuelve True si la página activa coincide con este bloque."""
    return _cur == _PAGE_ORDER[idx]

# Navegación inferior entre páginas de análisis
def _page_nav(idx):
    """Botones anterior / inicio / siguiente al pie de cada página."""
    st.markdown('<hr class="sec-divider">', unsafe_allow_html=True)
    _analysis_pages = ["resumen","depuracion","control","fdp_temp","fdp_hum","mapas","viento","combinado"]
    if _PAGE_ORDER[idx] not in _analysis_pages:
        if st.button("🏠 Volver al inicio", key=f"nav_home_{idx}"):
            go_to("home"); st.rerun()
        return
    pos = _analysis_pages.index(_PAGE_ORDER[idx])
    c1, c2, c3 = st.columns([1, 1, 1])
    if pos > 0:
        if c1.button(f"← {_analysis_pages[pos-1].replace('_',' ').title()}", key=f"prev_{idx}"):
            go_to(_analysis_pages[pos-1]); st.rerun()
    if c2.button("🏠 Inicio", key=f"home_{idx}"):
        go_to("home"); st.rerun()
    if pos < len(_analysis_pages) - 1:
        if c3.button(f"{_analysis_pages[pos+1].replace('_',' ').title()} →", key=f"next_{idx}"):
            go_to(_analysis_pages[pos+1]); st.rerun()

# ─────────────────────────────────────────────────────────────────────
# TAB 0 – RESUMEN
# ─────────────────────────────────────────────────────────────────────
if _show(0):
    st.markdown("## 🗂️ Resumen General")
    if meta["nombre"]:
        st.markdown(f"**Estación:** {meta['nombre']}  |  "
                    f"**Lat:** {meta['lat']:.4f}  |  "
                    f"**Lon:** {meta['lon']:.4f}  |  "
                    f"**Alt:** {meta['alt']:.0f} m")
        st.markdown("---")

    overview_cols = st.columns(4)
    variables_overview = [
        ("🌡️ Temperatura", df_T,   "Temperatura"),
        ("💧 Humedad",      df_HR,  "Humedad"),
        ("☀️ Radiación",    df_RAD, "Radiacion"),
        ("💨 Viento",       df_WIND,"velocidad"),
    ]
    for i, (label, dv, col) in enumerate(variables_overview):
        with overview_cols[i]:
            if dv is not None and len(dv) > 0 and col in dv.columns:
                s = to_float_col(dv[col])
                lo, hi = VALID_RANGES.get(col, (None, None))
                if lo is not None: s[s < lo] = np.nan
                if hi is not None: s[s > hi] = np.nan
                valid  = int(s.notna().sum())
                dt_min = dv["_dt"].min()
                dt_max = dv["_dt"].max()
                ideal  = int((dt_max - dt_min).total_seconds() / 3600) + 1
                pct    = min(valid / ideal * 100, 100) if ideal > 0 else 0.0
                badge  = ("🟢" if pct >= 98 else ("🔵" if pct >= 95 else
                          ("🟡" if pct >= 90 else ("🟠" if pct >= 85 else "🔴"))))
                st.metric(label, f"{badge} {pct:.1f}%")
                st.caption(f"{dt_min.strftime('%Y-%m-%d')} → {dt_max.strftime('%Y-%m-%d')}")
                st.caption(f"{valid:,} registros válidos")
            else:
                st.metric(label, "⚫ Sin datos")

    st.markdown("---")
    st.markdown("### 📅 Completitud anual por variable")
    for label, dv, col in variables_overview:
        if dv is None or col not in dv.columns: continue
        dv2 = dv.copy()
        s   = to_float_col(dv2[col])
        lo, hi = VALID_RANGES.get(col, (None, None))
        if lo is not None: s[s < lo] = np.nan
        if hi is not None: s[s > hi] = np.nan
        dv2["_valid"] = s.notna().astype(int)
        dv2["_year"]  = dv2["_dt"].dt.year
        by_year = dv2.groupby("_year").agg(valid=("_valid","sum"), total=("_valid","count"))
        by_year["pct"] = (by_year["valid"] / by_year["total"] * 100).clip(0, 100)
        colors = ["#2ecc71" if p >= 95 else ("#f39c12" if p >= 85 else "#e74c3c")
                  for p in by_year["pct"]]
        fig = go.Figure(go.Bar(
            x=by_year.index.astype(str), y=by_year["pct"],
            marker_color=colors,
            text=[f"{p:.0f}%" for p in by_year["pct"]], textposition="outside"
        ))
        fig.update_layout(title=f"Completitud anual – {label}",
                          xaxis_title="Año", yaxis_title="Completitud (%)",
                          yaxis_range=[0,110], height=280, template="plotly_white",
                          margin=dict(t=40,b=20))
        st.plotly_chart(fig, use_container_width=True)

    _page_nav(0)

# ─────────────────────────────────────────────────────────────────────
# TAB 1 – DEPURACIÓN
# ─────────────────────────────────────────────────────────────────────
if _show(1):
    st.markdown("## 📊 Depuración y Estadísticos")
    for label, dv, col in [
        ("Temperatura",      df_T,  "Temperatura"),
        ("Humedad Relativa", df_HR, "Humedad"),
        ("Radiación Global", df_RAD,"Radiacion"),
    ]:
        if dv is None or col not in dv.columns: continue
        st.markdown(f"### {label}")
        lo, hi = VALID_RANGES.get(col, (None, None))
        units  = UNITS.get(col, "")
        s = pd.to_numeric(dv[col], errors="coerce").copy()
        if lo is not None: s[s < lo] = np.nan
        if hi is not None: s[s > hi] = np.nan
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
            c1b,c2b,c3b,c4b,c5b,c6b,c7b = st.columns(7)
            c1b.metric("Mínimo",  f"{sv.min():.2f} {units}")
            c2b.metric("Q25",     f"{sv.quantile(.25):.2f}")
            c3b.metric("Media",   f"{sv.mean():.2f}")
            c4b.metric("Mediana", f"{sv.median():.2f}")
            c5b.metric("Q75",     f"{sv.quantile(.75):.2f}")
            c6b.metric("Máximo",  f"{sv.max():.2f} {units}")
            c7b.metric("Desv. σ", f"{sv.std():.2f} {units}")

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
                rows.append({"Inicio": str(start.date()),
                             "Fin":    str(end.date()),
                             "Días perdidos": (end-start).days})
            st.dataframe(pd.DataFrame(rows), use_container_width=True)
        else:
            st.success(f"✅ Sin huecos > 5 días en {label}")
        st.markdown("---")

# ─────────────────────────────────────────────────────────────────────
# TAB 2 – GRÁFICOS DE CONTROL
# ─────────────────────────────────────────────────────────────────────
if _show(2):
    st.markdown("## 📈 Gráficos de Control – Serie Temporal")
    for label, dv, col, color, units in [
        ("Temperatura",      df_T,  "Temperatura","#e74c3c","°C"),
        ("Humedad Relativa", df_HR, "Humedad",    "#2980b9","%"),
        ("Radiación Global", df_RAD,"Radiacion",  "#f39c12","MJ/m²"),
    ]:
        if dv is None or col not in dv.columns: continue
        s   = dv.dropna(subset=[col]).sort_values("_dt")
        mu  = s[col].mean(); sig = s[col].std()
        q25 = s[col].quantile(0.25); q75 = s[col].quantile(0.75)
        vmin = s[col].min(); vmax = s[col].max()
        an  = s[np.abs(s[col] - mu) > 3*sig]
        st.caption(f"📅 {s['_dt'].min().strftime('%d/%m/%Y')} → "
                   f"{s['_dt'].max().strftime('%d/%m/%Y')}")
        fig = go.Figure()
        fig.add_trace(go.Scatter(x=s["_dt"], y=s[col], mode="lines",
                                 name=label, line=dict(color=color, width=0.8),
                                 opacity=0.75))
        for y, dash, color_l, label_l in [
            (mu,         "dash",     "gray",    f"Media={mu:.1f}"),
            (mu+3*sig,   "dot",      "orange",  f"+3σ={mu+3*sig:.1f}"),
            (mu-3*sig,   "dot",      "orange",  f"−3σ={mu-3*sig:.1f}"),
            (q25,        "longdash", "#2980b9", f"Q25={q25:.1f}"),
            (q75,        "longdash", "#e74c3c", f"Q75={q75:.1f}"),
            (vmin,       "dot",      "#95a5a6", f"Min={vmin:.1f}"),
            (vmax,       "dot",      "#95a5a6", f"Max={vmax:.1f}"),
        ]:
            fig.add_hline(y=y, line_dash=dash, line_color=color_l,
                          annotation_text=label_l)
        if len(an):
            fig.add_trace(go.Scatter(x=an["_dt"], y=an[col], mode="markers",
                                     name=f"Anómalos ({len(an)})",
                                     marker=dict(color="red", size=5, symbol="x")))
        fig.update_layout(
            title=f"{label} | Anómalos >3σ: {len(an)}",
            xaxis_title="Fecha", yaxis_title=f"{label} ({units})",
            height=440, template="plotly_white",
            legend=dict(orientation="h", y=1.08))
        st.plotly_chart(fig, use_container_width=True)

# ─────────────────────────────────────────────────────────────────────
# TAB 3 – FDP TEMPERATURA
# ─────────────────────────────────────────────────────────────────────
if _show(3):
    st.markdown("## 🔔 FDP – Temperatura")
    if not has_T:
        st.info("No hay datos de Temperatura cargados.")
    else:
        s = to_float_col(df_T["Temperatura"]).dropna()
        lo, hi = VALID_RANGES["Temperatura"]
        s = s[(s >= lo) & (s <= hi)]
        xc, counts, params, rmse, ok = fit_gaussians(tuple(s.values), n=n_gauss)
        x_plot = np.linspace(s.min(), s.max(), 400)
        fig = go.Figure()
        fig.add_trace(go.Bar(x=xc, y=counts, name="Histograma",
                             marker_color="rgba(52,152,219,0.4)",
                             width=(xc[1]-xc[0])))
        total_fit = np.zeros_like(x_plot, dtype=float)
        for i in range(n_gauss):
            mu_i, sig_i, w_i = params[3*i], abs(params[3*i+1]), abs(params[3*i+2])
            yi = gaussian_pdf(x_plot, mu_i, sig_i, w_i)
            total_fit += yi
            fig.add_trace(go.Scatter(x=x_plot, y=yi, mode="lines",
                                     name=f"G{i+1} μ={mu_i:.1f} σ={sig_i:.1f} w={w_i:.2f}",
                                     line=dict(color=COLORS_G[i], width=2, dash="dash")))
        fig.add_trace(go.Scatter(x=x_plot, y=total_fit, mode="lines",
                                 name="Ajuste total",
                                 line=dict(color="black", width=2.5)))
        emc = float(np.sqrt(np.mean((counts - np.interp(xc, x_plot, total_fit))**2)))
        fig.update_layout(
            title=f"FDP Temperatura – EMC={emc:.6f} {'✅' if emc < EMC_THRESHOLD else '⚠️'}",
            xaxis_title="Temperatura (°C)", yaxis_title="Densidad",
            height=440, template="plotly_white",
            legend=dict(orientation="h", y=1.08))
        st.plotly_chart(fig, use_container_width=True)
        st.metric("EMC", f"{emc:.6f}",
                  delta="OK" if emc < EMC_THRESHOLD else "Alto", delta_color="normal")

# ─────────────────────────────────────────────────────────────────────
# TAB 4 – FDP HUMEDAD
# ─────────────────────────────────────────────────────────────────────
if _show(4):
    st.markdown("## 💧 FDP – Humedad Relativa")
    if not has_HR:
        st.info("No hay datos de Humedad cargados.")
    else:
        s = to_float_col(df_HR["Humedad"]).dropna()
        s = s[(s >= 0) & (s <= 100)]
        xc, counts, params, rmse, ok = fit_betas(tuple(s.values), n=n_beta)
        x_plot = np.linspace(0, 100, 400)
        fig = go.Figure()
        fig.add_trace(go.Bar(x=xc, y=counts, name="Histograma",
                             marker_color="rgba(41,128,185,0.4)",
                             width=(xc[1]-xc[0])))
        total_fit = np.zeros_like(x_plot, dtype=float)
        for i in range(n_beta):
            a_i, b_i, w_i = abs(params[3*i]), abs(params[3*i+1]), abs(params[3*i+2])
            yi = beta_pdf(x_plot, a_i, b_i, w_i)
            total_fit += yi
            fig.add_trace(go.Scatter(x=x_plot, y=yi, mode="lines",
                                     name=f"β{i+1} α={a_i:.2f} β={b_i:.2f} w={w_i:.2f}",
                                     line=dict(color=COLORS_B[i], width=2, dash="dash")))
        fig.add_trace(go.Scatter(x=x_plot, y=total_fit, mode="lines",
                                 name="Ajuste total",
                                 line=dict(color="black", width=2.5)))
        emc = float(np.sqrt(np.mean((counts - np.interp(xc, x_plot, total_fit))**2)))
        fig.update_layout(
            title=f"FDP Humedad – EMC={emc:.6f} {'✅' if emc < EMC_THRESHOLD else '⚠️'}",
            xaxis_title="Humedad Relativa (%)", yaxis_title="Densidad",
            height=440, template="plotly_white",
            legend=dict(orientation="h", y=1.08))
        st.plotly_chart(fig, use_container_width=True)
        st.metric("EMC", f"{emc:.6f}",
                  delta="OK" if emc < EMC_THRESHOLD else "Alto", delta_color="normal")

# ─────────────────────────────────────────────────────────────────────
# TAB 5 – MAPAS DE CALOR
# ─────────────────────────────────────────────────────────────────────
if _show(5):
    st.markdown("## 🗺️ Mapas de Calor – Hora × Mes")
    for label, dv, col, cscale in [
        ("Temperatura (°C)",    df_T,  "Temperatura","RdBu_r"),
        ("Humedad Relativa (%)",df_HR, "Humedad",    "Blues"),
        ("Radiación (MJ/m²)",  df_RAD,"Radiacion",  "YlOrRd"),
    ]:
        if dv is None or col not in dv.columns: continue
        tmp = dv.copy()
        tmp["_hora"] = tmp["_dt"].dt.hour
        tmp["_mes"]  = tmp["_dt"].dt.month
        pivot = tmp.groupby(["_hora","_mes"])[col].mean().unstack(fill_value=np.nan)
        fig = go.Figure(go.Heatmap(
            z=pivot.values,
            x=[MONTH_NAMES[m-1] for m in pivot.columns],
            y=[f"{h:02d}:00" for h in pivot.index],
            colorscale=cscale, colorbar=dict(title=label)
        ))
        fig.update_layout(title=f"Promedio {label} por hora y mes",
                          xaxis_title="Mes", yaxis_title="Hora del día",
                          height=420, template="plotly_white")
        st.plotly_chart(fig, use_container_width=True)

# ─────────────────────────────────────────────────────────────────────
# TAB 6 – VIENTO
# ─────────────────────────────────────────────────────────────────────
if _show(6):
    st.markdown("## 💨 Análisis de Viento")
    if not has_WIND:
        st.info("No hay datos de Viento cargados.")
    else:
        dw = df_WIND.copy()
        dw["_hora"] = dw["_dt"].dt.hour
        dw["_mes"]  = dw["_dt"].dt.month

        if "velocidad" in dw.columns:
            sv = dw["velocidad"].dropna()
            c1,c2,c3 = st.columns(3)
            c1.metric("Velocidad media",  f"{sv.mean():.2f} m/s")
            c2.metric("Velocidad máxima", f"{sv.max():.2f} m/s")
            c3.metric("Velocidad mínima", f"{sv.min():.2f} m/s")
            fig1 = go.Figure(go.Histogram(x=sv, nbinsx=40,
                                          marker_color="#2980b9", opacity=0.75))
            fig1.update_layout(title="Distribución de velocidad",
                               xaxis_title="m/s", yaxis_title="Frecuencia",
                               height=360, template="plotly_white")
            st.plotly_chart(fig1, use_container_width=True)

        if "dir_grados" in dw.columns and "velocidad" in dw.columns:
            fig2 = go.Figure(go.Scatterpolar(
                r=dw["velocidad"].fillna(0),
                theta=dw["dir_grados"].fillna(0),
                mode="markers",
                marker=dict(color=dw["velocidad"], colorscale="Viridis",
                            size=3, opacity=0.5,
                            colorbar=dict(title="Vel (m/s)"))))
            fig2.update_layout(
                title="Rosa de vientos",
                polar=dict(angularaxis=dict(direction="clockwise", rotation=90)),
                height=480)
            st.plotly_chart(fig2, use_container_width=True)

# ─────────────────────────────────────────────────────────────────────
# TAB 7 – COMBINADO T–HR
# ─────────────────────────────────────────────────────────────────────
if _show(7):
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

        samp_key = "merged_sample"
        if samp_key not in st.session_state or len(st.session_state[samp_key]) == 0:
            st.session_state[samp_key] = merged.sample(
                min(3000, len(merged)), random_state=42)
        samp = st.session_state[samp_key]

        from scipy.stats import gaussian_kde
        Z_kde = None
        try:
            kde = gaussian_kde(np.vstack([merged["Temperatura"], merged["Humedad"]]))
            density_vals = kde(np.vstack([merged["Temperatura"], merged["Humedad"]]))
            p90 = np.percentile(density_vals, 10)
            p95 = np.percentile(density_vals, 5)
            p99 = np.percentile(density_vals, 1)
            t_grid = np.linspace(merged["Temperatura"].min(),
                                 merged["Temperatura"].max(), 80)
            h_grid = np.linspace(merged["Humedad"].min(),
                                 merged["Humedad"].max(), 80)
            TT, HH = np.meshgrid(t_grid, h_grid)
            Z_kde  = kde(np.vstack([TT.ravel(), HH.ravel()])).reshape(TT.shape)
        except Exception:
            pass

        fig = go.Figure()
        fig.add_trace(go.Histogram2dContour(
            x=merged["Temperatura"], y=merged["Humedad"],
            colorscale="Blues", showscale=True,
            contours=dict(showlabels=True, coloring="heatmap"), name="Densidad"))
        fig.add_trace(go.Scatter(
            x=samp["Temperatura"], y=samp["Humedad"], mode="markers",
            marker=dict(color="rgba(50,50,150,0.08)", size=3),
            name="Datos (muestra)"))
        if Z_kde is not None:
            for level, pct_label, clr in [
                (p90,"90%","#e74c3c"),(p95,"95%","#e67e22"),(p99,"99%","#f1c40f")
            ]:
                fig.add_trace(go.Contour(
                    x=t_grid, y=h_grid, z=Z_kde,
                    contours=dict(start=level, end=level, size=0,
                                  showlabels=True,
                                  labelfont=dict(size=10, color=clr)),
                    line=dict(color=clr, width=2),
                    showscale=False, name=f"Percentil {pct_label}"))
        wet     = merged[(merged["Temperatura"] > 10) & (merged["Humedad"] > 79)]
        pct_wet = len(wet) / len(merged) * 100
        tmax    = merged["Temperatura"].max()
        fig.add_trace(go.Scatter(
            x=[10,10,tmax,tmax,10], y=[79,100,100,79,79],
            mode="lines", fill="toself",
            fillcolor="rgba(231,76,60,0.08)",
            line=dict(color="red", dash="dash", width=1.5),
            name=f"Humectación = {pct_wet:.1f}%"))
        fig.update_layout(
            title="Densidad T–HR con contornos percentilares",
            xaxis_title="Temperatura (°C)", yaxis_title="Humedad Relativa (%)",
            height=540, template="plotly_white",
            legend=dict(orientation="h", y=1.06))
        st.plotly_chart(fig, use_container_width=True)

        c1, c2 = st.columns(2)
        c1.metric("Tiempo de humectación (T>10°C, HR>79%)", f"{pct_wet:.1f}%")
        c2.metric("Correlación Pearson T–HR",
                  f"{merged['Temperatura'].corr(merged['Humedad']):.3f}")

        st.markdown("### Variabilidad horaria T y HR")
        merged["_hora"] = merged["_dt"].dt.hour
        hourly_t  = merged.groupby("_hora")["Temperatura"].mean()
        hourly_hr = merged.groupby("_hora")["Humedad"].mean()
        fig_h = make_subplots(specs=[[{"secondary_y": True}]])
        fig_h.add_trace(go.Scatter(x=hourly_t.index, y=hourly_t.values,
                                   mode="lines+markers", name="T media (°C)",
                                   line=dict(color="#e74c3c", width=2.5)),
                        secondary_y=False)
        fig_h.add_trace(go.Scatter(x=hourly_hr.index, y=hourly_hr.values,
                                   mode="lines+markers", name="HR media (%)",
                                   line=dict(color="#2980b9", width=2.5)),
                        secondary_y=True)
        fig_h.update_xaxes(title_text="Hora del día",
                           tickvals=list(range(0,24,2)),
                           ticktext=[f"{h:02d}:00" for h in range(0,24,2)])
        fig_h.update_yaxes(title_text="Temperatura (°C)", secondary_y=False)
        fig_h.update_yaxes(title_text="Humedad Relativa (%)", secondary_y=True)
        fig_h.update_layout(title="Variación horaria T y HR",
                            height=360, template="plotly_white",
                            legend=dict(orientation="h", y=1.08))
        st.plotly_chart(fig_h, use_container_width=True)

        st.markdown("### Gráfico Psicrométrico")
        Z_alt   = float(meta["alt"])
        P_total = 1013.25 * (1 - 2.25577e-5 * Z_alt)**5.2559
        P_sat   = (9.066 * np.exp(0.0641 * merged["Temperatura"])
                   - 1.796 * np.exp(0.0805 * merged["Temperatura"]))
        HR_f    = merged["Humedad"] / 100.0
        merged["H_abs"] = (18000/29) * (HR_f * P_sat) / (P_total - HR_f * P_sat)
        samp2 = merged.sample(min(4000, len(merged)), random_state=2)
        fig3 = go.Figure(go.Scatter(
            x=samp2["Temperatura"], y=samp2["H_abs"], mode="markers",
            marker=dict(color=samp2["Humedad"], colorscale="Blues",
                        size=3, opacity=0.6, showscale=True,
                        colorbar=dict(title="HR (%)"))))
        fig3.update_layout(
            title=f"Psicrométrico T vs H_abs  (Z={Z_alt:.0f} m)",
            xaxis_title="Temperatura (°C)",
            yaxis_title="Humedad Absoluta (g/kg aire seco)",
            height=460, template="plotly_white")
        st.plotly_chart(fig3, use_container_width=True)

        st.markdown("### Variación mensual T y HR")
        merged["_mes"] = merged["_dt"].dt.month
        monthly = merged.groupby("_mes")[["Temperatura","Humedad"]].mean()
        monthly.index = [MONTH_NAMES[m-1] for m in monthly.index]
        fig4 = make_subplots(specs=[[{"secondary_y": True}]])
        fig4.add_trace(go.Scatter(x=monthly.index, y=monthly["Temperatura"],
                                  mode="lines+markers", name="T media (°C)",
                                  line=dict(color="#e74c3c", width=2.5)),
                       secondary_y=False)
        fig4.add_trace(go.Scatter(x=monthly.index, y=monthly["Humedad"],
                                  mode="lines+markers", name="HR media (%)",
                                  line=dict(color="#2980b9", width=2.5)),
                       secondary_y=True)
        fig4.update_yaxes(title_text="Temperatura (°C)", secondary_y=False)
        fig4.update_yaxes(title_text="Humedad Relativa (%)", secondary_y=True)
        fig4.update_layout(title="Variación mensual T y HR",
                           height=380, template="plotly_white",
                           legend=dict(orientation="h", y=1.08))
        st.plotly_chart(fig4, use_container_width=True)

# ─────────────────────────────────────────────────────────────────────
# TAB 8 – BASE DE DATOS
# ─────────────────────────────────────────────────────────────────────
if _show(8):
    st.markdown("## 🗄️ Base de Datos – Supabase")
    st.caption(f"Backend activo: **{st.session_state.api_base}**  "
               "(cámbialo en el sidebar si es necesario)")

    # ── Verificar conexión ──────────────────────────────────────────
    st.markdown("### 🔌 Conexión al backend")
    col_conn1, col_conn2 = st.columns([1, 3])
    if col_conn1.button("🔁 Verificar conexión"):
        stations_test, err = api_get_stations()
        if err:
            st.error(f"❌ Sin conexión: {err}")
            st.info("Asegúrate de que el backend esté corriendo:\n\n"
                    "```bash\ncd Backend\nuvicorn main:app --reload --port 8000\n```")
        else:
            st.success(f"✅ Backend OK — {len(stations_test)} estación(es) en BD")

    st.markdown("---")

    # ── Sección 1: Estaciones ───────────────────────────────────────
    st.markdown("### 🏔️ 1. Estaciones registradas")
    stations_list, st_err = api_get_stations()
    if st_err:
        st.warning(f"No se pudo obtener estaciones: {st_err}")
        stations_list = []

    if stations_list:
        st.dataframe(pd.DataFrame(stations_list), use_container_width=True)
    else:
        st.info("No hay estaciones registradas aún.")

    st.markdown("#### ➕ Registrar nueva estación")

    tab_sel_st, tab_new_st = st.tabs(["Seleccionar existente", "Registrar nueva"])

    db_selected_station_id = None

    with tab_sel_st:
        if not stations_list:
            st.info("No hay estaciones. Regístrala en la pestaña **Registrar nueva**.")
        else:
            st_opts = {f"{s['station_code']} — {s['name']}": s["id"]
                       for s in stations_list}
            st_sel  = st.selectbox("Estación activa", list(st_opts.keys()),
                                   key="db_station_sel")
            db_selected_station_id = st_opts[st_sel]
            st.success(f"✅ Estación seleccionada: **{st_sel}**")

    with tab_new_st:
        with st.form("form_station"):
            col1, col2 = st.columns(2)
            f_code = col1.text_input("Código único *", placeholder="EST-101")
            f_name = col2.text_input("Nombre completo *",
                                     value=meta.get("nombre", ""),
                                     placeholder="Estación 101 – La Uruca")
            col3, col4, col5 = st.columns(3)
            f_lat  = col3.number_input("Latitud",     value=meta.get("lat", 0.0),
                                       format="%.6f")
            f_lon  = col4.number_input("Longitud",    value=meta.get("lon", 0.0),
                                       format="%.6f")
            f_alt  = col5.number_input("Altitud (m)", value=meta.get("alt", 0.0))
            f_inst = st.text_input("Institución", placeholder="IMN")
            submitted_st = st.form_submit_button("💾 Guardar estación", type="primary")

        if submitted_st:
            if not f_code or not f_name:
                st.error("El código y el nombre son obligatorios.")
            else:
                result, err = api_create_station({
                    "station_code":    f_code,
                    "name":            f_name,
                    "latitude":        float(f_lat),
                    "longitude":       float(f_lon),
                    "altitude_meters": float(f_alt),
                    "institution":     f_inst or None,
                })
                if err:
                    st.error(f"❌ Error: {err}")
                else:
                    st.success(f"✅ Estación creada — ID: {result.get('id')}")
                    db_selected_station_id = result["id"]
                    st.rerun()

    st.markdown("---")

    # ── Sección 2: Subir datos ──────────────────────────────────────
    st.markdown("### 📤 2. Subir datos a Supabase")

    variables_list, _ = api_get_variables()
    VAR_TO_KEY = {"TEMP": "Temperatura", "HR": "Humedad",
                  "RAD": "Radiacion", "VIENTO": "Viento"}

    if not stations_list:
        st.warning("⚠️ Primero registra al menos una estación (sección 1).")
    else:
        if not db_selected_station_id:
            st.info("Selecciona una estación en la sección 1 para continuar.")
        else:
            # ── Paso A: Variable (opcional — detección automática) ──────
            st.markdown("#### 📊 Variable meteorológica")
            if not variables_list:
                st.info(
                    "ℹ️ El backend detectará la variable automáticamente. "
                    "Si quieres forzarla, inserta las variables en Supabase primero:"
                )
                with st.expander("SQL para insertar variables"):
                    st.code("""
INSERT INTO variables (code, name, unit) VALUES
  ('TEMP',   'Temperatura',          '°C'),
  ('HR',     'Humedad Relativa',      '%'),
  ('RAD',    'Radiación Global',      'MJ/m²'),
  ('VIENTO', 'Velocidad del Viento',  'm/s')
ON CONFLICT (code) DO NOTHING;
""", language="sql")
                db_variable_id = None
            else:
                use_auto = st.checkbox(
                    "Detectar variable automáticamente (recomendado)", value=True,
                    key="db_auto_var"
                )
                db_variable_id = None
                if not use_auto:
                    var_opts = {
                        f"{v['code']} — {v['name']} ({v['unit']})": v["id"]
                        for v in variables_list
                    }
                    sel_var_db     = st.selectbox("Variable", list(var_opts.keys()),
                                                  key="db_var_sel")
                    db_variable_id = var_opts[sel_var_db]

            st.markdown("---")

            # ── Paso B: Origen del archivo ──────────────────────────────
            st.markdown("#### 📂 Origen de datos")

            upload_tab_a, upload_tab_b = st.tabs([
                "Subir nuevo archivo",
                "Usar archivo ya cargado en el sidebar",
            ])

            # ---- Subir nuevo archivo directamente ----------------------
            with upload_tab_a:
                st.markdown("""
| Formato | Descripción |
|---|---|
| **CSV (sep=;)** | Fila 0: tipo de variable · Fila 1: `Año Mes Día 01:00 … 24:00` |
| **CSV alternativo** | Encabezado en fila 0 con columnas `H1 H2 … H24` |
| **Excel (.xlsx)** | Una hoja por variable, mismo formato que CSV |
""")
                db_uploaded_file = st.file_uploader(
                    "Selecciona un archivo CSV o Excel",
                    type=["csv", "xlsx", "xls"],
                    key="db_file_uploader",
                )
                if db_uploaded_file:
                    st.info(f"📄 **{db_uploaded_file.name}** "
                            f"({db_uploaded_file.size:,} bytes)")
                    if st.button("🚀 Enviar al backend", type="primary",
                                 use_container_width=True, key="btn_new_file"):
                        fb = db_uploaded_file.read()
                        with st.spinner("Procesando… puede tardar unos segundos."):
                            result, err = api_upload_file(
                                fb, db_uploaded_file.name,
                                db_selected_station_id, db_variable_id,
                            )
                        if err:
                            st.error(f"❌ Error: {err}")
                        else:
                            st.success("✅ Archivo procesado correctamente")
                            c1, c2, c3 = st.columns(3)
                            c1.metric("Variable detectada",
                                      result.get("variable_type", "—"))
                            c2.metric("Filas parseadas",
                                      f"{result.get('rows_parsed', 0):,}")
                            c3.metric("Filas insertadas",
                                      f"{result.get('rows_inserted', 0):,}")
                            with st.expander("📋 Logs del parser"):
                                for log in result.get("logs", []):
                                    if log.startswith("✅"):
                                        st.success(log)
                                    elif log.startswith("⚠️"):
                                        st.warning(log)
                                    else:
                                        st.error(log)

            # ---- Usar archivo ya cargado en el sidebar -----------------
            with upload_tab_b:
                raw_bytes_map = st.session_state.get("raw_file_bytes", {})
                if not raw_bytes_map:
                    st.info("Carga archivos primero desde el sidebar (📂 Archivos de datos).")
                else:
                    file_sel = st.selectbox("Archivo a enviar",
                                            list(raw_bytes_map.keys()),
                                            key="db_file_sel")
                    if st.button("📤 Enviar archivo al backend", key="btn_raw"):
                        with st.spinner("Enviando…"):
                            result, err = api_upload_file(
                                raw_bytes_map[file_sel], file_sel,
                                db_selected_station_id, db_variable_id,
                            )
                        if err:
                            st.error(f"❌ {err}")
                        else:
                            st.success("✅ Archivo procesado correctamente")
                            c1, c2, c3 = st.columns(3)
                            c1.metric("Variable detectada",
                                      result.get("variable_type", "—"))
                            c2.metric("Filas parseadas",
                                      f"{result.get('rows_parsed', 0):,}")
                            c3.metric("Filas insertadas",
                                      f"{result.get('rows_inserted', 0):,}")
                            with st.expander("📋 Logs del parser"):
                                for log in result.get("logs", []):
                                    if log.startswith("✅"):
                                        st.success(log)
                                    elif log.startswith("⚠️"):
                                        st.warning(log)
                                    else:
                                        st.error(log)

                st.markdown("---")
                st.markdown("**Opción: enviar datos ya procesados en memoria**")
                if not variables_list:
                    st.info("Inserta variables en la BD para usar esta opción.")
                else:
                    var_opts2   = {f"{v['code']} — {v['name']} ({v['unit']})": v
                                   for v in variables_list}
                    sel_var_mem = st.selectbox("Variable",
                                               list(var_opts2.keys()),
                                               key="db_var_mem")
                    var_obj     = var_opts2[sel_var_mem]
                    var_code    = var_obj["code"]
                    sheet_key   = VAR_TO_KEY.get(var_code)
                    df_mem      = sheets.get(sheet_key) if sheet_key else None

                    if df_mem is not None and len(df_mem) > 0:
                        col_val = (sheet_key if sheet_key in df_mem.columns
                                   else "velocidad" if "velocidad" in df_mem.columns
                                   else None)
                        if col_val:
                            st.info(f"**{sheet_key}** en memoria: "
                                    f"{len(df_mem):,} registros")
                            st.dataframe(
                                df_mem[["_dt", col_val]].head(5).rename(
                                    columns={"_dt": "measured_at"}),
                                use_container_width=True,
                            )
                            if st.button("📤 Enviar datos procesados", key="btn_mem"):
                                df_exp = df_mem[["_dt", col_val]].dropna().copy()
                                df_exp.columns = ["measured_at", "value"]
                                df_exp["measured_at"] = df_exp["measured_at"].dt.strftime(
                                    "%Y-%m-%d %H:%M:%S")
                                csv_bytes = df_exp.to_csv(index=False).encode("utf-8")
                                fname = f"{sheet_key.lower()}_processed.csv"
                                with st.spinner("Enviando…"):
                                    result, err = api_upload_file(
                                        csv_bytes, fname,
                                        db_selected_station_id, var_obj["id"],
                                    )
                                if err:
                                    st.error(f"❌ {err}")
                                else:
                                    st.success(f"✅ {result.get('message','Listo')} — "
                                               f"{result.get('rows_inserted', result.get('rows', 0)):,} "
                                               "filas insertadas")
                        else:
                            st.warning(f"No se encontró columna de valor para {sheet_key}.")
                    else:
                        st.info(f"No hay datos en memoria para **{var_code}**. "
                                "Carga el archivo correspondiente en el sidebar.")

    st.markdown("---")

    # ── Sección 3: Historial de cargas ─────────────────────────────
    st.markdown("### 📜 3. Historial de archivos subidos")

    if st.button("🔄 Actualizar historial", key="btn_hist_refresh"):
        st.rerun()

    history, hist_err = api_get_upload_history()
    if hist_err:
        st.warning(f"No se pudo obtener el historial: {hist_err}")
    elif not history:
        st.info("No hay archivos subidos aún.")
    else:
        df_hist = pd.DataFrame(history)
        df_hist["estado"] = df_hist["status"].map({
            "processed":  "✅ Procesado",
            "processing": "⏳ Procesando",
            "error":      "❌ Error",
        }).fillna(df_hist["status"])
        show_cols = [c for c in
                     ["filename", "estado", "rows_imported", "rows_parsed",
                      "rows_inserted", "source", "uploaded_at"]
                     if c in df_hist.columns]
        rename_map = {
            "filename":      "Archivo",
            "estado":        "Estado",
            "rows_imported": "Filas importadas",
            "rows_parsed":   "Filas parseadas",
            "rows_inserted": "Filas insertadas",
            "source":        "Origen",
            "uploaded_at":   "Subido en",
        }
        st.dataframe(
            df_hist[show_cols].rename(columns=rename_map),
            use_container_width=True,
            hide_index=True,
        )

    st.markdown("---")

    # ── Sección 4: SQL helpers ──────────────────────────────────────
    st.markdown("### 🛠️ 4. Scripts SQL de ayuda")
    with st.expander("INSERT inicial de variables"):
        st.code("""
INSERT INTO variables (code, name, unit) VALUES
  ('TEMP',   'Temperatura',          '°C'),
  ('HR',     'Humedad Relativa',      '%'),
  ('RAD',    'Radiación Global',      'MJ/m²'),
  ('VIENTO', 'Velocidad del Viento',  'm/s')
ON CONFLICT (code) DO NOTHING;
""", language="sql")
    with st.expander("Consulta rápida de mediciones"):
        st.code("""
SELECT s.station_code, v.code AS variable,
       m.measured_at, m.value
FROM measurements m
JOIN stations  s ON s.id = m.station_id
JOIN variables v ON v.id = m.variable_id
ORDER BY m.measured_at DESC
LIMIT 100;
""", language="sql")

# ─────────────────────────────────────────────────────────────────────
# PÁGINA: GRÁFICOS
# ─────────────────────────────────────────────────────────────────────
if _cur == "graficos":
    st.markdown("## 📊 Gráficos")

    _G_VAR_MAP = {
        "Temperatura (TEMP)": ("TEMP",   "Temperatura", "°C",    "#e74c3c"),
        "Humedad (HR)":       ("HR",     "Humedad",     "%",     "#2980b9"),
        "Radiación (RAD)":    ("RAD",    "Radiacion",   "MJ/m²", "#f39c12"),
        "Viento (VIENTO)":    ("VIENTO", "Viento",      "m/s",   "#27ae60"),
    }
    _PAL = ["#e74c3c","#2980b9","#27ae60","#9b59b6","#f39c12","#1abc9c","#e67e22","#e91e63"]
    _MN  = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]

    # ── Session state ─────────────────────────────────────────────────
    if "graficos_source"   not in st.session_state: st.session_state.graficos_source   = None
    if "graficos_db_vars"  not in st.session_state: st.session_state.graficos_db_vars  = {}   # code → df
    if "graficos_db_meta"  not in st.session_state: st.session_state.graficos_db_meta  = {}   # code → {label,unit,color}
    if "graficos_show_all" not in st.session_state: st.session_state.graficos_show_all = False

    # ── Catálogo de gráficas ──────────────────────────────────────────
    # (id, nombre, icono, fuente, vars_necesarias)
    # vars_necesarias: lista de códigos BD que deben estar cargados, o [] para datos rápidos
    CHART_CATALOG = [
        ("serie_temp",      "Serie temporal – Temperatura",       "📉", "rapidos", []),
        ("serie_hum",       "Serie temporal – Humedad",           "📉", "rapidos", []),
        ("serie_rad",       "Serie temporal – Radiación",         "📉", "rapidos", []),
        ("serie_viento",    "Serie temporal – Viento",            "📉", "rapidos", []),
        ("completitud",     "Completitud anual por variable",     "📅", "rapidos", []),
        ("control_q",       "Control de calidad (outliers ±3σ)",  "📈", "rapidos", []),
        ("mapas_calor",     "Mapas de calor Hora × Mes",          "🗺️", "rapidos", []),
        ("fdp_temperatura", "FDP – Distribución Temperatura",     "🔔", "rapidos", []),
        ("fdp_humedad",     "FDP – Distribución Humedad",         "💧", "rapidos", []),
        ("combinado_t_hr",  "Combinado T × HR (densidad)",        "🔗", "rapidos", []),
        ("viento_rosa",     "Rosa de vientos",                    "💨", "rapidos", []),
        # ── BD: una variable ─────────────────────────────────────────
        ("db_serie",        "Serie temporal (BD)",                "📉", "db", ["any"]),
        ("db_mensual",      "Promedio mensual por año (BD)",      "📅", "db", ["any"]),
        ("db_diurno",       "Ciclo diurno promedio (BD)",         "🕓", "db", ["any"]),
        ("db_boxplot",      "Distribución mensual – Boxplot (BD)","📦", "db", ["any"]),
        ("db_mapa_calor",   "Mapa de calor Hora × Mes (BD)",      "🗺️", "db", ["any"]),
        ("db_anual",        "Promedio anual (BD)",                "📆", "db", ["any"]),
        # ── BD: multi-variable ───────────────────────────────────────
        ("db_combinado",    "Combinado T × HR (BD)",              "🔗", "db", ["TEMP","HR"]),
        ("db_diurno_multi", "Ciclo diurno multi-variable (BD)",   "🕓", "db", ["any2"]),
    ]

    # ── Selección de fuente ───────────────────────────────────────────
    st.markdown("### 🗄️ Fuente de datos")
    col_src1, col_src2 = st.columns(2)
    with col_src1:
        if st.button("🗄️ Cargar datos desde la Base de Datos",
                     use_container_width=True,
                     type="primary" if st.session_state.graficos_source == "db" else "secondary",
                     key="src_btn_db"):
            st.session_state.graficos_source   = "db"
            st.session_state.graficos_show_all = False
            st.rerun()
    with col_src2:
        if st.button("⚡ Cargar datos rápidos (archivos en memoria)",
                     use_container_width=True,
                     type="primary" if st.session_state.graficos_source == "rapidos" else "secondary",
                     key="src_btn_rapidos"):
            st.session_state.graficos_source   = "rapidos"
            st.session_state.graficos_show_all = False
            st.rerun()

    if st.session_state.graficos_source is None:
        st.info("👆 Elige una fuente de datos para continuar.")
        st.stop()

    source = st.session_state.graficos_source

    # ══════════════════════════════════════════════════════════════════
    # PANEL BD – consulta multi-variable
    # ══════════════════════════════════════════════════════════════════
    if source == "db":
        st.markdown("---")
        st.markdown("#### 🔌 Consulta a la Base de Datos")

        _g_stations, _ = api_get_stations()
        if not _g_stations:
            st.warning("⚠️ Sin conexión al backend o sin estaciones registradas.")
            st.stop()

        _g_st_opts = {f"{s['station_code']} — {s['name']}": s for s in _g_stations}
        _g_st_sel  = st.selectbox("🏔️ Estación", list(_g_st_opts.keys()), key="g_station_sel")
        _g_station = _g_st_opts[_g_st_sel]

        st.markdown("**Variables a cargar** — selecciona todas las que necesites:")
        _var_keys = list(_G_VAR_MAP.keys())
        _var_cols = st.columns(len(_var_keys))
        _vars_sel = []
        for _vc, _vk in zip(_var_cols, _var_keys):
            if _vc.checkbox(_vk, key=f"gvar_{_vk}"):
                _vars_sel.append(_vk)

        _g_d1 = st.date_input("Desde", value=None, key="g_date_from")
        _g_d2 = st.date_input("Hasta",  value=None, key="g_date_to")

        if st.button("📥 Consultar BD", type="primary", key="btn_g_query",
                     disabled=len(_vars_sel) == 0):
            _new_vars, _new_meta = {}, {}
            for _vk in _vars_sel:
                _code, _lbl, _unit, _clr = _G_VAR_MAP[_vk]
                with st.spinner(f"Consultando {_lbl}…"):
                    _raw, _err = api_get_measurements(
                        station_id    = str(_g_station["id"]),
                        variable_code = _code,
                        date_from     = str(_g_d1) if _g_d1 else None,
                        date_to       = str(_g_d2) if _g_d2 else None,
                    )
                if _err:
                    st.error(f"❌ {_lbl}: {_err}")
                    continue
                if not _raw:
                    st.warning(f"⚠️ {_lbl}: sin registros.")
                    continue
                _df_tmp = pd.DataFrame(_raw)
                _dtc, _vc2 = detect_db_columns(_df_tmp)
                if not _dtc or not _vc2:
                    st.warning(f"⚠️ {_lbl}: no se identificaron columnas. Cols: {list(_df_tmp.columns)}")
                    continue
                _df_tmp["_dt"]  = pd.to_datetime(_df_tmp[_dtc], errors="coerce")
                _df_tmp["_val"] = pd.to_numeric(_df_tmp[_vc2],  errors="coerce")
                _df_tmp = (_df_tmp.dropna(subset=["_dt","_val"])
                                  .sort_values("_dt").reset_index(drop=True))
                _df_tmp["_year"]  = _df_tmp["_dt"].dt.year
                _df_tmp["_month"] = _df_tmp["_dt"].dt.month
                _df_tmp["_hour"]  = _df_tmp["_dt"].dt.hour
                _new_vars[_code] = _df_tmp
                _new_meta[_code] = {"label": _lbl, "unit": _unit, "color": _clr}
                st.success(f"✅ {_lbl}: {len(_df_tmp):,} registros")
            st.session_state.graficos_db_vars = _new_vars
            st.session_state.graficos_db_meta = _new_meta
            st.rerun()

        # Resumen de variables cargadas
        _db_vars = st.session_state.graficos_db_vars
        _db_meta = st.session_state.graficos_db_meta
        if _db_vars:
            st.markdown("**Variables cargadas en sesión:**")
            _sum_cols = st.columns(len(_db_vars))
            for _sc, (_code, _df_v) in zip(_sum_cols, _db_vars.items()):
                _m = _db_meta[_code]
                _sc.metric(f"{_m['label']} ({_m['unit']})",
                           f"{len(_df_v):,} reg.",
                           delta=f"{_df_v['_dt'].min().strftime('%Y-%m-%d')} → {_df_v['_dt'].max().strftime('%Y-%m-%d')}")
            if st.button("🗑️ Limpiar datos cargados", key="btn_clear_db"):
                st.session_state.graficos_db_vars = {}
                st.session_state.graficos_db_meta = {}
                st.rerun()

    # ── Determinar gráficas disponibles ──────────────────────────────
    _db_vars = st.session_state.graficos_db_vars
    _db_meta = st.session_state.graficos_db_meta
    _loaded_codes = set(_db_vars.keys())

    def _chart_available(chart):
        cid, cname, cicon, csource, cvars = chart
        if csource == "rapidos": return source == "rapidos"
        if source != "db": return False
        if not _loaded_codes: return False
        if cvars == ["any"]:  return len(_loaded_codes) >= 1
        if cvars == ["any2"]: return len(_loaded_codes) >= 2
        return all(v in _loaded_codes for v in cvars)

    available_charts = [c for c in CHART_CATALOG if _chart_available(c)]

    if not available_charts:
        if source == "rapidos" and not sheets:
            st.info("⚡ No hay datos en memoria. Sube archivos en el sidebar.")
        elif source == "db" and not _db_vars:
            st.info("🗄️ Selecciona variables y consulta la BD para ver las gráficas disponibles.")
        else:
            st.info("ℹ️ No hay gráficas disponibles con las variables cargadas.")
        st.stop()

    # ── Cabecera + botón mostrar todos ───────────────────────────────
    st.markdown("---")
    col_title, col_all_btn = st.columns([7, 2])
    col_title.markdown("### 📋 Gráficas disponibles")
    show_all = st.session_state.graficos_show_all
    if col_all_btn.button(
        "✅ Ocultar todos" if show_all else "🖼️ Mostrar todos los gráficos",
        key="btn_show_all", use_container_width=True,
        type="primary" if show_all else "secondary",
    ):
        st.session_state.graficos_show_all = not show_all
        st.rerun()

    # ── Checkboxes ────────────────────────────────────────────────────
    if not show_all:
        st.caption("Selecciona las gráficas que quieres visualizar, o usa **Mostrar todos** 👆")
        selected_charts = []
        for i in range(0, len(available_charts), 3):
            row_charts = available_charts[i:i+3]
            row_cols   = st.columns(3)
            for col, chart in zip(row_cols, row_charts):
                cid, cname, cicon, *_ = chart
                if col.checkbox(f"{cicon} {cname}", key=f"chk_{cid}"):
                    selected_charts.append(chart)
    else:
        selected_charts = available_charts

    if not selected_charts:
        st.info("Selecciona al menos una gráfica de la lista de arriba.")
        st.stop()

    st.markdown("---")
    selected_ids = {c[0] for c in selected_charts}

    # ══════════════════════════════════════════════════════════════════
    # RENDER – DATOS RÁPIDOS
    # ══════════════════════════════════════════════════════════════════
    if source == "rapidos":

        for cid, dv, col_name, color, label, units in [
            ("serie_temp",   df_T,   "Temperatura", "#e74c3c", "Temperatura", "°C"),
            ("serie_hum",    df_HR,  "Humedad",     "#2980b9", "Humedad",     "%"),
            ("serie_rad",    df_RAD, "Radiacion",   "#f39c12", "Radiación",   "MJ/m²"),
        ]:
            if cid not in selected_ids: continue
            if dv is None or col_name not in dv.columns:
                st.info(f"Sin datos de {label}."); continue
            st.markdown(f"#### 📉 Serie temporal – {label}")
            s = dv.dropna(subset=[col_name]).sort_values("_dt")
            fig = go.Figure(go.Scatter(x=s["_dt"], y=s[col_name],
                mode="lines", line=dict(color=color, width=0.9), name=label))
            fig.update_layout(height=320, template="plotly_white",
                xaxis_title="Fecha", yaxis_title=f"{label} ({units})", hovermode="x unified")
            st.plotly_chart(fig, use_container_width=True)

        if "serie_viento" in selected_ids:
            if df_WIND is None or "velocidad" not in df_WIND.columns:
                st.info("Sin datos de Viento.")
            else:
                st.markdown("#### 📉 Serie temporal – Viento")
                s = df_WIND.dropna(subset=["velocidad"]).sort_values("_dt")
                fig = go.Figure(go.Scatter(x=s["_dt"], y=s["velocidad"],
                    mode="lines", line=dict(color="#27ae60", width=0.9), name="Viento"))
                fig.update_layout(height=320, template="plotly_white",
                    xaxis_title="Fecha", yaxis_title="Velocidad (m/s)")
                st.plotly_chart(fig, use_container_width=True)

        if "completitud" in selected_ids:
            st.markdown("#### 📅 Completitud anual por variable")
            for label, dv, col_name in [
                ("🌡️ Temperatura", df_T,  "Temperatura"),
                ("💧 Humedad",      df_HR, "Humedad"),
                ("☀️ Radiación",    df_RAD,"Radiacion"),
            ]:
                if dv is None or col_name not in dv.columns: continue
                dv2 = dv.copy()
                s = to_float_col(dv2[col_name])
                lo, hi = VALID_RANGES.get(col_name, (None, None))
                if lo is not None: s[s < lo] = np.nan
                if hi is not None: s[s > hi] = np.nan
                dv2["_valid"] = s.notna().astype(int)
                dv2["_year"]  = dv2["_dt"].dt.year
                by_year = dv2.groupby("_year").agg(valid=("_valid","sum"), total=("_valid","count"))
                by_year["pct"] = (by_year["valid"] / by_year["total"] * 100).clip(0, 100)
                colors_bar = ["#2ecc71" if p >= 95 else ("#f39c12" if p >= 85 else "#e74c3c")
                              for p in by_year["pct"]]
                fig = go.Figure(go.Bar(x=by_year.index.astype(str), y=by_year["pct"],
                    marker_color=colors_bar,
                    text=[f"{p:.0f}%" for p in by_year["pct"]], textposition="outside"))
                fig.update_layout(title=f"Completitud anual – {label}",
                    xaxis_title="Año", yaxis_title="Completitud (%)",
                    yaxis_range=[0,110], height=280, template="plotly_white")
                st.plotly_chart(fig, use_container_width=True)

        if "control_q" in selected_ids:
            st.markdown("#### 📈 Control de calidad (outliers ±3σ)")
            for label, dv, col_name, color, units in [
                ("Temperatura",      df_T,  "Temperatura","#e74c3c","°C"),
                ("Humedad Relativa", df_HR, "Humedad",    "#2980b9","%"),
                ("Radiación Global", df_RAD,"Radiacion",  "#f39c12","MJ/m²"),
            ]:
                if dv is None or col_name not in dv.columns: continue
                s  = dv.dropna(subset=[col_name]).sort_values("_dt")
                mu = s[col_name].mean(); sig = s[col_name].std()
                an = s[np.abs(s[col_name] - mu) > 3*sig]
                fig = go.Figure()
                fig.add_trace(go.Scatter(x=s["_dt"], y=s[col_name], mode="lines",
                    name=label, line=dict(color=color, width=0.8), opacity=0.75))
                fig.add_hline(y=mu+3*sig, line_dash="dot", line_color="orange",
                              annotation_text=f"+3σ={mu+3*sig:.1f}")
                fig.add_hline(y=mu-3*sig, line_dash="dot", line_color="orange",
                              annotation_text=f"−3σ={mu-3*sig:.1f}")
                if len(an):
                    fig.add_trace(go.Scatter(x=an["_dt"], y=an[col_name], mode="markers",
                        name=f"Anómalos ({len(an)})",
                        marker=dict(color="red", size=5, symbol="x")))
                fig.update_layout(title=f"{label} | Anómalos >3σ: {len(an)}",
                    xaxis_title="Fecha", yaxis_title=f"{label} ({units})",
                    height=380, template="plotly_white", legend=dict(orientation="h", y=1.08))
                st.plotly_chart(fig, use_container_width=True)

        if "mapas_calor" in selected_ids:
            st.markdown("#### 🗺️ Mapas de calor Hora × Mes")
            for label, dv, col_name, cscale in [
                ("Temperatura (°C)",    df_T,  "Temperatura","RdBu_r"),
                ("Humedad Relativa (%)",df_HR, "Humedad",    "Blues"),
                ("Radiación (MJ/m²)",  df_RAD,"Radiacion",  "YlOrRd"),
            ]:
                if dv is None or col_name not in dv.columns: continue
                tmp = dv.copy()
                tmp["_hora"] = tmp["_dt"].dt.hour
                tmp["_mes"]  = tmp["_dt"].dt.month
                pivot = tmp.groupby(["_hora","_mes"])[col_name].mean().unstack(fill_value=np.nan)
                fig = go.Figure(go.Heatmap(
                    z=pivot.values,
                    x=[MONTH_NAMES[m-1] for m in pivot.columns],
                    y=[f"{h:02d}:00" for h in pivot.index],
                    colorscale=cscale, colorbar=dict(title=label)))
                fig.update_layout(title=f"Promedio {label} por hora y mes",
                    xaxis_title="Mes", yaxis_title="Hora del día",
                    height=420, template="plotly_white")
                st.plotly_chart(fig, use_container_width=True)

        if "fdp_temperatura" in selected_ids:
            st.markdown("#### 🔔 FDP – Distribución Temperatura")
            if not has_T:
                st.info("Sin datos de Temperatura.")
            else:
                s_fdp = to_float_col(df_T["Temperatura"]).dropna()
                lo, hi = VALID_RANGES["Temperatura"]
                s_fdp = s_fdp[(s_fdp >= lo) & (s_fdp <= hi)]
                xc, counts, params, rmse, ok = fit_gaussians(tuple(s_fdp.values), n=n_gauss)
                x_plot = np.linspace(float(s_fdp.min()), float(s_fdp.max()), 400)
                fig = go.Figure()
                fig.add_trace(go.Bar(x=xc, y=counts, name="Histograma",
                    marker_color="rgba(52,152,219,0.4)", width=(xc[1]-xc[0])))
                total_fit = np.zeros_like(x_plot, dtype=float)
                for i in range(n_gauss):
                    mu_i, sig_i, w_i = params[3*i], abs(params[3*i+1]), abs(params[3*i+2])
                    yi = gaussian_pdf(x_plot, mu_i, sig_i, w_i)
                    total_fit += yi
                    fig.add_trace(go.Scatter(x=x_plot, y=yi, mode="lines",
                        name=f"G{i+1} μ={mu_i:.1f}",
                        line=dict(color=COLORS_G[i%len(COLORS_G)], width=2, dash="dash")))
                fig.add_trace(go.Scatter(x=x_plot, y=total_fit, mode="lines",
                    name="Ajuste total", line=dict(color="black", width=2.5)))
                fig.update_layout(title="FDP Temperatura", xaxis_title="Temperatura (°C)",
                    yaxis_title="Densidad", height=440, template="plotly_white",
                    legend=dict(orientation="h", y=1.08))
                st.plotly_chart(fig, use_container_width=True)

        if "fdp_humedad" in selected_ids:
            st.markdown("#### 💧 FDP – Distribución Humedad")
            if not has_HR:
                st.info("Sin datos de Humedad.")
            else:
                s_fdp = to_float_col(df_HR["Humedad"]).dropna()
                s_fdp = s_fdp[(s_fdp >= 0) & (s_fdp <= 100)]
                xc, counts, params, rmse, ok = fit_betas(tuple(s_fdp.values), n=n_beta)
                x_plot = np.linspace(0, 100, 400)
                fig = go.Figure()
                fig.add_trace(go.Bar(x=xc, y=counts, name="Histograma",
                    marker_color="rgba(41,128,185,0.4)", width=(xc[1]-xc[0])))
                total_fit = np.zeros_like(x_plot, dtype=float)
                for i in range(n_beta):
                    a_i, b_i, w_i = abs(params[3*i]), abs(params[3*i+1]), abs(params[3*i+2])
                    yi = beta_pdf(x_plot, a_i, b_i, w_i)
                    total_fit += yi
                    fig.add_trace(go.Scatter(x=x_plot, y=yi, mode="lines",
                        name=f"β{i+1}",
                        line=dict(color=COLORS_B[i%len(COLORS_B)], width=2, dash="dash")))
                fig.add_trace(go.Scatter(x=x_plot, y=total_fit, mode="lines",
                    name="Ajuste total", line=dict(color="black", width=2.5)))
                fig.update_layout(title="FDP Humedad Relativa", xaxis_title="Humedad (%)",
                    yaxis_title="Densidad", height=440, template="plotly_white",
                    legend=dict(orientation="h", y=1.08))
                st.plotly_chart(fig, use_container_width=True)

        if "combinado_t_hr" in selected_ids:
            st.markdown("#### 🔗 Combinado T × HR (densidad)")
            if not has_T or not has_HR:
                st.info("Se requieren datos de Temperatura y Humedad.")
            else:
                merged_g = pd.merge(
                    df_T[["_dt","Temperatura"]].dropna(),
                    df_HR[["_dt","Humedad"]].dropna(),
                    on="_dt", how="inner")
                if len(merged_g) > 0:
                    fig = go.Figure()
                    fig.add_trace(go.Histogram2dContour(
                        x=merged_g["Temperatura"], y=merged_g["Humedad"],
                        colorscale="Blues", showscale=True,
                        contours=dict(showlabels=True, coloring="heatmap"), name="Densidad"))
                    samp_g = merged_g.sample(min(3000, len(merged_g)), random_state=42)
                    fig.add_trace(go.Scatter(
                        x=samp_g["Temperatura"], y=samp_g["Humedad"], mode="markers",
                        marker=dict(color="rgba(50,50,150,0.07)", size=3), name="Datos"))
                    fig.update_layout(title="Densidad T × HR",
                        xaxis_title="Temperatura (°C)", yaxis_title="Humedad Relativa (%)",
                        height=500, template="plotly_white",
                        legend=dict(orientation="h", y=1.06))
                    st.plotly_chart(fig, use_container_width=True)

        if "viento_rosa" in selected_ids:
            st.markdown("#### 💨 Rosa de vientos")
            if not has_WIND:
                st.info("Sin datos de Viento.")
            elif "dir_grados" not in df_WIND.columns or "velocidad" not in df_WIND.columns:
                st.info("Los datos de viento no contienen dirección en grados.")
            else:
                fig = go.Figure(go.Scatterpolar(
                    r=df_WIND["velocidad"].fillna(0),
                    theta=df_WIND["dir_grados"].fillna(0),
                    mode="markers",
                    marker=dict(color=df_WIND["velocidad"], colorscale="Viridis",
                                size=3, opacity=0.5, colorbar=dict(title="Vel (m/s)"))))
                fig.update_layout(title="Rosa de vientos",
                    polar=dict(angularaxis=dict(direction="clockwise", rotation=90)),
                    height=480)
                st.plotly_chart(fig, use_container_width=True)

    # ══════════════════════════════════════════════════════════════════
    # RENDER – BASE DE DATOS (multi-variable)
    # ══════════════════════════════════════════════════════════════════
    elif source == "db":
        if not _db_vars:
            st.info("🗄️ Configura y ejecuta la consulta a la BD."); st.stop()

        # ── Helper: gráficas por variable individual ──────────────────
        for _code, _df_v in _db_vars.items():
            _m   = _db_meta[_code]
            _lbl = _m["label"]; _unit = _m["unit"]; _clr = _m["color"]
            _r   = int(_clr[1:3],16); _g_ = int(_clr[3:5],16); _b_ = int(_clr[5:7],16)

            if "db_serie" in selected_ids:
                st.markdown(f"#### 📉 Serie temporal – {_lbl} (BD)")
                fig = go.Figure(go.Scatter(x=_df_v["_dt"], y=_df_v["_val"],
                    mode="lines", name=_lbl, line=dict(color=_clr, width=1.2), opacity=0.85))
                fig.update_layout(height=320, template="plotly_white",
                    xaxis_title="Fecha", yaxis_title=f"{_lbl} ({_unit})", hovermode="x unified")
                st.plotly_chart(fig, use_container_width=True)

            if "db_mensual" in selected_ids:
                st.markdown(f"#### 📅 Promedio mensual por año – {_lbl} (BD)")
                _mo_yr = _df_v.groupby(["_year","_month"])["_val"].mean().reset_index()
                fig = go.Figure()
                for _i, _yr in enumerate(sorted(_mo_yr["_year"].unique())):
                    _s = _mo_yr[_mo_yr["_year"]==_yr]
                    fig.add_trace(go.Scatter(x=_s["_month"], y=_s["_val"],
                        mode="lines+markers", name=str(_yr),
                        line=dict(color=_PAL[_i%len(_PAL)], width=2)))
                fig.update_layout(height=320, template="plotly_white",
                    xaxis=dict(tickmode="array", tickvals=list(range(1,13)), ticktext=_MN),
                    yaxis_title=f"{_lbl} ({_unit})", hovermode="x unified",
                    legend=dict(orientation="h", y=1.08))
                st.plotly_chart(fig, use_container_width=True)

            if "db_diurno" in selected_ids:
                st.markdown(f"#### 🕓 Ciclo diurno – {_lbl} (BD)")
                _hrly = _df_v.groupby("_hour")["_val"].agg(["mean","std"]).reset_index()
                fig = go.Figure()
                fig.add_trace(go.Scatter(x=_hrly["_hour"],
                    y=_hrly["mean"]+_hrly["std"], mode="lines",
                    line=dict(width=0), showlegend=False))
                fig.add_trace(go.Scatter(x=_hrly["_hour"],
                    y=_hrly["mean"]-_hrly["std"], mode="lines",
                    line=dict(width=0), fill="tonexty",
                    fillcolor=f"rgba({_r},{_g_},{_b_},0.15)", name="±1σ"))
                fig.add_trace(go.Scatter(x=_hrly["_hour"], y=_hrly["mean"],
                    mode="lines+markers", name="Promedio",
                    line=dict(color=_clr, width=2.5)))
                fig.update_layout(height=300, template="plotly_white",
                    xaxis=dict(title="Hora", tickmode="linear", tick0=0, dtick=2),
                    yaxis_title=f"{_lbl} ({_unit})")
                st.plotly_chart(fig, use_container_width=True)

            if "db_boxplot" in selected_ids:
                st.markdown(f"#### 📦 Distribución mensual – {_lbl} (BD)")
                fig = go.Figure()
                for _mo in range(1,13):
                    _sub = _df_v[_df_v["_month"]==_mo]["_val"].dropna()
                    if len(_sub) == 0: continue
                    fig.add_trace(go.Box(y=_sub, name=_MN[_mo-1],
                        marker_color=_PAL[(_mo-1)%len(_PAL)],
                        boxmean="sd", showlegend=False))
                fig.update_layout(height=320, template="plotly_white",
                    yaxis_title=f"{_lbl} ({_unit})")
                st.plotly_chart(fig, use_container_width=True)

            if "db_mapa_calor" in selected_ids:
                st.markdown(f"#### 🗺️ Mapa de calor Hora × Mes – {_lbl} (BD)")
                _heat = _df_v.groupby(["_month","_hour"])["_val"].mean().unstack(level=0)
                _heat.columns = [_MN[c-1] for c in _heat.columns]
                fig = go.Figure(go.Heatmap(
                    z=_heat.values, x=_heat.columns.tolist(),
                    y=[f"{h:02d}:00" for h in _heat.index],
                    colorscale="RdYlGn" if _code=="TEMP" else "Blues",
                    colorbar=dict(title=_unit)))
                fig.update_layout(height=400, template="plotly_white",
                    xaxis_title="Mes", yaxis_title="Hora")
                st.plotly_chart(fig, use_container_width=True)

            if "db_anual" in selected_ids:
                st.markdown(f"#### 📆 Promedio anual – {_lbl} (BD)")
                _ann = _df_v.groupby("_year")["_val"].mean().reset_index()
                fig = go.Figure()
                fig.add_trace(go.Bar(x=_ann["_year"], y=_ann["_val"],
                    marker_color=_clr, opacity=0.85, name="Promedio anual"))
                fig.add_trace(go.Scatter(x=_ann["_year"], y=_ann["_val"],
                    mode="lines+markers", name="Tendencia",
                    line=dict(color="#2c3e50", width=2, dash="dash")))
                fig.update_layout(height=300, template="plotly_white",
                    xaxis_title="Año", yaxis_title=f"{_lbl} ({_unit})",
                    hovermode="x unified")
                st.plotly_chart(fig, use_container_width=True)

        # ── Gráficas multi-variable ───────────────────────────────────

        # Ciclo diurno con todas las variables en un solo gráfico
        if "db_diurno_multi" in selected_ids and len(_db_vars) >= 2:
            st.markdown("#### 🕓 Ciclo diurno multi-variable (BD)")
            from plotly.subplots import make_subplots as _mks
            _codes_list = list(_db_vars.keys())
            _fig_multi = _mks(specs=[[{"secondary_y": True}]])
            _use_sec = False
            for _i, _code in enumerate(_codes_list):
                _df_v = _db_vars[_code]
                _m    = _db_meta[_code]
                _hrly = _df_v.groupby("_hour")["_val"].mean().reset_index()
                _sec  = _i > 0  # primera en eje primario, resto en secundario
                _fig_multi.add_trace(go.Scatter(
                    x=_hrly["_hour"], y=_hrly["_val"],
                    mode="lines+markers",
                    name=f"{_m['label']} ({_m['unit']})",
                    line=dict(color=_m["color"], width=2.5)),
                    secondary_y=_sec)
                if _sec: _use_sec = True
            _fig_multi.update_xaxes(title_text="Hora",
                tickvals=list(range(0,24,2)),
                ticktext=[f"{h:02d}:00" for h in range(0,24,2)])
            _codes_list_meta = [_db_meta[c] for c in _codes_list]
            _fig_multi.update_yaxes(
                title_text=f"{_codes_list_meta[0]['label']} ({_codes_list_meta[0]['unit']})",
                secondary_y=False)
            if _use_sec:
                _fig_multi.update_yaxes(
                    title_text=" / ".join(f"{_db_meta[c]['label']} ({_db_meta[c]['unit']})"
                                          for c in _codes_list[1:]),
                    secondary_y=True)
            _fig_multi.update_layout(height=360, template="plotly_white",
                legend=dict(orientation="h", y=1.08))
            st.plotly_chart(_fig_multi, use_container_width=True)

        # Combinado T × HR desde BD
        if "db_combinado" in selected_ids:
            st.markdown("#### 🔗 Combinado T × HR (BD)")
            _df_T_bd = _db_vars.get("TEMP")
            _df_H_bd = _db_vars.get("HR")
            if _df_T_bd is not None and _df_H_bd is not None:
                _merged_bd = pd.merge(
                    _df_T_bd[["_dt","_val"]].rename(columns={"_val":"Temperatura"}),
                    _df_H_bd[["_dt","_val"]].rename(columns={"_val":"Humedad"}),
                    on="_dt", how="inner")
                if len(_merged_bd) > 0:
                    _m1, _m2, _m3 = st.columns(3)
                    _m1.metric("Pares válidos T–HR", f"{len(_merged_bd):,}")
                    _m2.metric("Correlación Pearson",
                               f"{_merged_bd['Temperatura'].corr(_merged_bd['Humedad']):.3f}")
                    _wet = _merged_bd[(_merged_bd["Temperatura"] > 10) & (_merged_bd["Humedad"] > 79)]
                    _m3.metric("Tiempo de humectación (T>10°C, HR>79%)",
                               f"{len(_wet)/len(_merged_bd)*100:.1f}%")

                    fig = go.Figure()
                    fig.add_trace(go.Histogram2dContour(
                        x=_merged_bd["Temperatura"], y=_merged_bd["Humedad"],
                        colorscale="Blues", showscale=True,
                        contours=dict(showlabels=True, coloring="heatmap"), name="Densidad"))
                    _samp_bd = _merged_bd.sample(min(3000, len(_merged_bd)), random_state=42)
                    fig.add_trace(go.Scatter(
                        x=_samp_bd["Temperatura"], y=_samp_bd["Humedad"], mode="markers",
                        marker=dict(color="rgba(50,50,150,0.07)", size=3), name="Datos"))
                    _tmax = _merged_bd["Temperatura"].max()
                    fig.add_trace(go.Scatter(
                        x=[10,10,_tmax,_tmax,10], y=[79,100,100,79,79],
                        mode="lines", fill="toself",
                        fillcolor="rgba(231,76,60,0.08)",
                        line=dict(color="red", dash="dash", width=1.5),
                        name=f"Zona humectación"))
                    fig.update_layout(title="Densidad T × HR (BD)",
                        xaxis_title="Temperatura (°C)", yaxis_title="Humedad Relativa (%)",
                        height=520, template="plotly_white",
                        legend=dict(orientation="h", y=1.06))
                    st.plotly_chart(fig, use_container_width=True)

                    # Variabilidad horaria T y HR
                    st.markdown("##### Variabilidad horaria T y HR")
                    _merged_bd["_hora"] = _merged_bd["_dt"].dt.hour
                    _h_t  = _merged_bd.groupby("_hora")["Temperatura"].mean()
                    _h_hr = _merged_bd.groupby("_hora")["Humedad"].mean()
                    from plotly.subplots import make_subplots as _mks2
                    _fig_h = _mks2(specs=[[{"secondary_y": True}]])
                    _fig_h.add_trace(go.Scatter(x=_h_t.index, y=_h_t.values,
                        mode="lines+markers", name="T media (°C)",
                        line=dict(color="#e74c3c", width=2.5)), secondary_y=False)
                    _fig_h.add_trace(go.Scatter(x=_h_hr.index, y=_h_hr.values,
                        mode="lines+markers", name="HR media (%)",
                        line=dict(color="#2980b9", width=2.5)), secondary_y=True)
                    _fig_h.update_xaxes(title_text="Hora del día",
                        tickvals=list(range(0,24,2)),
                        ticktext=[f"{h:02d}:00" for h in range(0,24,2)])
                    _fig_h.update_yaxes(title_text="Temperatura (°C)", secondary_y=False)
                    _fig_h.update_yaxes(title_text="Humedad Relativa (%)", secondary_y=True)
                    _fig_h.update_layout(height=360, template="plotly_white",
                        legend=dict(orientation="h", y=1.08))
                    st.plotly_chart(_fig_h, use_container_width=True)

    st.markdown("---")
    if st.button("🏠 Volver al inicio", key="graficos_home"):
        go_to("home"); st.rerun()