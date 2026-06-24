import { useState, useRef, useEffect } from 'react'
import * as d3 from 'd3'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid,
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

// ── Color para mapa de movilidad (TEMP/HR), igual a Analysis ──
const heatColorTH = (val, min, max, type) => {
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
// KDE HEATMAP SVG con D3 (densidad conjunta f(HR,T)) — igual a Analysis
// ══════════════════════════════════════════════════════════════
function KDEHeatmapSVG({ densityPoints, tMin, tMax, hrMin, hrMax, width, height }) {
  const svgRef = useRef(null)

  useEffect(() => {
    if (!svgRef.current || !densityPoints?.length) return

    const pad = { top: 20, right: 110, bottom: 50, left: 60 }
    const pw = width  - pad.left - pad.right
    const ph = height - pad.top  - pad.bottom
    if (pw <= 0 || ph <= 0) return

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
    defs.append('clipPath').attr('id', 'mkde-plot-clip')
      .append('rect').attr('width', pw).attr('height', ph)

    const cbGrad = defs.append('linearGradient')
      .attr('id', 'mkde-cb-grad')
      .attr('x1', '0%').attr('x2', '0%').attr('y1', '0%').attr('y2', '100%')
    d3.range(11).forEach(i => {
      cbGrad.append('stop').attr('offset', `${i * 10}%`).attr('stop-color', d3.interpolateViridis(1 - i / 10))
    })

    const g = svg.append('g').attr('transform', `translate(${pad.left},${pad.top})`)
    g.append('rect').attr('width', pw).attr('height', ph).attr('fill', '#0a0a1a')

    g.append('g').attr('clip-path', 'url(#mkde-plot-clip)')
      .selectAll('path').data(contours).join('path')
      .attr('d', d3.geoPath()).attr('fill', d => colorScale(d.value)).attr('stroke', 'none')

    g.append('g').attr('clip-path', 'url(#mkde-plot-clip)')
      .selectAll('path').data(contours.filter((_, i) => i % 3 === 0)).join('path')
      .attr('d', d3.geoPath()).attr('fill', 'none')
      .attr('stroke', d => colorScale(d.value * 1.5 > maxDensity ? maxDensity : d.value * 1.5))
      .attr('stroke-width', 0.6).attr('opacity', 0.7)

    const y79 = yScale(79)
    if (y79 >= 0 && y79 <= ph) {
      g.append('line').attr('x1', 0).attr('x2', pw).attr('y1', y79).attr('y2', y79)
        .attr('stroke', '#f97316').attr('stroke-width', 1.5).attr('stroke-dasharray', '8,4')
      g.append('text').attr('x', pw - 4).attr('y', y79 - 5).attr('fill', '#f97316')
        .attr('font-size', 11).attr('text-anchor', 'end').text('HR=79%')
    }
    const x10 = xScale(10)
    if (x10 >= 0 && x10 <= pw) {
      g.append('line').attr('x1', x10).attr('x2', x10).attr('y1', 0).attr('y2', ph)
        .attr('stroke', '#f97316').attr('stroke-width', 1.5).attr('stroke-dasharray', '8,4')
      g.append('text').attr('x', x10 + 3).attr('y', 14).attr('fill', '#f97316').attr('font-size', 11).text('T=10°C')
    }

    g.append('g').attr('transform', `translate(0,${ph})`)
      .call(d3.axisBottom(xScale).ticks((tMax - tMin) / 2.5).tickSize(-ph).tickFormat(''))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('line').attr('stroke', '#272d37').attr('stroke-dasharray', '2,4').attr('opacity', 0.6))
    g.append('g').call(d3.axisLeft(yScale).ticks(6).tickSize(-pw).tickFormat(''))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('line').attr('stroke', '#272d37').attr('stroke-dasharray', '2,4').attr('opacity', 0.6))

    g.append('g').attr('transform', `translate(0,${ph})`)
      .call(d3.axisBottom(xScale).ticks((tMax - tMin) / 2.5).tickFormat(d => d.toFixed(1)))
      .call(ax => ax.select('.domain').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick text').attr('fill', '#8b94a6').attr('font-size', 11).attr('font-family', 'monospace'))
    g.append('text').attr('x', pw / 2).attr('y', ph + 42).attr('fill', '#c3cad6')
      .attr('font-size', 13).attr('text-anchor', 'middle').text('Temperatura (°C)')

    g.append('g').call(d3.axisLeft(yScale).tickValues([0, 20, 40, 60, 80, 100].filter(v => v >= hrMin && v <= hrMax)).tickFormat(d => d.toFixed(0)))
      .call(ax => ax.select('.domain').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick text').attr('fill', '#8b94a6').attr('font-size', 11).attr('font-family', 'monospace'))
    g.append('text').attr('transform', 'rotate(-90)').attr('x', -ph / 2).attr('y', -46)
      .attr('fill', '#c3cad6').attr('font-size', 13).attr('text-anchor', 'middle').text('HR (%)')

    g.append('rect').attr('width', pw).attr('height', ph).attr('fill', 'none').attr('stroke', '#353d4a').attr('stroke-width', 0.8)

    const cbX = pw + 14, cbW = 16
    g.append('rect').attr('x', cbX).attr('y', 0).attr('width', cbW).attr('height', ph)
      .attr('fill', 'url(#mkde-cb-grad)').attr('stroke', '#353d4a').attr('stroke-width', 0.5)
    d3.range(5).map(i => (i / 4) * maxDensity).forEach(v => {
      const cy = ph - (v / maxDensity) * ph
      g.append('line').attr('x1', cbX + cbW).attr('x2', cbX + cbW + 4).attr('y1', cy).attr('y2', cy)
        .attr('stroke', '#8b94a6').attr('stroke-width', 0.5)
      g.append('text').attr('x', cbX + cbW + 7).attr('y', cy + 3).attr('fill', '#8b94a6')
        .attr('font-size', 10).attr('font-family', 'monospace').text(v.toFixed(4))
    })
    g.append('text').attr('transform', 'rotate(-90)').attr('x', -ph / 2).attr('y', cbX + cbW + 44)
      .attr('fill', '#c3cad6').attr('font-size', 11).attr('text-anchor', 'middle').text('f(HR;T)')
  }, [densityPoints, tMin, tMax, hrMin, hrMax, width, height])

  return <svg ref={svgRef} width={width} height={height} style={{ display: 'block', width: '100%', borderRadius: 8 }} />
}

// ══════════════════════════════════════════════════════════════
// DIAGRAMA PSICROMÉTRICO (Carrier) con D3 — igual a Analysis
// ══════════════════════════════════════════════════════════════
function PsychrometricChartSVG({ scatter, isoRh, humectCurve, tMin, tMax, width, height }) {
  const svgRef = useRef(null)

  useEffect(() => {
    if (!svgRef.current) return

    const pad = { top: 20, right: 64, bottom: 50, left: 64 }
    const pw  = width  - pad.left - pad.right
    const ph  = height - pad.top  - pad.bottom
    if (pw <= 0 || ph <= 0) return

    const habsVals = (scatter ?? []).map(d => d.habs).filter(v => v != null)
    let yMax = habsVals.length ? d3.max(habsVals) : 1
    yMax = Math.max(2, Math.ceil((yMax * 1.12) / 2) * 2)

    const xScale = d3.scaleLinear().domain([tMin, tMax]).range([0, pw])
    const yScale = d3.scaleLinear().domain([0, yMax]).range([ph, 0])

    const line = d3.line().defined(d => d.habs != null).x(d => xScale(d.T)).y(d => yScale(d.habs))

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    const defs = svg.append('defs')
    defs.append('clipPath').attr('id', 'mpsy-clip').append('rect').attr('width', pw).attr('height', ph)

    const g = svg.append('g').attr('transform', `translate(${pad.left},${pad.top})`)
    g.append('rect').attr('width', pw).attr('height', ph).attr('fill', '#0a0a14')

    g.append('g').attr('transform', `translate(0,${ph})`)
      .call(d3.axisBottom(xScale).ticks(10).tickSize(-ph).tickFormat(''))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('line').attr('stroke', '#272d37').attr('stroke-dasharray', '2,4').attr('opacity', 0.5))
    g.append('g').call(d3.axisLeft(yScale).ticks(6).tickSize(-pw).tickFormat(''))
      .call(ax => ax.select('.domain').remove())
      .call(ax => ax.selectAll('line').attr('stroke', '#272d37').attr('stroke-dasharray', '2,4').attr('opacity', 0.5))

    const plot = g.append('g').attr('clip-path', 'url(#mpsy-clip)')

    ;(isoRh ?? []).forEach(curve => {
      const isSat = curve.rh === 100
      plot.append('path').datum(curve.points).attr('d', line).attr('fill', 'none')
        .attr('stroke', isSat ? '#e0f2fe' : '#38bdf8')
        .attr('stroke-width', isSat ? 2 : 1).attr('opacity', isSat ? 0.95 : 0.4)
      const visible = curve.points.filter(p => {
        const y = yScale(p.habs), x = xScale(p.T)
        return y >= 0 && y <= ph && x >= 0 && x <= pw
      })
      const lbl = visible[visible.length - 1]
      if (lbl) {
        g.append('text').attr('x', Math.min(xScale(lbl.T) + 3, pw - 2)).attr('y', yScale(lbl.habs) - 2)
          .attr('fill', isSat ? '#e0f2fe' : '#7dd3fc').attr('font-size', 9).attr('font-family', 'monospace').text(`${curve.rh}%`)
      }
    })

    const x10 = xScale(10)
    if (x10 >= 0 && x10 <= pw) {
      plot.append('line').attr('x1', x10).attr('x2', x10).attr('y1', 0).attr('y2', ph)
        .attr('stroke', '#f97316').attr('stroke-width', 1.2).attr('stroke-dasharray', '8,4').attr('opacity', 0.8)
      g.append('text').attr('x', x10 + 3).attr('y', 12).attr('fill', '#f97316').attr('font-size', 10).text('T=10°C')
    }
    if (humectCurve?.length) {
      plot.append('path').datum(humectCurve).attr('d', line).attr('fill', 'none')
        .attr('stroke', '#f97316').attr('stroke-width', 1.2).attr('stroke-dasharray', '8,4').attr('opacity', 0.85)
    }

    plot.append('g').selectAll('circle').data(scatter ?? []).join('circle')
      .attr('cx', d => xScale(d.T)).attr('cy', d => yScale(d.habs)).attr('r', 2)
      .attr('fill', '#22c55e').attr('opacity', 0.22)
      .append('title').text(d => `T=${d.T}°C · HR=${d.HR}%\nH abs=${d.habs} g/kg`
        + (d.tr != null ? ` · T rocío=${d.tr}°C` : '') + (d.h != null ? `\nEntalpía=${d.h} kJ/kg` : ''))

    g.append('g').attr('transform', `translate(0,${ph})`)
      .call(d3.axisBottom(xScale).ticks(10).tickFormat(d => d.toFixed(0)))
      .call(ax => ax.select('.domain').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick text').attr('fill', '#8b94a6').attr('font-size', 11).attr('font-family', 'monospace'))
    g.append('g').call(d3.axisLeft(yScale).ticks(6).tickFormat(d => d.toFixed(0)))
      .call(ax => ax.select('.domain').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#353d4a'))
      .call(ax => ax.selectAll('.tick text').attr('fill', '#8b94a6').attr('font-size', 11).attr('font-family', 'monospace'))

    g.append('text').attr('x', pw / 2).attr('y', ph + 40).attr('fill', '#c3cad6')
      .attr('font-size', 13).attr('text-anchor', 'middle').text('Temperatura de bulbo seco (°C)')
    g.append('text').attr('transform', 'rotate(-90)').attr('x', -ph / 2).attr('y', -48)
      .attr('fill', '#c3cad6').attr('font-size', 13).attr('text-anchor', 'middle').text('Humedad absoluta (g/kg aire seco)')

    g.append('rect').attr('width', pw).attr('height', ph).attr('fill', 'none').attr('stroke', '#353d4a').attr('stroke-width', 0.8)
  }, [scatter, isoRh, humectCurve, tMin, tMax, width, height])

  return <svg ref={svgRef} width={width} height={height} style={{ display: 'block', width: '100%', borderRadius: 8 }} />
}

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
  const [svgW, setSvgW] = useState(700)
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

  if (!combined || combined.error) return (
    <div style={{ ...S, color: '#ef4444', fontSize: 13 }}>
      ⚠️ Combinado T×HR: {combined?.error || 'Sin datos'}
    </div>
  )

  const TABS = [
    { id: 'density',  label: 'd.1) Densidad conjunta f(HR,T)' },
    { id: 'habs',     label: 'd.2) Humedad absoluta' },
    { id: 'psych',    label: 'd.3) Diagrama psicrométrico' },
    { id: 'mobility', label: 'd.4) Movilidad T×HR' },
  ]

  const rawPoints = combined.scatter?.length
    ? combined.scatter.map(d => ({ T: d.T, HR: d.HR }))
    : combined.density?.map(d => ({ T: d.T, HR: d.HR })) ?? []
  const allT  = rawPoints.map(d => d.T)
  const allHR = rawPoints.map(d => d.HR)
  const tMin  = allT.length  ? Math.floor(Math.min(...allT) - 0.5)       : 0
  const tMax  = allT.length  ? Math.ceil(Math.max(...allT) + 0.5)        : 40
  const hrMin = allHR.length ? Math.max(0,   Math.floor(Math.min(...allHR) - 2)) : 0
  const hrMax = allHR.length ? Math.min(100, Math.ceil(Math.max(...allHR) + 2))  : 100

  const mobilityT = combined.mobility ?? []

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

      <div style={{ padding: '16px 20px' }} ref={containerRef}>

        {/* d.1) Densidad conjunta f(HR,T) — mapa KDE (igual a Analysis) */}
        {tab === 'density' && (
          <div>
            <p style={{ fontSize: 11, color: '#5b6577', marginBottom: 10 }}>
              Tiempo de humectación (T&gt;10°C y HR&gt;79%): {combined.humect_pct}% ({combined.humect_count} registros)
            </p>
            {rawPoints.length > 0 ? (
              <KDEHeatmapSVG densityPoints={rawPoints} tMin={tMin} tMax={tMax} hrMin={hrMin} hrMax={hrMax}
                width={svgW} height={Math.round(svgW * 0.62)} />
            ) : (
              <div style={{ color: '#5b6577', textAlign: 'center', padding: '2rem' }}>Sin datos de dispersión disponibles.</div>
            )}
            <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap', fontSize: 11, alignItems: 'center' }}>
              <div style={{ flex: 1, height: 10, borderRadius: 4, background: 'linear-gradient(to right, #440154, #31688e, #35b779, #fde725)' }} />
              <span style={{ color: '#5b6577', minWidth: 120 }}>Menor densidad → Mayor densidad</span>
            </div>
          </div>
        )}

        {tab === 'habs' && (
          <div>
            <div style={{ marginBottom: 10, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
              H_abs = 0.622 × (HR/100 × P_sat) / (P_tot − HR/100 × P_sat) × 1000 [g/kg] &nbsp;·&nbsp; P_sat = f(T) &nbsp;·&nbsp; P_tot = f(altitud)
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

        {/* d.3) Diagrama psicrométrico (Carrier) — igual a Analysis */}
        {tab === 'psych' && (
          <div>
            <div style={{ marginBottom: 10, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
              ω = 0.622 · P_vap /(P_tot − P_vap) · 1000 [g/kg] · P_vap = HR/100 · P_sat(T)
            </div>
            <PsychrometricChartSVG scatter={combined.scatter} isoRh={combined.iso_rh}
              humectCurve={combined.humect_curve?.[0]?.points} tMin={tMin} tMax={tMax}
              width={svgW} height={Math.round(svgW * 0.6)} />
            <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', fontSize: 11, alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="#38bdf8" strokeWidth="1.5"/></svg>
                <span style={{ color: '#8b94a6' }}>HR constante</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="#e0f2fe" strokeWidth="2.5"/></svg>
                <span style={{ color: '#8b94a6' }}>Saturación (HR=100%)</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="#f97316" strokeWidth="1.5" strokeDasharray="5,3"/></svg>
                <span style={{ color: '#8b94a6' }}>Umbral humectación (T&gt;10°C, HR=79%)</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="12" height="12"><circle cx="6" cy="6" r="3" fill="#22c55e" fillOpacity="0.6"/></svg>
                <span style={{ color: '#8b94a6' }}>Mediciones</span>
              </span>
            </div>
          </div>
        )}

        {/* d.4) Movilidad mes × hora — heatmap (igual a Analysis) */}
        {tab === 'mobility' && mobilityT.length > 0 && (() => {
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
            <div>
              <p style={{ fontSize: 11, color: '#5b6577', marginBottom: 10 }}>
                Temperatura y HR promedio por mes y hora del día
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {[
                  { label: 'T promedio (°C)', mat: matT,  min: tMinM, max: tMaxM, type: 'TEMP', unit: '°C' },
                  { label: 'HR promedio (%)', mat: matHR, min: hMinM, max: hMaxM, type: 'HR',   unit: '%'  },
                ].map(({ label, mat, min, max, type, unit }) => (
                  <div key={label} style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: '#8b94a6', marginBottom: 6, fontWeight: 600 }}>{label}</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', fontSize: 9 }}>
                        <thead>
                          <tr>
                            <th style={{ padding: '2px 6px', color: '#5b6577', textAlign: 'left' }}>M\H</th>
                            {HORAS.map(h => <th key={h} style={{ padding: '1px', color: '#5b6577', minWidth: 22 }}>{String(h).padStart(2,'0')}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {MESES.map((m, mi) => (
                            <tr key={m}>
                              <td style={{ padding: '1px 6px', color: '#8b94a6', fontWeight: 600 }}>{m}</td>
                              {HORAS.map(h => {
                                const v = mat[mi][h]
                                return (
                                  <td key={h} title={v != null ? `${m} ${String(h).padStart(2,'0')}:00 → ${v}${unit}` : 'Sin dato'}
                                    style={{ background: heatColorTH(v, min, max, type), height: 18, borderRadius: 1 }} />
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
            </div>
          )
        })()}
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