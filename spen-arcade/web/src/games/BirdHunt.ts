import { Scene, SceneContext } from '../core/Engine';
import { Shell } from '../core/Shell';
import { clamp, damp, lerp, makeRng, segmentHitsCircle, SpatialHash, TAU } from '../core/math';

interface Bird {
  x: number; y: number; r: number;
  vx: number; vy: number;
  flap: number; hp: number; kind: 0 | 1 | 2; // 0 обычная, 1 быстрая, 2 жирная
  alive: boolean; panic: number;
}
interface Pellet { x: number; y: number; px: number; py: number; vx: number; vy: number; life: number; }

/**
 * BIRD HUNT — стрельба наклоном пера.
 *
 * Управление:
 *   наклон             — ведёт прицел (скорость прицела ∝ наклону = «джойстик»)
 *   короткое нажатие   — выстрел дробью (разлёт + отдача, подбрасывающая прицел)
 *   долгое удержание   — перезарядка
 *   перо у экрана      — снайперский режим: прицел прыгает под кончик пера
 *
 * Сложная часть: стая ведёт себя по правилам boids + паника от выстрела,
 * а пули летят с конечной скоростью, поэтому по быстрым птицам нужно
 * брать упреждение. Индикатор упреждения включается перком «трассеры».
 */
export class BirdHunt implements Scene {
  name = 'hunt';

  private rng = makeRng(42);
  private birds: Bird[] = [];
  private pellets: Pellet[] = [];
  private hash = new SpatialHash<{ x: number; y: number; r: number }>(72);

  private aimX = 0; private aimY = 0;
  private recoil = 0;
  private recoilKickY = 0;

  private ammo = 6;
  private maxAmmo = 6;
  private reloading = 0;
  private score = 0;
  private streak = 0;
  private misses = 0;
  private wave = 1;
  private waveTimer = 0;
  private timeLeft = 60;
  private over = false;
  private overTimer = 0;

  /**
   * Во сколько ширин экрана превращается единичная дельта пера.
   *
   * Прицел ведут как ствол пушки: перо — относительный указатель, а не
   * рычаг скорости. Инерции и возврата к центру здесь быть не должно,
   * иначе невозможно навестись на точку и удержать её.
   */
  private static readonly AIM_GAIN = 1.0;
  private static readonly PELLET_SPEED = 1500;
  private static readonly PELLETS = 7;
  private static readonly SPREAD = 0.075;     // рад
  private static readonly RELOAD_TIME = 1.1;

  private onEvent = (kind: string) => {
    if (this.over || this.ctxRef?.scene !== 'hunt') return;
    if (this.shell.phase !== 'playing') return;
    if (kind === 'button_tap') this.wantShot = true;
    if (kind === 'button_long') this.wantReload = true;
  };
  private wantShot = false;
  private wantReload = false;
  private bound = false;
  private shell = new Shell('hunt', () => this.restart());
  private ctxRef: SceneContext | null = null;

  enter(ctx: SceneContext) {
    this.ctxRef = ctx;
    this.restart();
  }

  private restart() {
    const ctx = this.ctxRef!;
    this.rng = makeRng((Date.now() & 0xffff) | 1);
    this.birds = []; this.pellets = [];
    this.aimX = ctx.w / 2; this.aimY = ctx.h / 2;
    this.recoil = 0; this.recoilKickY = 0;
    this.ammo = this.maxAmmo; this.reloading = 0;
    this.score = 0; this.streak = 0; this.misses = 0;
    this.wave = 1; this.waveTimer = 0; this.timeLeft = 60;
    this.over = false; this.overTimer = 0;
    this.wantShot = false; this.wantReload = false;

    if (!this.bound) { ctx.input.onEvent(this.onEvent); this.bound = true; }
    ctx.r.camX = 0; ctx.r.camY = 0; ctx.r.camZoom = 1; ctx.r.camRot = 0;
    this.spawnWave(ctx);
    this.shell.begin(ctx);
  }

