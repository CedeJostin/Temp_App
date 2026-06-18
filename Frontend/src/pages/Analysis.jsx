import { useState, useEffect, useCallback, useRef } from 'react'
import * as d3 from 'd3'
import {
  AreaChart, Area, BarChart, Bar, ScatterChart, Scatter,
  LineChart, Line, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine, Cell, Brush,
} from 'recharts'
import { stationsApi, measurementsApi } from '../services/api'
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react'

const SPIN = { animation: 'spin 0.8s linear infinite' }

const MONTHS     = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
const MONTHS_NUM = [1,2,3,4,5,6,7,8,9,10,11,12]
const HOURS      = Array.from({ length: 24 }, (_, i) => i)

const TABS = [
  { id: 'overview',       label: 'a) Visualización general'   },
  { id: 'fdp',            label: 'b) FDP'                     },
  { id: 'summary-table',  label: 'b.1) Tabla resumen'         },
  { id: 'isolines',       label: 'c.1) Mapa de calor'         },
  { id: 'daily-profile',  label: 'c.2) Perfil diario'         },
  { id: 'annual-profile', label: 'c.3) Perfil anual'          },
  { id: 'combined',       label: 'd) T × HR combinado'        },
]

const fmt = (s) => {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d) ? s : d.toLocaleDateString('es-CR')
}
const fmtDoy = (doy) => {
  const d = new Date(2000, 0, doy)
  return d.toLocaleDateString('es-CR', { day: '2-digit', month: 'short' })
}

// ── Colores de completitud según instructivo ──────────────────
const COMPLETITUD_COLORS = {
  green:  { bg: '#22c55e20', border: '#22c55e40', text: '#22c55e', label: '≥ 98%' },
  blue:   { bg: '#3b82f620', border: '#3b82f640', text: '#3b82f6', label: '95–98%' },
  yellow: { bg: '#eab30820', border: '#eab30840', text: '#eab308', label: '90–95%' },
  orange: { bg: '#f9731620', border: '#f9731640', text: '#f97316', label: '85–90%' },
  red:    { bg: '#ef444420', border: '#ef444440', text: '#ef4444', label: '< 85%' },
}

// ── Paleta FDP igual al Excel ─────────────────────────────────
const GAUSS_COLORS = [
  '#f97316',
  '#22c55e',
  '#a78bfa',
  '#facc15',
]
const BETA_COLORS = [
  '#8b94a6',
  '#eab308',
  '#38bdf8',
  '#4ade80',
  '#c084fc',
]
const FDP_SUMA_COLOR  = '#e2e8f0'
const FDP_FREC_COLOR  = '#ef4444'

// ── UI helpers ────────────────────────────────────────────────
const Card = ({ children, style = {} }) => (
  <div style={{
    background: '#161a21', border: '1px solid #272d37',
    borderRadius: 12, padding: '20px', marginBottom: 20, ...style
  }}>
    {children}
  </div>
)

const Spinner = () => (
  <div style={{ padding: '3rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8b94a6', fontSize: 14 }}>
    <Loader2 size={16} style={SPIN} /> Cargando datos…
  </div>
)

const Err = ({ msg }) => (
  <div style={{ padding: '12px 16px', background: '#ef444420', border: '1px solid #ef444440', borderRadius: 8, color: '#ef4444', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
    <AlertTriangle size={16} style={{ flexShrink: 0 }} /> {msg}
  </div>
)

const StatBox = ({ label, value, unit, color }) => (
  <div style={{ background: '#0f1217', borderRadius: 8, padding: '10px 14px', textAlign: 'center', minWidth: 80 }}>
    <div style={{ fontSize: 16, fontWeight: 700, color: color || '#e7eaf0' }}>
      {typeof value === 'number' ? value.toFixed(2) : value}
      {unit && <span style={{ fontSize: 11, fontWeight: 400, color: '#8b94a6', marginLeft: 2 }}>{unit}</span>}
    </div>
    <div style={{ fontSize: 10, color: '#5b6577', marginTop: 2 }}>{label}</div>
  </div>
)

const SectionCard = ({ title, subtitle, children, badge }) => (
  <Card>
    <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#e7eaf0' }}>{title}</h3>
        {subtitle && <div style={{ margin: '4px 0 0', fontSize: 12, color: '#8b94a6' }}>{subtitle}</div>}
      </div>
      {badge}
    </div>
    {children}
  </Card>
)

const CompletitudBadge = ({ pct, color }) => {
  const c = COMPLETITUD_COLORS[color] || COMPLETITUD_COLORS.red
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, borderRadius: 20,
      padding: '2px 10px',
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {pct}% completitud
    </span>
  )
}

const QualityBadge = ({ quality }) => {
  if (!quality) return null
  const items = [
    { label: `EMC ${quality.mse_target}`,    ok: quality.mse_ok         },
    { label: `R² ${quality.r2_target}`,      ok: quality.r2_ok          },
    { label: `Err ${quality.error_target}`,  ok: quality.error_range_ok },
    { label: `Σw = ${quality.weights_sum?.toFixed(3)}`, ok: quality.weights_sum_ok },
  ]
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(({ label, ok }) => (
        <span key={label} style={{
          fontSize: 10, fontWeight: 600, borderRadius: 20,
          padding: '2px 8px',
          background: ok ? '#22c55e20' : '#ef444420',
          color:      ok ? '#22c55e'   : '#ef4444',
          border: `1px solid ${ok ? '#22c55e40' : '#ef444440'}`,
        }}>
          {ok ? '✓' : '✗'} {label}
        </span>
      ))}
    </div>
  )
}

// ── Mapa de calor ─────────────────────────────────────────────
const lerp = (a, b, t) => Math.round(a + (b - a) * t)

const heatColor = (val, min, max, type) => {
  if (val == null) return '#161a21'
  const t = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0
  if (type === 'TEMP') {
    const r = t < 0.5 ? lerp(59, 250, t*2)  : lerp(250, 220, (t-0.5)*2)
    const g = t < 0.5 ? lerp(130, 204, t*2) : lerp(204, 38,  (t-0.5)*2)
    const b = t < 0.5 ? lerp(246, 20, t*2)  : lerp(20, 38,   (t-0.5)*2)
    return `rgb(${r},${g},${b})`
  }
  const r = lerp(240, 30, t), g = lerp(249, 64, t), bl = lerp(255, 175, t)
  return `rgb(${r},${g},${bl})`
}

