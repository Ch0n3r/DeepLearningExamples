import { OneEuroFilter } from './OneEuroFilter';
import { clamp } from '../core/math';

export type PenSource = 'native' | 'pointer' | 'gyro' | 'mouse';

export interface PenState {
  /** Наклон, нормированный в [-1;1]. +X вправо, +Y вниз (нос вниз). */
  tiltX: number;
  tiltY: number;
  /** Модуль и направление наклона — удобно для радиальных механик. */
  magnitude: number;
  angle: number;
  /** Кнопка стилуса зажата. */
  button: boolean;
  /** Перо над экраном (hover) — есть абсолютный курсор. */
  hover: boolean;
  hoverX: number;   // [0;1] по ширине
  hoverY: number;   // [0;1] по высоте
  hoverDistance: number; // 0 = касание, 1 = край зоны
  pressure: number;
  source: PenSource;
  nativeReady: boolean;
}

type EventKind = 'button_tap' | 'button_long' | 'button_down';
type Listener = (kind: EventKind, heldMs: number) => void;
/** Касание экрана в нормированных координатах [0;1]. */
type TapListener = (x: number, y: number) => void;

declare global {
  interface Window {
    SPenNative?: {
      pollState(): string;
      calibrate(): void;
      vibrate(ms: number): void;
      debugState?(): string;
    };
    __spen?: {
      onEvent(kind: EventKind, held: number): void;
      onNativeReady(ok: boolean): void;
    };
  }
}

/**
 * Единая точка правды по вводу.
 *
 * Приоритет источников:
 *   1. SPenNative       — Kotlin-мост, S Pen Remote SDK (air motion + hover tilt)
 *   2. PointerEvent     — Chrome отдаёт tiltX/tiltY для стилуса прямо в вебе
 *   3. DeviceOrientation— наклон самого телефона (тест без пера)
 *   4. Мышь + Space     — разработка на десктопе
 *
 * Игры НИКОГДА не читают источник напрямую — только PenState. Благодаря этому
 * весь геймплей отлаживается в браузере AI Studio, а на телефоне просто
 * подменяется источник.
 */
export class PenInput {
  readonly state: PenState = {
    tiltX: 0, tiltY: 0, magnitude: 0, angle: 0,
    button: false, hover: false, hoverX: 0.5, hoverY: 0.5,
    hoverDistance: 1, pressure: 0,
    source: 'mouse', nativeReady: false,
  };

  private fx = new OneEuroFilter(1.1, 0.010);
  private fy = new OneEuroFilter(1.1, 0.010);

  private biasX = 0;
  private biasY = 0;

  /** Мёртвая зона — иначе персонаж "ползёт" при спокойной руке. */
  deadzone = 0.07;
  /** Экспонента отклика: <1 мягче у нуля, точнее целиться. */
  expo = 1.55;
  /** Умножитель чувствительности, настраивается игроком в меню. */
  sensitivity = 1.0;

  private listeners: Listener[] = [];
  private tapListeners: TapListener[] = [];
  private prevButton = false;
  private buttonDownAt = 0;

