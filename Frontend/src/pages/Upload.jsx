import { useState, useEffect, useRef } from "react";
import { UploadCloud, CheckCircle, XCircle, Clock, FileText } from "lucide-react";
import { stationsApi, uploadsApi } from "../services/api";
import { Spinner, Alert, Select, Card, Button, Badge } from "../components/ui";

const STATUS_ICON = {
  processed:  <CheckCircle size={16} color="#10b981" />,
  processing: <Clock       size={16} color="#f59e0b" />,
  error:      <XCircle     size={16} color="#ef4444" />,
};

export default function Upload() {
  const [stations, setStations]   = useState([]);
  const [variables, setVariables] = useState([]);
  const [stationId, setStationId] = useState("");
  const [varId, setVarId]         = useState("");
  const [file, setFile]           = useState(null);
  const [dragging, setDragging]   = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState(null);
  const [history, setHistory]     = useState([]);
  const [histLoading, setHistLoading] = useState(true);
  const inputRef = useRef();

  useEffect(() => {
    stationsApi.getAll().then((list) => {
      setStations(list);
      if (list.length) setStationId(list[0].id);
    }).catch(() => {});
    stationsApi.getVariables().then(setVariables).catch(() => {});
    loadHistory();
  }, []);

  const loadHistory = () => {
    setHistLoading(true);
    uploadsApi.history(20)
      .then(setHistory)
      .catch(() => {})
      .finally(() => setHistLoading(false));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const handleSubmit = async () => {
    if (!file || !stationId) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const res = await uploadsApi.upload(file, stationId, varId || null);
      setResult(res);
      setFile(null);
      loadHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const stationOpts  = stations.map((s) => ({ value: s.id,   label: s.name }));
  const variableOpts = variables.map((v) => ({ value: v.id,  label: `${v.code} — ${v.name}` }));

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Cargar datos</h1>
          <p className="page__subtitle">Importa archivos CSV o Excel con mediciones</p>
        </div>
      </header>

      {/* ── Upload form ─────────────────────────────────────── */}
      <Card className="upload-card">
        <div className="upload-fields">
          <Select
            label="Estación *"
            value={stationId}
            onChange={setStationId}
            options={stationOpts}
            placeholder="Seleccionar estación..."
          />
          <Select
            label="Variable (opcional)"
            value={varId}
            onChange={setVarId}
            options={variableOpts}
            placeholder="Detección automática"
          />
        </div>

        {/* Drop zone */}
        <div
          className={`dropzone ${dragging ? "dropzone--active" : ""} ${file ? "dropzone--has-file" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            style={{ display: "none" }}
            onChange={(e) => setFile(e.target.files[0])}
          />
          {file ? (
            <div className="dropzone__file">
              <FileText size={32} />
              <p><strong>{file.name}</strong></p>
              <p style={{ opacity: 0.6, fontSize: "0.85rem" }}>
                {(file.size / 1024).toFixed(1)} KB
              </p>
            </div>
          ) : (
            <div className="dropzone__hint">
              <UploadCloud size={40} />
              <p>Arrastra tu archivo aquí o <u>haz clic para buscar</u></p>
              <p style={{ opacity: 0.5, fontSize: "0.8rem" }}>CSV, XLSX, XLS</p>
            </div>
          )}
        </div>

        <div className="upload-actions">
          {file && (
            <Button variant="ghost" onClick={() => setFile(null)}>
              Quitar archivo
            </Button>
          )}
          <Button
            onClick={handleSubmit}
            disabled={!file || !stationId || uploading}
          >
            {uploading ? "Subiendo…" : "Subir archivo"}
          </Button>
        </div>

        {uploading && <Spinner />}
        {error   && <Alert>{error}</Alert>}
        {result  && (
          <Alert type="success">
            ✅ <strong>{result.filename}</strong> procesado — {result.rows_inserted} filas insertadas
            {result.variable_type && ` (${result.variable_type})`}
          </Alert>
        )}
      </Card>

      {/* ── Upload history ──────────────────────────────────── */}
      <Card>
        <h3 style={{ marginBottom: "1rem" }}>Historial de cargas</h3>
        {histLoading ? <Spinner size={24} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Archivo</th><th>Fuente</th><th>Filas</th>
                  <th>Estado</th><th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: "center", opacity: 0.5 }}>Sin historial</td></tr>
                ) : history.map((f) => {
                  const status = f.status?.startsWith("error") ? "error" : f.status;
                  return (
                    <tr key={f.id}>
                      <td><FileText size={14} style={{ marginRight: 4 }} />{f.filename}</td>
                      <td><Badge label={f.source} color="var(--accent)" /></td>
                      <td>{f.rows_imported}</td>
                      <td>
                        <span className={`status-dot status-dot--${status}`}>
                          {STATUS_ICON[status] || STATUS_ICON.processing}
                          {f.status}
                        </span>
                      </td>
                      <td style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                        {new Date(f.uploaded_at).toLocaleString("es-CR")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: "0.75rem", textAlign: "right" }}>
          <Button variant="ghost" onClick={loadHistory}>Actualizar</Button>
        </div>
      </Card>
    </div>
  );
}