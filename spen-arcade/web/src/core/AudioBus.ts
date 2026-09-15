/**
 * Процедурный звук на WebAudio: ни одного файла в бандле.
 * Для AI Studio это важно — проект остаётся однофайловым и грузится мгновенно.
 */
export class AudioBus {
  private ac?: AudioContext;
  private master?: GainNode;
  muted = false;

  /** Обязательно вызвать из обработчика пользовательского жеста. */
  unlock() {
    if (this.ac) { void this.ac.resume(); return; }
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    this.ac = new AC();
    this.master = this.ac.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ac.destination);
  }

  private env(type: OscillatorType, f0: number, f1: number, dur: number, vol: number) {
    if (!this.ac || !this.master || this.muted) return;
    const t = this.ac.currentTime;
    const osc = this.ac.createOscillator();
    const g = this.ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, cutoff: number) {
    if (!this.ac || !this.master || this.muted) return;
    const t = this.ac.currentTime;
    const len = Math.floor(this.ac.sampleRate * dur);
    const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = this.ac.createGain();
    g.gain.value = vol;
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
  }

  shot()      { this.env('square', 880, 120, 0.09, 0.25); this.noise(0.08, 0.2, 2400); }
  hit()       { this.env('triangle', 520, 180, 0.16, 0.3); }
  explode()   { this.noise(0.45, 0.45, 900); this.env('sawtooth', 160, 40, 0.4, 0.25); }
  pickup()    { this.env('sine', 660, 1320, 0.14, 0.22); }
  boost()     { this.env('sawtooth', 180, 520, 0.28, 0.16); }
  fail()      { this.env('sawtooth', 300, 60, 0.7, 0.3); }
  tick()      { this.env('square', 1400, 1400, 0.03, 0.1); }
}
