"""
file_parser.py
==============
Convierte archivos CSV y Excel meteorológicos a un DataFrame normalizado con columnas:
    measured_at  (datetime)
    value        (float)

Soporta:
  - Formato A: encabezado en fila 0,  columnas H1…H24
  - Formato B: encabezado en fila 1,  columnas 01:00…24:00
  - Formato L: formato largo (Fecha | Hora | ... | Valor)
  - Archivos Excel con múltiples hojas
"""

import io
import pandas as pd
import numpy as np


# ── helpers ──────────────────────────────────────────────────────────

HOUR_COLS_B     = [f"{i:02d}:00" for i in range(1, 25)]
HOUR_COLS_B_ALT = [f"{i}:00" for i in range(1, 25)] + ["24:00:00"]


def _norm(txt: str) -> str:
    return (str(txt).lower()
            .replace("á","a").replace("é","e").replace("í","i")
            .replace("ó","o").replace("ú","u").replace("ñ","n")
            .replace("°","").replace("º","").strip())


def _to_float(series: pd.Series) -> pd.Series:
    return pd.to_numeric(
        series.astype(str).str.replace(",", ".", regex=False).str.strip(),
        errors="coerce"
    )


def _detect_hour_cols(df: pd.DataFrame):
    """Devuelve (lista_columnas, formato) donde formato ∈ {'A','B','UNKNOWN'}"""
    cols = {c: str(c).strip() for c in df.columns}

    found_a = [c for c, v in cols.items()
               if v.upper() in [f"H{i}" for i in range(1, 25)]]
    if len(found_a) >= 12:
        found_a.sort(key=lambda c: int(str(c).upper().replace("H", "")))
        return found_a, "A"

    all_b = set(HOUR_COLS_B + HOUR_COLS_B_ALT)
    found_b = [c for c, v in cols.items() if v in all_b]
    if len(found_b) >= 12:
        def _sk(c):
            v = str(c).replace(":00:00","").replace(":00","")
            try: return int(v)
            except: return 99
        found_b.sort(key=_sk)
        return found_b, "B"

    return [], "UNKNOWN"


def _rename_date_cols(df: pd.DataFrame) -> pd.DataFrame:
    rename = {}
    for c in df.columns:
        cl = _norm(c).replace(" ", "")
        if   cl in ["ano","anio","year","a","año"]: rename[c] = "_year"
        elif cl in ["mes","month","m"]:             rename[c] = "_month"
        elif cl in ["dia","day","d","día"]:         rename[c] = "_day"
    return df.rename(columns=rename)


def _wide_to_long(df: pd.DataFrame, value_col: str) -> pd.DataFrame | None:
    """Pivota un DataFrame ancho (año|mes|día|H1…H24) a largo (measured_at, value)."""
    hour_cols, fmt = _detect_hour_cols(df)
    if not hour_cols:
        return None

    df = _rename_date_cols(df)
    if any(c not in df.columns for c in ["_year", "_month", "_day"]):
        return None

    for fc in ["_year", "_month", "_day"]:
        df[fc] = pd.to_numeric(df[fc], errors="coerce")
    df = df.dropna(subset=["_year","_month","_day"]).copy()
    df[["_year","_month","_day"]] = df[["_year","_month","_day"]].astype(int)

    melted = df.melt(
        id_vars=["_year","_month","_day"],
        value_vars=hour_cols,
        var_name="_hora_str",
        value_name=value_col
    )
    melted[value_col] = _to_float(melted[value_col])

    def _hora_num(s):
        s = str(s).strip().upper()
        if fmt == "A":
            return int(s.replace("H", ""))
        return int(s.replace(":00:00","").replace(":00",""))

    hora_int  = melted["_hora_str"].apply(_hora_num)
    extra_day = (hora_int == 24).astype(int)
    hora_int  = hora_int % 24

    base = pd.to_datetime(
        dict(year=melted["_year"], month=melted["_month"], day=melted["_day"]),
        errors="coerce"
    )
    melted["measured_at"] = (base
                             + pd.to_timedelta(hora_int, "h")
                             + pd.to_timedelta(extra_day, "d"))

    return (melted[["measured_at", value_col]]
            .rename(columns={value_col: "value"})
            .dropna(subset=["measured_at"])
            .assign(value=lambda x: pd.to_numeric(x["value"], errors="coerce"))
            .dropna(subset=["value"])
            .sort_values("measured_at")
            .reset_index(drop=True))


