// main.js — punto de entrada: conecta simulación, visualización 3D, gráficas y UI.

import { Simulation } from "./simulation.js";
import { Visualizer } from "./visualization.js";
import { PlotManager } from "./plots.js";
import { TurbineParams, bladeGeometryAt } from "./turbine.js";
import {
  loadAirfoilData,
  isAirfoilDataReady,
  airfoilShapeBlend,
  refXBlend,
  thicknessBlend,
  airfoilLabel,
  airfoilCoeffsBlend,
  db as airfoilDatabase,
  AIRFOIL_INFO,
} from "./airfoilData.js";

// Kick off loading of the real NREL 5MW airfoil polar/shape files (used by
// the BEM Method tab and, via bem.js, by the Full Simulator). Every consumer
// falls back gracefully to an analytic model until this resolves.
loadAirfoilData();

const sim = new Simulation();
const viz = new Visualizer(document.getElementById("viewport"));
const plots = new PlotManager();

// ---------- Configuración de gráficas ----------
const col = {
  power: "#3fb950", aero: "#8b949e", gen: "#2f81f7", rotor: "#f778ba",
  pitch: "#d29922", tsr: "#a371f7", wind: "#56d4dd", thrust: "#f0883e",
  tower: "#e6edf3", blade: "#3fb950", edge: "#f778ba",
};

plots.add(document.getElementById("c_power"), {
  title: "Power", unit: "MW", min: 0,
  series: [{ name: "Electrical", color: col.power }, { name: "Aerodynamic", color: col.aero }],
  extract: (o) => [o.elecPower / 1e6, o.aeroPower / 1e6],
});
plots.add(document.getElementById("c_torque"), {
  title: "Torque", unit: "kNm",
  series: [{ name: "Electrical (LSS)", color: col.gen }, { name: "Aerodynamic", color: col.aero }],
  extract: (o) => [o.genTorque * 97 / 1e3, o.aeroTorque / 1e3],
});
plots.add(document.getElementById("c_rotor"), {
  title: "Rotor speed", unit: "rpm", min: 0,
  series: [{ name: "Rotor", color: col.rotor }],
  extract: (o) => [o.rotorSpeedRPM],
});
plots.add(document.getElementById("c_pitch"), {
  title: "Pitch", unit: "°", min: 0,
  series: [{ name: "Pitch", color: col.pitch }],
  extract: (o) => [o.pitchDeg],
});
plots.add(document.getElementById("c_tsr"), {
  title: "TSR (λ)", unit: "", min: 0,
  series: [{ name: "λ", color: col.tsr }],
  extract: (o) => [o.lambda],
});
plots.add(document.getElementById("c_wind"), {
  title: "Wind", unit: "m/s", min: 0,
  series: [{ name: "Hub", color: col.wind }],
  extract: (o) => [o.wind],
});
plots.add(document.getElementById("c_thrust"), {
  title: "Thrust", unit: "kN", min: 0,
  series: [{ name: "Rotor thrust", color: col.thrust }],
  extract: (o) => [o.thrust / 1e3],
});
plots.add(document.getElementById("c_struct"), {
  title: "Deflections", unit: "m",
  series: [
    { name: "Tower FA", color: col.tower },
    { name: "Blade tip (flap)", color: col.blade },
    { name: "Blade (edge)", color: col.edge },
  ],
  extract: (o) => [o.towerFA, o.bladeTip, o.bladeEdge],
});

// ---------- Estado de ejecución ----------
let running = false;
let speed = 1.0;
let lastWall = 0;
let acc = 0;          // acumulador de tiempo de simulación pendiente
let lastPlotT = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  if (!lastWall) lastWall = ts;
  let dtWall = (ts - lastWall) / 1000;
  lastWall = ts;
  if (dtWall > 0.1) dtWall = 0.1; // evita saltos grandes tras pausa

  if (running) {
    acc += dtWall * speed;
    let steps = 0;
    const maxSteps = 4000;
    let out = sim.last;
    while (acc >= sim.dt && steps < maxSteps) {
      out = sim.step();
      acc -= sim.dt;
      steps++;
      if (out.t - lastPlotT >= 0.05) {
        plots.pushOutputs(out);
        lastPlotT = out.t;
      }
    }
    updateReadouts(out);
  }

  viz.exaggeration = exag;
  viz.update(sim.getVizState());
  plots.draw();
}

// ---------- Lecturas numéricas ----------
const $ = (id) => document.getElementById(id);
function updateReadouts(o) {
  $("g_wind").textContent = o.wind.toFixed(1);
  $("g_power").textContent = (o.elecPower / 1e6).toFixed(2);
  $("g_rotor").textContent = o.rotorSpeedRPM.toFixed(1);
  $("g_pitch").textContent = o.pitchDeg.toFixed(1);
  $("g_tsr").textContent = o.lambda.toFixed(1);
  $("g_gentq").textContent = (o.genTorque * 97 / 1e3).toFixed(0);
  $("g_thrust").textContent = (o.thrust / 1e3).toFixed(0);
  $("g_cp").textContent = o.Cp.toFixed(3);
  $("regionBadge").textContent = o.region === 0 ? "EMERGENCY STOP" : "Region " + o.region;
  $("simTime").textContent = "t = " + o.t.toFixed(1) + " s";
}

// ---------- Controls ----------
let exag = 8;

$("btnPlay").addEventListener("click", () => {
  running = !running;
  $("btnPlay").textContent = running ? "⏸ Pause" : "▶ Start";
  $("btnPlay").classList.toggle("primary", !running);
  lastWall = 0;
});

$("btnReset").addEventListener("click", () => {
  sim.reset();
  plots.clear();
  lastPlotT = 0;
  acc = 0;
  updateEstopButton();
  updateReadouts(sim.last);
});

// Emergency stop: blade feathering + mechanical brake, or re-arm.
function updateEstopButton() {
  const btn = $("btnEstop");
  if (sim.isEmergency) {
    btn.textContent = "⟳ RE-ARM";
    btn.classList.add("armed");
  } else {
    btn.textContent = "⏹ EMERGENCY STOP";
    btn.classList.remove("armed");
  }
}

$("btnEstop").addEventListener("click", () => {
  if (sim.isEmergency) {
    sim.clearEmergency();
  } else {
    sim.emergencyStop();
    // Make sure the simulation runs so the stop sequence is visible.
    if (!running) {
      running = true;
      $("btnPlay").textContent = "⏸ Pause";
      $("btnPlay").classList.remove("primary");
      lastWall = 0;
    }
  }
  updateEstopButton();
});

function bindSlider(id, valId, fmt, onChange) {
  const el = $(id);
  const apply = () => {
    const v = parseFloat(el.value);
    $(valId).textContent = fmt(v);
    onChange(v);
  };
  el.addEventListener("input", apply);
  apply();
}

