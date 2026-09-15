# Сборка Android-оболочки

## 1. S Pen Remote SDK

Maven-репозитория у Samsung нет — SDK отдаётся архивом:

1. `developer.samsung.com/galaxy-spen-remote` → скачать `SpenRemoteSDK.zip`
2. Из архива взять `spen-remote-v1.0.1.aar`
3. Положить в `app/libs/spen-remote-v1.0.1.aar`

Поддерживаемые устройства (Air Actions): Galaxy Note10/20, S21 Ultra и новее,
Z Fold3+, Tab S6+ и новее. На остальных `isFeatureEnabled(FEATURE_TYPE_AIR_MOTION)`
вернёт `false` — приложение автоматически перейдёт на hover-наклон через
`MotionEvent.AXIS_TILT`, игра останется играбельной.

## 2. Веб-часть

```bash
cd ../web
npm install
npm run build          # соберёт один dist/index.html (~49 КБ)
mkdir -p ../android/app/src/main/assets/game
cp dist/index.html ../android/app/src/main/assets/game/
```

`vite-plugin-singlefile` инлайнит весь JS/CSS, поэтому в assets кладётся
ровно один файл и никаких путей к чанкам чинить не нужно.

## 3. Сборка APK

```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Отладка ввода

WebView-отладка включена в debug-сборке: открыть `chrome://inspect` на десктопе,
подключить телефон по USB. В хабе внизу экрана подписан активный источник ввода
(`S Pen (SDK)` / `стилус (PointerEvent)` / `гироскоп` / `мышь`) — это первое,
что стоит проверять, если управление ведёт себя не так.
