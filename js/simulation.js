// simulation.js
// Integra en el tiempo el modelo acoplado: aerodinámica (BEM, cuasi-estacionaria),
// tren de potencia (torsión), modos estructurales (torre y palas) y control.

import { TurbineParams as P } from "./turbine.js";
import { bemSolve } from "./bem.js";
import { buildModes, modalAccel, GRAVITY } from "./structural.js";
import { Controller } from "./controller.js";

// --- Modelo de viento ---
export class WindModel {
  constructor() {
    this.mean = 11.4;
    this.shear = 0.14;        // exponente de cizalladura (perfil de capa límite)
    this.turbIntensity = 0.0; // intensidad de turbulencia [0..1]
    this.gustAmp = 0.0;       // amplitud de ráfaga sinusoidal [m/s]
    this.gustPeriod = 12.0;   // s
    this._seed = 12345;
    this._n1 = 0; this._n2 = 0;
  }

  _rand() {
    // Generador pseudoaleatorio determinista
    this._seed = (this._seed * 1103515245 + 12345) & 0x7fffffff;
    return this._seed / 0x7fffffff - 0.5;
  }

  // Velocidad media del viento en el buje en el instante t
  hubWind(t) {
    let v = this.mean;
    if (this.gustAmp > 0) {
      v += this.gustAmp * Math.sin((2 * Math.PI * t) / this.gustPeriod);
    }
    if (this.turbIntensity > 0) {
      // Turbulencia filtrada (primer orden) sobre ruido
      const sigma = this.turbIntensity * this.mean;
      this._n1 += 0.05 * (this._rand() * sigma * 6 - this._n1);
      v += this._n1;
    }
    return Math.max(0.1, v);
  }

  // Factor de cizalladura a una altura z (perfil potencial)
  shearFactor(z) {
    if (z <= 1) return 0.5;
    return Math.pow(z / P.hubHeight, this.shear);
  }
}

export class Simulation {
  constructor() {
    this.modes = buildModes();
    this.controller = new Controller();
    this.wind = new WindModel();
    this.dt = 0.005; // paso de integración [s]
    this.reset();
  }

  reset() {
    const w0 = P.ratedRotorSpeed * 0.6;
    this.t = 0;
    this.s = {
      thetaR: 0, omegaR: w0,
      thetaGL: 0, omegaGL: w0,
      tfaX: 0, tfaV: 0,
      tssX: 0, tssV: 0,
      bfX: [0, 0, 0], bfV: [0, 0, 0],
      beX: [0, 0, 0], beV: [0, 0, 0],
    };
    this.controller.reset();
    this.last = this._emptyOutputs();
  }

  _emptyOutputs() {
    return {
      t: 0, wind: this.wind.mean,
      rotorSpeedRPM: 0, genSpeedRPM: 0,
      aeroPower: 0, elecPower: 0, genTorque: 0, aeroTorque: 0, shaftTorque: 0,
      thrust: 0, pitchDeg: 0, lambda: 0, Cp: 0, Ct: 0, region: 1,
      emergency: false, brakeTorque: 0,
      towerFA: 0, towerSS: 0, bladeTip: 0, bladeEdge: 0,
      radialLoads: [],
    };
  }

