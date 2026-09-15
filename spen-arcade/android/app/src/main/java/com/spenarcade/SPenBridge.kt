package com.spenarcade

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import kotlin.math.abs

/**
 * Мост между Samsung S Pen Remote SDK и веб-игрой в WebView.
 *
 * ВАЖНО: SDK подключается ЧЕРЕЗ РЕФЛЕКСИЮ, а не через import.
 *
 * Причина: Samsung не публикует Pen Remote SDK в Maven — только AAR внутри
 * ZIP-архива с сайта разработчика. Прямой import сделал бы проект несобираемым
 * ни на CI, ни на чужой машине без ручного скачивания. С рефлексией APK
 * собирается везде и из коробки, а SDK — опциональное улучшение.
 *
 * Два независимых канала ввода объединяются в один поток состояния пера:
 *
 *  1. AIR MOTION (перо в воздухе) — доступен только при наличии AAR.
 *     SDK отдаёт ТОЛЬКО дельты угловой скорости: абсолютного наклона
 *     в воздухе не существует, гироскоп пера не знает, где «ноль».
 *     Поэтому дельты интегрируются с утечкой к нулю (leaky integrator).
 *
 *  2. HOVER TILT (перо над экраном, <~1.5 см) — работает ВСЕГДА, без SDK.
 *     MotionEvent.AXIS_TILT даёт честный абсолютный угол, который заодно
 *     сбрасывает накопленный дрейф первого канала.
 */
