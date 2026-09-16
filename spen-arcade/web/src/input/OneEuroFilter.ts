/**
 * One Euro Filter (Casiez, Roussel, Vogel, CHI 2012).
 *
 * Зачем он здесь: сырой наклон стилуса дрожит на ±2-3° даже у неподвижной руки.
 * Обычный low-pass убирает дрожь, но добавляет лаг — в аркаде это смерть.
 * One Euro адаптирует частоту среза к скорости сигнала: медленно двигаешь —
 * фильтруем жёстко (нет дрожи), резко дёрнул — фильтр почти прозрачен (нет лага).
 *
 * minCutoff — сколько сглаживания в покое (меньше = спокойнее, но вязче)
 * beta      — насколько быстро фильтр "отпускает" при резком движении
 */
export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private started = false;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.007,
    private dCutoff = 1.0
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, dt: number): number {
    if (dt <= 0) return this.xPrev;
    if (!this.started) {
      this.started = true;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    // 1) оценка производной, сама сглаженная
    const dxRaw = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dx = aD * dxRaw + (1 - aD) * this.dxPrev;
    this.dxPrev = dx;

    // 2) частота среза растёт вместе со скоростью
    const cutoff = this.minCutoff + this.beta * Math.abs(dx);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const out = a * x + (1 - a) * this.xPrev;
    this.xPrev = out;
    return out;
  }

  reset(value = 0) {
    this.started = false;
    this.xPrev = value;
    this.dxPrev = 0;
  }
}
