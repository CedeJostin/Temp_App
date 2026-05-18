import { useState, useRef } from 'react'
import {
  Upload as UploadIcon, CheckCircle2,
  AlertCircle, X, Info, Thermometer, Droplets, Wind, Loader2
} from 'lucide-react'
import api from '../services/api'

const VARIABLES = [
  {
    key: 'temperatura',
    label: 'Temperatura',
    icon: Thermometer,
    color: 'text-orange-400',
    borderActive: 'border-orange-300 bg-orange-50 dark:bg-orange-900/10',
    badgeColor: 'bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400',
    accept: '.csv,.xlsx',
  },
  {
    key: 'humedad',
    label: 'Humedad Relativa',
    icon: Droplets,
    color: 'text-blue-400',
    borderActive: 'border-blue-300 bg-blue-50 dark:bg-blue-900/10',
    badgeColor: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    accept: '.csv,.xlsx',
  },
  {
    key: 'viento',
    label: 'Viento',
    icon: Wind,
    color: 'text-teal-500',
    borderActive: 'border-teal-300 bg-teal-50 dark:bg-teal-900/10',
    badgeColor: 'bg-teal-50 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400',
    accept: '.csv,.xlsx',
  },
]

const formatoInfo = [
  'Separador: punto y coma (;)',
  'Columnas: año, mes, dia, H1 … H24',
  'Una fila por día, una columna por hora',
  'Valores faltantes marcados con guion (-)',
  'Temperatura usa coma como decimal (20,6 = 20.6°C)',
]

const parsearCSV = (texto) => {
  const lineas = texto.trim().split('\n').filter(Boolean)
  const sep = lineas[0].includes(';') ? ';' : ','
  const columnas = lineas[0].split(sep).map(c => c.trim().replace(/^\uFEFF/, ''))
  const colsNorm = columnas.map(c =>
    c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  )
  const esFormatoHorario = colsNorm.includes('ano') && colsNorm.includes('h1')
  const esFormatoViento  = colsNorm.includes('fecha') && colsNorm.includes('velocidad')
  if (!esFormatoHorario && !esFormatoViento) throw new Error('formato_desconocido')

  const filas = lineas.slice(1, 4).map(l => l.split(sep).slice(0, 6).map(c => c.trim()))
  const totalFilas = lineas.length - 1
  const totalFaltantes = lineas.slice(1).reduce((acc, l) =>
    acc + l.split(sep).filter(c => c.trim() === '-' || c.trim() === '-9').length, 0
  )
  return { columnas: columnas.slice(0, 6), filas, totalFilas, totalFaltantes }
}

