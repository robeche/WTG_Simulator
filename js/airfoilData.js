// airfoilData.js
// Loads and parses the real NREL 5 MW airfoil polar (Cl, Cd vs angle of attack)
// and shape coordinate files shipped in /data. These are the actual
// AeroDyn/AirfoilInfo input files distributed with the NREL 5 MW reference
// turbine definition, so both the BEM Method tab and the Full Simulator can
// use the real, radius-dependent airfoil family instead of a single generic
// analytic profile.
//
// Data loading is asynchronous (fetch); every consumer degrades gracefully
// to the analytic Viterna polar (airfoil.js) or a nominal thickness value
// until the real data has finished loading.

import { airfoilCoeffs as airfoilCoeffsAnalytic } from "./airfoil.js";

const DATA_BASE = "data/";

// Blade-station airfoil IDs (BlAFID column of the AeroDyn blade file) and the
// corresponding AirfoilInfo files.
export const AIRFOIL_INFO = {
  1: { name: "Cylinder1", file: "Cylinder1", thickness: 1.00, label: "Cylinder (root)" },
  2: { name: "Cylinder2", file: "Cylinder2", thickness: 1.00, label: "Cylinder (root)" },
  3: { name: "DU40_A17", file: "DU40_A17", thickness: 0.40, label: "DU40 (40% t/c)" },
  4: { name: "DU35_A17", file: "DU35_A17", thickness: 0.35, label: "DU35 (35% t/c)" },
  5: { name: "DU30_A17", file: "DU30_A17", thickness: 0.30, label: "DU30 (30% t/c)" },
  6: { name: "DU25_A17", file: "DU25_A17", thickness: 0.25, label: "DU25 (25% t/c)" },
  7: { name: "DU21_A17", file: "DU21_A17", thickness: 0.21, label: "DU21 (21% t/c)" },
  8: { name: "NACA64_A17", file: "NACA64_A17", thickness: 0.18, label: "NACA64-618 (18% t/c)" },
};

let db = null; // populated once loading finishes: { [id]: { points, ref, polar, thickness } }
let loadingPromise = null;

// Parses an AirfoilInfo *_coords.txt shape file. Format: a "NumCoords" header
// line, then a single x/c,y/c reference (pitch-axis) point, then the closed
// loop of shape coordinates (trailing edge -> around the leading edge ->
// trailing edge again).
function parseCoords(text) {
  const pts = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!")) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      pts.push({ x: parts[0], y: parts[1] });
    }
  }
  const ref = pts.shift() || { x: 0.25, y: 0 };
  return { points: pts, ref };
}

// Parses an AirfoilInfo *.dat polar file, extracting the Alpha/Cl/Cd table.
// Any other numeric parameter line in the file always contains at least one
// non-numeric token (its name/label), so requiring every token on the line
// to be a finite number is enough to isolate the data rows.
function parsePolar(text) {
  const alpha = [];
  const cl = [];
  const cd = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!")) continue;
    const parts = line.split(/\s+/).map(Number);
    if (
      parts.length >= 3 &&
      parts.length <= 4 &&
      parts.every((v) => Number.isFinite(v)) &&
      parts[0] >= -180.001 &&
      parts[0] <= 180.001
    ) {
      alpha.push((parts[0] * Math.PI) / 180);
      cl.push(parts[1]);
      cd.push(parts[2]);
    }
  }
  return { alpha, cl, cd };
}

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.text();
}

// Kicks off loading of all airfoil files (idempotent: safe to call repeatedly,
// always returns the same promise). Resolves once every airfoil is parsed.
export function loadAirfoilData() {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const entries = Object.entries(AIRFOIL_INFO);
    const results = await Promise.all(
      entries.map(async ([id, info]) => {
        const [coordsText, polarText] = await Promise.all([
          fetchText(`${DATA_BASE}${info.file}_coords.txt`),
          fetchText(`${DATA_BASE}${info.file}.dat`),
        ]);
        const { points, ref } = parseCoords(coordsText);
        const polar = parsePolar(polarText);
        let yMin = Infinity;
        let yMax = -Infinity;
        for (const p of points) {
          if (p.y < yMin) yMin = p.y;
          if (p.y > yMax) yMax = p.y;
        }
        const thickness = Number.isFinite(yMax - yMin) ? yMax - yMin : info.thickness;
        return [Number(id), { points, ref, polar, thickness }];
      })
    );
    db = Object.fromEntries(results);
    return db;
  })().catch((err) => {
    console.error("Failed to load NREL 5MW airfoil data, falling back to analytic model.", err);
    loadingPromise = null; // allow a retry on next call
    throw err;
  });
  return loadingPromise;
}

