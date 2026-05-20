import { useState, useEffect, useCallback } from "react"
import { stationsApi } from "../services/api"

// ─── Colores de banda ────────────────────────────────────────
const BAND_COLORS = {
  green:  { bg: "#dcfce7", border: "#16a34a", text: "#15803d" },
  blue:   { bg: "#dbeafe", border: "#2563eb", text: "#1d4ed8" },
  yellow: { bg: "#fef9c3", border: "#ca8a04", text: "#a16207" },
  orange: { bg: "#ffedd5", border: "#ea580c", text: "#c2410c" },
  red:    { bg: "#fee2e2", border: "#dc2626", text: "#b91c1c" },
}

const VAR_META = {
  temp: { label: "Temperatura",     unit: "°C", icon: "🌡️", color: "#ef4444" },
  hr:   { label: "Humedad Relativa", unit: "%",  icon: "💧", color: "#3b82f6" },
}

// ─── Helpers ─────────────────────────────────────────────────
function StatBox({ label, value, unit = "" }) {
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "12px 16px", textAlign: "center",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.07em", color: "var(--text-muted)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>
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
    <span style={{
      background: c.bg, border: `1px solid ${c.border}`,
      color: c.text, borderRadius: 20, padding: "3px 12px",
      fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.border, display: "inline-block" }} />
      {pct?.toFixed(2)}% · {band?.label}
    </span>
  )
}

