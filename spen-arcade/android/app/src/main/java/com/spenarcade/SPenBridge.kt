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

        /** Сколько градусов hover-наклона считаем «полным отклонением». */
        private const val FULL_TILT_DEG = 32f
        /** Утечка накопленного отклонения к нулю, доля в секунду. */
        private const val LEAK_PER_SEC = 0.55f
        /** Доверие абсолютному hover-наклону при слиянии каналов. */
        private const val HOVER_FUSION = 0.25f
        private const val LONG_PRESS_MS = 420L

        /**
         * Во что превращать дельты air motion.
         *
         * getDeltaX/getDeltaY отдают НЕ градусы, а долю в диапазоне -1..1, где
         * 1.0 — это примерно «провести пером через весь экран». Реальные
         * значения за событие — тысячные и сотые. Здесь накапливаем их
         * в отклонение [-1;1], где комфортный взмах кистью (суммарно ~0.35)
         * даёт полное отклонение.
         */
        private const val AIR_GAIN = 3.0f
    }

    // ---- состояние, читаемое из JS ------------------------------------------
    @Volatile private var tiltX = 0f
    @Volatile private var tiltY = 0f
    @Volatile private var buttonDown = false
    @Volatile private var hovering = false
    @Volatile private var hoverX = 0.5f
    @Volatile private var hoverY = 0.5f
    @Volatile private var hoverDistance = 1f
    @Volatile private var pressure = 0f
    @Volatile private var seq = 0L
    @Volatile private var airMotionAvailable = false
    @Volatile private var connected = false

    // Абсолютный наклон, как его отдаёт hover, и запомненная нейтраль.
    // Перо в руке естественно лежит под 40-50° к перпендикуляру экрана,
    // поэтому «ноль» — это НЕ вертикальное перо, а то положение, в котором
    // игрок держал стилус в момент калибровки.
    @Volatile private var absRollDeg = 0f
    @Volatile private var absPitchDeg = 0f
    @Volatile private var biasRollDeg = 0f
    @Volatile private var biasPitchDeg = 0f
    @Volatile private var hoverSeen = false

    /** Канал air motion в нормированных единицах [-1;1]. */
    @Volatile private var airX = 0f
    @Volatile private var airY = 0f

    // Диагностика: без неё невозможно отличить «события не приходят»
    // от «приходят, но мы их неправильно масштабируем».
    @Volatile private var airEvents = 0L
    @Volatile private var lastDx = 0f
    @Volatile private var lastDy = 0f
    @Volatile private var maxDelta = 0f

    private var buttonDownAt = 0L
    private var lastPollNs = 0L

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
            accumulateAirMotion(air.deltaX, air.deltaY)
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
     * Накопление дельт воздушного жеста в отклонение.
     *
     * Никакой мёртвой зоны здесь нет намеренно: дельты приходят порядка
     * тысячных, и любой осмысленный порог просто съел бы весь сигнал.
     * Дрожь гасится утечкой в decay() и фильтром One Euro на стороне игры.
     *
     * Утечка живёт НЕ здесь, а в decay(), который тикает каждый кадр:
     * иначе, когда игрок перестаёт двигать пером, события прекращаются
     * и последнее отклонение застывает навсегда.
     */
    private fun accumulateAirMotion(deltaX: Float, deltaY: Float) {
        airEvents++
        lastDx = deltaX
        lastDy = deltaY
        val mag = maxOf(abs(deltaX), abs(deltaY))
        if (mag > maxDelta) maxDelta = mag

        airX = (airX + deltaX * AIR_GAIN).coerceIn(-1.4f, 1.4f)
        airY = (airY + deltaY * AIR_GAIN).coerceIn(-1.4f, 1.4f)
        publish()
    }

    /** Сводит оба канала в итоговый наклон. Hover, когда он есть, — истина. */
    private fun publish() {
        if (hovering) {
            val hx = ((absRollDeg - biasRollDeg) / FULL_TILT_DEG).coerceIn(-1f, 1f)
            val hy = ((absPitchDeg - biasPitchDeg) / FULL_TILT_DEG).coerceIn(-1f, 1f)
            // Держим air-канал синхронно, чтобы при выходе из hover
            // управление не прыгнуло на старое накопленное значение.
            airX += (hx - airX) * HOVER_FUSION
            airY += (hy - airY) * HOVER_FUSION
            tiltX = hx
            tiltY = hy
        } else {
            tiltX = airX.coerceIn(-1f, 1f)
            tiltY = airY.coerceIn(-1f, 1f)
        }
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
        // Раскладываем на две оси так же, как это делает PointerEvent в вебе.
        val deg = Math.toDegrees(tiltRad.toDouble()).toFloat()
        absRollDeg = (deg * Math.sin(orientationRad.toDouble())).toFloat()
        absPitchDeg = (-deg * Math.cos(orientationRad.toDouble())).toFloat()

        // Первое же hover-событие задаёт нейтраль, если её ещё не брали:
        // иначе игрок стартует с максимальным отклонением в одну сторону.
        if (!hoverSeen) {
            hoverSeen = true
            biasRollDeg = absRollDeg
            biasPitchDeg = absPitchDeg
        }

        publish()
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

    /** Текущее положение пера принимается за нейтраль по обоим каналам. */
    @JavascriptInterface
    fun calibrate() {
        airX = 0f; airY = 0f
        tiltX = 0f; tiltY = 0f
        if (hoverSeen) {
            biasRollDeg = absRollDeg
            biasPitchDeg = absPitchDeg
        }
    }

    /** Сырые значения для экрана диагностики в игре. */
    @JavascriptInterface
    fun debugState(): String = JSONObject().apply {
        put("absRoll", absRollDeg)
        put("absPitch", absPitchDeg)
        put("biasRoll", biasRollDeg)
        put("biasPitch", biasPitchDeg)
        put("airX", airX)
        put("airY", airY)
        put("airEvents", airEvents)
        put("lastDx", lastDx)
        put("lastDy", lastDy)
        put("maxDelta", maxDelta)
        put("connected", connected)
        put("airMotion", airMotionAvailable)
        put("hoverSeen", hoverSeen)
    }.toString()

    /**
     * Единственный метод, который JS дёргает каждый кадр.
     * Возвращаем JSON-строку: @JavascriptInterface не умеет структуры,
     * а строка парсится за ~10 мкс и не создаёт GC-давления.
     */
    /**
     * Утечка накопленного отклонения к нулю. Тикает каждый кадр из pollState.
     *
     * Делает управление самоцентрирующимся: игрок возвращает перо в нейтраль
     * естественным движением, а не ищет точку калибровки. И заодно
     * не даёт отклонению застыть, когда события перестали приходить.
     */
    private fun decay() {
        val now = System.nanoTime()
        val dt = if (lastPollNs == 0L) 0f
                 else ((now - lastPollNs) / 1e9f).coerceIn(0f, 0.25f)
        lastPollNs = now
        if (dt <= 0f || hovering) return

        val leak = Math.pow((1f - LEAK_PER_SEC).toDouble(), dt.toDouble()).toFloat()
        airX *= leak
        airY *= leak
        tiltX = airX.coerceIn(-1f, 1f)
        tiltY = airY.coerceIn(-1f, 1f)
    }

    @JavascriptInterface
    fun pollState(): String = JSONObject().apply {
        decay()
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
