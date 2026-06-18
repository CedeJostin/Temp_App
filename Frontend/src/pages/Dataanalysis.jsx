import { useState, useEffect, useCallback } from "react"
import { stationsApi } from "../services/api"
import {
  Thermometer, Droplets, BarChart3, Loader2, AlertTriangle, CircleCheckBig,
  ChevronLeft, ChevronRight, ChevronDown,
} from "lucide-react"

const SPIN = { animation: "spin 0.8s linear infinite" }

// ─── Colores de banda (variantes oscuras translúcidas) ───────
const BAND_COLORS = {
  green:  { bg: "rgba(34,197,94,0.14)",  border: "#22c55e", text: "#4ade80" },
  blue:   { bg: "rgba(59,130,246,0.14)", border: "#3b82f6", text: "#60a5fa" },
  yellow: { bg: "rgba(234,179,8,0.14)",  border: "#eab308", text: "#facc15" },
  orange: { bg: "rgba(249,115,22,0.14)", border: "#f97316", text: "#fb923c" },
  red:    { bg: "rgba(239,68,68,0.14)",  border: "#ef4444", text: "#f87171" },
}

const VAR_META = {
  temp: { label: "Temperatura",      unit: "°C", Icon: Thermometer, color: "#ef4444" },
  hr:   { label: "Humedad Relativa", unit: "%",  Icon: Droplets,    color: "#3b82f6" },
}

