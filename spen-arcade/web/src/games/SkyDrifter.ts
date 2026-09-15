import { Scene, SceneContext } from '../core/Engine';
import { Shell } from '../core/Shell';
import { clamp, damp, fbm, lerp, makeNoise1D, makeRng, TAU } from '../core/math';

/** Смешение двух hex-цветов. Нужно для плавной смены времени суток. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(
    lerp((pa >> sh) & 255, (pb >> sh) & 255, t)
  );
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

interface Ring { x: number; y: number; r: number; taken: boolean; }
interface Rock { x: number; y: number; r: number; spin: number; }

/**
 * SKY DRIFTER — самолёт в процедурном каньоне.
 *
 * Управление:
 *   наклон пера влево/вправо  — крен, самолёт доворачивает
 *   наклон вперёд/назад       — тангаж (набор/снижение)
 *   кнопка стилуса            — форсаж (греется, нужен отпуск)
 *
 * Ключевая идея физики: наклон задаёт не позицию, а УГЛОВОЕ УСКОРЕНИЕ.
 * Позиционное управление ощущается как "мышь", инерционное — как полёт.
 */
export class SkyDrifter implements Scene {
  name = 'sky';

  private noiseTop = makeNoise1D(1);
  private noiseBot = makeNoise1D(2);
  private rng = makeRng(3);

  // самолёт
  private px = 0; private py = 0;
  private vx = 0; private vy = 0;
  private roll = 0;          // визуальный крен
  private heading = 0;       // направление носа, рад
  private speed = 0;
  private prevX = 0; private prevY = 0; // для интерполяции отрисовки

  private heat = 0;          // 0..1, форсаж
  private overheated = false;
  private shield = 0;

  private rings: Ring[] = [];
  private rocks: Rock[] = [];
  private distance = 0;
  private score = 0;
  private combo = 1;
  private comboTimer = 0;
  private alive = true;
  private deadTimer = 0;
  private spawnCursor = 0;
  /** Звёзды дальнего плана. Хранятся в мировых координатах и зацикливаются
   *  по мере полёта — так не нужен бесконечный массив. */
  private stars: { x: number; y: number; z: number }[] = [];
  private shell = new Shell('sky', () => this.restart());
  private ctxRef: SceneContext | null = null;

  /** Сколько мира впереди старта держим пустым, px. */
  private static readonly SAFE_ZONE = 900;

  private static readonly BASE_SPEED = 260;
  private static readonly BOOST_SPEED = 520;
  private static readonly VERT_ACCEL = 1000;  // px/с² при полном наклоне
  /** Насколько наклон вбок меняет ход относительно крейсерского. */
  private static readonly SPEED_RANGE = 170;
  private static readonly MIN_SPEED = 120;
  private static readonly SEG = 40;           // шаг сэмплирования каньона, px

  enter(ctx: SceneContext) {
    this.ctxRef = ctx;
    this.restart();
  }

  private restart() {
    const ctx = this.ctxRef!;
    const seed = (Date.now() & 0xffff) || 7;
    this.noiseTop = makeNoise1D(seed);
    this.noiseBot = makeNoise1D(seed ^ 0x9e37);
    this.rng = makeRng(seed);

    // Старт строго по центру коридора: раньше самолёт появлялся на y=0,
    // а коридор в этой точке мог быть смещён шумом — и раунд начинался
    // мгновенным ударом о скалу.
    this.px = 0;
    const start = this.corridor(0);
    this.py = (start.top + start.bottom) / 2;
    this.prevX = this.px; this.prevY = this.py;
    this.vx = SkyDrifter.BASE_SPEED; this.vy = 0;
    this.heading = 0; this.roll = 0; this.speed = SkyDrifter.BASE_SPEED;
    this.heat = 0; this.overheated = false; this.shield = 1.5;
    this.rings = []; this.rocks = [];
    this.stars = [];
    for (let i = 0; i < 140; i++) {
      this.stars.push({ x: this.rng() * 2400, y: (this.rng() * 2 - 1) * 900, z: 0.15 + this.rng() * 0.5 });
    }
    this.distance = 0; this.score = 0; this.combo = 1; this.comboTimer = 0;
    this.alive = true; this.deadTimer = 0; this.spawnCursor = 0;

    ctx.r.camX = this.px;
    ctx.r.camY = this.py;
    ctx.r.camZoom = 1;
    this.shell.begin(ctx);
  }

  /** Границы каньона в мировой точке x. Ширина сужается с дистанцией. */
  private corridor(x: number): { top: number; bottom: number } {
    const s = x * 0.0016;
    const mid = fbm(this.noiseTop, s, 4) * 220;
    const tighten = clamp(1 - x / 60000, 0.42, 1);      // к 60 км коридор вдвое уже
    const halfWidth = (200 + fbm(this.noiseBot, s * 1.7 + 50, 3) * 80) * tighten;
    return { top: mid - halfWidth, bottom: mid + halfWidth };
  }