  // Derivadas del vector de estado dadas las cargas (aero y control mantenidas
  // constantes durante el sub-paso RK4: hipótesis cuasi-estacionaria).
  _deriv(s, loads) {
    const m = this.modes;
    const Jr = P.rotorInertia;
    const JgL = P.generatorInertia * P.gearRatio * P.gearRatio;

    // Par en el eje (torsión del tren de potencia, referido al LSS)
    const Qshaft =
      P.driveTrainStiffness * (s.thetaR - s.thetaGL) +
      P.driveTrainDamping * (s.omegaR - s.omegaGL);
    const QgenLSS = loads.genTorque * P.gearRatio;

    // Par del freno mecánico (HSS), referido al LSS, opuesto al giro.
    let QbrakeLSS = 0;
    if (loads.brakeTorque > 0) {
      QbrakeLSS = -Math.sign(s.omegaGL) * loads.brakeTorque * P.gearRatio;
    }

    const d = {
      thetaR: s.omegaR,
      omegaR: (loads.aeroTorque - Qshaft) / Jr,
      thetaGL: s.omegaGL,
      omegaGL: (Qshaft - QgenLSS + QbrakeLSS) / JgL,
      tfaX: s.tfaV,
      tfaV: modalAccel(m.towerFA, s.tfaX, s.tfaV, loads.thrust),
      tssX: s.tssV,
      tssV: modalAccel(m.towerSS, s.tssX, s.tssV, loads.sideForce),
      bfX: [0, 0, 0], bfV: [0, 0, 0],
      beX: [0, 0, 0], beV: [0, 0, 0],
    };

    for (let i = 0; i < P.nBlades; i++) {
      d.bfX[i] = s.bfV[i];
      d.bfV[i] = modalAccel(m.bladeFlap, s.bfX[i], s.bfV[i], loads.flap[i]);
      d.beX[i] = s.beV[i];
      d.beV[i] = modalAccel(m.bladeEdge, s.beX[i], s.beV[i], loads.edge[i]);
    }
    return { d, Qshaft };
  }

  // Suma escalada de estados para RK4
  _axpy(s, d, h) {
    return {
      thetaR: s.thetaR + d.thetaR * h,
      omegaR: s.omegaR + d.omegaR * h,
      thetaGL: s.thetaGL + d.thetaGL * h,
      omegaGL: s.omegaGL + d.omegaGL * h,
      tfaX: s.tfaX + d.tfaX * h, tfaV: s.tfaV + d.tfaV * h,
      tssX: s.tssX + d.tssX * h, tssV: s.tssV + d.tssV * h,
      bfX: s.bfX.map((v, i) => v + d.bfX[i] * h),
      bfV: s.bfV.map((v, i) => v + d.bfV[i] * h),
      beX: s.beX.map((v, i) => v + d.beX[i] * h),
      beV: s.beV.map((v, i) => v + d.beV[i] * h),
    };
  }

