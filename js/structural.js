// structural.js
// Representación modal de la elasticidad estructural.
// Cada modo se modela como un oscilador de 2º orden amortiguado:
//   m·ẍ + c·ẋ + k·x = F   ->   ẍ = F/m - 2ζωₙ·ẋ - ωₙ²·x
// Se incluyen: torre (fore-aft y side-side), aleteo y arrastre de cada pala.

import { TurbineParams as P } from "./turbine.js";

export const GRAVITY = 9.81;

// Construye un descriptor de modo a partir de frecuencia [Hz], amortiguamiento
// relativo y masa modal.
function makeMode(def) {
  const wn = 2 * Math.PI * def.freq;
  return {
    wn,
    zeta: def.damping,
    modalMass: def.modalMass,
    stiffness: def.modalMass * wn * wn, // k = m·ωₙ²
  };
}

export function buildModes() {
  return {
    towerFA: makeMode(P.towerFA),
    towerSS: makeMode(P.towerSS),
    bladeFlap: makeMode(P.bladeFlap),
    bladeEdge: makeMode(P.bladeEdge),
  };
}

// Aceleración de un modo dado el desplazamiento x, velocidad v y fuerza
// generalizada F.
export function modalAccel(mode, x, v, F) {
  return F / mode.modalMass - 2 * mode.zeta * mode.wn * v - mode.wn * mode.wn * x;
}
