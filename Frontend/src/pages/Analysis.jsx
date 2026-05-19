import { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart, Line, AreaChart, Area,
  BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Brush, Legend,
  ReferenceLine,
} from "recharts";
import { stationsApi, measurementsApi } from "../services/api";
import { Spinner, Alert, Select, Input, Button, Card, Badge } from "../components/ui";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = { TEMP: "#ef4444", HR: "#3b82f6", RAD: "#f59e0b", VIENTO: "#10b981" };
const MONTHS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const HOURS  = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2,"0")}:00`);

const GROUP_OPTS = [
  { value: "hour",  label: "Hora"  },
  { value: "day",   label: "Día"   },
  { value: "month", label: "Mes"   },
  { value: "year",  label: "Año"   },
];

const SECTION_TABS = [
  { id: "overview",  label: "a) Visualización general" },
  { id: "fdp",       label: "b) FDP" },
  { id: "isolines",  label: "c) Distribución temporal" },
  { id: "combined",  label: "d) T × HR combinado" },
];

// ─── Physics helpers ──────────────────────────────────────────────────────────

function pSatH2O(T) {
  return 9.066 * Math.exp(0.0641 * T) - 1.796 * Math.exp(0.0805 * T);
}
function pTotal(Z) {
  return 1013.25 * Math.pow(1 - 2.25577e-5 * Z, 5.2559);
}
function absoluteHumidity(HR, T, Z = 0) {
  const psat = pSatH2O(T);
  const ptot = pTotal(Z);
  const hrFrac = HR / 100;
  return (18000 / 29) * (hrFrac * psat) / (ptot - hrFrac * psat);
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const q = (p) => {
    const idx = p * (n - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return {
    n, mean, std: Math.sqrt(variance),
    min: sorted[0], max: sorted[n - 1],
    q25: q(0.25), q50: q(0.5), q75: q(0.75),
  };
}

function gaussian(x, mu, sigma, w) {
  return w * Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
}

function buildFDP(values, step) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const bins = {};
  values.forEach(v => {
    const k = Math.round(v / step) * step;
    bins[k] = (bins[k] || 0) + 1;
  });
  const total = values.length;
  return Object.entries(bins)
    .map(([k, cnt]) => ({ x: parseFloat(k), freq: cnt / total / step }))
    .sort((a, b) => a.x - b.x);
}

function fitGaussians(fdp, nGauss = 2) {
  if (!fdp.length) return [];
  const sorted = [...fdp].sort((a, b) => b.freq - a.freq);
  const peaks = sorted.slice(0, nGauss).sort((a, b) => a.x - b.x);
  return peaks.map((p, i) => {
    const next = peaks[i + 1];
    const sigma = next ? Math.abs(next.x - p.x) / 2.5 : 2;
    return { mu: p.x, sigma: Math.max(sigma, 0.5), w: 1 / nGauss };
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatsBadge({ label, value, unit, color }) {
  return (
    <div style={{
      background: "var(--surface-2, #1e293b)", borderRadius: 8,
      padding: "10px 14px", minWidth: 90, textAlign: "center",
    }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || "var(--text)" }}>
        {typeof value === "number" ? value.toFixed(2) : value}
      </div>
      {unit && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{unit}</div>}
    </div>
  );
}

function SectionCard({ title, subtitle, children }) {
  return (
    <Card style={{ marginBottom: "1.5rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>{title}</h3>
        {subtitle && <p style={{ margin: "4px 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>{subtitle}</p>}
      </div>
      {children}
    </Card>
  );
}

const fmt = (str) => {
  if (!str) return "";
  const d = new Date(str);
  return isNaN(d) ? str : d.toLocaleDateString("es-CR");
};

// ─── Section A: Overview ──────────────────────────────────────────────────────

function SectionOverview({ tempData, hrData, stationAlt }) {
  const tValues = tempData.map(d => d.avg).filter(Boolean);
  const hValues = hrData.map(d => d.avg).filter(Boolean);
  const tStats  = stats(tValues);
  const hStats  = stats(hValues);

  // Data quality indicator
  const dataQuality = (pct) => {
    if (pct >= 98) return { label: "Excelente", color: "#22c55e" };
    if (pct >= 95) return { label: "Bueno",     color: "#3b82f6" };
    if (pct >= 90) return { label: "Aceptable", color: "#eab308" };
    if (pct >= 85) return { label: "Regular",   color: "#f97316" };
    return { label: "Deficiente", color: "#ef4444" };
  };

  // Detect anomalies (values > mean ± 3σ)
  const anomaliesT = tStats
    ? tempData.filter(d => d.avg && Math.abs(d.avg - tStats.mean) > 3 * tStats.std)
    : [];

  return (
    <>
      {/* Stats row */}
      {tStats && (
        <SectionCard title="Estadísticas — Temperatura (T)" subtitle="Cuartiles, media y desviación">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1rem" }}>
            <StatsBadge label="Media"  value={tStats.mean} unit="°C" color="#ef4444" />
            <StatsBadge label="Desv."  value={tStats.std}  unit="°C" />
            <StatsBadge label="Mín"    value={tStats.min}  unit="°C" />
            <StatsBadge label="Máx"    value={tStats.max}  unit="°C" />
            <StatsBadge label="Q25"    value={tStats.q25}  unit="°C" />
            <StatsBadge label="Q50"    value={tStats.q50}  unit="°C" />
            <StatsBadge label="Q75"    value={tStats.q75}  unit="°C" />
            <StatsBadge label="N datos" value={tStats.n}   />
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={tempData} margin={{ top: 8, right: 16, left: -10, bottom: 8 }}>
              <defs>
                <linearGradient id="tGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} unit="°C" />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }} />
              {tStats && <ReferenceLine y={tStats.mean}    stroke="#ef4444" strokeDasharray="4 2" label={{ value: "Media", fontSize: 10, fill: "#ef4444" }} />}
              {tStats && <ReferenceLine y={tStats.q75}     stroke="#f97316" strokeDasharray="2 4" label={{ value: "Q75",   fontSize: 10, fill: "#f97316" }} />}
              {tStats && <ReferenceLine y={tStats.q25}     stroke="#f97316" strokeDasharray="2 4" label={{ value: "Q25",   fontSize: 10, fill: "#f97316" }} />}
              <Area type="monotone" dataKey="max"  name="Máx"      stroke="#ef4444" fill="none"      strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg"  name="Promedio" stroke="#ef4444" fill="url(#tGrad)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="min"  name="Mín"      stroke="#ef4444" fill="none"      strokeWidth={1} opacity={0.4} dot={false} />
              <Brush dataKey="period" height={20} stroke="#ef4444" tickFormatter={fmt} />
              <Legend />
            </AreaChart>
          </ResponsiveContainer>
          {anomaliesT.length > 0 && (
            <Alert type="warning" style={{ marginTop: 8 }}>
              ⚠️ {anomaliesT.length} períodos con valores anómalos detectados (±3σ)
            </Alert>
          )}
        </SectionCard>
      )}

      {hStats && (
        <SectionCard title="Estadísticas — Humedad Relativa (HR)" subtitle="Cuartiles, moda y desviación">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1rem" }}>
            <StatsBadge label="Media"   value={hStats.mean} unit="%" color="#3b82f6" />
            <StatsBadge label="Desv."   value={hStats.std}  unit="%" />
            <StatsBadge label="Mín"     value={hStats.min}  unit="%" />
            <StatsBadge label="Máx"     value={hStats.max}  unit="%" />
            <StatsBadge label="Q25"     value={hStats.q25}  unit="%" />
            <StatsBadge label="Q50"     value={hStats.q50}  unit="%" />
            <StatsBadge label="Q75"     value={hStats.q75}  unit="%" />
            <StatsBadge label="N datos" value={hStats.n} />
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={hrData} margin={{ top: 8, right: 16, left: -10, bottom: 8 }}>
              <defs>
                <linearGradient id="hGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} unit="%" domain={[0, 100]} />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }} />
              {hStats && <ReferenceLine y={hStats.mean} stroke="#3b82f6" strokeDasharray="4 2" label={{ value: "Media", fontSize: 10, fill: "#3b82f6" }} />}
              <Area type="monotone" dataKey="max"  name="Máx"      stroke="#3b82f6" fill="none"       strokeWidth={1} opacity={0.4} dot={false} />
              <Area type="monotone" dataKey="avg"  name="Promedio" stroke="#3b82f6" fill="url(#hGrad)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="min"  name="Mín"      stroke="#3b82f6" fill="none"       strokeWidth={1} opacity={0.4} dot={false} />
              <Brush dataKey="period" height={20} stroke="#3b82f6" tickFormatter={fmt} />
              <Legend />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  );
}

// ─── Section B: FDP ───────────────────────────────────────────────────────────

function SectionFDP({ tempRaw, hrRaw }) {
  const tFDP   = useMemo(() => buildFDP(tempRaw, 0.1), [tempRaw]);
  const hFDP   = useMemo(() => buildFDP(hrRaw, 1),   [hrRaw]);
  const tStats = useMemo(() => stats(tempRaw), [tempRaw]);
  const hStats = useMemo(() => stats(hrRaw),   [hrRaw]);

  // Fit 2 gaussians for T
  const tGaussians = useMemo(() => fitGaussians(tFDP, 2), [tFDP]);
  const hGaussians = useMemo(() => fitGaussians(hFDP, 2), [hFDP]);

  // Enrich FDP data with gaussian model
  const tFDPWithModel = useMemo(() => tFDP.map(d => ({
    ...d,
    model: tGaussians.reduce((s, g) => s + gaussian(d.x, g.mu, g.sigma, g.w), 0),
  })), [tFDP, tGaussians]);

  const hFDPWithModel = useMemo(() => hFDP.map(d => ({
    ...d,
    model: hGaussians.reduce((s, g) => s + gaussian(d.x, g.mu, g.sigma, g.w), 0),
  })), [hFDP, hGaussians]);

  // R² calculation
  const r2 = (fdp, key) => {
    const yMean = fdp.reduce((s, d) => s + d.freq, 0) / fdp.length;
    const ssTot = fdp.reduce((s, d) => s + (d.freq - yMean) ** 2, 0);
    const ssRes = fdp.reduce((s, d) => s + (d.freq - d[key]) ** 2, 0);
    return 1 - ssRes / ssTot;
  };

  return (
    <>
      <SectionCard
        title="FDP — Temperatura (distribución gaussiana)"
        subtitle="Función de Distribución de Probabilidad ajustada con gaussianas"
      >
        {tStats && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1rem" }}>
            {tGaussians.map((g, i) => (
              <div key={i} style={{ background: "var(--surface-2,#1e293b)", borderRadius: 8, padding: "8px 14px" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Gaussiana {i + 1}</div>
                <div style={{ fontSize: 13 }}>μ = <strong>{g.mu.toFixed(2)}°C</strong></div>
                <div style={{ fontSize: 13 }}>σ = <strong>{g.sigma.toFixed(2)}</strong></div>
                <div style={{ fontSize: 13 }}>w = <strong>{(g.w * 100).toFixed(1)}%</strong></div>
              </div>
            ))}
            {tFDPWithModel.length > 0 && (
              <div style={{ background: "var(--surface-2,#1e293b)", borderRadius: 8, padding: "8px 14px" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Ajuste</div>
                <div style={{ fontSize: 13 }}>R² = <strong>{r2(tFDPWithModel, "model").toFixed(4)}</strong></div>
              </div>
            )}
          </div>
        )}
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={tFDPWithModel} margin={{ top: 8, right: 16, left: -10, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="x" tick={{ fontSize: 10, fill: "var(--text-muted)" }} unit="°C" />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
            <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }} />
            <Legend />
            <Area type="monotone" dataKey="freq"  name="FDP real"   stroke="#ef4444" fill="#ef444420" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="model" name="Modelo (Σ Gauss)" stroke="#f97316" fill="none" strokeWidth={2} strokeDasharray="6 3" dot={false} />
            {tStats && <ReferenceLine x={tStats.mean} stroke="#ef4444" strokeDasharray="4 2" label={{ value: "μ", fontSize: 11, fill: "#ef4444" }} />}
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>

      <SectionCard
        title="FDP — Humedad Relativa (distribución Beta)"
        subtitle="Función de Distribución de Probabilidad — clima tropical, múltiples modas"
      >
        {hStats && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1rem" }}>
            {hGaussians.map((g, i) => (
              <div key={i} style={{ background: "var(--surface-2,#1e293b)", borderRadius: 8, padding: "8px 14px" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Curva Beta {i + 1}</div>
                <div style={{ fontSize: 13 }}>Moda ≈ <strong>{g.mu.toFixed(1)}%</strong></div>
                <div style={{ fontSize: 13 }}>Var ≈ <strong>{(g.sigma ** 2).toFixed(1)}</strong></div>
                <div style={{ fontSize: 13 }}>w = <strong>{(g.w * 100).toFixed(1)}%</strong></div>
              </div>
            ))}
            {hFDPWithModel.length > 0 && (
              <div style={{ background: "var(--surface-2,#1e293b)", borderRadius: 8, padding: "8px 14px" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Ajuste</div>
                <div style={{ fontSize: 13 }}>R² = <strong>{r2(hFDPWithModel, "model").toFixed(4)}</strong></div>
              </div>
            )}
          </div>
        )}
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={hFDPWithModel} margin={{ top: 8, right: 16, left: -10, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="x" tick={{ fontSize: 10, fill: "var(--text-muted)" }} unit="%" domain={[0, 100]} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
            <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }} />
            <Legend />
            <Area type="monotone" dataKey="freq"  name="FDP real"       stroke="#3b82f6" fill="#3b82f620" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="model" name="Modelo (Σ Beta)" stroke="#6366f1" fill="none"     strokeWidth={2} strokeDasharray="6 3" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>
    </>
  );
}

// ─── Section C: Isolines / Temporal distribution ──────────────────────────────

function HeatmapCell({ value, min, max, colorStart, colorEnd }) {
  const t = max > min ? (value - min) / (max - min) : 0;
  const r = Math.round(parseInt(colorStart.slice(1,3),16) * (1-t) + parseInt(colorEnd.slice(1,3),16) * t);
  const g = Math.round(parseInt(colorStart.slice(3,5),16) * (1-t) + parseInt(colorEnd.slice(3,5),16) * t);
  const b = Math.round(parseInt(colorStart.slice(5,7),16) * (1-t) + parseInt(colorEnd.slice(5,7),16) * t);
  const bg = `rgb(${r},${g},${b})`;
  const textColor = t > 0.5 ? "#fff" : "#000";
  return (
    <td style={{ background: bg, color: textColor, fontSize: 10, padding: "3px 4px", textAlign: "center", minWidth: 38 }}>
      {value != null ? value.toFixed(1) : "—"}
    </td>
  );
}

function SectionIsolines({ stationId, dateFrom, dateTo }) {
  const [matrixT, setMatrixT] = useState(null);
  const [matrixH, setMatrixH] = useState(null);
  const [dailyT,  setDailyT]  = useState([]);
  const [dailyH,  setDailyH]  = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!stationId) return;
    setLoading(true);
    try {
      const [tHour, hHour, tMonth, hMonth] = await Promise.all([
        measurementsApi.byDate({ station_id: stationId, variable_code: "TEMP", group_by: "hour",  date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({ station_id: stationId, variable_code: "HR",   group_by: "hour",  date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({ station_id: stationId, variable_code: "TEMP", group_by: "month", date_from: dateFrom, date_to: dateTo }),
        measurementsApi.byDate({ station_id: stationId, variable_code: "HR",   group_by: "month", date_from: dateFrom, date_to: dateTo }),
      ]);

      // Build month×hour matrix from hourly data
      const buildMatrix = (hourlyData) => {
        const mat = Array.from({ length: 12 }, () => Array(24).fill(null));
        const counts = Array.from({ length: 12 }, () => Array(24).fill(0));
        hourlyData.forEach(d => {
          const dt = new Date(d.period);
          const m = dt.getMonth();
          const h = dt.getHours();
          if (mat[m][h] === null) mat[m][h] = 0;
          mat[m][h] += d.avg;
          counts[m][h]++;
        });
        return mat.map((row, m) => row.map((v, h) => counts[m][h] > 0 ? v / counts[m][h] : null));
      };

      setMatrixT(buildMatrix(tHour));
      setMatrixH(buildMatrix(hHour));
      setDailyT(tMonth);
      setDailyH(hMonth);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [stationId, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const allT = matrixT ? matrixT.flat().filter(v => v != null) : [];
  const allH = matrixH ? matrixH.flat().filter(v => v != null) : [];
  const minT = allT.length ? Math.min(...allT) : 0;
  const maxT = allT.length ? Math.max(...allT) : 40;
  const minH = allH.length ? Math.min(...allH) : 0;
  const maxH = allH.length ? Math.max(...allH) : 100;

  return (
    <>
      {loading && <Spinner />}

      {/* Heatmap Temperatura */}
      {matrixT && (
        <SectionCard title="c.1) Isolíneas — Temperatura promedio (mes × hora)" subtitle="Mapa de calor: meses del año vs horas del día">
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ padding: "4px 8px", textAlign: "left", color: "var(--text-muted)" }}>Mes \ Hora</th>
                  {HOURS.map(h => <th key={h} style={{ padding: "3px 2px", color: "var(--text-muted)", minWidth: 38, fontWeight: 500 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {MONTHS.map((m, mi) => (
                  <tr key={m}>
                    <td style={{ padding: "3px 8px", color: "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>{m}</td>
                    {matrixT[mi].map((v, hi) => (
                      <HeatmapCell key={hi} value={v} min={minT} max={maxT} colorStart="#1e3a5f" colorEnd="#ef4444" />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 4, alignItems: "center", fontSize: 11, color: "var(--text-muted)" }}>
            <div style={{ width: 80, height: 10, background: "linear-gradient(to right, #1e3a5f, #ef4444)", borderRadius: 4 }} />
            <span>Frío → Cálido ({minT.toFixed(1)}°C — {maxT.toFixed(1)}°C)</span>
          </div>
        </SectionCard>
      )}

      {/* Heatmap HR */}
      {matrixH && (
        <SectionCard title="c.1) Isolíneas — Humedad Relativa promedio (mes × hora)" subtitle="Mapa de calor: meses del año vs horas del día">
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ padding: "4px 8px", textAlign: "left", color: "var(--text-muted)" }}>Mes \ Hora</th>
                  {HOURS.map(h => <th key={h} style={{ padding: "3px 2px", color: "var(--text-muted)", minWidth: 38, fontWeight: 500 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {MONTHS.map((m, mi) => (
                  <tr key={m}>
                    <td style={{ padding: "3px 8px", color: "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>{m}</td>
                    {matrixH[mi].map((v, hi) => (
                      <HeatmapCell key={hi} value={v} min={minH} max={maxH} colorStart="#fffde7" colorEnd="#1565c0" />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 4, alignItems: "center", fontSize: 11, color: "var(--text-muted)" }}>
            <div style={{ width: 80, height: 10, background: "linear-gradient(to right, #fffde7, #1565c0)", borderRadius: 4 }} />
            <span>Seco → Húmedo ({minH.toFixed(1)}% — {maxH.toFixed(1)}%)</span>
          </div>
        </SectionCard>
      )}

      {/* c.3 Variación anual */}
      {(dailyT.length > 0 || dailyH.length > 0) && (
        <SectionCard title="c.3) Variación anual promedio" subtitle="Promedios mensuales de T y HR durante todo el período">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart margin={{ top: 8, right: 40, left: -10, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="period" allowDuplicatedCategory={false} tickFormatter={fmt} tick={{ fontSize: 10 }} />
              <YAxis yAxisId="t" unit="°C" tick={{ fontSize: 10, fill: "#ef4444" }} />
              <YAxis yAxisId="h" orientation="right" unit="%" domain={[0,100]} tick={{ fontSize: 10, fill: "#3b82f6" }} />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }} />
              <Legend />
              <Line yAxisId="t" data={dailyT} type="monotone" dataKey="avg" name="T promedio (°C)" stroke="#ef4444" strokeWidth={2} dot={false} />
              <Line yAxisId="h" data={dailyH} type="monotone" dataKey="avg" name="HR promedio (%)" stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  );
}

// ─── Section D: Combined T×HR ─────────────────────────────────────────────────

function SectionCombined({ stationId, stationAlt, dateFrom, dateTo }) {
  const [scatter, setScatter]   = useState([]);
  const [habsData, setHabsData] = useState([]);
  const [loading, setLoading]   = useState(false);

  const load = useCallback(async () => {
    if (!stationId) return;
    setLoading(true);
    try {
      const [tList, hList] = await Promise.all([
        measurementsApi.list({ station_id: stationId, variable_code: "TEMP", date_from: dateFrom, date_to: dateTo, limit: 5000 }),
        measurementsApi.list({ station_id: stationId, variable_code: "HR",   date_from: dateFrom, date_to: dateTo, limit: 5000 }),
      ]);
      const tMap = {};
      (tList.data || []).forEach(d => { tMap[d.measured_at] = d.value; });
      const joined = [];
      (hList.data || []).forEach(d => {
        const T = tMap[d.measured_at];
        if (T != null) {
          const HR = d.value;
          const habs = absoluteHumidity(HR, T, stationAlt || 0);
          joined.push({ T, HR, habs, measured_at: d.measured_at });
        }
      });
      setScatter(joined);

      // Habs time series (monthly avg)
      const byMonth = {};
      joined.forEach(d => {
        const key = new Date(d.measured_at).toISOString().slice(0, 7);
        if (!byMonth[key]) byMonth[key] = { sum: 0, cnt: 0 };
        byMonth[key].sum += d.habs;
        byMonth[key].cnt++;
      });
      setHabsData(
        Object.entries(byMonth)
          .map(([k, v]) => ({ period: k + "-01", avg: v.sum / v.cnt }))
          .sort((a, b) => a.period.localeCompare(b.period))
      );
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [stationId, stationAlt, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // Humectation time % (T>10 and HR>79)
  const humectPct = scatter.length
    ? (scatter.filter(d => d.T > 10 && d.HR > 79).length / scatter.length * 100).toFixed(1)
    : null;

  // Density map (T bins × HR bins)
  const densityData = useMemo(() => {
    if (!scatter.length) return [];
    const tStep = 1, hStep = 5;
    const cells = {};
    scatter.forEach(({ T, HR }) => {
      const tk = Math.round(T / tStep) * tStep;
      const hk = Math.round(HR / hStep) * hStep;
      const key = `${tk}_${hk}`;
      cells[key] = (cells[key] || 0) + 1;
    });
    return Object.entries(cells).map(([k, cnt]) => {
      const [t, h] = k.split("_").map(Number);
      return { T: t, HR: h, count: cnt };
    });
  }, [scatter]);

  const maxCount = densityData.length ? Math.max(...densityData.map(d => d.count)) : 1;

  return (
    <>
      {loading && <Spinner />}

      {/* d.1 Scatter T vs HR */}
      {scatter.length > 0 && (
        <SectionCard title="d.1) Distribución T × HR" subtitle="Diagrama de densidad con contornos de frecuencia">
          {humectPct !== null && (
            <div style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "center" }}>
              <Badge label={`Tiempo de humectación (T>10°C y HR>79%): ${humectPct}%`} color="#6366f1" />
            </div>
          )}
          <ResponsiveContainer width="100%" height={380}>
            <ScatterChart margin={{ top: 8, right: 16, left: -10, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="T"  name="Temperatura" unit="°C" type="number" tick={{ fontSize: 10 }}
                label={{ value: "T (°C)", position: "insideBottom", offset: -5, fontSize: 11 }} />
              <YAxis dataKey="HR" name="Humedad" unit="%" type="number" domain={[0, 100]} tick={{ fontSize: 10 }}
                label={{ value: "HR (%)", angle: -90, position: "insideLeft", fontSize: 11 }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}
                formatter={(v, n) => [typeof v === "number" ? v.toFixed(2) : v, n]} />
              <Scatter
                data={densityData.map(d => ({
                  ...d,
                  opacity: 0.2 + 0.8 * (d.count / maxCount),
                }))}
                name="Densidad"
                fill="#6366f1"
                fillOpacity={0.6}
              />
              {/* Humectation zone reference */}
              <ReferenceLine x={10}  stroke="#f97316" strokeDasharray="4 2" label={{ value: "T=10°C", fontSize: 9, fill: "#f97316" }} />
              <ReferenceLine y={79}  stroke="#f97316" strokeDasharray="4 2" label={{ value: "HR=79%", fontSize: 9, fill: "#f97316", position: "insideTopRight" }} />
            </ScatterChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {/* d.2 Humedad absoluta */}
      {habsData.length > 0 && (
        <SectionCard
          title="d.2) Humedad Absoluta (H abs)"
          subtitle={`Calculada con altitud = ${stationAlt || 0} m s.n.m.  |  Fórmula: Ptot(Z) + Psat(T) + HR`}
        >
          <div style={{ marginBottom: 8, fontSize: 12, color: "var(--text-muted)", fontFamily: "monospace" }}>
            H_abs = (18000/29) × (HR/100 × P_sat) / (P_tot − HR/100 × P_sat)
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={habsData} margin={{ top: 8, right: 16, left: -10, bottom: 8 }}>
              <defs>
                <linearGradient id="habsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="period" tickFormatter={fmt} tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} unit=" g/kg" />
              <Tooltip labelFormatter={fmt} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }} />
              <Area type="monotone" dataKey="avg" name="H abs prom (g/kg)" stroke="#10b981" fill="url(#habsGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {/* d.3 Psychrometric table */}
      {scatter.length > 0 && (
        <SectionCard title="d.3) Gráfico psicrométrico (T vs H abs)" subtitle="Distribución psicrométrica con HR como paramétrica">
          <ResponsiveContainer width="100%" height={340}>
            <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="T" name="T" unit="°C" type="number" tick={{ fontSize: 10 }}
                label={{ value: "T (°C)", position: "insideBottom", offset: -8, fontSize: 11 }} />
              <YAxis dataKey="habs" name="H abs" unit=" g/kg" type="number" tick={{ fontSize: 10 }}
                label={{ value: "H abs (g/kg)", angle: -90, position: "insideLeft", fontSize: 10 }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}
                formatter={(v, n) => [typeof v === "number" ? v.toFixed(3) : v, n]} />
              <Scatter
                data={scatter.slice(0, 2000)}
                name="T vs H abs"
                fill="#10b981"
                fillOpacity={0.3}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Analysis() {
  const [stations,   setStations]   = useState([]);
  const [stationId,  setStationId]  = useState("");
  const [stationAlt, setStationAlt] = useState(0);
  const [dateFrom,   setDateFrom]   = useState("");
  const [dateTo,     setDateTo]     = useState("");
  const [activeTab,  setActiveTab]  = useState("overview");

  // Data for Overview + FDP sections
  const [tempByDay, setTempByDay] = useState([]);
  const [hrByDay,   setHrByDay]   = useState([]);
  const [tempRaw,   setTempRaw]   = useState([]);
  const [hrRaw,     setHrRaw]     = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [queried,   setQueried]   = useState(false);

  useEffect(() => {
    stationsApi.getAll().then((list) => {
      setStations(list);
      if (list.length) {
        setStationId(list[0].id);
        setStationAlt(parseFloat(list[0].altitude) || 0);
      }
    }).catch(() => {});
  }, []);

  const handleStationChange = (id) => {
    setStationId(id);
    const s = stations.find(x => x.id === id);
    setStationAlt(parseFloat(s?.altitude) || 0);
  };

  const run = async () => {
    if (!stationId) return;
    setLoading(true);
    setError(null);
    setQueried(true);
    try {
      const [tDay, hDay, tRaw, hRaw] = await Promise.all([
        measurementsApi.byDate({ station_id: stationId, variable_code: "TEMP", group_by: "day", date_from: dateFrom || undefined, date_to: dateTo || undefined }),
        measurementsApi.byDate({ station_id: stationId, variable_code: "HR",   group_by: "day", date_from: dateFrom || undefined, date_to: dateTo || undefined }),
        measurementsApi.list({ station_id: stationId, variable_code: "TEMP", limit: 50000, date_from: dateFrom || undefined, date_to: dateTo || undefined }),
        measurementsApi.list({ station_id: stationId, variable_code: "HR",   limit: 50000, date_from: dateFrom || undefined, date_to: dateTo || undefined }),
      ]);
      setTempByDay(tDay);
      setHrByDay(hDay);
      setTempRaw((tRaw.data || []).map(d => d.value));
      setHrRaw((hRaw.data   || []).map(d => d.value));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const stationOpts = stations.map(s => ({ value: s.id, label: s.name }));

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Análisis meteorológico</h1>
          <p className="page__subtitle">Visualización, FDP, isolíneas y análisis combinado T×HR</p>
        </div>
      </header>

      {/* ── Filtros globales ──────────────────────────────── */}
      <Card className="filter-card" style={{ marginBottom: "1.25rem" }}>
        <div className="filter-row" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Select label="Estación" value={stationId} onChange={handleStationChange} options={stationOpts} placeholder="Seleccionar..." />
          <Input  label="Altitud (m)" type="number" value={stationAlt} onChange={v => setStationAlt(parseFloat(v) || 0)} style={{ width: 110 }} />
          <Input  label="Desde" type="date" value={dateFrom} onChange={setDateFrom} />
          <Input  label="Hasta" type="date" value={dateTo}   onChange={setDateTo}   />
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <Button onClick={run} disabled={!stationId || loading}>
              {loading ? "Cargando…" : "Consultar"}
            </Button>
          </div>
        </div>
      </Card>

      {error && <Alert>{error}</Alert>}
      {loading && <Spinner />}

      {queried && !loading && (
        <>
          {/* ── Section tabs ───────────────────────────────── */}
          <div style={{ display: "flex", gap: 6, marginBottom: "1.25rem", flexWrap: "wrap" }}>
            {SECTION_TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 500, cursor: "pointer",
                  border: "1px solid var(--border)",
                  background: activeTab === tab.id ? "var(--accent, #6366f1)" : "var(--surface)",
                  color: activeTab === tab.id ? "#fff" : "var(--text)",
                  transition: "all 0.15s",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Section content ────────────────────────────── */}
          {activeTab === "overview" && (
            <SectionOverview tempData={tempByDay} hrData={hrByDay} stationAlt={stationAlt} />
          )}
          {activeTab === "fdp" && (
            <SectionFDP tempRaw={tempRaw} hrRaw={hrRaw} />
          )}
          {activeTab === "isolines" && (
            <SectionIsolines stationId={stationId} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />
          )}
          {activeTab === "combined" && (
            <SectionCombined stationId={stationId} stationAlt={stationAlt} dateFrom={dateFrom || undefined} dateTo={dateTo || undefined} />
          )}
        </>
      )}

      {!queried && (
        <div style={{ textAlign: "center", padding: "3rem 0", color: "var(--text-muted)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🌦️</div>
          <p>Selecciona una estación y haz clic en <strong>Consultar</strong> para comenzar el análisis.</p>
        </div>
      )}
    </div>
  );
}