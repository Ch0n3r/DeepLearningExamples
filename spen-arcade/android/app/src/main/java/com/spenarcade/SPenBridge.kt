package com.spenarcade

import android.app.Activity
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
 * Два независимых канала ввода сводятся в один поток состояния пера:
 *
 *  1. AIR MOTION (перо в воздухе) — SDK отдаёт ТОЛЬКО дельты угловой скорости
 *     (deltaX/deltaY в градусах за тик). Абсолютного наклона в воздухе не
 *     существует: гироскоп пера не знает, где «ноль». Поэтому дельты
 *     интегрируются с утечкой к нулю — см. integrateAirMotion.
 *
 *  2. HOVER TILT (перо над экраном, <~1.5 см) — MotionEvent.AXIS_TILT даёт
 *     честный АБСОЛЮТНЫЙ угол. Он же гасит накопленный дрейф первого канала.
 *
 * Два подвоха этого SDK, стоящие отдельного упоминания:
 *  - connect() принимает ТОЛЬКО Activity-контекст (сам SDK проверяет это
 *    и иначе бросает исключение), поэтому конструктор требует Activity.
 *  - SDK биндится к сервису пакета com.samsung.android.service.aircommand,
 *    значит на Android 11+ нужен <queries> в манифесте, иначе система просто
 *    скроет сервис и связь не установится.
 */
