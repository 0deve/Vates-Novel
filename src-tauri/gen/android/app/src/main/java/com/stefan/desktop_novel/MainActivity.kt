package com.stefan.desktop_novel

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // Hands the app context to rustls-platform-verifier (the Rust TTS
  // engine's TLS trust-store bridge); implemented in src-tauri/src/lib.rs.
  private external fun initTlsVerifier(context: android.content.Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // super.onCreate loads the Rust library (Rust.onActivityCreate), so the
    // external fun above only resolves after it.
    super.onCreate(savedInstanceState)
    initTlsVerifier(applicationContext)
  }
}
