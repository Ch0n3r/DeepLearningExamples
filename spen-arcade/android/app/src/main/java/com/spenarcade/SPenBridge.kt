package com.spenarcade

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.samsung.android.sdk.penremote.AirMotionEvent
import com.samsung.android.sdk.penremote.ButtonEvent
import com.samsung.android.sdk.penremote.SpenEvent
import com.samsung.android.sdk.penremote.SpenEventListener
import com.samsung.android.sdk.penremote.SpenRemote
import com.samsung.android.sdk.penremote.SpenUnit
import com.samsung.android.sdk.penremote.SpenUnitManager
import org.json.JSONObject
import kotlin.math.abs

/**
 * Мост между Samsung S Pen Remote SDK и веб-игрой в WebView.
 *
 * Двa независимых канала ввода объединяются в один поток состояния пера:
 *
 *  1. AIR MOTION (перо в воздухе, вне экрана) — SDK отдаёт ТОЛЬКО дельты
 *     угловой скорости (deltaX/deltaY в градусах за тик, ~60-120 Гц).
 *     Абсолютного угла наклона в воздухе не существует, поэтому мы сами
 *     интегрируем дельты в "виртуальный аттитюд" с утечкой к нулю
 *     (leaky integrator) — см. AttitudeIntegrator ниже.
 *
 *  2. HOVER TILT (перо над экраном, <~1.5 см) — MotionEvent даёт
 *     АБСОЛЮТНЫЙ угол AXIS_TILT + направление getOrientation().
 *     Это истина в последней инстанции, поэтому при hover мы плавно
 *     подтягиваем виртуальный аттитюд к реальному (complementary fusion)
 *     и одновременно обнуляем накопленный дрейф.
 *
 * Наружу (в JS) уходит единый кадр состояния 60 раз в секунду.
 */
