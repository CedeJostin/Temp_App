import { useState, useRef } from 'react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { localAnalysisApi } from '../services/api'
import { Loader2, AlertTriangle, FileText, FolderOpen, X } from 'lucide-react'

const SPIN = { animation: 'spin 0.8s linear infinite' }

const VARIABLES = [
  { key: 'temperatura', label: 'Temperatura',      unit: '°C',  color: '#ef4444' },
  { key: 'humedad',     label: 'Humedad Relativa', unit: '%',   color: '#3b82f6' },
  { key: 'viento',      label: 'Viento',           unit: 'm/s', color: '#22c55e' },
]

const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
const HORAS = Array.from({ length: 24 }, (_, i) => i)

// ── Colores ───────────────────────────────────────────────────
const lerp = (a, b, t) => Math.round(a + (b - a) * t)
const heatColor = (val, min, max, color) => {
  if (val == null) return '#161a21'
  const t  = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0
  const r2 = color === '#ef4444' ? [239,68,68] : color === '#3b82f6' ? [59,130,246] : [34,197,94]
  return `rgb(${lerp(15,r2[0],t)},${lerp(23,r2[1],t)},${lerp(42,r2[2],t)})`
}

const COMPLETITUD_COLOR = { green: '#22c55e', blue: '#3b82f6', yellow: '#f59e0b', orange: '#f97316', red: '#ef4444' }

// ── UI helpers ────────────────────────────────────────────────
const S = { background: '#161a21', border: '1px solid #272d37', borderRadius: 12, padding: 20, marginBottom: 16 }

const StatBox = ({ label, value, color }) => (
  <div style={{ background: '#0f1217', borderRadius: 8, padding: '8px 12px', textAlign: 'center', minWidth: 78 }}>
    <div style={{ fontSize: 14, fontWeight: 700, color: color || '#e7eaf0' }}>{value}</div>
    <div style={{ fontSize: 10, color: '#5b6577', marginTop: 2 }}>{label}</div>
  </div>
)