// ══════════════════════════════════════════════════════════════
// KDE HEATMAP SVG con D3
// ══════════════════════════════════════════════════════════════
function KDEHeatmapSVG({ densityPoints, tMin, tMax, hrMin, hrMax, width, height }) {
  const svgRef = useRef(null)

  useEffect(() => {
    if (!svgRef.current || !densityPoints?.length) return

    const pad = { top: 20, right: 110, bottom: 50, left: 60 }
    const pw = width  - pad.left - pad.right
    const ph = height - pad.top  - pad.bottom

    const xScale = d3.scaleLinear().domain([tMin, tMax]).range([0, pw])
    const yScale = d3.scaleLinear().domain([hrMin, hrMax]).range([ph, 0])

    const contours = d3.contourDensity()
      .x(d => xScale(d.T))
      .y(d => yScale(d.HR))
      .size([pw, ph])
      .bandwidth(18)
      .thresholds(24)(densityPoints)

    const maxDensity = d3.max(contours, d => d.value) || 1
    const colorScale = d3.scaleSequential(d3.interpolateViridis).domain([0, maxDensity])

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const defs = svg.append('defs')

    defs.append('clipPath')
      .attr('id', 'kde-plot-clip')
      .append('rect')
      .attr('width', pw)
      .attr('height', ph)

    const cbGrad = defs.append('linearGradient')
      .attr('id', 'kde-cb-grad')
      .attr('x1', '0%').attr('x2', '0%')
      .attr('y1', '0%').attr('y2', '100%')
    d3.range(11).forEach(i => {
      cbGrad.append('stop')
        .attr('offset', `${i * 10}%`)
        .attr('stop-color', d3.interpolateViridis(1 - i / 10))
    })

    const g = svg.append('g')
      .attr('transform', `translate(${pad.left},${pad.top})`)

    g.append('rect')
      .attr('width', pw).attr('height', ph)
      .attr('fill', '#0a0a1a')

    g.append('g')
      .attr('clip-path', 'url(#kde-plot-clip)')
      .selectAll('path')
      .data(contours)
      .join('path')
      .attr('d', d3.geoPath())
      .attr('fill', d => colorScale(d.value))
      .attr('stroke', 'none')
      .attr('opacity', 1)

    g.append('g')
      .attr('clip-path', 'url(#kde-plot-clip)')
      .selectAll('path')
      .data(contours.filter((_, i) => i % 3 === 0))
      .join('path')
      .attr('d', d3.geoPath())
      .attr('fill', 'none')
      .attr('stroke', d => colorScale(d.value * 1.5 > maxDensity ? maxDensity : d.value * 1.5))
      .attr('stroke-width', 0.6)
      .attr('opacity', 0.7)

    const y79 = yScale(79)
    if (y79 >= 0 && y79 <= ph) {
      g.append('line')
        .attr('x1', 0).attr('x2', pw)
        .attr('y1', y79).attr('y2', y79)
        .attr('stroke', '#f97316')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '8,4')
      g.append('text')
        .attr('x', pw - 4).attr('y', y79 - 5)
        .attr('fill', '#f97316')
        .attr('font-size', 11)
        .attr('text-anchor', 'end')
        .text('HR=79%')
    }

    const x10 = xScale(10)
    if (x10 >= 0 && x10 <= pw) {
      g.append('line')
        .attr('x1', x10).attr('x2', x10)
        .attr('y1', 0).attr('y2', ph)
        .attr('stroke', '#f97316')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '8,4')
      g.append('text')
        .attr('x', x10 + 3).attr('y', 14)
        .attr('fill', '#f97316')
        .attr('font-size', 11)
        .text('T=10°C')
    }

    g.append('g')
      .attr('transform', `translate(0,${ph})`)
      .call(
        d3.axisBottom(xScale)
          .ticks((tMax - tMin) / 2.5)
          .tickSize(-ph)
          .tickFormat('')
      )
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('line')
        .attr('stroke', '#272d37')
        .attr('stroke-dasharray', '2,4')
        .attr('opacity', 0.6)
      )

    g.append('g')
      .call(
        d3.axisLeft(yScale)
          .ticks(6)
          .tickSize(-pw)
          .tickFormat('')
      )
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('line')
        .attr('stroke', '#272d37')
        .attr('stroke-dasharray', '2,4')
        .attr('opacity', 0.6)
      )

    g.append('g')
      .attr('transform', `translate(0,${ph})`)
      .call(
        d3.axisBottom(xScale)
          .ticks((tMax - tMin) / 2.5)
          .tickFormat(d => d.toFixed(1))
      )
      .call(ax => ax.select('.domain').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick text')
        .attr('fill', '#8b94a6')
        .attr('font-size', 11)
        .attr('font-family', 'monospace')
      )

    g.append('text')
      .attr('x', pw / 2).attr('y', ph + 42)
      .attr('fill', '#c3cad6')
      .attr('font-size', 13)
      .attr('text-anchor', 'middle')
      .text('Temperatura (°C)')

    g.append('g')
      .call(
        d3.axisLeft(yScale)
          .tickValues([0, 20, 40, 60, 80, 100].filter(v => v >= hrMin && v <= hrMax))
          .tickFormat(d => d.toFixed(0))
      )
      .call(ax => ax.select('.domain').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick text')
        .attr('fill', '#8b94a6')
        .attr('font-size', 11)
        .attr('font-family', 'monospace')
      )

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -ph / 2).attr('y', -46)
      .attr('fill', '#c3cad6')
      .attr('font-size', 13)
      .attr('text-anchor', 'middle')
      .text('HR (%)')

    g.append('rect')
      .attr('width', pw).attr('height', ph)
      .attr('fill', 'none')
      .attr('stroke', '#353d4a')
      .attr('stroke-width', 0.8)

    const cbX = pw + 14
    const cbW = 16

    g.append('rect')
      .attr('x', cbX).attr('y', 0)
      .attr('width', cbW).attr('height', ph)
      .attr('fill', 'url(#kde-cb-grad)')
      .attr('stroke', '#353d4a')
      .attr('stroke-width', 0.5)

    const cbTickValues = d3.range(5).map(i => (i / 4) * maxDensity)
    cbTickValues.forEach(v => {
      const cy = ph - (v / maxDensity) * ph
      g.append('line')
        .attr('x1', cbX + cbW).attr('x2', cbX + cbW + 4)
        .attr('y1', cy).attr('y2', cy)
        .attr('stroke', '#8b94a6')
        .attr('stroke-width', 0.5)
      g.append('text')
        .attr('x', cbX + cbW + 7).attr('y', cy + 3)
        .attr('fill', '#8b94a6')
        .attr('font-size', 10)
        .attr('font-family', 'monospace')
        .text(v.toFixed(4))
    })

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -ph / 2)
      .attr('y', cbX + cbW + 44)
      .attr('fill', '#c3cad6')
      .attr('font-size', 11)
      .attr('text-anchor', 'middle')
      .text('f(HR;T)')

  }, [densityPoints, tMin, tMax, hrMin, hrMax, width, height])

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      style={{ display: 'block', width: '100%', borderRadius: 8 }}
    />
  )
}

// ══════════════════════════════════════════════════════════════
// FDP ENRICHMENT
// ══════════════════════════════════════════════════════════════
function prepareFDPGaussian(fdp, gaussians, paso = 0.1) {
  if (!fdp?.length) return []

  const hasBackendComponents = fdp[0] && 'gauss1' in fdp[0]

  if (hasBackendComponents) {
    return fdp.map(point => {
      const enriched = { ...point }
      enriched.sumaGauss = point.model != null ? parseFloat(point.model.toFixed(7)) : 0
      if (gaussians?.length) {
        gaussians.forEach((_, i) => {
          const key = `gauss${i + 1}`
          enriched[key] = point[key] != null ? parseFloat(point[key].toFixed(7)) : 0
        })
      }
      return enriched
    })
  }

  return fdp.map(point => {
    const enriched = { ...point }
    enriched.sumaGauss = point.model != null ? parseFloat(point.model.toFixed(7)) : 0
    if (gaussians?.length) {
      gaussians.forEach((g, i) => {
        const exponent = -0.5 * ((point.x - g.mu) / g.sigma) ** 2
        const pdf = Math.exp(exponent) / (g.sigma * Math.sqrt(2 * Math.PI))
        enriched[`gauss${i + 1}`] = parseFloat((g.w * pdf * paso).toFixed(7))
      })
    }
    return enriched
  })
}

function prepareFDPBeta(fdp, betas) {
  if (!fdp?.length) return []

  const hasBackendComponents = fdp[0] && 'beta1' in fdp[0]

  if (hasBackendComponents) {
    return fdp.map(point => {
      const enriched = { ...point }
      enriched.sumaGauss = point.model != null ? parseFloat(point.model.toFixed(7)) : 0
      if (betas?.length) {
        betas.forEach((_, i) => {
          const key = `beta${i + 1}`
          enriched[key] = point[key] != null ? parseFloat(point[key].toFixed(7)) : 0
        })
      }
      return enriched
    })
  }

  return fdp.map(point => {
    const enriched = { ...point }
    enriched.sumaGauss = point.model != null ? parseFloat(point.model.toFixed(7)) : 0
    if (betas?.length) {
      betas.forEach((b, i) => {
        const A = b.A ?? 0
        const B = b.B ?? 100
        const width = B - A
        if (width <= 0) { enriched[`beta${i + 1}`] = 0; return }
        const x01 = (point.x - A) / width
        if (x01 <= 0 || x01 >= 1) { enriched[`beta${i + 1}`] = 0; return }
        const val = _betaGenPDFjs(point.x, b.alpha, b.beta, A, B, b.w, 1.0)
        enriched[`beta${i + 1}`] = parseFloat(val.toFixed(7))
      })
    }
    return enriched
  })
}

