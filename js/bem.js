// bem.js
// Solver de Blade Element Momentum (BEM) en estado estacionario.
// Calcula empuje, par y potencia aerodinámica integrando a lo largo de la pala,
// resolviendo iterativamente los factores de inducción axial (a) y tangencial (a').

import { TurbineParams, bladeGeometryAt } from "./turbine.js";
import { airfoilCoeffsBlend } from "./airfoilData.js";

const NELEM = 24; // número de elementos de pala

// Precalcula los radios de los elementos (uniformes entre buje y punta)
const elements = [];
(function buildElements() {
  const r0 = TurbineParams.hubRadius;
  const R = TurbineParams.rotorRadius;
  const dr = (R - r0) / NELEM;
  for (let i = 0; i < NELEM; i++) {
    const r = r0 + (i + 0.5) * dr;
    const geo = bladeGeometryAt(r);
    elements.push({
      r, dr, chord: geo.chord, twist: geo.twist,
      afLow: geo.afLow, afHigh: geo.afHigh, blend: geo.blend,
    });
  }
})();

// Resuelve el BEM para un elemento.
// V: velocidad axial del viento relativa [m/s]
// omega: velocidad de giro del rotor [rad/s]
// pitch: ángulo de paso de pala [rad]
function solveElement(el, V, omega, pitch) {
  const B = TurbineParams.nBlades;
  const R = TurbineParams.rotorRadius;
  const rho = TurbineParams.airDensity;
  const { r, chord, twist, afLow, afHigh, blend } = el;
  const sigma = (B * chord) / (2 * Math.PI * r); // solidez local

  let a = 0.0;
  let ap = 0.0;
  let phi = 0.0;
  let Cn = 0, Ct = 0, F = 1;

  for (let iter = 0; iter < 100; iter++) {
    const vAxial = V * (1 - a);
    const vTang = omega * r * (1 + ap);
    phi = Math.atan2(vAxial, vTang);

    if (phi < 1e-4) phi = 1e-4;

    const alpha = phi - twist - pitch;
    const { cl, cd } = airfoilCoeffsBlend(afLow, afHigh, blend, alpha);

    const cphi = Math.cos(phi);
    const sphi = Math.sin(phi);
    Cn = cl * cphi + cd * sphi;
    Ct = cl * sphi - cd * cphi;

    // Pérdida de punta y de raíz (Prandtl)
    const fTip = (B / 2) * (R - r) / (r * Math.max(sphi, 1e-3));
    const Ftip = (2 / Math.PI) * Math.acos(Math.min(1, Math.exp(-fTip)));
    const fHub = (B / 2) * (r - TurbineParams.hubRadius) / (TurbineParams.hubRadius * Math.max(sphi, 1e-3));
    const Fhub = (2 / Math.PI) * Math.acos(Math.min(1, Math.exp(-fHub)));
    F = Math.max(Ftip * Fhub, 1e-4);

    // Nuevos factores de inducción
    const denomA = 4 * F * sphi * sphi / (sigma * Cn);
    let aNew;
    const kA = denomA; // = 1/(sigma Cn/(4F sin^2))
    // Relación clásica: a = 1/(k+1)
    aNew = 1 / (kA + 1);

    // Corrección de Glauert para alta carga (a > ~0.4)
    const ac = 0.2;
    if (aNew > ac) {
      const K = 4 * F * sphi * sphi / (sigma * Cn);
      // Resolución cuadrática de Buhl
      aNew = 0.5 * (2 + K * (1 - 2 * ac) -
        Math.sqrt(Math.pow(K * (1 - 2 * ac) + 2, 2) + 4 * (K * ac * ac - 1)));
      if (!isFinite(aNew)) aNew = 0.4;
    }

    const denomAp = 4 * F * sphi * Math.cos(phi) / (sigma * Ct);
    let apNew = 1 / (denomAp - 1);
    if (!isFinite(apNew)) apNew = 0;

    // Relajación
    const relax = 0.5;
    const aRel = a + relax * (aNew - a);
    const apRel = ap + relax * (apNew - ap);

    if (Math.abs(aRel - a) < 1e-6 && Math.abs(apRel - ap) < 1e-6) {
      a = aRel; ap = apRel;
      break;
    }
    a = aRel;
    ap = apRel;
    a = Math.max(-0.5, Math.min(a, 0.95));
    ap = Math.max(-0.9, Math.min(ap, 2.0));
  }

  // Velocidad relativa y cargas por unidad de longitud
  const vAxial = V * (1 - a);
  const vTang = omega * r * (1 + ap);
  const Vrel2 = vAxial * vAxial + vTang * vTang;
  const q = 0.5 * rho * Vrel2 * chord; // presión dinámica * cuerda

  const dFn = q * Cn;          // fuerza normal por unidad de longitud (empuje)
  const dFt = q * Ct;          // fuerza tangencial por unidad de longitud
  const dT = B * dFn * el.dr;  // empuje del anillo
  const dQ = B * dFt * r * el.dr; // par del anillo

  return { dT, dQ, dFn, dFt, a, ap, phi, alpha: phi - el.twist - pitch };
}

// Calcula el estado aerodinámico completo del rotor.
// Devuelve empuje total, par total, potencia, Cp, Ct, lambda y cargas por pala.
export function bemSolve(windSpeed, omega, pitch) {
  const R = TurbineParams.rotorRadius;
  const rho = TurbineParams.airDensity;
  let T = 0, Q = 0;
  let rootFlapMoment = 0; // momento flector en raíz por pala (aleteo)

  const om = Math.max(omega, 0.05);
  const radialLoads = [];

  for (const el of elements) {
    const res = solveElement(el, windSpeed, om, pitch);
    T += res.dT;
    Q += res.dQ;
    // momento flector de aleteo en la raíz, por pala
    rootFlapMoment += res.dFn * el.dr * (el.r - TurbineParams.hubRadius);
    radialLoads.push({ r: el.r, fn: res.dFn, ft: res.dFt, a: res.a, alpha: res.alpha });
  }

  const power = Q * omega;
  const area = Math.PI * R * R;
  const lambda = (omega * R) / Math.max(windSpeed, 0.1);
  const Pavail = 0.5 * rho * area * Math.pow(windSpeed, 3);
  const Tavail = 0.5 * rho * area * windSpeed * windSpeed;
  const Cp = Pavail > 1 ? power / Pavail : 0;
  const Ct = Tavail > 1 ? T / Tavail : 0;

  return {
    thrust: T,
    torque: Q,
    aeroPower: power,
    Cp,
    Ct,
    lambda,
    rootFlapMoment,
    radialLoads,
  };
}
