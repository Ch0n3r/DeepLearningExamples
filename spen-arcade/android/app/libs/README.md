Сюда кладётся `spen-remote-v1.0.1.aar` с developer.samsung.com/galaxy-spen-remote,
если нужно управление наклоном пера **в воздухе** (Air Actions).

Без этого файла APK собирается и работает: наклон читается из
`MotionEvent.AXIS_TILT`, пока перо находится в зоне hover над экраном.
