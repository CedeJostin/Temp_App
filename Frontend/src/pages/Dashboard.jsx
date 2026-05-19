import { useState, useEffect } from "react";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Thermometer, Droplets, Zap, Wind, TrendingUp } from "lucide-react";
import { stationsApi, measurementsApi } from "../services/api";
import { Spinner, Alert, StatCard, Select, Card, Badge } from "../components/ui";

const VAR_META = {
  TEMP:   { label: "Temperatura", unit: "°C",  color: "#ef4444", icon: <Thermometer size={22} /> },
  HR:     { label: "Humedad",     unit: "%",   color: "#3b82f6", icon: <Droplets size={22} />    },
  RAD:    { label: "Radiación",   unit: "W/m²",color: "#f59e0b", icon: <Zap size={22} />         },
  VIENTO: { label: "Viento",     unit: "m/s", color: "#10b981", icon: <Wind size={22} />         },
};

const PERIOD_OPTS = [
  { value: "hour", label: "Por hora" },
  { value: "day",  label: "Por día"  },
  { value: "month",label: "Por mes"  },
];

function fmt(str) {
  if (!str) return "";
  const d = new Date(str);
  return isNaN(d) ? str : d.toLocaleDateString("es-CR", { day: "2-digit", month: "short" });
}

export default function Dashboard() {
  const [stations, setStations]   = useState([]);
  const [stationId, setStationId] = useState("");
  const [summary, setSummary]     = useState([]);
  const [charts, setCharts]       = useState({});
  const [groupBy, setGroupBy]     = useState("day");
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  // Load stations
  useEffect(() => {
    stationsApi.getAll().then(setStations).catch(() => {});
  }, []);

  // Auto-select first station
  useEffect(() => {
    if (stations.length && !stationId) setStationId(stations[0].id);
  }, [stations]);

  // Load data when station or groupBy changes
  useEffect(() => {
    if (!stationId) return;
    setLoading(true);
    setError(null);

    Promise.all([
      measurementsApi.summary({ station_id: stationId }),
      ...Object.keys(VAR_META).map((code) =>
        measurementsApi
          .byDate({ station_id: stationId, variable_code: code, group_by: groupBy })
          .then((data) => ({ code, data }))
          .catch(() => ({ code, data: [] }))
      ),
    ])
      .then(([summaryData, ...chartResults]) => {
        setSummary(summaryData);
        const map = {};
        chartResults.forEach(({ code, data }) => { map[code] = data; });
        setCharts(map);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [stationId, groupBy]);

  const stationOpts = stations.map((s) => ({ value: s.id, label: s.name }));

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Dashboard</h1>
          <p className="page__subtitle">Resumen de mediciones ambientales</p>
        </div>
        <div className="page__controls">
          <Select
            label="Estación"
            value={stationId}
            onChange={setStationId}
            options={stationOpts}
            placeholder="Seleccionar..."
          />
          <Select
            label="Agrupación"
            value={groupBy}
            onChange={setGroupBy}
            options={PERIOD_OPTS}
          />
        </div>
      </header>

      {error && <Alert>{error}</Alert>}
      {loading && <Spinner />}

      {!loading && (
        <>
          {/* ── Summary stats ───────────────────────────────── */}
          <section className="stats-grid">
            {Object.entries(VAR_META).map(([code, meta]) => {
              const row = summary.find((s) => s.variable_code === code);
              return (
                <StatCard
                  key={code}
                  label={meta.label}
                  value={row ? row.avg.toFixed(2) : null}
                  unit={meta.unit}
                  icon={meta.icon}
                  color={meta.color}
                />
              );
            })}
          </section>

          {/* ── Charts ──────────────────────────────────────── */}
          <div className="charts-grid">
            {Object.entries(VAR_META).map(([code, meta]) => {
              const data = charts[code] || [];
              return (
                <Card key={code} className="chart-card">
                  <div className="chart-card__header">
                    <span style={{ color: meta.color }}>{meta.icon}</span>
                    <h3>{meta.label}</h3>
                    <Badge label={meta.unit} color={meta.color} />
                  </div>
                  {data.length === 0 ? (
                    <p className="empty-hint">Sin datos para esta estación</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id={`grad-${code}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={meta.color} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={meta.color} stopOpacity={0}   />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis
                          dataKey="period"
                          tickFormatter={fmt}
                          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                          interval="preserveStartEnd"
                        />
                        <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
                        <Tooltip
                          formatter={(v) => [`${v.toFixed(2)} ${meta.unit}`, "Promedio"]}
                          labelFormatter={fmt}
                          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}
                        />
                        <Area
                          type="monotone"
                          dataKey="avg"
                          stroke={meta.color}
                          strokeWidth={2}
                          fill={`url(#grad-${code})`}
                          dot={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </Card>
              );
            })}
          </div>

          {/* ── Summary table ───────────────────────────────── */}
          {summary.length > 0 && (
            <Card>
              <h3 style={{ marginBottom: "1rem" }}>
                <TrendingUp size={16} style={{ marginRight: 6 }} />
                Estadísticas detalladas
              </h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Variable</th><th>Min</th><th>Máx</th>
                      <th>Promedio</th><th>Registros</th><th>Período</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((row) => {
                      const meta = VAR_META[row.variable_code] || {};
                      return (
                        <tr key={row.variable_code}>
                          <td>
                            <span style={{ color: meta.color, marginRight: 6 }}>{meta.icon}</span>
                            {row.variable_name}
                          </td>
                          <td>{row.min?.toFixed(2)} {row.unit}</td>
                          <td>{row.max?.toFixed(2)} {row.unit}</td>
                          <td><strong>{row.avg?.toFixed(2)} {row.unit}</strong></td>
                          <td>{row.count?.toLocaleString()}</td>
                          <td style={{ fontSize: "0.75rem", opacity: 0.7 }}>
                            {fmt(row.date_start)} → {fmt(row.date_end)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}