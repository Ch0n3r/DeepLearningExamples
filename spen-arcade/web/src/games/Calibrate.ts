import { Scene, SceneContext, persist } from '../core/Engine';
import { clamp, TAU } from '../core/math';

interface Row {
  label: string;
  get(ctx: SceneContext): string;
  dec?(ctx: SceneContext): void;
  inc?(ctx: SceneContext): void;
  act?(ctx: SceneContext): void;
}

/**
 * НАСТРОЙКА — живой отклик пера плюс подкрутка чувствительности.
 *
 * Нужен по простой причине: у наклона стилуса нет «правильных» чисел.
 * Один игрок держит перо почти вертикально, другой — под 60°, у Air Actions
 * и hover разная амплитуда. Поэтому вместо угадывания констант даём экран,
 * где видно сырые значения и можно подобрать отклик под свою руку.
 *
 * Управление: наклон вверх/вниз — выбор строки, влево/вправо — изменение,
 * кнопка стилуса — действие строки (там, где оно есть).
 */
export class Calibrate implements Scene {
  name = 'calibrate';

  private index = 0;
  private navCooldown = 0;
  private trail: { x: number; y: number }[] = [];
  private prevButton = false;
  private bound = false;

  /** Тап по строке выбирает её; по левой/правой части — меняет значение. */
  private onTap = (x: number, y: number) => {
    if (this.lastCtx?.scene !== this.name) return;
    const row = Math.floor((y * this.viewH - 73) / 34);
    if (row >= 0 && row < this.rows.length) {
      this.index = row;
      const ctx = this.lastCtx;
      if (!ctx) return;
      const r = this.rows[row];
      // Правая часть строки — увеличить или выполнить, левая — уменьшить.
      if (x > 0.42) { if (r.inc) r.inc(ctx); else r.act?.(ctx); }
      else if (x > 0.22) { if (r.dec) r.dec(ctx); else r.act?.(ctx); }
    }
  };
  private viewH = 1;
  private lastCtx: SceneContext | null = null;

  private rows: Row[] = [
    {
      label: 'Чувствительность',
      get: (c) => c.save.sensitivity.toFixed(2),
      dec: (c) => this.setSens(c, c.save.sensitivity - 0.1),
      inc: (c) => this.setSens(c, c.save.sensitivity + 0.1),
    },
    {
      label: 'Мёртвая зона',
      get: (c) => c.save.deadzone.toFixed(2),
      dec: (c) => this.setDead(c, c.save.deadzone - 0.01),
      inc: (c) => this.setDead(c, c.save.deadzone + 0.01),
    },
    {
      label: 'Поменять оси местами',
      get: (c) => (c.save.swapAxes ? 'да' : 'нет'),
      act: (c) => this.toggle(c, 'swapAxes'),
    },
    {
      label: 'Инверсия оси X',
      get: (c) => (c.save.invertX ? 'да' : 'нет'),
      act: (c) => this.toggle(c, 'invertX'),
    },
    {
      label: 'Инверсия оси Y',
      get: (c) => (c.save.invertY ? 'да' : 'нет'),
      act: (c) => this.toggle(c, 'invertY'),
    },
    {
      label: 'Задать нейтраль',
      get: () => 'держи перо ровно и нажми',
      act: (c) => { c.input.calibrate(); c.input.vibrate(30); c.audio.pickup(); },
    },
    {
      label: 'Назад',
      get: () => '',
      act: (c) => c.go('hub'),
    },
  ];

  private setSens(c: SceneContext, v: number) {
    c.save.sensitivity = clamp(Math.round(v * 100) / 100, 0.3, 3);
    c.input.sensitivity = c.save.sensitivity;
    persist(c.save);
  }
  private setDead(c: SceneContext, v: number) {
    c.save.deadzone = clamp(Math.round(v * 100) / 100, 0, 0.35);
    c.input.deadzone = c.save.deadzone;
    persist(c.save);
  }
  private toggle(c: SceneContext, key: 'swapAxes' | 'invertX' | 'invertY') {
    c.save[key] = !c.save[key];
    c.input.swapAxes = c.save.swapAxes;
    c.input.invertX = c.save.invertX;
    c.input.invertY = c.save.invertY;
    persist(c.save);
  }

  enter(ctx: SceneContext) {
    if (!this.bound) {
      ctx.input.onTap(this.onTap);
      ctx.input.onBack(() => {
        if (this.lastCtx?.scene !== this.name) return false;
        this.lastCtx.go('hub');
        return true;
      });
      this.bound = true;
    }
    this.lastCtx = ctx;
    this.index = 0;
    this.navCooldown = 0;
    this.trail = [];
    ctx.r.camX = 0; ctx.r.camY = 0; ctx.r.camZoom = 1; ctx.r.camRot = 0;
  }

