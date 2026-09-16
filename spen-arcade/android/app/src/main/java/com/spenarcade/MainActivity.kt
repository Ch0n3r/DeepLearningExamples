package com.spenarcade

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: SPenBridge

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            setBackgroundColor(0xFF05070F.toInt())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            }
        }
        setContentView(webView)
        goFullscreen()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Системную кнопку «назад» отдаём игре: она сама решает, что это —
        // пауза, выход из мини-игры или закрытие приложения из хаба.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "window.__spen && window.__spen.onBack ? window.__spen.onBack() : 'exit';"
                ) { result ->
                    if (result?.contains("exit") == true) finish()
                }
            }
        })

        bridge = SPenBridge(this, webView)
        // Имя ровно "SPenNative" — под него написан web/src/input/PenInput.ts
        webView.addJavascriptInterface(bridge, "SPenNative")
        HoverTiltTracker(bridge).attach(webView)

        bridge.connect { connected ->
            webView.post {
                webView.evaluateJavascript(
                    "window.__spen && window.__spen.onNativeReady($connected);", null
                )
            }
        }

        // Билд из AI Studio кладём в app/src/main/assets/game/
        webView.loadUrl("file:///android_asset/game/index.html")
    }

    private fun goFullscreen() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
    }

    override fun onResume() {
        super.onResume()
        goFullscreen()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        bridge.disconnect()
        webView.destroy()
        super.onDestroy()
    }
}
