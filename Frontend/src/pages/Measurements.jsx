import { useState, useRef } from "react"
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell
} from "recharts"

const VARIABLES = [
  { key: "temperatura", label: "Temperatura",     unit: "°C",  color: "#ef4444", step: 0.1 },
  { key: "humedad",     label: "Humedad Relativa", unit: "%",   color: "#3b82f6", step: 1   },
  { key: "viento",      label: "Viento",           unit: "m/s", color: "#22c55e", step: 0.5 },
]

const MESES  = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]
const HORAS  = Array.from({ length: 24 }, (_, i) => i)

// ── Parser local (sin guardar en BD) ─────────────────────────
const parsearLocal = (texto, variable) => {
  const lineas = texto.trim().split("\n").filter(Boolean)
  const sep = lineas[0].includes(";") ? ";" : ","
  const cols = lineas[0].split(sep).map(c => c.trim().replace(/^\uFEFF/, ""))
  const colsN = cols.map(c => c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())

  const esHorario = colsN.includes("ano") && colsN.some(c => c === "h1")
  const esViento  = colsN.includes("fecha") && colsN.includes("velocidad")

  if (!esHorario && !esViento) throw new Error("Formato no reconocido")

  const registros = []

  if (esHorario) {
    const iAno = colsN.indexOf("ano")
    const iMes = colsN.indexOf("mes")
    const iDia = colsN.findIndex(c => c === "dia" || c === "día")
    const hCols = cols.map((c, i) => ({ i, h: parseInt(c.toUpperCase().replace("H","")) }))
                      .filter(x => !isNaN(x.h) && x.h >= 1 && x.h <= 24)

    for (let r = 1; r < lineas.length; r++) {
      const celdas = lineas[r].split(sep).map(c => c.trim())
      const ano = parseInt(celdas[iAno])
      const mes = parseInt(celdas[iMes]) - 1
      const dia = parseInt(celdas[iDia])
      if (isNaN(ano) || isNaN(mes) || isNaN(dia)) continue
      for (const { i, h } of hCols) {
        const raw = celdas[i]
        if (!raw || raw === "-" || raw === "-9") continue
        const val = parseFloat(raw.replace(",", "."))
        if (isNaN(val) || val < 0) continue
        registros.push({ fecha: new Date(ano, mes, dia, h - 1), valor: val })
      }
    }
  } else {
    const iFecha = colsN.indexOf("fecha")
    const iHora  = colsN.indexOf("hora")
    const iVel   = colsN.findIndex(c => c.includes("velocidad") || c.includes("vel"))
    for (let r = 1; r < lineas.length; r++) {
      const celdas = lineas[r].split(sep).map(c => c.trim())
      const fechaStr = celdas[iFecha]
      const horaRaw  = parseInt(celdas[iHora])
      const val      = parseFloat(celdas[iVel]?.replace(",","."))
      if (!fechaStr || isNaN(val) || val < 0) continue
      const [d, m, a] = fechaStr.split("/").map(Number)
      const hora = Math.floor(horaRaw / 100) % 24
      registros.push({ fecha: new Date(a, m - 1, d, hora), valor: val })
    }
  }

  return registros
}

const calcularEstadisticos = (registros) => {
  const vals = registros.map(r => r.valor).sort((a, b) => a - b)
  const n    = vals.length
  if (n === 0) return null
  const sum  = vals.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const std  = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / n)
  return {
    n, mean: +mean.toFixed(2), std: +std.toFixed(2),
    min: vals[0], max: vals[n - 1],
    q25: vals[Math.floor(n * 0.25)],
    q50: vals[Math.floor(n * 0.50)],
    q75: vals[Math.floor(n * 0.75)],
  }
}

