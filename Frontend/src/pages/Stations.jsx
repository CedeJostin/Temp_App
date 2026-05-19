import { useState } from "react";
import { MapPin, Plus, X } from "lucide-react";
import { stationsApi } from "../services/api";
import { useFetch } from "../hooks/useFetch";
import { Spinner, Alert, Card, Button, Input, Badge } from "../components/ui";

function StationModal({ onClose, onCreated }) {
  const [form, setForm]   = useState({ name: "", station_code: "", latitude: "", longitude: "", altitude: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name || !form.station_code) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name:         form.name,
        station_code: form.station_code,
        latitude:     form.latitude  ? parseFloat(form.latitude)  : null,
        longitude:    form.longitude ? parseFloat(form.longitude) : null,
        altitude:     form.altitude  ? parseFloat(form.altitude)  : null,
      };
      const created = await stationsApi.create(payload);
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3>Nueva estación</h3>
          <button className="modal__close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal__body">
          <Input label="Nombre *"       value={form.name}         onChange={set("name")}         placeholder="Estación Central" />
          <Input label="Código *"       value={form.station_code} onChange={set("station_code")} placeholder="EST-01" />
          <Input label="Latitud"        type="number" value={form.latitude}     onChange={set("latitude")}     placeholder="9.9341" />
          <Input label="Longitud"       type="number" value={form.longitude}    onChange={set("longitude")}    placeholder="-84.0877" />
          <Input label="Altitud (m)"    type="number" value={form.altitude}     onChange={set("altitude")}     placeholder="1200" />
          {error && <Alert>{error}</Alert>}
        </div>
        <div className="modal__footer">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !form.name || !form.station_code}>
            {saving ? "Guardando…" : "Crear estación"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Stations() {
  const { data: stations, loading, error, refetch } = useFetch(stationsApi.getAll);
  const { data: variables } = useFetch(stationsApi.getVariables);
  const [showModal, setShowModal] = useState(false);

  const handleCreated = () => refetch();

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Estaciones</h1>
          <p className="page__subtitle">Administra las estaciones de monitoreo</p>
        </div>
        <Button onClick={() => setShowModal(true)}>
          <Plus size={16} /> Nueva estación
        </Button>
      </header>

      {error   && <Alert>{error}</Alert>}
      {loading && <Spinner />}

      {!loading && stations && (
        <div className="stations-grid">
          {stations.map((s) => (
            <Card key={s.id} className="station-card">
              <div className="station-card__header">
                <MapPin size={18} color="var(--accent)" />
                <h3>{s.name}</h3>
                <Badge label={s.station_code} color="var(--accent)" />
              </div>
              <div className="station-card__meta">
                {s.latitude  && <span>🌐 {parseFloat(s.latitude).toFixed(4)}, {parseFloat(s.longitude).toFixed(4)}</span>}
                {s.altitude  && <span>⛰️ {s.altitude} m</span>}
              </div>
              <div className="station-card__id">
                <span>ID: {s.id.slice(0, 8)}…</span>
              </div>
            </Card>
          ))}

          {stations.length === 0 && (
            <div className="empty-state">
              <MapPin size={48} opacity={0.3} />
              <p>No hay estaciones registradas.</p>
              <Button onClick={() => setShowModal(true)}>Crear primera estación</Button>
            </div>
          )}
        </div>
      )}

      {/* Variables table */}
      {variables && variables.length > 0 && (
        <Card style={{ marginTop: "2rem" }}>
          <h3 style={{ marginBottom: "1rem" }}>Variables disponibles</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Código</th><th>Nombre</th><th>Unidad</th></tr></thead>
              <tbody>
                {variables.map((v) => (
                  <tr key={v.id}>
                    <td><Badge label={v.code} color="var(--accent)" /></td>
                    <td>{v.name}</td>
                    <td>{v.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {showModal && (
        <StationModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}