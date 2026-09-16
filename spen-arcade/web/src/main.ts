import { Engine } from './core/Engine';
import { Renderer } from './core/Renderer';
import { AudioBus } from './core/AudioBus';
import { PenInput } from './input/PenInput';
import { Hub } from './games/Hub';
import { SkyDrifter } from './games/SkyDrifter';
import { TiltRacer } from './games/TiltRacer';
import { BirdHunt } from './games/BirdHunt';
import { InkRunes } from './games/InkRunes';
import { Calibrate } from './games/Calibrate';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const gate = document.getElementById('gate') as HTMLDivElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;

const renderer = new Renderer(canvas);
const audio = new AudioBus();
const input = new PenInput(canvas);

const engine = new Engine(input, renderer, audio)
  .register(new Hub())
  .register(new SkyDrifter())
  .register(new TiltRacer())
  .register(new BirdHunt())
  .register(new InkRunes())
  .register(new Calibrate());

/**
 * Стартовый экран обязателен: WebAudio и DeviceOrientation в вебе
 * разрешено включать только из пользовательского жеста.
 */
startBtn.addEventListener('click', async () => {
  audio.unlock();
  await input.enableGyro();
  input.calibrate();
  gate.style.display = 'none';
  engine.start('hub');
}, { once: true });

// Пауза при сворачивании — иначе накопитель кадров догоняет полсекунды физики.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) engine.stop();
});