function _logGammaJS(z) {
  if (z <= 0) return Infinity
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - _logGammaJS(1 - z)
  z -= 1
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  let x = c[0]
  for (let i = 1; i < 9; i++) x += c[i] / (z + i)
  const t = z + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

function _betaStdPDFjs(x01, alpha, beta) {
  const EPS = 1e-12
  if (x01 <= 0 || x01 >= 1) return 0
  const xc = Math.max(EPS, Math.min(1 - EPS, x01))
  const logB = _logGammaJS(alpha) + _logGammaJS(beta) - _logGammaJS(alpha + beta)
  const logPdf = (alpha - 1) * Math.log(xc) + (beta - 1) * Math.log(1 - xc) - logB
  const val = Math.exp(logPdf)
  return isFinite(val) ? val : 0
}

function _betaGenPDFjs(xPct, alpha, beta_param, A, B, w, paso) {
  const width = B - A
  if (width <= 0) return 0
  const x01 = (xPct - A) / width
  if (x01 <= 0 || x01 >= 1) return 0
  const pdf = _betaStdPDFjs(x01, alpha, beta_param) / width
  return isFinite(pdf) ? w * pdf * paso : 0
}

// ══════════════════════════════════════════════════════════════
// SECTION A — Visualización general
// ══════════════════════════════════════════════════════════════
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
        { l: 'Media', v: stats.mean },
        { l: 'Desv.',  v: stats.std  },
        { l: 'Mín',   v: stats.min  },
        { l: 'Máx',   v: stats.max  },
        { l: 'Q25',   v: stats.q25  },
        { l: 'Q50',   v: stats.q50  },
        { l: 'Q75',   v: stats.q75  },
        { l: 'Moda',  v: stats.mode },
        { l: 'N',     v: stats.n    },
      ].map(({ l, v }) => <StatBox key={l} label={l} value={v} unit={l === 'N' ? '' : unit} color={color} />)}
    </div>
  )

  const DateRange = ({ stats }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: '#8b94a6' }}>
        {fmt(stats.date_start)} → {fmt(stats.date_end)}
      </span>
      <CompletitudBadge pct={stats.completitud_pct} color={stats.completitud_color} />
    </div>
  )

  return (
    <>
      {tStats && (
        <SectionCard
          title="Temperatura (T)"
          subtitle={<DateRange stats={tStats} />}
        >
          <StatsRow stats={tStats} color="#ef4444" unit="°C" />
          {tStats.anomalies_count > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f59e0b20', border: '1px solid #f59e0b40', borderRadius: 6, fontSize: 12, color: '#f59e0b' }}>
              ⚠️ {tStats.anomalies_count} valores anómalos detectados (|v − μ| &gt; 3σ = ±{tStats.anomaly_threshold?.toFixed(2)}°C) — revisar si deben descartarse
              {tStats.anomaly_values?.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: '#fbbf24' }}>
                  Valores: {tStats.anomaly_values.slice(0, 10).map(v => `${v}°C`).join(', ')}{tStats.anomaly_values.length > 10 ? ' …' : ''}
                </div>
              )}
            </div>
          )}
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={tSeries} margin={{ top: 8, right: 50, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#8b94a6' }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="°C" width={48} label={{ value: 'T (°C)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#5b6577' }} />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <ReferenceLine y={tStats.mean} stroke="#ef4444" strokeDasharray="4 2" label={{ value: `μ=${tStats.mean?.toFixed(1)}°C`, fontSize: 10, fill: '#ef4444', position: 'right' }} />
              <ReferenceLine y={tStats.q25} stroke="#f97316" strokeDasharray="2 4" label={{ value: 'Q25', fontSize: 9, fill: '#f97316', position: 'right' }} />
              <ReferenceLine y={tStats.q75} stroke="#f97316" strokeDasharray="2 4" label={{ value: 'Q75', fontSize: 9, fill: '#f97316', position: 'right' }} />
              <Area type="monotone" dataKey="max"   name="Máx"      stroke="#ef4444" fill="none"     strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg"   name="Promedio" stroke="#ef4444" fill="url(#tg)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="min"   name="Mín"      stroke="#ef4444" fill="none"     strokeWidth={1} opacity={0.4} dot={false} />
              <Legend verticalAlign="top" height={28} />
              <Brush dataKey="period" height={28} stroke="#272d37" fill="#0f1217" tickFormatter={fmt} travellerWidth={10} gap={5} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {hStats && (
        <SectionCard
          title="Humedad Relativa (HR)"
          subtitle={<DateRange stats={hStats} />}
        >
          <StatsRow stats={hStats} color="#3b82f6" unit="%" />
          {hStats.anomalies_count > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f59e0b20', border: '1px solid #f59e0b40', borderRadius: 6, fontSize: 12, color: '#f59e0b' }}>
              ⚠️ {hStats.anomalies_count} valores anómalos detectados (|v − μ| &gt; 3σ = ±{hStats.anomaly_threshold?.toFixed(2)}%)
              {hStats.anomaly_values?.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: '#fbbf24' }}>
                  Valores: {hStats.anomaly_values.slice(0, 10).map(v => `${v}%`).join(', ')}{hStats.anomaly_values.length > 10 ? ' …' : ''}
                </div>
              )}
            </div>
          )}
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={hSeries} margin={{ top: 8, right: 50, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#8b94a6' }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="%" domain={[0, 100]} width={48} label={{ value: 'HR (%)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#5b6577' }} />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <ReferenceLine y={hStats.mean} stroke="#3b82f6" strokeDasharray="4 2" label={{ value: `μ=${hStats.mean?.toFixed(1)}%`, fontSize: 10, fill: '#3b82f6', position: 'right' }} />
              <ReferenceLine y={hStats.q25} stroke="#6366f1" strokeDasharray="2 4" label={{ value: 'Q25', fontSize: 9, fill: '#6366f1', position: 'right' }} />
              <ReferenceLine y={hStats.q75} stroke="#6366f1" strokeDasharray="2 4" label={{ value: 'Q75', fontSize: 9, fill: '#6366f1', position: 'right' }} />
              <Area type="monotone" dataKey="max"   name="Máx"      stroke="#3b82f6" fill="none"     strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg"   name="Promedio" stroke="#3b82f6" fill="url(#hg)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="min"   name="Mín"      stroke="#3b82f6" fill="none"     strokeWidth={1} opacity={0.4} dot={false} />
              <Legend verticalAlign="top" height={28} />
              <Brush dataKey="period" height={28} stroke="#272d37" fill="#0f1217" tickFormatter={fmt} travellerWidth={10} gap={5} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// SECTION B — FDP
// ══════════════════════════════════════════════════════════════

const GaussianCards = ({ gaussians, unit }) => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
    {gaussians.map((g, i) => (
      <div key={i} style={{ background: '#0f1217', borderRadius: 8, padding: '8px 12px', borderLeft: `3px solid ${GAUSS_COLORS[i] ?? '#8b94a6'}` }}>
        <div style={{ fontSize: 11, color: GAUSS_COLORS[i] ?? '#5b6577', marginBottom: 4, fontWeight: 700 }}>Gaussiana {i + 1}</div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>μ = <strong>{g.mu?.toFixed(2)}{unit}</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>σ = <strong>{g.sigma?.toFixed(3)}</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>w = <strong>{((g.w ?? 0) * 100).toFixed(1)}%</strong></div>
      </div>
    ))}
  </div>
)

const BetaCards = ({ betas }) => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
    {betas.map((b, i) => (
      <div key={i} style={{ background: '#0f1217', borderRadius: 8, padding: '8px 12px', borderLeft: `3px solid ${BETA_COLORS[i] ?? '#8b94a6'}` }}>
        <div style={{ fontSize: 11, color: BETA_COLORS[i] ?? '#5b6577', marginBottom: 4, fontWeight: 700 }}>Beta {i + 1}</div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>α = <strong>{b.alpha?.toFixed(4)}</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>β = <strong>{b.beta?.toFixed(4)}</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>Soporte = <strong>[{b.A?.toFixed(0)}, {b.B?.toFixed(0)}]</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>Moda = <strong>{b.mode?.toFixed(2)}%</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>
          Var = <strong>{b.variance != null ? b.variance.toFixed(4) : '—'}</strong>
          <span style={{ fontSize: 10, color: '#5b6577' }}> [0,1]</span>
        </div>
        {b.variance_hr != null && (
          <div style={{ fontSize: 11, color: '#5b6577' }}>Var<sub>HR</sub> = {b.variance_hr.toFixed(2)}%²</div>
        )}
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>w = <strong>{((b.w ?? 0) * 100).toFixed(1)}%</strong></div>
      </div>
    ))}
  </div>
)