  update(ctx: SceneContext, dt: number) {
    this.ctxRef = ctx;
    if (!this.shell.update(ctx, dt)) return;
    const { pen, r, audio } = ctx;

    if (!this.alive) {
      this.deadTimer += dt;
      r.camZoom = damp(r.camZoom, 1.6, 0.4, dt);
      if (this.deadTimer > 1.4) {
        this.shell.finish(ctx, {
          title: 'РАЗБИЛСЯ',
          score: this.score,
          note: `${(this.distance / 1000).toFixed(2)} км пройдено`,
        });
      }
      return;
    }

    this.prevX = this.px; this.prevY = this.py;

    // --- форсаж с перегревом ---------------------------------------------
    const wantBoost = pen.button && !this.overheated;
    if (wantBoost) {
      this.heat = clamp(this.heat + dt * 0.42, 0, 1);
      if (this.heat >= 1) { this.overheated = true; audio.fail(); r.addShake(6); }
    } else {
      this.heat = clamp(this.heat - dt * 0.30, 0, 1);
      if (this.overheated && this.heat < 0.25) this.overheated = false;
    }
    // --- управление --------------------------------------------------------
    //
    // Две оси разведены честно:
    //   наклон вперёд/назад — нос вверх и вниз;
    //   наклон влево/вправо — ход вперёд и назад, самолёт ездит по экрану.
    //
    // Раньше tiltX крутил heading, а синус heading прибавлялся к вертикальной
    // скорости — из-за чего наклон вбок поднимал машину, а горизонтального
    // управления не было вовсе: скорость держалась константой.
    const tiltY = pen.tiltY;

    // Вертикаль: наклон задаёт ускорение, не позицию — так чувствуется полёт.
    this.vy += tiltY * SkyDrifter.VERT_ACCEL * dt;
    this.vy = damp(this.vy, this.vy * 0.88, 0.32, dt);
    this.vy = clamp(this.vy, -640, 640);

    // Горизонталь: наклон вбок сдвигает целевую скорость относительно потока.
    const cruise = wantBoost ? SkyDrifter.BOOST_SPEED : SkyDrifter.BASE_SPEED;
    const target = cruise + pen.tiltX * SkyDrifter.SPEED_RANGE;
    this.speed = damp(this.speed, target, wantBoost ? 0.16 : 0.26, dt);
    this.speed = clamp(this.speed, SkyDrifter.MIN_SPEED, SkyDrifter.BOOST_SPEED * 1.15);
    this.vx = this.speed;

    this.px += this.vx * dt;
    this.py += this.vy * dt;
    this.distance = this.px;

    // Нос смотрит туда, куда самолёт реально летит.
    this.heading = damp(this.heading, Math.atan2(this.vy, this.vx), 0.07, dt);

    this.roll = damp(this.roll, pen.tiltX * 0.7, 0.1, dt);

    // --- мир ---------------------------------------------------------------
    this.generateAhead(ctx);
    this.cull();

    // выхлоп
    if (wantBoost) {
      const a = this.heading + Math.PI;
      r.spawn(this.px + Math.cos(a) * 18, this.py + Math.sin(a) * 18,
        Math.cos(a) * 180 + (this.rng() - 0.5) * 60, Math.sin(a) * 180 + (this.rng() - 0.5) * 60,
        0.35, 4, this.heat > 0.7 ? '#ff5a3c' : '#5ad2ff', { drag: 2.4 });
    }

    // --- столкновения -------------------------------------------------------
    const c = this.corridor(this.px);
    const margin = 14;
    if (this.py - margin < c.top || this.py + margin > c.bottom) {
      this.crash(ctx, 'СТЕНА КАНЬОНА');
      return;
    }

    for (const rock of this.rocks) {
      const dx = rock.x - this.px, dy = rock.y - this.py;
      if (dx * dx + dy * dy < (rock.r + 13) * (rock.r + 13)) {
        if (this.shield > 0) {
          this.shield = 0;
          rock.r = -1;
          r.burst(rock.x, rock.y, 26, 320, '#8fd6ff', 0.7);
          r.addShake(12); audio.explode();
        } else {
          this.crash(ctx, 'СТОЛКНОВЕНИЕ');
          return;
        }
      }
    }
    this.rocks = this.rocks.filter(rk => rk.r > 0);

    for (const ring of this.rings) {
      if (ring.taken) continue;
      const dx = ring.x - this.px, dy = ring.y - this.py;
      if (Math.abs(dx) < 16 && Math.abs(dy) < ring.r) {
        ring.taken = true;
        this.combo = Math.min(this.combo + 1, 12);
        this.comboTimer = 3.2;
        this.score += 50 * this.combo;
        ctx.save.coins += 1;
        audio.pickup();
        r.popup(ring.x, ring.y - 20, `+${50 * this.combo}`, '#ffd166');
        r.burst(ring.x, ring.y, 14, 220, '#ffd166', 0.5);
        ctx.input.vibrate(12);
      }
    }

    this.comboTimer -= dt;
    if (this.comboTimer <= 0 && this.combo > 1) { this.combo = 1; }

    this.score += this.speed * dt * 0.08;
    this.shield = Math.max(0, this.shield - dt * 0);

    // камера ведёт с опережением по курсу — игрок видит, куда летит
    r.camX = damp(r.camX, this.px + 180 + this.speed * 0.30, 0.16, dt);
    r.camY = damp(r.camY, this.py + this.vy * 0.18, 0.14, dt);
    r.camZoom = damp(r.camZoom, wantBoost ? 0.88 : 1, 0.3, dt);
    r.camRot = damp(r.camRot, this.roll * 0.05, 0.2, dt);
  }