  private spawnWave(ctx: SceneContext) {
    const count = Math.min(3 + this.wave * 2, 16);
    const fromLeft = this.rng() < 0.5;
    for (let i = 0; i < count; i++) {
      const kind: 0 | 1 | 2 = this.rng() < 0.15 && this.wave > 2 ? 2
                            : this.rng() < 0.3 + this.wave * 0.03 ? 1 : 0;
      const speed = kind === 1 ? 300 + this.wave * 16 : kind === 2 ? 110 : 180 + this.wave * 10;
      const y = lerp(ctx.h * 0.12, ctx.h * 0.72, this.rng());
      this.birds.push({
        x: fromLeft ? -60 - i * 45 : ctx.w + 60 + i * 45,
        y,
        r: kind === 2 ? 26 : 15,
        vx: fromLeft ? speed : -speed,
        vy: (this.rng() * 2 - 1) * 40,
        flap: this.rng() * TAU,
        hp: kind === 2 ? 3 : 1,
        kind,
        alive: true,
        panic: 0,
      });
    }
  }

  update(ctx: SceneContext, dt: number) {
    this.ctxRef = ctx;
    if (!this.shell.update(ctx, dt)) return;
    const { pen, r, audio } = ctx;

    if (this.over) {
      this.overTimer += dt;
      if (this.overTimer > 1.2) {
        this.shell.finish(ctx, {
          title: 'ОХОТА ОКОНЧЕНА',
          score: this.score,
          note: `волна ${this.wave} · промахов ${this.misses}`,
        });
      }
      return;
    }

    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.over = true; audio.fail(); return; }

    // --- прицел ---------------------------------------------------------------
    const { dx, dy } = ctx.input.consumeDelta();

    if (pen.hover && pen.hoverDistance < 0.45 && pen.source === 'native') {
      // Перо у экрана — наводимся абсолютно, прямо под кончик.
      this.aimX = damp(this.aimX, pen.hoverX * ctx.w, 0.05, dt);
      this.aimY = damp(this.aimY, pen.hoverY * ctx.h, 0.05, dt);
    } else {
      const gain = BirdHunt.AIM_GAIN * ctx.input.sensitivity;
      this.aimX += dx * ctx.w * gain;
      this.aimY += dy * ctx.h * gain;
    }

    // Отдача — короткий толчок вверх, который сам затухает.
    this.aimY += this.recoilKickY * dt;
    this.recoilKickY = damp(this.recoilKickY, 0, 0.05, dt);

    // Жёсткие границы: прицел просто упирается в край, без отскока —
    // ствол тоже не отпрыгивает от упора.
    this.aimX = clamp(this.aimX, 20, ctx.w - 20);
    this.aimY = clamp(this.aimY, 20, ctx.h - 20);

    this.recoil = damp(this.recoil, 0, 0.08, dt);

