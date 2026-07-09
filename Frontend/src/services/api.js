const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api'

// ── helpers ───────────────────────────────────────────────────
const clean = (params) =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
  )

async function req(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail?.message || err.detail || `Error ${res.status}`)
  }

  return res.json()
}

// ── Stations ──────────────────────────────────────────────────
export const stationsApi = {
  getAll: () => req('/stations/'),
  getOne: (id) => req(`/stations/${id}`),
  create: (d) =>
    req('/stations/', {
      method: 'POST',
      body: JSON.stringify(d),
    }),
  analysis: (id, params = {}) =>
    req(`/stations/${id}/analysis?${new URLSearchParams(clean(params))}`),
}

// ── Measurements ──────────────────────────────────────────────
export const measurementsApi = {
  list: (p = {}) =>
    req(`/measurements/?${new URLSearchParams(clean(p))}`),

  summary: (p = {}) =>
    req(`/measurements/summary?${new URLSearchParams(clean(p))}`),

  byDate: (p = {}) =>
    req(`/measurements/by-date?${new URLSearchParams(clean(p))}`),

  stats: (p = {}) =>
    req(`/measurements/stats?${new URLSearchParams(clean(p))}`),

  statsSummaryTable: (p = {}) =>                                          // ← nuevo
    req(`/measurements/stats/summary-table?${new URLSearchParams(clean(p))}`),

  recalculate: (p = {}) =>                                                // ← recalcular ajuste FDP
    req(`/measurements/stats/recalculate?${new URLSearchParams(clean(p))}`, {
      method: 'POST',
    }),

  heatmap: (p = {}) =>
    req(`/measurements/heatmap?${new URLSearchParams(clean(p))}`),

  dailyPeaks: (p = {}) =>                                                // ← nuevo (RF-03/04)
    req(`/measurements/daily-peaks?${new URLSearchParams(clean(p))}`),

  windRose: (p = {}) =>                                                   // ← viento (rosa)
    req(`/measurements/wind-rose?${new URLSearchParams(clean(p))}`),

  windDirectional: (p = {}) =>                                           // ← viento (dir×año/hora)
    req(`/measurements/wind-directional?${new URLSearchParams(clean(p))}`),

  dailyProfile: (p = {}) =>                                               // ← nuevo
    req(`/measurements/daily-profile?${new URLSearchParams(clean(p))}`),

  annualProfile: (p = {}) =>                                              // ← nuevo
    req(`/measurements/annual-profile?${new URLSearchParams(clean(p))}`),

  combined: (p = {}) =>
    req(`/measurements/combined?${new URLSearchParams(clean(p))}`),
}

// ── Uploads ───────────────────────────────────────────────────
export const uploadsApi = {
  upload: async (file, station_id) => {
    const form = new FormData()
    form.append('file', file)

    const res = await fetch(
      `${BASE_URL}/uploads/?station_id=${station_id}`,
      {
        method: 'POST',
        body: form,
      }
    )

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail?.message || err.detail || `Error ${res.status}`)
    }

    return res.json()
  },

  history: (limit = 20) =>
    req(`/uploads/history?limit=${limit}`),
}

// ── Local Analysis (sin BD) ───────────────────────────────────
export const localAnalysisApi = {
  analyzeFile: async (file, variable, n_components = 2) => {
    const form = new FormData()
    form.append("archivo",      file)
    form.append("variable",     variable)
    form.append("n_components", n_components)
    const res = await fetch(`${BASE_URL}/local-analysis/file`, {
      method: "POST", body: form,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail?.message || err.detail || `Error ${res.status}`)
    }
    return res.json()
  },

  analyzeMulti: async (archivos, n_components = 2) => {
    const form = new FormData()
    form.append("n_components", n_components)
    if (archivos.temperatura) form.append("temperatura", archivos.temperatura)
    if (archivos.humedad)     form.append("humedad",     archivos.humedad)
    if (archivos.viento)      form.append("viento",      archivos.viento)
    const res = await fetch(`${BASE_URL}/local-analysis/multi`, {
      method: "POST", body: form,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail?.message || err.detail || `Error ${res.status}`)
    }
    return res.json()
  },
}