  private crash(ctx: SceneContext, _reason: string) {
    this.alive = false;
    ctx.r.burst(this.px, this.py, 70, 520, '#ff6b4a', 1.1, 220);
    ctx.r.addShake(26);
    ctx.r.flash('#ff8a5c', 0.6);
    ctx.audio.explode();
    ctx.input.vibrate(120);
  }

  /** Генерируем контент только впереди камеры — мир бесконечный. */
  private generateAhead(ctx: SceneContext) {
    const horizon = this.px + ctx.w * 1.6;
    while (this.spawnCursor < horizon) {
      this.spawnCursor += 160;
      const x = this.spawnCursor;
      const c = this.corridor(x);
      const h = c.bottom - c.top;

      if (this.rng() < 0.55) {
        const r = clamp(h * 0.16, 26, 54);
        const y = lerp(c.top + r + 10, c.bottom - r - 10, this.rng());
        this.rings.push({ x, y, r, taken: false });
      }
      // В стартовой зоне препятствий нет: игрок должен успеть взять перо
      // и понять, куда летит, прежде чем появится первый камень.
      if (x < SkyDrifter.SAFE_ZONE) continue;

      // Плотность камней растёт с дистанцией — естественная кривая сложности.
      const rockChance = clamp(0.18 + x / 90000, 0.18, 0.72);
      if (this.rng() < rockChance) {
        const rr = 14 + this.rng() * 26;
        const y = lerp(c.top + rr + 8, c.bottom - rr - 8, this.rng());
        this.rocks.push({ x, y, r: rr, spin: this.rng() * TAU });
      }
    }
  }

  private cull() {
    const behind = this.px - 400;
    if (this.rings.length && this.rings[0].x < behind) this.rings = this.rings.filter(r => r.x >= behind);
    if (this.rocks.length && this.rocks[0].x < behind) this.rocks = this.rocks.filter(r => r.x >= behind);
  }

