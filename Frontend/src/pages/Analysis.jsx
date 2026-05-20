import { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, BarChart, Bar, ScatterChart, Scatter,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine, Cell, Brush,
} from 'recharts'
import { stationsApi, measurementsApi } from '../services/api'

const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
const HOURS  = Array.from({ length: 24 }, (_, i) => i)

const TABS = [
  { id: 'overview', label: 'a) Visualización general' },
  { id: 'fdp',      label: 'b) FDP'                   },
  { id: 'isolines', label: 'c) Distribución temporal'  },
  { id: 'combined', label: 'd) T × HR combinado'       },
]

const fmt = (s) => {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d) ? s : d.toLocaleDateString('es-CR')
}

// ── UI helpers ────────────────────────────────────────────────
const Card = ({ children, style = {} }) => (
  <div style={{
    background: '#1e293b', border: '1px solid #334155',
    borderRadius: 12, padding: '20px', marginBottom: 20, ...style
  }}>
    {children}
  </div>
)

const Spinner = () => (
  <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
    ⏳ Cargando datos…
  </div>
)

const Err = ({ msg }) => (
  <div style={{ padding: '12px 16px', background: '#ef444420', border: '1px solid #ef444440', borderRadius: 8, color: '#ef4444', fontSize: 13, marginBottom: 16 }}>
    ⚠️ {msg}
  </div>
)

