import { TAU } from './math';

export interface Pt { x: number; y: number; }
export interface Template { name: string; points: Pt[]; }
export interface Match { name: string; score: number; }

/**
 * $1 Unistroke Recognizer (Wobbrock, Wilson, Li — UIST 2007), TypeScript.
 *
 * Зачем такой алгоритм, а не нейросеть: он работает по одному эталону на жест,
 * не требует обучения, распознаёт за ~0.3 мс и устойчив к масштабу, повороту
 * и скорости рисования. Ровно то, что нужно, когда игрок «пишет» руну в воздухе
 * наклоном пера — линия всегда кривая, дрожащая и разного размера.
 *
 * Конвейер: ресемплинг → поворот по «индикативному углу» → масштаб в квадрат →
 * центрирование → золотое сечение по углу поворота для минимальной дистанции.
 */
export class GestureRecognizer {
  private templates: Template[] = [];

  private static readonly N = 64;          // точек после ресемплинга
  private static readonly SQUARE = 250;    // сторона нормировочного квадрата
  private static readonly HALF_DIAGONAL = 0.5 * Math.sqrt(2 * 250 * 250);
  private static readonly ANGLE_RANGE = (45 * Math.PI) / 180;
  private static readonly ANGLE_PRECISION = (2 * Math.PI) / 180;
  private static readonly PHI = 0.5 * (-1 + Math.sqrt(5));

  addTemplate(name: string, points: Pt[]) {
    this.templates.push({ name, points: GestureRecognizer.normalize(points) });
  }

  /** Возвращает лучший матч; score в [0;1], где 1 — идеальное совпадение. */
  recognize(points: Pt[]): Match | null {
    if (points.length < 10 || this.templates.length === 0) return null;
    const candidate = GestureRecognizer.normalize(points);

    let best = Infinity;
    let bestName = '';
    for (const t of this.templates) {
      const d = GestureRecognizer.distanceAtBestAngle(candidate, t.points);
      if (d < best) { best = d; bestName = t.name; }
    }
    const score = 1 - best / GestureRecognizer.HALF_DIAGONAL;
    return { name: bestName, score };
  }

  // ---------- конвейер нормализации ----------
  private static normalize(points: Pt[]): Pt[] {
    let p = GestureRecognizer.resample(points, GestureRecognizer.N);
    p = GestureRecognizer.rotateBy(p, -GestureRecognizer.indicativeAngle(p));
    p = GestureRecognizer.scaleTo(p, GestureRecognizer.SQUARE);
    return GestureRecognizer.translateToOrigin(p);
  }

  /** Равномерная переразметка по длине дуги: убирает влияние скорости рисования. */
  private static resample(points: Pt[], n: number): Pt[] {
    const I = GestureRecognizer.pathLength(points) / (n - 1);
    let D = 0;
    const src = points.slice();
    const out: Pt[] = [src[0]];
    for (let i = 1; i < src.length; i++) {
      const d = GestureRecognizer.dist(src[i - 1], src[i]);
      if (D + d >= I) {
        const t = (I - D) / d;
        const q = {
          x: src[i - 1].x + t * (src[i].x - src[i - 1].x),
          y: src[i - 1].y + t * (src[i].y - src[i - 1].y),
        };
        out.push(q);
        src.splice(i, 0, q);  // продолжаем с новой точки
        D = 0;
      } else {
        D += d;
      }
    }
    while (out.length < n) out.push(src[src.length - 1]);
    return out.slice(0, n);
  }

  /** Угол от центроида к первой точке — опорное направление жеста. */
  private static indicativeAngle(points: Pt[]) {
    const c = GestureRecognizer.centroid(points);
    return Math.atan2(c.y - points[0].y, c.x - points[0].x);
  }

  private static rotateBy(points: Pt[], rad: number): Pt[] {
    const c = GestureRecognizer.centroid(points);
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return points.map(p => ({
      x: (p.x - c.x) * cos - (p.y - c.y) * sin + c.x,
      y: (p.x - c.x) * sin + (p.y - c.y) * cos + c.y,
    }));
  }