bindSlider("s_speed", "v_speed", (v) => v.toFixed(2) + "×", (v) => (speed = v));
bindSlider("s_wind", "v_wind", (v) => v.toFixed(1) + " m/s", (v) => (sim.wind.mean = v));
bindSlider("s_turb", "v_turb", (v) => v + " %", (v) => (sim.wind.turbIntensity = v / 100));
bindSlider("s_shear", "v_shear", (v) => v.toFixed(2), (v) => (sim.wind.shear = v));
bindSlider("s_gust", "v_gust", (v) => v.toFixed(1) + " m/s", (v) => (sim.wind.gustAmp = v));
bindSlider("s_gustT", "v_gustT", (v) => v.toFixed(0) + " s", (v) => (sim.wind.gustPeriod = v));
bindSlider("s_exag", "v_exag", (v) => v + "×", (v) => (exag = v));

// Scenarios
const scenarios = {
  rated: { wind: 11.4, turb: 0, gust: 0, shear: 0.14 },
  below: { wind: 8, turb: 4, gust: 0, shear: 0.14 },
  above: { wind: 18, turb: 6, gust: 0, shear: 0.14 },
  gust: { wind: 12, turb: 10, gust: 4, shear: 0.18, gustT: 10 },
  storm: { wind: 24, turb: 18, gust: 3, shear: 0.20, gustT: 8 },
};
document.querySelectorAll(".scenario").forEach((btn) => {
  btn.addEventListener("click", () => {
    const s = scenarios[btn.dataset.scn];
    if (!s) return;
    setSlider("s_wind", s.wind);
    setSlider("s_turb", s.turb);
    setSlider("s_gust", s.gust);
    setSlider("s_shear", s.shear);
    if (s.gustT) setSlider("s_gustT", s.gustT);
    if (!running) {
      running = true;
      $("btnPlay").textContent = "⏸ Pause";
      $("btnPlay").classList.remove("primary");
      lastWall = 0;
    }
  });
});