const StatBox = ({ label, value, unit, color }) => (
  <div style={{ background: '#0f172a', borderRadius: 8, padding: '10px 14px', textAlign: 'center', minWidth: 80 }}>
    <div style={{ fontSize: 16, fontWeight: 700, color: color || '#f1f5f9' }}>
      {typeof value === 'number' ? value.toFixed(2) : value}
      {unit && <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8', marginLeft: 2 }}>{unit}</span>}
    </div>
    <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{label}</div>
  </div>
)

const SectionCard = ({ title, subtitle, children }) => (
  <Card>
    <div style={{ marginBottom: 14 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>{title}</h3>
      {subtitle && <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>{subtitle}</p>}
    </div>
    {children}
  </Card>
)

// ── Mapa de calor ─────────────────────────────────────────────
const lerp = (a, b, t) => Math.round(a + (b - a) * t)

const heatColor = (val, min, max, type) => {
  if (val == null) return '#1e293b'
  const t = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0
  if (type === 'TEMP') {
    const r = t < 0.5 ? lerp(59, 250, t*2)   : lerp(250, 220, (t-0.5)*2)
    const g = t < 0.5 ? lerp(130, 204, t*2)  : lerp(204, 38,  (t-0.5)*2)
    const b = t < 0.5 ? lerp(246, 20, t*2)   : lerp(20, 38,   (t-0.5)*2)
    return `rgb(${r},${g},${b})`
  }
  const r = lerp(240, 30, t), g = lerp(249, 64, t), bl = lerp(255, 175, t)
  return `rgb(${r},${g},${bl})`
}

// ── Section A ─────────────────────────────────────────────────
function SectionOverview({ stationId, dateFrom, dateTo }) {
  const [tStats,  setTStats]  = useState(null)
  const [hStats,  setHStats]  = useState(null)
  const [tSeries, setTSeries] = useState([])
  const [hSeries, setHSeries] = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const [ts, hs, tse, hse] = await Promise.all([
        measurementsApi.stats({ station_id: stationId, variable_code: 'TEMP', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.stats({ station_id: stationId, variable_code: 'HR',   date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({ station_id: stationId, variable_code: 'TEMP', group_by: 'day', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({ station_id: stationId, variable_code: 'HR',   group_by: 'day', date_from: dateFrom, date_to: dateTo }),
      ])
      setTStats(ts); setHStats(hs); setTSeries(tse); setHSeries(hse)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error)   return <Err msg={error} />

  const StatsRow = ({ stats, color, unit }) => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
      {[
        { l: 'Media',  v: stats.mean },
        { l: 'Desv.',  v: stats.std  },
        { l: 'Mín',    v: stats.min  },
        { l: 'Máx',    v: stats.max  },
        { l: 'Q25',    v: stats.q25  },
        { l: 'Q50',    v: stats.q50  },
        { l: 'Q75',    v: stats.q75  },
        { l: 'N',      v: stats.n    },
      ].map(({ l, v }) => <StatBox key={l} label={l} value={v} unit={l === 'N' ? '' : unit} color={color} />)}
    </div>
  )

  return (
    <>
      {tStats && (
        <SectionCard title="Temperatura (T)" subtitle={`${fmt(tStats.date_start)} → ${fmt(tStats.date_end)} · Completitud: ${tStats.completitud_pct}%`}>
          <StatsRow stats={tStats} color="#ef4444" unit="°C" />
          {tStats.anomalies_count > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f59e0b20', border: '1px solid #f59e0b40', borderRadius: 6, fontSize: 12, color: '#f59e0b' }}>
              ⚠️ {tStats.anomalies_count} valores anómalos detectados (±3σ)
            </div>
          )}
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={tSeries} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} unit="°C" />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
              <ReferenceLine y={tStats.mean} stroke="#ef4444" strokeDasharray="4 2" />
              <Area type="monotone" dataKey="max" name="Máx"      stroke="#ef4444" fill="none"      strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg" name="Promedio" stroke="#ef4444" fill="url(#tg)"  strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="min" name="Mín"      stroke="#ef4444" fill="none"      strokeWidth={1} opacity={0.4} dot={false} />
              <Brush dataKey="period" height={18} stroke="#334155" tickFormatter={fmt} />
              <Legend />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {hStats && (
        <SectionCard title="Humedad Relativa (HR)" subtitle={`${fmt(hStats.date_start)} → ${fmt(hStats.date_end)} · Completitud: ${hStats.completitud_pct}%`}>
          <StatsRow stats={hStats} color="#3b82f6" unit="%" />
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={hSeries} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} unit="%" domain={[0, 100]} />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
              <Area type="monotone" dataKey="max" name="Máx"      stroke="#3b82f6" fill="none"      strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg" name="Promedio" stroke="#3b82f6" fill="url(#hg)"  strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="min" name="Mín"      stroke="#3b82f6" fill="none"      strokeWidth={1} opacity={0.4} dot={false} />
              <Brush dataKey="period" height={18} stroke="#334155" tickFormatter={fmt} />
              <Legend />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ── Section B ─────────────────────────────────────────────────

// Tarjeta de parámetros para distribución Gaussiana
const GaussianCards = ({ gaussians, unit }) => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
    {gaussians.map((g, i) => (
      <div key={i} style={{ background: '#0f172a', borderRadius: 8, padding: '8px 12px' }}>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Gaussiana {i + 1}</div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>μ = <strong>{g.mu.toFixed(2)}{unit}</strong></div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>σ = <strong>{g.sigma.toFixed(2)}</strong></div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>w = <strong>{(g.w * 100).toFixed(1)}%</strong></div>
      </div>
    ))}
  </div>
)

// Tarjeta de parámetros para distribución Beta
const BetaCards = ({ betas }) => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
    {betas.map((b, i) => (
      <div key={i} style={{ background: '#0f172a', borderRadius: 8, padding: '8px 12px' }}>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Beta {i + 1}</div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>α = <strong>{b.alpha.toFixed(4)}</strong></div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>β = <strong>{b.beta.toFixed(4)}</strong></div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>Moda = <strong>{b.mode.toFixed(2)}%</strong></div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>Var = <strong>{b.variance.toFixed(4)}</strong></div>
        <div style={{ fontSize: 12, color: '#f1f5f9' }}>w = <strong>{(b.w * 100).toFixed(1)}%</strong></div>
      </div>
    ))}
  </div>
)

function SectionFDP({ stationId, dateFrom, dateTo }) {
  const [tStats, setTStats] = useState(null)
  const [hStats, setHStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const [t, h] = await Promise.all([
        measurementsApi.stats({ station_id: stationId, variable_code: 'TEMP', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.stats({ station_id: stationId, variable_code: 'HR',   date_from: dateFrom, date_to: dateTo }),
      ])
      setTStats(t); setHStats(h)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error)   return <Err msg={error} />

  return (
    <>
      {/* ── FDP Temperatura — Gaussianas ── */}
      {tStats && (
        <SectionCard
          title="FDP — Temperatura (Gaussianas)"
          subtitle={`R² = ${tStats.r2?.toFixed(4) ?? '—'} · N = ${tStats.n.toLocaleString()}`}
        >
          <GaussianCards gaussians={tStats.gaussians} unit="°C" />
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={tStats.fdp} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#94a3b8' }} unit="°C"
                interval={Math.ceil(tStats.fdp.length / 10)} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
              <Legend />
              <Area type="monotone" dataKey="freq"  name="FDP real"       stroke="#ef4444" fill="#ef444420" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="model" name="Modelo (Σ Gauss)" stroke="#f97316" fill="none"   strokeWidth={2} strokeDasharray="6 3" dot={false} />
              <ReferenceLine x={tStats.mean} stroke="#ef4444" strokeDasharray="4 2"
                label={{ value: 'μ', fontSize: 11, fill: '#ef4444' }} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {/* ── FDP Humedad Relativa — Beta ── */}
      {hStats && (
        <SectionCard
          title="FDP — Humedad Relativa (Beta)"
          subtitle={`R² = ${hStats.r2?.toFixed(4) ?? '—'} · N = ${hStats.n.toLocaleString()}`}
        >
          {/* Muestra parámetros Beta reales (α, β, moda, varianza, w) */}
          <BetaCards betas={hStats.betas ?? []} />
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={hStats.fdp} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#94a3b8' }} unit="%"
                interval={Math.ceil(hStats.fdp.length / 10)} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
              <Legend />
              <Area type="monotone" dataKey="freq"  name="FDP real"       stroke="#3b82f6" fill="#3b82f620" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="model" name="Modelo (Σ Beta)" stroke="#f97316" fill="none"    strokeWidth={2} strokeDasharray="6 3" dot={false} />
              {/* Línea de referencia en la moda de la primera Beta */}
              {hStats.betas?.[0] && (
                <ReferenceLine x={hStats.betas[0].mode} stroke="#3b82f6" strokeDasharray="4 2"
                  label={{ value: 'moda₁', fontSize: 11, fill: '#3b82f6' }} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ── Section C ─────────────────────────────────────────────────
function SectionIsolines({ stationId, dateFrom, dateTo }) {
  const [tHm,     setTHm]     = useState(null)
  const [hHm,     setHHm]     = useState(null)
  const [tMo,     setTMo]     = useState([])
  const [hMo,     setHMo]     = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const [th, hh, tm, hm] = await Promise.all([
        measurementsApi.heatmap({ station_id: stationId, variable_code: 'TEMP', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.heatmap({ station_id: stationId, variable_code: 'HR',   date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({  station_id: stationId, variable_code: 'TEMP', group_by: 'month', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({  station_id: stationId, variable_code: 'HR',   group_by: 'month', date_from: dateFrom, date_to: dateTo }),
      ])
      setTHm(th); setHHm(hh); setTMo(tm); setHMo(hm)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error)   return <Err msg={error} />

  const buildMatrix = (hm) => {
    if (!hm) return null
    const mat = Array.from({ length: 12 }, () => Array(24).fill(null))
    hm.matrix.forEach(({ mes, hora, avg }) => { mat[mes - 1][hora] = avg })
    return mat
  }

  const matT = buildMatrix(tHm)
  const matH = buildMatrix(hHm)

  const HeatTable = ({ mat, hm, type, unit }) => (
    <SectionCard title={`Mapa de calor — ${type === 'TEMP' ? 'Temperatura' : 'Humedad Relativa'} (mes × hora)`}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 10 }}>
          <thead>
            <tr>
              <th style={{ padding: '3px 8px', color: '#64748b', textAlign: 'left', fontWeight: 500 }}>Mes\Hr</th>
              {HOURS.map(h => <th key={h} style={{ padding: '2px 1px', color: '#64748b', minWidth: 28, fontWeight: 400 }}>{String(h).padStart(2,'0')}</th>)}
            </tr>
          </thead>
          <tbody>
            {MONTHS.map((m, mi) => (
              <tr key={m}>
                <td style={{ padding: '2px 8px', color: '#94a3b8', fontWeight: 600, whiteSpace: 'nowrap' }}>{m}</td>
                {HOURS.map(h => {
                  const v = mat[mi][h]
                  return (
                    <td key={h}
                      title={v != null ? `${m} ${String(h).padStart(2,'0')}:00 → ${v}${unit}` : 'Sin dato'}
                      style={{ background: heatColor(v, hm.min, hm.max, type), height: 22, borderRadius: 2 }}
                    />
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 11, color: '#64748b' }}>
        <span>{hm.min.toFixed(1)}{unit}</span>
        <div style={{ flex: 1, height: 8, borderRadius: 4, background: type === 'TEMP' ? 'linear-gradient(to right,#3b82f6,#facc15,#ef4444)' : 'linear-gradient(to right,#f0f9ff,#1d4ed8)' }} />
        <span>{hm.max.toFixed(1)}{unit}</span>
      </div>
    </SectionCard>
  )

  return (
    <>
      {matT && tHm && <HeatTable mat={matT} hm={tHm} type="TEMP" unit="°C" />}
      {matH && hHm && <HeatTable mat={matH} hm={hHm} type="HR"   unit="%"  />}

      {(tMo.length > 0 || hMo.length > 0) && (
        <SectionCard title="Variación anual promedio" subtitle="Promedios mensuales de T y HR">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart margin={{ top: 4, right: 40, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="period" allowDuplicatedCategory={false} tickFormatter={fmt} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis yAxisId="t" unit="°C" tick={{ fontSize: 10, fill: '#ef4444' }} />
              <YAxis yAxisId="h" orientation="right" unit="%" domain={[0,100]} tick={{ fontSize: 10, fill: '#3b82f6' }} />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
              <Legend />
              <Line yAxisId="t" data={tMo} type="monotone" dataKey="avg" name="T promedio (°C)" stroke="#ef4444" strokeWidth={2} dot={false} />
              <Line yAxisId="h" data={hMo} type="monotone" dataKey="avg" name="HR promedio (%)" stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ── Section D ─────────────────────────────────────────────────
function SectionCombined({ stationId, stationAlt, dateFrom, dateTo }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const r = await measurementsApi.combined({ station_id: stationId, altitude: stationAlt || 0, date_from: dateFrom, date_to: dateTo })
      setData(r)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, stationAlt, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error)   return <Err msg={error} />
  if (!data)   return null

  return (
    <>
      {data.density.length > 0 && (
        <SectionCard title="d.1) Distribución T × HR" subtitle={`Tiempo de humectación (T>10°C y HR>79%): ${data.humect_pct}%`}>
          <ResponsiveContainer width="100%" height={360}>
            <ScatterChart margin={{ top: 8, right: 16, left: -10, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="T"  name="Temperatura" unit="°C" type="number" tick={{ fontSize: 10, fill: '#94a3b8' }}
                label={{ value: 'T (°C)', position: 'insideBottom', offset: -8, fontSize: 11, fill: '#94a3b8' }} />
              <YAxis dataKey="HR" name="Humedad" unit="%" type="number" domain={[0,100]} tick={{ fontSize: 10, fill: '#94a3b8' }}
                label={{ value: 'HR (%)', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#94a3b8' }} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                formatter={(v, n) => [typeof v === 'number' ? v.toFixed(2) : v, n]} />
              <ReferenceLine x={10} stroke="#f97316" strokeDasharray="4 2" label={{ value: 'T=10°C', fontSize: 9, fill: '#f97316' }} />
              <ReferenceLine y={79} stroke="#f97316" strokeDasharray="4 2" label={{ value: 'HR=79%', fontSize: 9, fill: '#f97316', position: 'insideTopRight' }} />
              <Scatter data={data.density} name="Densidad" fill="#6366f1" fillOpacity={0.6} />
            </ScatterChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {data.habs_monthly.length > 0 && (
        <SectionCard title="d.2) Humedad Absoluta (H abs)" subtitle={`Altitud: ${stationAlt || 0} m s.n.m.`}>
          <div style={{ marginBottom: 10, fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>
            H_abs = (18000/29) × (HR/100 × P_sat) / (P_tot − HR/100 × P_sat)
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.habs_monthly} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="habsg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} unit=" g/kg" />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
              <Area type="monotone" dataKey="avg" name="H abs prom (g/kg)" stroke="#10b981" fill="url(#habsg)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {data.scatter.length > 0 && (
        <SectionCard title="d.3) Gráfico psicrométrico (T vs H abs)">
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="T"    name="T"     unit="°C"    type="number" tick={{ fontSize: 10, fill: '#94a3b8' }}
                label={{ value: 'T (°C)', position: 'insideBottom', offset: -8, fontSize: 11, fill: '#94a3b8' }} />
              <YAxis dataKey="habs" name="H abs" unit=" g/kg" type="number" tick={{ fontSize: 10, fill: '#94a3b8' }}
                label={{ value: 'H abs (g/kg)', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                formatter={(v, n) => [typeof v === 'number' ? v.toFixed(3) : v, n]} />
              <Scatter data={data.scatter} name="T vs H abs" fill="#10b981" fillOpacity={0.3} />
            </ScatterChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ── Página principal ──────────────────────────────────────────
export default function Analysis() {
  const [stations,   setStations]   = useState([])
  const [stationId,  setStationId]  = useState('')
  const [stationAlt, setStationAlt] = useState(0)
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  const [activeTab,  setActiveTab]  = useState('overview')
  const [queried,    setQueried]    = useState(false)

  useEffect(() => {
    stationsApi.getAll()
      .then(list => {
        setStations(list || [])
        if (list?.length) {
          setStationId(list[0].id)
          setStationAlt(parseFloat(list[0].altitude_meters) || 0)
        }
      }).catch(() => {})
  }, [])

  const handleStation = (id) => {
    setStationId(id)
    const s = stations.find(x => x.id === id)
    setStationAlt(parseFloat(s?.altitude_meters) || 0)
    setQueried(false)
  }

  return (
    <div style={{ padding: '2rem 2.5rem', maxWidth: 1200 }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '1.75rem', fontWeight: 800, color: '#f1f5f9' }}>Análisis meteorológico</h1>
        <p style={{ margin: 0, fontSize: '0.875rem', color: '#94a3b8' }}>Visualización, FDP, isolíneas y análisis combinado T×HR</p>
      </div>

      {/* Filtros */}
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '16px 20px', marginBottom: 24, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', marginBottom: 5 }}>Estación</label>
          <select value={stationId} onChange={e => handleStation(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', fontSize: 13 }}>
            <option value="">Seleccionar…</option>
            {stations.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', marginBottom: 5 }}>Altitud (m)</label>
          <input type="number" value={stationAlt} onChange={e => setStationAlt(parseFloat(e.target.value) || 0)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', fontSize: 13, width: 100 }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', marginBottom: 5 }}>Desde</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', marginBottom: 5 }}>Hasta</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', fontSize: 13 }} />
        </div>
        <button
          onClick={() => setQueried(true)}
          disabled={!stationId}
          style={{ padding: '8px 20px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 13, cursor: stationId ? 'pointer' : 'not-allowed', background: stationId ? '#22c55e' : '#334155', color: stationId ? '#000' : '#64748b' }}>
          Consultar
        </button>
      </div>

      {!queried ? (
        <div style={{ textAlign: 'center', padding: '4rem 0', color: '#94a3b8' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🌦️</div>
          <p>Seleccioná una estación y hacé clic en <strong>Consultar</strong> para comenzar el análisis.</p>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap', borderBottom: '1px solid #1e293b', paddingBottom: 0 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                padding: '10px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                background: 'none', border: 'none',
                color: activeTab === t.id ? '#22c55e' : '#94a3b8',
                borderBottom: `2px solid ${activeTab === t.id ? '#22c55e' : 'transparent'}`,
                marginBottom: -1,
              }}>
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && <SectionOverview stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'fdp'      && <SectionFDP      stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'isolines' && <SectionIsolines stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'combined' && <SectionCombined stationId={stationId} stationAlt={stationAlt} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
        </>
      )}
    </div>
  )
}