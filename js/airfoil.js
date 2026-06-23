// airfoil.js
// Modelo de polar aerodinámica (Cl, Cd en función del ángulo de ataque).
// Se usa un modelo analítico tipo placa plana con corrección de pérdida (Viterna),
// representativo de los perfiles DU/NACA64 del rotor NREL 5 MW.
// Esto evita depender de tablas externas manteniendo un comportamiento físico razonable.

const DEG = Math.PI / 180;

// Parámetros del perfil "equivalente"
const ALPHA0 = -2.0 * DEG;     // ángulo de sustentación nula
const CL_ALPHA = 2 * Math.PI;  // pendiente de sustentación (1/rad), teoría delgada
const ALPHA_STALL_POS = 13.0 * DEG;
const ALPHA_STALL_NEG = -10.0 * DEG;
const CD0 = 0.008;             // arrastre mínimo
const CD_STALL = 0.30;

// Coeficientes de sustentación en el inicio de pérdida
const CL_STALL_POS = CL_ALPHA * (ALPHA_STALL_POS - ALPHA0);
const CL_STALL_NEG = CL_ALPHA * (ALPHA_STALL_NEG - ALPHA0);

// Extensión de Viterna para grandes ángulos de ataque (modelo de placa plana)
const AR = 17.0; // relación de aspecto efectiva
const CD_MAX = 1.11 + 0.018 * AR;

function viterna(alpha, clStall, alphaStall) {
  // alpha y alphaStall en rad, alpha en [alphaStall, pi/2] (lado positivo)
  const A1 = CD_MAX / 2;
  const B1 = CD_MAX;
  const sa = Math.sin(alpha);
  const ca = Math.cos(alpha);
  const A2 =
    (clStall - CD_MAX * Math.sin(alphaStall) * Math.cos(alphaStall)) *
    Math.sin(alphaStall) /
    (Math.cos(alphaStall) * Math.cos(alphaStall) + 1e-9);
  const B2 = (CD_STALL - CD_MAX * Math.sin(alphaStall) * Math.sin(alphaStall)) /
    Math.max(Math.cos(alphaStall), 1e-6);
  const cl = A1 * Math.sin(2 * alpha) + A2 * (ca * ca) / Math.max(Math.abs(sa), 1e-6);
  const cd = B1 * sa * sa + B2 * ca;
  return { cl, cd };
}

// Devuelve {cl, cd} para un ángulo de ataque (rad)
export function airfoilCoeffs(alpha) {
  // Normaliza alpha a [-pi, pi]
  let a = alpha;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;

  if (a >= ALPHA_STALL_NEG && a <= ALPHA_STALL_POS) {
    // Región lineal (adherida)
    const cl = CL_ALPHA * (a - ALPHA0);
    const cd = CD0 + 0.012 * Math.pow((a - ALPHA0), 2); // parábola de arrastre
    return { cl, cd };
  }

  // Región de pérdida / grandes ángulos: modelo de placa plana (Viterna)
  if (a > ALPHA_STALL_POS) {
    if (a <= Math.PI / 2) {
      const v = viterna(a, CL_STALL_POS, ALPHA_STALL_POS);
      return v;
    }
    // a en (pi/2, pi]: placa plana
    const cl = 2 * Math.sin(a) * Math.cos(a);
    const cd = CD_MAX * Math.sin(a) * Math.sin(a) + CD0;
    return { cl, cd };
  } else {
    // a < ALPHA_STALL_NEG (negativo) — simetría aproximada
    if (a >= -Math.PI / 2) {
      const v = viterna(-a, -CL_STALL_NEG, -ALPHA_STALL_NEG);
      return { cl: -v.cl, cd: v.cd };
    }
    const cl = 2 * Math.sin(a) * Math.cos(a);
    const cd = CD_MAX * Math.sin(a) * Math.sin(a) + CD0;
    return { cl, cd };
  }
}