class SPenBridge(
    private val context: Context,
    private val webView: WebView
) {
    companion object {
        private const val TAG = "SPenBridge"

        /** Сколько градусов наклона считаем "полным отклонением" (нормировка в [-1;1]). */
        private const val FULL_TILT_DEG = 35f

        /** Скорость утечки виртуального аттитюда к нулю, доля в секунду.
         *  Без неё перо "уплывает": дельты накапливают ошибку гироскопа. */
        private const val LEAK_PER_SEC = 0.55f

        /** Коэффициент доверия абсолютному hover-наклону при слиянии. */
        private const val HOVER_FUSION = 0.22f

        /** Дельты ниже этого порога — шум покоящегося пера. */
        private const val MOTION_DEADZONE_DEG = 0.06f

        /** Порог для "long press" кнопки стилуса, мс. */
        private const val LONG_PRESS_MS = 420L
    }

    // ---- состояние, читаемое из JS -----------------------------------------
    @Volatile private var tiltX = 0f          // [-1;1], + = вправо
    @Volatile private var tiltY = 0f          // [-1;1], + = вниз (нос самолёта вниз)
    @Volatile private var rawPitchDeg = 0f
    @Volatile private var rawRollDeg = 0f
    @Volatile private var buttonDown = false
    @Volatile private var hovering = false
    @Volatile private var hoverX = 0f         // нормированные координаты курсора пера
    @Volatile private var hoverY = 0f
    @Volatile private var hoverDistance = 0f  // 0 = касание, 1 = край зоны hover
    @Volatile private var pressure = 0f
    @Volatile private var seq = 0L

    private var buttonDownAt = 0L
    private var lastMotionNs = 0L

    private var spenRemote: SpenRemote? = null
    private var unitManager: SpenUnitManager? = null
    private val main = Handler(Looper.getMainLooper())

    // ------------------------------------------------------------------------
    // Подключение к SDK
    // ------------------------------------------------------------------------
    fun connect(onReady: (Boolean) -> Unit) {
        val remote = SpenRemote.getInstance()
        spenRemote = remote

        if (!remote.isFeatureEnabled(SpenRemote.FEATURE_TYPE_AIR_MOTION)) {
            // Устройство без Air Actions (S21 обычный, Tab и т.п.) — не фатально:
            // игра переключится на hover-наклон, а в браузере — на мышь/гироскоп.
            Log.w(TAG, "Air motion недоступен на этом устройстве")
        }

        remote.connect(context, object : SpenRemote.ConnectionStateChangeListener {
            override fun onConnected(manager: SpenUnitManager) {
                unitManager = manager
                registerAirMotion(manager)
                registerButton(manager)
                onReady(true)
            }

            override fun onDisconnected() {
                unitManager = null
                onReady(false)
            }
        })
    }

    private fun registerAirMotion(manager: SpenUnitManager) {
        val unit: SpenUnit = manager.getUnit(SpenUnit.TYPE_AIR_MOTION) ?: return
        manager.registerSpenEventListener(SpenEventListener { event: SpenEvent ->
            val air = AirMotionEvent(event)
            val now = System.nanoTime()
            val dt = if (lastMotionNs == 0L) 1f / 90f
                     else ((now - lastMotionNs) / 1e9f).coerceIn(1f / 240f, 0.05f)
            lastMotionNs = now
            integrateAirMotion(air.deltaX, air.deltaY, dt)
        }, unit)
    }

    private fun registerButton(manager: SpenUnitManager) {
        val unit: SpenUnit = manager.getUnit(SpenUnit.TYPE_BUTTON) ?: return
        manager.registerSpenEventListener(SpenEventListener { event: SpenEvent ->
            when (ButtonEvent(event).action) {
                ButtonEvent.ACTION_DOWN -> {
                    buttonDown = true
                    buttonDownAt = System.currentTimeMillis()
                    emitDiscrete("button_down", 0L)
                }
                ButtonEvent.ACTION_UP -> {
                    buttonDown = false
                    val held = System.currentTimeMillis() - buttonDownAt
                    emitDiscrete(if (held >= LONG_PRESS_MS) "button_long" else "button_tap", held)
                }
            }
        }, unit)
    }

    /**
     * Интегрирование дельт воздушного жеста в виртуальный угол наклона.
     *
     * Модель: угол += дельта, затем экспоненциальная утечка к нулю.
     * Утечка делает управление "самоцентрирующимся" — игрок возвращает перо
     * в нейтраль естественным движением, а не ищет точку калибровки.
     */
    private fun integrateAirMotion(deltaX: Float, deltaY: Float, dt: Float) {
        val dx = if (abs(deltaX) < MOTION_DEADZONE_DEG) 0f else deltaX
        val dy = if (abs(deltaY) < MOTION_DEADZONE_DEG) 0f else deltaY

        val leak = Math.pow((1f - LEAK_PER_SEC).toDouble(), dt.toDouble()).toFloat()

        rawRollDeg = (rawRollDeg + dx) * leak
        rawPitchDeg = (rawPitchDeg + dy) * leak

        rawRollDeg = rawRollDeg.coerceIn(-FULL_TILT_DEG * 1.6f, FULL_TILT_DEG * 1.6f)
        rawPitchDeg = rawPitchDeg.coerceIn(-FULL_TILT_DEG * 1.6f, FULL_TILT_DEG * 1.6f)

        tiltX = (rawRollDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        tiltY = (rawPitchDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        seq++
    }

    /**
     * Вызывается из HoverTiltTracker, когда перо висит над экраном.
     * Абсолютный наклон пересиливает накопленный дрейф гироскопа.
     */
    fun onHoverTilt(tiltRad: Float, orientationRad: Float, distance: Float,
                    nx: Float, ny: Float, press: Float) {
        hovering = true
        hoverX = nx
        hoverY = ny
        hoverDistance = distance
        pressure = press

        // AXIS_TILT — угол от перпендикуляра к экрану; getOrientation() — куда наклонён.
        val deg = Math.toDegrees(tiltRad.toDouble()).toFloat()
        val ax = (deg * Math.sin(orientationRad.toDouble())).toFloat()
        val ay = (-deg * Math.cos(orientationRad.toDouble())).toFloat()

        rawRollDeg += (ax - rawRollDeg) * HOVER_FUSION
        rawPitchDeg += (ay - rawPitchDeg) * HOVER_FUSION

        tiltX = (rawRollDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        tiltY = (rawPitchDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        seq++
    }

    fun onHoverExit() {
        hovering = false
    }

    /** Сброс нейтрали — вызывается игрой при старте раунда. */
    @JavascriptInterface
    fun calibrate() {
        rawPitchDeg = 0f
        rawRollDeg = 0f
        tiltX = 0f
        tiltY = 0f
    }

    /**
     * Единственный метод, который JS дёргает каждый кадр.
     * Возвращаем JSON-строку, а не объект — @JavascriptInterface не умеет
     * структуры, а строка парсится за ~10 мкс и не создаёт GC-давления.
     */
    @JavascriptInterface
    fun pollState(): String = JSONObject().apply {
        put("ok", true)
        put("tiltX", tiltX)
        put("tiltY", tiltY)
        put("button", buttonDown)
        put("hover", hovering)
        put("hx", hoverX)
        put("hy", hoverY)
        put("hdist", hoverDistance)
        put("pressure", pressure)
        put("seq", seq)
        put("airMotion", spenRemote?.isFeatureEnabled(SpenRemote.FEATURE_TYPE_AIR_MOTION) ?: false)
    }.toString()

    @JavascriptInterface
    fun vibrate(ms: Int) = Haptics.buzz(context, ms)

    /** Дискретные события кнопки — пушим в JS, чтобы не терять быстрые тапы между кадрами. */
    private fun emitDiscrete(kind: String, held: Long) {
        val js = "window.__spen && window.__spen.onEvent('$kind', $held);"
        main.post { webView.evaluateJavascript(js, null) }
    }

    fun disconnect() {
        unitManager?.let { m ->
            m.getUnit(SpenUnit.TYPE_AIR_MOTION)?.let { m.unregisterSpenEventListener(it) }
            m.getUnit(SpenUnit.TYPE_BUTTON)?.let { m.unregisterSpenEventListener(it) }
        }
        spenRemote?.disconnect(context)
        spenRemote = null
        unitManager = null
    }
}
