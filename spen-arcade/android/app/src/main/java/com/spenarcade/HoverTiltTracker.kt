package com.spenarcade

import android.view.MotionEvent
import android.view.View

/**
 * Читает АБСОЛЮТНЫЙ наклон стилуса, пока перо висит над экраном.
 *
 * S Pen Remote SDK такого не отдаёт — только дельты. Зато обычный MotionEvent
 * при TOOL_TYPE_STYLUS несёт:
 *   AXIS_TILT      — угол между пером и нормалью экрана, радианы [0; ~pi/2]
 *   getOrientation — азимут наклона, радианы [-pi; pi]
 *   AXIS_DISTANCE  — высота над экраном (у Samsung — условные единицы)
 *
 * Вешается на View поверх WebView через setOnHoverListener + setOnTouchListener.
 */
class HoverTiltTracker(private val bridge: SPenBridge) {

    private var maxDistanceSeen = 1f

    fun attach(view: View) {
        view.setOnHoverListener { v, e -> handle(v, e) }
        view.setOnGenericMotionListener { v, e -> handle(v, e) }
        view.setOnTouchListener { v, e -> handle(v, e); false } // не съедаем тачи WebView
    }

    private fun handle(view: View, e: MotionEvent): Boolean {
        if (e.getToolType(0) != MotionEvent.TOOL_TYPE_STYLUS) return false

        when (e.actionMasked) {
            MotionEvent.ACTION_HOVER_EXIT, MotionEvent.ACTION_CANCEL -> {
                bridge.onHoverExit()
                return false
            }
        }

        val tilt = e.getAxisValue(MotionEvent.AXIS_TILT)
        val orientation = e.orientation
        val rawDist = e.getAxisValue(MotionEvent.AXIS_DISTANCE)

        // AXIS_DISTANCE не нормирован и отличается между моделями — калибруем на лету
        // по максимуму, который реально видели на этом устройстве.
        if (rawDist > maxDistanceSeen) maxDistanceSeen = rawDist
        val dist = (rawDist / maxDistanceSeen).coerceIn(0f, 1f)

        // Боковая кнопка пера без SDK: Android отдаёт её как BUTTON_STYLUS_PRIMARY,
        // но только пока перо в зоне hover или касается экрана.
        bridge.onStylusButton((e.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0)

        val nx = (e.x / view.width.coerceAtLeast(1)).coerceIn(0f, 1f)
        val ny = (e.y / view.height.coerceAtLeast(1)).coerceIn(0f, 1f)

        bridge.onHoverTilt(tilt, orientation, dist, nx, ny, e.pressure)
        return false
    }
}
