import { SceneContext, persist } from './Engine';
import { clamp, TAU } from './math';

export type Phase = 'countdown' | 'playing' | 'paused' | 'over';

interface OverInfo { title: string; score: number; note?: string; }

/**
 * Общая обвязка мини-игры: отсчёт, пауза, кнопка «назад», экран итога.
 *
 * Вынесено из игр по двум причинам. Во-первых, раньше раунд начинался
 * мгновенно — игрок ещё не взял перо, а самолёт уже летел в стену.
 * Во-вторых, выйти из мини-игры было нельзя вообще: оставалось доиграть
 * до проигрыша.
 *
 * Игра вызывает update() первым делом и выходит, если он вернул false:
 * на паузе и отсчёте физика не должна тикать.
 */
export class Shell {
  phase: Phase = 'countdown';
  private countdown = 0;
  private over: OverInfo | null = null;
  private bound = false;
  private pausePulse = 0;

  /** Куда нажимать пальцем: кнопка «назад» в углу. */
  private backBox = { x: 0, y: 0, w: 44, h: 44 };

  constructor(
    private sceneName: string,
    private onRestart: () => void
  ) {}

  /** Вызывается из enter() сцены. */
  begin(ctx: SceneContext, seconds = 3) {
    this.phase = 'countdown';
    this.countdown = seconds;
    this.over = null;

    if (!this.bound) {
      this.bound = true;
      ctx.input.onBack(() => {
        if (!this.isActive(ctx)) return false;
        return this.handleBack(ctx);
      });
      ctx.input.onTap((x, y) => {
        if (this.isActive(ctx)) this.handleTap(ctx, x, y);
      });
      ctx.input.onEvent((kind) => {
        if (!this.isActive(ctx)) return;
        if (kind === 'button_long' && this.phase === 'playing') this.pause(ctx);
        // На паузе и на экране итога кнопка стилуса — это «продолжить»
        // или «ещё раз»: без неё пришлось бы тянуться пальцем к экрану.
        else if (kind === 'button_tap' && this.phase !== 'playing') this.handleButton(ctx);
      });
    }
  }

  private isActive(ctx: SceneContext) { return ctx.scene === this.sceneName; }

