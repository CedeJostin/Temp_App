import { useState } from "react"
import { useFetch } from "../hooks/useFetch"
import { stationsApi } from "../services/api"

const BASE_URL = import.meta.env.VITE_API_URL || "/api"

export default function Stations() {
  const { data, loading, error, refetch } = useFetch(() => stationsApi.getAll())
  const [showModal, setShowModal] = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [saveError, setSaveError] = useState("")
  const [form, setForm] = useState({
    name: "", station_code: "", latitude: "", longitude: "", altitude_meters: "", institution: ""
  })

  const handleChange = (e) => setForm(f => ({ ...f, [e.target.name]: e.target.value }))

  const handleCreate = async () => {
    if (!form.name || !form.station_code || !form.latitude || !form.longitude) {
      setSaveError("Nombre, código, latitud y longitud son obligatorios.")
      return
    }
    setSaving(true)
    setSaveError("")
    try {
      await stationsApi.create({
        name:             form.name,
        station_code:     form.station_code,
        latitude:         parseFloat(form.latitude),
        longitude:        parseFloat(form.longitude),
        altitude_meters:  form.altitude_meters ? parseFloat(form.altitude_meters) : null,
        institution:      form.institution || null,
      })
      setShowModal(false)
      setForm({ name: "", station_code: "", latitude: "", longitude: "", altitude_meters: "", institution: "" })
      refetch()
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const stations = data || []

  return (
    <div className="page">
      <header className="page__header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="page__title">Estaciones</h1>
          <p className="page__subtitle">Administra las estaciones de monitoreo</p>
        </div>
        <button className="btn btn--primary" onClick={() => { setShowModal(true); setSaveError("") }}>
          + Nueva estación
        </button>
      </header>

      {loading && <p style={{ color: "var(--text-muted)", padding: "2rem" }}>Cargando estaciones...</p>}
      {error   && <div className="alert alert--error">{error}</div>}

      {!loading && !error && stations.length === 0 && (
        <div style={{ textAlign: "center", padding: "3rem", color: "var(--text-muted)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📡</div>
          <p>No hay estaciones registradas aún.</p>
          <p style={{ fontSize: 13 }}>Hacé clic en <strong>+ Nueva estación</strong> para agregar la primera.</p>
        </div>
      )}

      {!loading && stations.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
          {stations.map(s => (
            <div key={s.id} style={{
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 12, padding: "16px 20px",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</span>
                <span style={{
                  background: "var(--accent, #22c55e20)", color: "var(--accent, #22c55e)",
                  borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600,
                }}>
                  {s.station_code}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                <div>📍 {parseFloat(s.latitude).toFixed(4)}, {parseFloat(s.longitude).toFixed(4)}</div>
                {s.altitude_meters && <div>⛰️ {s.altitude_meters} m s.n.m.</div>}
                {s.institution     && <div>🏛️ {s.institution}</div>}
                <div style={{ fontSize: 11, marginTop: 4, opacity: 0.6 }}>
                  ID: {s.id.slice(0, 8)}…
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal nueva estación */}
      {showModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
        }}>
          <div style={{
            background: "var(--surface)", borderRadius: 16, padding: "2rem",
            width: "100%", maxWidth: 460, boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Nueva estación</h2>
              <button onClick={() => setShowModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
            </div>

            {saveError && <div className="alert alert--error" style={{ marginBottom: 12 }}>{saveError}</div>}

            {[
              { label: "Nombre *",       name: "name",            placeholder: "Estación Central" },
              { label: "Código *",       name: "station_code",    placeholder: "EST-01" },
              { label: "Latitud *",      name: "latitude",        placeholder: "9.9341",  type: "number" },
              { label: "Longitud *",     name: "longitude",       placeholder: "-84.0877", type: "number" },
              { label: "Altitud (m)",    name: "altitude_meters", placeholder: "1200",    type: "number" },
              { label: "Institución",    name: "institution",     placeholder: "IMN / ICE" },
            ].map(({ label, name, placeholder, type = "text" }) => (
              <div key={name} style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>
                  {label}
                </label>
                <input
                  type={type}
                  name={name}
                  value={form[name]}
                  onChange={handleChange}
                  placeholder={placeholder}
                  style={{
                    width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 14,
                    background: "var(--surface-2, #1e293b)", border: "1px solid var(--border)",
                    color: "var(--text)", outline: "none", boxSizing: "border-box",
                  }}
                />
              </div>
            ))}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: "1.5rem" }}>
              <button className="btn btn--ghost" onClick={() => setShowModal(false)}>Cancelar</button>
              <button className="btn btn--primary" onClick={handleCreate} disabled={saving}>
                {saving ? "Guardando…" : "Crear estación"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}