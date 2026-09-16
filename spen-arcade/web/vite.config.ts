import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Собираем в ОДИН index.html: так сборку можно просто положить
// в android/app/src/main/assets/game/ без возни с путями к чанкам.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2020', assetsInlineLimit: 100_000_000, cssCodeSplit: false },
});