  update(ctx: SceneContext, dt: number) {
    const { pen } = ctx;
    this.lastCtx = ctx;
    this.viewH = ctx.h;
    this.navCooldown -= dt;

    if (this.navCooldown <= 0) {
      if (Math.abs(pen.tiltY) > 0.5) {
        this.index = clamp(this.index + Math.sign(pen.tiltY), 0, this.rows.length - 1);
        this.navCooldown = 0.3;
        ctx.audio.tick();
      } else if (Math.abs(pen.tiltX) > 0.5) {
        const row = this.rows[this.index];
        (pen.tiltX > 0 ? row.inc : row.dec)?.(ctx);
        this.navCooldown = 0.22;
        ctx.audio.tick();
      }
    }

    if (pen.button && !this.prevButton) {
      this.rows[this.index].act?.(ctx);
    }
    this.prevButton = pen.button;

    // След отклонения: видно и дрожь, и залипание в углу
    this.trail.push({ x: pen.tiltX, y: pen.tiltY });
    if (this.trail.length > 90) this.trail.shift();
  }

  render(ctx: SceneContext, _alpha: number) {
    const { r, pen } = ctx;
    const g = r.ctx;
    r.clear('#06070f');
    r.ui();

    r.text('НАСТРОЙКА ПЕРА', ctx.w / 2, 34, 22, '#ffffff', 'center');

    // --- визуализация отклонения ------------------------------------------
    const cx = ctx.w * 0.74;
    const cy = ctx.h * 0.52;
    const R = Math.min(ctx.w * 0.2, ctx.h * 0.3);

    g.strokeStyle = 'rgba(120,150,220,0.3)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    g.beginPath(); g.arc(cx, cy, R * ctx.save.deadzone, 0, TAU); g.stroke();
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.stroke();
    g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();

    if (this.trail.length > 1) {
      g.strokeStyle = 'rgba(90,210,255,0.45)';
      g.lineWidth = 2;
      g.beginPath();
      this.trail.forEach((p, i) => {
        const x = cx + p.x * R, y = cy + p.y * R;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      });
      g.stroke();
    }
    r.circle(cx + pen.tiltX * R, cy + pen.tiltY * R, 7, pen.button ? '#ffd166' : '#5ad2ff');
    r.text(`X ${pen.tiltX.toFixed(2)}   Y ${pen.tiltY.toFixed(2)}`,
      cx, cy + R + 24, 14, '#cfe0ff', 'center');
    r.text(pen.button ? 'КНОПКА НАЖАТА' : 'кнопка отпущена',
      cx, cy + R + 46, 12, pen.button ? '#ffd166' : '#6b7ea8', 'center');

    // --- строки настроек ----------------------------------------------------
    const x0 = 28;
    let y = 88;
    this.rows.forEach((row, i) => {
      const active = i === this.index;
      if (active) r.roundRect(x0 - 10, y - 15, ctx.w * 0.46, 30, 8, 'rgba(90,210,255,0.14)');
      r.text(row.label, x0, y, 15, active ? '#ffffff' : '#93a6cc');
      r.text(row.get(ctx), x0 + ctx.w * 0.30, y, 14, active ? '#5ad2ff' : '#6b7ea8');
      y += 34;
    });

    // --- диагностика --------------------------------------------------------
    const d = ctx.input.debug();
    const src = pen.source === 'native' ? 'S Pen SDK'
              : pen.source === 'pointer' ? 'стилус (PointerEvent)'
              : pen.source === 'gyro' ? 'гироскоп телефона'
              : 'мышь';
    y += 12;
    r.text(`источник: ${src}`, x0, y, 12, '#7f93b8'); y += 20;

    if (d.connected !== undefined) {
      r.text(`SDK подключён: ${d.connected ? 'да' : 'нет'} · Air Actions: ${d.airMotion ? 'да' : 'нет'}`,
        x0, y, 12, d.connected ? '#7dffb0' : '#ff8080'); y += 20;
      // Счётчик событий — главный индикатор: он сразу разделяет
      // «данные не приходят» и «приходят, но мы их не так считаем».
      const events = typeof d.airEvents === 'number' ? d.airEvents : 0;
      r.text(`air motion: ${events} событий  последняя дельта ${fmt(d.lastDx, 4)} / ${fmt(d.lastDy, 4)}`,
        x0, y, 12, events > 0 ? '#7dffb0' : '#ff8080'); y += 18;
      r.text(`макс. дельта ${fmt(d.maxDelta, 4)}   накоплено X ${fmt(d.airX, 2)} Y ${fmt(d.airY, 2)}`,
        x0, y, 12, '#7f93b8'); y += 18;
      r.text(`hover  абс ${fmt(d.absRoll)}° / ${fmt(d.absPitch)}°   нейтраль ${fmt(d.biasRoll)}° / ${fmt(d.biasPitch)}°`,
        x0, y, 12, '#7f93b8'); y += 18;
      if (!d.hoverSeen) {
        r.text('hover ещё не видел перо — поднеси стилус к экрану',
          x0, y, 12, '#ffd166');
      }
    } else {
      r.text(`сырой  X ${fmt(d.rawX, 2)}  Y ${fmt(d.rawY, 2)}`, x0, y, 12, '#7f93b8'); y += 18;
      r.text(`нейтраль X ${fmt(d.biasX, 2)}  Y ${fmt(d.biasY, 2)}`, x0, y, 12, '#7f93b8');
    }

    r.text('наклон вверх/вниз — выбор · влево/вправо — изменить · кнопка — применить',
      ctx.w / 2, ctx.h - 20, 11, 'rgba(180,195,225,0.55)', 'center');
    r.restore();
  }
}

function fmt(v: unknown, digits = 1): string {
  return typeof v === 'number' ? v.toFixed(digits) : '—';
}
