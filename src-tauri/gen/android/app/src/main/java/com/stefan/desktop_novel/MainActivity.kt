package com.stefan.desktop_novel

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // Hands the app context to rustls-platform-verifier (the Rust TTS
  // engine's TLS trust-store bridge); implemented in src-tauri/src/lib.rs.
  private external fun initTlsVerifier(context: android.content.Context)

  private var nativeTts: NativeTtsBridge? = null
  private var mediaBridge: MediaControlBridge? = null

  // Called by WryActivity once the webview exists, before the app URL loads —
  // the right moment for addJavascriptInterface.
  override fun onWebViewCreate(webView: WebView) {
    nativeTts = NativeTtsBridge(this, webView).also {
      webView.addJavascriptInterface(it, "NativeTTS")
    }
    mediaBridge = MediaControlBridge(this, webView).also {
      webView.addJavascriptInterface(it, "NativeMedia")
    }
  }

  override fun onDestroy() {
    nativeTts?.shutdown()
    nativeTts = null
    super.onDestroy()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // super.onCreate loads the Rust library (Rust.onActivityCreate), so the
    // external fun above only resolves after it.
    super.onCreate(savedInstanceState)
    initTlsVerifier(applicationContext)

    // The playback/download notifications need this on Android 13+.
    if (android.os.Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
        android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 9001)
    }

    // Edge-to-edge is enforced on targetSdk 35+, and the system webview
    // reports env(safe-area-inset-*) as 0, so the page can't avoid the
    // status/navigation bars itself. Pad the content view by the system-bar
    // insets instead; the exposed bands show the view background below,
    // set to the app's page background (Tailwind zinc-950).
    val content = findViewById<android.view.View>(android.R.id.content)
    content.setBackgroundColor(0xFF09090B.toInt())
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