  /** true — можно считать физику. */
  update(ctx: SceneContext, dt: number): boolean {
    this.pausePulse += dt;

    // Пока раунд не идёт, перемещение пера выбрасываем. Иначе всё, что
    // игрок намахал за отсчёт или паузу, применилось бы одним рывком.
    if (this.phase !== 'playing') ctx.input.consumeDelta();

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'playing';
        // Нейтраль берём в момент старта: игрок уже держит перо как ему удобно.
        ctx.input.calibrate();
        ctx.audio.tick();
      }
      return false;
    }
    return this.phase === 'playing';
  }

  pause(ctx: SceneContext) {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    ctx.audio.tick();
  }

  resume(ctx: SceneContext) {
    if (this.phase !== 'paused') return;
    this.phase = 'countdown';
    this.countdown = 1.2;
    ctx.audio.tick();
  }

  /** Раунд окончен. Сцена больше не должна двигать мир. */
  finish(ctx: SceneContext, info: OverInfo) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.over = info;
    const best = ctx.save.best[this.sceneName] ?? 0;
    if (info.score > best) {
      ctx.save.best[this.sceneName] = Math.floor(info.score);
      persist(ctx.save);
    }
  }

  private handleBack(ctx: SceneContext): boolean {
    if (this.phase === 'playing') { this.pause(ctx); return true; }
    ctx.go('hub');
    return true;
  }

  private handleTap(ctx: SceneContext, x: number, y: number) {
    const px = x * ctx.w;
    const py = y * ctx.h;

    if (this.phase === 'playing') {
      const b = this.backBox;
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) this.pause(ctx);
      return;
    }

    if (this.phase === 'paused' || this.phase === 'over') {
      // Три кнопки в ряд: продолжить/заново — слева, в меню — справа.
      if (y < 0.55 || y > 0.78) return;
      if (x < 0.42) {
        if (this.phase === 'paused') this.resume(ctx);
        else this.onRestart();
      } else if (x > 0.58) {
        ctx.go('hub');
      }
    }
  }

  /** Рисуется поверх игры, последним. */
  render(ctx: SceneContext) {
    const { r } = ctx;
    const g = r.ctx;
    r.ui();

    if (this.phase === 'playing') {
      const b = this.backBox;
      b.x = ctx.w - 56; b.y = ctx.h - 56;
      r.roundRect(b.x, b.y, b.w, b.h, 12, 'rgba(10,14,28,0.55)');
      g.strokeStyle = 'rgba(200,215,245,0.75)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(b.x + 26, b.y + 14);
      g.lineTo(b.x + 16, b.y + 22);
      g.lineTo(b.x + 26, b.y + 30);
      g.stroke();
      r.restore();
      return;
    }

    if (this.phase === 'countdown') {
      const n = Math.ceil(this.countdown);
      const frac = 1 - (this.countdown % 1);
      g.globalAlpha = 0.55;
      r.roundRect(0, 0, ctx.w, ctx.h, 0, 'rgba(6,8,18,0.55)');
      g.globalAlpha = 1;
      r.text(n > 0 ? String(n) : 'ВПЕРЁД',
        ctx.w / 2, ctx.h / 2, 54 + frac * 10, '#ffffff', 'center');
      r.text('держи перо так, как тебе удобно',
        ctx.w / 2, ctx.h / 2 + 52, 13, '#9fb2da', 'center');
      // Кольцо прогресса — видно, сколько осталось
      g.strokeStyle = 'rgba(90,210,255,0.8)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(ctx.w / 2, ctx.h / 2, 52, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(frac, 0, 1));
      g.stroke();
      r.restore();
      return;
    }

    // Пауза и итог используют одну раскладку кнопок
    r.roundRect(0, 0, ctx.w, ctx.h, 0, 'rgba(6,8,18,0.82)');

    const paused = this.phase === 'paused';
    const title = paused ? 'ПАУЗА' : (this.over?.title ?? 'КОНЕЦ');
    r.text(title, ctx.w / 2, ctx.h * 0.3, 34, paused ? '#ffffff' : '#ffd166', 'center');

    if (!paused && this.over) {
      r.text(`${Math.floor(this.over.score)} очков`, ctx.w / 2, ctx.h * 0.39, 20, '#cfe0ff', 'center');
      const best = ctx.save.best[this.sceneName] ?? 0;
      r.text(`рекорд ${best}`, ctx.w / 2, ctx.h * 0.44, 14, '#7f93b8', 'center');
      if (this.over.note) r.text(this.over.note, ctx.w / 2, ctx.h * 0.49, 13, '#93a6cc', 'center');
    }

    const by = ctx.h * 0.6;
    const bh = ctx.h * 0.13;
    this.button(ctx, ctx.w * 0.08, by, ctx.w * 0.34, bh,
      paused ? 'ПРОДОЛЖИТЬ' : 'ЕЩЁ РАЗ', '#5ad2ff');
    this.button(ctx, ctx.w * 0.58, by, ctx.w * 0.34, bh, 'В МЕНЮ', '#8fa5d8');

    r.text('кнопка стилуса — продолжить · системная «назад» — в меню',
      ctx.w / 2, ctx.h - 24, 11, 'rgba(180,195,225,0.5)', 'center');
    r.restore();
  }

  private button(ctx: SceneContext, x: number, y: number, w: number, h: number,
                 label: string, color: string) {
    const { r } = ctx;
    r.roundRect(x, y, w, h, 14, 'rgba(18,24,48,0.95)');
    r.roundRect(x, y, w, h, 14, color, true);
    r.text(label, x + w / 2, y + h / 2, 16, color, 'center');
  }

  /** Кнопка стилуса на паузе — продолжить, на экране итога — заново. */
  handleButton(ctx: SceneContext) {
    if (this.phase === 'paused') this.resume(ctx);
    else if (this.phase === 'over') this.onRestart();
  }
}
