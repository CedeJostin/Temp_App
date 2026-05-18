import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import {
  BarChart2, Thermometer, Droplets, Wind,
  ChevronDown, TrendingUp, Activity, Grid3x3,
  Upload, Loader2, AlertCircle
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar, Cell
} from 'recharts'
import api from '../services/api'

const ESTACIONES = [
  { id: 1, nombre: 'Belén (84199)' },
  { id: 2, nombre: 'Heredia'       },
  { id: 3, nombre: 'Alajuela'      },
  { id: 4, nombre: 'San José'      },
  { id: 5, nombre: 'Cartago'       },
]

const VARIABLES = [
  { value: 'temperatura', label: 'Temperatura',      icon: Thermometer, unit: '°C',  color: '#f97316' },
  { value: 'humedad',     label: 'Humedad Relativa', icon: Droplets,    unit: '%',   color: '#3b82f6' },
  { value: 'viento',      label: 'Viento',           icon: Wind,        unit: 'm/s', color: '#14b8a6' },
]

const TABS = [
  { id: 'serie', label: 'Serie temporal', icon: TrendingUp },
  { id: 'fdp',   label: 'FDP',            icon: Activity   },
  { id: 'calor', label: 'Mapa de calor',  icon: Grid3x3    },
]

const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
const HORAS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2,'0')}:00`)

// ── helpers ──────────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t

const valorAColor = (val, min, max, variable) => {
  const t = Math.max(0, Math.min(1, (val - min) / (max - min)))
  let r, g, b
  if (variable === 'temperatura') {
    if (t < 0.5) {
      const t2 = t * 2
      r = Math.round(lerp(59,  250, t2))
      g = Math.round(lerp(130, 204, t2))
      b = Math.round(lerp(246, 20,  t2))
    } else {
      const t2 = (t - 0.5) * 2
      r = Math.round(lerp(250, 220, t2))
      g = Math.round(lerp(204, 38,  t2))
      b = Math.round(lerp(20,  38,  t2))
    }
  } else if (variable === 'humedad') {
    r = Math.round(lerp(240, 30,  t))
    g = Math.round(lerp(249, 64,  t))
    b = Math.round(lerp(255, 175, t))
  } else {
    r = Math.round(lerp(240, 13,  t))
    g = Math.round(lerp(249, 148, t))
    b = Math.round(lerp(255, 136, t))
  }
  return `rgb(${r},${g},${b})`
}

// ── Dropzone de archivo ───────────────────────────────────────
function ArchivoDropzone({ onArchivo, archivo }) {
  const onDrop = useCallback(files => {
    if (files[0]) onArchivo(files[0])
  }, [onArchivo])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'text/csv': ['.csv'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }, maxFiles: 1
  })

  return (
    <div
      {...getRootProps()}
      className={`border-2 border-dashed rounded-lg px-4 py-3 text-center cursor-pointer transition-colors flex items-center gap-3
        ${isDragActive
          ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
          : archivo
            ? 'border-green-300 bg-green-50 dark:bg-green-900/10'
            : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600'
        }`}
    >
      <input {...getInputProps()} />
      <Upload size={16} className={archivo ? 'text-green-500' : 'text-gray-400'} />
      <span className="text-sm text-gray-600 dark:text-gray-400 truncate">
        {archivo ? archivo.name : 'Arrastrá o seleccioná el archivo CSV / Excel'}
      </span>
    </div>
  )
}

// ── Gráfico serie temporal ────────────────────────────────────
function GraficoSerie({ serie, resumen, cfg }) {
  const muestra = serie.length > 365
    ? serie.filter((_, i) => i % Math.ceil(serie.length / 365) === 0)
    : serie

  return (
    <div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {resumen.fecha_inicio} → {resumen.fecha_fin} · {resumen.total_validos} datos válidos
      </p>

      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={muestra} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={cfg.color} stopOpacity={0.15} />
              <stop offset="95%" stopColor={cfg.color} stopOpacity={0}    />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" strokeOpacity={0.5} />
          <XAxis dataKey="fecha" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
            interval={Math.ceil(muestra.length / 8)}
          />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
            tickFormatter={v => `${v}${cfg.unit}`} width={54}
          />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
            formatter={v => v !== null ? [`${v} ${cfg.unit}`, cfg.label] : ['Sin dato', cfg.label]}
          />
          <Area type="monotone" dataKey="valor" stroke={cfg.color}
            strokeWidth={1.5} fill="url(#grad)" dot={false} activeDot={{ r: 3 }}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* Estadísticos */}
      <div className="grid grid-cols-3 gap-3 mt-5">
        {[
          { label: 'Máximo',     val: `${resumen.maximo}${cfg.unit}`    },
          { label: 'Mínimo',     val: `${resumen.minimo}${cfg.unit}`    },
          { label: 'Promedio',   val: `${resumen.promedio}${cfg.unit}`  },
          { label: 'Desv. Est.', val: `${resumen.desviacion}${cfg.unit}`},
          { label: 'Q25',        val: `${resumen.q25}${cfg.unit}`       },
          { label: 'Q75',        val: `${resumen.q75}${cfg.unit}`       },
        ].map(({ label, val }) => (
          <div key={label} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
            <div className="text-base font-semibold text-gray-800 dark:text-gray-200">{val}</div>
            <div className="text-xs text-gray-400 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Huecos largos */}
      {resumen.huecos_largos?.length > 0 && (
        <div className="mt-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-100 dark:border-orange-800 rounded-lg p-3">
          <p className="text-xs font-medium text-orange-700 dark:text-orange-400 mb-2">
            ⚠️ Huecos continuos &gt; 5 días detectados
          </p>
          <div className="space-y-1">
            {resumen.huecos_largos.map((h, i) => (
              <p key={i} className="text-xs text-orange-600 dark:text-orange-400">
                {h.inicio} → {h.fin} ({h.horas} horas)
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Gráfico FDP ───────────────────────────────────────────────
function GraficoFDP({ fdp, resumen, cfg, variable }) {
  const muestra = fdp.length > 200
    ? fdp.filter((_, i) => i % Math.ceil(fdp.length / 200) === 0)
    : fdp

  return (
    <div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Distribución de frecuencias de {cfg.label} · resolución {variable === 'temperatura' ? '0.1°C' : variable === 'humedad' ? '1%' : '0.5 m/s'}
      </p>

      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={muestra} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" strokeOpacity={0.5} />
          <XAxis dataKey="valor" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
            tickFormatter={v => `${v}${cfg.unit}`}
            interval={Math.ceil(muestra.length / 10)}
          />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
            tickFormatter={v => `${v}%`} width={40}
          />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
            formatter={v => [`${v}%`, 'Frecuencia']}
            labelFormatter={v => `${v} ${cfg.unit}`}
          />
          <Bar dataKey="frecuencia" radius={[2, 2, 0, 0]}>
            {muestra.map((_, i) => (
              <Cell key={i} fill={cfg.color} fillOpacity={0.75} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Info completitud */}
      <div className="mt-4 grid grid-cols-3 gap-3 text-center text-xs">
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
          <div className="font-semibold text-gray-800 dark:text-gray-200 text-sm">{resumen.completitud_pct}%</div>
          <div className="text-gray-400 mt-0.5">Completitud</div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
          <div className="font-semibold text-gray-800 dark:text-gray-200 text-sm">{resumen.total_validos.toLocaleString()}</div>
          <div className="text-gray-400 mt-0.5">Datos válidos</div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
          <div className="font-semibold text-gray-800 dark:text-gray-200 text-sm">{resumen.moda}{cfg.unit}</div>
          <div className="text-gray-400 mt-0.5">Moda</div>
        </div>
      </div>

      <div className="mt-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-lg p-3 text-xs text-blue-600 dark:text-blue-400">
        ℹ️ El ajuste de curvas {variable === 'humedad' ? 'Beta' : 'Gaussianas'} se integrará en la próxima fase del proyecto.
      </div>
    </div>
  )
}

// ── Mapa de calor ─────────────────────────────────────────────
function MapaCalor({ calor, cfg, variable }) {
  const vals = calor.map(d => d.valor)
  const min  = Math.min(...vals)
  const max  = Math.max(...vals)

  const getVal = (mes, hora) => {
    const p = calor.find(d => d.mes === mes + 1 && d.hora === hora)
    return p ? p.valor : null
  }

  const HORAS_LABEL = [0, 3, 6, 9, 12, 15, 18, 21]

  return (
    <div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Promedio de {cfg.label} por hora del día y mes del año · datos reales
      </p>

      <div className="overflow-x-auto">
        <div className="min-w-[580px]">
          {/* Etiquetas horas */}
          <div className="flex mb-1 ml-10">
            {HORAS_LABEL.map(h => (
              <div key={h} className="text-xs text-gray-400 text-center"
                style={{ width: `${100/8}%` }}>
                {String(h).padStart(2,'0')}:00
              </div>
            ))}
          </div>

          {/* Filas por mes */}
          {MESES.map((mes, m) => (
            <div key={mes} className="flex items-center mb-0.5">
              <div className="text-xs text-gray-400 dark:text-gray-500 w-10 shrink-0 text-right pr-2">
                {mes}
              </div>
              <div className="flex flex-1 h-7 gap-px">
                {Array.from({ length: 24 }, (_, h) => {
                  const val = getVal(m, h)
                  return (
                    <div
                      key={h}
                      className="flex-1 rounded-sm"
                      style={{
                        background: val !== null
                          ? valorAColor(val, min, max, variable)
                          : '#f3f4f6'
                      }}
                      title={val !== null ? `${mes} ${String(h).padStart(2,'0')}:00 → ${val}${cfg.unit}` : 'Sin dato'}
                    />
                  )
                })}
              </div>
            </div>
          ))}

          {/* Leyenda */}
          <div className="flex items-center gap-3 mt-4 ml-10">
            <span className="text-xs text-gray-400">{min.toFixed(1)}{cfg.unit}</span>
            <div className="flex-1 h-3 rounded-full overflow-hidden">
              <div className="w-full h-full" style={{
                background: variable === 'temperatura'
                  ? 'linear-gradient(to right, rgb(59,130,246), rgb(250,204,20), rgb(220,38,38))'
                  : variable === 'humedad'
                    ? 'linear-gradient(to right, rgb(240,249,255), rgb(30,64,175))'
                    : 'linear-gradient(to right, rgb(240,249,255), rgb(13,148,136))'
              }} />
            </div>
            <span className="text-xs text-gray-400">{max.toFixed(1)}{cfg.unit}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────
export default function Analysis() {
  const [estacion, setEstacion] = useState(ESTACIONES[0].nombre)
  const [variable, setVariable] = useState('temperatura')
  const [archivo,  setArchivo]  = useState(null)
  const [tab,      setTab]      = useState('serie')
  const [datos,    setDatos]    = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error,    setError]    = useState('')

  const cfg = VARIABLES.find(v => v.value === variable)

  const analizarArchivo = async (file) => {
    if (!file) return
    setArchivo(file)
    setError('')
    setDatos(null)
    setCargando(true)

    try {
      const form = new FormData()
      form.append('estacion', estacion)
      form.append('variable', variable)
      form.append('archivo',  file)

      const res = await api.post('/datos/analizar', form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      setDatos(res.data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Error al analizar el archivo')
    } finally {
      setCargando(false)
    }
  }

  // Re-analizar si cambia la variable con el mismo archivo
  const handleVariable = (val) => {
    setVariable(val)
    setDatos(null)
    setArchivo(null)
    setError('')
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <BarChart2 size={22} className="text-blue-500" />
          <h1 className="text-2xl font-semibold text-gray-800 dark:text-gray-100">Análisis</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Cargá un archivo para visualizar la serie temporal, distribución y mapa de calor
        </p>
      </div>

      {/* Controles */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 mb-6">
        <div className="grid grid-cols-1 gap-4">

          {/* Estación + Variable */}
          <div className="flex flex-wrap gap-3 items-center">
            {/* Estación */}
            <div className="relative">
              <select
                value={estacion}
                onChange={e => setEstacion(e.target.value)}
                className="appearance-none pl-3 pr-8 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700
                  bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200
                  focus:outline-none focus:ring-2 focus:ring-blue-400 cursor-pointer"
              >
                {ESTACIONES.map(e => <option key={e.id}>{e.nombre}</option>)}
              </select>
              <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>

            {/* Variable */}
            <div className="flex gap-2">
              {VARIABLES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => handleVariable(value)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-colors
                    ${variable === value
                      ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300'
                    }`}
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Dropzone de archivo */}
          <ArchivoDropzone onArchivo={analizarArchivo} archivo={archivo} />

          {cargando && (
            <div className="flex items-center gap-2 text-sm text-blue-500">
              <Loader2 size={15} className="animate-spin" />
              Analizando datos...
            </div>
          )}

          {error && (
            <div className="flex gap-2 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-lg px-3 py-2">
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Resultados */}
      {datos && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {/* Pestañas */}
          <div className="flex border-b border-gray-100 dark:border-gray-800">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 px-5 py-3.5 text-sm border-b-2 transition-colors
                  ${tab === id
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400 font-medium'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>

          {/* Contenido */}
          <div className="p-6">
            {tab === 'serie' && (
              <GraficoSerie serie={datos.serie} resumen={datos.resumen} cfg={cfg} />
            )}
            {tab === 'fdp' && (
              <GraficoFDP fdp={datos.fdp} resumen={datos.resumen} cfg={cfg} variable={variable} />
            )}
            {tab === 'calor' && (
              <MapaCalor calor={datos.calor} cfg={cfg} variable={variable} />
            )}
          </div>
        </div>
      )}

      {/* Estado vacío */}
      {!datos && !cargando && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-300 dark:text-gray-600">
          <BarChart2 size={48} strokeWidth={1} />
          <p className="text-sm mt-3">Seleccioná una variable y subí un archivo para ver el análisis</p>
        </div>
      )}
    </div>
  )
}