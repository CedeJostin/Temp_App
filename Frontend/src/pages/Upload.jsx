import { useState, useRef } from "react"
import { useFetch } from "../hooks/useFetch"
import { stationsApi, uploadsApi } from "../services/api"

const VARIABLES = [
  { key: "temperatura", code: "TEMP",   label: "Temperatura",     icon: "🌡️", color: "#ef4444", border: "#ef444440" },
  { key: "humedad",     code: "HR",     label: "Humedad Relativa", icon: "💧", color: "#3b82f6", border: "#3b82f640" },
  { key: "viento",      code: "VIENTO", label: "Viento",           icon: "💨", color: "#22c55e", border: "#22c55e40" },
]

const parsearCSV = (texto) => {
  const lineas = texto.trim().split("\n").filter(Boolean)
  const sep = lineas[0].includes(";") ? ";" : ","

  // ── Formato C: metadata en filas 0-3 (Estacion:;NOMBRE…) ──────────
  const primeraCelda = lineas[0].split(sep)[0].trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  if (primeraCelda === "estacion:" || primeraCelda === "estacion") {
    // Variable detectada en fila 2
    const celdaVar = lineas[2]?.split(sep) ?? []
    const textoVar = celdaVar.join(" ").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    const variableDetectada =
      textoVar.includes("temperatura") ? "Temperatura" :
      textoVar.includes("humedad")     ? "Humedad"     :
      textoVar.includes("radiaci")     ? "Radiacion"   :
      textoVar.includes("viento")      ? "Viento"      : "Desconocida"

    // Encabezados en fila 3, datos desde fila 4
    const columnas = lineas[3].split(sep)
      .filter(c => !c.trim().startsWith("Unnamed") && c.trim() !== "")
      .slice(0, 7)
      .map(c => c.trim())

    const filas = lineas.slice(4, 7).map(l =>
      l.split(sep)
       .filter((_, i) => i !== 1)   // quitar columna vacía (índice 1)
       .slice(0, 7)
       .map(c => c.trim())
    )
    const totalFilas = lineas.length - 4
    const totalFaltantes = lineas.slice(4).reduce((acc, l) =>
      acc + l.split(sep).filter(c => c.trim() === "-" || c.trim() === "-9").length, 0
    )
    return { columnas, filas, totalFilas, totalFaltantes, variableDetectada, formato: "C" }
  }

  // ── Formatos A / B: encabezado en fila 0 o 1 ──────────────────────
  const columnas = lineas[0].split(sep).map(c => c.trim().replace(/^\uFEFF/, ""))
  const colsNorm = columnas.map(c =>
    c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  )
  const esHorario = colsNorm.includes("ano") && colsNorm.includes("h1")
  const esViento  = colsNorm.includes("fecha") && colsNorm.includes("velocidad")
  if (!esHorario && !esViento) throw new Error("formato_desconocido")

  const filas = lineas.slice(1, 4).map(l => l.split(sep).slice(0, 6).map(c => c.trim()))
  const totalFilas = lineas.length - 1
  const totalFaltantes = lineas.slice(1).reduce((acc, l) =>
    acc + l.split(sep).filter(c => c.trim() === "-" || c.trim() === "-9").length, 0
  )
  return { columnas: columnas.slice(0, 6), filas, totalFilas, totalFaltantes, formato: "AB" }
}