  // Фолбэки
  private keySpace = false;
  private gyroBeta = 0;
  private gyroGamma = 0;
  private gyroActive = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.__spen = {
      onEvent: (kind, held) => this.emit(kind, held),
      onNativeReady: (ok) => { this.state.nativeReady = ok; },
    };
    this.bindFallbacks();
  }

  onEvent(fn: Listener) { this.listeners.push(fn); }

  /**
   * Касание экрана. Нужно как запасной путь управления в меню: если наклон
   * по какой-то причине не работает, до настройки и диагностики всё равно
   * можно добраться пальцем.
   */
  onTap(fn: TapListener) { this.tapListeners.push(fn); }
  private emit(kind: EventKind, held: number) {
    for (const l of this.listeners) l(kind, held);
  }

  /**
   * Текущее положение пера принимается за нейтраль.
   *
   * Смещение снимается РОВНО ОДИН РАЗ. Нативный мост обнуляет угол у себя,
   * поэтому вычитать здесь ещё и старое значение нельзя — иначе получится
   * постоянный сдвиг на величину этого значения.
   */
  calibrate() {
    if (window.SPenNative) {
      window.SPenNative.calibrate();
      this.biasX = 0;
      this.biasY = 0;
    } else {
      // PointerEvent отдаёт АБСОЛЮТНЫЙ угол стилуса, а перо в руке лежит
      // под 40-50° к экрану. Без вычитания нейтрали управление сразу
      // упирается в максимум.
      this.biasX = this.rawX;
      this.biasY = this.rawY;
    }
    this.fx.reset(0);
    this.fy.reset(0);
  }

  /** Сырые данные для экрана диагностики. */
  debug(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      rawX: this.rawX, rawY: this.rawY,
      biasX: this.biasX, biasY: this.biasY,
      source: this.state.source,
    };
    if (window.SPenNative?.debugState) {
      try { Object.assign(out, JSON.parse(window.SPenNative.debugState())); } catch { /* нет моста */ }
    }
    return out;
  }

  vibrate(ms: number) {
    if (window.SPenNative) window.SPenNative.vibrate(ms);
    else navigator.vibrate?.(ms);
  }

  private rawX = 0;
  private rawY = 0;

  /** Дёргается один раз за кадр из GameLoop до update() сцены. */
  sample(dt: number) {
    const s = this.state;
    let rx = 0, ry = 0, btn = false;

    const native = window.SPenNative;
    if (native) {
      try {
        const j = JSON.parse(native.pollState());
        rx = j.tiltX; ry = j.tiltY; btn = !!j.button;
        s.hover = !!j.hover;
        s.hoverX = j.hx; s.hoverY = j.hy;
        s.hoverDistance = j.hdist; s.pressure = j.pressure;
        s.source = 'native';
        s.nativeReady = true;
      } catch { /* мост отвалился — падаем на фолбэк ниже */ }
    }

    if (s.source !== 'native') {
      if (this.pointerTiltFresh) {
        rx = this.pointerTiltX; ry = this.pointerTiltY;
        s.source = 'pointer';
      } else if (this.gyroActive) {
        // gamma — крен телефона, beta — тангаж. 30° = полное отклонение.
        rx = clamp(this.gyroGamma / 30, -1, 1);
        ry = clamp((this.gyroBeta - 45) / 30, -1, 1);
        s.source = 'gyro';
      } else {
        rx = this.mouseX; ry = this.mouseY;
        s.source = 'mouse';
      }
      btn = this.pointerButton || this.keySpace;
    }

    this.rawX = rx;
    this.rawY = ry;

    // Порядок важен: сначала убираем смещение калибровки, потом фильтруем,
    // потом мёртвая зона, потом экспонента. Любая другая очередь даёт либо
    // рывок на выходе из дедзоны, либо неустранимый дрейф.
    const cx = this.fx.filter(rx - this.biasX, dt);
    const cy = this.fy.filter(ry - this.biasY, dt);

    s.tiltX = this.shape(cx);
    s.tiltY = this.shape(cy);
    s.magnitude = clamp(Math.hypot(s.tiltX, s.tiltY), 0, 1);
    s.angle = Math.atan2(s.tiltY, s.tiltX);
    s.button = btn;

    if (btn && !this.prevButton) {
      this.buttonDownAt = performance.now();
      if (!window.SPenNative) this.emit('button_down', 0);
    }
    if (!btn && this.prevButton && !window.SPenNative) {
      const held = performance.now() - this.buttonDownAt;
      this.emit(held >= 420 ? 'button_long' : 'button_tap', held);
    }
    this.prevButton = btn;

    this.pointerTiltFresh = false;
  }

  /** Дедзона + экспоненциальный отклик, без разрыва производной на границе. */
  private shape(v: number) {
    const a = Math.abs(v);
    if (a <= this.deadzone) return 0;
    const t = (a - this.deadzone) / (1 - this.deadzone);
    return Math.sign(v) * clamp(Math.pow(t, this.expo) * this.sensitivity, 0, 1);
  }

  // ---------------- фолбэки для браузера ----------------
  private mouseX = 0; private mouseY = 0;
  private pointerButton = false;
  private pointerTiltX = 0; private pointerTiltY = 0;
  private pointerTiltFresh = false;

  private bindFallbacks() {
    const c = this.canvas;

    c.addEventListener('pointermove', (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      this.state.hover = true;
      this.state.hoverX = (e.clientX - r.left) / r.width;
      this.state.hoverY = (e.clientY - r.top) / r.height;
      this.state.pressure = e.pressure;

      if (e.pointerType === 'pen' && (e.tiltX !== 0 || e.tiltY !== 0)) {
        // Спецификация: tiltX/tiltY в градусах, [-90;90].
        this.pointerTiltX = clamp(e.tiltX / 35, -1, 1);
        this.pointerTiltY = clamp(e.tiltY / 35, -1, 1);
        this.pointerTiltFresh = true;
      } else {
        this.mouseX = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
        this.mouseY = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
      }
    }, { passive: true });

    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width;
      const ny = (e.clientY - r.top) / r.height;
      this.state.hoverX = nx;
      this.state.hoverY = ny;
      for (const l of this.tapListeners) l(nx, ny);

      this.pointerButton = true;
      // Кнопка стилуса в вебе приходит как button===5 / buttons&32 (barrel button)
      if (e.pointerType === 'pen' && (e.buttons & 32) !== 0) this.pointerButton = true;
    });
    c.addEventListener('pointerup', () => { this.pointerButton = false; });
    c.addEventListener('pointerleave', () => { this.state.hover = false; });

    addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); this.keySpace = true; } });
    addEventListener('keyup', (e) => { if (e.code === 'Space') this.keySpace = false; });
  }

  /** Вызывать по кнопке "Играть" — iOS требует жест пользователя. */
  async enableGyro(): Promise<boolean> {
    const anyDO = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof anyDO?.requestPermission === 'function') {
      try { if ((await anyDO.requestPermission()) !== 'granted') return false; } catch { return false; }
    }
    addEventListener('deviceorientation', (e) => {
      if (e.beta == null || e.gamma == null) return;
      this.gyroBeta = e.beta;
      this.gyroGamma = e.gamma;
      this.gyroActive = true;
    }, { passive: true });
    return true;
  }
}
