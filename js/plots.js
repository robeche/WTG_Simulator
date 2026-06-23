// plots.js
// Gráficas de series temporales en tiempo real sobre <canvas> (sin dependencias).

class StripChart {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.title = opts.title;
    this.unit = opts.unit || "";
    this.window = opts.window || 60; // s visibles
    this.series = opts.series;       // [{name, color, ref?}]
    this.fixedMin = opts.min;
    this.fixedMax = opts.max;
    this.extract = opts.extract; // (outputs) => number[]
    this.data = this.series.map(() => []);
    this.time = [];
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._resize();
  }

  _resize() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(rect.width * this._dpr));
    c.height = Math.max(1, Math.floor(rect.height * this._dpr));
  }

  push(t, values) {
    this.time.push(t);
    for (let i = 0; i < this.series.length; i++) this.data[i].push(values[i]);
    // recorta a la ventana
    const tMin = t - this.window;
    while (this.time.length > 2 && this.time[0] < tMin) {
      this.time.shift();
      for (const d of this.data) d.shift();
    }
  }

  clear() {
    this.time = [];
    this.data = this.series.map(() => []);
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const Hh = this.canvas.height;
    const dpr = this._dpr;
    ctx.clearRect(0, 0, W, Hh);

    const padL = 52 * dpr, padR = 10 * dpr, padT = 22 * dpr, padB = 20 * dpr;
    const plotW = W - padL - padR;
    const plotH = Hh - padT - padB;

    // Fondo
    ctx.fillStyle = "#11151c";
    ctx.fillRect(0, 0, W, Hh);

    if (this.time.length < 2) {
      this._drawTitle(ctx, dpr, padL, padT);
      return;
    }

    const t1 = this.time[this.time.length - 1];
    const t0 = t1 - this.window;

    // Rango Y
    let yMin = this.fixedMin, yMax = this.fixedMax;
    if (yMin === undefined || yMax === undefined) {
      let lo = Infinity, hi = -Infinity;
      for (const d of this.data) for (const v of d) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (lo === hi) { lo -= 1; hi += 1; }
      const m = (hi - lo) * 0.1;
      yMin = (this.fixedMin !== undefined) ? this.fixedMin : lo - m;
      yMax = (this.fixedMax !== undefined) ? this.fixedMax : hi + m;
    }

    const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const yOf = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // Rejilla y etiquetas Y
    ctx.strokeStyle = "#27303d";
    ctx.fillStyle = "#7b8794";
    ctx.lineWidth = 1 * dpr;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const nY = 4;
    for (let i = 0; i <= nY; i++) {
      const v = yMin + ((yMax - yMin) * i) / nY;
      const y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(this._fmt(v), padL - 5 * dpr, y);
    }

    // Series
    for (let si = 0; si < this.series.length; si++) {
      const d = this.data[si];
      ctx.strokeStyle = this.series[si].color;
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < d.length; i++) {
        const x = xOf(this.time[i]);
        const y = yOf(d[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    this._drawTitle(ctx, dpr, padL, padT);

    // Leyenda
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let lx = padL + 4 * dpr;
    const ly = padT - 11 * dpr;
    for (const s of this.series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly - 3 * dpr, 10 * dpr, 6 * dpr);
      ctx.fillStyle = "#c7d0db";
      ctx.fillText(s.name, lx + 14 * dpr, ly);
      lx += (s.name.length * 6.5 + 26) * dpr;
    }
  }

  _drawTitle(ctx, dpr, padL, padT) {
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#e8edf2";
    ctx.font = `bold ${11 * dpr}px system-ui, sans-serif`;
    const label = this.unit ? `${this.title} [${this.unit}]` : this.title;
    ctx.fillText(label, 6 * dpr, 13 * dpr);
  }

  _fmt(v) {
    const a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toFixed(1) + "k";
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
}

export class PlotManager {
  constructor() {
    this.charts = [];
  }

  add(canvas, opts) {
    const c = new StripChart(canvas, opts);
    this.charts.push(c);
    return c;
  }

  pushOutputs(o) {
    for (const c of this.charts) {
      if (c.extract) c.push(o.t, c.extract(o));
    }
  }

  resize() {
    for (const c of this.charts) c._resize();
  }

  clear() {
    for (const c of this.charts) c.clear();
  }

  draw() {
    for (const c of this.charts) c.draw();
  }
}

export { StripChart };