    // --- перезарядка / выстрел -------------------------------------------------
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { this.ammo = this.maxAmmo; audio.tick(); }
    } else if (this.wantReload && this.ammo < this.maxAmmo) {
      this.reloading = BirdHunt.RELOAD_TIME;
      audio.tick();
    }
    this.wantReload = false;

    if (this.wantShot) {
      this.wantShot = false;
      if (this.ammo > 0 && this.reloading <= 0) this.fire(ctx);
      else if (this.reloading <= 0) { this.reloading = BirdHunt.RELOAD_TIME; audio.tick(); }
    }

    // --- птицы: boids + паника --------------------------------------------------
    this.updateFlock(ctx, dt);

    // --- дробь ------------------------------------------------------------------
    this.hash.clear();
    for (const b of this.birds) if (b.alive) this.hash.insert(b);

    for (const p of this.pellets) {
      p.px = p.x; p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 260 * dt;           // лёгкая гравитация — дальние цели надо брать выше
      p.life -= dt;
      if (p.life <= 0) continue;

      // Непрерывная проверка попадания: дробь за кадр пролетает ~25 px,
      // мелкая птица радиусом 15 иначе проскочит насквозь.
      let hitSomething = false;
      this.hash.query(p.x, p.y, 40, (cand) => {
        if (hitSomething) return;
        const b = cand as Bird;
        if (!b.alive) return;
        if (segmentHitsCircle(p.px, p.py, p.x, p.y, b.x, b.y, b.r)) {
          hitSomething = true;
          this.damage(ctx, b);
        }
      });
      if (hitSomething) p.life = 0;
    }
    this.pellets = this.pellets.filter(p => p.life > 0 && p.y < ctx.h + 80);

    // --- волны ------------------------------------------------------------------
    const aliveCount = this.birds.reduce((n, b) => n + (b.alive ? 1 : 0), 0);
    this.waveTimer += dt;
    if (aliveCount === 0 || this.waveTimer > 12) {
      this.wave++;
      this.waveTimer = 0;
      this.birds = this.birds.filter(b => b.alive);
      this.timeLeft = Math.min(this.timeLeft + 6, 75);
      this.spawnWave(ctx);
    }

    r.camX = ctx.w / 2; r.camY = ctx.h / 2;
  }

  private fire(ctx: SceneContext) {
    this.ammo--;
    for (let i = 0; i < BirdHunt.PELLETS; i++) {
      // Разлёт: центральная дробина точная, остальные по гауссоподобному конусу.
      const spread = (this.rng() + this.rng() - 1) * BirdHunt.SPREAD * (i === 0 ? 0.15 : 1);
      // Дробь летит от низа экрана к прицелу — так читается перспектива.
      const ox = ctx.w / 2 + (this.rng() - 0.5) * 12;
      const oy = ctx.h + 30;
      let dx = this.aimX - ox, dy = this.aimY - oy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const ca = Math.cos(spread), sa = Math.sin(spread);
      const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
      this.pellets.push({
        x: ox, y: oy, px: ox, py: oy,
        vx: rx * BirdHunt.PELLET_SPEED,
        vy: ry * BirdHunt.PELLET_SPEED,
        life: 0.9,
      });
    }
    // Отдача подбрасывает прицел — стрелять очередями невыгодно.
    this.recoilKickY = -900;
    this.aimX += (this.rng() - 0.5) * 6;
    this.recoil = 1;
    ctx.r.addShake(5);
    ctx.audio.shot();
    ctx.input.vibrate(18);

    // паника: все птицы в радиусе слышат выстрел
    for (const b of this.birds) {
      if (!b.alive) continue;
      const d = Math.hypot(b.x - this.aimX, b.y - this.aimY);
      if (d < 260) b.panic = Math.max(b.panic, 1 - d / 260);
    }
  }

  private damage(ctx: SceneContext, b: Bird) {
    b.hp--;
    ctx.r.burst(b.x, b.y, 6, 140, '#ffd7a8', 0.35, 200);
    if (b.hp > 0) { ctx.audio.hit(); b.panic = 1; return; }

    b.alive = false;
    this.streak++;
    const bonus = 1 + Math.min(this.streak, 10) * 0.15;
    this.score += Math.round((b.kind === 1 ? 180 : b.kind === 2 ? 260 : 100) * bonus);
    ctx.save.coins += 1;
    ctx.r.burst(b.x, b.y, 22, 260, '#ff9f6b', 0.7, 420);
    ctx.audio.explode();
    ctx.input.vibrate(30);
  }

  /**
   * Правила стаи (упрощённые boids):
   *   separation — не слипаться
   *   alignment  — лететь как соседи
   *   cohesion   — держаться центра стаи
   *   panic      — резкий рывок от точки прицела
   * Соседей ищем через ту же хеш-сетку, что и коллизии.
   */
  private updateFlock(ctx: SceneContext, dt: number) {
    this.hash.clear();
    for (const b of this.birds) if (b.alive) this.hash.insert(b);

    for (const b of this.birds) {
      if (!b.alive) continue;
      let sx = 0, sy = 0, ax = 0, ay = 0, cx = 0, cy = 0, n = 0;

      this.hash.query(b.x, b.y, 110, (cand) => {
        const o = cand as Bird;
        if (o === b || !o.alive) return;
        const dx = o.x - b.x, dy = o.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 110 * 110 || d2 < 1e-3) return;
        sx -= dx / d2 * 900; sy -= dy / d2 * 900;
        ax += o.vx; ay += o.vy;
        cx += o.x; cy += o.y;
        n++;
      });

      if (n > 0) {
        b.vx += (sx + (ax / n - b.vx) * 0.6 + (cx / n - b.x) * 0.35) * dt;
        b.vy += (sy + (ay / n - b.vy) * 0.6 + (cy / n - b.y) * 0.35) * dt;
      }

      if (b.panic > 0.01) {
        const dx = b.x - this.aimX, dy = b.y - this.aimY;
        const d = Math.hypot(dx, dy) || 1;
        b.vx += (dx / d) * 900 * b.panic * dt;
        b.vy += (dy / d) * 900 * b.panic * dt - 220 * b.panic * dt; // вверх, к небу
        b.panic = damp(b.panic, 0, 0.5, dt);
      }

      // держим в вертикальных границах неба
      if (b.y < 40) b.vy += 400 * dt;
      if (b.y > ctx.h * 0.8) b.vy -= 400 * dt;

      const sp = Math.hypot(b.vx, b.vy);
      const maxSp = b.kind === 1 ? 420 : b.kind === 2 ? 170 : 300;
      if (sp > maxSp) { b.vx = b.vx / sp * maxSp; b.vy = b.vy / sp * maxSp; }

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.flap += dt * (8 + sp * 0.02);

      // улетела за экран — промах, серия рвётся
      if (b.x < -160 || b.x > ctx.w + 160) {
        b.alive = false;
        this.misses++;
        this.streak = 0;
      }
    }
  }

  render(ctx: SceneContext, _alpha: number) {
    const { r } = ctx;
    const g = r.ctx;

    // градиент неба
    const sky = g.createLinearGradient(0, 0, 0, ctx.h);
    sky.addColorStop(0, '#1b3b6f');
    sky.addColorStop(0.55, '#3f6fa8');
    sky.addColorStop(1, '#b98f5c');
    g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    g.fillStyle = sky;
    g.fillRect(0, 0, ctx.w, ctx.h);

    r.camera();
    g.translate(-ctx.w / 2, -ctx.h / 2);

    // кусты на переднем плане
    g.fillStyle = '#12301c';
    g.beginPath();
    g.moveTo(0, ctx.h);
    for (let x = 0; x <= ctx.w; x += 40) {
      g.lineTo(x, ctx.h - 60 - Math.sin(x * 0.03) * 22 - Math.cos(x * 0.011) * 14);
    }
    g.lineTo(ctx.w, ctx.h);
    g.closePath();
    g.fill();

    for (const b of this.birds) {
      if (!b.alive) continue;
      const wing = Math.sin(b.flap) * 0.9;
      g.save();
      g.translate(b.x, b.y);
      g.scale(Math.sign(b.vx) || 1, 1);
      g.fillStyle = b.kind === 2 ? '#2b2118' : b.kind === 1 ? '#4a2f5e' : '#23272e';
      g.beginPath();
      g.ellipse(0, 0, b.r, b.r * 0.6, 0, 0, TAU);
      g.fill();
      g.beginPath();
      g.moveTo(-2, -2);
      g.lineTo(-b.r * 1.5, -b.r * 1.4 * wing);
      g.lineTo(b.r * 0.4, -2);
      g.closePath();
      g.fill();
      g.restore();
    }

    for (const p of this.pellets) {
      g.strokeStyle = 'rgba(255,240,200,0.8)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(p.px, p.py);
      g.lineTo(p.x, p.y);
      g.stroke();
    }

    r.drawParticles();
    r.restore();

    // --- прицел ---------------------------------------------------------------
    r.ui();
    const spread = 18 + this.recoil * 26;
    g.strokeStyle = this.reloading > 0 ? 'rgba(255,120,120,0.9)' : 'rgba(255,255,255,0.92)';
    g.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      g.beginPath();
      g.moveTo(this.aimX + Math.cos(a) * spread, this.aimY + Math.sin(a) * spread);
      g.lineTo(this.aimX + Math.cos(a) * (spread + 10), this.aimY + Math.sin(a) * (spread + 10));
      g.stroke();
    }
    r.circle(this.aimX, this.aimY, 2.5, '#fff');

    // патроны
    for (let i = 0; i < this.maxAmmo; i++) {
      const x = 20 + i * 16;
      r.roundRect(x, ctx.h - 40, 10, 24, 3,
        i < this.ammo ? '#ffd166' : 'rgba(255,255,255,0.18)');
    }
    if (this.reloading > 0) {
      const t = 1 - this.reloading / BirdHunt.RELOAD_TIME;
      r.roundRect(20, ctx.h - 52, this.maxAmmo * 16 - 6, 5, 2, 'rgba(255,255,255,0.2)');
      r.roundRect(20, ctx.h - 52, (this.maxAmmo * 16 - 6) * t, 5, 2, '#7dffb0');
    }

    r.text(`${Math.floor(this.score)}`, 20, 34, 30, '#ffffff');
    r.text(`волна ${this.wave}`, 20, 62, 13, '#dfe9ff');
    if (this.streak > 1) r.text(`серия x${this.streak}`, 20, 84, 16, '#ffd166');
    r.text(`${this.timeLeft.toFixed(1)} с`, ctx.w - 20, 34, 22,
      this.timeLeft < 10 ? '#ff6b6b' : '#ffffff', 'right');
    r.text('удержать — перезарядка', ctx.w - 20, 60, 12, 'rgba(255,255,255,0.6)', 'right');

    r.restore();
    this.shell.render(ctx);
  }
}
