// visualization.js
// Visualización 3D del aerogenerador con Three.js.
// Representa torre, góndola, buje y 3 palas, aplicando en cada fotograma:
//  - giro del rotor (azimut)
//  - paso de pala (pitch)
//  - flexión de torre (fore-aft / side-side)
//  - flexión de palas (aleteo / arrastre)

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TurbineParams as P, bladeGeometryAt } from "./turbine.js";

const TOWER_SEGMENTS = 14;
const BLADE_SEGMENTS = 12;

export class Visualizer {
  constructor(container) {
    this.container = container;
    this.exaggeration = 8; // factor de exageración de las deflexiones
    this._initScene();
    this._buildTurbine();
    this._animateBound = null;
  }

  _initScene() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc7e8);
    this.scene.fog = new THREE.Fog(0x9fc7e8, 250, 700);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.5, 2000);
    this.camera.position.set(120, 90, 160);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, P.hubHeight * 0.6, 0);
    this.controls.enableDamping = true;
    this.controls.update();

    // Luces
    const hemi = new THREE.HemisphereLight(0xffffff, 0x556b2f, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(120, 200, 100);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 600;
    sun.shadow.camera.left = -150;
    sun.shadow.camera.right = 150;
    sun.shadow.camera.top = 250;
    sun.shadow.camera.bottom = -50;
    this.scene.add(sun);

    // Suelo
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(600, 64),
      new THREE.MeshStandardMaterial({ color: 0x5a8f3c, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Rejilla sutil
    const grid = new THREE.GridHelper(800, 80, 0x3c6b28, 0x4a7d32);
    grid.position.y = 0.05;
    this.scene.add(grid);
  }

  _buildTurbine() {
    const matTower = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, metalness: 0.1 });
    const matNacelle = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5, metalness: 0.2 });
    const matHub = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5 });
    const matBlade = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.4, metalness: 0.05, side: THREE.DoubleSide });

    // --- Torre por segmentos (para flexión) ---
    this.towerSegs = [];
    const H = P.hubHeight;
    const baseR = 3.0, topR = 1.9;
    for (let i = 0; i < TOWER_SEGMENTS; i++) {
      const y0 = (i / TOWER_SEGMENTS) * H;
      const y1 = ((i + 1) / TOWER_SEGMENTS) * H;
      const r0 = baseR + (topR - baseR) * (i / TOWER_SEGMENTS);
      const r1 = baseR + (topR - baseR) * ((i + 1) / TOWER_SEGMENTS);
      const len = y1 - y0;
      const geo = new THREE.CylinderGeometry(r1, r0, len, 20, 1);
      const mesh = new THREE.Mesh(geo, matTower);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { y0: y0 + len / 2, frac: (y0 + len / 2) / H };
      this.scene.add(mesh);
      this.towerSegs.push(mesh);
    }

    // --- Conjunto superior (góndola + rotor) ---
    this.topGroup = new THREE.Group();
    this.scene.add(this.topGroup);

    // Góndola
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 8), matNacelle);
    nacelle.position.set(-2, 0, 0);
    nacelle.castShadow = true;
    this.topGroup.add(nacelle);

    // Grupo del rotor (con inclinación del eje)
    this.rotorTilt = new THREE.Group();
    this.rotorTilt.rotation.z = P.shaftTilt;
    this.topGroup.add(this.rotorTilt);

    // Eje
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.8, P.overhang + 2, 16),
      matHub
    );
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = P.overhang / 2;
    this.rotorTilt.add(shaft);

    // Grupo que gira (azimut)
    this.rotorSpin = new THREE.Group();
    this.rotorSpin.position.x = P.overhang;
    this.rotorTilt.add(this.rotorSpin);

    // Buje
    const hub = new THREE.Mesh(new THREE.SphereGeometry(2.0, 24, 16), matHub);
    hub.castShadow = true;
    this.rotorSpin.add(hub);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(2.0, 3.5, 24), matHub);
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = 2.3;
    this.rotorSpin.add(nose);

    // --- Palas ---
    this.blades = [];
    for (let b = 0; b < P.nBlades; b++) {
      const pitchGroup = new THREE.Group(); // azimut de la pala
      pitchGroup.rotation.x = (b * 2 * Math.PI) / P.nBlades;
      this.rotorSpin.add(pitchGroup);

      const pitchAxis = new THREE.Group(); // eje de paso (a lo largo de la envergadura = +Y local)
      pitchGroup.add(pitchAxis);

      // Segmentos de pala
      const segs = [];
      const r0 = P.hubRadius;
      const R = P.rotorRadius;
      for (let i = 0; i < BLADE_SEGMENTS; i++) {
        const ra = r0 + ((R - r0) * i) / BLADE_SEGMENTS;
        const rb = r0 + ((R - r0) * (i + 1)) / BLADE_SEGMENTS;
        const ga = bladeGeometryAt(ra);
        const gb = bladeGeometryAt(rb);
        const len = rb - ra;
        // Sección de la pala: la cuerda se orienta a lo largo de Z local
        // (tangencial, en el plano del rotor) y el espesor a lo largo de X local
        // (eje del rotor). Así, a paso 0 la cara ancha mira al viento (posición
        // de operación) y a 90° la pala queda de canto (bandera).
        const chord = (ga.chord + gb.chord) / 2;
        const thick = chord * 0.18;
        const geo = new THREE.BoxGeometry(thick, len, chord);
        const mesh = new THREE.Mesh(geo, matBlade);
        mesh.castShadow = true;
        // torsión geométrica de la pala (alrededor del eje de envergadura, Y)
        mesh.rotation.y = ga.twist;
        mesh.userData = { rMid: (ra + rb) / 2, frac: ((ra + rb) / 2 - r0) / (R - r0) };
        pitchAxis.add(mesh);
        segs.push(mesh);
      }
      this.blades.push({ pitchAxis, segs });
    }
  }

  // Actualiza la pose según el estado de simulación
  update(viz) {
    const ex = this.exaggeration;
    const H = P.hubHeight;
    const faTip = viz.towerFA * ex;
    const ssTip = viz.towerSS * ex;

    // Flexión de la torre: forma ~ frac^2 (1er modo en voladizo).
    // El eje del rotor está a lo largo de X, por lo que el empuje del viento
    // (fore-aft) flexiona la torre en X (hacia atrás, aguas abajo = -X);
    // el modo lateral (side-side) lo hace en Z.
    for (const seg of this.towerSegs) {
      const shape = seg.userData.frac * seg.userData.frac;
      seg.position.set(-faTip * shape, seg.userData.y0, ssTip * shape);
    }

    // Conjunto superior sigue la punta de la torre
    this.topGroup.position.set(-faTip, H, ssTip);
    // pequeña inclinación de la góndola por la flexión
    this.topGroup.rotation.z = (faTip / H) * 0.5;
    this.topGroup.rotation.x = (ssTip / H) * 0.5;

    // Giro del rotor
    this.rotorSpin.rotation.x = viz.azimuth;

    // Palas: paso + flexión
    for (let b = 0; b < this.blades.length; b++) {
      const blade = this.blades[b];
      blade.pitchAxis.rotation.y = viz.pitch; // paso colectivo
      const flapTip = viz.bladeFlap[b] * ex;  // fuera de plano
      const edgeTip = viz.bladeEdge[b] * ex;  // en plano
      for (const seg of blade.segs) {
        const shape = seg.userData.frac * seg.userData.frac;
        // a lo largo de Y (envergadura); flap ~ Z local, edge ~ X local
        seg.position.set(edgeTip * shape, seg.userData.rMid, flapTip * shape);
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