function SectionFDP({ stationId, dateFrom, dateTo }) {
  const [tStats,  setTStats]  = useState(null)
  const [hStats,  setHStats]  = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [recalc,  setRecalc]  = useState(false)
  const [recalcMsg, setRecalcMsg] = useState(null)

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const [t, h] = await Promise.all([
        measurementsApi.stats({ station_id: stationId, variable_code: 'TEMP', date_from: dateFrom, date_to: dateTo, n_components: 2 }),
        measurementsApi.stats({ station_id: stationId, variable_code: 'HR',   date_from: dateFrom, date_to: dateTo, n_components: 5 }),
      ])
      setTStats(t)
      setHStats(h)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  // Recalcula el ajuste FDP desde la BD (sin re-subir archivos) y recarga
  const handleRecalc = useCallback(async () => {
    if (!stationId || recalc) return
    setRecalc(true); setRecalcMsg(null); setError(null)
    try {
      const res = await measurementsApi.recalculate({ station_id: stationId })
      const ok  = (res.recalculado ?? []).filter(r => r.ok).map(r => r.variable)
      const bad = (res.recalculado ?? []).filter(r => !r.ok)
      setRecalcMsg(
        bad.length
          ? `Recalculado: ${ok.join(', ') || '—'}. Errores: ${bad.map(b => `${b.variable} (${b.msg})`).join('; ')}`
          : `✓ Recalculado correctamente: ${ok.join(', ')}`
      )
      await load()
    } catch (e) { setError(e.message) }
    finally { setRecalc(false) }
  }, [stationId, recalc, load])

  if (error) return <Err msg={error} />

  const tPaso = tStats?.fdp_resolution ?? 0.1
  const tFdp = tStats ? prepareFDPGaussian(tStats.fdp, tStats.gaussians ?? [], tPaso) : []
  const hFdp = hStats ? prepareFDPBeta(hStats.fdp, hStats.betas ?? []) : []

  const CustomTooltip = ({ active, payload, label, unit }) => {
    if (!active || !payload?.length) return null
    return (
      <div style={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, padding: '10px 14px', fontSize: 11 }}>
        <div style={{ fontWeight: 700, color: '#e7eaf0', marginBottom: 6 }}>
          {typeof label === 'number' ? label.toFixed(1) : label}{unit}
        </div>
        {payload.map((p, i) => (
          <div key={i} style={{ color: p.color, marginBottom: 2 }}>
            {p.name}: {typeof p.value === 'number' ? p.value.toFixed(6) : p.value}
          </div>
        ))}
      </div>
    )
  }

  const FDPLegend = ({ components, colors, sumaLabel, isGauss }) => (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8, fontSize: 11, alignItems: 'center' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <svg width="24" height="4"><line x1="0" y1="2" x2="24" y2="2" stroke={FDP_FREC_COLOR} strokeWidth="2"/></svg>
        <span style={{ color: '#8b94a6' }}>Frec norm</span>
      </span>
      {components.map((c, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="24" height="4"><line x1="0" y1="2" x2="24" y2="2" stroke={colors[i] ?? '#8b94a6'} strokeWidth="1.5"/></svg>
          <span style={{ color: '#8b94a6' }}>
            {isGauss ? `Gauss ${i+1} (μ=${c.mu?.toFixed(1)}°C)` : `Beta ${i+1} (moda=${c.mode?.toFixed(1)}%)`}
          </span>
        </span>
      ))}
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <svg width="24" height="5"><line x1="0" y1="2.5" x2="24" y2="2.5" stroke={FDP_SUMA_COLOR} strokeWidth="3"/></svg>
        <span style={{ color: '#8b94a6' }}>{sumaLabel}</span>
      </span>
    </div>
  )

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          onClick={handleRecalc}
          disabled={recalc || loading || !stationId}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 8, border: '1px solid #272d37',
            background: recalc ? '#161a21' : '#2563eb', color: '#e7eaf0',
            fontSize: 13, fontWeight: 600, cursor: (recalc || loading) ? 'not-allowed' : 'pointer',
            opacity: (recalc || loading || !stationId) ? 0.6 : 1,
          }}
          title="Recalcula el ajuste FDP con la lógica actual usando las mediciones ya cargadas (no requiere re-subir archivos)"
        >
          {recalc
            ? <><Loader2 size={15} style={SPIN} /> Recalculando…</>
            : <><RefreshCw size={15} /> Recalcular FDP</>}
        </button>
        {recalcMsg && (
          <span style={{ fontSize: 12, color: recalcMsg.startsWith('✓') ? '#22c55e' : '#f59e0b' }}>
            {recalcMsg}
          </span>
        )}
      </div>

      {loading && <Spinner />}

      {!loading && tStats && (
        <SectionCard
          title="FDP — Temperatura (Gaussianas)"
          subtitle={`R² = ${tStats.r2?.toFixed(4) ?? '—'} · EMC = ${tStats.mse?.toExponential(2) ?? '—'} · N = ${tStats.n?.toLocaleString()} · Resolución: ${tPaso}°C/bin`}
          badge={<QualityBadge quality={tStats.quality} />}
        >
          <GaussianCards gaussians={tStats.gaussians ?? []} unit="°C" />
          <div style={{ marginBottom: 12, padding: '6px 12px', background: '#0f1217', borderRadius: 6, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
            freq[bin] = count[bin] / N_total · paso = {tPaso}°C · modelo(x) = Σ w_i · N(x|μ_i,σ_i) · {tPaso}
          </div>
          <FDPLegend components={tStats.gaussians ?? []} colors={GAUSS_COLORS} sumaLabel="Gauss suma" isGauss={true} />
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={tFdp} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#272d37" strokeOpacity={0.5} />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#8b94a6' }} unit="°C" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => v?.toFixed(1)}
                ticks={(() => { if (!tFdp.length) return []; const mn = Math.ceil(tFdp[0].x); const mx = Math.floor(tFdp[tFdp.length-1].x); const out = []; for (let v = mn; v <= mx; v++) out.push(v); return out })()} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(1)} />
              <Tooltip content={props => <CustomTooltip {...props} unit="°C" />} />
              <Line type="monotone" dataKey="freq" name="Frec norm" stroke={FDP_FREC_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} legendType="none" />
              {(tStats.gaussians ?? []).map((g, i) => (
                <Line key={`gauss${i+1}`} type="monotone" dataKey={`gauss${i+1}`} name={`Gauss ${i+1}`} stroke={GAUSS_COLORS[i] ?? '#8b94a6'} strokeWidth={1.5} dot={false} isAnimationActive={false} legendType="none" />
              ))}
              <Line type="monotone" dataKey="sumaGauss" name="Gauss suma" stroke={FDP_SUMA_COLOR} strokeWidth={3} dot={false} isAnimationActive={false} legendType="none" />
              {(tStats.gaussians ?? []).map((g, i) => (
                <ReferenceLine key={`ref${i}`} x={parseFloat(g.mu?.toFixed(1))} stroke={`${GAUSS_COLORS[i] ?? '#5b6577'}80`} strokeDasharray="4 2"
                  label={{ value: `μ${i+1}=${g.mu?.toFixed(1)}°C`, fontSize: 9, fill: GAUSS_COLORS[i] ?? '#5b6577', position: 'insideTopRight' }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
            <StatBox label="R²"      value={tStats.r2?.toFixed(4)  ?? '—'} color="#22c55e" />
            <StatBox label="EMC"     value={tStats.mse?.toExponential(2) ?? '—'} color={tStats.quality?.mse_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Err máx" value={tStats.quality?.max_error_range?.toFixed(5) ?? '—'} color={tStats.quality?.error_range_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Σw"      value={tStats.quality?.weights_sum?.toFixed(4) ?? '—'} color={tStats.quality?.weights_sum_ok ? '#22c55e' : '#ef4444'} />
          </div>
        </SectionCard>
      )}

      {!loading && hStats && (
        <SectionCard
          title="FDP — Humedad Relativa (Beta generalizada)"
          subtitle={`R² = ${hStats.r2?.toFixed(4) ?? '—'} · EMC = ${hStats.mse?.toExponential(2) ?? '—'} · N = ${hStats.n?.toLocaleString()} · Resolución: 1%/bin`}
          badge={<QualityBadge quality={hStats.quality} />}
        >
          <BetaCards betas={hStats.betas ?? []} />
          <div style={{ marginBottom: 12, padding: '6px 12px', background: '#0f1217', borderRadius: 6, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
            freq[bin] = count[bin] / N_total · paso = 1% (escala [0,100]) · modelo(x) = Σ w_i · BetaGen(x|α_i,β_i,A_i,B_i) · 1
          </div>
          <FDPLegend components={hStats.betas ?? []} colors={BETA_COLORS} sumaLabel="Beta suma" isGauss={false} />
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={hFdp} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#272d37" strokeOpacity={0.5} />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#8b94a6' }} unit="%" type="number" domain={[0, 100]} tickFormatter={v => v?.toFixed(0)} ticks={[0,10,20,30,40,50,60,70,80,90,100]} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(1)} />
              <Tooltip content={props => <CustomTooltip {...props} unit="%" />} />
              <Line type="monotone" dataKey="freq"      name="Frec norm" stroke={FDP_FREC_COLOR} strokeWidth={2}   dot={false} isAnimationActive={false} legendType="none" />
              {(hStats.betas ?? []).map((b, i) => (
                <Line key={`beta${i+1}`} type="monotone" dataKey={`beta${i+1}`} name={`Beta ${i+1}`} stroke={BETA_COLORS[i] ?? '#8b94a6'} strokeWidth={1.5} dot={false} isAnimationActive={false} legendType="none" />
              ))}
              <Line type="monotone" dataKey="sumaGauss" name="Beta suma"  stroke={FDP_SUMA_COLOR} strokeWidth={3}   dot={false} isAnimationActive={false} legendType="none" />
              {(hStats.betas ?? []).map((b, i) => (
                <ReferenceLine key={`ref${i}`} x={b.mode} stroke={`${BETA_COLORS[i] ?? '#5b6577'}80`} strokeDasharray="4 2"
                  label={{ value: `m${i+1}=${b.mode?.toFixed(1)}%`, fontSize: 9, fill: BETA_COLORS[i] ?? '#5b6577', position: 'insideTopRight' }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
            <StatBox label="R²"      value={hStats.r2?.toFixed(4)  ?? '—'} color="#22c55e" />
            <StatBox label="EMC"     value={hStats.mse?.toExponential(2) ?? '—'} color={hStats.quality?.mse_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Err máx" value={hStats.quality?.max_error_range?.toFixed(5) ?? '—'} color={hStats.quality?.error_range_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Σw"      value={hStats.quality?.weights_sum?.toFixed(4) ?? '—'} color={hStats.quality?.weights_sum_ok ? '#22c55e' : '#ef4444'} />
          </div>
        </SectionCard>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// SECTION B.1 — Tabla resumen exportable por estación
// ══════════════════════════════════════════════════════════════
function SectionSummaryTable({ dateFrom, dateTo }) {
  const [variable, setVariable] = useState('TEMP')
  const nComponentsT = 2
  const nComponentsH = 5
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await measurementsApi.statsSummaryTable({
        variable_code: variable,
        date_from:     dateFrom,
        date_to:       dateTo,
        n_components:  variable === 'TEMP' ? nComponentsT : nComponentsH,
      })
      setData(r)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [variable, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const isHR = variable === 'HR'
  const nComponents = variable === 'TEMP' ? nComponentsT : nComponentsH

  const compHeaders = Array.from({ length: nComponents }, (_, i) =>
    isHR ? [`Moda${i+1}`, `Var${i+1}`, `w${i+1}`] : [`μ${i+1}`, `σ${i+1}`, `w${i+1}`]
  ).flat()

  const exportCSV = () => {
    if (!data?.stations?.length) return
    const headers = ['Estación', 'Lat', 'Lon', 'Alt (m)', 'Inicio', 'Fin', 'N', 'Compl.%',
      ...compHeaders, 'EMC', 'R²', 'EMC ok', 'R² ok', 'Err ok', 'Σw ok']
    const rows = data.stations.map(s => {
      const compVals = Array.from({ length: nComponents }, (_, i) => {
        const c = s.components?.[i]
        if (!c) return ['—', '—', '—']
        return isHR
          ? [c.mode?.toFixed(2) ?? '—', c.variance != null ? c.variance.toFixed(4) : '—', ((c.w ?? 0) * 100).toFixed(1) + '%']
          : [c.mu?.toFixed(2) ?? '—', c.sigma?.toFixed(3) ?? '—', ((c.w ?? 0) * 100).toFixed(1) + '%']
      }).flat()
      return [
        s.station_name, s.latitude ?? '', s.longitude ?? '', s.altitude_m ?? '',
        fmt(s.date_start), fmt(s.date_end), s.n, s.completitud_pct,
        ...compVals,
        s.mse?.toExponential(2) ?? '—', s.r2?.toFixed(4) ?? '—',
        s.quality?.mse_ok ? 'Sí' : 'No', s.quality?.r2_ok ? 'Sí' : 'No',
        s.quality?.error_range_ok ? 'Sí' : 'No', s.quality?.weights_sum_ok ? 'Sí' : 'No',
      ]
    })
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `resumen_${variable}_${nComponents}comp.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <Card style={{ padding: '12px 20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <span style={{ fontSize: 13, color: '#8b94a6', fontWeight: 600, marginRight: 8 }}>Variable:</span>
            {['TEMP', 'HR'].map(v => (
              <button key={v} onClick={() => setVariable(v)} style={{
                padding: '4px 14px', borderRadius: 20, border: '1px solid', fontSize: 13, cursor: 'pointer', marginRight: 6,
                background:  variable === v ? '#6366f1' : 'transparent',
                borderColor: variable === v ? '#6366f1' : '#272d37',
                color:       variable === v ? '#fff'    : '#8b94a6',
              }}>{v}</button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: '#5b6577' }}>
            Componentes: <strong style={{ color: '#e7eaf0' }}>{variable === 'TEMP' ? '2 Gaussianas' : '5 Beta generalizadas'}</strong>
          </div>
          <button onClick={exportCSV} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid #272d37', background: '#0f1217', color: '#8b94a6', fontSize: 12, cursor: 'pointer' }}>
            ⬇ Exportar CSV
          </button>
        </div>
      </Card>

      {loading && <Spinner />}
      {error   && <Err msg={error} />}

      {!loading && data?.stations?.length > 0 && (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #272d37' }}>
                  {['#', 'Estación', 'Lat', 'Lon', 'Alt(m)', 'Inicio', 'Fin', 'N', 'Compl.',
                    ...compHeaders, 'EMC', 'R²', '✓EMC', '✓R²', '✓Err', '✓Σw'
                  ].map(h => (
                    <th key={h} style={{ padding: '6px 10px', color: '#5b6577', textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.stations.map((s, idx) => {
                  const compVals = Array.from({ length: nComponents }, (_, i) => {
                    const c = s.components?.[i]
                    if (!c) return ['—', '—', '—']
                    return isHR
                      ? [c.mode?.toFixed(1) ?? '—', c.variance != null ? c.variance.toFixed(4) : '—', ((c.w ?? 0)*100).toFixed(1)+'%']
                      : [c.mu?.toFixed(2) ?? '—', c.sigma?.toFixed(3) ?? '—', ((c.w ?? 0)*100).toFixed(1)+'%']
                  }).flat()
                  const q  = s.quality
                  const cc = COMPLETITUD_COLORS[s.completitud_color] || COMPLETITUD_COLORS.red
                  return (
                    <tr key={s.station_code} style={{ borderBottom: '1px solid #161a21' }}>
                      <td style={{ padding: '5px 10px', color: '#5b6577' }}>{idx + 1}</td>
                      <td style={{ padding: '5px 10px', color: '#e7eaf0', fontWeight: 600, whiteSpace: 'nowrap' }}>{s.station_name}</td>
                      <td style={{ padding: '5px 10px', color: '#8b94a6' }}>{s.latitude?.toFixed(4) ?? '—'}</td>
                      <td style={{ padding: '5px 10px', color: '#8b94a6' }}>{s.longitude?.toFixed(4) ?? '—'}</td>
                      <td style={{ padding: '5px 10px', color: '#8b94a6' }}>{s.altitude_m ?? '—'}</td>
                      <td style={{ padding: '5px 10px', color: '#8b94a6', whiteSpace: 'nowrap' }}>{fmt(s.date_start)}</td>
                      <td style={{ padding: '5px 10px', color: '#8b94a6', whiteSpace: 'nowrap' }}>{fmt(s.date_end)}</td>
                      <td style={{ padding: '5px 10px', color: '#8b94a6' }}>{s.n?.toLocaleString()}</td>
                      <td style={{ padding: '5px 10px' }}><span style={{ color: cc.text, fontWeight: 700 }}>{s.completitud_pct}%</span></td>
                      {compVals.map((v, i) => (
                        <td key={i} style={{ padding: '5px 10px', color: '#e7eaf0', fontFamily: 'monospace' }}>{v}</td>
                      ))}
                      <td style={{ padding: '5px 10px', color: '#e7eaf0', fontFamily: 'monospace' }}>{s.mse?.toExponential(2) ?? '—'}</td>
                      <td style={{ padding: '5px 10px', color: '#e7eaf0', fontFamily: 'monospace' }}>{s.r2?.toFixed(4) ?? '—'}</td>
                      {[q?.mse_ok, q?.r2_ok, q?.error_range_ok, q?.weights_sum_ok].map((ok, i) => (
                        <td key={i} style={{ padding: '5px 10px', textAlign: 'center', color: ok ? '#22c55e' : '#ef4444' }}>{ok ? '✓' : '✗'}</td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#5b6577' }}>Completitud:</span>
            {Object.entries(COMPLETITUD_COLORS).map(([key, c]) => (
              <span key={key} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>{c.label}</span>
            ))}
          </div>
          {isHR && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: '#0f1217', borderRadius: 6, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
              Var = α·β / ((α+β)²·(α+β+1)) &nbsp;[adimensional, escala interna 0–1 de la distribución Beta]
            </div>
          )}
        </Card>
      )}

      {!loading && data?.stations?.length === 0 && (
        <div style={{ textAlign: 'center', color: '#5b6577', padding: '2rem' }}>Sin datos para los filtros seleccionados.</div>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// SECTION C.1 — Mapa de calor
// ══════════════════════════════════════════════════════════════
function SectionIsolines({ stationId, dateFrom, dateTo }) {
  const [groupBy,  setGroupBy]  = useState('hour')
  const [tHm,      setTHm]      = useState(null)
  const [hHm,      setHHm]      = useState(null)
  const [tMo,      setTMo]      = useState([])
  const [hMo,      setHMo]      = useState([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const [th, hh, tm, hm] = await Promise.all([
        measurementsApi.heatmap({ station_id: stationId, variable_code: 'TEMP', group_by: groupBy, date_from: dateFrom, date_to: dateTo }),
        measurementsApi.heatmap({ station_id: stationId, variable_code: 'HR',   group_by: groupBy, date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({ station_id: stationId, variable_code: 'TEMP', group_by: 'month', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({ station_id: stationId, variable_code: 'HR',   group_by: 'month', date_from: dateFrom, date_to: dateTo }),
      ])
      setTHm(th); setHHm(hh); setTMo(tm); setHMo(hm)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, dateFrom, dateTo, groupBy])

  useEffect(() => { load() }, [load])

  if (error) return <Err msg={error} />

  const buildMatrix = (hm) => {
    if (!hm) return null
    const ejeProp  = hm.eje_label ?? 'hora'
    const ejeRange = hm.eje_range ?? HOURS
    const mat = Array.from({ length: 12 }, () => Array(ejeRange.length).fill(null))
    hm.matrix.forEach(row => {
      const mi  = (row.mes ?? 1) - 1
      const ej  = row[ejeProp]
      const idx = ejeRange.indexOf(ej)
      if (mi >= 0 && mi < 12 && idx >= 0) mat[mi][idx] = row.avg
    })
    return { mat, ejeRange }
  }

  const tBuilt = buildMatrix(tHm)
  const hBuilt = buildMatrix(hHm)
  const ejeLabel = groupBy === 'week' ? 'Sem.' : 'Hr.'

  const HeatTable = ({ built, hm, type, unit }) => {
    if (!built || !hm) return null
    const { mat, ejeRange } = built
    return (
      <SectionCard title={`Mapa de calor — ${type === 'TEMP' ? 'Temperatura' : 'Humedad Relativa'} (mes × ${groupBy === 'week' ? 'semana' : 'hora'})`}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 10 }}>
            <thead>
              <tr>
                <th style={{ padding: '3px 8px', color: '#5b6577', textAlign: 'left', fontWeight: 500 }}>Mes\{ejeLabel}</th>
                {ejeRange.map(e => (
                  <th key={e} style={{ padding: '2px 1px', color: '#5b6577', minWidth: groupBy === 'week' ? 48 : 28, fontWeight: 400 }}>
                    {groupBy === 'week' ? `S${e}` : String(e).padStart(2, '0')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MONTHS.map((m, mi) => (
                <tr key={m}>
                  <td style={{ padding: '2px 8px', color: '#8b94a6', fontWeight: 600, whiteSpace: 'nowrap' }}>{m}</td>
                  {ejeRange.map((e, ei) => {
                    const v = mat[mi][ei]
                    return (
                      <td key={e}
                        title={v != null ? `${m} ${groupBy === 'week' ? `Sem${e}` : `${String(e).padStart(2,'0')}:00`} → ${v}${unit}` : 'Sin dato'}
                        style={{ background: heatColor(v, hm.min, hm.max, type), height: 22, borderRadius: 2 }}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 11, color: '#5b6577' }}>
          <span>{hm.min?.toFixed(1)}{unit}</span>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: type === 'TEMP' ? 'linear-gradient(to right,#3b82f6,#facc15,#ef4444)' : 'linear-gradient(to right,#f0f9ff,#1d4ed8)' }} />
          <span>{hm.max?.toFixed(1)}{unit}</span>
        </div>
      </SectionCard>
    )
  }

  return (
    <>
      <Card style={{ padding: '12px 20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#8b94a6', fontWeight: 600 }}>Agrupación eje secundario:</span>
          {[{ v: 'hour', label: 'Mes × Hora' }, { v: 'week', label: 'Mes × Semana' }].map(({ v, label }) => (
            <button key={v} onClick={() => setGroupBy(v)} style={{
              padding: '5px 16px', borderRadius: 20, border: '1px solid', fontSize: 13, cursor: 'pointer',
              background:  groupBy === v ? '#3b82f6' : 'transparent',
              borderColor: groupBy === v ? '#3b82f6' : '#272d37',
              color:       groupBy === v ? '#fff'    : '#8b94a6',
            }}>{label}</button>
          ))}
        </div>
      </Card>

      {loading && <Spinner />}

      {!loading && (
        <>
          <HeatTable built={tBuilt} hm={tHm} type="TEMP" unit="°C" />
          <HeatTable built={hBuilt} hm={hHm} type="HR"   unit="%"  />
        </>
      )}

      {(tMo.length > 0 || hMo.length > 0) && (
        <SectionCard title="Variación anual promedio (promedios mensuales T y HR)">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart margin={{ top: 4, right: 40, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="period" allowDuplicatedCategory={false} tickFormatter={fmt} tick={{ fontSize: 10, fill: '#8b94a6' }} />
              <YAxis yAxisId="t" unit="°C" tick={{ fontSize: 10, fill: '#ef4444' }} />
              <YAxis yAxisId="h" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 10, fill: '#3b82f6' }} />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <Legend />
              <Line yAxisId="t" data={tMo} type="monotone" dataKey="avg" name="T promedio (°C)"  stroke="#ef4444" strokeWidth={2} dot={false} />
              <Line yAxisId="t" data={tMo} type="monotone" dataKey="max" name="T máx (°C)"       stroke="#ef444460" strokeWidth={1} strokeDasharray="4 2" dot={false} />
              <Line yAxisId="t" data={tMo} type="monotone" dataKey="min" name="T mín (°C)"       stroke="#ef444460" strokeWidth={1} strokeDasharray="4 2" dot={false} />
              <Line yAxisId="h" data={hMo} type="monotone" dataKey="avg" name="HR promedio (%)"  stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// SECTION C.2 — Perfil diario promedio por mes
// FIX: fillHours garantiza las 24 horas siempre presentes.
//      XAxis forzado con domain [0,23] y ticks explícitos.
// ══════════════════════════════════════════════════════════════

// Helper: rellena horas faltantes con null para garantizar 0–23
const fillHours = (data) => {
  if (!data?.length) return Array.from({ length: 24 }, (_, h) => ({
    hora: h, avg: null, min: null, max: null, mode: null, q25: null, q75: null,
  }))
  const map = {}
  data.forEach(d => { map[d.hora] = d })
  return Array.from({ length: 24 }, (_, h) => ({
    hora: h,
    avg:  null,
    min:  null,
    max:  null,
    mode: null,
    q25:  null,
    q75:  null,
    ...map[h],
  }))
}

// Ticks fijos de 0 a 23 para el XAxis del perfil diario
const HOUR_TICKS = Array.from({ length: 24 }, (_, i) => i)
const fmtHour   = h => `${String(h).padStart(2, '0')}:00`

function SectionDailyProfile({ stationId, dateFrom, dateTo }) {
  const [tProfile, setTProfile] = useState(null)
  const [hProfile, setHProfile] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [selMonth, setSelMonth] = useState('0')

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const [tp, hp] = await Promise.all([
        measurementsApi.dailyProfile({ station_id: stationId, variable_code: 'TEMP', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.dailyProfile({ station_id: stationId, variable_code: 'HR',   date_from: dateFrom, date_to: dateTo }),
      ])
      setTProfile(tp)
      setHProfile(hp)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error)   return <Err msg={error} />
  if (!tProfile && !hProfile) return null

  const getTData = () => {
    if (!tProfile) return []
    if (selMonth === '0') return tProfile.annual ?? []
    return tProfile.monthly?.[selMonth] ?? []
  }
  const getHData = () => {
    if (!hProfile) return []
    if (selMonth === '0') return hProfile.annual ?? []
    return hProfile.monthly?.[selMonth] ?? []
  }

  const MonthSelector = () => (
    <Card style={{ padding: '12px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: '#8b94a6', fontWeight: 600, marginRight: 4 }}>Período:</span>
        <button onClick={() => setSelMonth('0')} style={{
          padding: '4px 12px', borderRadius: 20, border: '1px solid', fontSize: 12, cursor: 'pointer',
          background: selMonth === '0' ? '#22c55e' : 'transparent',
          borderColor: selMonth === '0' ? '#22c55e' : '#272d37',
          color: selMonth === '0' ? '#000' : '#8b94a6',
        }}>Anual</button>
        {MONTHS.map((m, i) => (
          <button key={i} onClick={() => setSelMonth(String(i + 1))} style={{
            padding: '4px 10px', borderRadius: 20, border: '1px solid', fontSize: 12, cursor: 'pointer',
            background: selMonth === String(i + 1) ? '#6366f1' : 'transparent',
            borderColor: selMonth === String(i + 1) ? '#6366f1' : '#272d37',
            color: selMonth === String(i + 1) ? '#fff' : '#8b94a6',
          }}>{m}</button>
        ))}
      </div>
    </Card>
  )

  // ── FIX: siempre 24 puntos, dominio forzado ────────────────
  const tData = fillHours(getTData())
  const hData = fillHours(getHData())
  const monthLabel = selMonth === '0' ? 'Anual' : MONTHS[parseInt(selMonth) - 1]

  return (
    <>
      <div style={{ marginBottom: 8, padding: '4px 0' }}>
        <p style={{ margin: 0, fontSize: 13, color: '#8b94a6' }}>
          Perfil diario promedio (c.2): estadísticos horarios de T (max, min, avg, moda, Q25, Q75) y HR (moda, avg).
        </p>
      </div>
      <MonthSelector />

      {/* ── Temperatura ─────────────────────────────────────── */}
      <SectionCard
        title={`Temperatura — Perfil diario (${monthLabel})`}
        subtitle="Estadísticos horarios"
      >
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={tData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="tpg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
            {/* FIX: domain + ticks explícitos garantizan 0–23 siempre */}
            <XAxis
              dataKey="hora"
              type="number"
              domain={[0, 23]}
              ticks={HOUR_TICKS}
              tickFormatter={fmtHour}
              tick={{ fontSize: 10, fill: '#8b94a6' }}
              interval={0}
            />
            <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="°C" />
            <Tooltip
              labelFormatter={fmtHour}
              contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
            />
            <Legend />
            <Area type="monotone" dataKey="max"  name="Máx"      stroke="#ef4444" fill="none"      strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="q75"  name="Q75"      stroke="#f97316" fill="none"      strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="avg"  name="Promedio" stroke="#ef4444" fill="url(#tpg)" strokeWidth={2} dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="mode" name="Moda"     stroke="#fbbf24" fill="none"      strokeWidth={1} strokeDasharray="6 2" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="q25"  name="Q25"      stroke="#f97316" fill="none"      strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="min"  name="Mín"      stroke="#ef4444" fill="none"      strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>

      {/* ── Humedad Relativa ─────────────────────────────────── */}
      <SectionCard
        title={`Humedad Relativa — Perfil diario (${monthLabel})`}
        subtitle="Estadísticos horarios (moda como estadístico principal)"
      >
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={hData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="hpg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
            {/* FIX: domain + ticks explícitos garantizan 0–23 siempre */}
            <XAxis
              dataKey="hora"
              type="number"
              domain={[0, 23]}
              ticks={HOUR_TICKS}
              tickFormatter={fmtHour}
              tick={{ fontSize: 10, fill: '#8b94a6' }}
              interval={0}
            />
            <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="%" domain={[0, 100]} />
            <Tooltip
              labelFormatter={fmtHour}
              contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
            />
            <Legend />
            <Area type="monotone" dataKey="max"  name="Máx"      stroke="#3b82f6" fill="none"      strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="q75"  name="Q75"      stroke="#6366f1" fill="none"      strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="avg"  name="Promedio" stroke="#3b82f6" fill="url(#hpg)" strokeWidth={2} dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="mode" name="Moda"     stroke="#a78bfa" fill="none"      strokeWidth={2} strokeDasharray="6 2" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="q25"  name="Q25"      stroke="#6366f1" fill="none"      strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="min"  name="Mín"      stroke="#3b82f6" fill="none"      strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// SECTION C.3 — Perfil anual promedio
// ══════════════════════════════════════════════════════════════
function SectionAnnualProfile({ stationId, dateFrom, dateTo }) {
  const [tProfile, setTProfile] = useState(null)
  const [hProfile, setHProfile] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [smoothW,  setSmoothW]  = useState(14)

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const [tp, hp] = await Promise.all([
        measurementsApi.annualProfile({ station_id: stationId, variable_code: 'TEMP', date_from: dateFrom, date_to: dateTo }),
        measurementsApi.annualProfile({ station_id: stationId, variable_code: 'HR',   date_from: dateFrom, date_to: dateTo }),
      ])
      setTProfile(tp)
      setHProfile(hp)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error)   return <Err msg={error} />
  if (!tProfile && !hProfile) return null

  const movingAvg = (data, key, w) => {
    const half = Math.floor(w / 2)
    return data.map((d, i) => {
      const slice = data.slice(Math.max(0, i - half), Math.min(data.length, i + half + 1))
      const vals  = slice.map(s => s[key]).filter(v => v != null)
      return { ...d, [`${key}_smooth`]: vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3) : null }
    })
  }

  const tRaw    = tProfile?.series ?? []
  const hRaw    = hProfile?.series ?? []
  const tSeries = movingAvg(tRaw, 'avg', smoothW)
  const hSeries = movingAvg(hRaw, 'avg', smoothW)
  const monthDoys = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]

  const SmoothControl = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#0f1217', borderRadius: 8, marginBottom: 14, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: '#8b94a6', fontWeight: 600 }}>Suavizado (media móvil):</span>
      {[7, 14].map(w => (
        <button key={w} onClick={() => setSmoothW(w)} style={{
          padding: '4px 14px', borderRadius: 20, border: '1px solid', fontSize: 12, cursor: 'pointer',
          background:  smoothW === w ? '#6366f1' : 'transparent',
          borderColor: smoothW === w ? '#6366f1' : '#272d37',
          color:       smoothW === w ? '#fff'    : '#8b94a6',
        }}>{w} días</button>
      ))}
      <div style={{ display: 'flex', gap: 14, marginLeft: 8, fontSize: 11 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#5b6577' }}>
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 2"/></svg>
          Datos brutos
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#8b94a6' }}>
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="#ef4444" strokeWidth="3"/></svg>
          Media móvil {smoothW}d
        </span>
      </div>
    </div>
  )

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <p style={{ margin: 0, fontSize: 13, color: '#8b94a6' }}>
          Perfil anual promedio (c.3): media diaria de T y moda diaria de HR. La curva suavizada usa media móvil de ventana configurable.
        </p>
      </div>

      {tSeries.length > 0 && (
        <SectionCard
          title="Temperatura — Variación anual promedio"
          subtitle={`${tProfile.date_start ? fmt(tProfile.date_start) : ''} → ${tProfile.date_end ? fmt(tProfile.date_end) : ''} · Estadístico: media diaria`}
        >
          <SmoothControl />
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={tSeries} margin={{ top: 8, right: 16, left: -10, bottom: 24 }}>
              <defs>
                <linearGradient id="tag" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="doy" tickFormatter={fmtDoy} ticks={monthDoys} tick={{ fontSize: 10, fill: '#8b94a6' }} height={40}
                label={{ value: 'Día del año', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#5b6577' }} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="°C" width={52}
                label={{ value: 'T (°C)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#5b6577' }} />
              <Tooltip labelFormatter={fmtDoy} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <Legend verticalAlign="top" height={28} />
              <Area type="monotone" dataKey="max" name="Máx" stroke="#ef4444" fill="url(#tag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Area type="monotone" dataKey="min" name="Mín" stroke="#ef4444" fill="url(#tag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Line type="monotone" dataKey="avg" name="Media diaria (bruto)" stroke="#ef444470" strokeWidth={1} strokeDasharray="3 2" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="avg_smooth" name={`Media móvil ${smoothW}d`} stroke="#ef4444" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q75" name="Q75" stroke="#f9731660" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q25" name="Q25" stroke="#f9731660" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              {monthDoys.map((d, i) => (
                <ReferenceLine key={i} x={d} stroke="#272d37" strokeDasharray="2 4"
                  label={{ value: MONTHS[i], fontSize: 9, fill: '#353d4a', position: 'insideTopRight' }} />
              ))}
              <Brush dataKey="doy" height={22} stroke="#272d37" fill="#0f1217" tickFormatter={fmtDoy} startIndex={0} endIndex={Math.min(tSeries.length - 1, 364)} />
            </ComposedChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {hSeries.length > 0 && (
        <SectionCard
          title="Humedad Relativa — Variación anual promedio"
          subtitle={`${hProfile.date_start ? fmt(hProfile.date_start) : ''} → ${hProfile.date_end ? fmt(hProfile.date_end) : ''} · Estadístico: moda diaria`}
        >
          <SmoothControl />
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={hSeries} margin={{ top: 8, right: 16, left: -10, bottom: 24 }}>
              <defs>
                <linearGradient id="hag" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="doy" tickFormatter={fmtDoy} ticks={monthDoys} tick={{ fontSize: 10, fill: '#8b94a6' }} height={40}
                label={{ value: 'Día del año', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#5b6577' }} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="%" domain={[0, 100]} width={52}
                label={{ value: 'HR (%)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#5b6577' }} />
              <Tooltip labelFormatter={fmtDoy} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <Legend verticalAlign="top" height={28} />
              <Area type="monotone" dataKey="max" name="Máx" stroke="#3b82f6" fill="url(#hag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Area type="monotone" dataKey="min" name="Mín" stroke="#3b82f6" fill="url(#hag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Line type="monotone" dataKey="avg" name="Moda diaria (bruto)" stroke="#3b82f670" strokeWidth={1} strokeDasharray="3 2" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="avg_smooth" name={`Media móvil ${smoothW}d`} stroke="#3b82f6" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q75" name="Q75" stroke="#6366f160" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q25" name="Q25" stroke="#6366f160" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              {monthDoys.map((d, i) => (
                <ReferenceLine key={i} x={d} stroke="#272d37" strokeDasharray="2 4"
                  label={{ value: MONTHS[i], fontSize: 9, fill: '#353d4a', position: 'insideTopRight' }} />
              ))}
              <Brush dataKey="doy" height={22} stroke="#272d37" fill="#0f1217" tickFormatter={fmtDoy} />
            </ComposedChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// SECTION D — T × HR combinado
// ══════════════════════════════════════════════════════════════
function SectionCombined({ stationId, stationAlt, dateFrom, dateTo }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [svgW,    setSvgW]    = useState(700)
  const containerRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w > 0) setSvgW(Math.floor(w))
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const load = useCallback(async () => {
    if (!stationId) return
    setLoading(true); setError(null)
    try {
      const r = await measurementsApi.combined({
        station_id: stationId,
        altitude:   stationAlt || 0,
        date_from:  dateFrom,
        date_to:    dateTo,
      })
      setData(r)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [stationId, stationAlt, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error)   return <Err msg={error} />
  if (!data)   return null

  const rawPoints = data.scatter?.length
    ? data.scatter.map(d => ({ T: d.T, HR: d.HR }))
    : data.density?.map(d => ({ T: d.T, HR: d.HR })) ?? []

  const allT  = rawPoints.map(d => d.T)
  const allHR = rawPoints.map(d => d.HR)
  const tMin  = Math.floor(Math.min(...allT)  - 0.5)
  const tMax  = Math.ceil( Math.max(...allT)  + 0.5)
  const hrMin = Math.max(0,   Math.floor(Math.min(...allHR) - 2))
  const hrMax = Math.min(100, Math.ceil( Math.max(...allHR) + 2))

  const mobilityT = data.mobility ?? []

  return (
    <>
      <SectionCard
        title="d.1) Densidad conjunta f(HR,T)"
        subtitle={`Tiempo de humectación (T>10°C y HR>79%): ${data.humect_pct}% (${data.humect_count} registros)`}
      >
        <div ref={containerRef} style={{ width: '100%' }}>
          {rawPoints.length > 0 ? (
            <KDEHeatmapSVG
              densityPoints={rawPoints}
              tMin={tMin}
              tMax={tMax}
              hrMin={hrMin}
              hrMax={hrMax}
              width={svgW}
              height={Math.round(svgW * 0.62)}
            />
          ) : (
            <div style={{ color: '#5b6577', textAlign: 'center', padding: '2rem' }}>
              Sin datos de dispersión disponibles.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap', fontSize: 11, alignItems: 'center' }}>
          <div style={{ flex: 1, height: 10, borderRadius: 4, background: 'linear-gradient(to right, #440154, #31688e, #35b779, #fde725)' }} />
          <span style={{ color: '#5b6577', minWidth: 120 }}>Menor densidad → Mayor densidad</span>
        </div>
      </SectionCard>

      {data.habs_monthly?.length > 0 && (
        <SectionCard title="d.2) Humedad Absoluta mensual" subtitle={`Altitud: ${stationAlt || 0} m s.n.m.`}>
          <div style={{ marginBottom: 10, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
            H_abs = (18000/29) × (HR/100 × P_sat) / (P_tot − HR/100 × P_sat)
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.habs_monthly} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="habsg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#8b94a6' }} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit=" g/kg" />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <Area type="monotone" dataKey="avg" name="H abs prom (g/kg)" stroke="#10b981" fill="url(#habsg)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {data.scatter?.length > 0 && (
        <SectionCard title="d.3) Gráfico psicrométrico (T vs H abs)">
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="T" name="T" unit="°C" type="number" tick={{ fontSize: 10, fill: '#8b94a6' }}
                label={{ value: 'T (°C)', position: 'insideBottom', offset: -8, fontSize: 11, fill: '#8b94a6' }} />
              <YAxis dataKey="habs" name="H abs" unit=" g/kg" type="number" tick={{ fontSize: 10, fill: '#8b94a6' }}
                label={{ value: 'H abs (g/kg)', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#8b94a6' }} />
              <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
                formatter={(v, n) => [typeof v === 'number' ? v.toFixed(3) : v, n]} />
              <Scatter data={data.scatter} name="T vs H abs" fill="#10b981" fillOpacity={0.3} />
            </ScatterChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {mobilityT.length > 0 && (
        <SectionCard
          title="d.4) Movilidad del flujo T × HR durante el año"
          subtitle="Temperatura y HR promedio por mes y hora del día"
        >
          {(() => {
            const matT  = Array.from({ length: 12 }, () => Array(24).fill(null))
            const matHR = Array.from({ length: 12 }, () => Array(24).fill(null))
            mobilityT.forEach(({ mes, hora, T_avg, HR_avg }) => {
              matT [mes-1][hora] = T_avg
              matHR[mes-1][hora] = HR_avg
            })
            const allTm  = mobilityT.map(d => d.T_avg)
            const allHRm = mobilityT.map(d => d.HR_avg)
            const tMinM = Math.min(...allTm),  tMaxM = Math.max(...allTm)
            const hMinM = Math.min(...allHRm), hMaxM = Math.max(...allHRm)

            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {[
                  { label: 'T promedio (°C)', mat: matT,  min: tMinM, max: tMaxM, type: 'TEMP', unit: '°C' },
                  { label: 'HR promedio (%)', mat: matHR, min: hMinM, max: hMaxM, type: 'HR',   unit: '%'  },
                ].map(({ label, mat, min, max, type, unit }) => (
                  <div key={label}>
                    <div style={{ fontSize: 12, color: '#8b94a6', marginBottom: 6, fontWeight: 600 }}>{label}</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', fontSize: 9 }}>
                        <thead>
                          <tr>
                            <th style={{ padding: '2px 6px', color: '#5b6577', textAlign: 'left' }}>M\H</th>
                            {HOURS.map(h => <th key={h} style={{ padding: '1px', color: '#5b6577', minWidth: 22 }}>{String(h).padStart(2,'0')}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {MONTHS.map((m, mi) => (
                            <tr key={m}>
                              <td style={{ padding: '1px 6px', color: '#8b94a6', fontWeight: 600 }}>{m}</td>
                              {HOURS.map(h => {
                                const v = mat[mi][h]
                                return (
                                  <td key={h}
                                    title={v != null ? `${m} ${String(h).padStart(2,'0')}:00 → ${v}${unit}` : 'Sin dato'}
                                    style={{ background: heatColor(v, min, max, type), height: 18, borderRadius: 1 }}
                                  />
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, fontSize: 10, color: '#5b6577', alignItems: 'center' }}>
                      <span>{min?.toFixed(1)}{unit}</span>
                      <div style={{ flex: 1, height: 6, borderRadius: 3, background: type === 'TEMP' ? 'linear-gradient(to right,#3b82f6,#facc15,#ef4444)' : 'linear-gradient(to right,#f0f9ff,#1d4ed8)' }} />
                      <span>{max?.toFixed(1)}{unit}</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </SectionCard>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════
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

  const tabRequiresStation = activeTab !== 'summary-table'

  return (
    <div style={{ padding: '2rem 2.5rem', maxWidth: 1200 }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '1.75rem', fontWeight: 800, color: '#e7eaf0' }}>Análisis meteorológico</h1>
        <p style={{ margin: 0, fontSize: '0.875rem', color: '#8b94a6' }}>Visualización · FDP · Isolíneas · Perfil diario y anual · Análisis combinado T×HR</p>
      </div>

      {/* Filtros */}
      <div style={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 12, padding: '16px 20px', marginBottom: 24, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#5b6577', marginBottom: 5 }}>Estación</label>
          <select value={stationId} onChange={e => handleStation(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #272d37', background: '#0f1217', color: '#e7eaf0', fontSize: 13 }}>
            <option value="">Seleccionar…</option>
            {stations.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#5b6577', marginBottom: 5 }}>Altitud (m)</label>
          <input type="number" value={stationAlt} onChange={e => setStationAlt(parseFloat(e.target.value) || 0)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #272d37', background: '#0f1217', color: '#e7eaf0', fontSize: 13, width: 100 }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#5b6577', marginBottom: 5 }}>Desde</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #272d37', background: '#0f1217', color: '#e7eaf0', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#5b6577', marginBottom: 5 }}>Hasta</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #272d37', background: '#0f1217', color: '#e7eaf0', fontSize: 13 }} />
        </div>
        <button
          onClick={() => setQueried(true)}
          disabled={tabRequiresStation && !stationId}
          style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 13,
            cursor: (tabRequiresStation && !stationId) ? 'not-allowed' : 'pointer',
            background: (tabRequiresStation && !stationId) ? '#272d37' : '#22c55e',
            color:      (tabRequiresStation && !stationId) ? '#5b6577'  : '#000',
          }}>
          Consultar
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, flexWrap: 'wrap', borderBottom: '1px solid #161a21', paddingBottom: 0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setActiveTab(t.id); if (t.id === 'summary-table') setQueried(true) }} style={{
            padding: '10px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
            background: 'none', border: 'none',
            color: activeTab === t.id ? '#22c55e' : '#8b94a6',
            borderBottom: `2px solid ${activeTab === t.id ? '#22c55e' : 'transparent'}`,
            marginBottom: -1,
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Contenido por tab */}
      {activeTab === 'summary-table' ? (
        <SectionSummaryTable dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />
      ) : !queried ? (
        <div style={{ textAlign: 'center', padding: '4rem 0', color: '#8b94a6' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🌦️</div>
          <p>Seleccioná una estación y hacé clic en <strong>Consultar</strong> para comenzar el análisis.</p>
        </div>
      ) : (
        <>
          {activeTab === 'overview'       && <SectionOverview      stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'fdp'            && <SectionFDP           stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'isolines'       && <SectionIsolines      stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'daily-profile'  && <SectionDailyProfile  stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'annual-profile' && <SectionAnnualProfile stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
          {activeTab === 'combined'       && <SectionCombined      stationId={stationId} stationAlt={stationAlt} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />}
        </>
      )}
    </div>
  )
}