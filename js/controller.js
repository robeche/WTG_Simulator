// controller.js
// Controlador del aerogenerador: par de generador (regiones 1-2-3) y paso (pitch).

import { TurbineParams as P } from "./turbine.js";

// Coeficiente de par óptimo (región 2): Qgen = Kopt · ω_gen²  (lado rápido, HSS)
// Kopt = 0.5·ρ·π·R⁵·Cp_max / (λ_opt³ · N³)
const Kopt =
  (0.5 * P.airDensity * Math.PI * Math.pow(P.rotorRadius, 5) * P.CpMax) /
  (Math.pow(P.lambdaOpt, 3) * Math.pow(P.gearRatio, 3));

// Par nominal de generador (HSS)
const ratedGenTorque = P.ratedPower / P.generatorEfficiency / P.ratedGenSpeed;

// Par máximo del freno mecánico de disco (lado rápido, HSS)
const brakeTorqueHSS = 28000; // N·m

export class Controller {
  constructor() {
    this.pitch = P.minPitch;      // rad
    this.pitchIntegral = 0;       // término integral del PI
    this.genTorque = 0;           // N·m (HSS)
    this.region = 1;
    this.emergency = false;       // parada de emergencia activa
    this.brakeTorque = 0;         // par de freno mecánico aplicado (HSS)
  }

  // Activa/desactiva la parada de emergencia.
  triggerEmergencyStop() {
    this.emergency = true;
  }

  clearEmergencyStop() {
    this.emergency = false;
    this.brakeTorque = 0;
  }

  reset() {
    this.pitch = P.minPitch;
    this.pitchIntegral = 0;
    this.emergency = false;
    this.brakeTorque = 0;
    this.genTorque = 0;
    this.region = 1;
  }

  // omegaGen: velocidad del generador [rad/s] (HSS)
  // dt: paso temporal [s]
  update(omegaGen, dt) {
    // ---------- Parada de emergencia ----------
    if (this.emergency) {
      // Feathering: lleva las palas a bandera (90°) a la máxima velocidad de pitch.
      const step = P.maxPitchRate * dt;
      this.pitch = Math.min(P.maxPitch, this.pitch + step);

      // Generador desconectado de la red (sin par electromagnético til).
      this.genTorque = 0;

      // Freno mecánico de disco: par de Coulomb opuesto al giro. Se aplica una
      // vez que las palas están suficientemente embanderadas (retardo típico).
      if (this.pitch > 20 * Math.PI / 180 && omegaGen > 0.5) {
        this.brakeTorque = brakeTorqueHSS;
      } else if (omegaGen <= 0.5) {
        this.brakeTorque = brakeTorqueHSS; // freno de aparcamiento al detenerse
      } else {
        this.brakeTorque = 0;
      }
      this.region = 0; // 0 = parada de emergencia
      this.pitchIntegral = this.pitch / Math.max(P.pitchKi, 1e-9); // evita salto al rearmar
      return {
        genTorque: this.genTorque,
        pitch: this.pitch,
        region: this.region,
        brakeTorque: this.brakeTorque,
      };
    }
    this.brakeTorque = 0;

    // ---------- Control de par de generador ----------
    const wMin = P.cutInRotorSpeed * P.gearRatio;
    const wRated = P.ratedGenSpeed;

    let Qopt = Kopt * omegaGen * omegaGen;

    // Limitación a par nominal (transición a región 3)
    let Qgen;
    if (omegaGen <= wMin) {
      Qgen = Qopt;
      this.region = 1;
    } else if (this.pitch > 0.01 || Qopt > ratedGenTorque) {
      // Región 3: potencia constante
      Qgen = ratedGenTorque * wRated / Math.max(omegaGen, 1e-3);
      this.region = 3;
    } else {
      Qgen = Qopt;
      this.region = 2;
    }
    Qgen = Math.min(Qgen, ratedGenTorque * 1.1);
    this.genTorque = Qgen;

    // ---------- Control de paso (pitch) PI con gain scheduling ----------
    const speedError = omegaGen - wRated;

    // Programación de ganancia: la sensibilidad del par al pitch crece con el
    // ángulo; se reduce la ganancia al aumentar el pitch.
    const gs = 1 / (1 + this.pitch / P.pitchKK);
    const Kp = P.pitchKp * gs;
    const Ki = P.pitchKi * gs;

    // Integral con anti-windup
    this.pitchIntegral += speedError * dt;
    // Límite de la integral en términos de contribución de pitch
    const intMin = (P.minPitch) / Math.max(Ki, 1e-9);
    const intMax = (P.maxPitch) / Math.max(Ki, 1e-9);
    this.pitchIntegral = Math.max(intMin, Math.min(intMax, this.pitchIntegral));

    let pitchDemand = Kp * speedError + Ki * this.pitchIntegral;
    pitchDemand = Math.max(P.minPitch, Math.min(P.maxPitch, pitchDemand));

    // Limitación de velocidad de actuación del pitch
    const maxStep = P.maxPitchRate * dt;
    const delta = pitchDemand - this.pitch;
    if (delta > maxStep) this.pitch += maxStep;
    else if (delta < -maxStep) this.pitch -= maxStep;
    else this.pitch = pitchDemand;

    return {
      genTorque: this.genTorque,
      pitch: this.pitch,
      region: this.region,
      brakeTorque: this.brakeTorque,
    };
  }
}

export const ControllerInfo = { Kopt, ratedGenTorque };