const calcularFDP = (registros, paso) => {
  const vals = registros.map(r => r.valor)
  const min  = Math.min(...vals)
  const max  = Math.max(...vals)
  const bins = {}
  for (const v of vals) {
    const bin = +(Math.round(v / paso) * paso).toFixed(2)
    bins[bin] = (bins[bin] || 0) + 1
  }
  return Object.entries(bins)
    .map(([x, count]) => ({ x: parseFloat(x), freq: +(count / vals.length * 100).toFixed(3) }))
    .sort((a, b) => a.x - b.x)
}

const calcularCalor = (registros) => {
  const grid = Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => ({ sum: 0, n: 0 })))
  for (const { fecha, valor } of registros) {
    const m = fecha.getMonth()
    const h = fecha.getHours()
    grid[m][h].sum += valor
    grid[m][h].n   += 1
  }
  const result = []
  for (let m = 0; m < 12; m++)
    for (let h = 0; h < 24; h++)
      if (grid[m][h].n > 0)
        result.push({ mes: m + 1, hora: h, avg: +(grid[m][h].sum / grid[m][h].n).toFixed(2) })
  return result
}

const calcularSerie = (registros) => {
  const byDay = {}
  for (const { fecha, valor } of registros) {
    const key = `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,"0")}-${String(fecha.getDate()).padStart(2,"0")}`
    if (!byDay[key]) byDay[key] = []
    byDay[key].push(valor)
  }
  return Object.entries(byDay)
    .map(([period, vals]) => ({
      period,
      avg: +(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2),
      min: +Math.min(...vals).toFixed(2),
      max: +Math.max(...vals).toFixed(2),
    }))
    .sort((a, b) => a.period.localeCompare(b.period))
}

// ── Mapa de calor ─────────────────────────────────────────────
const lerp = (a, b, t) => Math.round(a + (b - a) * t)

const heatColor = (val, min, max, color) => {
  if (val == null) return "var(--surface-2)"
  const t = max > min ? (val - min) / (max - min) : 0
  const hex = c => parseInt(c, 16)
  const r1 = [15, 23, 42], r2 = color === "#ef4444" ? [239,68,68] : color === "#3b82f6" ? [59,130,246] : [34,197,94]
  return `rgb(${lerp(r1[0],r2[0],t)},${lerp(r1[1],r2[1],t)},${lerp(r1[2],r2[2],t)})`
}

