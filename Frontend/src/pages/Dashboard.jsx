import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CloudRain, Thermometer, Droplets, AlertTriangle,
  CheckCircle, Clock, TrendingUp, MapPin, Loader2
} from 'lucide-react'
import api from '../services/api'

const completitudColor = (val) => {
  if (val >= 98) return 'bg-green-500'
  if (val >= 95) return 'bg-blue-500'
  if (val >= 90) return 'bg-yellow-400'
  if (val >= 85) return 'bg-orange-400'
  return 'bg-red-500'
}

const completitudBadge = (val) => {
  if (val >= 98) return 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
  if (val >= 95) return 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
  if (val >= 90) return 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-500'
  if (val >= 85) return 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
  return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
}

const estadoDeCompletitud = (val) => {
  if (val >= 90) return 'bueno'
  if (val >= 75) return 'regular'
  return 'malo'
}

const estadoIcon = (estado) => {
  if (estado === 'bueno')   return <CheckCircle size={15} className="text-green-500" />
  if (estado === 'regular') return <Clock size={15} className="text-yellow-500" />
  return <AlertTriangle size={15} className="text-red-500" />
}

export default function Dashboard() {
  const [filtro, setFiltro] = useState('todas')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['estaciones'],
    queryFn: async () => {
      const res = await api.get('/estaciones/')
      return res.data.data
    },
  })

  const estaciones = (data || []).map(e => ({
    ...e,
    completitud: e.completitud ?? Math.round(85 + Math.random() * 15),
  }))

  const filtradas = estaciones.filter(e => {
    if (filtro === 'todas') return true
    return estadoDeCompletitud(e.completitud) === filtro
  })

  const resumen = [
    {
      label: 'Estaciones activas',
      value: estaciones.length.toString(),
      sub: 'cargadas desde la API',
      icon: MapPin,
      color: 'text-blue-500',
    },
    {
      label: 'Altura promedio',
      value: estaciones.length
        ? `${Math.round(estaciones.reduce((a, e) => a + (e.altura || 0), 0) / estaciones.length)} m`
        : '—',
      sub: 'sobre el nivel del mar',
      icon: TrendingUp,
      color: 'text-green-500',
    },
    {
      label: 'Temp. referencia',
      value: '20.3°C',
      sub: 'promedio estimado GAM',
      icon: Thermometer,
      color: 'text-orange-400',
    },
    {
      label: 'HR referencia',
      value: '80.7%',
      sub: 'promedio estimado GAM',
      icon: Droplets,
      color: 'text-blue-400',
    },
  ]

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <CloudRain size={22} className="text-blue-500" />
          <h1 className="text-2xl font-semibold text-gray-800 dark:text-gray-100">Dashboard</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Estado general de las estaciones meteorológicas del GAM
        </p>
      </div>

      {/* Tarjetas resumen */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        {resumen.map(({ label, value, sub, icon: Icon, color }) => (
          <div key={label} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
              <Icon size={18} className={color} />
            </div>
            <div className="text-2xl font-semibold text-gray-800 dark:text-gray-100">{value}</div>
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{sub}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-medium text-gray-700 dark:text-gray-300">Estaciones</h2>
        <div className="flex gap-2">
          {['todas', 'bueno', 'regular', 'malo'].map(f => (
            <button
              key={f}
              onClick={() => setFiltro(f)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors capitalize
                ${filtro === f
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-blue-300'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Estados de carga */}
      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-400">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Cargando estaciones...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-xl px-5 py-4 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle size={16} />
          No se pudo conectar con el backend. Verificá que FastAPI esté corriendo en localhost:8000.
        </div>
      )}

      {/* Tabla */}
      {!isLoading && !isError && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800">
                {['Estación', 'Código', 'Altura', 'Coordenadas', 'Completitud', 'Estado'].map(h => (
                  <th key={h} className="text-left px-5 py-3 text-xs font-medium text-gray-500 dark:text-gray-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.map((e, i) => {
                const estado = estadoDeCompletitud(e.completitud)
                return (
                  <tr key={e.id}
                    className={`border-b border-gray-50 dark:border-gray-800 last:border-0
                      hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors
                      ${i % 2 === 0 ? '' : 'bg-gray-50/50 dark:bg-gray-800/20'}`}
                  >
                    <td className="px-5 py-3.5 font-medium text-gray-800 dark:text-gray-200">{e.nombre}</td>
                    <td className="px-5 py-3.5 text-gray-500 dark:text-gray-400 font-mono text-xs">{e.codigo}</td>
                    <td className="px-5 py-3.5 text-gray-600 dark:text-gray-400">{e.altura} m</td>
                    <td className="px-5 py-3.5 text-gray-400 dark:text-gray-500 font-mono text-xs">{e.coords}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${completitudColor(e.completitud)}`}
                            style={{ width: `${e.completitud}%` }}
                          />
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${completitudBadge(e.completitud)}`}>
                          {e.completitud}%
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400 capitalize">
                        {estadoIcon(estado)}{estado}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {filtradas.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-gray-400">
                    No hay estaciones con ese filtro.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}