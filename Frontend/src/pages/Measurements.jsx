import { useState, useEffect, useRef } from 'react'
import * as d3 from 'd3'
import {
  AreaChart, Area, LineChart, Line, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ReferenceLine, Brush, ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { localAnalysisApi } from '../services/api'
import { Loader2, AlertTriangle, FileText, FolderOpen, X, Download } from 'lucide-react'

const SPIN = { animation: 'spin 0.8s linear infinite' }

const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
const DOY_MONTH_START = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
const HOUR_TICKS = Array.from({ length: 24 }, (_, i) => i)
const fmtHour = h => `${String(h).padStart(2, '0')}:00`

const VARIABLES = [
  { key: 'temperatura', label: 'Temperatura',      code: 'TEMP',   unit: '°C',  color: '#ef4444' },
  { key: 'humedad',     label: 'Humedad Relativa', code: 'HR',     unit: '%',   color: '#3b82f6' },
  { key: 'viento',      label: 'Viento',           code: 'VIENTO', unit: ' m/s', color: '#22c55e' },
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

// ── Paleta FDP igual a Analysis ───────────────────────────────
const GAUSS_COLORS = ['#f97316', '#22c55e', '#a78bfa', '#facc15']
const BETA_COLORS  = ['#8b94a6', '#eab308', '#38bdf8', '#4ade80', '#c084fc']
const WB_COLORS    = ['#4ade80', '#c084fc', '#f87171', '#38bdf8', '#facc15']
const FDP_SUMA_COLOR = '#e2e8f0'
const FDP_FREC_COLOR = '#ef4444'

// ── Viento ────────────────────────────────────────────────────
const SPEED_BIN_COLORS = ['#1e3a8a', '#2563eb', '#22d3ee', '#84cc16', '#facc15', '#dc2626']
const DIR16_ES = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO']

// ══════════════════════════════════════════════════════════════
// UI helpers (mismos que Analysis)
// ══════════════════════════════════════════════════════════════
const Card = ({ children, style = {} }) => (
  <div style={{
    background: '#161a21', border: '1px solid #272d37',
    borderRadius: 12, padding: '20px', marginBottom: 20, ...style
  }}>
    {children}
  </div>
)

const Err = ({ msg }) => (
  <div style={{ padding: '12px 16px', background: '#ef444420', border: '1px solid #ef444440', borderRadius: 8, color: '#ef4444', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
    <AlertTriangle size={16} style={{ flexShrink: 0 }} /> {msg}
  </div>
)

const NoData = ({ msg }) => (
  <div style={{ textAlign: 'center', color: '#8b94a6', padding: '3rem 0', fontSize: 14 }}>{msg}</div>
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

// ── Exportar un nodo (gráfico o tabla) a PDF ──────────────────
const slugify = (s) =>
  (s || 'grafico').toString().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'grafico'

async function exportNodeToPdf(node, rawName) {
  if (!node) return
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas-pro'),
    import('jspdf'),
  ])
  const canvas = await html2canvas(node, {
    backgroundColor: '#161a21',
    scale: 2,
    useCORS: true,
    logging: false,
  })
  const imgData = canvas.toDataURL('image/png')
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageW  = pdf.internal.pageSize.getWidth()
  const pageH  = pdf.internal.pageSize.getHeight()
  const margin = 10
  const imgW   = pageW - margin * 2
  const imgH   = (canvas.height * imgW) / canvas.width
  const usableH = pageH - margin * 2

  if (imgH <= usableH) {
    pdf.addImage(imgData, 'PNG', margin, margin, imgW, imgH)
  } else {
    let position = 0, page = 0
    while (position < imgH) {
      if (page > 0) pdf.addPage()
      pdf.addImage(imgData, 'PNG', margin, margin - position, imgW, imgH)
      position += usableH
      page++
    }
  }
  pdf.save(`${slugify(rawName)}.pdf`)
}

function PdfButton({ targetRef, name, label = 'PDF', style = {} }) {
  const [busy, setBusy] = useState(false)
  const handle = async () => {
    if (busy) return
    setBusy(true)
    try { await exportNodeToPdf(targetRef.current, name) }
    catch (e) { console.error('PDF export failed:', e); alert('No se pudo generar el PDF: ' + (e?.message || e)) }
    finally { setBusy(false) }
  }
  return (
    <button
      data-html2canvas-ignore
      onClick={handle}
      disabled={busy}
      title="Descargar en PDF"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 12px', borderRadius: 8, border: '1px solid #272d37',
        background: '#0f1217', color: busy ? '#5b6577' : '#8b94a6',
        fontSize: 12, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      {busy ? <Loader2 size={13} style={SPIN} /> : <Download size={13} />}
      {busy ? 'Generando…' : label}
    </button>
  )
}

const SectionCard = ({ title, subtitle, children, badge }) => {
  const ref = useRef(null)
  return (
    <Card>
      <div ref={ref} style={{ background: '#161a21' }}>
        <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#e7eaf0' }}>{title}</h3>
            {subtitle && <div style={{ margin: '4px 0 0', fontSize: 12, color: '#8b94a6' }}>{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {badge}
            <PdfButton targetRef={ref} name={title} />
          </div>
        </div>
        {children}
      </div>
    </Card>
  )
}

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

// ══════════════════════════════════════════════════════════════
// FDP ENRICHMENT (igual a Analysis)
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

// Weibull: el backend ya trae wb1/wb2/wb3 y model en cada punto de la FDP.
function prepareFDPWeibull(fdp, weibulls) {
  if (!fdp?.length) return []
  return fdp.map(point => {
    const enriched = { ...point }
    enriched.sumaGauss = point.model != null ? parseFloat(point.model.toFixed(7)) : 0
    ;(weibulls ?? []).forEach((_, i) => {
      const key = `wb${i + 1}`
      enriched[key] = point[key] != null ? parseFloat(point[key].toFixed(7)) : 0
    })
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

// Ancho responsivo del contenedor para dimensionar los SVG
function useSvgWidth(initial = 700) {
  const ref = useRef(null)
  const [w, setW] = useState(initial)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(entries => {
      const cw = entries[0]?.contentRect?.width
      if (cw > 0) setW(Math.floor(cw))
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

// ══════════════════════════════════════════════════════════════
// VIENTO — rosa de vientos y dispersión direccional (igual a Analysis)
// ══════════════════════════════════════════════════════════════
function WindRoseSVG({ sectors, valueKey = 'pct', stacked = false, fill = 'var(--accent)', binColors = SPEED_BIN_COLORS, binLabels = [], size = 300 }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !sectors?.length) return
    const svg = d3.select(ref.current); svg.selectAll('*').remove()
    const cx = size / 2, cy = size / 2, R = size / 2 - 34
    const maxVal = stacked
      ? d3.max(sectors, s => (s.bins || []).reduce((a, b) => a + b, 0)) || 1
      : d3.max(sectors, s => s[valueKey]) || 1
    const rScale = d3.scaleLinear().domain([0, maxVal]).range([0, R])
    const arc = d3.arc()
    const g = svg.append('g').attr('transform', `translate(${cx},${cy})`)

    rScale.ticks(4).filter(t => t > 0).forEach(t => {
      g.append('circle').attr('r', rScale(t)).attr('fill', 'none')
        .attr('stroke', '#272d37').attr('stroke-dasharray', '2,3')
      g.append('text').attr('x', 2).attr('y', -rScale(t) - 2)
        .attr('fill', '#5b6577').attr('font-size', 8)
        .text(stacked ? t.toLocaleString() : `${t}%`)
    })

    // Radios de los 16 sectores (los "rayos" de la rosa)
    DIR16_ES.forEach((_, i) => {
      const a = i * 22.5 * Math.PI / 180
      g.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', Math.sin(a) * R).attr('y2', -Math.cos(a) * R)
        .attr('stroke', '#272d37').attr('stroke-width', 0.5).attr('opacity', 0.7)
    })

    sectors.forEach(s => {
      const a0 = (s.dir_deg - 11.25) * Math.PI / 180
      const a1 = (s.dir_deg + 11.25) * Math.PI / 180
      if (stacked && s.bins) {
        let acc = 0
        s.bins.forEach((cnt, bi) => {
          if (cnt <= 0) return
          const path = arc({ innerRadius: rScale(acc), outerRadius: rScale(acc + cnt), startAngle: a0, endAngle: a1 })
          acc += cnt
          g.append('path').attr('d', path)
            .attr('fill', binColors[bi % binColors.length])
            .attr('opacity', 0.92).attr('stroke', '#0f1217').attr('stroke-width', 0.4)
            .append('title')
            .text(`${s.label}${binLabels[bi] ? ` · ${binLabels[bi]} m/s` : ''}: ${cnt.toLocaleString()}`)
        })
      } else {
        const v = s[valueKey] || 0
        g.append('path')
          .attr('d', arc({ innerRadius: 0, outerRadius: rScale(v), startAngle: a0, endAngle: a1 }))
          .attr('fill', fill).attr('opacity', 0.85)
          .attr('stroke', '#0f1217').attr('stroke-width', 0.4)
          .append('title').text(`${s.label}: ${v}${valueKey === 'pct' ? '%' : ''}`)
      }
    })

    // 16 etiquetas con jerarquía: cardinales > intercardinales > secundarias
    DIR16_ES.forEach((lbl, i) => {
      const a = i * 22.5 * Math.PI / 180
      const isCardinal = i % 4 === 0   // N, E, S, O
      const isInter    = i % 4 === 2   // NE, SE, SO, NO
      const lr = R + (isCardinal ? 18 : isInter ? 15 : 12)
      g.append('text')
        .attr('x', Math.sin(a) * lr).attr('y', -Math.cos(a) * lr)
        .attr('fill', isCardinal ? '#e7eaf0' : isInter ? '#8b94a6' : '#5b6577')
        .attr('font-size', isCardinal ? 12 : isInter ? 10 : 8)
        .attr('font-weight', isCardinal ? 700 : isInter ? 600 : 500)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .text(lbl)
    })
  }, [sectors, valueKey, stacked, fill, binColors, binLabels, size])
  return <svg ref={ref} width={size} height={size} style={{ display: 'block', margin: '0 auto' }} />
}

function WindDirScatterSVG({ points, xKey, xMax, xLabel, color = 'var(--accent)', width, height }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !points?.length) return
    const pad = { top: 14, right: 16, bottom: 44, left: 56 }
    const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom
    if (pw <= 0 || ph <= 0) return
    const x = d3.scaleLinear().domain([xKey === 'doy' ? 1 : -0.5, xMax]).range([0, pw])
    const y = d3.scaleLinear().domain([0, 360]).range([ph, 0])
    const svg = d3.select(ref.current); svg.selectAll('*').remove()
    const clipId = `mwdir-${xKey}-${Math.random().toString(36).slice(2, 8)}`
    svg.append('defs').append('clipPath').attr('id', clipId)
      .append('rect').attr('width', pw).attr('height', ph)
    const g = svg.append('g').attr('transform', `translate(${pad.left},${pad.top})`)
    g.append('rect').attr('width', pw).attr('height', ph).attr('fill', '#0a0a14')
    const plot = g.append('g').attr('clip-path', `url(#${clipId})`)

    ;[90, 180, 270].forEach(d => plot.append('line')
      .attr('x1', 0).attr('x2', pw).attr('y1', y(d)).attr('y2', y(d))
      .attr('stroke', '#272d37').attr('stroke-dasharray', '2,4').attr('opacity', 0.6))

    // Separadores de mes cuando el eje X es el día del año
    if (xKey === 'doy') {
      DOY_MONTH_START.forEach((d0, i) => {
        if (i === 0) return
        plot.append('line').attr('x1', x(d0)).attr('x2', x(d0)).attr('y1', 0).attr('y2', ph)
          .attr('stroke', '#272d37').attr('stroke-dasharray', '2,4').attr('opacity', 0.5)
      })
    }

    // Puntos: un punto por registro en v máx ± σ
    plot.append('g').selectAll('circle').data(points).join('circle')
      .attr('cx', d => x(d[xKey])).attr('cy', d => y(d.dir))
      .attr('r', 1.5).attr('fill', color).attr('opacity', 0.35)

    const compassFmt = { 0: 'N', 90: 'E', 180: 'S', 270: 'O', 360: 'N' }
    g.append('g')
      .call(d3.axisLeft(y).tickValues([0, 90, 180, 270, 360]).tickFormat(d => compassFmt[d]))
      .call(ax => ax.select('.domain').attr('stroke', '#3a424f'))
      .call(ax => ax.selectAll('.tick line').attr('stroke', '#3a424f'))
      .call(ax => ax.selectAll('.tick text').attr('fill', '#8b94a6').attr('font-size', 10))
    if (xKey === 'doy') {
      g.append('g').attr('transform', `translate(0,${ph})`)
        .call(d3.axisBottom(x).tickValues(DOY_MONTH_START).tickFormat((d, i) => MONTHS[i]))
        .call(ax => ax.select('.domain').attr('stroke', '#3a424f'))
        .call(ax => ax.selectAll('.tick line').attr('stroke', '#3a424f'))
        .call(ax => ax.selectAll('.tick text').attr('fill', '#8b94a6').attr('font-size', 9))
    } else {
      g.append('g').attr('transform', `translate(0,${ph})`)
        .call(d3.axisBottom(x).tickValues([0, 4, 8, 12, 16, 20, 23]).tickFormat(d => `${String(d).padStart(2, '0')}h`))
        .call(ax => ax.select('.domain').attr('stroke', '#3a424f'))
        .call(ax => ax.selectAll('.tick line').attr('stroke', '#3a424f'))
        .call(ax => ax.selectAll('.tick text').attr('fill', '#8b94a6').attr('font-size', 10))
    }
    g.append('text').attr('x', pw / 2).attr('y', ph + 36).attr('fill', '#c2c9d6')
      .attr('font-size', 12).attr('text-anchor', 'middle').text(xLabel)
    g.append('text').attr('transform', 'rotate(-90)').attr('x', -ph / 2).attr('y', -42)
      .attr('fill', '#c2c9d6').attr('font-size', 12).attr('text-anchor', 'middle').text('Dirección del viento')
    g.append('rect').attr('width', pw).attr('height', ph).attr('fill', 'none')
      .attr('stroke', '#3a424f').attr('stroke-width', 0.8)
  }, [points, xKey, xMax, xLabel, color, width, height])
  return <svg ref={ref} width={width} height={height} style={{ display: 'block', width: '100%', borderRadius: 8 }} />
}

// ══════════════════════════════════════════════════════════════
// a) VISUALIZACIÓN GENERAL (igual a Analysis SectionOverview)
// ══════════════════════════════════════════════════════════════
function OverviewCard({ variable, res }) {
  const stats = res.stats
  const serie = res.serie ?? []

  return (
    <SectionCard
      title={`${variable.label} (${variable.code})`}
      subtitle={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#8b94a6' }}>
            {fmt(stats.date_start)} → {fmt(stats.date_end)}
          </span>
          <CompletitudBadge pct={stats.completitud_pct} color={stats.completitud_color} />
        </div>
      }
    >
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
        ].map(({ l, v }) => (
          <StatBox key={l} label={l} value={l === 'N' ? v.toLocaleString() : v} unit={l === 'N' ? '' : variable.unit} color={variable.color} />
        ))}
      </div>

      {stats.anomalies_count > 0 && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f59e0b20', border: '1px solid #f59e0b40', borderRadius: 6, fontSize: 12, color: '#f59e0b' }}>
          ⚠️ {stats.anomalies_count} valores anómalos detectados (|v − μ| &gt; 3σ = ±{stats.anomaly_threshold?.toFixed(2)}{variable.unit}) — revisar si deben descartarse
          {stats.anomaly_values?.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, color: '#fbbf24' }}>
              Valores: {stats.anomaly_values.slice(0, 10).map(v => `${v}${variable.unit}`).join(', ')}{stats.anomaly_values.length > 10 ? ' …' : ''}
            </div>
          )}
        </div>
      )}

      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={serie} margin={{ top: 8, right: 50, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`ovg-${variable.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={variable.color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={variable.color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
          <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: '#8b94a6' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit={variable.unit} width={48}
            domain={variable.key === 'humedad' ? [0, 100] : ['auto', 'auto']}
            label={{ value: `${variable.code} (${variable.unit.trim()})`, angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#5b6577' }} />
          <Tooltip labelFormatter={fmt} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
          <ReferenceLine y={stats.mean} stroke={variable.color} strokeDasharray="4 2" label={{ value: `μ=${stats.mean?.toFixed(1)}${variable.unit}`, fontSize: 10, fill: variable.color, position: 'right' }} />
          <ReferenceLine y={stats.q25} stroke="#f97316" strokeDasharray="2 4" label={{ value: 'Q25', fontSize: 9, fill: '#f97316', position: 'right' }} />
          <ReferenceLine y={stats.q75} stroke="#f97316" strokeDasharray="2 4" label={{ value: 'Q75', fontSize: 9, fill: '#f97316', position: 'right' }} />
          <Area type="monotone" dataKey="max" name="Máx"      stroke={variable.color} fill="none" strokeWidth={1} opacity={0.4} dot={false} />
          <Area type="monotone" dataKey="avg" name="Promedio" stroke={variable.color} fill={`url(#ovg-${variable.key})`} strokeWidth={2} dot={false} />
          <Area type="monotone" dataKey="min" name="Mín"      stroke={variable.color} fill="none" strokeWidth={1} opacity={0.4} dot={false} />
          <Legend verticalAlign="top" height={28} />
          <Brush dataKey="period" height={28} stroke="#272d37" fill="#0f1217" tickFormatter={fmt} travellerWidth={10} gap={5} />
        </AreaChart>
      </ResponsiveContainer>
    </SectionCard>
  )
}

// ══════════════════════════════════════════════════════════════
// b) FDP (igual a Analysis SectionFDP)
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

const WeibullCards = ({ weibulls }) => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
    {(weibulls ?? []).map((c, i) => (
      <div key={i} style={{ background: '#0f1217', borderRadius: 8, padding: '8px 12px', borderLeft: `3px solid ${WB_COLORS[i % WB_COLORS.length]}` }}>
        <div style={{ fontSize: 11, color: WB_COLORS[i % WB_COLORS.length], marginBottom: 4, fontWeight: 700 }}>Viento {i + 1}</div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>v<sub>máx</sub> = <strong>{c.vmax?.toFixed(2)} m/s</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>σ = <strong>{c.sigma?.toFixed(2)}</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>λ = <strong>{c.lambda?.toFixed(2)}</strong> · k = <strong>{c.k?.toFixed(2)}</strong></div>
        <div style={{ fontSize: 12, color: '#e7eaf0' }}>w = <strong>{((c.w ?? 0) * 100).toFixed(1)}%</strong></div>
      </div>
    ))}
  </div>
)

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

function SectionFDPLocal({ tRes, hRes, wRes }) {
  const tPaso = tRes?.fdp_resolution ?? 0.1
  const tFdp = tRes ? prepareFDPGaussian(tRes.fdp, tRes.gaussians ?? [], tPaso) : []
  const hFdp = hRes ? prepareFDPBeta(hRes.fdp, hRes.betas ?? []) : []
  const wWeibulls = wRes?.weibulls ?? []
  const wFdp = wRes ? prepareFDPWeibull(wRes.fdp, wWeibulls) : []
  // Diagramas de control del ajuste Weibull (Fig. 5 y 6 del artículo)
  const wRegData = wFdp.map(p => ({ real: p.freq, model: p.sumaGauss }))
  const wMaxReg  = d3.max(wRegData, d => Math.max(d.real, d.model)) || 0.001

  if (!tRes && !hRes && !wRes) return <NoData msg="Subí al menos un archivo y hacé clic en Analizar para ver la FDP." />

  return (
    <>
      {tRes && (
        <SectionCard
          title="FDP — Temperatura (Gaussianas)"
          subtitle={`R² = ${tRes.r2?.toFixed(4) ?? '—'} · EMC = ${tRes.mse?.toExponential(2) ?? '—'} · N = ${tRes.stats?.n?.toLocaleString()} · Resolución: ${tPaso}°C/bin`}
          badge={<QualityBadge quality={tRes.quality} />}
        >
          <GaussianCards gaussians={tRes.gaussians ?? []} unit="°C" />
          <div style={{ marginBottom: 12, padding: '6px 12px', background: '#0f1217', borderRadius: 6, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
            freq[bin] = count[bin] / N_total · paso = {tPaso}°C · modelo(x) = Σ w_i · N(x|μ_i,σ_i) · {tPaso}
          </div>
          <FDPLegend components={tRes.gaussians ?? []} colors={GAUSS_COLORS} sumaLabel="Gauss suma" isGauss={true} />
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={tFdp} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#272d37" strokeOpacity={0.5} />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#8b94a6' }} unit="°C" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => v?.toFixed(1)}
                ticks={(() => { if (!tFdp.length) return []; const mn = Math.ceil(tFdp[0].x); const mx = Math.floor(tFdp[tFdp.length-1].x); const out = []; for (let v = mn; v <= mx; v++) out.push(v); return out })()} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(1)} />
              <Tooltip content={props => <CustomTooltip {...props} unit="°C" />} />
              <Line type="monotone" dataKey="freq" name="Frec norm" stroke={FDP_FREC_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} legendType="none" />
              {(tRes.gaussians ?? []).map((g, i) => (
                <Line key={`gauss${i+1}`} type="monotone" dataKey={`gauss${i+1}`} name={`Gauss ${i+1}`} stroke={GAUSS_COLORS[i] ?? '#8b94a6'} strokeWidth={1.5} dot={false} isAnimationActive={false} legendType="none" />
              ))}
              <Line type="monotone" dataKey="sumaGauss" name="Gauss suma" stroke={FDP_SUMA_COLOR} strokeWidth={3} dot={false} isAnimationActive={false} legendType="none" />
              {(tRes.gaussians ?? []).map((g, i) => (
                <ReferenceLine key={`ref${i}`} x={parseFloat(g.mu?.toFixed(1))} stroke={`${GAUSS_COLORS[i] ?? '#5b6577'}80`} strokeDasharray="4 2"
                  label={{ value: `μ${i+1}=${g.mu?.toFixed(1)}°C`, fontSize: 9, fill: GAUSS_COLORS[i] ?? '#5b6577', position: 'insideTopRight' }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
            <StatBox label="R²"      value={tRes.r2?.toFixed(4)  ?? '—'} color="#22c55e" />
            <StatBox label="EMC"     value={tRes.mse?.toExponential(2) ?? '—'} color={tRes.quality?.mse_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Err máx" value={tRes.quality?.max_error_range?.toFixed(5) ?? '—'} color={tRes.quality?.error_range_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Σw"      value={tRes.quality?.weights_sum?.toFixed(4) ?? '—'} color={tRes.quality?.weights_sum_ok ? '#22c55e' : '#ef4444'} />
          </div>
        </SectionCard>
      )}

      {hRes && (
        <SectionCard
          title="FDP — Humedad Relativa (Beta generalizada)"
          subtitle={`R² = ${hRes.r2?.toFixed(4) ?? '—'} · EMC = ${hRes.mse?.toExponential(2) ?? '—'} · N = ${hRes.stats?.n?.toLocaleString()} · Resolución: 1%/bin`}
          badge={<QualityBadge quality={hRes.quality} />}
        >
          <BetaCards betas={hRes.betas ?? []} />
          <div style={{ marginBottom: 12, padding: '6px 12px', background: '#0f1217', borderRadius: 6, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
            freq[bin] = count[bin] / N_total · paso = 1% (escala [0,100]) · modelo(x) = Σ w_i · BetaGen(x|α_i,β_i,A_i,B_i) · 1
          </div>
          <FDPLegend components={hRes.betas ?? []} colors={BETA_COLORS} sumaLabel="Beta suma" isGauss={false} />
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={hFdp} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#272d37" strokeOpacity={0.5} />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#8b94a6' }} unit="%" type="number" domain={[0, 100]} tickFormatter={v => v?.toFixed(0)} ticks={[0,10,20,30,40,50,60,70,80,90,100]} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(1)} />
              <Tooltip content={props => <CustomTooltip {...props} unit="%" />} />
              <Line type="monotone" dataKey="freq"      name="Frec norm" stroke={FDP_FREC_COLOR} strokeWidth={2}   dot={false} isAnimationActive={false} legendType="none" />
              {(hRes.betas ?? []).map((b, i) => (
                <Line key={`beta${i+1}`} type="monotone" dataKey={`beta${i+1}`} name={`Beta ${i+1}`} stroke={BETA_COLORS[i] ?? '#8b94a6'} strokeWidth={1.5} dot={false} isAnimationActive={false} legendType="none" />
              ))}
              <Line type="monotone" dataKey="sumaGauss" name="Beta suma"  stroke={FDP_SUMA_COLOR} strokeWidth={3}   dot={false} isAnimationActive={false} legendType="none" />
              {(hRes.betas ?? []).map((b, i) => (
                <ReferenceLine key={`ref${i}`} x={b.mode} stroke={`${BETA_COLORS[i] ?? '#5b6577'}80`} strokeDasharray="4 2"
                  label={{ value: `m${i+1}=${b.mode?.toFixed(1)}%`, fontSize: 9, fill: BETA_COLORS[i] ?? '#5b6577', position: 'insideTopRight' }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
            <StatBox label="R²"      value={hRes.r2?.toFixed(4)  ?? '—'} color="#22c55e" />
            <StatBox label="EMC"     value={hRes.mse?.toExponential(2) ?? '—'} color={hRes.quality?.mse_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Err máx" value={hRes.quality?.max_error_range?.toFixed(5) ?? '—'} color={hRes.quality?.error_range_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Σw"      value={hRes.quality?.weights_sum?.toFixed(4) ?? '—'} color={hRes.quality?.weights_sum_ok ? '#22c55e' : '#ef4444'} />
          </div>
        </SectionCard>
      )}

      {wRes && wWeibulls.length > 0 && (
        <SectionCard
          title="FDP — Viento (descomposición de curvas Weibull)"
          subtitle={`R² = ${wRes.r2?.toFixed(4) ?? '—'} · EMC = ${wRes.mse?.toExponential(2) ?? '—'} · N = ${wRes.stats?.n?.toLocaleString()} · Resolución: 0.1 m/s`}
          badge={<QualityBadge quality={wRes.quality} />}
        >
          <WeibullCards weibulls={wWeibulls} />
          <div style={{ marginBottom: 12, padding: '6px 12px', background: '#0f1217', borderRadius: 6, fontSize: 11, color: '#5b6577', fontFamily: 'monospace' }}>
            f(v) = (k/λ)(v/λ)^(k−1)·e^(−(v/λ)^k) · modelo(v) = Σ w_i · WB(v|k_i,λ_i) · 0.1
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8, fontSize: 11, alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width="24" height="4"><line x1="0" y1="2" x2="24" y2="2" stroke={FDP_FREC_COLOR} strokeWidth="2"/></svg>
              <span style={{ color: '#8b94a6' }}>Frec norm</span>
            </span>
            {wWeibulls.map((c, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="24" height="4"><line x1="0" y1="2" x2="24" y2="2" stroke={WB_COLORS[i % WB_COLORS.length]} strokeWidth="1.5"/></svg>
                <span style={{ color: '#8b94a6' }}>Viento {i + 1} (v máx={c.vmax?.toFixed(1)} m/s)</span>
              </span>
            ))}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width="24" height="5"><line x1="0" y1="2.5" x2="24" y2="2.5" stroke={FDP_SUMA_COLOR} strokeWidth="3"/></svg>
              <span style={{ color: '#8b94a6' }}>WB suma</span>
            </span>
          </div>
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={wFdp} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#272d37" strokeOpacity={0.5} />
              <XAxis dataKey="x" tick={{ fontSize: 10, fill: '#8b94a6' }} unit=" m/s" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => v?.toFixed(0)} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(1)} />
              <Tooltip content={props => <CustomTooltip {...props} unit=" m/s" />} />
              <Line type="monotone" dataKey="freq" name="Frec norm" stroke={FDP_FREC_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} legendType="none" />
              {wWeibulls.map((c, i) => (
                <Line key={`wb${i + 1}`} type="monotone" dataKey={`wb${i + 1}`} name={`Viento ${i + 1}`} stroke={WB_COLORS[i % WB_COLORS.length]} strokeWidth={1.5} dot={false} isAnimationActive={false} legendType="none" />
              ))}
              <Line type="monotone" dataKey="sumaGauss" name="WB suma" stroke={FDP_SUMA_COLOR} strokeWidth={3} dot={false} isAnimationActive={false} legendType="none" />
              {wWeibulls.map((c, i) => (
                <ReferenceLine key={`ref${i}`} x={c.vmax} stroke={`${WB_COLORS[i % WB_COLORS.length]}80`} strokeDasharray="4 2"
                  label={{ value: `v${i + 1}=${c.vmax?.toFixed(1)}`, fontSize: 9, fill: WB_COLORS[i % WB_COLORS.length], position: 'insideTopRight' }} />
              ))}
            </LineChart>
          </ResponsiveContainer>

          {/* Diagramas de control: regresión real vs modelo y error por punto */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#8b94a6', marginBottom: 6, fontWeight: 600 }}>Regresión: real vs modelo (R² = {wRes.r2?.toFixed(4) ?? '—'})</div>
              <ResponsiveContainer width="100%" height={220}>
                <ScatterChart margin={{ top: 8, right: 12, left: -6, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#272d37" strokeOpacity={0.5} />
                  <XAxis type="number" dataKey="real" name="Real" domain={[0, wMaxReg]} tick={{ fontSize: 9, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(0)} />
                  <YAxis type="number" dataKey="model" name="Modelo" domain={[0, wMaxReg]} tick={{ fontSize: 9, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(0)} />
                  <ZAxis range={[16, 16]} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: wMaxReg, y: wMaxReg }]} stroke="#5b6577" strokeDasharray="4 3" />
                  <Scatter data={wRegData} fill="var(--accent)" fillOpacity={0.5} isAnimationActive={false} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#8b94a6', marginBottom: 6, fontWeight: 600 }}>Error por punto (real − modelo)</div>
              <ResponsiveContainer width="100%" height={220}>
                <ScatterChart margin={{ top: 8, right: 12, left: -6, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#272d37" strokeOpacity={0.5} />
                  <XAxis type="number" dataKey="x" name="Velocidad" domain={['dataMin', 'dataMax']} tick={{ fontSize: 9, fill: '#8b94a6' }} tickFormatter={v => v?.toFixed(0)} unit=" m/s" />
                  <YAxis type="number" dataKey="error_range" name="Error" tick={{ fontSize: 9, fill: '#8b94a6' }} tickFormatter={v => v.toExponential(0)} />
                  <ZAxis range={[16, 16]} />
                  <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 3" />
                  <Tooltip contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }}
                    formatter={(v, name) => [typeof v === 'number' ? v.toExponential(2) : v, name]}
                    labelFormatter={() => ''} />
                  <Scatter data={wFdp} fill="#f59e0b" fillOpacity={0.6} isAnimationActive={false} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
            <StatBox label="R²"      value={wRes.r2?.toFixed(4) ?? '—'} color="#22c55e" />
            <StatBox label="EMC"     value={wRes.mse?.toExponential(2) ?? '—'} color={wRes.quality?.mse_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Err máx" value={wRes.quality?.max_error_range?.toFixed(5) ?? '—'} color={wRes.quality?.error_range_ok ? '#22c55e' : '#ef4444'} />
            <StatBox label="Σw"      value={wRes.quality?.weights_sum?.toFixed(4) ?? '—'} color={wRes.quality?.weights_sum_ok ? '#22c55e' : '#ef4444'} />
          </div>
        </SectionCard>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// c.2) PERFIL DIARIO (igual a Analysis SectionDailyProfile)
// ══════════════════════════════════════════════════════════════
function SectionDailyProfileLocal({ tRes, hRes }) {
  const [selMonth, setSelMonth] = useState('0')

  const tProfile = tRes?.daily_profile
  const hProfile = hRes?.daily_profile
  if (!tProfile && !hProfile) {
    return <NoData msg="Subí un archivo de Temperatura o Humedad Relativa para ver el perfil diario." />
  }

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

      {tProfile && (
        <SectionCard
          title={`Temperatura — Perfil diario (${monthLabel})`}
          subtitle="Estadísticos horarios"
        >
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={tData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="mtpg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
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
              <Area type="monotone" dataKey="max"  name="Máx"      stroke="#ef4444" fill="none"       strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="q75"  name="Q75"      stroke="#f97316" fill="none"       strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="avg"  name="Promedio" stroke="#ef4444" fill="url(#mtpg)" strokeWidth={2} dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="mode" name="Moda"     stroke="#fbbf24" fill="none"       strokeWidth={1} strokeDasharray="6 2" dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="q25"  name="Q25"      stroke="#f97316" fill="none"       strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="min"  name="Mín"      stroke="#ef4444" fill="none"       strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {hProfile && (
        <SectionCard
          title={`Humedad Relativa — Perfil diario (${monthLabel})`}
          subtitle="Estadísticos horarios (moda como estadístico principal)"
        >
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={hData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="mhpg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
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
              <Area type="monotone" dataKey="max"  name="Máx"      stroke="#3b82f6" fill="none"       strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="q75"  name="Q75"      stroke="#6366f1" fill="none"       strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="avg"  name="Promedio" stroke="#3b82f6" fill="url(#mhpg)" strokeWidth={2} dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="mode" name="Moda"     stroke="#a78bfa" fill="none"       strokeWidth={2} strokeDasharray="6 2" dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="q25"  name="Q25"      stroke="#6366f1" fill="none"       strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="min"  name="Mín"      stroke="#3b82f6" fill="none"       strokeWidth={1} opacity={0.5} dot={false} connectNulls={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  )
}

// ══════════════════════════════════════════════════════════════
// c.3) PERFIL ANUAL (igual a Analysis SectionAnnualProfile)
// ══════════════════════════════════════════════════════════════
function SectionAnnualProfileLocal({ tRes, hRes }) {
  const [smoothW, setSmoothW] = useState(14)

  const tProfile = tRes?.annual_profile
  const hProfile = hRes?.annual_profile
  if (!tProfile && !hProfile) {
    return <NoData msg="Subí un archivo de Temperatura o Humedad Relativa para ver el perfil anual." />
  }

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
                <linearGradient id="mtag" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="doy" tickFormatter={fmtDoy} ticks={DOY_MONTH_START} tick={{ fontSize: 10, fill: '#8b94a6' }} height={40}
                label={{ value: 'Día del año', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#5b6577' }} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="°C" width={52}
                label={{ value: 'T (°C)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#5b6577' }} />
              <Tooltip labelFormatter={fmtDoy} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <Legend verticalAlign="top" height={28} />
              <Area type="monotone" dataKey="max" name="Máx" stroke="#ef4444" fill="url(#mtag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Area type="monotone" dataKey="min" name="Mín" stroke="#ef4444" fill="url(#mtag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Line type="monotone" dataKey="avg" name="Media diaria (bruto)" stroke="#ef444470" strokeWidth={1} strokeDasharray="3 2" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="avg_smooth" name={`Media móvil ${smoothW}d`} stroke="#ef4444" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q75" name="Q75" stroke="#f9731660" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q25" name="Q25" stroke="#f9731660" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              {DOY_MONTH_START.map((d, i) => (
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
                <linearGradient id="mhag" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161a21" />
              <XAxis dataKey="doy" tickFormatter={fmtDoy} ticks={DOY_MONTH_START} tick={{ fontSize: 10, fill: '#8b94a6' }} height={40}
                label={{ value: 'Día del año', position: 'insideBottom', offset: -10, fontSize: 11, fill: '#5b6577' }} />
              <YAxis tick={{ fontSize: 10, fill: '#8b94a6' }} unit="%" domain={[0, 100]} width={52}
                label={{ value: 'HR (%)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11, fill: '#5b6577' }} />
              <Tooltip labelFormatter={fmtDoy} contentStyle={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 8, fontSize: 12 }} />
              <Legend verticalAlign="top" height={28} />
              <Area type="monotone" dataKey="max" name="Máx" stroke="#3b82f6" fill="url(#mhag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Area type="monotone" dataKey="min" name="Mín" stroke="#3b82f6" fill="url(#mhag)" strokeWidth={1} opacity={0.35} dot={false} legendType="none" />
              <Line type="monotone" dataKey="avg" name="Moda diaria (bruto)" stroke="#3b82f670" strokeWidth={1} strokeDasharray="3 2" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="avg_smooth" name={`Media móvil ${smoothW}d`} stroke="#3b82f6" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q75" name="Q75" stroke="#6366f160" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="q25" name="Q25" stroke="#6366f160" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              {DOY_MONTH_START.map((d, i) => (
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
// e.1 / e.2) ROSA DE VIENTOS (igual a Analysis SectionWindRose)
// ══════════════════════════════════════════════════════════════
function SectionWindRoseLocal({ rose, mode }) {
  const [containerRef, svgW] = useSvgWidth()

  // Bandas de 1 m/s compartidas por las rosas por viento, con la rampa
  // amarillo (lento) → púrpura (rápido) del artículo (plasma invertida)
  const wbBinLabels = rose?.wind_speed_bins ?? []
  const wbBinColors = wbBinLabels.map((_, i) =>
    d3.interpolatePlasma(wbBinLabels.length > 1 ? 0.95 - 0.9 * i / (wbBinLabels.length - 1) : 0.5))

  if (!rose) return null

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {mode === 'general' && rose.general && (
        <SectionCard
          title="Rosa de los vientos — general"
          subtitle={`${rose.n?.toLocaleString()} registros · 16 direcciones · frecuencia por banda de velocidad`}
        >
          <WindRoseSVG sectors={rose.general} stacked size={Math.min(420, svgW)} />
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 10, fontSize: 11 }}>
            {(rose.speed_bins ?? []).map((lb, i) => (
              <span key={lb} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 2, background: SPEED_BIN_COLORS[i % SPEED_BIN_COLORS.length] }} />
                <span style={{ color: '#8b94a6' }}>{lb} m/s</span>
              </span>
            ))}
          </div>
        </SectionCard>
      )}

      {mode === 'by_wind' && (
        rose.by_wind?.length > 0 ? (
          <SectionCard
            title="Rosa de los vientos — por cada viento (v máx ± σ)"
            subtitle="Distribución direccional por banda de velocidad de los registros cercanos al máximo de cada curva Weibull"
          >
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${Math.min(280, svgW)}px, 1fr))`, gap: 16 }}>
              {rose.by_wind.map((wnd, i) => (
                <div key={wnd.comp} style={{ minWidth: 0, textAlign: 'center' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: WB_COLORS[i % WB_COLORS.length], marginBottom: 4 }}>
                    Viento {wnd.comp} · {wnd.vmax?.toFixed(2)} m/s
                  </div>
                  <div style={{ fontSize: 11, color: '#5b6577', marginBottom: 4 }}>{wnd.n?.toLocaleString()} registros</div>
                  <WindRoseSVG sectors={wnd.sectors} stacked binColors={wbBinColors} binLabels={wbBinLabels} size={Math.min(280, svgW - 20)} />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 12, fontSize: 11 }}>
              {wbBinLabels.map((lb, i) => (
                <span key={lb} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 2, background: wbBinColors[i] }} />
                  <span style={{ color: '#8b94a6' }}>{lb} m/s</span>
                </span>
              ))}
            </div>
          </SectionCard>
        ) : (
          <NoData msg="Aún no hay ajuste Weibull para separar los vientos." />
        )
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// e.3 / e.4) VIENTO × AÑO y VIENTO × HORA (igual a Analysis SectionWindDir)
// ══════════════════════════════════════════════════════════════
function SectionWindDirLocal({ directional, xKey }) {
  const [containerRef, svgW] = useSvgWidth()
  const isYear = xKey === 'doy'

  if (!directional?.components?.length) {
    return <NoData msg="Sin datos direccionales de viento en el archivo subido." />
  }

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <SectionCard
        title={isYear
          ? 'Cada viento durante el año — dirección vs día del año'
          : 'Cada viento durante el día — dirección vs hora'}
        subtitle={isYear
          ? 'Un punto por registro en v máx ± σ de cada viento (estacionalidad)'
          : 'Un punto por registro en v máx ± σ de cada viento (ciclo diurno / brisas valle-montaña)'}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 18 }}>
          {directional.components.map((c, i) => (
            <div key={c.comp} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: WB_COLORS[i % WB_COLORS.length], marginBottom: 4 }}>
                Viento {c.comp} · {c.vmax?.toFixed(2)} m/s ({c.n_total?.toLocaleString()} registros)
              </div>
              <WindDirScatterSVG
                points={c.points}
                xKey={xKey}
                xMax={isYear ? 366 : 23.5}
                xLabel={isYear ? 'Día del año (mes)' : 'Hora del día'}
                color={WB_COLORS[i % WB_COLORS.length]}
                width={svgW}
                height={Math.round(svgW * 0.3)}
              />
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// DROP ZONE
// ══════════════════════════════════════════════════════════════
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
        <input ref={ref} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }}
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

// ══════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════
const TABS = [
  { id: 'overview',       label: 'a) Visualización general' },
  { id: 'fdp',            label: 'b) FDP'                   },
  { id: 'daily-profile',  label: 'c.2) Perfil diario'       },
  { id: 'annual-profile', label: 'c.3) Perfil anual'        },
  { id: 'wind-rose',      label: 'e.1) Rosa de vientos'     },
  { id: 'wind-rose-each', label: 'e.2) Rosa por viento'     },
  { id: 'wind-year',      label: 'e.3) Viento × año'        },
  { id: 'wind-hour',      label: 'e.4) Viento × hora'       },
]

export default function Measurements() {
  const [archivos,   setArchivos]   = useState({ temperatura: null, humedad: null, viento: null })
  const [procesando, setProcesando] = useState({})
  const [resultados, setResultados] = useState({})
  const [errores,    setErrores]    = useState({})
  const [activeTab,  setActiveTab]  = useState('overview')

  const handleFile   = (key, file) => { setArchivos(p => ({ ...p, [key]: file })); setResultados(p => ({ ...p, [key]: null })); setErrores(p => ({ ...p, [key]: '' })) }
  const handleQuitar = (key)       => { setArchivos(p => ({ ...p, [key]: null })); setResultados(p => ({ ...p, [key]: null })); setErrores(p => ({ ...p, [key]: '' })) }

  const hayArchivos    = Object.values(archivos).some(Boolean)
  const algoProcesando = Object.values(procesando).some(Boolean)

  const handleAnalizar = async () => {
    // Procesar cada variable en paralelo con la misma matemática del flujo de
    // carga de datos: T = 2 gaussianas, HR = 5 betas, viento = 3 Weibull.
    const promises = VARIABLES.filter(v => archivos[v.key]).map(async (v) => {
      setProcesando(p => ({ ...p, [v.key]: true }))
      setErrores(p => ({ ...p, [v.key]: '' }))
      try {
        const res = await localAnalysisApi.analyzeFile(archivos[v.key], v.key)
        setResultados(p => ({ ...p, [v.key]: res }))
      } catch (e) {
        setErrores(p => ({ ...p, [v.key]: e.message }))
      } finally {
        setProcesando(p => ({ ...p, [v.key]: false }))
      }
    })
    await Promise.all(promises)
  }

  const tRes = resultados.temperatura
  const hRes = resultados.humedad
  const vRes = resultados.viento
  const hayResultados = Boolean(tRes || hRes || vRes)

  const rose        = vRes?.wind?.rose
  const directional = vRes?.wind?.directional
  const windMsg = vRes
    ? (vRes.wind_error || 'El archivo de viento no incluye dirección (formato IMN con velocidad + dirección); solo se pudo calcular la FDP de velocidad.')
    : 'Subí un archivo de viento (formato IMN con velocidad + dirección) para ver este gráfico.'

  return (
    <div style={{ padding: '2rem 2.5rem', maxWidth: 1200 }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '1.75rem', fontWeight: 800, color: '#e7eaf0' }}>Mediciones</h1>
        <p style={{ margin: 0, fontSize: '0.875rem', color: '#8b94a6' }}>
          Análisis local desde archivos CSV/Excel — Visualización general · FDP · Perfiles diario y anual · Viento · Sin guardar en BD
        </p>
      </div>

      {/* Panel de carga */}
      <div style={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 14 }}>
          {VARIABLES.map(v => (
            <DropZone key={v.key} variable={v} archivo={archivos[v.key]}
              onFile={f  => handleFile(v.key, f)}
              onQuitar={() => handleQuitar(v.key)} />
          ))}
        </div>

        <div style={{ fontSize: 11, color: '#5b6577', marginBottom: 14 }}>
          Se usa la misma matemática que la carga de datos: T = 2 gaussianas · HR = 5 betas generalizadas · Viento = 3 Weibull.
          El archivo de viento IMN (velocidad + dirección) habilita las rosas y los gráficos direccionales.
        </div>

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

      {/* Estado por variable */}
      {VARIABLES.map(v => {
        if (procesando[v.key]) return (
          <div key={v.key} style={{ background: '#161a21', border: '1px solid #272d37', borderRadius: 12, padding: 20, marginBottom: 16, textAlign: 'center', color: '#8b94a6', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Loader2 size={15} style={SPIN} /> Calculando {v.label} — ajustando {v.key === 'temperatura' ? '2 curvas Gaussianas' : v.key === 'humedad' ? '5 curvas Beta' : '3 curvas Weibull'}…
          </div>
        )
        if (errores[v.key]) return (
          <Err key={v.key} msg={<span><strong>{v.label}:</strong> {errores[v.key]}</span>} />
        )
        return null
      })}

      {/* Tabs + contenido */}
      {hayResultados && (
        <>
          <div style={{ display: 'flex', gap: 2, marginBottom: 20, flexWrap: 'wrap', borderBottom: '1px solid #161a21', paddingBottom: 0 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                padding: '10px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                background: 'none', border: 'none',
                color: activeTab === t.id ? 'var(--accent)' : '#8b94a6',
                borderBottom: `2px solid ${activeTab === t.id ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
              }}>
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && VARIABLES.map(v => resultados[v.key] && (
            <OverviewCard key={v.key} variable={v} res={resultados[v.key]} />
          ))}

          {activeTab === 'fdp' && <SectionFDPLocal tRes={tRes} hRes={hRes} wRes={vRes} />}

          {activeTab === 'daily-profile'  && <SectionDailyProfileLocal  tRes={tRes} hRes={hRes} />}
          {activeTab === 'annual-profile' && <SectionAnnualProfileLocal tRes={tRes} hRes={hRes} />}

          {activeTab === 'wind-rose'      && (rose ? <SectionWindRoseLocal rose={rose} mode="general" /> : <NoData msg={windMsg} />)}
          {activeTab === 'wind-rose-each' && (rose ? <SectionWindRoseLocal rose={rose} mode="by_wind" /> : <NoData msg={windMsg} />)}
          {activeTab === 'wind-year'      && (directional ? <SectionWindDirLocal directional={directional} xKey="doy"  /> : <NoData msg={windMsg} />)}
          {activeTab === 'wind-hour'      && (directional ? <SectionWindDirLocal directional={directional} xKey="hour" /> : <NoData msg={windMsg} />)}
        </>
      )}
    </div>
  )
}
