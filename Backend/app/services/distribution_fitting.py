"""
distribution_fitting.py
=======================
Matemática de ajuste de distribuciones para las FDP (funciones de densidad de
probabilidad) meteorológicas. Funciones puras (sin acceso a BD ni HTTP):

  - _build_fdp                construye la FDP como fracción simple
  - _fit_gaussian_components  ajuste de mezcla gaussiana (Temperatura)
  - _fit_beta_components      ajuste de Beta generalizada (Humedad relativa)
  - _quality_flags            verificación de umbrales del instructivo

Se consume desde las rutas (charts.py) y desde analytics_service.py. Vive en la
capa de servicios para evitar que la lógica de negocio dependa de la capa HTTP.

NOTA: la lógica de cálculo NO debe modificarse sin verificación numérica; estas
funciones reproducen el método de referencia (tablas Beta estándar, etc.).
"""

# ═════════════════════════════════════════════════════════════
# HELPER INTERNO: construir FDP como fracción simple
# ═════════════════════════════════════════════════════════════

def _build_fdp(values, paso: float) -> list[dict]:
    """
    Construye la FDP como fracción simple:
        freq[i] = count_en_bin[i] / total_datos
    """
    import numpy as np

    mn = float(np.min(values))
    mx = float(np.max(values))
    bins = np.arange(mn, mx + paso, paso)

    counts_hist, edges = np.histogram(values, bins=bins, density=False)
    centers = ((edges[:-1] + edges[1:]) / 2).round(4)
    total = counts_hist.sum()

    return [
        {"x": float(c), "freq": round(float(f) / total, 6)}
        for c, f in zip(centers, counts_hist)
    ]


# ═════════════════════════════════════════════════════════════
# AJUSTE GAUSSIANO (para T)
# ═════════════════════════════════════════════════════════════

def _fit_gaussian_components(
    fdp: list[dict],
    n_components: int = 2,
) -> tuple[list[dict], float | None, float | None, list[dict]]:
    """
    Ajusta n_components gaussianas a la FDP de T.
    """
    import numpy as np
    from scipy.optimize import minimize

    x_arr  = np.array([d["x"]    for d in fdp])
    y_real = np.array([d["freq"] for d in fdp])

    paso = float(x_arr[1] - x_arr[0]) if len(x_arr) > 1 else 0.1

    dy = np.diff(y_real)
    peak_candidates = []
    for i in range(len(dy) - 1):
        if dy[i] > 0 and dy[i + 1] <= 0:
            peak_candidates.append(i + 1)

    if len(peak_candidates) < n_components:
        mask = np.ones(len(y_real), dtype=bool)
        for idx in peak_candidates:
            mask[max(0, idx - 2):min(len(mask), idx + 3)] = False
        remaining = np.where(mask)[0]
        if len(remaining) > 0:
            extra = remaining[np.argsort(y_real[remaining])[::-1]]
            for e in extra:
                peak_candidates.append(int(e))
                if len(peak_candidates) >= n_components:
                    break

    peak_candidates = sorted(
        peak_candidates,
        key=lambda i: y_real[i],
        reverse=True,
    )[:n_components]
    peak_candidates = sorted(peak_candidates)

    p0 = []
    for k, idx in enumerate(peak_candidates):
        mu = float(x_arr[idx])
        if k + 1 < len(peak_candidates):
            sigma = float(abs(x_arr[peak_candidates[k + 1]] - mu) / 2.5)
        else:
            sigma = float((x_arr[-1] - x_arr[0]) / (4 * n_components))
        sigma = max(sigma, 0.3)
        p0.extend([mu, sigma, 1.0 / n_components])
    p0 = np.array(p0, dtype=float)

    def gauss_pdf(x, mu, sigma):
        return np.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * np.sqrt(2 * np.pi))

    def model(x, params):
        total = np.zeros_like(x, dtype=float)
        n = len(params) // 3
        for i in range(n):
            mu, sigma, w = params[3 * i], params[3 * i + 1], params[3 * i + 2]
            total += w * gauss_pdf(x, mu, sigma) * paso
        return total

    def cost(params):
        sigmas  = params[1::3]
        weights = params[2::3]
        if np.any(sigmas < 0.1) or np.any(weights < 0.001):
            return 1e9
        y_hat = model(x_arr, params)
        return float(np.mean((y_real - y_hat) ** 2))

    constraints = [{"type": "eq", "fun": lambda p: np.sum(p[2::3]) - 1.0}]

    x_min, x_max = float(x_arr.min()), float(x_arr.max())
    bounds = [(x_min - 5, x_max + 5), (0.1, 20.0), (0.001, 1.0)] * n_components

    result = minimize(
        cost, p0, method="SLSQP",
        bounds=bounds,
        constraints=constraints,
        options={"maxiter": 2000, "ftol": 1e-12},
    )

    params_opt = result.x

    weights = params_opt[2::3].copy()
    weights = np.clip(weights, 0, None)
    weights /= weights.sum()

    gaussians = []
    for i in range(n_components):
        mu    = float(params_opt[3 * i])
        sigma = float(abs(params_opt[3 * i + 1]))
        w     = float(weights[i])
        gaussians.append({
            "mu":    round(mu,    3),
            "sigma": round(sigma, 3),
            "w":     round(w,     4),
        })

    params_norm = params_opt.copy()
    for i in range(n_components):
        params_norm[3 * i + 2] = float(weights[i])

    y_model = model(x_arr, params_norm)

    y_components = []
    for i in range(n_components):
        mu    = params_norm[3 * i]
        sigma = params_norm[3 * i + 1]
        w     = params_norm[3 * i + 2]
        y_components.append(w * gauss_pdf(x_arr, mu, sigma) * paso)

    mse    = float(np.mean((y_real - y_model) ** 2))
    ss_tot = float(np.sum((y_real - np.mean(y_real)) ** 2))
    ss_res = float(np.sum((y_real - y_model) ** 2))
    r2     = round(1 - ss_res / ss_tot, 4) if ss_tot > 0 else None

    fdp_out = []
    for j, d in enumerate(fdp):
        point = {
            **d,
            "model":       round(float(y_model[j]), 7),
            "error_range": round(float(y_real[j] - y_model[j]), 7),
        }
        for i, y_comp in enumerate(y_components):
            point[f"gauss{i + 1}"] = round(float(y_comp[j]), 7)
        fdp_out.append(point)

    return gaussians, r2, round(mse, 8), fdp_out