function HeatmapGrid({ calor, color, unit }) {
  const vals = calor.map(d => d.avg)
  const min  = Math.min(...vals)
  const max  = Math.max(...vals)
  const get  = (m, h) => { const d = calor.find(x => x.mes === m+1 && x.hora === h); return d ? d.avg : null }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 10, minWidth: 600 }}>
        <thead>
          <tr>
            <th style={{ padding: "3px 8px", color: "var(--text-muted)", textAlign: "left" }}>Mes\Hora</th>
            {HORAS.map(h => <th key={h} style={{ padding: "3px 3px", color: "var(--text-muted)", minWidth: 32, fontWeight: 400 }}>{String(h).padStart(2,"0")}</th>)}
          </tr>
        </thead>
        <tbody>
          {MESES.map((m, mi) => (
            <tr key={m}>
              <td style={{ padding: "2px 8px", color: "var(--text-muted)", fontWeight: 600 }}>{m}</td>
              {HORAS.map(h => {
                const v = get(mi, h)
                return (
                  <td key={h} title={v != null ? `${m} ${String(h).padStart(2,"0")}:00 → ${v}${unit}` : "Sin dato"}
                    style={{ background: heatColor(v, min, max, color), borderRadius: 2, minWidth: 32, height: 20 }} />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
        <span>{min.toFixed(1)}{unit}</span>
        <div style={{ flex: 1, height: 8, borderRadius: 4, background: `linear-gradient(to right, #0f1726, ${color})` }} />
        <span>{max.toFixed(1)}{unit}</span>
      </div>
    </div>
  )
}

// ── Card de variable ──────────────────────────────────────────
function VariableCard({ variable, resultado }) {
  const [tab, setTab] = useState("serie")
  const { stats, serie, fdp, calor } = resultado
  const TABS = [
    { id: "serie", label: "Serie temporal" },
    { id: "fdp",   label: "FDP"            },
    { id: "calor", label: "Mapa de calor"  },
  ]

  return (
    <div style={{
      background: "var(--surface)", border: `1px solid ${variable.color}30`,
      borderTop: `3px solid ${variable.color}`, borderRadius: 12, marginBottom: 20,
    }}>
      {/* Header */}
      <div style={{ padding: "16px 20px 0", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{variable.label}</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{stats.n.toLocaleString()} registros válidos</span>
      </div>

      {/* Estadísticos */}
      <div style={{ padding: "12px 20px", display: "flex", gap: 10, flexWrap: "wrap" }}>
        {[
          { l: "Media",   v: `${stats.mean}${variable.unit}` },
          { l: "Desv.",   v: `${stats.std}${variable.unit}`  },
          { l: "Mín",     v: `${stats.min}${variable.unit}`  },
          { l: "Máx",     v: `${stats.max}${variable.unit}`  },
          { l: "Q25",     v: `${stats.q25}${variable.unit}`  },
          { l: "Q50",     v: `${stats.q50}${variable.unit}`  },
          { l: "Q75",     v: `${stats.q75}${variable.unit}`  },
        ].map(({ l, v }) => (
          <div key={l} style={{ background: "var(--surface-2,#1e293b)", borderRadius: 8, padding: "8px 12px", textAlign: "center", minWidth: 70 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: variable.color }}>{v}</div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Pestañas */}
      <div style={{ padding: "0 20px", borderTop: "1px solid var(--border)", display: "flex", gap: 2 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "10px 14px", fontSize: 13, fontWeight: 500, cursor: "pointer",
            background: "none", border: "none", color: tab === t.id ? variable.color : "var(--text-muted)",
            borderBottom: `2px solid ${tab === t.id ? variable.color : "transparent"}`,
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Contenido */}
      <div style={{ padding: "16px 20px" }}>
        {tab === "serie" && (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={serie} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id={`g-${variable.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={variable.color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={variable.color} stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="period" tick={{ fontSize: 9, fill: "var(--text-muted)" }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} unit={variable.unit} />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
              <Legend />
              <Area type="monotone" dataKey="max" name="Máx"      stroke={variable.color} fill="none" strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg" name="Promedio" stroke={variable.color} fill={`url(#g-${variable.key})`} strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="min" name="Mín"      stroke={variable.color} fill="none" strokeWidth={1} opacity={0.4} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
        {tab === "fdp" && (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={fdp} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="x" tick={{ fontSize: 9, fill: "var(--text-muted)" }} unit={variable.unit} interval={Math.ceil(fdp.length / 10)} />
              <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} unit="%" />
              <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                formatter={v => [`${v}%`, "Frecuencia"]} labelFormatter={v => `${v} ${variable.unit}`} />
              <Bar dataKey="freq" name="Frecuencia" radius={[2,2,0,0]}>
                {fdp.map((_, i) => <Cell key={i} fill={variable.color} fillOpacity={0.75} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        {tab === "calor" && <HeatmapGrid calor={calor} color={variable.color} unit={variable.unit} />}
      </div>
    </div>
  )
}

// ── Drop zone individual ──────────────────────────────────────
function DropZone({ variable, archivo, onFile, onQuitar }) {
  const ref  = useRef()
  const [drag, setDrag] = useState(false)
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{variable.label}</span>
        {archivo && <span style={{ background: "#22c55e20", color: "#22c55e", borderRadius: 20, padding: "2px 8px", fontSize: 11 }}>Listo</span>}
      </div>
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
        onClick={() => !archivo && ref.current.click()}
        style={{
          border: `2px dashed ${drag ? variable.color : archivo ? "#22c55e" : "var(--border)"}`,
          borderRadius: 8, padding: "10px 14px", cursor: archivo ? "default" : "pointer",
          background: drag ? `${variable.color}10` : "transparent", transition: "all 0.15s",
        }}
      >
        <input ref={ref} type="file" accept=".csv,.xlsx" style={{ display: "none" }} onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
        {archivo ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13 }}>📄 {archivo.name} <span style={{ color: "var(--text-muted)", fontSize: 11 }}>({(archivo.size/1024).toFixed(1)} KB)</span></span>
            <button onClick={e => { e.stopPropagation(); onQuitar() }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16 }}>✕</button>
          </div>
        ) : (
          <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            📂 Arrastrá o <span style={{ color: variable.color }}>seleccioná</span> el archivo
          </div>
        )}
      </div>
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────
export default function Measurements() {
  const [archivos,    setArchivos]    = useState({ temperatura: null, humedad: null, viento: null })
  const [procesando,  setProcesando]  = useState(false)
  const [resultados,  setResultados]  = useState(null)
  const [errorGlobal, setErrorGlobal] = useState("")

  const handleFile = (key, file) => {
    setArchivos(p => ({ ...p, [key]: file }))
    setResultados(null)
    setErrorGlobal("")
  }

  const handleQuitar = (key) => {
    setArchivos(p => ({ ...p, [key]: null }))
    setResultados(null)
  }

  const hayArchivos = Object.values(archivos).some(Boolean)

  const handleAnalizar = async () => {
    if (!hayArchivos) return
    setProcesando(true)
    setErrorGlobal("")
    setResultados(null)

    const nuevos = {}

    for (const v of VARIABLES) {
      if (!archivos[v.key]) continue
      try {
        const buffer = await archivos[v.key].arrayBuffer()
        const texto  = new TextDecoder("windows-1252").decode(buffer)
        const registros = parsearLocal(texto, v.key)
        if (registros.length === 0) throw new Error("No se encontraron datos válidos en el archivo")
        nuevos[v.key] = {
          stats: calcularEstadisticos(registros),
          serie: calcularSerie(registros),
          fdp:   calcularFDP(registros, v.step),
          calor: calcularCalor(registros),
        }
      } catch (e) {
        nuevos[v.key] = { error: e.message }
      }
    }

    setResultados(nuevos)
    setProcesando(false)
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title">Mediciones</h1>
        <p className="page__subtitle">Análisis local de archivos CSV — sin guardar en la base de datos</p>
      </header>

      {/* Panel de carga */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "20px", marginBottom: 24,
      }}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 14 }}>
          Subí los archivos CSV de cada variable para visualizar el análisis localmente. Los datos <strong>no se guardan</strong> en la base de datos.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12, marginBottom: 16 }}>
          {VARIABLES.map(v => (
            <DropZone
              key={v.key}
              variable={v}
              archivo={archivos[v.key]}
              onFile={f  => handleFile(v.key, f)}
              onQuitar={() => handleQuitar(v.key)}
            />
          ))}
        </div>

        {errorGlobal && (
          <div style={{ marginBottom: 12, fontSize: 13, color: "#ef4444", background: "#ef444415", borderRadius: 6, padding: "8px 12px" }}>
            ⚠️ {errorGlobal}
          </div>
        )}

        <button
          onClick={handleAnalizar}
          disabled={!hayArchivos || procesando}
          className="btn btn--primary"
          style={{ width: "100%", opacity: hayArchivos && !procesando ? 1 : 0.5, cursor: hayArchivos && !procesando ? "pointer" : "not-allowed" }}
        >
          {procesando ? "⏳ Analizando datos…" : "Analizar archivos"}
        </button>
      </div>

      {/* Resultados */}
      {resultados && VARIABLES.map(v => {
        const res = resultados[v.key]
        if (!res) return null
        if (res.error) return (
          <div key={v.key} style={{ marginBottom: 16, background: "#ef444415", border: "1px solid #ef444430", borderRadius: 10, padding: "12px 16px", fontSize: 13, color: "#ef4444" }}>
            ❌ <strong>{v.label}:</strong> {res.error}
          </div>
        )
        return <VariableCard key={v.key} variable={v} resultado={res} />
      })}
    </div>
  )
}