class SPenBridge(
    private val activity: Activity,
    private val webView: WebView
) {
    companion object {
        private const val TAG = "SPenBridge"

        /** Сколько градусов наклона считаем «полным отклонением». */
        private const val FULL_TILT_DEG = 35f
        /** Утечка виртуального аттитюда к нулю, доля в секунду. */
        private const val LEAK_PER_SEC = 0.55f
        /** Доверие абсолютному hover-наклону при слиянии каналов. */
        private const val HOVER_FUSION = 0.22f
        /** Дельты ниже порога — шум покоящегося пера. */
        private const val MOTION_DEADZONE_DEG = 0.06f
        private const val LONG_PRESS_MS = 420L
    }

    // ---- состояние, читаемое из JS ------------------------------------------
    @Volatile private var tiltX = 0f
    @Volatile private var tiltY = 0f
    @Volatile private var rawPitchDeg = 0f
    @Volatile private var rawRollDeg = 0f
    @Volatile private var buttonDown = false
    @Volatile private var hovering = false
    @Volatile private var hoverX = 0.5f
    @Volatile private var hoverY = 0.5f
    @Volatile private var hoverDistance = 1f
    @Volatile private var pressure = 0f
    @Volatile private var seq = 0L
    @Volatile private var airMotionAvailable = false
    @Volatile private var connected = false

    private var buttonDownAt = 0L
    private var lastMotionNs = 0L

    private var unitManager: SpenUnitManager? = null
    private var airMotionUnit: SpenUnit? = null
    private var buttonUnit: SpenUnit? = null

    /**
     * Поднимаем SDK. Неудача — не ошибка, а штатный сценарий: на устройстве
     * без Air Actions игра работает на hover-наклоне.
     */
    fun connect(onReady: (Boolean) -> Unit) {
        val remote = try {
            SpenRemote.getInstance()
        } catch (e: Throwable) {
            Log.w(TAG, "S Pen Framework недоступен: ${e.message}")
            onReady(false)
            return
        }

        airMotionAvailable = remote.isFeatureEnabled(SpenRemote.FEATURE_TYPE_AIR_MOTION)
        if (!airMotionAvailable) {
            Log.w(TAG, "Air Actions не поддерживаются этим устройством")
        }

        remote.setConnectionStateChangeListener { state ->
            connected = state == SpenRemote.State.CONNECTED
            if (!connected) {
                unitManager = null
                Log.i(TAG, "S Pen отключился, состояние=$state")
            }
        }

        try {
            remote.connect(activity, object : SpenRemote.ConnectionResultCallback {
                override fun onSuccess(manager: SpenUnitManager) {
                    unitManager = manager
                    connected = true
                    registerAirMotion(manager)
                    registerButton(manager)
                    webView.post { onReady(true) }
                }

                override fun onFailure(error: Int) {
                    val reason = when (error) {
                        SpenRemote.Error.UNSUPPORTED_DEVICE -> "устройство не поддерживается"
                        SpenRemote.Error.CONNECTION_FAILED -> "не удалось подключиться"
                        else -> "неизвестная ошибка ($error)"
                    }
                    Log.w(TAG, "S Pen Remote недоступен: $reason")
                    webView.post { onReady(false) }
                }
            })
        } catch (e: Throwable) {
            Log.w(TAG, "connect() упал: ${e.message}")
            onReady(false)
        }
    }

    private fun registerAirMotion(manager: SpenUnitManager) {
        val unit = manager.getUnit(SpenUnit.TYPE_AIR_MOTION) ?: return
        airMotionUnit = unit
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
        val unit = manager.getUnit(SpenUnit.TYPE_BUTTON) ?: return
        buttonUnit = unit
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
     * Угол += дельта, затем экспоненциальная утечка к нулю. Утечка делает
     * управление самоцентрирующимся: игрок возвращает перо в нейтраль
     * естественным движением, а не ищет точку калибровки.
     */
    private fun integrateAirMotion(deltaX: Float, deltaY: Float, dt: Float) {
        val dx = if (abs(deltaX) < MOTION_DEADZONE_DEG) 0f else deltaX
        val dy = if (abs(deltaY) < MOTION_DEADZONE_DEG) 0f else deltaY

        val leak = Math.pow((1f - LEAK_PER_SEC).toDouble(), dt.toDouble()).toFloat()
        rawRollDeg = (rawRollDeg + dx) * leak
        rawPitchDeg = (rawPitchDeg + dy) * leak

        val cap = FULL_TILT_DEG * 1.6f
        rawRollDeg = rawRollDeg.coerceIn(-cap, cap)
        rawPitchDeg = rawPitchDeg.coerceIn(-cap, cap)

        tiltX = (rawRollDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        tiltY = (rawPitchDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        seq++
    }

    /**
     * Вызывается из HoverTiltTracker, пока перо висит над экраном.
     * Абсолютный наклон пересиливает накопленный дрейф гироскопа.
     */
    fun onHoverTilt(tiltRad: Float, orientationRad: Float, distance: Float,
                    nx: Float, ny: Float, press: Float) {
        hovering = true
        hoverX = nx
        hoverY = ny
        hoverDistance = distance
        pressure = press

        // AXIS_TILT — угол от перпендикуляра к экрану, getOrientation() — куда наклонён.
        val deg = Math.toDegrees(tiltRad.toDouble()).toFloat()
        val ax = (deg * Math.sin(orientationRad.toDouble())).toFloat()
        val ay = (-deg * Math.cos(orientationRad.toDouble())).toFloat()

        rawRollDeg += (ax - rawRollDeg) * HOVER_FUSION
        rawPitchDeg += (ay - rawPitchDeg) * HOVER_FUSION

        tiltX = (rawRollDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        tiltY = (rawPitchDeg / FULL_TILT_DEG).coerceIn(-1f, 1f)
        seq++
    }

    fun onHoverExit() { hovering = false }

    /**
     * Боковая кнопка, пойманная как MotionEvent. Нужна, пока SDK не подключён:
     * на устройствах без Air Actions это единственный источник нажатий.
     */
    fun onStylusButton(down: Boolean) {
        if (connected) return  // при живом SDK источник истины — он
        if (down && !buttonDown) {
            buttonDown = true
            buttonDownAt = System.currentTimeMillis()
            emitDiscrete("button_down", 0L)
        } else if (!down && buttonDown) {
            buttonDown = false
            val held = System.currentTimeMillis() - buttonDownAt
            emitDiscrete(if (held >= LONG_PRESS_MS) "button_long" else "button_tap", held)
        }
    }

    @JavascriptInterface
    fun calibrate() {
        rawPitchDeg = 0f; rawRollDeg = 0f
        tiltX = 0f; tiltY = 0f
    }

    /**
     * Единственный метод, который JS дёргает каждый кадр.
     * Возвращаем JSON-строку: @JavascriptInterface не умеет структуры,
     * а строка парсится за ~10 мкс и не создаёт GC-давления.
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
        put("airMotion", airMotionAvailable && connected)
    }.toString()

    @JavascriptInterface
    fun vibrate(ms: Int) = Haptics.buzz(activity, ms)

    /** Дискретные события кнопки пушим в JS, чтобы не терять быстрые тапы между кадрами. */
    private fun emitDiscrete(kind: String, held: Long) {
        val js = "window.__spen && window.__spen.onEvent('$kind', $held);"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    fun disconnect() {
        try {
            unitManager?.let { m ->
                airMotionUnit?.let { m.unregisterSpenEventListener(it) }
                buttonUnit?.let { m.unregisterSpenEventListener(it) }
            }
            SpenRemote.getInstance().disconnect(activity)
        } catch (e: Throwable) {
            Log.w(TAG, "disconnect(): ${e.message}")
        }
        unitManager = null
        airMotionUnit = null
        buttonUnit = null
        connected = false
    }
}