const QualityBadge = ({ ok, label, value, target }) => (
  <div style={{ background: ok ? '#22c55e15' : '#ef444415', border: `1px solid ${ok ? '#22c55e30' : '#ef444430'}`, borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
    <div style={{ color: ok ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{ok ? '✓' : '✗'} {label}</div>
    <div style={{ color: '#8b94a6', marginTop: 2 }}>{value} <span style={{ color: '#5b6577' }}>({target})</span></div>
  </div>
)

// ── Mapa de calor ─────────────────────────────────────────────
function HeatmapGrid({ heatmap, color, unit }) {
  if (!heatmap) return null
  const { matrix, eje_label, min, max } = heatmap
  const isHour = eje_label === 'hora'
  const ejeVals = isHour ? HORAS : Array.from({ length: 53 }, (_, i) => i + 1)
  const get = (m, e) => { const d = matrix.find(x => x.mes === m+1 && x[eje_label] === e); return d?.avg ?? null }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 10, minWidth: 580 }}>
        <thead>
          <tr>
            <th style={{ padding: '3px 8px', color: '#5b6577', textAlign: 'left' }}>
              Mes\{isHour ? 'Hora' : 'Semana'}
            </th>
            {ejeVals.filter((_, i) => isHour || i % 2 === 0).map(e => (
              <th key={e} style={{ padding: '2px 1px', color: '#5b6577', minWidth: isHour ? 28 : 20, fontWeight: 400 }}>
                {isHour ? String(e).padStart(2,'0') : e}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MESES.map((m, mi) => (
            <tr key={m}>
              <td style={{ padding: '2px 8px', color: '#8b94a6', fontWeight: 600 }}>{m}</td>
              {ejeVals.filter((_, i) => isHour || i % 2 === 0).map(e => {
                const v = get(mi, e)
                return <td key={e} style={{ background: heatColor(v, min, max, color), height: 20, borderRadius: 2 }}
                  title={v != null ? `${m} ${eje_label} ${e} → ${v}${unit}` : 'Sin dato'} />
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 11, color: '#5b6577' }}>
        <span>{min}{unit}</span>
        <div style={{ flex: 1, height: 8, borderRadius: 4, background: `linear-gradient(to right, #0f1217, ${color})` }} />
        <span>{max}{unit}</span>
      </div>
    </div>
  )
}

// ── Card de resultados ────────────────────────────────────────
function ResultCard({ variable, resultado }) {
  const [tab,      setTab]      = useState('serie')
  const [heatType, setHeatType] = useState('hour')
  const [mes,      setMes]      = useState('annual')

  const { stats, fdp, gaussians, betas, weibulls, r2, mse, quality,
          tipo_curva, serie, heatmap_hour, heatmap_week,
          daily_profile, annual_profile } = resultado

  const curvas   = gaussians?.length ? gaussians : betas?.length ? betas : weibulls || []
  const label    = tipo_curva === 'gaussiana' ? 'Gaussiana' : tipo_curva === 'beta' ? 'Beta' : 'Weibull'

  const TABS = [
    { id: 'serie',   label: 'a) Serie temporal'  },
    { id: 'fdp',     label: 'b) FDP + Modelo'     },
    { id: 'calor',   label: 'c.1) Mapa de calor'  },
    { id: 'diario',  label: 'c.2) Perfil diario'  },
    { id: 'anual',   label: 'c.3) Perfil anual'   },
    { id: 'tabla',   label: 'Tabla resumen'        },
  ]

  return (
    <div style={{ background: '#161a21', border: `1px solid ${variable.color}30`, borderTop: `3px solid ${variable.color}`, borderRadius: 12, marginBottom: 24 }}>

      {/* Header */}
      <div style={{ padding: '16px 20px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#e7eaf0' }}>{variable.label}</span>
          <span style={{ fontSize: 12, color: '#8b94a6', marginLeft: 10 }}>
            {stats.n.toLocaleString()} registros · {stats.fecha_inicio} → {stats.fecha_fin}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 11, padding: '2px 10px', borderRadius: 20, fontWeight: 600,
            background: `${COMPLETITUD_COLOR[stats.completitud_color]}20`,
            color: COMPLETITUD_COLOR[stats.completitud_color],
          }}>
            {stats.completitud_pct}% completo
          </span>
          {stats.anomalies_count > 0 && (
            <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 20, background: '#f59e0b20', color: '#f59e0b', fontWeight: 600 }}>
              ⚠️ {stats.anomalies_count} anomalías (±{stats.anomaly_threshold.toFixed(2)})
            </span>
          )}
        </div>
      </div>

      {/* Estadísticos */}
      <div style={{ padding: '12px 20px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {[
          { l: 'Media',  v: `${stats.mean}${variable.unit}`,  c: variable.color },
          { l: 'Desv.',  v: `${stats.std}${variable.unit}`  },
          { l: 'Mín',    v: `${stats.min}${variable.unit}`  },
          { l: 'Máx',    v: `${stats.max}${variable.unit}`  },
          { l: 'Moda',   v: `${stats.mode}${variable.unit}` },
          { l: 'Q25',    v: `${stats.q25}${variable.unit}`  },
          { l: 'Q50',    v: `${stats.q50}${variable.unit}`  },
          { l: 'Q75',    v: `${stats.q75}${variable.unit}`  },
        ].map(({ l, v, c }) => <StatBox key={l} label={l} value={v} color={c} />)}
      </div>

      {/* Tabs */}
      <div style={{ padding: '0 20px', borderTop: '1px solid #272d37', display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '9px 14px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            background: 'none', border: 'none',
            color: tab === t.id ? variable.color : '#8b94a6',
            borderBottom: `2px solid ${tab === t.id ? variable.color : 'transparent'}`,
          }}>{t.label}</button>
        ))}
      </div>

      {/* Contenido */}
      <div style={{ padding: '16px 20px' }}>

        {/* a) Serie temporal */}
        {tab === 'serie' && (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={serie} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id={`g-${variable.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={variable.color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={variable.color} stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="period" tick={{ fontSize: 9, fill: '#8b94a6' }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: '#8b94a6' }} unit={variable.unit} />
              <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <Legend />
              <Area type="monotone" dataKey="max" name="Máx"      stroke={variable.color} fill="none"                     strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg" name="Promedio" stroke={variable.color} fill={`url(#g-${variable.key})`} strokeWidth={2}              dot={false} />
              <Area type="monotone" dataKey="min" name="Mín"      stroke={variable.color} fill="none"                     strokeWidth={1} opacity={0.4} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}

        {/* b) FDP + Modelo */}
        {tab === 'fdp' && (
          <div>
            {/* Calidad del ajuste */}
            {quality && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                <QualityBadge ok={quality.r2_ok}          label="R²"      value={r2?.toFixed(4)}          target={quality.r2_target}      />
                <QualityBadge ok={quality.mse_ok}         label="EMC"     value={mse?.toExponential(2)}   target={quality.mse_target}     />
                <QualityBadge ok={quality.error_range_ok} label="Error"   value="ver gráfico"             target={quality.error_target}   />
                <QualityBadge ok={quality.weights_sum_ok} label="Σpesos"  value={quality.weights_sum}     target="=1.00 (±1%)"            />
              </div>
            )}

            {/* Parámetros de las curvas */}
            {curvas.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                {curvas.map((c, i) => (
                  <div key={i} style={{ background: '#0f1217', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                    <div style={{ fontSize: 11, color: '#5b6577', marginBottom: 4 }}>{label} {i+1}</div>
                    {tipo_curva === 'gaussiana' && <>
                      <div style={{ color: '#e7eaf0' }}>μ = <strong>{c.mu}{variable.unit}</strong></div>
                      <div style={{ color: '#e7eaf0' }}>σ = <strong>{c.sigma}</strong></div>
                      <div style={{ color: '#e7eaf0' }}>w = <strong>{(c.w*100).toFixed(1)}%</strong></div>
                    </>}
                    {tipo_curva === 'beta' && <>
                      <div style={{ color: '#e7eaf0' }}>Moda ≈ <strong>{c.mode}%</strong></div>
                      <div style={{ color: '#e7eaf0' }}>Var = <strong>{c.variance}</strong></div>
                      <div style={{ color: '#e7eaf0' }}>α={c.alpha} β={c.beta}</div>
                      <div style={{ color: '#e7eaf0' }}>w = <strong>{(c.w*100).toFixed(1)}%</strong></div>
                    </>}
                    {tipo_curva === 'weibull' && <>
                      <div style={{ color: '#e7eaf0' }}>λ = <strong>{c.lambda} m/s</strong></div>
                      <div style={{ color: '#e7eaf0' }}>k = <strong>{c.k}</strong></div>
                      <div style={{ color: '#e7eaf0' }}>vmax = <strong>{c.vmax} m/s</strong></div>
                      <div style={{ color: '#e7eaf0' }}>σ = <strong>{c.sigma}</strong></div>
                      <div style={{ color: '#e7eaf0' }}>w = <strong>{(c.w*100).toFixed(1)}%</strong></div>
                    </>}
                  </div>
                ))}
              </div>
            )}

            {/* Gráfico FDP */}
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={fdp} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
                <XAxis dataKey="x" tick={{ fontSize: 9, fill: '#8b94a6' }} unit={variable.unit}
                  interval={Math.ceil(fdp.length / 10)} />
                <YAxis tick={{ fontSize: 9, fill: '#8b94a6' }} />
                <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
                <Legend />
                <Area type="monotone" dataKey="freq"  name="FDP real"            stroke={variable.color} fill={`${variable.color}20`} strokeWidth={2} dot={false} />
                <Area type="monotone" dataKey="model" name={`Modelo (Σ ${label})`} stroke="#f97316"      fill="none"                   strokeWidth={2} strokeDasharray="5 3" dot={false} />
              </AreaChart>
            </ResponsiveContainer>

            {/* Gráfico de residuos */}
            <p style={{ fontSize: 12, color: '#5b6577', marginTop: 16, marginBottom: 6 }}>Residuos (error real vs modelo)</p>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={fdp} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
                <XAxis dataKey="x" tick={{ fontSize: 9, fill: '#8b94a6' }} unit={variable.unit} interval={Math.ceil(fdp.length / 10)} />
                <YAxis tick={{ fontSize: 9, fill: '#8b94a6' }} />
                <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 11 }} />
                <ReferenceLine y={0}    stroke="#272d37" />
                <ReferenceLine y={1e-3} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: '+1E-3', fontSize: 9, fill: '#f59e0b' }} />
                <ReferenceLine y={-1e-3} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: '-1E-3', fontSize: 9, fill: '#f59e0b' }} />
                <Area type="monotone" dataKey="error_range" name="Residuo" stroke="#a855f7" fill="#a855f720" strokeWidth={1.5} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* c.1) Mapa de calor */}
        {tab === 'calor' && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {[['hour','Mes × Hora'], ['week','Mes × Semana']].map(([v, l]) => (
                <button key={v} onClick={() => setHeatType(v)} style={{
                  padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, cursor: 'pointer',
                  background: heatType === v ? variable.color : '#272d37',
                  color:      heatType === v ? '#000' : '#8b94a6',
                }}>{l}</button>
              ))}
            </div>
            <HeatmapGrid heatmap={heatType === 'hour' ? heatmap_hour : heatmap_week} color={variable.color} unit={variable.unit} />
          </div>
        )}

        {/* c.2) Perfil diario */}
        {tab === 'diario' && daily_profile && (
          <div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              <button onClick={() => setMes('annual')} style={{
                padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 11, cursor: 'pointer',
                background: mes === 'annual' ? variable.color : '#272d37',
                color:      mes === 'annual' ? '#000' : '#8b94a6',
              }}>Anual</button>
              {MESES.map((m, i) => (
                <button key={i} onClick={() => setMes(String(i+1))} style={{
                  padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 11, cursor: 'pointer',
                  background: mes === String(i+1) ? variable.color : '#272d37',
                  color:      mes === String(i+1) ? '#000' : '#8b94a6',
                }}>{m}</button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#5b6577', marginBottom: 8 }}>
              {variable.key === 'humedad' ? 'Moda horaria de HR' : 'Media horaria de T'} — {mes === 'annual' ? 'todo el período' : MESES[parseInt(mes)-1]}
            </p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart
                data={mes === 'annual' ? daily_profile.annual : (daily_profile.monthly[mes] || [])}
                margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
                <XAxis dataKey="hora" tick={{ fontSize: 9, fill: '#8b94a6' }}
                  tickFormatter={h => `${String(h).padStart(2,'0')}:00`} />
                <YAxis tick={{ fontSize: 9, fill: '#8b94a6' }} unit={variable.unit} />
                <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={h => `${String(h).padStart(2,'0')}:00`} />
                <Legend />
                <Line type="monotone" dataKey="max"  name="Máx"      stroke={variable.color} strokeWidth={1} opacity={0.5} dot={false} />
                <Line type="monotone" dataKey="avg"  name="Promedio" stroke={variable.color} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="min"  name="Mín"      stroke={variable.color} strokeWidth={1} opacity={0.5} dot={false} />
                <Line type="monotone" dataKey="mode" name="Moda"     stroke="#f97316"        strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
                <Line type="monotone" dataKey="q25"  name="Q25"      stroke="#8b94a6"        strokeWidth={1} strokeDasharray="2 3" dot={false} />
                <Line type="monotone" dataKey="q75"  name="Q75"      stroke="#8b94a6"        strokeWidth={1} strokeDasharray="2 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* c.3) Perfil anual */}
        {tab === 'anual' && annual_profile && (
          <div>
            <p style={{ fontSize: 11, color: '#5b6577', marginBottom: 8 }}>
              {variable.key === 'humedad' ? 'Moda diaria de HR' : 'Media diaria de T'} a lo largo del año (día del año 1–365)
            </p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={annual_profile} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
                <XAxis dataKey="doy" tick={{ fontSize: 9, fill: '#8b94a6' }} label={{ value: 'Día del año', position: 'insideBottom', offset: -5, fontSize: 10, fill: '#5b6577' }} />
                <YAxis tick={{ fontSize: 9, fill: '#8b94a6' }} unit={variable.unit} />
                <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={d => `Día ${d}`} />
                <Legend />
                <Line type="monotone" dataKey="max" name="Máx"      stroke={variable.color} strokeWidth={1} opacity={0.4} dot={false} />
                <Line type="monotone" dataKey="avg" name="Promedio" stroke={variable.color} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="min" name="Mín"      stroke={variable.color} strokeWidth={1} opacity={0.4} dot={false} />
                <Line type="monotone" dataKey="q25" name="Q25"      stroke="#8b94a6"        strokeWidth={1} strokeDasharray="2 3" dot={false} />
                <Line type="monotone" dataKey="q75" name="Q75"      stroke="#8b94a6"        strokeWidth={1} strokeDasharray="2 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Tabla resumen */}
        {tab === 'tabla' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #272d37' }}>
                  {['Parámetro', 'Valor'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#5b6577', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['Período',          `${stats.fecha_inicio} → ${stats.fecha_fin}`],
                  ['N datos válidos',  stats.n.toLocaleString()],
                  ['Completitud',      `${stats.completitud_pct}%`],
                  ['Huecos >5 días',   stats.huecos.length],
                  ['Media',            `${stats.mean} ${variable.unit}`],
                  ['Desv. estándar',   `${stats.std} ${variable.unit}`],
                  ['Moda',             `${stats.mode} ${variable.unit}`],
                  ['Mínimo',           `${stats.min} ${variable.unit}`],
                  ['Máximo',           `${stats.max} ${variable.unit}`],
                  ['Q25',              `${stats.q25} ${variable.unit}`],
                  ['Q50 (mediana)',    `${stats.q50} ${variable.unit}`],
                  ['Q75',              `${stats.q75} ${variable.unit}`],
                  ['Anomalías (±3σ)',  `${stats.anomalies_count} valores`],
                  ['Umbral anomalía',  `±${stats.anomaly_threshold} ${variable.unit}`],
                  ['Tipo de modelo',   label],
                  ['N componentes',    curvas.length],
                  ['R²',              r2?.toFixed(4) ?? '—'],
                  ['EMC',             mse?.toExponential(2) ?? '—'],
                  ['Σ pesos',         quality?.weights_sum ?? '—'],
                  ['EMC ≤ 1E-5',      quality?.mse_ok ? '✓ Sí' : '✗ No'],
                  ['R² > 0.95',       quality?.r2_ok  ? '✓ Sí' : '✗ No'],
                  ['Error ±1E-3',     quality?.error_range_ok ? '✓ Sí' : '✗ No'],
                ].map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: '1px solid #161a21' }}>
                    <td style={{ padding: '7px 12px', color: '#8b94a6' }}>{k}</td>
                    <td style={{ padding: '7px 12px', color: '#e7eaf0', fontWeight: 500 }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Parámetros de curvas */}
            {curvas.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <p style={{ fontSize: 12, color: '#5b6577', marginBottom: 8, fontWeight: 600 }}>Parámetros por componente</p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #272d37' }}>
                      {tipo_curva === 'gaussiana' && ['Curva','μ','σ','w'].map(h => <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#5b6577' }}>{h}</th>)}
                      {tipo_curva === 'beta'      && ['Curva','α','β','Moda','Var','w'].map(h => <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#5b6577' }}>{h}</th>)}
                      {tipo_curva === 'weibull'   && ['Curva','λ','k','vmax','σ','w'].map(h => <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#5b6577' }}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {curvas.map((c, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #161a21' }}>
                        <td style={{ padding: '6px 10px', color: variable.color, fontWeight: 600 }}>{label} {i+1}</td>
                        {tipo_curva === 'gaussiana' && <>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.mu} {variable.unit}</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.sigma}</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{(c.w*100).toFixed(1)}%</td>
                        </>}
                        {tipo_curva === 'beta' && <>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.alpha}</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.beta}</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.mode}%</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.variance}</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{(c.w*100).toFixed(1)}%</td>
                        </>}
                        {tipo_curva === 'weibull' && <>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.lambda} m/s</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.k}</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.vmax} m/s</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{c.sigma}</td>
                          <td style={{ padding: '6px 10px', color: '#e7eaf0' }}>{(c.w*100).toFixed(1)}%</td>
                        </>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {stats.huecos.length > 0 && (
              <div style={{ marginTop: 14, background: '#f59e0b15', border: '1px solid #f59e0b30', borderRadius: 8, padding: '10px 14px' }}>
                <p style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, marginBottom: 6 }}>⚠️ Huecos continuos &gt;5 días detectados</p>
                {stats.huecos.map((h, i) => (
                  <p key={i} style={{ fontSize: 12, color: '#8b94a6' }}>{h.inicio} → {h.fin} ({h.horas} horas)</p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sección combinada T×HR ────────────────────────────────────
function CombinedCard({ combined }) {
  const [tab, setTab] = useState('density')
  if (!combined || combined.error) return (
    <div style={{ ...S, color: '#ef4444', fontSize: 13 }}>
      ⚠️ Combinado T×HR: {combined?.error || 'Sin datos'}
    </div>
  )

  const TABS = [
    { id: 'density', label: 'd.1) Densidad T×HR' },
    { id: 'habs',    label: 'd.2) Humedad absoluta' },
    { id: 'psych',   label: 'd.3) Psicrométrico' },
    { id: 'mobility',label: 'd) Movilidad flujo' },
  ]

  const maxCount = combined.density?.length ? Math.max(...combined.density.map(d => d.count)) : 1

  return (
    <div style={{ background: '#161a21', border: '1px solid #6366f130', borderTop: '3px solid #6366f1', borderRadius: 12, marginBottom: 24 }}>
      <div style={{ padding: '16px 20px 0' }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#e7eaf0' }}>Análisis combinado T × HR</span>
        <span style={{ fontSize: 12, color: '#8b94a6', marginLeft: 10 }}>
          {combined.total_paired?.toLocaleString()} pares · Humectación: {combined.humect_pct}%
        </span>
      </div>

      <div style={{ padding: '0 20px', borderTop: '1px solid #272d37', marginTop: 12, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '9px 14px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            background: 'none', border: 'none',
            color: tab === t.id ? '#6366f1' : '#8b94a6',
            borderBottom: `2px solid ${tab === t.id ? '#6366f1' : 'transparent'}`,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding: '16px 20px' }}>

        {tab === 'density' && (
          <div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {[['90','#22c55e'],['95','#f59e0b'],['99','#ef4444'],['out','#5b6577']].map(([c, col]) => (
                <span key={c} style={{ fontSize: 11, padding: '2px 8px', background: `${col}20`, color: col, borderRadius: 20 }}>
                  {c === 'out' ? 'Fuera 99%' : `≤${c}%`}
                </span>
              ))}
              <span style={{ fontSize: 11, padding: '2px 8px', background: '#f97316'+'20', color: '#f97316', borderRadius: 20 }}>
                Humectación (T&gt;10°C, HR&gt;79%): {combined.humect_pct}%
              </span>
            </div>
            <ResponsiveContainer width="100%" height={360}>
              <ScatterChart margin={{ top: 8, right: 16, left: -10, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
                <XAxis dataKey="T"  name="T"  unit="°C" type="number" tick={{ fontSize: 10, fill: '#8b94a6' }}
                  label={{ value: 'T (°C)', position: 'insideBottom', offset: -8, fontSize: 11, fill: '#8b94a6' }} />
                <YAxis dataKey="HR" name="HR" unit="%" type="number" domain={[0,100]} tick={{ fontSize: 10, fill: '#8b94a6' }}
                  label={{ value: 'HR (%)', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#8b94a6' }} />
                <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
                  formatter={(v,n) => [typeof v === 'number' ? v.toFixed(2) : v, n]} />
                <ReferenceLine x={10} stroke="#f97316" strokeDasharray="4 2" label={{ value: 'T=10°C', fontSize: 9, fill: '#f97316' }} />
                <ReferenceLine y={79} stroke="#f97316" strokeDasharray="4 2" label={{ value: 'HR=79%', fontSize: 9, fill: '#f97316', position: 'insideTopRight' }} />
                {['90','95','99','out'].map(c => (
                  <Scatter key={c} name={c === 'out' ? 'Fuera 99%' : `≤${c}%`}
                    data={combined.density.filter(d => d.contour === c)}
                    fill={c === '90' ? '#22c55e' : c === '95' ? '#f59e0b' : c === '99' ? '#ef4444' : '#5b6577'}
                    fillOpacity={0.6}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}

        {tab === 'habs' && (
          <div>
            <div style={{ marginBottom: 10, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
              H_abs = (18000/29) × (HR/100 × P_sat) / (P_tot − HR/100 × P_sat) &nbsp;·&nbsp; P_sat = f(T) &nbsp;·&nbsp; P_tot = f(altitud)
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={combined.habs_monthly} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="habsg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}   />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
                <XAxis dataKey="period" tick={{ fontSize: 10, fill: '#8b94a6' }} />
                <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit=" g/kg" />
                <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="avg" name="H abs prom (g/kg)" stroke="#10b981" fill="url(#habsg)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {tab === 'psych' && (
          <ResponsiveContainer width="100%" height={340}>
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="T"    name="T"     unit="°C"    type="number" tick={{ fontSize: 10, fill: '#8b94a6' }}
                label={{ value: 'T (°C)', position: 'insideBottom', offset: -8, fontSize: 11, fill: '#8b94a6' }} />
              <YAxis dataKey="habs" name="H abs" unit=" g/kg" type="number" tick={{ fontSize: 10, fill: '#8b94a6' }}
                label={{ value: 'H abs (g/kg)', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#8b94a6' }} />
              <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
                formatter={(v,n) => [typeof v === 'number' ? v.toFixed(3) : v, n]} />
              <Scatter data={combined.scatter} name="T vs H abs" fill="#10b981" fillOpacity={0.3} />
            </ScatterChart>
          </ResponsiveContainer>
        )}

        {tab === 'mobility' && combined.mobility && (
          <div>
            <p style={{ fontSize: 11, color: '#5b6577', marginBottom: 10 }}>
              Distribución horaria de T media y HR durante el año (promedio por mes y hora del día)
            </p>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
                <XAxis dataKey="hora" name="Hora" type="number" domain={[0,23]} tick={{ fontSize: 10, fill: '#8b94a6' }}
                  label={{ value: 'Hora del día', position: 'insideBottom', offset: -8, fontSize: 11, fill: '#8b94a6' }} />
                <YAxis dataKey="T_avg" name="T media" unit="°C" tick={{ fontSize: 10, fill: '#8b94a6' }} />
                <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
                  formatter={(v,n) => [typeof v === 'number' ? v.toFixed(2) : v, n]} />
                <Scatter data={combined.mobility} name="Movilidad T" fill="#ef4444" fillOpacity={0.5} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Drop zone ─────────────────────────────────────────────────
function DropZone({ variable, archivo, onFile, onQuitar }) {
  const ref  = useRef()
  const [drag, setDrag] = useState(false)
  return (
    <div style={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#e7eaf0' }}>{variable.label}</span>
        {archivo && <span style={{ background: '#22c55e20', color: '#22c55e', borderRadius: 20, padding: '2px 8px', fontSize: 11 }}>Listo</span>}
      </div>
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
        onClick={() => !archivo && ref.current.click()}
        style={{
          border: `2px dashed ${drag ? variable.color : archivo ? '#22c55e' : '#272d37'}`,
          borderRadius: 8, padding: '10px 14px', cursor: archivo ? 'default' : 'pointer',
          background: drag ? `${variable.color}10` : 'transparent', transition: 'all 0.15s',
        }}
      >
        <input ref={ref} type="file" accept=".csv,.xlsx" style={{ display: 'none' }}
          onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
        {archivo ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#e7eaf0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <FileText size={15} style={{ color: '#8b94a6' }} /> {archivo.name} <span style={{ color: '#5b6577', fontSize: 11 }}>({(archivo.size/1024).toFixed(1)} KB)</span>
            </span>
            <button onClick={e => { e.stopPropagation(); onQuitar() }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5b6577', display: 'inline-flex' }} aria-label="Quitar"><X size={16} /></button>
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: '#5b6577', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <FolderOpen size={15} /> Arrastrá o <span style={{ color: variable.color }}>seleccioná</span> el archivo CSV / Excel
          </div>
        )}
      </div>
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────
export default function Measurements() {
  const [archivos,     setArchivos]     = useState({ temperatura: null, humedad: null, viento: null })
  const [nComponents,  setNComponents]  = useState(2)
  const [procesando,   setProcesando]   = useState({})
  const [resultados,   setResultados]   = useState({})
  const [combined,     setCombined]     = useState(null)
  const [errores,      setErrores]      = useState({})
  const [errorGlobal,  setErrorGlobal]  = useState('')

  const handleFile   = (key, file) => { setArchivos(p => ({...p, [key]: file})); setResultados(p => ({...p, [key]: null})); setErrores(p => ({...p, [key]: ''})); setCombined(null) }
  const handleQuitar = (key)       => { setArchivos(p => ({...p, [key]: null})); setResultados(p => ({...p, [key]: null})); setErrores(p => ({...p, [key]: ''})); setCombined(null) }

  const hayArchivos    = Object.values(archivos).some(Boolean)
  const algoProcesando = Object.values(procesando).some(Boolean)

  const handleAnalizar = async () => {
    setErrorGlobal('')
    setCombined(null)

    // Procesar cada variable individualmente (en paralelo)
    const promises = VARIABLES.filter(v => archivos[v.key]).map(async (v) => {
      setProcesando(p => ({...p, [v.key]: true}))
      setErrores(p => ({...p, [v.key]: ''}))
      try {
        const res = await localAnalysisApi.analyzeFile(archivos[v.key], v.key, nComponents)
        setResultados(p => ({...p, [v.key]: res}))
      } catch (e) {
        setErrores(p => ({...p, [v.key]: e.message}))
      } finally {
        setProcesando(p => ({...p, [v.key]: false}))
      }
    })

    await Promise.all(promises)

    // Si hay T y HR, calcular combinado
    if (archivos.temperatura && archivos.humedad) {
      try {
        const res = await localAnalysisApi.analyzeMulti(archivos, nComponents)
        if (res.combined) setCombined(res.combined)
      } catch (e) {
        setErrorGlobal(`Error en análisis combinado: ${e.message}`)
      }
    }
  }

  return (
    <div style={{ padding: '2rem 2.5rem', maxWidth: 1300 }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '1.75rem', fontWeight: 800, color: '#e7eaf0' }}>Mediciones</h1>
        <p style={{ margin: 0, fontSize: '0.875rem', color: '#8b94a6' }}>
          Análisis completo desde archivos CSV — Gaussianas, Beta, Weibull, perfiles diario/anual, mapas de calor · Sin guardar en BD
        </p>
      </div>

      {/* Panel de carga */}
      <div style={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 16 }}>
          {VARIABLES.map(v => (
            <DropZone key={v.key} variable={v} archivo={archivos[v.key]}
              onFile={f  => handleFile(v.key, f)}
              onQuitar={() => handleQuitar(v.key)} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 11, color: '#5b6577', display: 'block', marginBottom: 4 }}>N° de componentes para el ajuste</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {[2, 3, 4].map(n => (
                <button key={n} onClick={() => setNComponents(n)} style={{
                  padding: '4px 12px', borderRadius: 6, border: 'none', fontSize: 12, cursor: 'pointer',
                  background: nComponents === n ? '#6366f1' : '#272d37',
                  color:      nComponents === n ? '#fff'    : '#8b94a6',
                }}>{n}</button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#353d4a' }}>
            Con T + HR se calcula automáticamente el análisis combinado T×HR
          </div>
        </div>

        {errorGlobal && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#ef444415', border: '1px solid #ef444430', borderRadius: 6, fontSize: 13, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} /> {errorGlobal}
          </div>
        )}

        <button
          onClick={handleAnalizar}
          disabled={!hayArchivos || algoProcesando}
          style={{
            width: '100%', padding: 10, borderRadius: 8, border: 'none',
            fontWeight: 600, fontSize: 13,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            cursor: hayArchivos && !algoProcesando ? 'pointer' : 'not-allowed',
            background: hayArchivos && !algoProcesando ? 'var(--accent)' : '#272d37',
            color:      hayArchivos && !algoProcesando ? 'var(--accent-fg)' : '#5b6577',
          }}
        >
          {algoProcesando
            ? <><Loader2 size={15} style={SPIN} /> Procesando en el backend (puede tardar con datos grandes)…</>
            : 'Analizar archivos'}
        </button>
      </div>

      {/* Resultados por variable */}
      {VARIABLES.map(v => {
        const res  = resultados[v.key]
        const err  = errores[v.key]
        const proc = procesando[v.key]
        if (proc) return (
          <div key={v.key} style={{ ...S, textAlign: 'center', color: '#8b94a6', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Loader2 size={15} style={SPIN} /> Calculando {v.label} — ajustando {nComponents} curvas {v.key === 'temperatura' ? 'Gaussianas' : v.key === 'humedad' ? 'Beta' : 'Weibull'}…
          </div>
        )
        if (err) return (
          <div key={v.key} style={{ ...S, color: '#ef4444', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} /> <span><strong>{v.label}:</strong> {err}</span>
          </div>
        )
        if (!res) return null
        return <ResultCard key={v.key} variable={v} resultado={res} />
      })}

      {/* Análisis combinado T×HR */}
      {combined && <CombinedCard combined={combined} />}
    </div>
  )
}