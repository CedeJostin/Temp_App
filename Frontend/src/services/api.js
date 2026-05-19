const BASE_URL = import.meta.env.VITE_API_URL || "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || err.detail || `Error ${res.status}`);
  }
  return res.json();
}

const clean = (params) =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== "")
  );

// ─── Stations ─────────────────────────────────────────────────────────────────
export const stationsApi = {
  getAll:      ()    => request("/stations/"),
  getOne:      (id)  => request(`/stations/${id}`),
  create:      (d)   => request("/stations/", { method: "POST", body: JSON.stringify(d) }),
  getVariables:()    => request("/stations/variables/all"),
};

// ─── Measurements ─────────────────────────────────────────────────────────────
export const measurementsApi = {
  list:    (p = {}) => request(`/measurements/?${new URLSearchParams(clean(p))}`),
  summary: (p = {}) => request(`/measurements/summary?${new URLSearchParams(clean(p))}`),
  byDate:  (p)      => request(`/measurements/by-date?${new URLSearchParams(clean(p))}`),
  create:  (d)      => request("/measurements/", { method: "POST", body: JSON.stringify(d) }),
  delete:  (id)     => request(`/measurements/${id}`, { method: "DELETE" }),
  deleteRange: (p)  => request(`/measurements/?${new URLSearchParams(clean(p))}`, { method: "DELETE" }),
};

// ─── Uploads ──────────────────────────────────────────────────────────────────
export const uploadsApi = {
  upload: async (file, station_id, variable_id = null) => {
    const form = new FormData();
    form.append("file", file);
    const p = new URLSearchParams({ station_id });
    if (variable_id) p.append("variable_id", variable_id);
    const res = await fetch(`${BASE_URL}/uploads/?${p}`, { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("Upload 422 detail:", JSON.stringify(err, null, 2)); // ← línea nueva
      throw new Error(err.detail?.message || err.detail || `Error ${res.status}`);
    }
    return res.json();
  },
  history: (limit = 20) => request(`/uploads/history?limit=${limit}`),
};