// ─── Helpers ─────────────────────────────────────────────────
function StatBox({ label, value, unit = "" }) {
  return (
    <div style={{
      background: "var(--bg2)", border: "1px solid var(--border)",
      borderRadius: "var(--radius)", padding: "12px 16px", textAlign: "center",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.07em", color: "var(--text-muted)", marginBottom: 4 }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 600, color: "var(--text)", lineHeight: 1 }}>
        {value !== undefined && value !== null ? value : "—"}
        {value !== undefined && value !== null && unit && (
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 2 }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  )
}

function CompletenessChip({ band, pct }) {
  const c = BAND_COLORS[band?.color] ?? BAND_COLORS.red
  return (
    <span className="num" style={{
      background: c.bg, border: `1px solid ${c.border}`,
      color: c.text, borderRadius: "var(--radius-pill)", padding: "3px 12px",
      fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.border, display: "inline-block" }} />
      {pct?.toFixed(2)}% · {band?.label}
    </span>
  )
}

function GapsTable({ gaps }) {
  if (!gaps?.length) return (
    <div style={{ color: "#4ade80", fontSize: 13, padding: "8px 0", display: "flex", alignItems: "center", gap: 6 }}>
      <CircleCheckBig size={16} /> Sin huecos continuos mayores a 5 días. Los datos faltantes pueden considerarse aleatorios.
    </div>
  )
  return (
    <div>
      <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <AlertTriangle size={16} /> Se detectaron <strong>{gaps.length}</strong> hueco(s) continuos mayores a 5 días:
      </div>
      <div className="table-wrap">
        <table className="table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              {["#", "Inicio", "Fin", "Días"].map(h => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gaps.map((g, i) => (
              <tr key={i}>
                <td style={{ color: "var(--text-muted)" }}>{i + 1}</td>
                <td className="num">{g.start?.slice(0, 16).replace("T", " ")}</td>
                <td className="num">{g.end?.slice(0, 16).replace("T", " ")}</td>
                <td className="num" style={{ fontWeight: 700, color: "#f87171" }}>{g.days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BoxplotViz({ stats, color, unit }) {
  if (!stats || !stats.n) return null
  const { min, q25, q50, q75, max, mean } = stats
  const range = max - min || 1
  const pct = v => ((v - min) / range * 100).toFixed(1) + "%"

  return (
    <div style={{ margin: "12px 0 4px" }}>
      <div style={{ position: "relative", height: 32, borderRadius: 4, background: "var(--border)", overflow: "visible" }}>
        {/* IQR box */}
        <div style={{
          position: "absolute", top: 6, height: 20,
          left: pct(q25), width: `calc(${pct(q75)} - ${pct(q25)})`,
          background: color + "55", border: `2px solid ${color}`,
          borderRadius: 3,
        }} />
        {/* Median line */}
        <div style={{
          position: "absolute", top: 2, bottom: 2,
          left: pct(q50), width: 2, background: color, borderRadius: 2,
        }} />
        {/* Mean dot */}
        <div style={{
          position: "absolute", top: "50%", transform: "translate(-50%, -50%)",
          left: pct(mean), width: 8, height: 8, borderRadius: "50%",
          background: color, border: "2px solid var(--surface)",
          boxShadow: "0 0 0 1px " + color,
        }} title={`Media: ${mean} ${unit}`} />
        {/* Whiskers izquierdo */}
        <div style={{ position: "absolute", top: "50%", left: "0%", right: `calc(100% - ${pct(q25)})`, height: 2, background: color + "88", transform: "translateY(-50%)" }} />
        {/* Whiskers derecho */}
        <div style={{ position: "absolute", top: "50%", left: pct(q75), right: "0%", height: 2, background: color + "88", transform: "translateY(-50%)" }} />
      </div>
      <div className="num" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
        <span>mín {min} {unit}</span>
        <span>Q25 {q25}</span>
        <span>Mediana {q50}</span>
        <span>Q75 {q75}</span>
        <span>máx {max} {unit}</span>
      </div>
    </div>
  )
}

function RawDataTable({ data, unit }) {
  const [page, setPage] = useState(0)
  const PAGE = 50
  const total = data?.length ?? 0
  const slice = data?.slice(page * PAGE, (page + 1) * PAGE) ?? []
  const totalPages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span className="num" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {total.toLocaleString()} registros depurados
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <button
            className="icon-btn"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Página anterior"
          ><ChevronLeft size={16} /></button>
          <span className="num" style={{ padding: "3px 8px", color: "var(--text-muted)" }}>
            {page + 1} / {totalPages}
          </span>
          <button
            className="icon-btn"
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            aria-label="Página siguiente"
          ><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table num" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              {["#", "Año", "Mes", "Día", "Hora", `Valor (${unit})`].map(h => (
                <th key={h} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i}>
                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{r.n}</td>
                <td style={{ textAlign: "right" }}>{r.year}</td>
                <td style={{ textAlign: "right" }}>{r.month}</td>
                <td style={{ textAlign: "right" }}>{r.day}</td>
                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{String(r.hour).padStart(2, "0")}:00</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Panel por variable ───────────────────────────────────────
function VariablePanel({ varKey, varData }) {
  const [showRaw, setShowRaw] = useState(false)
  const meta = VAR_META[varKey]
  const MetaIcon = meta.Icon

  if (!varData || varData.status === "no_data") {
    return (
      <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        Sin datos para {meta.label}
      </div>
    )
  }

  const { stats, completeness_pct, completeness_band, large_gaps, n_raw, n_clean, n_ideal, date_start, date_end } = varData

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: meta.color, display: "inline-flex" }}><MetaIcon size={26} /></span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{meta.label}</div>
            <div className="num" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {date_start?.slice(0, 10)} → {date_end?.slice(0, 10)}
            </div>
          </div>
        </div>
        <CompletenessChip band={completeness_band} pct={completeness_pct} />
      </div>

      {/* Conteos */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <StatBox label="Datos crudos"  value={n_raw?.toLocaleString()} />
        <StatBox label="Datos limpios" value={n_clean?.toLocaleString()} />
        <StatBox label="Total ideal"   value={n_ideal?.toLocaleString()} />
        <StatBox label="Completitud"   value={completeness_pct?.toFixed(2)} unit="%" />
      </div>

      {/* Estadísticos */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.07em", color: "var(--text-muted)", marginBottom: 8 }}>
          Estadísticos descriptivos
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
          <StatBox label="Mínimo"    value={stats?.min}  unit={meta.unit} />
          <StatBox label="Q25"       value={stats?.q25}  unit={meta.unit} />
          <StatBox label="Mediana"   value={stats?.q50}  unit={meta.unit} />
          <StatBox label="Media"     value={stats?.mean} unit={meta.unit} />
          <StatBox label="Q75"       value={stats?.q75}  unit={meta.unit} />
          <StatBox label="Máximo"    value={stats?.max}  unit={meta.unit} />
          <StatBox label="Moda"      value={stats?.mode} unit={meta.unit} />
          <StatBox label="Desv. std" value={stats?.std}  unit={meta.unit} />
        </div>
        <BoxplotViz stats={stats} color={meta.color} unit={meta.unit} />
      </div>

      {/* Huecos */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.07em", color: "var(--text-muted)", marginBottom: 8 }}>
          Análisis de huecos continuos (&gt; 5 días)
        </div>
        <GapsTable gaps={large_gaps} />
      </div>

      {/* Datos crudos colapsables */}
      <div>
        <button
          onClick={() => setShowRaw(v => !v)}
          className="btn btn--ghost"
          style={{ fontSize: 12 }}
        >
          {showRaw ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Datos primarios crudos depurados
        </button>
        {showRaw && (
          <div style={{ marginTop: 12 }}>
            <RawDataTable data={varData.raw_data} unit={meta.unit} />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────
export default function DataAnalysis() {
  const [stations,  setStations]  = useState([])
  const [stationId, setStationId] = useState("")
  const [dateFrom,  setDateFrom]  = useState("")
  const [dateTo,    setDateTo]    = useState("")
  const [analysis,  setAnalysis]  = useState(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState("")
  const [activeVar, setActiveVar] = useState("temp")

  // Cargar estaciones usando stationsApi
  useEffect(() => {
    stationsApi.getAll().then(setStations).catch(() => {})
  }, [])

  const runAnalysis = useCallback(async () => {
    if (!stationId) return
    setLoading(true)
    setError("")
    try {
      const data = await stationsApi.analysis(stationId, {
        date_from: dateFrom || undefined,
        date_to:   dateTo   || undefined,
      })
      setAnalysis(data)
    } catch (e) {
      setError("Error al cargar el análisis. Verificá la conexión con la API.")
    } finally {
      setLoading(false)
    }
  }, [stationId, dateFrom, dateTo])

  const varData = analysis?.variables?.[activeVar]

  return (
    <div className="page">
      {/* Header */}
      <header className="page__header">
        <div>
          <h1 className="page__title">Análisis de Calidad de Datos</h1>
          <p className="page__subtitle">Depuración, completitud y estadísticos — T y HR por estación</p>
        </div>
      </header>

      {/* Filtros */}
      <div className="card" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field">
          <span className="field__label">Estación</span>
          <select className="field__select" value={stationId} onChange={e => setStationId(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">Seleccionar…</option>
            {stations.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Desde</span>
          <input className="field__input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </label>

        <label className="field">
          <span className="field__label">Hasta</span>
          <input className="field__input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </label>

        <button className="btn btn--primary" onClick={runAnalysis} disabled={!stationId || loading}>
          {loading ? <><Loader2 size={15} style={SPIN} /> Analizando…</> : "Analizar"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="alert alert--error">
          <AlertTriangle size={16} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}

      {/* Empty state */}
      {!analysis && !loading && !error && (
        <div className="empty-state">
          <span className="empty-state__icon"><BarChart3 size={44} /></span>
          <p>Seleccioná una estación y hacé clic en <strong>Analizar</strong>.</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="empty-state">
          <span className="empty-state__icon"><Loader2 size={32} style={SPIN} /></span>
          <p>Procesando datos…</p>
        </div>
      )}

      {/* Resultado */}
      {analysis && !loading && (
        <>
          <div className="num" style={{ fontSize: 14, color: "var(--text-muted)" }}>
            Estación: <strong style={{ color: "var(--text)" }}>{analysis.station_name}</strong>
            {" · "}
            <span>{analysis.station_code}</span>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(VAR_META).map(([key, meta]) => {
              const vd     = analysis.variables?.[key]
              const active = activeVar === key
              const TabIcon = meta.Icon
              return (
                <button
                  key={key}
                  onClick={() => setActiveVar(key)}
                  style={{
                    padding: "8px 18px", borderRadius: "var(--radius)",
                    border: `1px solid ${active ? meta.color : "var(--border)"}`,
                    background: active ? meta.color + "18" : "var(--surface)",
                    color: active ? meta.color : "var(--text-muted)",
                    fontWeight: active ? 700 : 500, fontSize: 13, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6, transition: "all .15s",
                  }}
                >
                  <TabIcon size={16} />
                  {meta.label}
                  {vd?.completeness_band && (
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: BAND_COLORS[vd.completeness_band.color]?.border ?? "var(--text-faint)",
                      display: "inline-block",
                    }} />
                  )}
                </button>
              )
            })}
          </div>

          {/* Panel */}
          <div className="card" style={{ padding: "24px" }}>
            <VariablePanel varKey={activeVar} varData={varData} />
          </div>
        </>
      )}
    </div>
  )
}