def _detect_variable(text: str, filename: str = "") -> str:
    t = _norm(text + " " + filename)
    if "temperatura" in t or "temp" in t:            return "Temperatura"
    if "humedad" in t or "hum" in t:                 return "Humedad"
    if "radiaci" in t or "mj" in t or "rad" in t:   return "Radiacion"
    if "viento" in t or "velocidad" in t or "vel" in t: return "Viento"
    return "UNKNOWN"


def _parse_long_format(
    df: pd.DataFrame,
    filename: str,
    logs: list[str],
) -> tuple[pd.DataFrame, str, list[str]]:
    """
    Maneja CSVs con formato largo: columna Fecha + columna Hora + columna de valor.
    Ej: Fecha | Hora | Dirección | Velocidad (m/s) | ...
    """
    col_map = {_norm(str(c)): c for c in df.columns}

    # Detectar columna de fecha y hora
    fecha_col = next((col_map[k] for k in col_map
                      if k in ["fecha", "date", "f"]), None)
    hora_col  = next((col_map[k] for k in col_map
                      if k in ["hora", "hour", "time", "tiempo"]), None)

    if not fecha_col or not hora_col:
        logs.append(f"⚠️ {filename}: no se encontraron columnas Fecha/Hora")
        return pd.DataFrame(), "UNKNOWN", logs

    # Detectar variable y columna de valor
    vtype = _detect_variable("", filename)
    value_col = None

    PRIORITY = [
        (["velocidad", "vel", "speed"],         "Viento"),
        (["temperatura", "temp"],               "Temperatura"),
        (["humedad", "hum", "humidity"],        "Humedad"),
        (["radiaci", "rad", "mj", "radiation"], "Radiacion"),
    ]

    for keywords, detected_vtype in PRIORITY:
        for c in df.columns:
            cn = _norm(str(c))
            if any(kw in cn for kw in keywords):
                value_col = c
                if vtype == "UNKNOWN":
                    vtype = detected_vtype
                break
        if value_col:
            break

    if not value_col:
        logs.append(f"⚠️ {filename}: no se detectó columna de valor")
        return pd.DataFrame(), vtype, logs

    # Construir measured_at combinando Fecha + Hora
    try:
        fecha_str = df[fecha_col].astype(str).str.strip()
        hora_str  = df[hora_col].astype(str).str.strip()
        measured_at = pd.to_datetime(
            fecha_str + " " + hora_str,
            dayfirst=True, errors="coerce"
        )
    except Exception as e:
        logs.append(f"⚠️ {filename}: error parseando fechas: {e}")
        return pd.DataFrame(), vtype, logs

    result = pd.DataFrame({
        "measured_at": measured_at,
        "value": _to_float(df[value_col]),
    }).dropna().sort_values("measured_at").reset_index(drop=True)

    if result.empty:
        logs.append(f"⚠️ {filename}: formato largo detectado pero sin datos válidos")
        return pd.DataFrame(), vtype, logs

    logs.append(f"✅ {filename} → {vtype} ({len(result):,} registros, formato largo)")
    return result, vtype, logs


def _try_read_csv(file_bytes: bytes, enc: str, sep: str, header: int) -> pd.DataFrame:
    try:
        return pd.read_csv(
            io.BytesIO(file_bytes), sep=sep,
            encoding=enc, header=header, decimal=","
        )
    except Exception:
        return pd.DataFrame()


# ── API pública ───────────────────────────────────────────────────────

def parse_file(
    file_bytes: bytes,
    filename:   str,
) -> tuple[pd.DataFrame, str, list[str]]:
    """
    Parsea un archivo CSV o Excel meteorológico.

    Retorna:
        df      DataFrame con columnas [measured_at, value]
        vtype   Tipo de variable detectado (Temperatura, Humedad, Radiacion, Viento)
        logs    Lista de mensajes de diagnóstico
    """
    logs: list[str] = []
    ext = filename.lower()

    if ext.endswith(".csv"):
        return _parse_csv(file_bytes, filename, logs)
    elif ext.endswith((".xlsx", ".xls")):
        return _parse_excel(file_bytes, filename, logs)
    else:
        logs.append(f"❌ Formato no soportado: {filename}")
        return pd.DataFrame(), "UNKNOWN", logs