function DropZone({ variable, archivo, preview, error, onFile, onQuitar }) {
  const ref = useRef()
  const [drag, setDrag] = useState(false)

  const handleDrop = (e) => {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f) onFile(f)
  }

  return (
    <div style={{
      background: "var(--surface)", border: `1px solid ${archivo ? "#22c55e40" : "var(--border)"}`,
      borderRadius: 12, padding: "16px 20px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>{variable.icon}</span>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{variable.label}</span>
        </div>
        {archivo && (
          <span style={{ background: "#22c55e20", color: "#22c55e", borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600 }}>
            Listo
          </span>
        )}
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={handleDrop}
        onClick={() => !archivo && ref.current.click()}
        style={{
          border: `2px dashed ${drag ? variable.color : archivo ? "#22c55e" : "var(--border)"}`,
          borderRadius: 10, padding: "14px 16px", cursor: archivo ? "default" : "pointer",
          background: drag ? `${variable.color}10` : archivo ? "#22c55e10" : "transparent",
          transition: "all 0.15s",
        }}
      >
        <input ref={ref} type="file" accept=".csv,.xlsx" className="hidden" onChange={e => e.target.files[0] && onFile(e.target.files[0])} />

        {archivo ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{archivo.name}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                {(archivo.size / 1024).toFixed(1)} KB
                {preview && ` · ${preview.totalFilas} filas · `}
                {preview && <span style={{ color: preview.totalFaltantes > 0 ? "#f59e0b" : "#22c55e" }}>{preview.totalFaltantes} faltantes</span>}
              </div>
            </div>
            <button onClick={e => { e.stopPropagation(); onQuitar() }}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 18, padding: 4 }}>✕</button>
          </div>
        ) : (
          <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            <div style={{ fontSize: 22, marginBottom: 4 }}>📂</div>
            Arrastrá o <span style={{ color: variable.color }}>seleccioná</span> el archivo CSV / Excel
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#ef4444", background: "#ef444415", borderRadius: 6, padding: "6px 10px" }}>
          ⚠️ {error}
        </div>
      )}

      {preview && !error && (
        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {preview.columnas.map(c => (
                  <th key={c} style={{ padding: "3px 6px", color: "var(--text-muted)", fontWeight: 500, textAlign: "left", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{c}</th>
                ))}
                <th style={{ padding: "3px 6px", color: "var(--text-muted)" }}>…</th>
              </tr>
            </thead>
            <tbody>
              {preview.filas.map((fila, i) => (
                <tr key={i}>
                  {fila.map((c, j) => (
                    <td key={j} style={{ padding: "3px 6px", color: c === "-" || c === "-9" ? "#ef4444" : "var(--text-muted)", whiteSpace: "nowrap" }}>{c}</td>
                  ))}
                  <td style={{ padding: "3px 6px", color: "var(--text-muted)" }}>…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function Upload() {
  const { data: stationsData } = useFetch(() => stationsApi.getAll())
  const stations = stationsData || []

  const [stationId,  setStationId]  = useState("")
  const [archivos,   setArchivos]   = useState({ temperatura: null, humedad: null, viento: null })
  const [previews,   setPreviews]   = useState({ temperatura: null, humedad: null, viento: null })
  const [errores,    setErrores]    = useState({ temperatura: "",   humedad: "",   viento: ""   })
  const [cargando,   setCargando]   = useState(false)
  const [resultados, setResultados] = useState({})
  const [subido,     setSubido]     = useState(false)

  const handleFile = (key, file) => {
    setSubido(false); setResultados({})
    setArchivos(p => ({ ...p, [key]: file }))
    setErrores(p  => ({ ...p, [key]: "" }))
    setPreviews(p => ({ ...p, [key]: null }))
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const texto = new TextDecoder("windows-1252").decode(e.target.result)
        setPreviews(p => ({ ...p, [key]: parsearCSV(texto) }))
      } catch {
        setErrores(p => ({
  ...p,
  [key]: "Formato no reconocido. Válidos: (A/B) encabezado con año;mes;dia;H1…H24, o (C) archivo con 'Estacion:' en fila 1 y horas 1:00…24:00"
}))
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const handleQuitar = (key) => {
    setArchivos(p => ({ ...p, [key]: null }))
    setPreviews(p => ({ ...p, [key]: null }))
    setErrores(p  => ({ ...p, [key]: "" }))
    setSubido(false); setResultados({})
  }

  const archivosListos  = Object.values(archivos).filter(Boolean).length
  const hayAlgunArchivo = archivosListos > 0
  const puedeSubir      = stationId && hayAlgunArchivo && !cargando

  const handleSubir = async () => {
    if (!puedeSubir) return
    setCargando(true); setResultados({})
    const nuevos = {}
    for (const v of VARIABLES) {
      if (!archivos[v.key]) continue
      try {
        const res = await uploadsApi.upload(archivos[v.key], stationId)
        nuevos[v.key] = { ok: true, data: res }
      } catch (e) {
        nuevos[v.key] = { ok: false, error: e.message }
      }
    }
    setResultados(nuevos); setCargando(false); setSubido(true)
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title">Cargar datos</h1>
        <p className="page__subtitle">Subí los archivos CSV de cada variable por estación</p>
      </header>

      {/* Selector de estación */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "16px 20px", marginBottom: 20,
      }}>
        <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
          Estación meteorológica *
        </label>
        <select
          value={stationId}
          onChange={e => { setStationId(e.target.value); setSubido(false) }}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 14,
            background: "var(--surface-2, #1e293b)", border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        >
          <option value="">Seleccionar estación…</option>
          {stations.map(s => <option key={s.id} value={s.id}>{s.name} ({s.station_code})</option>)}
        </select>
      </div>

      {/* Info formato */}
      <div style={{
        background: "#3b82f610", border: "1px solid #3b82f630",
        borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: 12, color: "#93c5fd",
      }}>
        ℹ️ <strong>Formato esperado:</strong> separador punto y coma (;) · columnas año, mes, dia, H1…H24 · valores faltantes con guion (-)
      </div>

      {/* Drop zones */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
        {VARIABLES.map(v => (
          <DropZone
            key={v.key}
            variable={v}
            archivo={archivos[v.key]}
            preview={previews[v.key]}
            error={errores[v.key]}
            onFile={f  => handleFile(v.key, f)}
            onQuitar={() => handleQuitar(v.key)}
          />
        ))}
      </div>

      {/* Botón + resultados */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "16px 20px",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {archivosListos === 0 ? "Ningún archivo cargado" : `${archivosListos} de 3 archivo${archivosListos > 1 ? "s" : ""} listo${archivosListos > 1 ? "s" : ""}`}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {VARIABLES.map(v => (
              <div key={v.key} style={{
                width: 8, height: 8, borderRadius: "50%",
                background: archivos[v.key] ? "#22c55e" : "var(--border)",
              }} title={v.label} />
            ))}
          </div>
        </div>

        <button
          onClick={handleSubir}
          disabled={!puedeSubir}
          className="btn btn--primary"
          style={{ width: "100%", opacity: puedeSubir ? 1 : 0.5, cursor: puedeSubir ? "pointer" : "not-allowed" }}
        >
          {cargando
            ? "⏳ Procesando archivos…"
            : !stationId
              ? "Seleccioná una estación para continuar"
              : !hayAlgunArchivo
                ? "Seleccioná al menos un archivo"
                : `Subir ${archivosListos} archivo${archivosListos > 1 ? "s" : ""} a la base de datos`
          }
        </button>

        {subido && Object.keys(resultados).length > 0 && (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(resultados).map(([key, res]) => {
              const v = VARIABLES.find(x => x.key === key)
              return (
                <div key={key} style={{
                  borderRadius: 8, padding: "10px 14px", fontSize: 13,
                  background: res.ok ? "#22c55e15" : "#ef444415",
                  border: `1px solid ${res.ok ? "#22c55e30" : "#ef444430"}`,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{v.icon} <strong>{v.label}</strong></span>
                    <span>{res.ok ? "✅" : "❌"}</span>
                  </div>
                  {res.ok ? (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                      {res.data.rows_inserted?.toLocaleString()} filas insertadas · Variable: {res.data.variable_type}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>{res.error}</div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}