function DropZone({ variable, archivo, onFile, onQuitar, error, preview }) {
  const inputRef = useRef()
  const [dragging, setDragging] = useState(false)
  const { label, icon: Icon, color, borderActive, badgeColor, accept } = variable

  const handleDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) onFile(f)
  }

  const handleFile = (e) => {
    if (e.target.files[0]) onFile(e.target.files[0])
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon size={18} className={color} />
          <span className="font-medium text-gray-800 dark:text-gray-200 text-sm">{label}</span>
        </div>
        {archivo && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}`}>
            Listo
          </span>
        )}
      </div>

      {/* Drop area */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !archivo && inputRef.current.click()}
        className={`relative border-2 border-dashed rounded-lg p-5 text-center transition-colors
          ${archivo
            ? 'border-green-300 bg-green-50 dark:bg-green-900/10'
            : dragging
              ? borderActive
              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40'
          }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleFile}
        />

        {archivo ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={20} className="text-green-500 shrink-0" />
              <div className="text-left">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate max-w-[200px]">
                  {archivo.name}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {(archivo.size / 1024).toFixed(1)} KB
                  {preview && ` · ${preview.totalFilas} días · `}
                  {preview && (
                    <span className={preview.totalFaltantes > 0 ? 'text-orange-400' : 'text-green-500'}>
                      {preview.totalFaltantes} faltantes
                    </span>
                  )}
                </p>
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onQuitar() }}
              className="text-gray-300 hover:text-red-400 transition-colors p-1"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5">
            <UploadIcon size={22} className="text-gray-300 dark:text-gray-600" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Arrastrá o <span className="text-blue-500">seleccioná</span> el archivo
            </p>
            <p className="text-xs text-gray-400">CSV · Excel</p>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex gap-2 mt-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-lg px-3 py-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Preview mini */}
      {preview && !error && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800">
          <table className="text-xs w-full">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800">
                {preview.columnas.map(col => (
                  <th key={col} className="px-2 py-1.5 text-left font-medium text-gray-400 whitespace-nowrap">
                    {col}
                  </th>
                ))}
                <th className="px-2 py-1.5 text-gray-300">…</th>
              </tr>
            </thead>
            <tbody>
              {preview.filas.map((fila, i) => (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                  {fila.map((celda, j) => (
                    <td key={j} className={`px-2 py-1 whitespace-nowrap
                      ${celda === '-' || celda === '-9' ? 'text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                      {celda}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-gray-300">…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function Upload() {
  const [estacion,   setEstacion]   = useState('')
  const [archivos,   setArchivos]   = useState({ temperatura: null, humedad: null, viento: null })
  const [previews,   setPreviews]   = useState({ temperatura: null, humedad: null, viento: null })
  const [errores,    setErrores]    = useState({ temperatura: '',   humedad: '',   viento: ''   })
  const [subido,     setSubido]     = useState(false)
  const [cargando,   setCargando]   = useState(false)
  const [resultados, setResultados] = useState({})

  const handleFile = (key, file) => {
    setSubido(false)
    setResultados({})
    setArchivos(prev  => ({ ...prev, [key]: file }))
    setErrores(prev   => ({ ...prev, [key]: '' }))
    setPreviews(prev  => ({ ...prev, [key]: null }))

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const decoder = new TextDecoder('windows-1252')
        const texto   = decoder.decode(e.target.result)
        const datos   = parsearCSV(texto)
        setPreviews(prev => ({ ...prev, [key]: datos }))
      } catch {
        setErrores(prev => ({
          ...prev,
          [key]: 'Formato no reconocido. Verificá que tenga columnas: año, mes, dia, H1…H24'
        }))
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const handleQuitar = (key) => {
    setArchivos(prev  => ({ ...prev, [key]: null }))
    setPreviews(prev  => ({ ...prev, [key]: null }))
    setErrores(prev   => ({ ...prev, [key]: '' }))
    setSubido(false)
    setResultados({})
  }

  const archivosListos  = Object.values(archivos).filter(Boolean).length
  const hayAlgunArchivo = archivosListos > 0
  const puedeSubir      = estacion && hayAlgunArchivo

  const handleSubir = async () => {
    if (!puedeSubir) return
    setCargando(true)
    setResultados({})

    const nuevosResultados = {}

    for (const key of ['temperatura', 'humedad', 'viento']) {
      if (!archivos[key]) continue
      try {
        const form = new FormData()
        form.append('estacion', estacion)
        form.append('variable', key)
        form.append('archivo',  archivos[key])

        const res = await api.post('/datos/depurar', form, {
          headers: { 'Content-Type': 'multipart/form-data' }
        })
        nuevosResultados[key] = { ok: true, data: res.data }
      } catch (err) {
        nuevosResultados[key] = {
          ok: false,
          error: err.response?.data?.detail || 'Error al procesar'
        }
      }
    }

    setResultados(nuevosResultados)
    setCargando(false)
    setSubido(true)
  }

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <UploadIcon size={22} className="text-blue-500" />
          <h1 className="text-2xl font-semibold text-gray-800 dark:text-gray-100">
            Cargar datos
          </h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Subí los archivos de cada variable por estación meteorológica
        </p>
      </div>

      {/* Info formato */}
      <div className="flex gap-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-4 mb-6">
        <Info size={16} className="text-blue-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-1">Formato esperado</p>
          <ul className="text-xs text-blue-600 dark:text-blue-400 space-y-0.5">
            {formatoInfo.map(f => <li key={f}>· {f}</li>)}
          </ul>
        </div>
      </div>

      {/* Estación */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 mb-4">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
          Estación meteorológica
        </label>
        <input
          type="text"
          value={estacion}
          onChange={e => { setEstacion(e.target.value); setSubido(false) }}
          placeholder="Ej: Belén (código 84199)"
          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700
            bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200
            placeholder-gray-400 dark:placeholder-gray-500
            focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
        />
      </div>

      {/* Los 3 drop zones */}
      <div className="space-y-4 mb-6">
        {VARIABLES.map(v => (
          <DropZone
            key={v.key}
            variable={v}
            archivo={archivos[v.key]}
            preview={previews[v.key]}
            error={errores[v.key]}
            onFile={(f) => handleFile(v.key, f)}
            onQuitar={() => handleQuitar(v.key)}
          />
        ))}
      </div>

      {/* Botón y resultados */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {archivosListos === 0
              ? 'Ningún archivo cargado aún'
              : `${archivosListos} de 3 archivo${archivosListos > 1 ? 's' : ''} listo${archivosListos > 1 ? 's' : ''}`
            }
          </p>
          <div className="flex gap-2">
            {VARIABLES.map(v => (
              <div
                key={v.key}
                className={`w-2 h-2 rounded-full transition-colors
                  ${archivos[v.key] ? 'bg-green-400' : 'bg-gray-200 dark:bg-gray-700'}`}
                title={v.label}
              />
            ))}
          </div>
        </div>

        <button
          onClick={handleSubir}
          disabled={!puedeSubir || cargando}
          className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2
            ${puedeSubir && !cargando
              ? 'bg-blue-500 hover:bg-blue-600 text-white'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-400 cursor-not-allowed'
            }`}
        >
          {cargando && <Loader2 size={15} className="animate-spin" />}
          {!estacion
            ? 'Ingresá el nombre de la estación para continuar'
            : !hayAlgunArchivo
              ? 'Seleccioná al menos un archivo'
              : cargando
                ? 'Procesando archivos...'
                : `Procesar ${archivosListos} archivo${archivosListos > 1 ? 's' : ''}`
          }
        </button>

        {/* Resultados por variable */}
        {subido && Object.keys(resultados).length > 0 && (
          <div className="mt-4 space-y-3">
            {Object.entries(resultados).map(([key, res]) => {
              const cfg  = VARIABLES.find(v => v.key === key)
              const Icon = cfg.icon
              return (
                <div key={key}
                  className={`rounded-lg p-3 border text-sm
                    ${res.ok
                      ? 'bg-green-50 dark:bg-green-900/10 border-green-100 dark:border-green-800'
                      : 'bg-red-50 dark:bg-red-900/10 border-red-100 dark:border-red-800'
                    }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon size={14} className={cfg.color} />
                    <span className="font-medium text-gray-700 dark:text-gray-300">{cfg.label}</span>
                    {res.ok
                      ? <CheckCircle2 size={14} className="text-green-500 ml-auto" />
                      : <AlertCircle  size={14} className="text-red-500 ml-auto" />
                    }
                  </div>
                  {res.ok ? (
                    <div className="grid grid-cols-3 gap-2 mt-2 text-xs text-gray-500 dark:text-gray-400">
                      <span>📅 {res.data.resumen.fecha_inicio} → {res.data.resumen.fecha_fin}</span>
                      <span>✅ Completitud: <strong>{res.data.resumen.completitud_pct}%</strong></span>
                      <span>⚠️ Faltantes: <strong>{res.data.resumen.total_faltantes}</strong></span>
                      <span>↑ Máx: {res.data.resumen.maximo}</span>
                      <span>↓ Mín: {res.data.resumen.minimo}</span>
                      <span>~ Prom: {res.data.resumen.promedio}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-red-500 mt-1">{res.error}</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-600 mt-4">
        * Los archivos se procesarán en el backend cuando conectemos Supabase para persistencia.
      </p>
    </div>
  )
}