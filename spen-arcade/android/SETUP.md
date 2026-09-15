# Как получить APK

## Вариант 1 — GitHub Actions (ничего ставить не нужно)

1. Запушить репозиторий на GitHub.
2. Actions → **S Pen Arcade APK** → **Run workflow**.
3. Через ~4 минуты скачать `spen-arcade-apk` из артефактов сборки.
4. Перекинуть `.apk` на телефон и установить (потребуется разрешить
   установку из неизвестных источников).

APK подписан debug-ключом — для личной установки этого достаточно,
для публикации в Play нужен свой keystore.

## Вариант 2 — локально

Нужны JDK 17 и Android SDK (проще всего — Android Studio).

```bash
cd spen-arcade/web
npm ci && npm run build          # соберёт dist/index.html (~49 КБ)

cd ../android
./gradlew assembleRelease
# app/build/outputs/apk/release/app-release.apk
```

Gradle сам копирует веб-сборку в assets и остановится с внятной ошибкой,
если её забыли собрать.

## Про Samsung S Pen SDK

**Скачивать ничего не обязательно.** `SPenBridge` обращается к SDK через
рефлексию и корректно переживает его отсутствие, поэтому APK собирается
на пустом CI без единого файла от Samsung.

Что это значит на практике:

| Режим | Нужен AAR | Когда работает |
|---|---|---|
| **Hover-наклон** | нет | перо в пределах ~1.5 см над экраном; абсолютный угол из `MotionEvent.AXIS_TILT` |
| **Air Actions** | да | перо где угодно в воздухе; дельты от `AirMotionEvent` |

Чтобы включить второй режим:

1. `developer.samsung.com/galaxy-spen-remote` → скачать `SpenRemoteSDK.zip`
2. Достать `spen-remote-v1.0.1.aar`
3. Положить в `app/libs/` и пересобрать

Gradle подхватит любой `*.aar` из этой папки автоматически — правки в
`build.gradle.kts` не нужны.

Устройства с Air Actions: Galaxy Note10/20, S21 Ultra и новее, Z Fold3+,
Tab S6+ и новее. На остальных `isFeatureEnabled` вернёт `false`, и игра
сама останется на hover-наклоне.

## Отладка ввода

В debug-сборке включена WebView-отладка: `chrome://inspect` на десктопе,
телефон по USB. В хабе внизу подписан активный источник ввода
(`S Pen (SDK)` / `стилус (PointerEvent)` / `гироскоп` / `мышь`) — это первое,
что стоит смотреть, если управление ведёт себя не так.
