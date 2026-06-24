// betz.js — Sub-aplicación interactiva: inducción axial y obtención del límite de Betz.
// Modelo de disco actuador (cantidad de movimiento 1D):
//   V      = V∞ (1 - a)        velocidad en el disco
//   V_w    = V∞ (1 - 2a)       velocidad en la estela lejana
//   C_P    = 4 a (1 - a)^2     coeficiente de potencia
//   C_T    = 4 a (1 - a)       coeficiente de empuje
//   dC_P/da = 4(1-a)(1-3a) = 0 → a = 1/3 → C_P,max = 16/27 ≈ 0.593 (límite de Betz)

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createTurbineModel } from "./visualization.js";

const V_INF = 10.0;          // velocidad de corriente libre de referencia [m/s]
const R_DISC = 6.0;          // radio del disco en unidades de escena
const X_UP = 32;             // extensión aguas arriba
const X_DOWN = 46;           // extensión aguas abajo (mayor: la estela se expande)
const L_TRANS = 7.0;         // longitud de transición de la inducción
const NX = 90;               // resoluciones de la malla del tubo
const NTHETA = 56;
const N_PARTICLES = 1400;

const A_BETZ = 1 / 3;
const CP_BETZ = 16 / 27;

// Tiempo de vida de las partículas (s): tras agotarse se desvanecen y vuelven
// a aparecer aguas arriba. Permite que siga entrando flujo nuevo aunque la
// estela se "congele" (a→0.5).
const P_LIFE_MIN = 14.0;
const P_LIFE_MAX = 24.0;
const P_FADE = 1.2;          // duración del fundido de entrada/salida (s)
const BG_COLOR = new THREE.Color(0x0e1c2c); // color de fondo para el fundido
// Perfil de velocidad normalizado u(x) = v(x)/V∞ a lo largo del eje.
// u(-∞)=1, u(0)=1-a, u(+∞)=1-2a.
function uProfile(x, a) {
  return 1 - a * (1 + Math.tanh(x / L_TRANS));
}

// Radio del tubo de corriente: r(x)/R = sqrt((1-a)/u(x))  (conservación de masa).
function tubeRadius(x, a) {
  const u = Math.max(uProfile(x, a), 0.04); // evita divergencia cuando a→0.5
  const ratio = Math.sqrt(Math.max(1 - a, 1e-4) / u);
  return R_DISC * Math.min(ratio, 3.2); // recorta la expansión extrema
}

export class BetzApp {
  constructor(container) {
    this.container = container;
    this.a = A_BETZ;
    this.active = false;
    this._clock = new THREE.Clock();

    this._initScene();
    this._buildTube();
    this._buildDisc();
    this._buildTurbine();
    this._buildParticles();
    this._initUI();
    this._initPlot();
    this._renderEquations();

    // Info cards are anchored under their matching velocity label.
    this.cards = {
      up: document.getElementById("zone_up"),
      rotor: document.getElementById("zone_rotor"),
      down: document.getElementById("zone_down"),
    };
    this._cardProj = new THREE.Vector3();

    this.setInduction(this.a);

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _initScene() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1c2c);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    this.camera.position.set(-38, 26, 52);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(4, 0, 0);
    this.controls.enableDamping = true;
    this.controls.update();

    // Normalize wheel events to fix GitHub Pages zoom jumping issue
    this.renderer.domElement.addEventListener("wheel", (e) => {
      if (e.ctrlKey) {
        // Let browser handle zoom
        e.stopPropagation();
        return;
      }
      // Clamp deltaY to reasonable values to prevent extreme zoom jumps
      const maxDelta = 50;
      if (Math.abs(e.deltaY) > maxDelta) {
        e.stopPropagation();
        e.preventDefault();
        const normalized = new WheelEvent("wheel", {
          deltaY: Math.sign(e.deltaY) * maxDelta,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
          cancelable: true,
        });
        e.target.dispatchEvent(normalized);
      }
    }, { passive: false, capture: true });

    this.scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x1a2535, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(-20, 40, 30);
    this.scene.add(dir);

