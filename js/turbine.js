// turbine.js
// Definición del aerogenerador de referencia (basado en el NREL 5 MW).
// Todas las unidades en SI salvo indicación contraria.

export const TurbineParams = {
  name: "NREL 5 MW (referencia)",

  // --- Geometría general ---
  nBlades: 3,
  rotorRadius: 63.0,        // m (radio aerodinámico)
  hubRadius: 1.5,           // m
  hubHeight: 90.0,          // m
  overhang: 5.0,            // m (distancia eje rotor - torre)
  shaftTilt: 5.0 * Math.PI / 180, // rad
  precone: 2.5 * Math.PI / 180,   // rad

  // --- Masas / inercias ---
  rotorInertia: 3.5444e7,   // kg·m^2 (rotor + buje, lado lento, LSS)
  generatorInertia: 534.116,// kg·m^2 (lado rápido, HSS)
  nacelleMass: 240000,      // kg
  towerTopMass: 347460,     // kg (nacelle + rotor aprox.)
  bladeMass: 17740,         // kg por pala

  // --- Multiplicadora ---
  gearRatio: 97.0,

  // --- Tren de potencia (torsión, referido al LSS) ---
  driveTrainStiffness: 8.67637e8,  // N·m/rad
  driveTrainDamping: 6.215e6,      // N·m·s/rad

  // --- Aire ---
  airDensity: 1.225,        // kg/m^3

  // --- Condiciones operativas ---
  cutInWind: 3.0,           // m/s
  ratedWind: 11.4,          // m/s
  cutOutWind: 25.0,         // m/s
  cutInRotorSpeed: 6.9 * 2 * Math.PI / 60,  // rad/s (LSS)
  ratedRotorSpeed: 12.1 * 2 * Math.PI / 60, // rad/s (LSS)
  ratedPower: 5.0e6,        // W (eléctrica)
  ratedGenSpeed: 1173.7 * 2 * Math.PI / 60, // rad/s (HSS)
  generatorEfficiency: 0.944,

  // --- Control ---
  // Par óptimo región 2: Qgen = Kopt * omega_gen^2  (HSS)
  // Kopt se calcula en controller.js a partir de Cp_max y lambda_opt.
  lambdaOpt: 7.55,
  CpMax: 0.482,

  minPitch: 0.0 * Math.PI / 180,   // rad
  maxPitch: 90.0 * Math.PI / 180,  // rad
  maxPitchRate: 8.0 * Math.PI / 180, // rad/s

  // Ganancias PI del control de pitch (sobre velocidad de generador)
  pitchKp: 0.012,    // s
  pitchKi: 0.005,    // -
  // Ganancia de programación (gain scheduling) por sensibilidad al pitch
  pitchKK: 6.302336 * Math.PI / 180, // rad (ángulo donde la sensibilidad se duplica)

  // --- Modos estructurales (representación modal de 2º orden) ---
  // Torre (1er modo flexión). Masa modal en la cima.
  towerFA: { freq: 0.324, damping: 0.01, modalMass: 436000 }, // fore-aft
  towerSS: { freq: 0.312, damping: 0.01, modalMass: 436000 }, // side-side

  // Pala (1er modo de aleteo/flap y 1er modo de arrastre/edge)
  bladeFlap: { freq: 0.70, damping: 0.0048, modalMass: 12000 },
  bladeEdge: { freq: 1.08, damping: 0.0092, modalMass: 13000 },

  // --- Distribución de cuerda, torsión y perfil aerodinámico (NREL 5MW) ---
  // Transcrita directamente de NRELOffshrBsline5MW_AeroDyn_blade.dat (19 nodos).
  // r [m] = hubRadius + BlSpn, cuerda [m], torsión [deg], afid = BlAFID
  // (identificador de perfil AeroDyn, ver AIRFOIL_INFO en airfoilData.js):
  //   1-2 = Cylinder (raíz), 3 = DU40, 4 = DU35, 5 = DU30, 6 = DU25,
  //   7 = DU21, 8 = NACA64-618 (punta).
  bladeStations: [
    { r: 1.5000, chord: 3.542, twist: 13.308, afid: 1 },
    { r: 2.8667, chord: 3.542, twist: 13.308, afid: 1 },
    { r: 5.6000, chord: 3.854, twist: 13.308, afid: 1 },
    { r: 8.3333, chord: 4.167, twist: 13.308, afid: 2 },
    { r: 11.7500, chord: 4.557, twist: 13.308, afid: 3 },
    { r: 15.8500, chord: 4.652, twist: 11.480, afid: 4 },
    { r: 19.9500, chord: 4.458, twist: 10.162, afid: 4 },
    { r: 24.0500, chord: 4.249, twist: 9.011, afid: 5 },
    { r: 28.1500, chord: 4.007, twist: 7.795, afid: 6 },
    { r: 32.2500, chord: 3.748, twist: 6.544, afid: 6 },
    { r: 36.3500, chord: 3.502, twist: 5.361, afid: 7 },
    { r: 40.4500, chord: 3.256, twist: 4.188, afid: 7 },
    { r: 44.5500, chord: 3.010, twist: 3.125, afid: 8 },
    { r: 48.6500, chord: 2.764, twist: 2.319, afid: 8 },
    { r: 52.7500, chord: 2.518, twist: 1.526, afid: 8 },
    { r: 56.1667, chord: 2.313, twist: 0.863, afid: 8 },
    { r: 58.9000, chord: 2.086, twist: 0.370, afid: 8 },
    { r: 61.6333, chord: 1.419, twist: 0.106, afid: 8 },
    { r: 63.0000, chord: 1.419, twist: 0.106, afid: 8 },
  ],
};

// Interpola cuerda, torsión (rad) y perfil aerodinámico a un radio dado.
// afLow/afHigh son los BlAFID de las dos estaciones que rodean r, y blend
// en [0,1] indica cuánto pesa afHigh (0 = puro afLow, 1 = puro afHigh) —
// reproduce la transición gradual de un perfil a otro a lo largo de la pala.
export function bladeGeometryAt(r) {
  const st = TurbineParams.bladeStations;
  if (r <= st[0].r) {
    return { chord: st[0].chord, twist: st[0].twist * Math.PI / 180, afLow: st[0].afid, afHigh: st[0].afid, blend: 0 };
  }
  const last = st[st.length - 1];
  if (r >= last.r) {
    return { chord: last.chord, twist: last.twist * Math.PI / 180, afLow: last.afid, afHigh: last.afid, blend: 0 };
  }
  for (let i = 0; i < st.length - 1; i++) {
    if (r >= st[i].r && r <= st[i + 1].r) {
      const t = (r - st[i].r) / (st[i + 1].r - st[i].r);
      const chord = st[i].chord + t * (st[i + 1].chord - st[i].chord);
      const twist = st[i].twist + t * (st[i + 1].twist - st[i].twist);
      return {
        chord,
        twist: twist * Math.PI / 180,
        afLow: st[i].afid,
        afHigh: st[i + 1].afid,
        blend: t,
      };
    }
  }
  return { chord: 1.0, twist: 0.0, afLow: last.afid, afHigh: last.afid, blend: 0 };
}
