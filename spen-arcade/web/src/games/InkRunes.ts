import { Scene, SceneContext } from '../core/Engine';
import { Shell } from '../core/Shell';
import { buildRuneTemplates, GestureRecognizer, Pt } from '../core/GestureRecognizer';
import { clamp, makeRng, TAU } from '../core/math';

interface Foe {
  x: number; y: number; r: number; hp: number; maxHp: number;
  speed: number; type: 'grunt' | 'armor' | 'swarm' | 'flyer';
  frozen: number; burn: number; alive: boolean;
}

type Rune = 'fire' | 'ice' | 'shield' | 'chain' | 'vortex';

/**
 * INK RUNES — «пишем» заклинания наклоном пера в воздухе.
 *
 * Управление:
 *   удерживай кнопку стилуса и наклоняй перо — курсор оставляет чернильный след
 *   отпусти кнопку — след распознаётся как руна и кастуется заклинание
 *   без кнопки — курсор просто двигается (наводка для точечных заклинаний)
 *
 * Здесь наклон интегрируется в ПОЗИЦИЮ курсора (не скорость): рисовать
 * инерционным курсором невозможно, $1 не разберёт такую кашу. Зато скорость
 * курсора завязана на модуль наклона нелинейно — мелкие детали руны выводятся
 * малым наклоном, крупные росчерки — большим.
 */
export class InkRunes implements Scene {
  name = 'runes';

  private rec = new GestureRecognizer();
  private rng = makeRng(77);

  private cx = 0; private cy = 0;
  private drawing = false;
  private stroke: Pt[] = [];
  private lastSampleT = 0;

  private foes: Foe[] = [];
  private hp = 100;
  private mana = 100;
  private shield = 0;
  private score = 0;
  private wave = 0;
  private waveDelay = 1.5;
  private over = false;
  private overTimer = 0;

  private lastRune: { name: string; score: number; t: number } | null = null;
  private cooldowns: Record<Rune, number> = { fire: 0, ice: 0, shield: 0, chain: 0, vortex: 0 };

  /** Во сколько ширин экрана превращается единичная дельта пера. */
  private static readonly CURSOR_GAIN = 1.0;
  private static readonly SAMPLE_HZ = 60;
  private static readonly MIN_SCORE = 0.74;     // ниже — «руна не распознана»
  private static readonly COSTS: Record<Rune, number> = {
    fire: 22, ice: 18, shield: 28, chain: 26, vortex: 35,
  };

  private onEvent = (kind: string) => {
    if (this.over || this.ctxRef?.scene !== 'runes') return;
    if (this.shell.phase !== 'playing') return;
    if (kind === 'button_down') this.beginStroke();
  };
  private bound = false;
  private prevButton = false;
  private shell = new Shell('runes', () => this.restart());
  private ctxRef: SceneContext | null = null;

  enter(ctx: SceneContext) {
    this.ctxRef = ctx;
    this.restart();
  }

  private restart() {
    const ctx = this.ctxRef!;
    this.rng = makeRng((Date.now() & 0xffff) | 3);
    const templates = buildRuneTemplates();
    this.rec = new GestureRecognizer();
    for (const [name, pts] of Object.entries(templates)) this.rec.addTemplate(name, pts);

    this.cx = ctx.w / 2; this.cy = ctx.h / 2;
    this.drawing = false; this.stroke = [];
    this.foes = []; this.hp = 100; this.mana = 100; this.shield = 0;
    this.score = 0; this.wave = 0; this.waveDelay = 1.5;
    this.over = false; this.overTimer = 0; this.lastRune = null;
    this.cooldowns = { fire: 0, ice: 0, shield: 0, chain: 0, vortex: 0 };

    if (!this.bound) { ctx.input.onEvent(this.onEvent); this.bound = true; }
    // Эти игры рисуются прямо в экранных координатах, поэтому камеру ставим
    // в центр вида — тогда camera() даёт тождественное преобразование и
    // при этом продолжает работать тряска.
    ctx.r.camX = ctx.w / 2; ctx.r.camY = ctx.h / 2;
    ctx.r.camZoom = 1; ctx.r.camRot = 0;
    this.shell.begin(ctx);
  }

  private beginStroke() {
    this.drawing = true;
    this.stroke = [{ x: this.cx, y: this.cy }];
    this.lastSampleT = 0;
  }

