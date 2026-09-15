import { Scene, SceneContext } from '../core/Engine';
import { clamp, damp, TAU } from '../core/math';

interface Card { id: string; title: string; subtitle: string; color: string; }

/**
 * HUB — выбор мини-игры наклоном пера.
 *
 * Карусель: наклон влево/вправо листает, задержка на карточке >0.75 с ИЛИ
 * нажатие кнопки — запуск. Такой «dwell select» нужен, потому что в воздухе
 * у пера нет курсора: тыкать некуда, а листать наклоном — естественно.
 */
export class Hub implements Scene {
  name = 'hub';

  private cards: Card[] = [
    { id: 'sky',   title: 'SKY DRIFTER', subtitle: 'наклон — курс, кнопка — форсаж', color: '#5ad2ff' },
    { id: 'race',  title: 'TILT RACER',  subtitle: 'от себя — газ, кнопка — ручник',  color: '#7dffb0' },
    { id: 'hunt',  title: 'BIRD HUNT',   subtitle: 'наклон — прицел, тап — выстрел',  color: '#ffd166' },
    { id: 'runes', title: 'INK RUNES',   subtitle: 'зажми и рисуй руну в воздухе',    color: '#b388ff' },
  ];

  private index = 0;
  private offset = 0;      // сглаженная позиция карусели
  private dwell = 0;
  private navCooldown = 0;
  private t = 0;
  private launching = 0;
  private pendingLaunch: string | null = null;

  private onEvent = (kind: string) => {
    if (kind === 'button_tap' && !this.pendingLaunch) this.launch();
  };
  private bound = false;
  private prevButton = false;

  enter(ctx: SceneContext) {
    this.dwell = 0;
    this.navCooldown = 0;
    this.launching = 0;
    this.pendingLaunch = null;
    if (!this.bound) { ctx.input.onEvent(this.onEvent); this.bound = true; }
    ctx.r.camX = 0; ctx.r.camY = 0; ctx.r.camZoom = 1; ctx.r.camRot = 0;
    ctx.input.calibrate();
  }

  private launch() {
    this.pendingLaunch = this.cards[this.index].id;
    this.launching = 0.35;
  }

  update(ctx: SceneContext, dt: number) {
    const { pen, r, audio } = ctx;
    this.t += dt;

    if (this.pendingLaunch) {
      this.launching -= dt;
      r.camZoom = damp(r.camZoom, 1.35, 0.15, dt);
      if (this.launching <= 0) {
        const id = this.pendingLaunch;
        this.pendingLaunch = null;
        ctx.go(id);
      }
      return;
    }

    // листание: нужен уверенный наклон, чтобы карусель не «дребезжала»
    this.navCooldown -= dt;
    if (this.navCooldown <= 0 && Math.abs(pen.tiltX) > 0.45) {
      this.index = clamp(this.index + Math.sign(pen.tiltX), 0, this.cards.length - 1);
      this.navCooldown = 0.32;
      this.dwell = 0;
      audio.tick();
      ctx.input.vibrate(10);
    }

    // dwell-select: держим перо ровно — запускаем
    if (Math.abs(pen.tiltX) < 0.22 && Math.abs(pen.tiltY) < 0.28) {
      this.dwell += dt;
      if (this.dwell > 1.35) this.launch();
    } else {
      this.dwell = Math.max(0, this.dwell - dt * 2);
    }

    if (pen.button && !this.prevButton) this.launch();
    this.prevButton = pen.button;

    this.offset = damp(this.offset, this.index, 0.09, dt);
    r.camZoom = damp(r.camZoom, 1, 0.3, dt);
  }

  render(ctx: SceneContext, _alpha: number) {
    const { r, pen } = ctx;
    const g = r.ctx;
    r.clear('#06070f');

    r.camera();
    g.translate(-ctx.w / 2, -ctx.h / 2);

    // фоновая сетка, слегка реагирующая на наклон — сразу видно, что ввод живой
    g.strokeStyle = 'rgba(90,120,200,0.10)';
    g.lineWidth = 1;
    const gs = 48;
    const ox = -pen.tiltX * 24, oy = -pen.tiltY * 24;
    for (let x = -gs; x < ctx.w + gs; x += gs) {
      g.beginPath(); g.moveTo(x + ox, 0); g.lineTo(x + ox, ctx.h); g.stroke();
    }
    for (let y = -gs; y < ctx.h + gs; y += gs) {
      g.beginPath(); g.moveTo(0, y + oy); g.lineTo(ctx.w, y + oy); g.stroke();
    }

    const cw = Math.min(280, ctx.w * 0.66);
    const ch = cw * 0.62;
    const cyy = ctx.h / 2;

    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      const d = i - this.offset;
      const x = ctx.w / 2 + d * (cw * 0.78);
      const scale = clamp(1 - Math.abs(d) * 0.22, 0.5, 1);
      const alpha = clamp(1 - Math.abs(d) * 0.42, 0.12, 1);
      if (Math.abs(d) > 2.6) continue;

      g.save();
      g.translate(x, cyy);
      g.scale(scale, scale);
      g.globalAlpha = alpha;

      r.roundRect(-cw / 2, -ch / 2, cw, ch, 20, 'rgba(18,24,48,0.95)');
      r.roundRect(-cw / 2, -ch / 2, cw, ch, 20, c.color, true);

      // «превью» — простая процедурная иллюстрация в цвете игры
      g.strokeStyle = c.color;
      g.globalAlpha = alpha * 0.55;
      g.lineWidth = 2;
      g.beginPath();
      for (let k = 0; k < 40; k++) {
        const t = k / 39;
        const px = -cw / 2 + 20 + t * (cw - 40);
        const py = -14 + Math.sin(t * 7 + this.t * 1.6 + i) * 22;
        k === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.stroke();
      g.globalAlpha = alpha;

      r.text(c.title, 0, ch / 2 - 52, 20, '#ffffff', 'center');
      r.text(c.subtitle, 0, ch / 2 - 28, 11, 'rgba(200,215,245,0.8)', 'center');
      const best = ctx.save.best[c.id] ?? 0;
      if (best > 0) r.text(`рекорд ${best}`, 0, -ch / 2 + 24, 12, c.color, 'center');

      g.globalAlpha = 1;
      g.restore();
    }

    // индикатор dwell вокруг активной карточки
    if (this.dwell > 0.05) {
      const p = clamp(this.dwell / 1.35, 0, 1);
      g.strokeStyle = this.cards[this.index].color;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(ctx.w / 2, cyy + ch / 2 + 44, 18, -Math.PI / 2, -Math.PI / 2 + TAU * p);
      g.stroke();
    }

    r.drawParticles();
    r.restore();

    r.ui();
    r.text('S PEN ARCADE', ctx.w / 2, 42, 24, '#ffffff', 'center');
    const src = pen.source === 'native' ? 'S Pen (SDK)'
              : pen.source === 'pointer' ? 'стилус (PointerEvent)'
              : pen.source === 'gyro' ? 'гироскоп телефона'
              : 'мышь + пробел';
    r.text(`ввод: ${src}`, ctx.w / 2, 68, 12, '#7f93b8', 'center');
    r.text('наклон — листать · кнопка или задержка — старт',
      ctx.w / 2, ctx.h - 28, 12, 'rgba(180,195,225,0.6)', 'center');
    r.text(`монеты ${ctx.save.coins}`, ctx.w - 20, ctx.h - 28, 12, '#ffd166', 'right');
    r.restore();

  }
}
