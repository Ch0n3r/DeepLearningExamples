import { Scene, SceneContext, persist } from '../core/Engine';
import { Shell } from '../core/Shell';
import { clamp, damp, fbm, lerp, makeNoise1D, makeRng, TAU } from '../core/math';

interface TrackPoint { x: number; y: number; nx: number; ny: number; width: number; }

/**
 * Пресет трассы. Форма задаётся не только seed'ом: радиус, сжатие и размах
 * шума меняют характер круга сильнее, чем другое зерно того же шума.
 */
interface TrackPreset {
  name: string;
  seed: number;
  radius: number;
  aspect: number;   // сжатие по вертикали
  wobble: number;   // насколько шум гнёт радиус
  width: number;    // базовая ширина полотна
  cones: number;    // плотность конусов
}
interface Cone { x: number; y: number; hit: boolean; }
interface Gate { x: number; y: number; nx: number; ny: number; w: number; passed: boolean; }

/**
 * TILT RACER — вид сверху, процедурная трасса, дрифтовая физика.
 *
 * Управление:
 *   наклон влево/вправо — руль
 *   наклон вперёд       — газ (сильнее наклон = больше тяга)
 *   наклон назад        — тормоз
 *   кнопка стилуса      — ручник: срывает заднюю ось в занос
 *
 * Физика: модель с раздельным трением вдоль/поперёк оси машины.
 * Именно разное трение по двум осям и даёт дрифт — без неё машина
 * ездит "как мышка" и управление наклоном ощущается плоско.
 */
export class TiltRacer implements Scene {
  name = 'race';

  private track: TrackPoint[] = [];
  private cones: Cone[] = [];
  private gates: Gate[] = [];
  private noise = makeNoise1D(11);
  private rng = makeRng(11);

  private x = 0; private y = 0;
  private prevX = 0; private prevY = 0;
  private vx = 0; private vy = 0;
  private heading = -Math.PI / 2;
  private angVel = 0;
  private drift = 0;          // 0..1 — насколько машина в заносе
  private nearest = 0;        // индекс ближайшей точки трассы

  private time = 0;
  private score = 0;
  private combo = 0;
  private best = 0;
  private finished = false;
  private timeLeft = 45;
  /** Следы шин. Кольцевой буфер: держим последние N отрезков и затираем
   *  старые, иначе за минуту дрифта массив разрастётся до десятков тысяч. */
  /**
   * Положение «рычагов»: руль и педаль держатся там, куда их поставили.
   *
   * Наклон здесь НЕ самоцентрируется. Канал tiltX/tiltY утекает к нулю —
   * это правильно для самолёта, но рулю противопоказано: держишь перо
   * повёрнутым, а колёса сами возвращаются прямо. Поэтому оба рычага
   * набираются из покадровых дельт и остаются в заданном положении.
   */
  private steer = 0;
  private pedal = 0;

  private skid: { x: number; y: number; a: number; w: number }[] = [];
  private static readonly MAX_SKID = 260;
  private shell = new Shell('race', () => this.restart());
  private ctxRef: SceneContext | null = null;

  private static readonly ENGINE = 900;
  private static readonly REVERSE = 420;
  private static readonly BRAKE = 1700;
  private static readonly STEER = 2.0;
  /** Потолок хода. Без него дрифт на длинной прямой разгонял до неуправляемого. */
  private static readonly MAX_SPEED = 400;
  private static readonly MAX_REVERSE = 150;
  /** Во сколько единиц руля превращается единичная дельта пера. */
  private static readonly STEER_GAIN = 2.6;
  private static readonly PEDAL_GAIN = 2.6;
  /** Ниже этого хода тормоз превращается в задний ход. */
  private static readonly REVERSE_THRESHOLD = 24;
  private static readonly GRIP_FWD = 0.02;   // сопротивление вдоль корпуса (мало)
  private static readonly GRIP_SIDE = 7.5;   // поперёк (много = держит дорогу)
  private static readonly GRIP_SIDE_DRIFT = 1.4;
  private static readonly SEGMENTS = 900;

  private static readonly TRACKS: TrackPreset[] = [
    { name: 'КОЛЬЦО',   seed: 101, radius: 1400, aspect: 0.78, wobble: 520, width: 150, cones: 0.35 },
    { name: 'СЕРПАНТИН', seed: 202, radius: 1250, aspect: 0.92, wobble: 820, width: 125, cones: 0.5 },
    { name: 'ОВАЛ',     seed: 303, radius: 1600, aspect: 0.55, wobble: 240, width: 175, cones: 0.25 },
    { name: 'УЗЛЫ',     seed: 404, radius: 1320, aspect: 0.85, wobble: 980, width: 115, cones: 0.6 },
    { name: 'ДЛИННАЯ',  seed: 505, radius: 1750, aspect: 0.7,  wobble: 430, width: 160, cones: 0.4 },
  ];