function setSlider(id, value) {
  const el = $(id);
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

// Toggle plots
$("togglePlots").addEventListener("click", () => {
  const p = $("plots");
  const hidden = p.classList.toggle("collapsed");
  $("togglePlots").textContent = hidden ? "Show plots" : "Hide plots";
  setTimeout(() => { viz.resize(); plots.resize(); }, 220);
});

// Resize
window.addEventListener("resize", () => {
  viz.resize();
  plots.resize();
  if (betzApp) betzApp.resize();
  if (bemApp) bemApp.resize();
});

// ---------- Pestañas / sub-aplicaciones ----------
let betzApp = null; // inicialización perezosa la primera vez que se abre
let bemApp = null;
let bemRendered = false;

// ======== BEM Interactive App ========
class BEMInteractiveApp {
  constructor() {
    this.canvas = document.getElementById("bemCanvas");
    this.plotCanvas = document.getElementById("bemCpPlot");
    this.polarClCanvas = document.getElementById("bemPolarClCanvas");
    this.polarCdCanvas = document.getElementById("bemPolarCdCanvas");
    if (!this.canvas || !this.plotCanvas) return;

    this.ctx = this.canvas.getContext("2d");
    this.plotCtx = this.plotCanvas.getContext("2d");
    this.polarClCtx = this.polarClCanvas ? this.polarClCanvas.getContext("2d") : null;
    this.polarCdCtx = this.polarCdCanvas ? this.polarCdCanvas.getContext("2d") : null;
    
    // Operating conditions
    this.windSpeed = 11.4;  // m/s
    this.rotorSpeed = 12.1; // rpm
    this.pitch = 0.0;       // degrees
    this.radius = 40.0;     // m (radial position to show)
    
    // Turbine geometry (real NREL 5MW reference turbine, from turbine.js)
    this.rotorRadius = TurbineParams.rotorRadius; // m
    this.hubRadius = TurbineParams.hubRadius;     // m
    
    this.lambda = 7.0;  // TSR for Cp plot
    this.active = false;
    
    this._initControls();
    this._updateResults();
    this._resize();
    
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // Real NREL 5MW blade geometry + spanwise airfoil family, sourced from the
  // same turbine.js table used by the Full Simulator's BEM solver (single
  // source of truth — no more duplicated/simplified taper approximation).
  _getBladeGeometry(r) {
    const geo = bladeGeometryAt(r); // { chord, twist(rad), afLow, afHigh, blend }
    const rNorm = (r - this.hubRadius) / (this.rotorRadius - this.hubRadius);
    const thickness = thicknessBlend(geo.afLow, geo.afHigh, geo.blend);
    return { ...geo, thickness, rNorm };
  }


  _initControls() {
    // Wind speed
    const windSlider = document.getElementById("bem_wind");
    const windVal = document.getElementById("bem_wind_val");
    if (windSlider && windVal) {
      windSlider.addEventListener("input", () => {
        this.windSpeed = parseFloat(windSlider.value);
        windVal.textContent = this.windSpeed.toFixed(1) + " m/s";
        this._updateResults();
      });
    }

    // Rotor speed
    const omegaSlider = document.getElementById("bem_omega");
    const omegaVal = document.getElementById("bem_omega_val");
    if (omegaSlider && omegaVal) {
      omegaSlider.addEventListener("input", () => {
        this.rotorSpeed = parseFloat(omegaSlider.value);
        omegaVal.textContent = this.rotorSpeed.toFixed(1) + " rpm";
        this._updateResults();
      });
    }

    // Pitch angle
    const pitchSlider = document.getElementById("bem_pitch");
    const pitchVal = document.getElementById("bem_pitch_val");
    if (pitchSlider && pitchVal) {
      pitchSlider.addEventListener("input", () => {
        this.pitch = parseFloat(pitchSlider.value);
        pitchVal.textContent = this.pitch.toFixed(1) + "°";
        this._updateResults();
      });
    }

    // Radial position
    const radiusSlider = document.getElementById("bem_radius");
    const radiusVal = document.getElementById("bem_radius_val");
    if (radiusSlider && radiusVal) {
      radiusSlider.addEventListener("input", () => {
        this.radius = parseFloat(radiusSlider.value);
        radiusVal.textContent = this.radius.toFixed(1) + " m";
        this._updateResults();
      });
    }

    // Legacy lambda slider for Cp plot
    const lambdaSlider = document.getElementById("bem_lambda");
    const lambdaVal = document.getElementById("bem_lambda_val");
    if (lambdaSlider && lambdaVal) {
      lambdaSlider.addEventListener("input", () => {
        this.lambda = parseFloat(lambdaSlider.value);
        lambdaVal.textContent = this.lambda.toFixed(1);
        this._updateResults();
      });
    }
  }

  // Simplified Cp model (Gaussian-like peak)
  _computeCp(lambda, pitch) {
    const lambda_opt = 8.1;
    const pitch_opt = 0;
    const dLambda = (lambda - lambda_opt) / 3;
    const dPitch = (pitch - pitch_opt) / 10;
    const dist2 = dLambda * dLambda + dPitch * dPitch;
    const cp_max = 0.48;
    const cp = cp_max * Math.exp(-dist2 * 1.2);
    return Math.max(0, Math.min(0.50, cp));
  }

  _computeCq(lambda, pitch) {
    const cp = this._computeCp(lambda, pitch);
    return lambda > 0.1 ? cp / lambda : 0;
  }

  _computeCt(lambda, pitch) {
    const cp = this._computeCp(lambda, pitch);
    const a = 1 - Math.sqrt(1 - cp / (2 * lambda * lambda + 0.01));
    return 4 * a * (1 - a);
  }

  _updateResults() {
    // Calculate TSR from current operating conditions
    const omegaRad = this.rotorSpeed * 2 * Math.PI / 60; // rpm to rad/s
    const currentLambda = (omegaRad * this.rotorRadius) / (this.windSpeed + 0.01);
    
    const cp = this._computeCp(currentLambda, this.pitch);
    const cq = this._computeCq(currentLambda, this.pitch);
    const ct = this._computeCt(currentLambda, this.pitch);

    const lambdaDisplay = document.getElementById("bem_lambda_display");
    const cpVal = document.getElementById("bem_cp_val");
    const cqVal = document.getElementById("bem_cq_val");
    const ctVal = document.getElementById("bem_ct_val");
    const status = document.getElementById("bem_status");

    const gaugeCp = document.getElementById("bem_gauge_cp");
    const gaugeCq = document.getElementById("bem_gauge_cq");
    const gaugeCt = document.getElementById("bem_gauge_ct");
    const gaugeLambda = document.getElementById("bem_gauge_lambda");
    const gaugePitch = document.getElementById("bem_gauge_pitch");
    const gaugeStatus = document.getElementById("bem_gauge_status");

    if (lambdaDisplay) lambdaDisplay.textContent = currentLambda.toFixed(2);
    if (cpVal) cpVal.textContent = cp.toFixed(3);
    if (cqVal) cqVal.textContent = cq.toFixed(4);
    if (ctVal) ctVal.textContent = ct.toFixed(3);

    if (gaugeCp) gaugeCp.textContent = cp.toFixed(3);
    if (gaugeCq) gaugeCq.textContent = cq.toFixed(4);
    if (gaugeCt) gaugeCt.textContent = ct.toFixed(3);
    if (gaugeLambda) gaugeLambda.textContent = currentLambda.toFixed(2);
    if (gaugePitch) gaugePitch.textContent = this.pitch.toFixed(1);

    const statusText = cp > 0.45 ? "⚡ High eff." : cp > 0.30 ? "✓ Good" : "⚠ Low eff.";
    const statusColor = cp > 0.45 ? "#3fb950" : cp > 0.30 ? "#2f81f7" : "#d29922";
    
    if (status) {
      status.textContent = cp > 0.45 ? "⚡ High efficiency region" :
                           cp > 0.30 ? "✓ Good operating point" :
                           "⚠ Low efficiency";
      status.style.color = statusColor;
    }
    if (gaugeStatus) gaugeStatus.textContent = statusText;

    this._drawPlot();
  }

  _drawPlot() {
    if (!this.plotCanvas) return;
    const canvas = this.plotCanvas;
    const ctx = this.plotCtx;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = "#11151c";
    ctx.fillRect(0, 0, W, H);

    const pad = 40;
    const plotW = W - 2 * pad;
    const plotH = H - 2 * pad;

    // Axes
    ctx.strokeStyle = "#2a323d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, H - pad);
    ctx.lineTo(W - pad, H - pad);
    ctx.moveTo(pad, H - pad);
    ctx.lineTo(pad, pad);
    ctx.stroke();

    // Labels
    ctx.fillStyle = "#8b949e";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Tip speed ratio λ", W / 2, H - 8);
    ctx.save();
    ctx.translate(12, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Cp", 0, 0);
    ctx.restore();

    // Lambda axis ticks
    const lambdaMin = 3, lambdaMax = 12;
    for (let l = 4; l <= 12; l += 2) {
      const x = pad + ((l - lambdaMin) / (lambdaMax - lambdaMin)) * plotW;
      ctx.fillText(l.toString(), x, H - pad + 18);
    }

    // Cp axis ticks
    const cpMax = 0.5;
    for (let c = 0.1; c <= 0.5; c += 0.1) {
      const y = H - pad - (c / cpMax) * plotH;
      ctx.fillText(c.toFixed(1), pad - 18, y + 4);
    }

    // Plot curves for current pitch and nearby
    const pitches = [this.pitch - 5, this.pitch, this.pitch + 5];
    const colors = ["#4a5d7a", "#2f81f7", "#4a5d7a"];
    const widths = [1, 2, 1];

    pitches.forEach((p, i) => {
      ctx.strokeStyle = colors[i];
      ctx.lineWidth = widths[i];
      ctx.beginPath();
      let first = true;
      for (let l = lambdaMin; l <= lambdaMax; l += 0.2) {
        const cp = this._computeCp(l, p);
        const x = pad + ((l - lambdaMin) / (lambdaMax - lambdaMin)) * plotW;
        const y = H - pad - (cp / cpMax) * plotH;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    });

    // Current operating point (calculated from actual conditions)
    const omegaRad = this.rotorSpeed * 2 * Math.PI / 60;
    const currentLambda = (omegaRad * this.rotorRadius) / (this.windSpeed + 0.01);
    
    const x = pad + ((currentLambda - lambdaMin) / (lambdaMax - lambdaMin)) * plotW;
    const cp = this._computeCp(currentLambda, this.pitch);
    const y = H - pad - (cp / cpMax) * plotH;

    ctx.fillStyle = "#3fb950";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Legend
    ctx.font = "10px system-ui";
    ctx.fillStyle = "#8b949e";
    ctx.textAlign = "left";
    const legY = pad + 15;
    ctx.fillText(`β = ${this.pitch.toFixed(1)}° (blue)`, W - 140, legY);
    ctx.fillText(`β ± 5° (gray)`, W - 140, legY + 14);
    ctx.fillStyle = "#3fb950";
    ctx.fillText(`● Current λ=${currentLambda.toFixed(2)}`, W - 140, legY + 28);
  }

  _loop() {
    requestAnimationFrame(this._loop);
    if (!this.active) return;
    this._drawBlade();
    this._drawPolars();
  }

  _drawBlade() {
    if (!this.canvas) return;
    const canvas = this.canvas;
    const ctx = this.ctx;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = "#0e1c2c";
    ctx.fillRect(0, 0, W, H);

    // Two-panel layout: blade overview (left) + element detail (right)
    const splitX = W * 0.42;

    // ===== LEFT PANEL: BLADE OVERVIEW =====
    const centerX = splitX / 2;
    const centerY = H / 2;
    const R = Math.min(splitX * 0.8, H * 0.35);

    // Hub
    ctx.fillStyle = "#2a323d";
    ctx.beginPath();
    ctx.arc(centerX, centerY, R * 0.08, 0, Math.PI * 2);
    ctx.fill();

    // Blade
    ctx.strokeStyle = "#2f81f7";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(centerX, centerY - R);
    ctx.stroke();

    // Calculate which element corresponds to selected radius
    const rNorm = (this.radius - this.hubRadius) / (this.rotorRadius - this.hubRadius);
    const highlightY = centerY - rNorm * R;

    // Element divisions
    const nElements = 8;
    ctx.strokeStyle = "#56d4dd";
    ctx.lineWidth = 1;
    ctx.font = "9px system-ui";
    ctx.fillStyle = "#56d4dd";
    ctx.textAlign = "right";

    for (let i = 1; i <= nElements; i++) {
      const r = (i / nElements) * R;
      const y = centerY - r;
      
      ctx.strokeStyle = "#56d4dd";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(centerX - 10, y);
      ctx.lineTo(centerX + 10, y);
      ctx.stroke();

      if (i % 2 === 0) {
        ctx.fillStyle = "#56d4dd";
        const actualR = this.hubRadius + (i / nElements) * (this.rotorRadius - this.hubRadius);
        ctx.fillText(`${actualR.toFixed(0)}m`, centerX - 14, y + 3);
      }
    }

    // Highlight selected radius
    ctx.strokeStyle = "#3fb950";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(centerX - 12, highlightY);
    ctx.lineTo(centerX + 12, highlightY);
    ctx.stroke();
    
    ctx.fillStyle = "#3fb950";
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`r = ${this.radius.toFixed(1)}m`, centerX + 16, highlightY + 4);

    // Annular ring for highlighted element
    ctx.strokeStyle = "rgba(63, 185, 80, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, rNorm * R, -Math.PI * 0.75, -Math.PI * 0.25);
    ctx.stroke();

    // Rotation arrow
    ctx.strokeStyle = "#f0c040";
    ctx.lineWidth = 2;
    const arrowR = R * 0.2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, arrowR, -Math.PI * 0.3, Math.PI * 0.5);
    ctx.stroke();
    const tipX = centerX + arrowR * Math.cos(Math.PI * 0.5);
    const tipY = centerY + arrowR * Math.sin(Math.PI * 0.5);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 6, tipY - 8);
    ctx.lineTo(tipX + 4, tipY - 4);
    ctx.closePath();
    ctx.fillStyle = "#f0c040";
    ctx.fill();
    ctx.fillStyle = "#f0c040";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(`Ω=${this.rotorSpeed.toFixed(1)}rpm`, centerX + arrowR * 0.6, centerY + arrowR * 0.7);

    // Wind arrow
    ctx.strokeStyle = "#9fe7ec";
    ctx.lineWidth = 2;
    const windY = centerY - R * 1.15;
    ctx.beginPath();
    ctx.moveTo(centerX - 40, windY);
    ctx.lineTo(centerX + 40, windY);
    ctx.stroke();
    for (let side of [-1, 1]) {
      const x = centerX + side * 40;
      ctx.beginPath();
      ctx.moveTo(x, windY);
      ctx.lineTo(x - side * 7, windY - 3);
      ctx.lineTo(x - side * 7, windY + 3);
      ctx.closePath();
      ctx.fillStyle = "#9fe7ec";
      ctx.fill();
    }
    ctx.fillStyle = "#9fe7ec";
    ctx.font = "10px system-ui";
    ctx.fillText(`V∞=${this.windSpeed.toFixed(1)}m/s`, centerX, windY - 10);

    // Title
    ctx.fillStyle = "#e6edf3";
    ctx.font = "12px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("Discretized blade", 10, 18);

    // ===== DIVIDER =====
    ctx.strokeStyle = "#2a323d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, H);
    ctx.stroke();

    // ===== RIGHT PANEL: ELEMENT DETAIL =====
    this._drawElementDetail(ctx, splitX, W, H);
  }

  _drawElementDetail(ctx, splitX, W, H) {
    const rightCenterX = splitX + (W - splitX) / 2;
    const rightCenterY = H / 2;

    // Get blade geometry at selected radius (real NREL 5MW station data)
    const geo = this._getBladeGeometry(this.radius);
    const twistDeg = geo.twist * 180 / Math.PI;
    const afText = airfoilLabel(geo.afLow, geo.afHigh, geo.blend);

    ctx.fillStyle = "#e6edf3";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(`Section at r = ${this.radius.toFixed(1)} m`, rightCenterX, 18);
    ctx.fillStyle = "#8b949e";
    ctx.font = "9px system-ui";
    ctx.fillText(`Chord: ${geo.chord.toFixed(2)}m | Twist: ${twistDeg.toFixed(1)}° | Thickness: ${(geo.thickness*100).toFixed(0)}%`, 
                 rightCenterX, 32);
    ctx.fillStyle = "#56d4dd";
    ctx.fillText(`Profile: ${afText}`, rightCenterX, 44);

    // Calculate velocities
    const omegaRad = this.rotorSpeed * 2 * Math.PI / 60; // rpm to rad/s
    const a = 0.33; // Approximate induction factor
    const aPrime = 0.0; // Approximate tangential induction
    
    const vAxial = this.windSpeed * (1 - a);
    const vTang = omegaRad * this.radius * (1 + aPrime);
    const vRel = Math.sqrt(vAxial * vAxial + vTang * vTang);
    const phi = Math.atan2(vAxial, vTang) * 180 / Math.PI;
    const alpha = phi - twistDeg - this.pitch;

    // Real Cl/Cd at the actual angle of attack — this is what makes the
    // pitch angle affect more than just the profile drawing: changing
    // pitch changes alpha, which changes Cl/Cd, which changes the dL/dD
    // force vectors drawn further below.
    const alphaRad = alpha * Math.PI / 180;
    const { cl, cd } = airfoilCoeffsBlend(geo.afLow, geo.afHigh, geo.blend, alphaRad);
    ctx.fillStyle = "#8b949e";
    ctx.font = "9px system-ui";
    ctx.fillText(`α = ${alpha.toFixed(1)}° | Cl = ${cl.toFixed(2)} | Cd = ${cd.toFixed(3)}`, rightCenterX, 56);

    // Draw airfoil profile - scale based on actual chord and rotate by twist + pitch
    // Use meters to pixels scale: 1m = 50 pixels for reference
    const metersToPixels = 50;
    const airfoilScale = geo.chord * metersToPixels;
    const airfoilX = rightCenterX;
    const airfoilY = rightCenterY - 80;
    
    // Total blade angle = local twist + pitch (both in degrees)
    const bladeAngle = twistDeg + this.pitch;

    // Real NREL 5MW airfoil shape (blended between the two bracketing
    // stations), or null while the data files are still loading.
    const realShape = airfoilShapeBlend(geo.afLow, geo.afHigh, geo.blend);
    const refX = realShape ? refXBlend(geo.afLow, geo.afHigh, geo.blend) : 0.5;
    // Fallback (data not loaded yet): approximate NACA4 profile, treating
    // near-circular root stations (thickness ~100%) as a plain circle.
    const useCircular = geo.thickness > 0.9;

    this._drawAirfoil(ctx, airfoilX, airfoilY, airfoilScale, geo.thickness, bladeAngle, useCircular, realShape, refX);

    // Aerodynamic center / Reference point / Origin of dT, dQ, dL, dD vectors:
    // In BEM methodology, forces are calculated at the quarter-chord point (25% chord)
    // which serves as the aerodynamic center for subsonic profiles.
    // Let's place the aerodynamic center (forceOrigin) at the actual 25% chord point, which is:
    // x_ac = (0.25 - refX) * 2 * airfoilScale [rotated by bladeAngle]
    const acFraction = 0.25;
    const acXOffset = (acFraction - refX) * 2 * airfoilScale;
    const bladeAngleRad = bladeAngle * Math.PI / 180;
    const forceOriginX = airfoilX + acXOffset * Math.cos(bladeAngleRad);
    const forceOriginY = airfoilY + acXOffset * Math.sin(bladeAngleRad);

    // Draw aerodynamic center marker (AC)
    ctx.fillStyle = "#ff6a5c";
    ctx.beginPath();
    ctx.arc(forceOriginX, forceOriginY, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "bold 9px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("AC (c/4)", forceOriginX, forceOriginY - 8);

    // Chord line (horizontal - represents rotor plane)
    ctx.strokeStyle = "#8b949e";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(airfoilX - airfoilScale * 1.2, airfoilY);
    ctx.lineTo(airfoilX + airfoilScale * 1.2, airfoilY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Label for rotor plane
    ctx.fillStyle = "#8b949e";
    ctx.font = "9px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("Rotor plane (Plane of rotation)", airfoilX + airfoilScale * 1.25, airfoilY + 3);

    // Horizontal line through the Aerodynamic Center (parallel to rotor plane)
    ctx.strokeStyle = "rgba(139, 148, 158, 0.4)";
    ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(forceOriginX - airfoilScale, forceOriginY);
    ctx.lineTo(forceOriginX + airfoilScale, forceOriginY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Chord line along the actual pitched/twisted airfoil
    ctx.strokeStyle = "#2f81f7";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(airfoilX - refX * 2 * airfoilScale * Math.cos(bladeAngleRad), airfoilY - refX * 2 * airfoilScale * Math.sin(bladeAngleRad));
    ctx.lineTo(airfoilX + (1 - refX) * 2 * airfoilScale * Math.cos(bladeAngleRad), airfoilY + (1 - refX) * 2 * airfoilScale * Math.sin(bladeAngleRad));
    ctx.stroke();
    ctx.setLineDash([]);

    // Velocity vectors origin - moved to a lower position with respect to the airfoil
    const vecOriginX = airfoilX - airfoilScale * 0.4;
    const vecOriginY = airfoilY + 200;

    // Use FIXED scale for vectors to avoid visual coupling
    // Scale to make vectors visible: 1 m/s = 3 pixels
    const vecScale = 3;

    // Axial velocity (V_axial)
    const vAxialLen = vAxial * vecScale;
    ctx.strokeStyle = "#9fe7ec";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(vecOriginX, vecOriginY);
    ctx.lineTo(vecOriginX, vecOriginY + vAxialLen);
    ctx.stroke();
    this._drawArrowhead(ctx, vecOriginX, vecOriginY + vAxialLen, 0, Math.PI / 2, "#9fe7ec");
    ctx.fillStyle = "#9fe7ec";
    ctx.font = "13px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(`V∞(1-a)`, vecOriginX - 10, vecOriginY + vAxialLen / 2);
    ctx.fillText(`${vAxial.toFixed(1)}m/s`, vecOriginX - 10, vecOriginY + vAxialLen / 2 + 16);

    // Tangential velocity (Ωr)
    const vTangLen = vTang * vecScale;
    ctx.strokeStyle = "#f0c040";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(vecOriginX, vecOriginY);
    ctx.lineTo(vecOriginX + vTangLen, vecOriginY);
    ctx.stroke();
    this._drawArrowhead(ctx, vecOriginX + vTangLen, vecOriginY, Math.PI / 2, 0, "#f0c040");
    ctx.fillStyle = "#f0c040";
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(`Ωr(1+a')`, vecOriginX + vTangLen / 2, vecOriginY - 12);
    ctx.fillText(`${vTang.toFixed(1)}m/s`, vecOriginX + vTangLen / 2, vecOriginY - 26);

    // Relative velocity W (resultant)
    ctx.strokeStyle = "#f0883e";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(vecOriginX, vecOriginY);
    ctx.lineTo(vecOriginX + vTangLen, vecOriginY + vAxialLen);
    ctx.stroke();
    const wAngle = Math.atan2(vAxialLen, vTangLen);
    this._drawArrowhead(ctx, vecOriginX + vTangLen, vecOriginY + vAxialLen, wAngle, wAngle, "#f0883e");
    ctx.fillStyle = "#f0883e";
    ctx.font = "13px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`W=${vRel.toFixed(1)}m/s`, vecOriginX + vTangLen + 12, vecOriginY + vAxialLen / 2 - 8);

    // Angle phi - INCREASED SIZE
    const phiRadius = 50;
    ctx.strokeStyle = "#56d4dd";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(vecOriginX, vecOriginY, phiRadius, 0, wAngle);
    ctx.stroke();
    ctx.fillStyle = "#56d4dd";
    ctx.font = "13px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`φ=${phi.toFixed(1)}°`, vecOriginX + phiRadius + 5, vecOriginY + 12);

    // DRAW RELATIVE WIND VECTOR ("W") VISUALLY SEEN BY THE AIRFOIL AT THE AC
    // Let's project W pointing towards the Aerodynamic Center (originating from upwind: left-bottom)
    const windWLen = 130; // visible vector size
    const relativeWindAngle = wAngle;
    const wStartX = forceOriginX - windWLen * Math.cos(relativeWindAngle);
    const wStartY = forceOriginY - windWLen * Math.sin(relativeWindAngle);

    ctx.strokeStyle = "#f0883e";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(wStartX, wStartY);
    ctx.lineTo(forceOriginX, forceOriginY);
    ctx.stroke();
    this._drawArrowhead(ctx, forceOriginX, forceOriginY, relativeWindAngle, relativeWindAngle, "#f0883e");
    
    ctx.fillStyle = "#f0883e";
    ctx.font = "italic 11px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(`Relative Wind (W)`, forceOriginX - 35 * Math.cos(relativeWindAngle), forceOriginY - 35 * Math.sin(relativeWindAngle) - 6);

    // DRAW THE ANGLE OF ATTACK (α) ON THE AIRFOIL
    // It's the angle between the relative wind (direction relativeWindAngle) and the chord line (direction bladeAngleRad)
    // Let's draw an arc representing α inside the sector between blade angle (twist+pitch) and inflow angle (phi)
    const aoaRadius = 80;
    ctx.strokeStyle = "#ff6a5c";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(forceOriginX, forceOriginY, aoaRadius, Math.min(bladeAngleRad, relativeWindAngle), Math.max(bladeAngleRad, relativeWindAngle));
    ctx.stroke();

    // Draw label for Angle of Attack α
    const midAoAAngle = (bladeAngleRad + relativeWindAngle) / 2;
    ctx.fillStyle = "#ff6a5c";
    ctx.font = "bold 11px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`α = ${alpha.toFixed(1)}°`, forceOriginX + (aoaRadius + 10) * Math.cos(midAoAAngle), forceOriginY + (aoaRadius + 10) * Math.sin(midAoAAngle));

    // Aerodynamic forces - length driven by the REAL Cl(α)/Cd(α) computed
    // above, so pitch (which changes α) visibly changes these vectors too,
    // not just the profile rotation. Reference coefficients set the scale
    // at which a "typical" cl/cd renders at the old fixed 135px/33.75px
    // lengths; lift direction flips sign with cl (e.g. near-zero pitch vs.
    // heavily feathered blade), and drag length is clamped so deep-stall
    // cd spikes stay on-screen.
    const forceScale = 135;
    const clRef = 1.0;
    const cdRef = 0.01;
    const liftLen = Math.max(-1.6, Math.min(1.6, cl / clRef)) * forceScale;
    const dragLen = Math.max(0, Math.min(1.6, cd / cdRef)) * (forceScale * 0.25);

    // dL (lift, perpendicular to W; sign of cl flips which side it points to)
    const liftAngle = wAngle + Math.PI / 2;
    const liftEndX = forceOriginX + liftLen * Math.cos(liftAngle);
    const liftEndY = forceOriginY + liftLen * Math.sin(liftAngle);
    ctx.strokeStyle = "#3fb950";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(forceOriginX, forceOriginY);
    ctx.lineTo(liftEndX, liftEndY);
    ctx.stroke();
    this._drawArrowhead(ctx, liftEndX, liftEndY, liftAngle, Math.sign(liftLen) >= 0 ? liftAngle : liftAngle + Math.PI, "#3fb950");
    ctx.fillStyle = "#3fb950";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("dL", liftEndX + 18 * Math.cos(liftAngle) * Math.sign(liftLen || 1), liftEndY + 18 * Math.sin(liftAngle) * Math.sign(liftLen || 1));

    // dD (drag, parallel to W)
    const dragAngle = wAngle;
    const dragEndX = forceOriginX + dragLen * Math.cos(dragAngle);
    const dragEndY = forceOriginY + dragLen * Math.sin(dragAngle);
    ctx.strokeStyle = "#d29922";
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(forceOriginX, forceOriginY);
    ctx.lineTo(dragEndX, dragEndY);
    ctx.stroke();
    this._drawArrowhead(ctx, dragEndX, dragEndY, dragAngle, dragAngle, "#d29922");
    ctx.fillStyle = "#d29922";
    ctx.font = "12px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("dD", dragEndX + 10, dragEndY);

    // Integration explanation
    ctx.fillStyle = "#8b949e";
    ctx.font = "10px system-ui";
    ctx.textAlign = "center";
    const explainY = H - 70;
    ctx.fillText("From elementary forces dL and dD, we obtain:", rightCenterX, explainY);
    ctx.fillText(`• Elementary thrust: dT = (dL cos φ + dD sin φ) · dr`, rightCenterX, explainY + 15);
    ctx.fillText(`• Elementary torque: dQ = r · (dL sin φ - dD cos φ) · dr`, rightCenterX, explainY + 30);
    
    ctx.fillStyle = "#3fb950";
    ctx.font = "11px system-ui";
    ctx.fillText(`Integrate from r=${this.hubRadius.toFixed(1)}m to R=${this.rotorRadius.toFixed(0)}m → Total T, Total Q`, rightCenterX, explainY + 50); 
  }

  _drawAirfoil(ctx, x, y, scale, thicknessRatio, angleDegs, useCircular, realShape, refX) {
    // Draw the airfoil profile, rotated by angleDegs (twist + pitch) about
    // its pitch/reference axis so it aligns correctly with the rotor plane.
    ctx.strokeStyle = "#2f81f7";
    ctx.lineWidth = 2;
    
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angleDegs * Math.PI / 180);

    if (realShape) {
      // Real NREL 5MW airfoil coordinates (blended between the two
      // bracketing stations' families) — a genuine profile, not an
      // approximation, so every radial position looks different.
      ctx.beginPath();
      for (let i = 0; i < realShape.length; i++) {
        const px = (realShape[i].x - refX) * 2 * scale;
        const py = -realShape[i].y * scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(47, 129, 247, 0.15)";
      ctx.fill();
      ctx.stroke();
    } else if (useCircular) {
      // Fallback while data loads: circular profile near root
      const radius = scale * thicknessRatio * 0.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
      
      // Fill with semi-transparent blue
      ctx.fillStyle = "rgba(47, 129, 247, 0.2)";
      ctx.fill();
    } else {
      // Fallback while data loads: NACA 4-digit approximation
      ctx.beginPath();
      
      const nPoints = 30;
      const points = [];
      
      // Upper surface
      for (let i = 0; i <= nPoints; i++) {
        const xc = i / nPoints; // Chord position [0, 1]
        const yt = 5 * thicknessRatio * (0.2969 * Math.sqrt(xc) - 
                                         0.1260 * xc - 
                                         0.3516 * xc * xc + 
                                         0.2843 * xc * xc * xc - 
                                         0.1015 * xc * xc * xc * xc);
        const px = -scale + xc * 2 * scale;
        const py = -yt * scale;
        points.push({ x: px, y: py });
      }
      
      // Draw upper surface
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      
      // Lower surface (reversed)
      for (let i = nPoints; i >= 0; i--) {
        const xc = i / nPoints;
        const yt = 5 * thicknessRatio * (0.2969 * Math.sqrt(xc) - 
                                         0.1260 * xc - 
                                         0.3516 * xc * xc + 
                                         0.2843 * xc * xc * xc - 
                                         0.1015 * xc * xc * xc * xc);
        const px = -scale + xc * 2 * scale;
        const py = yt * scale;
        ctx.lineTo(px, py);
      }
      
      ctx.closePath();
      ctx.fillStyle = "rgba(47, 129, 247, 0.15)";
      ctx.fill();
      ctx.stroke();
    }
    
    ctx.restore();
  }

  _drawPolars() {
    if (!this.polarClCanvas || !this.polarCdCanvas || !this.polarClCtx || !this.polarCdCtx) return;
    
    // Sourced coordinates & current blending
    const geo = this._getBladeGeometry(this.radius);
    
    // Angle of Attack calculations
    const omegaRad = this.rotorSpeed * 2 * Math.PI / 60;
    const a = 0.33;
    const vAxial = this.windSpeed * (1 - a);
    const vTang = omegaRad * this.radius;
    const phi = Math.atan2(vAxial, vTang) * 180 / Math.PI;
    const twistDeg = geo.twist * 180 / Math.PI;
    const alpha = phi - twistDeg - this.pitch; // Current Angle of Attack in degrees
    
    const clCanvas = this.polarClCanvas;
    const cdCanvas = this.polarCdCanvas;
    const clCtx = this.polarClCtx;
    const cdCtx = this.polarCdCtx;
    
    const clRect = clCanvas.getBoundingClientRect();
    const cdRect = cdCanvas.getBoundingClientRect();
    const clW = clRect.width;
    const clH = clRect.height;
    const cdW = cdRect.width;
    const cdH = cdRect.height;
    
    // Clear and draw backgrounds
    clCtx.fillStyle = "#11151c";
    clCtx.fillRect(0, 0, clW, clH);
    cdCtx.fillStyle = "#11151c";
    cdCtx.fillRect(0, 0, cdW, cdH);
    
    const pad = 28;
    const clPlotW = clW - 2 * pad;
    const clPlotH = clH - 2 * pad;
    const cdPlotW = cdW - 2 * pad;
    const cdPlotH = cdH - 2 * pad;
    
    // Draw axes
    [clCtx, cdCtx].forEach((ctx, idx) => {
      const W = idx === 0 ? clW : cdW;
      const H = idx === 0 ? clH : cdH;
      const plotH = idx === 0 ? clPlotH : cdPlotH;
      
      ctx.strokeStyle = "#2a323d";
      ctx.lineWidth = 1;
      ctx.beginPath();
      // X axis
      ctx.moveTo(pad, H - pad);
      ctx.lineTo(W - pad, H - pad);
      // Y axis
      ctx.moveTo(pad, H - pad);
      ctx.lineTo(pad, pad);
      ctx.stroke();
      
      // X Label
      ctx.fillStyle = "#8b949e";
      ctx.font = "9px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("Angle of attack α (°)", W / 2, H - 6);
    });
    
    // Draw Cl Y-Label
    clCtx.fillStyle = "#8b949e";
    clCtx.font = "9px system-ui";
    clCtx.textAlign = "center";
    clCtx.save();
    clCtx.translate(10, clH / 2);
    clCtx.rotate(-Math.PI / 2);
    clCtx.fillText("Lift Coeff. Cl", 0, 0);
    clCtx.restore();
    
    // Draw Cd Y-Label
    cdCtx.fillStyle = "#8b949e";
    cdCtx.font = "9px system-ui";
    cdCtx.textAlign = "center";
    cdCtx.save();
    cdCtx.translate(10, cdH / 2);
    cdCtx.rotate(-Math.PI / 2);
    cdCtx.fillText("Drag Coeff. Cd", 0, 0);
    cdCtx.restore();

    // Scale settings: Alpha domain [-30°, +30°]
    const alphaMin = -30, alphaMax = 30;
    
    // Cl range [-1.5, +1.5]
    const clMin = -1.5, clMax = 1.5;
    // Cd range [0, 0.4]
    const cdMin = 0, cdMax = 0.4;
    
    // Ticks & Grid
    // Alpha ticks (every 10°)
    for (let aVal = -20; aVal <= 20; aVal += 10) {
      const xCl = pad + ((aVal - alphaMin) / (alphaMax - alphaMin)) * clPlotW;
      const xCd = pad + ((aVal - alphaMin) / (alphaMax - alphaMin)) * cdPlotW;
      
      clCtx.fillStyle = "#555";
      clCtx.fillText(aVal.toString(), xCl, clH - pad + 12);
      cdCtx.fillStyle = "#555";
      cdCtx.fillText(aVal.toString(), xCd, cdH - pad + 12);
    }
    
    // Cl Y-ticks
    for (let clVal = -1.0; clVal <= 1.0; clVal += 0.5) {
      const y = clH - pad - ((clVal - clMin) / (clMax - clMin)) * clPlotH;
      clCtx.fillStyle = "#555";
      clCtx.textAlign = "right";
      clCtx.fillText(clVal.toFixed(1), pad - 6, y + 3);
    }
    
    // Cd Y-ticks
    for (let cdVal = 0.1; cdVal <= 0.3; cdVal += 0.1) {
      const y = cdH - pad - ((cdVal - cdMin) / (cdMax - cdMin)) * cdPlotH;
      cdCtx.fillStyle = "#555";
      cdCtx.textAlign = "right";
      cdCtx.fillText(cdVal.toFixed(2), pad - 6, y + 3);
    }
    
    // Draw polar curves
    clCtx.strokeStyle = "#3fb950";
    clCtx.lineWidth = 1.5;
    clCtx.beginPath();
    
    cdCtx.strokeStyle = "#d29922";
    cdCtx.lineWidth = 1.5;
    cdCtx.beginPath();
    
    let first = true;
    for (let aDeg = alphaMin; aDeg <= alphaMax; aDeg += 1) {
      const rad = aDeg * Math.PI / 180;
      const { cl: valCl, cd: valCd } = airfoilCoeffsBlend(geo.afLow, geo.afHigh, geo.blend, rad);
      
      const xCl = pad + ((aDeg - alphaMin) / (alphaMax - alphaMin)) * clPlotW;
      const yCl = clH - pad - ((valCl - clMin) / (clMax - clMin)) * clPlotH;
      
      const xCd = pad + ((aDeg - alphaMin) / (alphaMax - alphaMin)) * cdPlotW;
      const yCd = cdH - pad - ((valCd - cdMin) / (cdMax - cdMin)) * cdPlotH;
      
      if (first) {
        clCtx.moveTo(xCl, yCl);
        cdCtx.moveTo(xCd, yCd);
        first = false;
      } else {
        clCtx.lineTo(xCl, yCl);
        cdCtx.lineTo(xCd, yCd);
      }
    }
    clCtx.stroke();
    cdCtx.stroke();
    
    // Plot current operating alpha point
    if (alpha >= alphaMin && alpha <= alphaMax) {
      const rad = alpha * Math.PI / 180;
      const { cl: targetCl, cd: targetCd } = airfoilCoeffsBlend(geo.afLow, geo.afHigh, geo.blend, rad);
      
      // Draw Cl point
      const ptClX = pad + ((alpha - alphaMin) / (alphaMax - alphaMin)) * clPlotW;
      const ptClY = clH - pad - ((targetCl - clMin) / (clMax - clMin)) * clPlotH;
      clCtx.fillStyle = "#ff6a5c";
      clCtx.beginPath();
      clCtx.arc(ptClX, ptClY, 4, 0, Math.PI * 2);
      clCtx.fill();
      
      // Draw Cd point
      const ptCdX = pad + ((alpha - alphaMin) / (alphaMax - alphaMin)) * cdPlotW;
      const ptCdY = cdH - pad - ((targetCd - cdMin) / (cdMax - cdMin)) * cdPlotH;
      cdCtx.fillStyle = "#ff6a5c";
      cdCtx.beginPath();
      cdCtx.arc(ptCdX, ptCdY, 4, 0, Math.PI * 2);
      cdCtx.fill();
      
      // Vertical indicator line in both
      [clCtx, cdCtx].forEach((ctx, idx) => {
        const H = idx === 0 ? clH : cdH;
        const ptX = idx === 0 ? ptClX : ptCdX;
        ctx.strokeStyle = "rgba(255, 106, 92, 0.4)";
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(ptX, pad);
        ctx.lineTo(ptX, H - pad);
        ctx.stroke();
        ctx.setLineDash([]);
      });
      
      // Value labels
      clCtx.fillStyle = "#ff6a5c";
      clCtx.textAlign = "left";
      clCtx.font = "9px system-ui";
      clCtx.fillText(`α=${alpha.toFixed(1)}°, Cl=${targetCl.toFixed(2)}`, ptClX + 8, ptClY - 4);
      
      cdCtx.fillStyle = "#ff6a5c";
      cdCtx.textAlign = "left";
      cdCtx.font = "9px system-ui";
      cdCtx.fillText(`α=${alpha.toFixed(1)}°, Cd=${targetCd.toFixed(3)}`, ptCdX + 8, ptCdY - 4);
    }
  }

  _drawArrowhead(ctx, x, y, angle, direction, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 12 * Math.cos(direction) + 6 * Math.sin(direction), 
               y - 12 * Math.sin(direction) - 6 * Math.cos(direction));
    ctx.lineTo(x - 12 * Math.cos(direction) - 6 * Math.sin(direction), 
               y - 12 * Math.sin(direction) + 6 * Math.cos(direction));
    ctx.closePath();
    ctx.fill();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    
    if (this.canvas) {
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.ctx.scale(dpr, dpr);
    }

    if (this.plotCanvas) {
      const rect = this.plotCanvas.getBoundingClientRect();
      this.plotCanvas.width = rect.width * dpr;
      this.plotCanvas.height = rect.height * dpr;
      this.plotCtx.scale(dpr, dpr);
      this._drawPlot();
    }

    if (this.polarClCanvas) {
      const rect = this.polarClCanvas.getBoundingClientRect();
      this.polarClCanvas.width = rect.width * dpr;
      this.polarClCanvas.height = rect.height * dpr;
      if (this.polarClCtx) this.polarClCtx.scale(dpr, dpr);
    }

    if (this.polarCdCanvas) {
      const rect = this.polarCdCanvas.getBoundingClientRect();
      this.polarCdCanvas.width = rect.width * dpr;
      this.polarCdCanvas.height = rect.height * dpr;
      if (this.polarCdCtx) this.polarCdCtx.scale(dpr, dpr);
    }
  }

  setActive(active) {
    this.active = active;
    if (active) {
      setTimeout(() => this._resize(), 30);
    }
  }

  resize() {
    this._resize();
  }
}

function renderBemEquations() {
  if (bemRendered || typeof katex === "undefined") return;
  const defs = {
    bem_eq_annulus_1:
      "\\tan(\\phi)=\\frac{V_\\infty(1-a)}{\\Omega r(1+a')}\\,,\\qquad\\alpha=\\phi-(\\beta+\\theta(r))",
    bem_eq_annulus_2:
      "dT=\\tfrac12\\rho W^2c\\,(C_l\\cos\\phi+C_d\\sin\\phi)\\,B\\,dr\\\\dQ=\\tfrac12\\rho W^2c\\,(C_l\\sin\\phi-C_d\\cos\\phi)\\,B\\,r\\,dr",
    bem_eq_totals:
      "T=\\int_{r_{hub}}^{R} dT\\,,\\qquad Q=\\int_{r_{hub}}^{R} dQ\\,,\\qquad P=\\Omega Q",
    bem_eq_coeffs:
      "C_P=\\frac{P}{\\tfrac12\\rho A V_\\infty^3}\\,,\\qquad C_Q=\\frac{Q}{\\tfrac12\\rho A R V_\\infty^2}\\,,\\qquad C_T=\\frac{T}{\\tfrac12\\rho A V_\\infty^2}",
    bem_eq_maps:
      "C_P[i,j]=C_P(\\lambda_i,\\beta_j),\\quad C_Q[i,j]=C_Q(\\lambda_i,\\beta_j),\\quad C_T[i,j]=C_T(\\lambda_i,\\beta_j)",
  };
  Object.entries(defs).forEach(([id, expr]) => {
    const el = document.getElementById(id);
    if (!el) return;
    katex.render(expr, el, { displayMode: true, throwOnError: false });
  });
  bemRendered = true;
}

function activateTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name)
  );
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === "tab-" + name)
  );
  document.body.classList.toggle("tab-betz-active", name !== "simulator");

  if (name === "betz") {
    if (!betzApp) {
      import("./betz.js").then(({ BetzApp }) => {
        betzApp = new BetzApp(document.getElementById("betzViewport"));
        // Wait for container to have correct dimensions
        setTimeout(() => { betzApp.setActive(true); }, 30);
      });
    } else {
      // Wait for container to become visible and resize
      setTimeout(() => { betzApp.setActive(true); }, 30);
    }
  } else if (betzApp) {
    betzApp.setActive(false);
  }

  if (name === "bem") {
    renderBemEquations();
    if (!bemApp) {
      bemApp = new BEMInteractiveApp();
      setTimeout(() => { bemApp.setActive(true); }, 30);
    } else {
      setTimeout(() => { bemApp.setActive(true); }, 30);
    }
  } else if (bemApp) {
    bemApp.setActive(false);
  }

  if (name === "simulator") {
    // El contenedor recupera su tamaño al hacerse visible.
    setTimeout(() => { viz.resize(); plots.resize(); }, 30);
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

// Inicializa lecturas y arranca el bucle de render
activateTab("betz");
updateReadouts(sim.last);
requestAnimationFrame((ts) => { lastWall = ts; requestAnimationFrame(loop); });