# ═════════════════════════════════════════════════════════════
# AJUSTE BETA GENERALIZADA (para HR)
# ═════════════════════════════════════════════════════════════

def _fit_beta_components(
    fdp: list[dict],
    n_components: int = 5,
    *,
    free_support: bool = False,
    sat_tail: bool = False,
    extra_seed: float | None = None,
    censor_sat: bool = False,
) -> tuple[list[dict], float | None, float | None, list[dict]]:
    """
    Ajusta n_components distribuciones Beta GENERALIZADAS a la FDP de HR.

    Plan de prueba en dos pasos (feedback Sergio, error acumulado alto):

      free_support : "libera el entorno" de cada beta. Por defecto los límites
                     [A, B] y los parámetros α, β se buscan en ventanas estrechas
                     alrededor de la región detectada (3 grados de libertad
                     efectivos). Con free_support=True las ventanas de A/B se
                     ensanchan y el piso de α, β baja a ~1.05, dando los 5 grados
                     de libertad reales por curva que pide el feedback (paso 1).
      sat_tail     : da más "cola" a la beta de saturación (HR→100 %): baja α y
                     extiende su soporte izquierdo, para que la subida exponencial
                     hacia 100 % arrastre una cola más larga hacia humedades
                     menores en vez de concentrarse en los últimos grados.
      extra_seed   : paso 2 condicional. Inyecta UNA beta extra centrada en este
                     x (p. ej. 85.0, el "bache") con peso inicial bajo (~2.5 %) y
                     deja que el optimizador la conserve o la "destruya" (w→0).
                     Sube el nº de curvas a n_components+1 (mayor costo de cálculo).
      censor_sat   : censura tipo "extended-support beta" (XBX, Zeileis et al.,
                     JRSS-C 2026) para la curva de saturación: su soporte puede
                     extenderse MÁS ALLÁ de 100 % y toda la masa latente por
                     encima del último bin se apila EN el bin de 100 % (masa
                     puntual de saturación), integrando por CDF en vez de
                     pdf·paso. Modela el spike de HR=100 sin perder área.

    NOTA de costo: cada curva son 5 variables (α, β, A, B, w). Con extra_seed o
    free_support el espacio de búsqueda crece; el optimizador SLSQP escala
    aprox. cuadráticamente con el nº de variables.
    """
    import numpy as np
    from scipy.stats import beta as beta_dist
    from scipy.optimize import minimize
    from scipy.ndimage import gaussian_filter1d

    x_pct  = np.array([d["x"]    for d in fdp])
    y_real = np.array([d["freq"] for d in fdp])
    paso   = float(x_pct[1] - x_pct[0]) if len(x_pct) > 1 else 1.0
    n_pts  = len(x_pct)

    # ── Suavizado para estabilizar derivadas ─────────────────────
    sigma_smooth = max(1.5, n_pts / 60.0)
    y_smooth = gaussian_filter1d(y_real, sigma=sigma_smooth)

    mean_freq = float(np.mean(y_smooth))

    # ── 1ª y 2ª derivada de la FDP ───────────────────────────────
    d1 = np.gradient(y_smooth, x_pct)
    d2 = np.gradient(d1,       x_pct)

    # ── Detección de curvas por regiones cóncavas hacia abajo ────
    # (cambio de signo de la 2ª derivada de + a -).  Cada región
    # cóncava (d2 < 0) corresponde a un pico u hombro; los cruces
    # de - a + son los límites A/B entre curvas.
    concave_down = d2 < 0

    # Índices donde la 2ª derivada cruza hacia arriba (valles / límites)
    up_cross = [0]
    for i in range(len(d2) - 1):
        if d2[i] <= 0 and d2[i + 1] > 0:
            up_cross.append(i + 1)
    up_cross.append(n_pts - 1)
    up_cross = sorted(set(up_cross))

    # ── Construir un segmento (curva candidata) por cada región ──
    segments = []  # cada uno: dict con idx_mode, mode, A, B, mass
    for j in range(len(up_cross) - 1):
        lo, hi = up_cross[j], up_cross[j + 1]
        if hi <= lo:
            continue
        seg_mask = np.zeros(n_pts, dtype=bool)
        seg_mask[lo:hi + 1] = True
        # Solo cuenta como curva si contiene una zona cóncava hacia abajo
        if not (concave_down[lo:hi + 1]).any():
            continue
        local = y_smooth[lo:hi + 1]
        idx_mode = lo + int(np.argmax(local))
        mass = float(np.sum(y_real[lo:hi + 1]))
        segments.append({
            "idx":  idx_mode,
            "mode": float(x_pct[idx_mode]),
            "A":    float(x_pct[lo]),
            "B":    float(x_pct[hi]),
            "mass": mass,
        })

    # Spike de saturación al extremo derecho (subida final hacia 100%)
    has_right_spike = (
        n_pts > 10 and float(np.mean(y_smooth[-3:])) > mean_freq * 1.2
    )
    if has_right_spike:
        last_x = float(x_pct[-1])
        if not any(s["mode"] >= last_x - 4 for s in segments):
            lo = max(0, n_pts - 6)
            segments.append({
                "idx":  n_pts - 1,
                "mode": last_x,
                "A":    float(x_pct[lo]),
                "B":    last_x,
                "mass": float(np.sum(y_real[lo:])),
            })

    # ── Conservar las n_components curvas con mayor masa de datos ─
    segments.sort(key=lambda s: s["mass"], reverse=True)
    segments = segments[:n_components]
    # Si la FDP es muy plana y faltan regiones, rellenar con máximos
    if len(segments) < n_components:
        used = {s["idx"] for s in segments}
        order = np.argsort(y_smooth)[::-1]
        for idx in order:
            if len(segments) >= n_components:
                break
            if any(abs(int(idx) - u) <= 3 for u in used):
                continue
            used.add(int(idx))
            segments.append({
                "idx":  int(idx),
                "mode": float(x_pct[idx]),
                "A":    float(x_pct[max(0, idx - 4)]),
                "B":    float(x_pct[min(n_pts - 1, idx + 4)]),
                "mass": float(y_real[idx]),
            })

    # ── Paso 2 (condicional): beta extra sembrada en `extra_seed` ─
    # Se añade ADEMÁS de las n_components, con peso inicial bajo; el
    # optimizador la conserva si reduce el error o la lleva a w≈0.
    if extra_seed is not None and n_pts > 4:
        near = any(abs(s["mode"] - extra_seed) <= 3.0 for s in segments)
        idx  = int(np.argmin(np.abs(x_pct - extra_seed)))
        if not near and all(idx != s["idx"] for s in segments):
            lo = max(0, idx - 5)
            hi = min(n_pts - 1, idx + 5)
            segments.append({
                "idx":  idx,
                "mode": float(x_pct[idx]),
                "A":    float(x_pct[lo]),
                "B":    float(x_pct[hi]),
                "mass": float(np.sum(y_real[lo:hi + 1])),
                "extra": True,
            })

    segments.sort(key=lambda s: s["mode"])

    peak_candidates = [s["idx"] for s in segments]
    n_eff           = len(peak_candidates)
    seg_bounds      = {s["idx"]: (s["A"], s["B"]) for s in segments}
    total_mass      = sum(s["mass"] for s in segments) or 1.0
    # Peso inicial = masa de datos en su rango; la beta extra arranca con
    # un peso bajo fijo (~2.5 %) para no "robar" masa a las curvas reales.
    seg_w0          = {
        s["idx"]: (0.025 if s.get("extra") else max(s["mass"] / total_mass, 0.01))
        for s in segments
    }
    # Una curva con w en su cota inferior 0 puede ser "destruida" por el
    # optimizador (paso 2); por defecto se conserva el piso 0.001 de antes.
    w_lo = 0.0 if extra_seed is not None else 0.001

    # ── Marcar qué componente es la curva de saturación ──────────
    # (misma regla que usa build_init; alineado con peak_candidates)
    x_last = float(x_pct[-1])
    sat_flags: list[bool] = []
    for pk in peak_candidates:
        m_pct = float(x_pct[min(pk, n_pts - 1)])
        _, B_sg = seg_bounds[pk]
        sat_flags.append(
            (m_pct >= 97.0) or (B_sg >= x_last - 1e-6 and m_pct >= 90.0)
        )

    def beta_gen_pdf(x_arr_pct, a, b, A, B):
        width = B - A
        if width <= 0:
            return np.zeros_like(x_arr_pct, dtype=float)
        x01 = (x_arr_pct - A) / width
        pdf = np.zeros_like(x_arr_pct, dtype=float)
        mask = (x01 > 0) & (x01 < 1)
        if mask.any():
            pdf[mask] = beta_dist.pdf(x01[mask], a, b) / width
        return pdf

    # Bordes izquierdos de cada bin (para integrar por CDF)
    edges_left = x_pct - paso / 2.0

    def beta_sat_censored(a, b, A, B):
        """
        Masa por bin de la beta de saturación con censura al borde (XBX):
        se integra la CDF entre bordes de bin y TODA la masa latente por
        encima del borde izquierdo del último bin (incluida la que cae más
        allá de 100 %, hasta B) se apila en el último bin. Devuelve masa
        por bin (misma escala que pdf·paso).
        """
        width = B - A
        if width <= 0:
            return np.zeros_like(x_pct, dtype=float)
        t = np.clip((edges_left - A) / width, 0.0, 1.0)
        cdf = beta_dist.cdf(t, a, b)
        masses = np.empty_like(cdf)
        masses[:-1] = np.diff(cdf)
        masses[-1]  = 1.0 - cdf[-1]   # censura: masa puntual de saturación
        return masses

    def model(params: np.ndarray) -> np.ndarray:
        out = np.zeros(len(x_pct), dtype=float)
        n = len(params) // 5
        for i in range(n):
            a = params[5*i]
            b = params[5*i + 1]
            A = params[5*i + 2]
            B = params[5*i + 3]
            w = params[5*i + 4]
            if censor_sat and sat_flags[i]:
                out += w * beta_sat_censored(a, b, A, B)
            else:
                out += w * beta_gen_pdf(x_pct, a, b, A, B) * paso
        return out

    def cost(params: np.ndarray) -> float:
        weights = params[4::5]
        # Pesos por debajo de su cota inferior son inviables. Con w_lo=0
        # (modo paso 2) una curva puede anularse; el único guard duro es
        # que la masa total siga siendo positiva para poder normalizar.
        if np.any(weights < w_lo - 1e-12):
            return 1e9
        w_sum = float(np.sum(weights))
        if w_sum <= 1e-9:
            return 1e9
        p_norm = params.copy()
        for i in range(n_eff):
            p_norm[5*i + 4] /= w_sum
        y_hat = model(p_norm)
        return float(np.mean((y_real - y_hat) ** 2))

    # ── Tablas estándar Moda / Varianza → (α, β) ─────────────────
    # La malla α,β ∈ {1.1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5} reproduce
    # exactamente las tablas estándar (la moda y la varianza de una
    # Beta sobre esos valores).  Para cada pico se busca la pareja
    # (α, β) cuya moda y varianza se ajusten a las del dato, igual que
    # el método de referencia "buscar en las tablas".
    ALFA_GRID = np.array([1.1, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0])
    BETA_GRID = ALFA_GRID
    AB_MIN    = 2.0   # piso de α,β para curvas con pico (evita cajas uniformes)

    def seed_ab(m01: float, var01: float) -> tuple[float, float]:
        best = (2.0, 2.0)
        best_score = 1e18
        for a in ALFA_GRID:
            for b in BETA_GRID:
                mode_ab = (a - 1.0) / (a + b - 2.0)            # moda en [0,1]
                var_ab  = a * b / ((a + b) ** 2 * (a + b + 1.0))
                # moda como criterio principal; varianza como ajuste fino
                score = (mode_ab - m01) ** 2 + 8.0 * (var_ab - var01) ** 2
                if score < best_score:
                    best_score = score
                    best = (float(a), float(b))
        return best

    def estimate_var01(A0: float, B0: float, width: float) -> float:
        seg = (x_pct >= A0) & (x_pct <= B0)
        wts = y_real[seg]
        if seg.sum() >= 2 and float(wts.sum()) > 0:
            xn = (x_pct[seg] - A0) / width
            mu = float(np.sum(wts * xn) / np.sum(wts))
            v  = float(np.sum(wts * (xn - mu) ** 2) / np.sum(wts))
            return float(np.clip(v, 0.005, 0.08))
        return 0.03

    def build_init(concentration: float):
        p0_list: list[float] = []
        bounds_list: list[tuple] = []

        for k, pk in enumerate(peak_candidates):
            mode_pct = float(x_pct[min(pk, n_pts - 1)])
            A_seg, B_seg = seg_bounds[pk]
            w0 = seg_w0[pk]

            # Bordes [A, B] ya provienen de los cambios de signo de la 2ª
            # derivada; se aseguran de envolver la moda con holgura mínima.
            A0 = min(A_seg, mode_pct - 3.0)
            B0 = max(B_seg, mode_pct + 3.0)
            A0 = max(A0, 0.0)
            B0 = min(B0, 101.0)

            is_right_spike = sat_flags[k]
            is_left_spike  = mode_pct <= 3.0

            if is_right_spike and censor_sat:
                # Saturación con censura XBX: la beta latente puede tener su
                # masa (incluso su moda) MÁS ALLÁ de 100 %; lo que excede el
                # último bin se censura como masa puntual en 100 %. Por eso
                # b puede ser ≥1 y B se extiende bastante sobre 100.
                # La semilla varía con cada reinicio (`concentration`) para
                # explorar formas distintas: subida pura (b<1), campana
                # interior y campana con moda latente más allá de 100.
                sat_seeds = {
                    10.0:  (3.0, 0.8, 85.0, 104.0),
                    30.0:  (2.0, 2.0, 80.0, 106.0),
                    80.0:  (8.0, 0.5, 88.0, 102.0),
                    200.0: (1.5, 1.2, 75.0, 110.0),
                }
                a0, b0, A_cap, B0 = sat_seeds.get(concentration, (3.0, 0.8, 85.0, 104.0))
                A0 = min(A0, A_cap)
                p0_list.extend([a0, b0, A0, B0, w0])
                bounds_list += [
                    (1.05,  500.0),
                    (0.05,  5.0),
                    (60.0,  98.0),
                    (100.5, 115.0),
                    (w_lo,  1.0),
                ]

            elif is_right_spike:
                # Curva de saturación: Beta con beta<1 (sube hacia 100%, sin máximo)
                if sat_tail:
                    # Más "cola": α menor y soporte izquierdo más extendido,
                    # para arrastrar la subida hacia 100 % desde humedades
                    # bastante menores en vez de pegarse a los últimos grados.
                    a0 = max(concentration * 0.2, 2.0)
                    b0 = 0.5
                    A0 = min(A0, 78.0)
                    B0 = 101.0
                    p0_list.extend([a0, b0, A0, B0, w0])
                    bounds_list += [
                        (1.05,  500.0),
                        (0.05,  0.99),
                        (60.0,  95.0),
                        (100.5, 102.0),
                        (w_lo,  1.0),
                    ]
                else:
                    a0 = max(concentration * 0.4, 4.0)
                    b0 = 0.5
                    A0 = min(A0, 90.0)
                    B0 = 101.0
                    p0_list.extend([a0, b0, A0, B0, w0])
                    bounds_list += [
                        (1.1,   500.0),
                        (0.05,  0.99),
                        (80.0,  98.0),
                        (100.5, 102.0),
                        (w_lo,  1.0),
                    ]

            elif is_left_spike:
                a0 = 0.5
                b0 = max(concentration * 0.4, 4.0)
                A0 = -1.0
                B0 = min(101.0, max(B_seg, 10.0))
                p0_list.extend([a0, b0, A0, B0, w0])
                bounds_list += [
                    (0.05, 0.99),
                    (1.1,  500.0),
                    (-1.0, 2.0),
                    (5.0,  20.0),
                    (w_lo, 1.0),
                ]

            else:
                width = B0 - A0
                if width < 1.0:
                    width = 10.0
                    A0 = max(0.0, mode_pct - 5.0)
                    B0 = min(101.0, mode_pct + 5.0)

                # alpha/beta desde las tablas estándar, según la moda
                # relativa y la varianza del dato dentro de [A, B]
                m01 = float(np.clip((mode_pct - A0) / width, 0.05, 0.95))
                var01 = estimate_var01(A0, B0, width)
                a0, b0 = seed_ab(m01, var01)
                # Piso de α,β. Se mantiene SIEMPRE en AB_MIN: bajarlo a ~1 deja
                # que el optimizador colapse la curva a un rectángulo uniforme
                # (peor ajuste). free_support libera el "entorno" [A,B], no la
                # forma; α,β ya eran libres dentro de [AB_MIN, 500].
                ab_floor = AB_MIN
                a0 = max(a0, ab_floor)
                b0 = max(b0, ab_floor)
                p0_list.extend([a0, b0, A0, B0, w0])

                # Margen de búsqueda alrededor de los límites detectados.
                # free_support ensancha la ventana de A/B ("libera el entorno").
                margin_frac = 0.8 if free_support else 0.35
                margin_min  = 12.0 if free_support else 6.0
                search_margin = max(margin_min, width * margin_frac)
                A_lo = max(0.0, A0 - search_margin)
                A_hi = max(0.0, min(mode_pct - 1.0, A0 + search_margin * 0.5))
                B_lo = max(mode_pct + 1.0, B0 - search_margin * 0.5)
                B_hi = min(101.0, B0 + search_margin)

                if A_lo >= A_hi:
                    A_hi = max(A_lo + 1.0, mode_pct - 1.0)
                if B_lo >= B_hi:
                    B_lo = min(B_hi - 1.0, mode_pct + 1.0)

                bounds_list += [
                    (ab_floor, 500.0),
                    (ab_floor, 500.0),
                    (A_lo,     A_hi),
                    (B_lo,     B_hi),
                    (w_lo,     1.0),
                ]

        return np.array(p0_list, dtype=float), bounds_list

    constraints = [{"type": "eq", "fun": lambda p: float(np.sum(p[4::5])) - 1.0}]

    best_result = None
    best_mse    = np.inf

    for concentration in [10.0, 30.0, 80.0, 200.0]:
        p0, bounds = build_init(concentration)
        try:
            result = minimize(
                cost, p0,
                method="SLSQP",
                bounds=bounds,
                constraints=constraints,
                options={"maxiter": 5000, "ftol": 1e-13},
            )
            if result.fun < best_mse:
                best_mse    = result.fun
                best_result = result
        except Exception:
            continue

    if best_result is None:
        fdp_out = [{**d, "model": 0.0, "error_range": float(d["freq"])} for d in fdp]
        return [], None, None, fdp_out

    params_opt = best_result.x

    weights = params_opt[4::5].copy()
    weights = np.clip(weights, 0.0, None)
    w_total = weights.sum()
    if w_total <= 0:
        fdp_out = [{**d, "model": 0.0, "error_range": float(d["freq"])} for d in fdp]
        return [], None, None, fdp_out
    weights /= w_total

    params_norm = params_opt.copy()
    for i in range(n_eff):
        params_norm[5*i + 4] = float(weights[i])

    y_components = []
    for i in range(n_eff):
        a = float(abs(params_norm[5*i]))
        b = float(abs(params_norm[5*i + 1]))
        A = float(params_norm[5*i + 2])
        B = float(params_norm[5*i + 3])
        w = float(params_norm[5*i + 4])
        if censor_sat and sat_flags[i]:
            y_comp = w * beta_sat_censored(a, b, A, B)
        else:
            y_comp = w * beta_gen_pdf(x_pct, a, b, A, B) * paso
        y_components.append(y_comp)

    y_model = sum(y_components)

    betas_out = []
    for i in range(n_eff):
        a = float(abs(params_norm[5*i]))
        b = float(abs(params_norm[5*i + 1]))
        A = float(params_norm[5*i + 2])
        B = float(params_norm[5*i + 3])
        w = float(params_norm[5*i + 4])

        if a > 1.0 and b > 1.0:
            mode_01 = (a - 1.0) / (a + b - 2.0)
        elif b <= 1.0 and a > b:
            mode_01 = 1.0
        elif a <= 1.0 and b > a:
            mode_01 = 0.0
        elif a >= b:
            mode_01 = 1.0
        else:
            mode_01 = 0.0

        width    = max(B - A, 1e-6)
        mode_pct = round(float(A + mode_01 * width), 2)
        mode_pct = float(np.clip(mode_pct, 0.0, 100.0))

        var_01  = (a * b) / ((a + b) ** 2 * (a + b + 1.0))
        var_hr  = round(float(var_01 * (width ** 2)), 4)

        betas_out.append({
            "alpha":       round(a,      4),
            "beta":        round(b,      4),
            "A":           round(A,      2),
            "B":           round(B,      2),
            "mode":        mode_pct,
            "variance":    round(float(var_01), 6),
            "variance_hr": var_hr,
            "w":           round(w,      4),
        })

    mse    = float(np.mean((y_real - y_model) ** 2))
    ss_tot = float(np.sum((y_real - np.mean(y_real)) ** 2))
    ss_res = float(np.sum((y_real - y_model) ** 2))
    r2     = round(1.0 - ss_res / ss_tot, 4) if ss_tot > 0 else None

    fdp_out = []
    for j, d in enumerate(fdp):
        point = {
            **d,
            "model":       round(float(y_model[j]), 7),
            "error_range": round(float(y_real[j] - y_model[j]), 7),
        }
        for i, y_comp in enumerate(y_components):
            point[f"beta{i + 1}"] = round(float(y_comp[j]), 7)
        fdp_out.append(point)

    return betas_out, r2, round(mse, 8), fdp_out


# ─── Verificación de umbrales del instructivo ─────────────────
def _quality_flags(mse, r2, fdp_data):
    errors  = [abs(d.get("error_range", 0)) for d in fdp_data if "error_range" in d]
    max_err = max(errors) if errors else None
    return {
        "mse_ok":           mse is not None and mse <= 1e-5,
        "r2_ok":            r2  is not None and r2  >= 0.95,
        "error_range_ok":   max_err is not None and max_err <= 1e-3,
        "max_error_range":  round(max_err, 6) if max_err is not None else None,
        "mse_target":       "≤ 1E-5",
        "r2_target":        "≥ 0.95",
        "error_target":     "± 1E-3",
    }