class SPenBridge(
    private val context: Context,
    private val webView: WebView
) {
    companion object {
        private const val TAG = "SPenBridge"
        private const val PKG = "com.samsung.android.sdk.penremote"

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

    private var buttonDownAt = 0L
    private var lastMotionNs = 0L

    private val main = Handler(Looper.getMainLooper())

    // ---- рефлексивные ссылки на SDK -----------------------------------------
    private var spenRemote: Any? = null          // SpenRemote
    private var unitManager: Any? = null         // SpenUnitManager
    private var airMotionUnit: Any? = null
    private var buttonUnit: Any? = null
    private var sdkPresent = false

    /**
     * Пытаемся поднять SDK. Любая осечка — не ошибка, а штатный сценарий:
     * значит, играем на hover-наклоне.
     */
    fun connect(onReady: (Boolean) -> Unit) {
        val remoteCls = try {
            Class.forName("$PKG.SpenRemote")
        } catch (_: ClassNotFoundException) {
            Log.i(TAG, "Pen Remote SDK не найден в APK — работаем на hover-наклоне")
            onReady(false)
            return
        }

        try {
            sdkPresent = true
            val remote = remoteCls.getMethod("getInstance").invoke(null)
            spenRemote = remote

            // Константы читаем полем, а не хардкодим числом: Samsung их менял.
            val featureAirMotion = remoteCls.getField("FEATURE_TYPE_AIR_MOTION").getInt(null)
            airMotionAvailable = remoteCls
                .getMethod("isFeatureEnabled", Int::class.javaPrimitiveType)
                .invoke(remote, featureAirMotion) as Boolean

            if (!airMotionAvailable) {
                Log.w(TAG, "Air Actions недоступны на этом устройстве")
            }

            // ConnectionStateChangeListener — интерфейс, реализуем динамическим прокси.
            val listenerCls = Class.forName("$PKG.SpenRemote\$ConnectionStateChangeListener")
            val listener = Proxy.newProxyInstance(
                listenerCls.classLoader,
                arrayOf(listenerCls),
                InvocationHandler { _, method: Method, args ->
                    when (method.name) {
                        "onConnected" -> {
                            unitManager = args?.getOrNull(0)
                            unitManager?.let {
                                registerAirMotion(it)
                                registerButton(it)
                            }
                            main.post { onReady(true) }
                        }
                        "onDisconnected" -> {
                            unitManager = null
                            main.post { onReady(false) }
                        }
                    }
                    null
                }
            )

            remoteCls
                .getMethod("connect", Context::class.java, listenerCls)
                .invoke(remote, context, listener)
        } catch (e: Throwable) {
            Log.w(TAG, "Не удалось поднять Pen Remote SDK: ${e.message}")
            sdkPresent = false
            onReady(false)
        }
    }

    /** Общая часть регистрации: получить юнит нужного типа и повесить слушатель. */
    private fun registerUnit(manager: Any, typeFieldName: String, onEvent: (Any) -> Unit): Any? {
        return try {
            val unitCls = Class.forName("$PKG.SpenUnit")
            val type = unitCls.getField(typeFieldName).getInt(null)
            val unit = manager.javaClass
                .getMethod("getUnit", Int::class.javaPrimitiveType)
                .invoke(manager, type) ?: return null

            val eventListenerCls = Class.forName("$PKG.SpenEventListener")
            val proxy = Proxy.newProxyInstance(
                eventListenerCls.classLoader,
                arrayOf(eventListenerCls),
                InvocationHandler { _, method, args ->
                    if (method.name == "onEvent") {
                        args?.getOrNull(0)?.let(onEvent)
                    }
                    null
                }
            )
            manager.javaClass
                .getMethod("registerSpenEventListener", eventListenerCls, unitCls)
                .invoke(manager, proxy, unit)
            unit
        } catch (e: Throwable) {
            Log.w(TAG, "Юнит $typeFieldName недоступен: ${e.message}")
            null
        }
    }

    private fun registerAirMotion(manager: Any) {
        val airEventCls = try { Class.forName("$PKG.AirMotionEvent") } catch (_: Throwable) { return }
        val ctor = airEventCls.getConstructor(Class.forName("$PKG.SpenEvent"))
        val getDX = airEventCls.getMethod("getDeltaX")
        val getDY = airEventCls.getMethod("getDeltaY")

        airMotionUnit = registerUnit(manager, "TYPE_AIR_MOTION") { event ->
            try {
                val e = ctor.newInstance(event)
                val now = System.nanoTime()
                val dt = if (lastMotionNs == 0L) 1f / 90f
                         else ((now - lastMotionNs) / 1e9f).coerceIn(1f / 240f, 0.05f)
                lastMotionNs = now
                integrateAirMotion(getDX.invoke(e) as Float, getDY.invoke(e) as Float, dt)
            } catch (_: Throwable) { /* битый пакет — пропускаем кадр */ }
        }
    }

    private fun registerButton(manager: Any) {
        val btnEventCls = try { Class.forName("$PKG.ButtonEvent") } catch (_: Throwable) { return }
        val ctor = btnEventCls.getConstructor(Class.forName("$PKG.SpenEvent"))
        val getAction = btnEventCls.getMethod("getAction")
        val actionDown = btnEventCls.getField("ACTION_DOWN").getInt(null)
        val actionUp = btnEventCls.getField("ACTION_UP").getInt(null)

        buttonUnit = registerUnit(manager, "TYPE_BUTTON") { event ->
            try {
                when (getAction.invoke(ctor.newInstance(event)) as Int) {
                    actionDown -> {
                        buttonDown = true
                        buttonDownAt = System.currentTimeMillis()
                        emitDiscrete("button_down", 0L)
                    }
                    actionUp -> {
                        buttonDown = false
                        val held = System.currentTimeMillis() - buttonDownAt
                        emitDiscrete(if (held >= LONG_PRESS_MS) "button_long" else "button_tap", held)
                    }
                }
            } catch (_: Throwable) { /* битый пакет */ }
        }
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

    /** Нажатие боковой кнопки пера, пойманное как MotionEvent (без SDK). */
    fun onStylusButton(down: Boolean) {
        if (sdkPresent) return  // при живом SDK источник истины — он
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
        put("airMotion", airMotionAvailable)
    }.toString()

    @JavascriptInterface
    fun vibrate(ms: Int) = Haptics.buzz(context, ms)

    /** Дискретные события кнопки пушим в JS, чтобы не терять быстрые тапы между кадрами. */
    private fun emitDiscrete(kind: String, held: Long) {
        val js = "window.__spen && window.__spen.onEvent('$kind', $held);"
        main.post { webView.evaluateJavascript(js, null) }
    }

    fun disconnect() {
        try {
            val manager = unitManager ?: return
            val unitCls = Class.forName("$PKG.SpenUnit")
            val unregister = manager.javaClass.getMethod("unregisterSpenEventListener", unitCls)
            airMotionUnit?.let { unregister.invoke(manager, it) }
            buttonUnit?.let { unregister.invoke(manager, it) }
            spenRemote?.let {
                it.javaClass.getMethod("disconnect", Context::class.java).invoke(it, context)
            }
        } catch (_: Throwable) { /* уже отключились */ }
        spenRemote = null
        unitManager = null
        airMotionUnit = null
        buttonUnit = null
    }
}
