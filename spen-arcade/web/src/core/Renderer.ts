import { clamp, damp, TAU } from './math';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number;
  color: string; drag: number; gravity: number; additive: boolean;
}

/**
 * Canvas2D-рендерер с камерой, тряской, пулом частиц и аддитивным слоем.
 * Пул фиксированного размера: аркада на телефоне не может позволить себе
 * аллокации по 300 объектов в кадр — GC-паузы видны как фризы.
 */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  dpr = 1;

  camX = 0; camY = 0; camZoom = 1; camRot = 0;
  private shake = 0;
  private shakeX = 0; private shakeY = 0;
  private flashAlpha = 0;
  private flashColor = '#fff';

  private pool: Particle[] = [];
  private live = 0;
  private static readonly MAX_PARTICLES = 900;

  constructor(private canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!c) throw new Error('Canvas2D недоступен');
    this.ctx = c;
    for (let i = 0; i < Renderer.MAX_PARTICLES; i++) {
      this.pool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2,
                       color: '#fff', drag: 0, gravity: 0, additive: false });
    }
    this.resizeIfNeeded();
  }

  resizeIfNeeded() {
    // Ограничиваем DPR: на Galaxy Ultra честные 3.0 съедают 40% кадра впустую.
    const dpr = clamp(devicePixelRatio || 1, 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.dpr = dpr;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
  }

  beginFrame(dt: number) {
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.shake = damp(this.shake, 0, 0.09, dt);
    const s = this.shake;
    this.shakeX = (Math.random() * 2 - 1) * s;
    this.shakeY = (Math.random() * 2 - 1) * s;

    this.flashAlpha = damp(this.flashAlpha, 0, 0.06, dt);
    this.updateParticles(dt);
  }

  endFrame() {
    if (this.flashAlpha > 0.004) {
      const g = this.ctx;
      g.save();
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.globalAlpha = this.flashAlpha;
      g.fillStyle = this.flashColor;
      g.fillRect(0, 0, this.width, this.height);
      g.restore();
    }
  }

  clear(color: string) {
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = color;
    g.fillRect(0, 0, this.width, this.height);
  }

  /** Применяет камеру. Всё, что рисуется между camera()/restore() — в мире. */
  camera() {
    const g = this.ctx;
    g.save();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.translate(this.width / 2 + this.shakeX, this.height / 2 + this.shakeY);
    g.rotate(this.camRot);
    g.scale(this.camZoom, this.camZoom);
    g.translate(-this.camX, -this.camY);
  }
  restore() { this.ctx.restore(); }

  /** UI-слой: без камеры, но с тряской — иначе HUD «отклеивается» при взрывах. */
  ui() {
    const g = this.ctx;
    g.save();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  addShake(amount: number) { this.shake = Math.min(this.shake + amount, 34); }
  flash(color = '#ffffff', a = 0.5) { this.flashColor = color; this.flashAlpha = Math.max(this.flashAlpha, a); }

  // ---------------- частицы ----------------
  spawn(
    x: number, y: number, vx: number, vy: number,
    life: number, size: number, color: string,
    opts: { drag?: number; gravity?: number; additive?: boolean } = {}
  ) {
    if (this.live >= Renderer.MAX_PARTICLES) return;
    const p = this.pool[this.live++];
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life; p.size = size; p.color = color;
    p.drag = opts.drag ?? 1.6;
    p.gravity = opts.gravity ?? 0;
    p.additive = opts.additive ?? true;
  }

  /** Радиальный взрыв — самый частый эффект во всех мини-играх. */
  burst(x: number, y: number, count: number, speed: number, color: string, life = 0.6, gravity = 0) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = speed * (0.35 + Math.random() * 0.65);
      this.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
        life * (0.6 + Math.random() * 0.6), 1.5 + Math.random() * 2.5, color, { gravity });
    }
  }

  private updateParticles(dt: number) {
    for (let i = 0; i < this.live; i++) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        // swap-remove: порядок частиц не важен, зато нет сдвига массива
        this.pool[i] = this.pool[this.live - 1];
        this.pool[this.live - 1] = p;
        this.live--;
        i--;
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  /** Рисуется внутри camera(). */
  drawParticles() {
    const g = this.ctx;
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.live; i++) {
      const p = this.pool[i];
      const t = p.life / p.maxLife;
      g.globalAlpha = t * t;
      g.fillStyle = p.color;
      const s = p.size * (0.4 + t * 0.6);
      g.fillRect(p.x - s * 0.5, p.y - s * 0.5, s, s);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
  }

  // ---------------- удобные примитивы ----------------
  text(s: string, x: number, y: number, size = 16, color = '#e8f0ff', align: CanvasTextAlign = 'left') {
    const g = this.ctx;
    g.fillStyle = color;
    g.font = `600 ${size}px "Inter", system-ui, sans-serif`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(s, x, y);
  }

  circle(x: number, y: number, r: number, color: string) {
    const g = this.ctx;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fillStyle = color;
    g.fill();
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, color: string, stroke = false) {
    const g = this.ctx;
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    if (stroke) { g.strokeStyle = color; g.lineWidth = 2; g.stroke(); }
    else { g.fillStyle = color; g.fill(); }
  }
}
