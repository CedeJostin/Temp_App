import { useState } from "react"
import { createPortal } from "react-dom"
import { useFetch } from "../hooks/useFetch"
import { stationsApi } from "../services/api"
import { Plus, X, MapPin, Mountain, Building2, SatelliteDish } from "lucide-react"

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
      <header className="page__header">
        <div>
          <h1 className="page__title">Estaciones</h1>
          <p className="page__subtitle">Administra las estaciones de monitoreo</p>
        </div>
        <button className="btn btn--primary" onClick={() => { setShowModal(true); setSaveError("") }}>
          <Plus size={16} /> Nueva estación
        </button>
      </header>

      {loading && <p style={{ color: "var(--text-muted)", padding: "2rem" }}>Cargando estaciones…</p>}
      {error   && <div className="alert alert--error">{error}</div>}

      {!loading && !error && stations.length === 0 && (
        <div className="empty-state">
          <span className="empty-state__icon"><SatelliteDish size={40} /></span>
          <p>No hay estaciones registradas aún.</p>
          <p style={{ fontSize: 13 }}>Hacé clic en <strong>Nueva estación</strong> para agregar la primera.</p>
        </div>
      )}

      {!loading && stations.length > 0 && (
        <div className="stations-grid">
          {stations.map(s => (
            <div key={s.id} className="card">
              <div className="station-card__header">
                <h3 style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</h3>
                <span className="badge" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
                  {s.station_code}
                </span>
              </div>
              <div className="station-card__meta num">
                <div className="station-card__meta-row">
                  <MapPin size={14} />
                  {parseFloat(s.latitude).toFixed(4)}, {parseFloat(s.longitude).toFixed(4)}
                </div>
                {s.altitude_meters && (
                  <div className="station-card__meta-row">
                    <Mountain size={14} /> {s.altitude_meters} m s.n.m.
                  </div>
                )}
                {s.institution && (
                  <div className="station-card__meta-row">
                    <Building2 size={14} /> <span style={{ fontFamily: "var(--font)" }}>{s.institution}</span>
                  </div>
                )}
              </div>
              <div className="station-card__id">ID: {s.id.slice(0, 8)}…</div>
            </div>
          ))}
        </div>
      )}

      {/* Modal nueva estación — vía portal a document.body para que ningún
          transform de un ancestro (.page) altere su position: fixed */}
      {showModal && createPortal(
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal__header">
              <h3>Nueva estación</h3>
              <button className="modal__close" onClick={() => setShowModal(false)} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>

            <div className="modal__body">
              {saveError && <div className="alert alert--error">{saveError}</div>}

              {[
                { label: "Nombre *",       name: "name",            placeholder: "Estación Central" },
                { label: "Código *",       name: "station_code",    placeholder: "EST-01" },
                { label: "Latitud *",      name: "latitude",        placeholder: "9.9341",  type: "number" },
                { label: "Longitud *",     name: "longitude",       placeholder: "-84.0877", type: "number" },
                { label: "Altitud (m)",    name: "altitude_meters", placeholder: "1200",    type: "number" },
                { label: "Institución",    name: "institution",     placeholder: "IMN / ICE" },
              ].map(({ label, name, placeholder, type = "text" }) => (
                <label key={name} className="field">
                  <span className="field__label">{label}</span>
                  <input
                    className="field__input"
                    type={type}
                    name={name}
                    value={form[name]}
                    onChange={handleChange}
                    placeholder={placeholder}
                    style={{ width: "100%" }}
                  />
                </label>
              ))}
            </div>

            <div className="modal__footer">
              <button className="btn btn--ghost" onClick={() => setShowModal(false)}>Cancelar</button>
              <button className="btn btn--primary" onClick={handleCreate} disabled={saving}>
                {saving ? "Guardando…" : "Crear estación"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