  // Avanza un paso de integración dt
  step() {
    const dt = this.dt;
    const s = this.s;

    // Velocidad del generador (HSS) para el control
    const omegaGen = s.omegaGL * P.gearRatio;
    const ctrl = this.controller.update(omegaGen, dt);

    // Viento efectivo: media del buje menos velocidad fore-aft de la góndola
    const windHub = this.wind.hubWind(this.t);
    const Veff = Math.max(0.1, windHub - s.tfaV);

    // --- Aerodinámica BEM (cuasi-estacionaria) ---
    const bem = bemSolve(Veff, s.omegaR, ctrl.pitch);

    // Reparto de cargas por pala con cizalladura del viento y gravedad
    const Reff = 0.7 * P.rotorRadius;
    const FtBlade = bem.torque / (P.nBlades * Reff); // fuerza tangencial media
    const flap = [];
    const edge = [];
    let sideForce = 0;
    for (let i = 0; i < P.nBlades; i++) {
      const psi = s.thetaR + (i * 2 * Math.PI) / P.nBlades;
      const z = P.hubHeight + Reff * Math.cos(psi);
      const shear = this.wind.shearFactor(z);
      // Aleteo: empuje por pala modulado por cizalladura
      flap.push((bem.thrust / P.nBlades) * shear * shear);
      // Arrastre (edge): tangencial aerodinámico + peso de la pala (1P)
      const grav = P.bladeMass * GRAVITY * Math.sin(psi);
      edge.push(FtBlade * shear - grav);
      // Carga lateral en el buje (componente horizontal de cargas en plano)
      sideForce += FtBlade * shear * Math.cos(psi);
    }

    const loads = {
      aeroTorque: bem.torque,
      thrust: bem.thrust,
      sideForce,
      genTorque: ctrl.genTorque,
      brakeTorque: ctrl.brakeTorque,
      flap, edge,
    };

    // --- Integración RK4 ---
    const k1 = this._deriv(s, loads);
    const k2 = this._deriv(this._axpy(s, k1.d, dt / 2), loads);
    const k3 = this._deriv(this._axpy(s, k2.d, dt / 2), loads);
    const k4 = this._deriv(this._axpy(s, k3.d, dt), loads);

    const comb = (a, b, c, e) => (a + 2 * b + 2 * c + e) / 6;
    const upd = (key) => {
      s[key] += dt * comb(k1.d[key], k2.d[key], k3.d[key], k4.d[key]);
    };
    ["thetaR", "omegaR", "thetaGL", "omegaGL", "tfaX", "tfaV", "tssX", "tssV"].forEach(upd);
    for (let i = 0; i < P.nBlades; i++) {
      s.bfX[i] += dt * comb(k1.d.bfX[i], k2.d.bfX[i], k3.d.bfX[i], k4.d.bfX[i]);
      s.bfV[i] += dt * comb(k1.d.bfV[i], k2.d.bfV[i], k3.d.bfV[i], k4.d.bfV[i]);
      s.beX[i] += dt * comb(k1.d.beX[i], k2.d.beX[i], k3.d.beX[i], k4.d.beX[i]);
      s.beV[i] += dt * comb(k1.d.beV[i], k2.d.beV[i], k3.d.beV[i], k4.d.beV[i]);
    }

    // Evita velocidades negativas de rotor (parada)
    if (s.omegaR < 0) { s.omegaR = 0; }
    if (s.omegaGL < 0) { s.omegaGL = 0; }

    // Freno mecánico: al caer por debajo de un umbral, retiene el rotor (evita
    // el chattering numérico del par de Coulomb en torno a velocidad nula).
    if (ctrl.brakeTorque > 0 && s.omegaGL < 0.3 && bem.torque * P.gearRatio < ctrl.brakeTorque) {
      s.omegaGL = 0; s.omegaR = 0;
    }

    this.t += dt;

    // --- Salidas ---
    const omegaGenOut = s.omegaGL * P.gearRatio;
    const mechPower = ctrl.genTorque * omegaGenOut;
    const elecPower = mechPower > 0 ? mechPower * P.generatorEfficiency : 0;
    const lambda = (s.omegaR * P.rotorRadius) / Veff;

    this.last = {
      t: this.t,
      wind: windHub,
      rotorSpeedRPM: (s.omegaR * 60) / (2 * Math.PI),
      genSpeedRPM: (omegaGenOut * 60) / (2 * Math.PI),
      aeroPower: bem.aeroPower,
      elecPower,
      genTorque: ctrl.genTorque,
      aeroTorque: bem.torque,
      shaftTorque: k4.Qshaft,
      thrust: bem.thrust,
      pitchDeg: (ctrl.pitch * 180) / Math.PI,
      lambda,
      Cp: bem.Cp,
      Ct: bem.Ct,
      region: ctrl.region,
      emergency: this.controller.emergency,
      brakeTorque: ctrl.brakeTorque,
      towerFA: s.tfaX,
      towerSS: s.tssX,
      bladeTip: s.bfX[0],
      bladeEdge: s.beX[0],
      radialLoads: bem.radialLoads,
    };
    return this.last;
  }

  // Activa la parada de emergencia (feathering + freno mecánico).
  emergencyStop() {
    this.controller.triggerEmergencyStop();
  }

  // Rearma el aerogenerador tras una parada de emergencia.
  clearEmergency() {
    this.controller.clearEmergencyStop();
  }

  get isEmergency() {
    return this.controller.emergency;
  }

  // Estado para visualización
  getVizState() {
    return {
      azimuth: this.s.thetaR,
      pitch: (this.controller.pitch),
      towerFA: this.s.tfaX,
      towerSS: this.s.tssX,
      bladeFlap: this.s.bfX.slice(),
      bladeEdge: this.s.beX.slice(),
    };
  }
}
