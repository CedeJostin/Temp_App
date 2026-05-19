import { useState, useEffect } from "react";
import { Trash2, RefreshCw } from "lucide-react";
import { stationsApi, measurementsApi } from "../services/api";
import { Spinner, Alert, Select, Input, Button, Card, Badge } from "../components/ui";

const VAR_OPTS = [
  { value: "",       label: "Todas" },
  { value: "TEMP",   label: "Temperatura" },
  { value: "HR",     label: "Humedad" },
  { value: "RAD",    label: "Radiación" },
  { value: "VIENTO", label: "Viento" },
];

const VAR_COLOR = { TEMP: "#ef4444", HR: "#3b82f6", RAD: "#f59e0b", VIENTO: "#10b981" };

export default function Measurements() {
  const [stations, setStations]     = useState([]);
  const [stationId, setStationId]   = useState("");
  const [varCode, setVarCode]       = useState("");
  const [dateFrom, setDateFrom]     = useState("");
  const [dateTo, setDateTo]         = useState("");
  const [order, setOrder]           = useState("desc");
  const [limit, setLimit]           = useState("200");
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [deleting, setDeleting]     = useState(null);

  useEffect(() => {
    stationsApi.getAll().then((list) => {
      setStations(list);
      if (list.length) setStationId(list[0].id);
    }).catch(() => {});
  }, []);

  const fetch = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await measurementsApi.list({
        station_id:    stationId || undefined,
        variable_code: varCode   || undefined,
        date_from:     dateFrom  || undefined,
        date_to:       dateTo    || undefined,
        order,
        limit: parseInt(limit) || 200,
      });
      setData(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("¿Eliminar esta medición?")) return;
    setDeleting(id);
    try {
      await measurementsApi.delete(id);
      setData((d) => ({ ...d, data: d.data.filter((r) => r.id !== id), total: d.total - 1 }));
    } catch (e) {
      alert(e.message);
    } finally {
      setDeleting(null);
    }
  };

  const stationOpts = [
    { value: "", label: "Todas" },
    ...stations.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Mediciones</h1>
          <p className="page__subtitle">Consulta y administra las mediciones registradas</p>
        </div>
      </header>

      {/* ── Filtros ─────────────────────────────────────────── */}
      <Card className="filter-card">
        <div className="filter-row">
          <Select label="Estación"  value={stationId} onChange={setStationId} options={stationOpts} />
          <Select label="Variable"  value={varCode}   onChange={setVarCode}   options={VAR_OPTS}    />
          <Input  label="Desde"     type="date" value={dateFrom} onChange={setDateFrom} />
          <Input  label="Hasta"     type="date" value={dateTo}   onChange={setDateTo}   />
          <Select
            label="Orden"
            value={order}
            onChange={setOrder}
            options={[{ value: "desc", label: "Más recientes" }, { value: "asc", label: "Más antiguos" }]}
          />
          <Select
            label="Límite"
            value={limit}
            onChange={setLimit}
            options={["100", "200", "500", "1000", "5000"].map((v) => ({ value: v, label: v }))}
          />
          <div className="filter-action">
            <Button onClick={fetch} disabled={loading}>
              <RefreshCw size={14} /> {loading ? "Cargando…" : "Consultar"}
            </Button>
          </div>
        </div>
      </Card>

      {error && <Alert>{error}</Alert>}
      {loading && <Spinner />}

      {/* ── Results ─────────────────────────────────────────── */}
      {data && !loading && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h3>Resultados</h3>
            <Badge
              label={`${data.count} / ${data.total} registros`}
              color="var(--accent)"
            />
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha/Hora</th><th>Estación</th><th>Variable</th>
                  <th>Valor</th><th>Unidad</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: "center", opacity: 0.5 }}>Sin resultados</td></tr>
                ) : data.data.map((row) => (
                  <tr key={row.id}>
                    <td style={{ fontSize: "0.82rem" }}>
                      {new Date(row.measured_at).toLocaleString("es-CR")}
                    </td>
                    <td>{row.station_name || row.station_code}</td>
                    <td>
                      <Badge
                        label={row.variable_code}
                        color={VAR_COLOR[row.variable_code] || "#6366f1"}
                      />
                    </td>
                    <td><strong>{row.value}</strong></td>
                    <td style={{ opacity: 0.6 }}>{row.variable_unit}</td>
                    <td>
                      <button
                        className="icon-btn icon-btn--danger"
                        onClick={() => handleDelete(row.id)}
                        disabled={deleting === row.id}
                        title="Eliminar"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > data.count && (
            <p style={{ marginTop: "0.75rem", opacity: 0.6, fontSize: "0.85rem" }}>
              Mostrando {data.count} de {data.total} — ajusta el límite para ver más.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}