export function isAirfoilDataReady() {
  return db !== null;
}

// Linear interpolation of Cl/Cd at a given angle of attack (rad) for one airfoil id.
function interpPolar(id, alphaRad) {
  const af = db[id];
  const a = af.polar.alpha;
  const n = a.length;
  if (n === 0) return airfoilCoeffsAnalytic(alphaRad);
  if (alphaRad <= a[0]) return { cl: af.polar.cl[0], cd: af.polar.cd[0] };
  if (alphaRad >= a[n - 1]) return { cl: af.polar.cl[n - 1], cd: af.polar.cd[n - 1] };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= alphaRad) lo = mid;
    else hi = mid;
  }
  const t = (alphaRad - a[lo]) / (a[hi] - a[lo]);
  return {
    cl: af.polar.cl[lo] + t * (af.polar.cl[hi] - af.polar.cl[lo]),
    cd: af.polar.cd[lo] + t * (af.polar.cd[hi] - af.polar.cd[lo]),
  };
}

// Cl/Cd at a blade station that sits between two airfoil families
// (afLow -> afHigh, blend in [0,1]), matching the actual NREL 5 MW spanwise
// airfoil schedule. Falls back to the analytic Viterna model (airfoil.js)
// until the real data has finished loading.
export function airfoilCoeffsBlend(afLow, afHigh, blend, alphaRad) {
  if (!db) return airfoilCoeffsAnalytic(alphaRad);
  const a = interpPolar(afLow, alphaRad);
  if (afHigh === afLow || blend <= 1e-6) return a;
  const b = interpPolar(afHigh, alphaRad);
  return { cl: a.cl + blend * (b.cl - a.cl), cd: a.cd + blend * (b.cd - a.cd) };
}

// Real shape coordinates blended between two airfoil families, for rendering.
// Returns an array of {x, y} chordwise fractions (x/c, y/c), or null if the
// data has not loaded yet or the shapes are incompatible for blending.
export function airfoilShapeBlend(afLow, afHigh, blend) {
  if (!db) return null;
  const shapeA = db[afLow]?.points;
  if (!shapeA) return null;
  if (afHigh === afLow || blend <= 1e-6) return shapeA;
  const shapeB = db[afHigh]?.points;
  if (!shapeB || shapeB.length !== shapeA.length) return shapeA;
  const out = new Array(shapeA.length);
  for (let i = 0; i < shapeA.length; i++) {
    out[i] = {
      x: shapeA[i].x + blend * (shapeB[i].x - shapeA[i].x),
      y: shapeA[i].y + blend * (shapeB[i].y - shapeA[i].y),
    };
  }
  return out;
}

// Chordwise position (x/c) of the pitch/reference axis at a blended station.
export function refXBlend(afLow, afHigh, blend) {
  const rLow = db?.[afLow]?.ref?.x ?? 0.25;
  const rHigh = db?.[afHigh]?.ref?.x ?? 0.25;
  return rLow + blend * (rHigh - rLow);
}

// Thickness ratio (t/c) at a blended station; uses real geometric thickness
// once loaded, otherwise falls back to nominal published values.
export function thicknessBlend(afLow, afHigh, blend) {
  const tLow = db?.[afLow]?.thickness ?? AIRFOIL_INFO[afLow].thickness;
  const tHigh = db?.[afHigh]?.thickness ?? AIRFOIL_INFO[afHigh].thickness;
  return tLow + blend * (tHigh - tLow);
}

// Human-readable label for a (possibly blended) station, e.g. "DU30 (30% t/c)"
// or "DU30 (30% t/c) → DU25 (25% t/c) (42%)".
export function airfoilLabel(afLow, afHigh, blend) {
  const lowLabel = AIRFOIL_INFO[afLow]?.label ?? `#${afLow}`;
  if (afHigh === afLow || blend <= 1e-6) return lowLabel;
  const highLabel = AIRFOIL_INFO[afHigh]?.label ?? `#${afHigh}`;
  return `${lowLabel} → ${highLabel} (${(blend * 100).toFixed(0)}%)`;
}