  render(ctx: SceneContext, alpha: number) {
    const { r } = ctx;
    const g = r.ctx;

    // Небо теплеет с дистанцией: полёт из ночи в рассвет читается как прогресс.
    const dayT = clamp(this.distance / 45000, 0, 1);
    const sky = g.createLinearGradient(0, 0, 0, ctx.h);
    sky.addColorStop(0, mix('#05070f', '#2a1c4a', dayT));
    sky.addColorStop(0.6, mix('#0a1024', '#6b3b6e', dayT));
    sky.addColorStop(1, mix('#111a3a', '#c9724a', dayT));
    g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    g.fillStyle = sky;
    g.fillRect(0, 0, ctx.w, ctx.h);

    // Звёзды: собственный параллакс, гаснут к рассвету.
    g.globalAlpha = 0.7 * (1 - dayT * 0.75);
    g.fillStyle = '#ffffff';
    for (const st of this.stars) {
      const sx = ((st.x - r.camX * st.z) % 2400 + 2400) % 2400 - 400;
      const sy = ctx.h / 2 + st.y * 0.35 - r.camY * st.z * 0.25;
      if (sy < -10 || sy > ctx.h + 10) continue;
      const size = st.z * 2.4;
      g.fillRect(sx, sy, size, size);
    }
    g.globalAlpha = 1;

    r.camera();

    const left = r.camX - ctx.w / r.camZoom;
    const right = r.camX + ctx.w / r.camZoom;

    // параллакс-слои дальних скал
    for (let layer = 0; layer < 2; layer++) {
      const k = 0.35 + layer * 0.3;
      g.beginPath();
      g.moveTo(left, -4000);
      for (let x = left; x < right; x += SkyDrifter.SEG * 2) {
        const c = this.corridor(x * k + this.px * (1 - k));
        g.lineTo(x, c.top * k - 60 * layer);
      }
      g.lineTo(right, -4000);
      g.closePath();
      g.fillStyle = layer === 0 ? '#0d1430' : '#121c44';
      g.fill();
    }

    // сам коридор
    g.beginPath();
    g.moveTo(left, -6000);
    for (let x = left; x < right; x += SkyDrifter.SEG) g.lineTo(x, this.corridor(x).top);
    g.lineTo(right, -6000);
    g.closePath();
    g.fillStyle = '#1b2b5e';
    g.fill();

    g.beginPath();
    g.moveTo(left, 6000);
    for (let x = left; x < right; x += SkyDrifter.SEG) g.lineTo(x, this.corridor(x).bottom);
    g.lineTo(right, 6000);
    g.closePath();
    g.fill();

    for (const ring of this.rings) {
      if (ring.taken) continue;
      const pulse = 0.75 + Math.sin(this.distance * 0.01 + ring.y) * 0.25;
      g.strokeStyle = '#ffd166';
      g.globalAlpha = 0.25 * pulse;
      g.lineWidth = 12;
      g.beginPath();
      g.ellipse(ring.x, ring.y, 10, ring.r, 0, 0, TAU);
      g.stroke();
      g.globalAlpha = 0.95;
      g.lineWidth = 3;
      g.beginPath();
      g.ellipse(ring.x, ring.y, 10, ring.r, 0, 0, TAU);
      g.stroke();
      g.globalAlpha = 1;
    }

    for (const rock of this.rocks) {
      g.save();
      g.translate(rock.x, rock.y);
      g.rotate(rock.spin);
      g.fillStyle = '#5b6ea8';
      g.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU;
        const rr = rock.r * (0.78 + ((i * 37) % 11) / 34);
        g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      g.restore();
    }

    r.drawParticles();
    r.drawPopups();

    // Скоростные штрихи: чем быстрее, тем гуще — ход читается телом.
    const over = (this.speed - SkyDrifter.BASE_SPEED) /
                 (SkyDrifter.BOOST_SPEED - SkyDrifter.BASE_SPEED);
    if (over > 0.15) {
      g.strokeStyle = `rgba(190,225,255,${clamp(over * 0.35, 0, 0.35)})`;
      g.lineWidth = 2;
      for (let i = 0; i < 16; i++) {
        const sy = this.py + ((i * 137) % 700) - 350;
        const sx = this.px + 260 - ((this.px * 1.4 + i * 211) % 900);
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(sx - 40 - over * 70, sy);
        g.stroke();
      }
    }

    if (this.alive) {
      const ix = lerp(this.prevX, this.px, alpha);
      const iy = lerp(this.prevY, this.py, alpha);
      g.save();
      g.translate(ix, iy);
      g.rotate(this.heading);
      g.scale(1, Math.cos(this.roll * 0.8));   // крен как сжатие силуэта
      // Свечение сопла тем ярче, чем выше ход
      const glow = clamp(over, 0, 1);
      if (glow > 0.05) {
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(90,210,255,${glow * 0.5})`;
        g.beginPath();
        g.arc(-14, 0, 10 + glow * 12, 0, TAU);
        g.fill();
        g.globalCompositeOperation = 'source-over';
      }
      g.fillStyle = '#e9f2ff';
      g.beginPath();
      g.moveTo(22, 0); g.lineTo(-14, -11); g.lineTo(-7, 0); g.lineTo(-14, 11);
      g.closePath();
      g.fill();
      g.fillStyle = '#5ad2ff';
      g.beginPath();
      g.moveTo(8, 0); g.lineTo(-6, -4); g.lineTo(-6, 4);
      g.closePath();
      g.fill();
      if (this.shield > 0) {
        g.strokeStyle = 'rgba(140,220,255,0.75)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(0, 0, 24, 0, TAU); g.stroke();
      }
      g.restore();
    }

    r.restore();
    this.hud(ctx);
  }

  private hud(ctx: SceneContext) {
    const { r } = ctx;
    r.ui();
    r.text(`${Math.floor(this.score)}`, 20, 34, 30, '#ffffff');
    r.text(`${(this.distance / 1000).toFixed(2)} км`, 20, 64, 14, '#8fa5d8');
    if (this.combo > 1) r.text(`x${this.combo}`, 20, 90, 20, '#ffd166');

    // шкала перегрева
    const bw = 130, bh = 8, bx = ctx.w - bw - 82, by = 26;
    r.roundRect(bx, by, bw, bh, 4, 'rgba(255,255,255,0.15)');
    r.roundRect(bx, by, bw * this.heat, bh, 4, this.overheated ? '#ff4d4d' : '#5ad2ff');
    r.text(this.overheated ? 'ПЕРЕГРЕВ' : 'ФОРСАЖ', ctx.w - 82, 50, 12,
      this.overheated ? '#ff8080' : '#7fb6ff', 'right');

    r.restore();
    this.shell.render(ctx);
  }
}