    // Eje del flujo y rótulos de dirección del viento
    const axisMat = new THREE.LineBasicMaterial({ color: 0x3a5068 });
    const axisGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-X_UP, 0, 0),
      new THREE.Vector3(X_DOWN, 0, 0),
    ]);
    this.scene.add(new THREE.Line(axisGeo, axisMat));

    // Flecha que indica la dirección del viento (entra por aguas arriba)
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-X_UP, R_DISC + 6, 0),
      14, 0x56d4dd, 4, 2.4
    );
    this.scene.add(arrow);

    // Etiquetas de velocidad flotantes en la ventana 3D
    this.labels = {
      vinf: this._makeLabel("V∞", 0x9fe7ec),
      vdisc: this._makeLabel("V0", 0xf0c040),
      vwake: this._makeLabel("Vw", 0xf0883e),
    };
    this.labels.vinf.position.set(-X_UP + 4, R_DISC + 2.5, 0);
    this.labels.vdisc.position.set(0, R_DISC + 5.5, 0);
    this.labels.vwake.position.set(X_DOWN - 6, 0, 0); // recolocada en _updateLabels
    this.scene.add(this.labels.vinf, this.labels.vdisc, this.labels.vwake);
  }

  // Crea una etiqueta de texto como sprite con textura de canvas.
  _makeLabel(text, color = 0xffffff) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        depthTest: false,
        transparent: true,
      })
    );
    sprite.scale.set(18, 4.5, 1); // relación 4:1 acorde al canvas
    sprite.userData = { canvas, color };
    this._drawLabel(sprite, text);
    return sprite;
  }

  // Dibuja/actualiza el texto de una etiqueta sprite.
  _drawLabel(sprite, text) {
    const { canvas, color } = sprite.userData;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const hex = "#" + color.toString(16).padStart(6, "0");
    // Fondo redondeado semitransparente
    ctx.fillStyle = "rgba(10, 22, 36, 0.78)";
    const r = 18;
    ctx.beginPath();
    ctx.moveTo(r, 4);
    ctx.arcTo(W - 4, 4, W - 4, H - 4, r);
    ctx.arcTo(W - 4, H - 4, 4, H - 4, r);
    ctx.arcTo(4, H - 4, 4, 4, r);
    ctx.arcTo(4, 4, W - 4, 4, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = hex;
    ctx.lineWidth = 3;
    ctx.stroke();
    // Texto, ajustando la fuente para que quepa
    ctx.fillStyle = hex;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let fontSize = 56;
    do {
      ctx.font = `bold ${fontSize}px 'Segoe UI', system-ui, sans-serif`;
      if (ctx.measureText(text).width <= W - 32) break;
      fontSize -= 2;
    } while (fontSize > 20);
    ctx.fillText(text, W / 2, H / 2);
    sprite.material.map.needsUpdate = true;
  }

  // Actualiza el texto y la posición de las etiquetas según la inducción.
  _updateLabels() {
    if (!this.labels) return;
    const a = this.a;
    const V = V_INF * (1 - a);
    const Vw = V_INF * (1 - 2 * a);
    this._drawLabel(this.labels.vinf, `V∞ = ${V_INF.toFixed(1)} m/s`);
    this._drawLabel(this.labels.vdisc, `V0 = ${V.toFixed(1)} m/s`);
    this._drawLabel(this.labels.vwake, `Vw = ${Vw.toFixed(1)} m/s`);
    // La etiqueta de estela sigue el borde del tubo expandido
    const rWake = tubeRadius(X_DOWN - 8, a);
    this.labels.vwake.position.set(X_DOWN - 8, rWake + 2.5, 0);
  }

  _buildTube() {
    // Malla parametrizada (NX a lo largo del eje × NTHETA alrededor).
    const verts = (NX + 1) * (NTHETA + 1);
    this.tubePos = new Float32Array(verts * 3);
    const idx = [];
    for (let i = 0; i < NX; i++) {
      for (let j = 0; j < NTHETA; j++) {
        const a0 = i * (NTHETA + 1) + j;
        const a1 = a0 + 1;
        const b0 = a0 + (NTHETA + 1);
        const b1 = b0 + 1;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.tubePos, 3));
    geo.setIndex(idx);
    this.tubeGeo = geo;

    const surfMat = new THREE.MeshStandardMaterial({
      color: 0x56d4dd, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, roughness: 0.6, depthWrite: false,
    });
    this.tubeMesh = new THREE.Mesh(geo, surfMat);
    this.scene.add(this.tubeMesh);

    // Malla de alambre superpuesta para leer mejor la forma
    const wire = new THREE.WireframeGeometry(geo);
    this.tubeWire = new THREE.LineSegments(
      wire,
      new THREE.LineBasicMaterial({ color: 0x56d4dd, transparent: true, opacity: 0.22 })
    );
    this.scene.add(this.tubeWire);
  }

  _updateTube() {
    const a = this.a;
    let k = 0;
    for (let i = 0; i <= NX; i++) {
      const x = -X_UP + (i / NX) * (X_UP + X_DOWN);
      const r = tubeRadius(x, a);
      for (let j = 0; j <= NTHETA; j++) {
        const th = (j / NTHETA) * Math.PI * 2;
        this.tubePos[k++] = x;
        this.tubePos[k++] = r * Math.cos(th);
        this.tubePos[k++] = r * Math.sin(th);
      }
    }
    this.tubeGeo.attributes.position.needsUpdate = true;
    this.tubeGeo.computeVertexNormals();

    // Reconstruye la malla de alambre
    this.tubeWire.geometry.dispose();
    this.tubeWire.geometry = new THREE.WireframeGeometry(this.tubeGeo);
  }

  _buildDisc() {
    // Disco actuador (rotor permeable) en x = 0
    const discGeo = new THREE.CylinderGeometry(R_DISC, R_DISC, 0.4, 48, 1, true);
    discGeo.rotateZ(Math.PI / 2); // eje del cilindro → X
    this.disc = new THREE.Mesh(
      discGeo,
      new THREE.MeshStandardMaterial({
        color: 0xf0883e, transparent: true, opacity: 0.35,
        side: THREE.DoubleSide, emissive: 0x4a2a10,
      })
    );
    this.scene.add(this.disc);

    // Anillo del borde del disco
    this.discRing = new THREE.Mesh(
      new THREE.TorusGeometry(R_DISC, 0.18, 12, 64),
      new THREE.MeshStandardMaterial({ color: 0xf0883e, emissive: 0x3a1f08 })
    );
    this.scene.add(this.discRing); // en plano YZ por defecto (eje del toro = Z)
    this.discRing.rotation.y = Math.PI / 2;
  }

  _buildTurbine() {
    // Reutiliza el modelo del simulador, escalado para que el rotor encaje en
    // el disco actuador (radio R_DISC) y orientado para mirar al viento (-X).
    const model = createTurbineModel({ pitch: 0 });
    this.rotor = model.rotorSpin;

    const holder = new THREE.Group();          // aplica escala y posición global
    const s = R_DISC / model.rotorRadius;       // 63 m → R_DISC unidades de escena
    holder.scale.setScalar(s);

    // Orienta el aerogenerador para que el rotor mire aguas arriba (-X)
    model.root.rotation.y = Math.PI;

    // Centra el buje en el origen de la escena (plano del disco, x = 0)
    const hub = model.hubPos; // posición del buje en coords. del modelo
    model.root.position.set(hub.x, -hub.y, 0);

    holder.add(model.root);
    this.turbine = holder;
    this.scene.add(holder);
  }

  _buildParticles() {
    this.pPos = new Float32Array(N_PARTICLES * 3);
    this.pCol = new Float32Array(N_PARTICLES * 3);
    this.pData = []; // {frac, theta, x, age, life}
    for (let i = 0; i < N_PARTICLES; i++) {
      const frac = Math.sqrt(Math.random()); // distribución uniforme en área
      const theta = Math.random() * Math.PI * 2;
      const x = -X_UP + Math.random() * (X_UP + X_DOWN);
      const life = P_LIFE_MIN + Math.random() * (P_LIFE_MAX - P_LIFE_MIN);
      this.pData.push({ frac, theta, x, age: Math.random() * life, life });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.pCol, 3));
    this.pGeo = geo;
    this.particles = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.7, vertexColors: true, transparent: true, opacity: 0.95 })
    );
    this.scene.add(this.particles);
  }

  // Reinicia una partícula aguas arriba con un nuevo tiempo de vida.
  _respawnParticle(p) {
    p.x = -X_UP;
    p.frac = Math.sqrt(Math.random());
    p.theta = Math.random() * Math.PI * 2;
    p.age = 0;
    p.life = P_LIFE_MIN + Math.random() * (P_LIFE_MAX - P_LIFE_MIN);
  }

  _updateParticles(dt) {
    const a = this.a;
    const speedScale = 1.6;
    const fast = new THREE.Color(0x56d4dd); // rápido (corriente libre)
    const slow = new THREE.Color(0xf0553e); // lento (estela)
    const c = new THREE.Color();
    for (let i = 0; i < N_PARTICLES; i++) {
      const p = this.pData[i];
      const u = uProfile(p.x, a);
      // Avance a la velocidad real V∞·u (se detiene de verdad en la estela
      // cuando a→0.5). El reciclado lo gobierna el tiempo de vida, no la posición.
      p.x += V_INF * u * dt * speedScale;
      p.age += dt;

      // Reaparece si sale por aguas abajo o agota su tiempo de vida.
      if (p.x > X_DOWN || p.age >= p.life) {
        this._respawnParticle(p);
      }

      const r = tubeRadius(p.x, a) * p.frac;
      this.pPos[i * 3] = p.x;
      this.pPos[i * 3 + 1] = r * Math.cos(p.theta);
      this.pPos[i * 3 + 2] = r * Math.sin(p.theta);

      // color por velocidad local (u entre 1-2a y 1)
      const t = Math.max(0, Math.min(1, (u - (1 - 2 * a)) / Math.max(2 * a, 1e-3)));
      c.copy(slow).lerp(fast, t);

      // Fundido de entrada/salida según el tiempo de vida (mezcla hacia el fondo)
      const fadeIn = Math.min(1, p.age / P_FADE);
      const fadeOut = Math.min(1, (p.life - p.age) / P_FADE);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
      c.lerp(BG_COLOR, 1 - alpha);

      this.pCol[i * 3] = c.r;
      this.pCol[i * 3 + 1] = c.g;
      this.pCol[i * 3 + 2] = c.b;
    }
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.color.needsUpdate = true;
  }

  // ---------------- Física (coeficientes) ----------------
  static cp(a) { return 4 * a * (1 - a) * (1 - a); }
  static ct(a) { return 4 * a * (1 - a); }

  setInduction(a) {
    this.a = Math.max(0, Math.min(0.5, a));
    this._updateTube();
    this._updateReadouts();
    this._updateLabels();
    this._updateZones();
    this._renderEquations();
    this._drawPlot();
  }

  // Per-zone explanatory messages (upstream, rotor, wake) as a function of a.
  _updateZones() {
    const a = this.a;
    const V = V_INF * (1 - a);
    const Vw = V_INF * (1 - 2 * a);
    const Cp = BetzApp.cp(a);
    const expand = Math.sqrt(Math.max(1 - a, 1e-4) / Math.max(1 - 2 * a, 1e-4));
    const set = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };

    let up, rotor, down;

    if (a < 0.02) {
      // Rotor almost transparent
      up =
        `The rotor barely disturbs the air: the stream tube arrives <strong>straight</strong>, ` +
        `with no appreciable contraction. The pressure is atmospheric.`;
      rotor =
        `With <strong>a ≈ 0</strong> the disc is almost transparent: it does not slow the flow ` +
        `(V₀ ≈ V∞ = ${V.toFixed(1)} m/s) and there is no pressure jump, so ` +
        `<strong>no power is extracted</strong> (C<sub>P</sub> ≈ 0).`;
      down =
        `The wake is indistinguishable from the free stream ` +
        `(V<sub>w</sub> ≈ ${Vw.toFixed(1)} m/s): no kinetic energy has been given to the rotor.`;
    } else if (a < A_BETZ - 0.02) {
      // Light (sub-optimal) loading
      up =
        `Upstream the air begins to <strong>slow down before reaching the rotor</strong>: ` +
        `part of the energy turns into overpressure. By continuity the tube ` +
        `<strong>contracts</strong> (the same mass passes more slowly).`;
      rotor =
        `The disc slows the air to <strong>V₀ = V∞(1−a) = ${V.toFixed(1)} m/s</strong> and ` +
        `creates a <strong>pressure jump</strong>. Power is extracted, but being ` +
        `below a = 1/3 there is still margin: <strong>C<sub>P</sub> = ${Cp.toFixed(3)}</strong>.`;
      down =
        `The wake leaves at <strong>V<sub>w</sub> = V∞(1−2a) = ${Vw.toFixed(1)} m/s</strong> and ` +
        `<strong>expands ×${expand.toFixed(2)}</strong> in radius to conserve the mass flow.`;
    } else if (a <= A_BETZ + 0.02) {
      // Betz optimum
      up =
        `The upstream slowdown is <strong>just right</strong>: neither so little that the ` +
        `wind is wasted, nor so much that the airflow is blocked. The tube ` +
        `contracts optimally.`;
      rotor =
        `<strong>Optimum point a = 1/3</strong>: V₀ = ${V.toFixed(1)} m/s. The balance between ` +
        `<em>slowing more</em> (higher Δp) and <em>letting flow through</em> maximizes the power ` +
        `→ <strong>C<sub>P</sub> = 16/27 ≈ 0.593</strong> (Betz limit).`;
      down =
        `The wake travels at <strong>V<sub>w</sub> = ${Vw.toFixed(1)} m/s</strong> (≈ V∞/3) and ` +
        `expands ×${expand.toFixed(2)}. The <strong>maximum possible fraction</strong> of ` +
        `kinetic energy has been extracted (59.3 %).`;
    } else if (a < 0.48) {
      // Overloading
      up =
        `The rotor slows the air <strong>too much</strong>: a large part of the flow ` +
        `<strong>bypasses the disc</strong> instead of going through it. The tube contracts ` +
        `strongly upstream (large overpressure).`;
      rotor =
        `V₀ = ${V.toFixed(1)} m/s. Although the pressure jump is large, <strong>little ` +
        `flow</strong> passes through, so the power <strong>drops again</strong>: ` +
        `<strong>C<sub>P</sub> = ${Cp.toFixed(3)}</strong> &lt; 0.593. The optimum has been exceeded.`;
      down =
        `The wake becomes very slow (<strong>V<sub>w</sub> = ${Vw.toFixed(1)} m/s</strong>) and very ` +
        `<strong>expanded ×${expand.toFixed(2)}</strong>; the 1D theory loses validity as it ` +
        `approaches the turbulent-wake state.`;
    } else {
      // a → 1/2
      up =
        `The disc acts almost like a <strong>solid wall</strong>: the air piles up and ` +
        `almost all of it is deflected around. The stream tube going through it is very narrow.`;
      rotor =
        `<strong>a → 1/2</strong>: V₀ = ${V.toFixed(1)} m/s. So little flow passes that, despite the ` +
        `maximum pressure jump, <strong>C<sub>P</sub> = ${Cp.toFixed(3)}</strong> is low. ` +
        `The 1D momentum model is no longer reliable.`;
      down =
        `The wake <strong>stops</strong> (V<sub>w</sub> = ${Vw.toFixed(1)} m/s) and would ` +
        `expand infinitely: physically, recirculation appears (turbulent-wake ` +
        `state), not covered by the ideal theory.`;
    }

    set("zone_up_text", up);
    set("zone_rotor_text", rotor);
    set("zone_down_text", down);
  }

  _updateReadouts() {
    const a = this.a;
    const V = V_INF * (1 - a);
    const Vw = V_INF * (1 - 2 * a);
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set("b_a", a.toFixed(3));
    set("b_v1", V_INF.toFixed(1));
    set("b_vd", V.toFixed(1));
    set("b_vw", Vw.toFixed(1));
    set("b_cp", BetzApp.cp(a).toFixed(3));
    set("b_ct", BetzApp.ct(a).toFixed(3));
    if (this.slider) this.slider.value = a;
    set("b_a_slider_val", a.toFixed(3));

    const status = document.getElementById("b_status");
    if (status) {
      const dcp = 4 * (1 - a) * (1 - 3 * a);
      if (Math.abs(a - A_BETZ) < 0.005) {
        status.textContent = "★ Betz optimum: dC_P/da = 0 → C_P = 16/27 ≈ 0.593";
        status.style.color = "var(--accent2)";
      } else {
        status.textContent =
          `dC_P/da = ${dcp.toFixed(3)} ${dcp > 0 ? "> 0 (increases if you raise a)" : "< 0 (decreases if you raise a)"}`;
        status.style.color = "var(--muted)";
      }
    }
  }

  // ---------------- Ecuaciones (KaTeX) ----------------
  _renderEquations() {
    if (typeof katex === "undefined") return;
    const a = this.a;
    const V = (V_INF * (1 - a)).toFixed(2);
    const Vw = (V_INF * (1 - 2 * a)).toFixed(2);
    const cp = BetzApp.cp(a).toFixed(3);
    const ct = BetzApp.ct(a).toFixed(3);
    const a1 = (1 - a).toFixed(3);
    const a3 = a < 0.4999 ? ((1 - a) / (1 - 2 * a)).toFixed(3) : "\\infty";

    const tex = (id, latex) => {
      const el = document.getElementById(id);
      if (el) katex.render(latex, el, { throwOnError: false, displayMode: true });
    };

    tex("eq_mass",
      `\\dot{m} = \\rho A_1 V_\\infty = \\rho A V = \\rho A_3 V_w \\\\[4pt]
       \\frac{A_1}{A} = 1-a = ${a1}, \\quad \\frac{A_3}{A} = \\frac{1-a}{1-2a} = ${a3}`);

    tex("eq_vel",
      `V = V_\\infty(1-a) = ${V}\\,\\tfrac{m}{s}, \\quad
       V_w = V_\\infty(1-2a) = ${Vw}\\,\\tfrac{m}{s}`);

    tex("eq_thrust",
      `T = \\dot{m}\\,(V_\\infty - V_w) = 2\\rho A V_\\infty^2\\, a(1-a)`);

    tex("eq_power",
      `P = T\\,V = 2\\rho A V_\\infty^3\\, a(1-a)^2`);

    tex("eq_coeffs",
      `C_P = \\dfrac{P}{\\tfrac12 \\rho A V_\\infty^3} = 4a(1-a)^2 = \\mathbf{${cp}} \\\\[6pt]
       C_T = \\dfrac{T}{\\tfrac12 \\rho A V_\\infty^2} = 4a(1-a) = \\mathbf{${ct}}`);

    tex("eq_opt",
      `\\frac{dC_P}{da} = 4(1-a)(1-3a) = 0 \\;\\Rightarrow\\; a = \\tfrac{1}{3}`);

    tex("eq_betz",
      `C_{P,\\max} = 4\\cdot\\tfrac13\\left(\\tfrac23\\right)^2 = \\frac{16}{27} \\approx 0.593`);
  }

  // ---------------- Gráfica Cp/Ct vs a ----------------
  _initPlot() {
    this.plotCanvas = document.getElementById("betzPlot");
    this.pctx = this.plotCanvas.getContext("2d");
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._resizePlot();
  }

  _resizePlot() {
    const c = this.plotCanvas;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(rect.width * this._dpr));
    c.height = Math.max(1, Math.floor(rect.height * this._dpr));
    this._drawPlot();
  }

  _drawPlot() {
    if (!this.pctx) return;
    const ctx = this.pctx;
    const dpr = this._dpr;
    const W = this.plotCanvas.width, H = this.plotCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#11151c";
    ctx.fillRect(0, 0, W, H);

    const padL = 40 * dpr, padR = 12 * dpr, padT = 14 * dpr, padB = 28 * dpr;
    const pw = W - padL - padR, ph = H - padT - padB;
    const xOf = (a) => padL + (a / 0.5) * pw;
    const yOf = (v) => padT + (1 - v / 1.0) * ph;

    // Rejilla
    ctx.strokeStyle = "#27303d"; ctx.fillStyle = "#7b8794";
    ctx.lineWidth = 1 * dpr; ctx.font = `${10 * dpr}px system-ui`;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 5; i++) {
      const v = i / 5; const y = yOf(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(v.toFixed(1), padL - 5 * dpr, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i <= 5; i++) {
      const a = (i / 5) * 0.5; const x = xOf(a);
      ctx.fillText(a.toFixed(2), x, H - padB + 5 * dpr);
    }
    ctx.fillText("a (axial induction)", padL + pw / 2, H - 12 * dpr);

    // Marca del óptimo de Betz
    ctx.strokeStyle = "#3fb95066"; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(xOf(A_BETZ), padT); ctx.lineTo(xOf(A_BETZ), H - padB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, yOf(CP_BETZ)); ctx.lineTo(W - padR, yOf(CP_BETZ)); ctx.stroke();
    ctx.setLineDash([]);

    // Curvas Cp y Ct
    const drawCurve = (fn, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2 * dpr; ctx.beginPath();
      for (let i = 0; i <= 100; i++) {
        const a = (i / 100) * 0.5;
        const x = xOf(a), y = yOf(fn(a));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawCurve(BetzApp.ct, "#f0883e"); // Ct
    drawCurve(BetzApp.cp, "#3fb950"); // Cp

    // Punto actual sobre Cp
    const a = this.a;
    ctx.strokeStyle = "#a371f7"; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(xOf(a), padT); ctx.lineTo(xOf(a), H - padB); ctx.stroke();
    ctx.setLineDash([]);
    const dot = (v, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      ctx.arc(xOf(a), yOf(v), 4 * dpr, 0, Math.PI * 2); ctx.fill();
    };
    dot(BetzApp.cp(a), "#3fb950");
    dot(BetzApp.ct(a), "#f0883e");

    // Leyenda
    ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = `${10 * dpr}px system-ui`;
    ctx.fillStyle = "#3fb950"; ctx.fillText("■ C_P", padL + 6 * dpr, padT + 8 * dpr);
    ctx.fillStyle = "#f0883e"; ctx.fillText("■ C_T", padL + 46 * dpr, padT + 8 * dpr);
  }

  // ---------------- UI ----------------
  _initUI() {
    this.slider = document.getElementById("b_a_slider");
    this.slider.addEventListener("input", () => {
      this._stopAnim();
      this.setInduction(parseFloat(this.slider.value));
    });
    document.getElementById("b_optimize").addEventListener("click", () => {
      this._animateTo(A_BETZ);
    });
    document.getElementById("b_reset").addEventListener("click", () => {
      this._animateTo(0);
    });
  }

  _animateTo(target) {
    this._stopAnim();
    this._anim = { from: this.a, to: target, t: 0, dur: 0.9 };
  }
  _stopAnim() { this._anim = null; }

  // ---------------- Bucle ----------------
  _loop() {
    requestAnimationFrame(this._loop);
    const dt = Math.min(this._clock.getDelta(), 0.05);
    if (!this.active) return;

    // Animación de transición de a
    if (this._anim) {
      this._anim.t += dt / this._anim.dur;
      const s = Math.min(1, this._anim.t);
      const e = s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2; // easeInOut
      this.setInduction(this._anim.from + (this._anim.to - this._anim.from) * e);
      if (s >= 1) this._stopAnim();
    }

    this._updateParticles(dt);
    if (this.rotor) this.rotor.rotation.x -= dt * 0.9 * (1 - this.a); // horario visto desde aguas arriba; frena al aumentar la inducción
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._positionCards();
  }

  // Anchor each HTML info card just above its matching 3D velocity label,
  // so the card stays connected to the velocity it explains as the view orbits.
  _positionCards() {
    if (!this.cards || !this.labels) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const pairs = [
      [this.labels.vinf, this.cards.up],
      [this.labels.vdisc, this.cards.rotor],
      [this.labels.vwake, this.cards.down],
    ];
    const v = this._cardProj;
    const vTop = this._cardProj2 || (this._cardProj2 = new THREE.Vector3());
    const up = this._cardUp || (this._cardUp = new THREE.Vector3());
    for (const [label, card] of pairs) {
      if (!label || !card) continue;
      v.copy(label.position).project(this.camera);
      const behind = v.z > 1; // label is behind the camera
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      // Measure the label's on-screen half-height by projecting its top edge,
      // so the card can sit fully above the velocity box (not overlapping it).
      up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const halfWorld = (label.scale.y || 4.5) / 2;
      vTop.copy(label.position).addScaledVector(up, halfWorld).project(this.camera);
      const sTopY = (-vTop.y * 0.5 + 0.5) * h;
      const labelHalfH = Math.abs(sy - sTopY);
      const cw = card.offsetWidth || 215;
      const ch = card.offsetHeight || 80;
      let left = sx - cw / 2;
      let top = sy - labelHalfH - ch - 14; // clear of the velocity box top edge
      left = Math.max(8, Math.min(w - cw - 8, left));
      top = Math.max(8, Math.min(h - ch - 8, top));
      card.style.left = left + "px";
      card.style.top = top + "px";
      card.style.right = "auto";
      card.style.transform = "none";
      card.style.opacity = behind ? "0" : "1";
    }
  }

  setActive(b) {
    this.active = b;
    if (b) { this._clock.getDelta(); this.resize(); }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this._resizePlot();
  }
}