function GapsTable({ gaps }) {
  if (!gaps?.length) return (
    <div style={{ color: "#16a34a", fontSize: 13, padding: "8px 0", display: "flex", alignItems: "center", gap: 6 }}>
      <span>✅</span> Sin huecos continuos mayores a 5 días. Los datos faltantes pueden considerarse aleatorios.
    </div>
  )
  return (
    <div>
      <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <span>⚠️</span> Se detectaron <strong>{gaps.length}</strong> hueco(s) continuos mayores a 5 días:
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--surface-alt, #f8fafc)" }}>
              {["#", "Inicio", "Fin", "Días"].map(h => (
                <th key={h} style={{ padding: "6px 10px", textAlign: "left",
                  borderBottom: "1px solid var(--border)", fontWeight: 700,
                  color: "var(--text-muted)", letterSpacing: "0.05em", fontSize: 10,
                  textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gaps.map((g, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "5px 10px", color: "var(--text-muted)" }}>{i + 1}</td>
                <td style={{ padding: "5px 10px", fontFamily: "monospace" }}>{g.start?.slice(0, 16).replace("T", " ")}</td>
                <td style={{ padding: "5px 10px", fontFamily: "monospace" }}>{g.end?.slice(0, 16).replace("T", " ")}</td>
                <td style={{ padding: "5px 10px", fontWeight: 700, color: "#dc2626" }}>{g.days}</td>
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
          background: color, border: "2px solid white",
          boxShadow: "0 0 0 1px " + color,
        }} title={`Media: ${mean} ${unit}`} />
        {/* Whiskers izquierdo */}
        <div style={{ position: "absolute", top: "50%", left: "0%", right: `calc(100% - ${pct(q25)})`, height: 2, background: color + "88", transform: "translateY(-50%)" }} />
        {/* Whiskers derecho */}
        <div style={{ position: "absolute", top: "50%", left: pct(q75), right: "0%", height: 2, background: color + "88", transform: "translateY(-50%)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
        <span>↓ {min} {unit}</span>
        <span>Q25 {q25}</span>
        <span>Mediana {q50}</span>
        <span>Q75 {q75}</span>
        <span>↑ {max} {unit}</span>
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
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {total.toLocaleString()} registros depurados
        </span>
        <div style={{ display: "flex", gap: 6, fontSize: 12 }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border)",
              background: "var(--surface)", cursor: page === 0 ? "default" : "pointer",
              opacity: page === 0 ? 0.4 : 1 }}
          >‹</button>
          <span style={{ padding: "3px 8px", color: "var(--text-muted)" }}>
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border)",
              background: "var(--surface)", cursor: "pointer",
              opacity: page >= totalPages - 1 ? 0.4 : 1 }}
          >›</button>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--surface-alt, #f8fafc)" }}>
              {["#", "Año", "Mes", "Día", "Hora", `Valor (${unit})`].map(h => (
                <th key={h} style={{ padding: "6px 12px", textAlign: "right",
                  borderBottom: "1px solid var(--border)", fontWeight: 700,
                  color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase",
                  letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--border)",
                background: i % 2 === 0 ? "transparent" : "var(--surface-alt, #f9fafb)" }}>
                <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--text-muted)", fontFamily: "monospace" }}>{r.n}</td>
                <td style={{ padding: "4px 12px", textAlign: "right" }}>{r.year}</td>
                <td style={{ padding: "4px 12px", textAlign: "right" }}>{r.month}</td>
                <td style={{ padding: "4px 12px", textAlign: "right" }}>{r.day}</td>
                <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--text-muted)" }}>{String(r.hour).padStart(2, "0")}:00</td>
                <td style={{ padding: "4px 12px", textAlign: "right", fontWeight: 600 }}>{r.value}</td>
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 28 }}>{meta.icon}</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>{meta.label}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
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
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)",
            background: "var(--surface)", cursor: "pointer", fontSize: 12, fontWeight: 600,
            color: "var(--text)",
          }}
        >
          {showRaw ? "▾" : "▸"} Datos primarios crudos depurados
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
      <header className="page__header" style={{ marginBottom: 20 }}>
        <h1 className="page__title">Análisis de Calidad de Datos</h1>
        <p className="page__subtitle">Depuración, completitud y estadísticos — T y HR por estación</p>
      </header>

      {/* Filtros */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "16px 20px", marginBottom: 20,
        display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end",
      }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase",
            color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
            Estación
          </label>
          <select
            value={stationId}
            onChange={e => setStationId(e.target.value)}
            style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)",
              background: "var(--surface)", color: "var(--text)", fontSize: 13, minWidth: 180 }}
          >
            <option value="">Seleccionar…</option>
            {stations.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase",
            color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
            Desde
          </label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)",
              background: "var(--surface)", color: "var(--text)", fontSize: 13 }} />
        </div>

        <div>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase",
            color: "var(--text-muted)", display: "block", marginBottom: 3 }}>
            Hasta
          </label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)",
              background: "var(--surface)", color: "var(--text)", fontSize: 13 }} />
        </div>

        <button
          onClick={runAnalysis}
          disabled={!stationId || loading}
          style={{
            padding: "8px 22px", borderRadius: 8, border: "none",
            background: stationId && !loading ? "#3b82f6" : "var(--border)",
            color: stationId && !loading ? "white" : "var(--text-muted)",
            fontWeight: 700, fontSize: 13,
            cursor: stationId && !loading ? "pointer" : "default",
            transition: "background .15s",
          }}
        >
          {loading ? "Analizando…" : "Analizar"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: "#fee2e2", border: "1px solid #dc2626", borderRadius: 10,
          padding: "10px 16px", color: "#b91c1c", fontSize: 13, marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Empty state */}
      {!analysis && !loading && !error && (
        <div style={{ textAlign: "center", padding: "4rem 0", color: "var(--text-muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
          <p>Seleccioná una estación y hacé clic en <strong>Analizar</strong>.</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: "4rem 0", color: "var(--text-muted)" }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>⏳</div>
          <p>Procesando datos…</p>
        </div>
      )}

      {/* Resultado */}
      {analysis && !loading && (
        <>
          <div style={{ marginBottom: 16, fontSize: 14, color: "var(--text-muted)" }}>
            Estación: <strong style={{ color: "var(--text)" }}>{analysis.station_name}</strong>
            {" · "}
            <span style={{ fontFamily: "monospace" }}>{analysis.station_code}</span>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            {Object.entries(VAR_META).map(([key, meta]) => {
              const vd     = analysis.variables?.[key]
              const active = activeVar === key
              return (
                <button
                  key={key}
                  onClick={() => setActiveVar(key)}
                  style={{
                    padding: "8px 18px", borderRadius: 10,
                    border: `2px solid ${active ? meta.color : "var(--border)"}`,
                    background: active ? meta.color + "18" : "var(--surface)",
                    color: active ? meta.color : "var(--text-muted)",
                    fontWeight: active ? 700 : 500, fontSize: 13, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6, transition: "all .15s",
                  }}
                >
                  <span>{meta.icon}</span>
                  {meta.label}
                  {vd?.completeness_band && (
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: BAND_COLORS[vd.completeness_band.color]?.border ?? "#ccc",
                      display: "inline-block",
                    }} />
                  )}
                </button>
              )
            })}
          </div>

          {/* Panel */}
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 14, padding: "24px",
          }}>
            <VariablePanel varKey={activeVar} varData={varData} />
          </div>
        </>
      )}
    </div>
  )
}