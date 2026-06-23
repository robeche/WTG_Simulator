# WTG Simulator — Simulador de Aerogenerador

Aplicación web para la simulación dinámica de un aerogenerador de eje horizontal
(turbina de referencia NREL 5 MW), con visualización 3D en tiempo real y gráficas
de las principales variables operativas.

## Características

- **Aerodinámica:** solver Blade Element Momentum (BEM) con 24 elementos de pala,
  pérdidas de punta y raíz de Prandtl y corrección de Glauert para alta carga.
- **Elasticidad estructural:** superposición modal (osciladores de 2.º orden) de los
  primeros modos de:
  - Torre: fore-aft y side-side.
  - Pala: aleteo (flap) y arrastre (edge).
  - Tren de potencia: grado de libertad torsional (drive train).
- **Control:** par óptimo en carga parcial (región 2) y control PI de paso (pitch)
  con _gain scheduling_ en plena potencia (región 3).
- **Parada de emergencia:** embanderamiento de palas (feathering a 90°) y freno
  mecánico de disco.
- **Modelo de viento:** velocidad media, turbulencia, cizalladura (perfil potencial)
  y ráfagas sinusoidales.
- **Visualización 3D** con Three.js: giro del rotor, paso de pala y deflexiones
  estructurales (con factor de exageración ajustable).
- **Gráficas en tiempo real:** potencia, par, velocidad de rotor, pitch, TSR (λ),
  viento, empuje y deflexiones estructurales.

## Uso

Al usar módulos ES, la aplicación debe servirse mediante un servidor HTTP local
(no abriendo el archivo directamente).

```powershell
# Desde la carpeta del proyecto
python -m http.server 8123
```

Después abre <http://localhost:8123/index.html> en el navegador.

## Estructura del proyecto

```
WTG_Simulator/
├── index.html              # Interfaz principal
├── css/
│   └── style.css           # Estilos
└── js/
    ├── main.js             # Punto de entrada y wiring de la UI
    ├── turbine.js          # Parámetros de la turbina y geometría de pala
    ├── airfoil.js          # Polar aerodinámica (Cl, Cd)
    ├── bem.js              # Solver Blade Element Momentum
    ├── structural.js       # Modos estructurales (2.º orden)
    ├── controller.js       # Control de par y paso + parada de emergencia
    ├── simulation.js       # Bucle de simulación acoplado (integrador RK4)
    ├── visualization.js    # Visualización 3D (Three.js)
    └── plots.js            # Gráficas de series temporales (canvas)
```

## Modelo de referencia

Los parámetros corresponden al aerogenerador de referencia **NREL 5 MW**
(rotor de 126 m de diámetro, altura de buje de 90 m, multiplicadora 1:97).

## Notas

- Three.js se carga desde CDN mediante un _import map_; se requiere conexión a
  internet la primera vez.
- La aerodinámica se trata de forma cuasi-estacionaria dentro de cada paso de
  integración.

## Licencia

MIT
