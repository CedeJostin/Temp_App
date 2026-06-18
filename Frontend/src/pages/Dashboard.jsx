import { useState, useEffect } from "react"
import { useFetch } from "../hooks/useFetch"
import { stationsApi, measurementsApi } from "../services/api"
import { Thermometer, Droplets, CloudSun, Wind } from "lucide-react"
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts"

const VARIABLES = [
  { code: "TEMP",   label: "Temperatura",  unit: "°C",   color: "#ef4444", Icon: Thermometer },
  { code: "HR",     label: "Humedad",      unit: "%",    color: "#3b82f6", Icon: Droplets },
  { code: "RAD",    label: "Radiación",    unit: "W/m²", color: "#f59e0b", Icon: CloudSun },
  { code: "VIENTO", label: "Viento",       unit: "m/s",  color: "#22c55e", Icon: Wind },
]

const GROUP_OPTIONS = [
  { value: "day",   label: "Por día"   },
  { value: "month", label: "Por mes"   },
  { value: "year",  label: "Por año"   },
]

function SummaryCard({ variable, summary }) {
  const s = summary?.find(r => r.variable_code === variable.code)
  const { Icon } = variable
  return (
    <div className="stat-card" style={{ "--stat-accent": variable.color, alignItems: "flex-start" }}>
      <div className="stat-card__body" style={{ flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="stat-card__label">{variable.label}</span>
          <span className="stat-card__icon"><Icon size={18} /></span>
        </div>
        {s ? (
          <>
            <p className="stat-card__value">
              {s.avg?.toFixed(1)}
              <span className="stat-card__unit"> {variable.unit}</span>
            </p>
            <div className="num" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.7 }}>
              <span>Máx {s.max?.toFixed(1)} {variable.unit}</span>
              <span style={{ margin: "0 8px", color: "var(--text-faint)" }}>·</span>
              <span>Mín {s.min?.toFixed(1)} {variable.unit}</span>
              <br />
              <span>{s.count?.toLocaleString()} mediciones</span>
            </div>
          </>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>Sin datos</p>
        )}
      </div>
    </div>
  )
}

function VariableChart({ stationId, variable, groupBy }) {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(false)
  const { Icon } = variable

  useEffect(() => {
    if (!stationId) return
    setLoading(true)
    measurementsApi.byDate({ station_id: stationId, variable_code: variable.code, group_by: groupBy })
      .then(setData).catch(() => setData([])).finally(() => setLoading(false))
  }, [stationId, variable.code, groupBy])

  const fmt = (s) => {
    if (!s) return ""
    const d = new Date(s)
    return isNaN(d) ? s : groupBy === "year"
      ? d.getFullYear().toString()
      : d.toLocaleDateString("es-CR", groupBy === "month" ? { month: "short", year: "2-digit" } : { day: "2-digit", month: "short" })
  }

  return (
    <div className="card">
      <div className="chart-card__header">
        <span style={{ color: variable.color, display: "inline-flex" }}><Icon size={16} /></span>
        <span style={{ fontWeight: 600 }}>{variable.label}</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{variable.unit}</span>
      </div>

      {loading && <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>Cargando…</div>}

      {!loading && data.length === 0 && (
        <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
          Sin datos para esta estación
        </div>
      )}

      {!loading && data.length > 0 && (
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${variable.code}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={variable.color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={variable.color} stopOpacity={0}   />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 9, fill: "var(--text-muted)" }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} unit={variable.unit} />
            <Tooltip labelFormatter={fmt} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
            <Area type="monotone" dataKey="avg" name="Promedio" stroke={variable.color} fill={`url(#grad-${variable.code})`} strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export default function Dashboard() {
  const { data: stations } = useFetch(() => stationsApi.getAll())
  const [stationId, setStationId] = useState("")
  const [groupBy,   setGroupBy]   = useState("day")
  const [summary,   setSummary]   = useState([])

  const stationList = stations || []

  useEffect(() => {
    if (!stationId) return
    measurementsApi.summary({ station_id: stationId })
      .then(setSummary).catch(() => setSummary([]))
  }, [stationId])

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Dashboard</h1>
          <p className="page__subtitle">Resumen de mediciones ambientales</p>
        </div>
        <div className="page__controls">
          <label className="field">
            <span className="field__label">Estación</span>
            <select className="field__select" value={stationId} onChange={e => setStationId(e.target.value)}>
              <option value="">Seleccionar…</option>
              {stationList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Agrupación</span>
            <select className="field__select" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
              {GROUP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
      </header>

      {!stationId ? (
        <div className="empty-state">
          <span className="empty-state__icon"><CloudSun size={44} /></span>
          <p>Seleccioná una estación para ver el resumen.</p>
        </div>
      ) : (
        <>
          {/* Tarjetas resumen */}
          <div className="stats-grid">
            {VARIABLES.map(v => <SummaryCard key={v.code} variable={v} summary={summary} />)}
          </div>

          {/* Gráficos */}
          <div className="charts-grid">
            {VARIABLES.map(v => (
              <VariableChart key={v.code} stationId={stationId} variable={v} groupBy={groupBy} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
