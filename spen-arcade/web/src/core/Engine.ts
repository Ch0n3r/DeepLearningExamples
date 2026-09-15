import { PenInput, PenState } from '../input/PenInput';
import { Renderer } from './Renderer';
import { AudioBus } from './AudioBus';

export interface SceneContext {
  pen: PenState;
  input: PenInput;
  r: Renderer;
  audio: AudioBus;
  /** Переключиться на другую сцену (по имени из реестра). */
  go(scene: string, payload?: unknown): void;
  /** Общий профиль игрока: рекорды, монеты, разблокировки. */
  save: SaveData;
  w: number;
  h: number;
}

export interface Scene {
  name: string;
  enter(ctx: SceneContext, payload?: unknown): void;
  /** Фиксированный шаг симуляции. dt ВСЕГДА равен 1/60. */
  update(ctx: SceneContext, dt: number): void;
  /** alpha — доля между прошлым и текущим шагом, для интерполяции отрисовки. */
  render(ctx: SceneContext, alpha: number): void;
  exit?(ctx: SceneContext): void;
}

export interface SaveData {
  best: Record<string, number>;
  coins: number;
  sensitivity: number;
  invertY: boolean;
  unlocked: string[];
}

const SAVE_KEY = 'spen-arcade-v1';

function loadSave(): SaveData {
  const fallback: SaveData = { best: {}, coins: 0, sensitivity: 1, invertY: false, unlocked: ['sky'] };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch { return fallback; }
}

export function persist(save: SaveData) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* приватный режим */ }
}

/**
 * Цикл с фиксированным шагом и накопителем.
 *
 * Почему не «dt как пришло»: при переменном шаге физика наклона перестаёт быть
 * воспроизводимой — на 120-герцовом Galaxy самолёт разгоняется иначе, чем на 60,
 * а реплеи по seed разъезжаются. Фиксированный шаг 1/60 + интерполяция при
 * отрисовке даёт одинаковый геймплей на любом дисплее.
 */
export class Engine {
  private scenes = new Map<string, Scene>();
  private current?: Scene;
  private acc = 0;
  private last = 0;
  private running = false;
  private ctx: SceneContext;

  static readonly STEP = 1 / 60;
  /** Ограничитель: после сворачивания приложения не догоняем 300 шагов разом. */
  private static readonly MAX_STEPS = 5;

  constructor(
    private input: PenInput,
    private renderer: Renderer,
    audio: AudioBus
  ) {
    const save = loadSave();
    this.ctx = {
      pen: input.state,
      input,
      r: renderer,
      audio,
      save,
      w: renderer.width,
      h: renderer.height,
      go: (name, payload) => this.switchTo(name, payload),
    };
    input.sensitivity = save.sensitivity;
  }

  register(scene: Scene) { this.scenes.set(scene.name, scene); return this; }

  switchTo(name: string, payload?: unknown) {
    const next = this.scenes.get(name);
    if (!next) throw new Error(`Нет сцены "${name}"`);
    this.current?.exit?.(this.ctx);
    this.current = next;
    this.acc = 0;
    next.enter(this.ctx, payload);
  }

  start(first: string) {
    this.switchTo(first);
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop() { this.running = false; }

  private frame = (now: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    let elapsed = (now - this.last) / 1000;
    this.last = now;
    if (elapsed > 0.25) elapsed = 0.25; // вкладка была свёрнута

    this.renderer.resizeIfNeeded();
    this.ctx.w = this.renderer.width;
    this.ctx.h = this.renderer.height;

    // Ввод опрашиваем по РЕАЛЬНОМУ времени кадра: фильтр One Euro завязан на
    // фактическую частоту сэмплов, а не на шаг симуляции.
    this.input.sample(elapsed);

    this.acc += elapsed;
    let steps = 0;
    while (this.acc >= Engine.STEP && steps < Engine.MAX_STEPS) {
      this.current?.update(this.ctx, Engine.STEP);
      this.acc -= Engine.STEP;
      steps++;
    }
    if (steps === Engine.MAX_STEPS) this.acc = 0;

    const alpha = this.acc / Engine.STEP;
    this.renderer.beginFrame(elapsed);
    this.current?.render(this.ctx, alpha);
    this.renderer.endFrame();
  };
}
