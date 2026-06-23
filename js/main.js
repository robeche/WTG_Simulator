// main.js — punto de entrada: conecta simulación, visualización 3D, gráficas y UI.

import { Simulation } from "./simulation.js";
import { Visualizer } from "./visualization.js";
import { PlotManager } from "./plots.js";

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
  title: "Potencia", unit: "MW", min: 0,
  series: [{ name: "Eléctrica", color: col.power }, { name: "Aerodinámica", color: col.aero }],
  extract: (o) => [o.elecPower / 1e6, o.aeroPower / 1e6],
});
plots.add(document.getElementById("c_torque"), {
  title: "Par", unit: "kNm",
  series: [{ name: "Eléctrico (LSS)", color: col.gen }, { name: "Aerodinámico", color: col.aero }],
  extract: (o) => [o.genTorque * 97 / 1e3, o.aeroTorque / 1e3],
});
plots.add(document.getElementById("c_rotor"), {
  title: "Vel. rotor", unit: "rpm", min: 0,
  series: [{ name: "Rotor", color: col.rotor }],
  extract: (o) => [o.rotorSpeedRPM],
});
plots.add(document.getElementById("c_pitch"), {
  title: "Pitch", unit: "°", min: 0,
  series: [{ name: "Paso", color: col.pitch }],
  extract: (o) => [o.pitchDeg],
});
plots.add(document.getElementById("c_tsr"), {
  title: "TSR (λ)", unit: "", min: 0,
  series: [{ name: "λ", color: col.tsr }],
  extract: (o) => [o.lambda],
});
plots.add(document.getElementById("c_wind"), {
  title: "Viento", unit: "m/s", min: 0,
  series: [{ name: "Buje", color: col.wind }],
  extract: (o) => [o.wind],
});
plots.add(document.getElementById("c_thrust"), {
  title: "Empuje", unit: "kN", min: 0,
  series: [{ name: "Empuje rotor", color: col.thrust }],
  extract: (o) => [o.thrust / 1e3],
});
plots.add(document.getElementById("c_struct"), {
  title: "Deflexiones", unit: "m",
  series: [
    { name: "Torre FA", color: col.tower },
    { name: "Punta pala (flap)", color: col.blade },
    { name: "Pala (edge)", color: col.edge },
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
  $("regionBadge").textContent = o.region === 0 ? "PARADA EMERGENCIA" : "Región " + o.region;
  $("simTime").textContent = "t = " + o.t.toFixed(1) + " s";
}

// ---------- Controles ----------
let exag = 8;

$("btnPlay").addEventListener("click", () => {
  running = !running;
  $("btnPlay").textContent = running ? "⏸ Pausar" : "▶ Iniciar";
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

// Parada de emergencia: feathering de palas + freno mecánico, o rearme.
function updateEstopButton() {
  const btn = $("btnEstop");
  if (sim.isEmergency) {
    btn.textContent = "⟳ REARMAR";
    btn.classList.add("armed");
  } else {
    btn.textContent = "⏹ PARADA DE EMERGENCIA";
    btn.classList.remove("armed");
  }
}

$("btnEstop").addEventListener("click", () => {
  if (sim.isEmergency) {
    sim.clearEmergency();
  } else {
    sim.emergencyStop();
    // Asegura que la simulación corre para visualizar la secuencia de parada.
    if (!running) {
      running = true;
      $("btnPlay").textContent = "⏸ Pausar";
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

// Escenarios
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
      $("btnPlay").textContent = "⏸ Pausar";
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

// Toggle gráficas
$("togglePlots").addEventListener("click", () => {
  const p = $("plots");
  const hidden = p.classList.toggle("collapsed");
  $("togglePlots").textContent = hidden ? "Mostrar gráficas" : "Ocultar gráficas";
  setTimeout(() => { viz.resize(); plots.resize(); }, 220);
});

// Redimensionado
window.addEventListener("resize", () => {
  viz.resize();
  plots.resize();
});

// Inicializa lecturas y arranca el bucle de render
updateReadouts(sim.last);
requestAnimationFrame((ts) => { lastWall = ts; requestAnimationFrame(loop); });