  private static scaleTo(points: Pt[], size: number): Pt[] {
    const b = GestureRecognizer.boundingBox(points);
    const sx = b.w > 1e-6 ? size / b.w : 1;
    const sy = b.h > 1e-6 ? size / b.h : 1;
    return points.map(p => ({ x: p.x * sx, y: p.y * sy }));
  }

  private static translateToOrigin(points: Pt[]): Pt[] {
    const c = GestureRecognizer.centroid(points);
    return points.map(p => ({ x: p.x - c.x, y: p.y - c.y }));
  }

  /**
   * Поиск угла, при котором жест ближе всего к эталону.
   * Золотое сечение вместо полного перебора: ~10 итераций вместо 90.
   */
  private static distanceAtBestAngle(pts: Pt[], tpl: Pt[]) {
    let a = -GestureRecognizer.ANGLE_RANGE;
    let b = GestureRecognizer.ANGLE_RANGE;
    const phi = GestureRecognizer.PHI;
    let x1 = phi * a + (1 - phi) * b;
    let f1 = GestureRecognizer.distanceAtAngle(pts, tpl, x1);
    let x2 = (1 - phi) * a + phi * b;
    let f2 = GestureRecognizer.distanceAtAngle(pts, tpl, x2);

    while (Math.abs(b - a) > GestureRecognizer.ANGLE_PRECISION) {
      if (f1 < f2) {
        b = x2; x2 = x1; f2 = f1;
        x1 = phi * a + (1 - phi) * b;
        f1 = GestureRecognizer.distanceAtAngle(pts, tpl, x1);
      } else {
        a = x1; x1 = x2; f1 = f2;
        x2 = (1 - phi) * a + phi * b;
        f2 = GestureRecognizer.distanceAtAngle(pts, tpl, x2);
      }
    }
    return Math.min(f1, f2);
  }

  private static distanceAtAngle(pts: Pt[], tpl: Pt[], rad: number) {
    return GestureRecognizer.pathDistance(GestureRecognizer.rotateBy(pts, rad), tpl);
  }

  private static pathDistance(a: Pt[], b: Pt[]) {
    let d = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) d += GestureRecognizer.dist(a[i], b[i]);
    return d / n;
  }

  // ---------- мелочь ----------
  private static dist(a: Pt, b: Pt) { return Math.hypot(b.x - a.x, b.y - a.y); }
  private static pathLength(p: Pt[]) {
    let d = 0;
    for (let i = 1; i < p.length; i++) d += GestureRecognizer.dist(p[i - 1], p[i]);
    return d;
  }
  private static centroid(p: Pt[]): Pt {
    let x = 0, y = 0;
    for (const q of p) { x += q.x; y += q.y; }
    return { x: x / p.length, y: y / p.length };
  }
  private static boundingBox(p: Pt[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of p) {
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
}

/** Эталоны рун. Точки заданы «на глаз» в квадрате 100x100 — $1 всё нормирует. */
export function buildRuneTemplates(): Record<string, Pt[]> {
  const line = (x0: number, y0: number, x1: number, y1: number, n = 12): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      out.push({ x: x0 + (x1 - x0) * (i / n), y: y0 + (y1 - y0) * (i / n) });
    }
    return out;
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 24): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return out;
  };

  return {
    // Огонь: зигзаг-молния
    fire: [...line(20, 10, 70, 40), ...line(70, 40, 35, 55), ...line(35, 55, 85, 92)],
    // Лёд: треугольник вершиной вверх
    ice: [...line(50, 10, 90, 88), ...line(90, 88, 10, 88), ...line(10, 88, 50, 10)],
    // Щит: дуга-полукруг
    shield: arc(50, 50, 40, Math.PI, TAU),
    // Молния-цепь: горизонтальная змейка
    chain: [...line(10, 50, 35, 25), ...line(35, 25, 60, 75), ...line(60, 75, 90, 45)],
    // Воронка: спираль внутрь
    vortex: (() => {
      const out: Pt[] = [];
      for (let i = 0; i <= 70; i++) {
        const t = i / 70;
        const a = t * TAU * 2.2;
        const r = 45 * (1 - t * 0.85);
        out.push({ x: 50 + Math.cos(a) * r, y: 50 + Math.sin(a) * r });
      }
      return out;
    })(),
  };
}