  private preset: TrackPreset = TiltRacer.TRACKS[0];

  enter(ctx: SceneContext) {
    this.ctxRef = ctx;
    this.restart();
  }

  private restart() {
    const ctx = this.ctxRef!;
    // Трассы идут по кругу: каждый заезд — следующая, выбор запоминается.
    const idx = ((ctx.save.trackIndex ?? 0) % TiltRacer.TRACKS.length + TiltRacer.TRACKS.length)
                % TiltRacer.TRACKS.length;
    this.preset = TiltRacer.TRACKS[idx];
    ctx.save.trackIndex = (idx + 1) % TiltRacer.TRACKS.length;
    persist(ctx.save);

    this.noise = makeNoise1D(this.preset.seed);
    this.rng = makeRng(this.preset.seed);
    this.buildTrack();

    const p = this.track[0];
    this.x = p.x; this.y = p.y;
    this.prevX = p.x; this.prevY = p.y;
    this.vx = 0; this.vy = 0;
    this.heading = Math.atan2(this.track[1].y - p.y, this.track[1].x - p.x);
    this.angVel = 0; this.drift = 0; this.nearest = 0;
    this.skid = [];
    this.steer = 0; this.pedal = 0;
    this.time = 0; this.score = 0; this.combo = 0; this.finished = false;
    this.timeLeft = 45;
    this.best = ctx.save.best[this.name] ?? 0;
    ctx.r.camX = this.x;
    ctx.r.camY = this.y;
    this.shell.begin(ctx);
  }