  private endStroke(ctx: SceneContext) {
    this.drawing = false;
    if (this.stroke.length < 12) { this.stroke = []; return; }

    const match = this.rec.recognize(this.stroke);
    this.stroke = [];
    if (!match) return;

    this.lastRune = { name: match.name, score: match.score, t: 1.4 };
    if (match.score < InkRunes.MIN_SCORE) {
      ctx.audio.fail();
      ctx.r.flash('#ff5a5a', 0.12);
      return;
    }
    this.cast(ctx, match.name as Rune);
  }

  private cast(ctx: SceneContext, rune: Rune) {
    const cost = InkRunes.COSTS[rune];
    if (this.mana < cost || this.cooldowns[rune] > 0) {
      ctx.audio.fail();
      return;
    }
    this.mana -= cost;
    ctx.input.vibrate(35);
    ctx.audio.boost();

    switch (rune) {
      case 'fire': {
        // Огненный шар в точку курсора: урон по площади + горение
        for (const f of this.foes) {
          if (!f.alive) continue;
          const d = Math.hypot(f.x - this.cx, f.y - this.cy);
          if (d < 130) {
            f.hp -= 40 * (1 - d / 190);
            f.burn = 3;
          }
        }
        ctx.r.burst(this.cx, this.cy, 46, 420, '#ff7a3c', 0.8);
        ctx.r.addShake(10);
        ctx.r.flash('#ff9a5c', 0.2);
        this.cooldowns.fire = 0.5;
        break;
      }
      case 'ice': {
        // Заморозка всех в широком конусе перед курсором
        for (const f of this.foes) {
          if (!f.alive) continue;
          if (Math.hypot(f.x - this.cx, f.y - this.cy) < 220) {
            f.frozen = 2.6;
            f.hp -= 12;
            ctx.r.burst(f.x, f.y, 8, 120, '#9fe8ff', 0.5);
          }
        }
        this.cooldowns.ice = 0.8;
        break;
      }
      case 'shield': {
        this.shield = Math.min(this.shield + 60, 100);
        ctx.r.flash('#7dd6ff', 0.18);
        this.cooldowns.shield = 3.0;
        break;
      }
      case 'chain': {
        // Цепная молния: 5 прыжков по ближайшим целям
        let src = { x: this.cx, y: this.cy };
        const hitSet = new Set<Foe>();
        for (let jump = 0; jump < 5; jump++) {
          let best: Foe | null = null;
          let bestD = 330;
          for (const f of this.foes) {
            if (!f.alive || hitSet.has(f)) continue;
            const d = Math.hypot(f.x - src.x, f.y - src.y);
            if (d < bestD) { bestD = d; best = f; }
          }
          if (!best) break;
          hitSet.add(best);
          best.hp -= 34 - jump * 4;
          // рисуем разряд частицами вдоль отрезка
          const steps = Math.max(6, Math.floor(bestD / 14));
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            ctx.r.spawn(
              src.x + (best.x - src.x) * t + (this.rng() - 0.5) * 18,
              src.y + (best.y - src.y) * t + (this.rng() - 0.5) * 18,
              0, 0, 0.3, 3, '#c8b6ff'
            );
          }
          src = { x: best.x, y: best.y };
        }
        ctx.r.addShake(7);
        this.cooldowns.chain = 1.0;
        break;
      }
      case 'vortex': {
        // Воронка: тянет всех к курсору и наносит урон со временем
        this.vortexTimer = 2.4;
        this.vortexX = this.cx;
        this.vortexY = this.cy;
        this.cooldowns.vortex = 5.0;
        break;
      }
    }
  }

  private vortexTimer = 0;
  private vortexX = 0;
  private vortexY = 0;

  update(ctx: SceneContext, dt: number) {
    this.ctxRef = ctx;
    if (!this.shell.update(ctx, dt)) return;
    const { pen, r, audio } = ctx;

    if (this.over) {
      this.overTimer += dt;
      if (this.overTimer > 1.2) {
        this.shell.finish(ctx, {
          title: 'ЯДРО ПАЛО',
          score: this.score,
          note: `волна ${this.wave}`,
        });
      }
      return;
    }

    // --- курсор ---------------------------------------------------------------
    //
    // Прямое перемещение: на сколько повернул перо — на столько уехал курсор.
    // Раньше наклон задавал СКОРОСТЬ, и курсор продолжал ползти после
    // остановки руки; нарисовать руну таким управлением невозможно.
    const { dx, dy } = ctx.input.consumeDelta();
    const gain = InkRunes.CURSOR_GAIN * ctx.input.sensitivity;

    if (pen.hover && pen.hoverDistance < 0.5 && pen.source === 'native') {
      // Перо у экрана — ведём курсор прямо под кончик.
      this.cx = pen.hoverX * ctx.w;
      this.cy = pen.hoverY * ctx.h;
    } else {
      this.cx += dx * ctx.w * gain;
      this.cy += dy * ctx.h * gain;
    }
    this.cx = clamp(this.cx, 12, ctx.w - 12);
    this.cy = clamp(this.cy, 12, ctx.h - 12);

    // Фолбэк-источники не шлют дискретные события кнопки — ловим фронт сами.
    if (pen.button && !this.prevButton && !this.drawing) this.beginStroke();
    if (!pen.button && this.prevButton && this.drawing) this.endStroke(ctx);
    this.prevButton = pen.button;

    if (this.drawing) {
      this.lastSampleT += dt;
      const period = 1 / InkRunes.SAMPLE_HZ;
      if (this.lastSampleT >= period) {
        this.lastSampleT = 0;
        const last = this.stroke[this.stroke.length - 1];
        // Пропускаем точки ближе 3 px: дубли портят ресемплинг $1.
        if (!last || Math.hypot(this.cx - last.x, this.cy - last.y) > 3) {
          this.stroke.push({ x: this.cx, y: this.cy });
          r.spawn(this.cx, this.cy, 0, 0, 0.5, 3, '#8fd6ff');
        }
        // Защита от бесконечного росчерка
        if (this.stroke.length > 380) this.endStroke(ctx);
      }
    }

    for (const k of Object.keys(this.cooldowns) as Rune[]) {
      this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dt);
    }
    this.mana = Math.min(100, this.mana + dt * 9);

    // --- волны ----------------------------------------------------------------
    this.waveDelay -= dt;
    const aliveCount = this.foes.reduce((n, f) => n + (f.alive ? 1 : 0), 0);
    if (this.waveDelay <= 0 && aliveCount === 0) {
      this.wave++;
      this.spawnWave(ctx);
      this.waveDelay = 2.2;
      this.mana = Math.min(100, this.mana + 25);
    }

    // --- воронка ---------------------------------------------------------------
    if (this.vortexTimer > 0) {
      this.vortexTimer -= dt;
      for (const f of this.foes) {
        if (!f.alive) continue;
        const dx = this.vortexX - f.x, dy = this.vortexY - f.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 320) {
          f.x += (dx / d) * 220 * dt;
          f.y += (dy / d) * 220 * dt;
          f.hp -= 24 * dt;
        }
      }
      for (let i = 0; i < 3; i++) {
        const a = this.rng() * TAU;
        const rr = 40 + this.rng() * 260;
        r.spawn(this.vortexX + Math.cos(a) * rr, this.vortexY + Math.sin(a) * rr,
          -Math.cos(a) * 240, -Math.sin(a) * 240, 0.5, 3, '#b388ff');
      }
    }

    // --- враги ------------------------------------------------------------------
    const coreX = ctx.w / 2, coreY = ctx.h - 60;
    for (const f of this.foes) {
      if (!f.alive) continue;

      if (f.burn > 0) { f.burn -= dt; f.hp -= 14 * dt;
        if (this.rng() < 0.4) r.spawn(f.x, f.y, (this.rng() - 0.5) * 40, -60, 0.4, 3, '#ff9a4a'); }
      const slow = f.frozen > 0 ? 0.25 : 1;
      if (f.frozen > 0) f.frozen -= dt;

      const dx = coreX - f.x, dy = coreY - f.y;
      const d = Math.hypot(dx, dy) || 1;
      f.x += (dx / d) * f.speed * slow * dt;
      f.y += (dy / d) * f.speed * slow * dt;
      if (f.type === 'flyer') f.x += Math.sin(f.y * 0.03) * 60 * dt;

      if (d < 44) {
        f.alive = false;
        const dmg = f.type === 'armor' ? 22 : 12;
        const absorbed = Math.min(this.shield, dmg);
        this.shield -= absorbed;
        this.hp -= dmg - absorbed;
        r.addShake(12);
        r.flash('#ff4040', 0.25);
        audio.explode();
        ctx.input.vibrate(60);
        if (this.hp <= 0) { this.hp = 0; this.over = true; audio.fail(); }
      }

      if (f.hp <= 0) {
        f.alive = false;
        const gain = f.type === 'armor' ? 260 : f.type === 'swarm' ? 60 : 140;
        this.score += gain;
        r.popup(f.x, f.y - 18, `+${gain}`, '#ffb86b');
        ctx.save.coins += 1;
        r.burst(f.x, f.y, 18, 260, '#ffb86b', 0.6);
        audio.hit();
      }
    }
    this.foes = this.foes.filter(f => f.alive);

    this.score += dt * 4;
    if (this.lastRune) {
      this.lastRune.t -= dt;
      if (this.lastRune.t <= 0) this.lastRune = null;
    }
    r.camX = ctx.w / 2; r.camY = ctx.h / 2;
  }

  private spawnWave(ctx: SceneContext) {
    const n = 3 + Math.floor(this.wave * 1.6);
    for (let i = 0; i < n; i++) {
      const roll = this.rng();
      const type: Foe['type'] =
        this.wave > 3 && roll < 0.18 ? 'armor'
        : roll < 0.42 ? 'swarm'
        : roll < 0.66 ? 'flyer'
        : 'grunt';
      const hp = type === 'armor' ? 150 + this.wave * 14
               : type === 'swarm' ? 26
               : 55 + this.wave * 6;
      // Держим дистанцию от ядра по горизонтали: иначе первая же волна
      // падает прямо на него и отнимает здоровье до первого заклинания.
      const coreX = ctx.w / 2;
      let fx = this.rng() * ctx.w;
      if (Math.abs(fx - coreX) < ctx.w * 0.12) fx = coreX + Math.sign(fx - coreX || 1) * ctx.w * 0.2;
      this.foes.push({
        x: clamp(fx, 20, ctx.w - 20),
        y: -80 - this.rng() * 340,
        r: type === 'armor' ? 26 : type === 'swarm' ? 11 : 17,
        hp, maxHp: hp,
        speed: type === 'swarm' ? 92 + this.wave * 3
             : type === 'armor' ? 34
             : 58 + this.wave * 2,
        type,
        frozen: 0, burn: 0, alive: true,
      });
    }
  }

  render(ctx: SceneContext, _alpha: number) {
    const { r } = ctx;
    const g = r.ctx;
    r.clear('#080612');

    r.camera();

    // ядро, которое защищаем: пульс тем тревожнее, чем меньше здоровья
    const coreX = ctx.w / 2, coreY = ctx.h - 60;
    const urgency = 1 - this.hp / 100;
    const pulse = 1 + Math.sin(this.score * 0.05 + this.wave) * (0.05 + urgency * 0.12);

    g.globalCompositeOperation = 'lighter';
    const coreGlow = g.createRadialGradient(coreX, coreY, 0, coreX, coreY, 90 * pulse);
    coreGlow.addColorStop(0, `rgba(255,209,102,${0.35 + urgency * 0.25})`);
    coreGlow.addColorStop(1, 'rgba(255,209,102,0)');
    g.fillStyle = coreGlow;
    g.fillRect(coreX - 120, coreY - 120, 240, 240);
    g.globalCompositeOperation = 'source-over';

    g.strokeStyle = this.shield > 0 ? 'rgba(125,214,255,0.85)' : 'rgba(255,209,102,0.5)';
    g.lineWidth = this.shield > 0 ? 4 : 3;
    g.beginPath(); g.arc(coreX, coreY, 40 * pulse, 0, TAU); g.stroke();
    r.circle(coreX, coreY, 22, '#ffd166');

    if (this.vortexTimer > 0) {
      g.strokeStyle = 'rgba(179,136,255,0.5)';
      g.lineWidth = 2;
      g.beginPath(); g.arc(this.vortexX, this.vortexY, 300 * (this.vortexTimer / 2.4), 0, TAU); g.stroke();
    }

    for (const f of this.foes) {
      const color = f.frozen > 0 ? '#8fd6ff'
                  : f.type === 'armor' ? '#c06a6a'
                  : f.type === 'swarm' ? '#9a7ad6'
                  : f.type === 'flyer' ? '#6ac0a0'
                  : '#d0d6e8';
      g.save();
      g.translate(f.x, f.y);
      g.fillStyle = color;
      if (f.type === 'armor') {
        // бронированный — шестиугольник, видно издалека
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * TAU;
          g.lineTo(Math.cos(a) * f.r, Math.sin(a) * f.r);
        }
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.35)';
        g.lineWidth = 2;
        g.stroke();
      } else if (f.type === 'flyer') {
        g.beginPath();
        g.moveTo(0, -f.r);
        g.lineTo(f.r, f.r * 0.7);
        g.lineTo(-f.r, f.r * 0.7);
        g.closePath();
        g.fill();
      } else {
        g.beginPath();
        g.arc(0, 0, f.r, 0, TAU);
        g.fill();
      }
      if (f.frozen > 0) {
        g.strokeStyle = 'rgba(200,240,255,0.9)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(0, 0, f.r + 4, 0, TAU); g.stroke();
      }
      g.restore();
      if (f.hp < f.maxHp) {
        const w = f.r * 2;
        r.roundRect(f.x - f.r, f.y - f.r - 9, w, 3, 1.5, 'rgba(0,0,0,0.5)');
        r.roundRect(f.x - f.r, f.y - f.r - 9, w * (f.hp / f.maxHp), 3, 1.5, '#7dffb0');
      }
    }

    r.drawParticles();
    r.drawPopups();

    // чернильный след
    if (this.stroke.length > 1) {
      g.lineJoin = 'round';
      g.lineCap = 'round';
      // два прохода: широкий светящийся и тонкий яркий поверх
      g.globalCompositeOperation = 'lighter';
      for (const [w, a] of [[14, 0.18], [4, 0.95]] as const) {
        g.strokeStyle = `rgba(140,210,255,${a})`;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(this.stroke[0].x, this.stroke[0].y);
        for (let i = 1; i < this.stroke.length; i++) g.lineTo(this.stroke[i].x, this.stroke[i].y);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
    }

    // курсор пера
    g.strokeStyle = this.drawing ? '#8fd6ff' : 'rgba(255,255,255,0.7)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(this.cx, this.cy, this.drawing ? 9 : 6, 0, TAU); g.stroke();

    r.restore();

    r.ui();
    r.roundRect(20, 22, 160, 10, 5, 'rgba(255,255,255,0.15)');
    r.roundRect(20, 22, 160 * (this.hp / 100), 10, 5, '#ff6b6b');
    r.roundRect(20, 38, 160, 8, 4, 'rgba(255,255,255,0.15)');
    r.roundRect(20, 38, 160 * (this.mana / 100), 8, 4, '#6b9cff');
    if (this.shield > 0) {
      r.roundRect(20, 52, 160 * (this.shield / 100), 6, 3, '#7dd6ff');
    }
    r.text(`${Math.floor(this.score)}`, ctx.w - 82, 30, 26, '#ffffff', 'right');
    r.text(`волна ${this.wave}`, ctx.w - 82, 56, 13, '#a9bbe0', 'right');

    // подсказка по рунам + кулдауны
    const runes: Rune[] = ['fire', 'ice', 'shield', 'chain', 'vortex'];
    const labels: Record<Rune, string> = {
      fire: 'молния ⚡ огонь', ice: 'треугольник △ лёд', shield: 'дуга ⌒ щит',
      chain: 'зигзаг ⌁ цепь', vortex: 'спираль ◎ воронка',
    };
    runes.forEach((rn, i) => {
      const y = ctx.h - 24 - (runes.length - 1 - i) * 20;
      const cd = this.cooldowns[rn];
      const ready = cd <= 0 && this.mana >= InkRunes.COSTS[rn];
      r.text(labels[rn], 20, y, 12, ready ? '#cfe0ff' : 'rgba(180,195,225,0.35)');
    });

    if (this.lastRune) {
      const ok = this.lastRune.score >= InkRunes.MIN_SCORE;
      r.text(
        ok ? `${this.lastRune.name.toUpperCase()} ${(this.lastRune.score * 100).toFixed(0)}%` : 'руна не распознана',
        ctx.w / 2, 80, 20, ok ? '#7dffb0' : '#ff8080', 'center'
      );
    }

    r.restore();
    this.shell.render(ctx);
  }
}
