/** Малый математический рантайм: без зависимостей, без аллокаций в горячем цикле. */

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Кадрово-независимый экспоненциальный сглаживатель.
 *  half — время, за которое остаток расстояния сокращается вдвое (сек). */
export function damp(current: number, target: number, half: number, dt: number) {
  if (half <= 0) return target;
  return lerp(target, current, Math.pow(2, -dt / half));
}

export function angleLerp(a: number, b: number, t: number) {
  let d = ((b - a + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** Детерминированный ГПСЧ (mulberry32) — нужен, чтобы трассы/волны
 *  воспроизводились по seed: дейли-челленджи, реплеи, отладка. */
export function makeRng(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1D value-noise с кубической интерполяцией — из него лепим изгибы трассы,
 *  болтанку ветра и траектории птиц. */
export function makeNoise1D(seed: number) {
  const rng = makeRng(seed);
  const table = new Float32Array(512);
  for (let i = 0; i < 512; i++) table[i] = rng() * 2 - 1;
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = table[i & 511];
    const b = table[(i + 1) & 511];
    return lerp(a, b, smoothstep(f));
  };
}

/** Фрактальный шум: несколько октав поверх value-noise. */
export function fbm(noise: (x: number) => number, x: number, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Равномерная хеш-сетка для broad-phase коллизий.
 * O(n) вместо O(n²): при 400 астероидах разница между 60 и 12 fps.
 */
export class SpatialHash<T extends { x: number; y: number; r: number }> {
  private cells = new Map<number, T[]>();
  constructor(private cell = 64) {}

  private key(cx: number, cy: number) {
    // Упаковка двух int16 в один int32 — Map по числу быстрее, чем по строке.
    return ((cx & 0xffff) << 16) | (cy & 0xffff);
  }

  clear() { this.cells.clear(); }

  insert(item: T) {
    const c = this.cell;
    const x0 = Math.floor((item.x - item.r) / c), x1 = Math.floor((item.x + item.r) / c);
    const y0 = Math.floor((item.y - item.r) / c), y1 = Math.floor((item.y + item.r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const bucket = this.cells.get(k);
        if (bucket) bucket.push(item); else this.cells.set(k, [item]);
      }
    }
  }

  /** Вызывает fn для каждого кандидата рядом с (x,y,r). Дубли отсекаются через seen. */
  query(x: number, y: number, r: number, fn: (item: T) => void) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    const seen = new Set<T>();
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const it = bucket[i];
          if (seen.has(it)) continue;
          seen.add(it);
          fn(it);
        }
      }
    }
  }
}

/** Пересечение отрезка движения с окружностью — чтобы быстрая пуля
 *  не "протыкала" цель между кадрами (continuous collision detection). */
export function segmentHitsCircle(
  x0: number, y0: number, x1: number, y1: number,
  cx: number, cy: number, r: number
): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-6) return fx * fx + fy * fy <= r * r;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}