def _parse_csv(
    file_bytes: bytes,
    filename:   str,
    logs:       list[str],
) -> tuple[pd.DataFrame, str, list[str]]:

    for enc in ["latin1", "utf-8", "cp1252"]:
        try:
            # Leer fila 0 para detectar tipo de variable
            row0 = pd.read_csv(
                io.BytesIO(file_bytes), sep=";", encoding=enc,
                header=None, nrows=1
            )
            row0_text = " ".join(str(v) for v in row0.iloc[0].values if pd.notna(v))
            vtype = _detect_variable(row0_text, filename)

            # ── Intentar formatos anchos (A y B) ─────────────────
            df_b = _try_read_csv(file_bytes, enc, ";", 1)
            _, fmt_b = _detect_hour_cols(df_b) if not df_b.empty else ([], "UNKNOWN")

            df_a = _try_read_csv(file_bytes, enc, ";", 0)
            _, fmt_a = _detect_hour_cols(df_a) if not df_a.empty else ([], "UNKNOWN")

            if fmt_b in ("A", "B"):
                df_use = df_b
            elif fmt_a in ("A", "B"):
                df_use = df_a
                if vtype == "UNKNOWN":
                    vtype = _detect_variable(
                        " ".join(str(c) for c in df_a.columns), filename)
            else:
                # ── Fallback: intentar formato largo ─────────────
                # Probar separador ";" primero, luego ","
                for sep in [";", ","]:
                    df_long = _try_read_csv(file_bytes, enc, sep, 0)
                    if df_long.empty or len(df_long.columns) <= 1:
                        continue
                    result, vtype, long_logs = _parse_long_format(df_long, filename, [])
                    logs.extend(long_logs)
                    if not result.empty:
                        result["measured_at"] = result["measured_at"].dt.round("h")
                        return result, vtype, logs

                logs.append(f"⚠️ {filename}: no se detectaron columnas horarias")
                return pd.DataFrame(), "UNKNOWN", logs

            parsed = _wide_to_long(df_use, vtype)
            if parsed is None or len(parsed) == 0:
                logs.append(f"⚠️ {filename}: parseado vacío")
                return pd.DataFrame(), vtype, logs

            parsed["measured_at"] = parsed["measured_at"].dt.round("h")
            logs.append(f"✅ {filename} → {vtype} ({len(parsed):,} registros)")
            return parsed, vtype, logs

        except Exception as e:
            logs.append(f"⚠️ {filename} enc={enc}: {e}")
            continue

    return pd.DataFrame(), "UNKNOWN", logs


def _parse_excel(
    file_bytes: bytes,
    filename:   str,
    logs:       list[str],
) -> tuple[pd.DataFrame, str, list[str]]:

    xl = pd.ExcelFile(io.BytesIO(file_bytes))
    all_frames = []
    vtype_detected = "UNKNOWN"

    for sname in xl.sheet_names:
        try:
            raw = xl.parse(sname, header=None)
            if raw.empty or len(raw) < 3:
                continue

            row0_text = " ".join(str(v) for v in raw.iloc[0].values if pd.notna(v))
            vtype = _detect_variable(row0_text, sname + " " + filename)

            df_b = xl.parse(sname, header=1).dropna(how="all").reset_index(drop=True)
            _, fmt_b = _detect_hour_cols(df_b)
            df_a = xl.parse(sname, header=0).dropna(how="all").reset_index(drop=True)
            _, fmt_a = _detect_hour_cols(df_a)

            if fmt_b in ("A", "B"):
                df_use = df_b
            elif fmt_a in ("A", "B"):
                df_use = df_a
                if vtype == "UNKNOWN":
                    vtype = _detect_variable(
                        " ".join(str(c) for c in df_a.columns), sname)
            else:
                # Fallback: formato largo en Excel
                result, vtype, long_logs = _parse_long_format(df_a, sname, [])
                logs.extend(long_logs)
                if not result.empty:
                    result["measured_at"] = result["measured_at"].dt.round("h")
                    all_frames.append(result)
                    vtype_detected = vtype
                else:
                    logs.append(f"⚠️ Hoja '{sname}': no se detectaron columnas horarias")
                continue

            parsed = _wide_to_long(df_use, vtype)
            if parsed is None or len(parsed) == 0:
                logs.append(f"⚠️ Hoja '{sname}': parseado vacío")
                continue

            parsed["measured_at"] = parsed["measured_at"].dt.round("h")
            all_frames.append(parsed)
            vtype_detected = vtype
            logs.append(f"✅ Hoja '{sname}' → {vtype} ({len(parsed):,} registros)")

        except Exception as e:
            logs.append(f"❌ Hoja '{sname}': {e}")

    if not all_frames:
        return pd.DataFrame(), vtype_detected, logs

    combined = (pd.concat(all_frames, ignore_index=True)
                .drop_duplicates(subset=["measured_at"])
                .sort_values("measured_at")
                .reset_index(drop=True))
    return combined, vtype_detected, logs