  /**
   * Трасса — замкнутая петля: радиус модулируется fbm-шумом по углу.
   * Замыкание делаем честно: шум сэмплируем по окружности (cos/sin угла),
   * поэтому начало и конец сходятся без шва.
   */
  private buildTrack() {
    this.track = [];
    this.cones = [];
    this.gates = [];
    const n = TiltRacer.SEGMENTS;
    const pts: { x: number; y: number; width: number }[] = [];

    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      // периодический шум: два независимых fbm по cos и sin
      const wob = fbm(this.noise, Math.cos(a) * 3 + 10, 4) * 0.55
                + fbm(this.noise, Math.sin(a) * 3 + 40, 3) * 0.45;
      const radius = this.preset.radius + wob * this.preset.wobble;
      const width = this.preset.width + fbm(this.noise, Math.cos(a) * 5 + 90, 2) * 45;
      pts.push({
        x: Math.cos(a) * radius,
        y: Math.sin(a) * radius * this.preset.aspect,
        width,
      });
    }

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const nx1 = pts[(i + 1) % n];
      const np1 = pts[(i - 1 + n) % n];
      let tx = nx1.x - np1.x, ty = nx1.y - np1.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len; ty /= len;
      this.track.push({ x: p.x, y: p.y, nx: -ty, ny: tx, width: p.width });
    }

    for (let i = 0; i < n; i += 9) {
      // Первые сегменты оставляем чистыми: машина стартует в track[0],
      // и конус рядом означал бы штраф ещё до первого поворота.
      if (i < 40) continue;
      const t = this.track[i];
      if (this.rng() < this.preset.cones) {
        const off = (this.rng() * 2 - 1) * (t.width * 0.72);
        this.cones.push({ x: t.x + t.nx * off, y: t.y + t.ny * off, hit: false });
      }
    }
    for (let i = 0; i < n; i += 45) {
      const t = this.track[i];
      this.gates.push({ x: t.x, y: t.y, nx: t.nx, ny: t.ny, w: t.width, passed: false });
    }
  }

  /** Ищем ближайшую точку трассы инкрементально — полный поиск по 900 точкам
   *  каждый кадр не нужен, машина не телепортируется. */
  private updateNearest() {
    const n = this.track.length;
    let bestI = this.nearest;
    let bestD = Infinity;
    for (let k = -12; k <= 40; k++) {
      const i = (this.nearest + k + n) % n;
      const t = this.track[i];
      const d = (t.x - this.x) ** 2 + (t.y - this.y) ** 2;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    this.nearest = bestI;
    return Math.sqrt(bestD);
  }

  update(ctx: SceneContext, dt: number) {
    this.ctxRef = ctx;
    if (!this.shell.update(ctx, dt)) return;
    const { pen, r, audio } = ctx;

    if (this.finished) {
      r.camZoom = damp(r.camZoom, 0.55, 0.5, dt);
      this.time += dt;
      if (this.time > 1.2) {
        this.shell.finish(ctx, { title: 'ВРЕМЯ ВЫШЛО', score: this.score });
      }
      return;
    }

    this.prevX = this.x; this.prevY = this.y;
    this.time += dt;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.finish(ctx); return; }

    // --- рычаги ---------------------------------------------------------------
    const { dx, dy } = ctx.input.consumeDelta();
    const sens = ctx.input.sensitivity;
    this.steer = clamp(this.steer + dx * TiltRacer.STEER_GAIN * sens, -1, 1);
    // Вертикальная дельта пера растёт вверх, а газ должен быть «вниз».
    this.pedal = clamp(this.pedal - dy * TiltRacer.PEDAL_GAIN * sens, -1, 1);

    const throttle = clamp(this.pedal, 0, 1);
    const brake = clamp(-this.pedal, 0, 1);
    const handbrake = pen.button;

    // --- ориентация ---------------------------------------------------------
    const fwdSpeed = this.vx * Math.cos(this.heading) + this.vy * Math.sin(this.heading);
    // Руль работает только на ходу: стоящая машина не вращается на месте.
    const steerAuth = clamp(Math.abs(fwdSpeed) / 220, 0, 1);
    const steerTarget = this.steer * TiltRacer.STEER * steerAuth * Math.sign(fwdSpeed || 1);
    this.angVel = damp(this.angVel, steerTarget, handbrake ? 0.05 : 0.10, dt);
    this.heading += this.angVel * dt;

    // --- тяга ----------------------------------------------------------------
    const cs = Math.cos(this.heading), sn = Math.sin(this.heading);
    this.vx += cs * throttle * TiltRacer.ENGINE * dt;
    this.vy += sn * throttle * TiltRacer.ENGINE * dt;

    if (brake > 0.02) {
      if (fwdSpeed > TiltRacer.REVERSE_THRESHOLD) {
        // Пока катимся вперёд — это тормоз.
        const sp = Math.hypot(this.vx, this.vy);
        if (sp > 1) {
          const dec = Math.min(sp, brake * TiltRacer.BRAKE * dt);
          this.vx -= (this.vx / sp) * dec;
          this.vy -= (this.vy / sp) * dec;
        }
      } else {
        // Почти встали — тот же наклон включает заднюю передачу.
        this.vx -= cs * brake * TiltRacer.REVERSE * dt;
        this.vy -= sn * brake * TiltRacer.REVERSE * dt;
      }
    }

    // Потолок скорости, отдельный для переднего и заднего хода.
    {
      const sp = Math.hypot(this.vx, this.vy);
      const cap = fwdSpeed < -1 ? TiltRacer.MAX_REVERSE : TiltRacer.MAX_SPEED;
      if (sp > cap) { this.vx = this.vx / sp * cap; this.vy = this.vy / sp * cap; }
    }

    // --- разложение скорости на продольную и поперечную -----------------------
    let vForward = this.vx * cs + this.vy * sn;
    let vLateral = -this.vx * sn + this.vy * cs;

    const gripSide = handbrake ? TiltRacer.GRIP_SIDE_DRIFT : TiltRacer.GRIP_SIDE;
    vForward *= Math.exp(-TiltRacer.GRIP_FWD * dt * 60 * 0.016);
    vLateral *= Math.exp(-gripSide * dt);  // вот здесь и рождается занос

    this.vx = vForward * cs - vLateral * sn;
    this.vy = vForward * sn + vLateral * cs;

    const speed = Math.hypot(this.vx, this.vy);
    this.drift = damp(this.drift, clamp(Math.abs(vLateral) / 180, 0, 1), 0.12, dt);

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // --- трасса, трава, коллизии ---------------------------------------------
    const dist = this.updateNearest();
    const t = this.track[this.nearest];
    const onTrack = dist < t.width;
    if (!onTrack) {
      // Съезд на обочину — резкая потеря скорости, а не мгновенный конец.
      const over = clamp((dist - t.width) / 120, 0, 1);
      this.vx *= Math.exp(-3.4 * over * dt * 8);
      this.vy *= Math.exp(-3.4 * over * dt * 8);
      this.combo = 0;
      if (speed > 200 && Math.random() < 0.4) {
        r.spawn(this.x, this.y, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120,
          0.5, 3, '#6d5a3a', { additive: false });
      }
    }

    // следы: кладём, пока машину тащит боком
    if (this.drift > 0.3 && speed > 200) {
      this.skid.push({ x: this.x, y: this.y, a: this.heading, w: this.drift });
      if (this.skid.length > TiltRacer.MAX_SKID) this.skid.shift();
    }

    // очки за дрифт: чем быстрее и боком — тем больше
    if (this.drift > 0.35 && speed > 250) {
      this.score += this.drift * speed * dt * 0.09 * (1 + this.combo * 0.12);
      if (Math.random() < 0.7) {
        r.spawn(this.x - cs * 16, this.y - sn * 16,
          -this.vx * 0.12 + (Math.random() - 0.5) * 60,
          -this.vy * 0.12 + (Math.random() - 0.5) * 60,
          0.8, 5, 'rgba(180,180,190,1)', { drag: 1.2, additive: false });
      }
    }

    for (const cone of this.cones) {
      if (cone.hit) continue;
      if ((cone.x - this.x) ** 2 + (cone.y - this.y) ** 2 < 26 * 26) {
        cone.hit = true;
        this.combo = 0;
        this.score = Math.max(0, this.score - 120);
        r.burst(cone.x, cone.y, 12, 180, '#ff8a3c', 0.5);
        r.addShake(7);
        audio.hit();
        ctx.input.vibrate(25);
      }
    }

    for (const gate of this.gates) {
      if (gate.passed) continue;
      const dx = this.x - gate.x, dy = this.y - gate.y;
      const along = dx * gate.ny * -1 + dy * gate.nx; // проекция на касательную
      const across = dx * gate.nx + dy * gate.ny;
      if (Math.abs(along) < 30 && Math.abs(across) < gate.w) {
        gate.passed = true;
        this.combo++;
        this.timeLeft = Math.min(this.timeLeft + 4.5, 60);
        this.score += 300 + this.combo * 60;
        ctx.save.coins += 2;
        audio.pickup();
        r.popup(gate.x, gate.y - 24, `+${300 + this.combo * 60}`, '#7dffb0');
        r.flash('#7dffb0', 0.15);
        ctx.input.vibrate(15);
      }
    }

    // камера: центр смещён по вектору скорости + зум от скорости
    r.camX = damp(r.camX, this.x + this.vx * 0.32, 0.14, dt);
    r.camY = damp(r.camY, this.y + this.vy * 0.32, 0.14, dt);
    r.camZoom = damp(r.camZoom, clamp(0.85 - speed / 5200, 0.55, 0.85), 0.35, dt);
    r.camRot = damp(r.camRot, -this.angVel * 0.035, 0.25, dt);
  }

  private finish(ctx: SceneContext) {
    this.finished = true;
    this.time = 0;
    ctx.audio.fail();
  }

  render(ctx: SceneContext, alpha: number) {
    const { r } = ctx;
    const g = r.ctx;
    r.clear('#0a1409');

    r.camera();

    // полотно трассы одним полигоном: левый край вперёд, правый — назад
    g.beginPath();
    for (let i = 0; i < this.track.length; i++) {
      const t = this.track[i];
      const px = t.x + t.nx * t.width, py = t.y + t.ny * t.width;
      i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
    }
    for (let i = this.track.length - 1; i >= 0; i--) {
      const t = this.track[i];
      g.lineTo(t.x - t.nx * t.width, t.y - t.ny * t.width);
    }
    g.closePath();
    g.fillStyle = '#23252c';
    g.fill();

    // осевая разметка
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 3;
    g.setLineDash([26, 30]);
    g.beginPath();
    for (let i = 0; i < this.track.length; i += 2) {
      const t = this.track[i];
      i === 0 ? g.moveTo(t.x, t.y) : g.lineTo(t.x, t.y);
    }
    g.closePath();
    g.stroke();
    g.setLineDash([]);

    // следы шин ложатся на полотно, до конусов и ворот
    g.lineCap = 'round';
    for (let i = 0; i < this.skid.length; i++) {
      const sk = this.skid[i];
      const fade = (i / this.skid.length) * 0.45;
      g.strokeStyle = `rgba(20,20,24,${fade * sk.w})`;
      g.lineWidth = 6;
      const nx = Math.cos(sk.a + Math.PI / 2) * 9;
      const ny = Math.sin(sk.a + Math.PI / 2) * 9;
      g.beginPath();
      g.moveTo(sk.x + nx, sk.y + ny);
      g.lineTo(sk.x + nx - Math.cos(sk.a) * 10, sk.y + ny - Math.sin(sk.a) * 10);
      g.moveTo(sk.x - nx, sk.y - ny);
      g.lineTo(sk.x - nx - Math.cos(sk.a) * 10, sk.y - ny - Math.sin(sk.a) * 10);
      g.stroke();
    }

    for (const gate of this.gates) {
      if (gate.passed) continue;
      g.strokeStyle = '#7dffb0';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(gate.x + gate.nx * gate.w, gate.y + gate.ny * gate.w);
      g.lineTo(gate.x - gate.nx * gate.w, gate.y - gate.ny * gate.w);
      g.stroke();
    }

    for (const cone of this.cones) {
      if (cone.hit) continue;
      r.circle(cone.x, cone.y, 8, '#ff8a3c');
    }

    r.drawParticles();
    r.drawPopups();

    const ix = lerp(this.prevX, this.x, alpha);
    const iy = lerp(this.prevY, this.y, alpha);
    g.save();
    g.translate(ix, iy);
    g.rotate(this.heading);
    // колёса: передние доворачиваются вслед за рулём
    g.fillStyle = '#15161c';
    g.fillRect(-14, -14, 9, 5);
    g.fillRect(-14, 9, 9, 5);
    const wa = this.steer * 0.5;
    for (const wy of [-11.5, 11.5]) {
      g.save();
      g.translate(11.5, wy);
      g.rotate(wa);
      g.fillRect(-4.5, -2.5, 9, 5);
      g.restore();
    }
    // кузов
    g.fillStyle = this.drift > 0.4 ? '#ffd166' : '#e9f2ff';
    r.roundRect(-18, -11, 36, 22, 5, this.drift > 0.4 ? '#ffd166' : '#e9f2ff');
    // стекло и фары
    g.fillStyle = '#121a2e';
    r.roundRect(-3, -8, 11, 16, 3, '#121a2e');
    g.fillStyle = 'rgba(255,240,190,0.9)';
    g.fillRect(16, -8, 3, 5);
    g.fillRect(16, 3, 3, 5);
    g.restore();

    r.restore();

    r.ui();
    r.text(`${Math.floor(this.score)}`, 20, 34, 30, '#ffffff');
    r.text(`рекорд ${this.best}`, 20, 62, 13, '#7f93b8');
    const sp = Math.hypot(this.vx, this.vy) * 0.45;
    r.text(`${Math.round(sp)} км/ч`, ctx.w - 82, 30, 22, '#8fd6ff', 'right');
    r.text(`${this.timeLeft.toFixed(1)} с`, ctx.w - 82, 58, 18,
      this.timeLeft < 8 ? '#ff6b6b' : '#cfe0ff', 'right');
    if (this.combo > 1) r.text(`ворота x${this.combo}`, ctx.w / 2, 34, 18, '#7dffb0', 'center');
    r.text(this.preset.name, 20, 84, 13, '#8fa5d8');

    // Передача: задний ход надо видеть, иначе непонятно, почему едешь назад.
    const fwd = this.vx * Math.cos(this.heading) + this.vy * Math.sin(this.heading);
    if (fwd < -4) r.text('ЗАДНИЙ ХОД', ctx.w / 2, ctx.h - 66, 16, '#ff9f6b', 'center');

    // Положение рычагов: они не самоцентрируются, поэтому игрок должен
    // видеть, где они стоят, — иначе легко потерять ноль.
    const gx = 20, gy = ctx.h - 44, gw = 120;
    r.roundRect(gx, gy, gw, 6, 3, 'rgba(255,255,255,0.16)');
    r.roundRect(gx + gw / 2 - 2 + this.steer * (gw / 2 - 2), gy - 2, 4, 10, 2, '#5ad2ff');
    r.text('руль', gx + gw + 10, gy + 3, 11, '#7f93b8');

    r.roundRect(gx, gy + 16, gw, 6, 3, 'rgba(255,255,255,0.16)');
    r.roundRect(gx + gw / 2 - 2 + this.pedal * (gw / 2 - 2), gy + 14, 4, 10, 2,
      this.pedal >= 0 ? '#7dffb0' : '#ff8a5c');
    r.text(this.pedal >= 0 ? 'газ' : 'тормоз', gx + gw + 10, gy + 19, 11, '#7f93b8');
    if (this.drift > 0.4) r.text('ДРИФТ', ctx.w / 2, ctx.h - 40, 24, '#ffd166', 'center');
    r.restore();
    this.shell.render(ctx);
  }
}
