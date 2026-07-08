package com.stefan.desktop_novel

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * Exposes the Android system TTS engine to the webview as `window.NativeTTS`
 * (see MainActivity.onWebViewCreate), so reading can work fully offline where
 * the Edge voices can't. Progress flows back as `native-tts` CustomEvents on
 * `window`: {kind: "ready"|"start"|"range"|"done"|"error", id, start?, end?}.
 * The JS side lives in src/lib/nativeTts.ts.
 */
class NativeTtsBridge(context: Context, private val webView: WebView) {
  @Volatile private var ready = false

  private val tts: TextToSpeech =
    TextToSpeech(context.applicationContext) { status ->
      ready = status == TextToSpeech.SUCCESS
      emit(JSONObject().put("kind", "ready").put("ok", ready))
    }

  init {
    tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String) {
        emit(JSONObject().put("kind", "start").put("id", utteranceId))
      }

      override fun onDone(utteranceId: String) {
        emit(JSONObject().put("kind", "done").put("id", utteranceId))
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String) {
        emit(JSONObject().put("kind", "error").put("id", utteranceId))
      }

      override fun onError(utteranceId: String, errorCode: Int) {
        emit(
          JSONObject().put("kind", "error").put("id", utteranceId)
            .put("code", errorCode)
        )
      }

      // Word-level progress (API 26+): character range of the word about to
      // be spoken, driving the reader's word highlighting.
      override fun onRangeStart(utteranceId: String, start: Int, end: Int, frame: Int) {
        emit(
          JSONObject().put("kind", "range").put("id", utteranceId)
            .put("start", start).put("end", end)
        )
      }
    })
  }

  private fun emit(detail: JSONObject) {
    val js = "window.dispatchEvent(new CustomEvent('native-tts', { detail: $detail }))"
    webView.post { webView.evaluateJavascript(js, null) }
  }

  @JavascriptInterface
  fun isReady(): Boolean = ready

  /** Installed voices as a JSON array of {name, locale, network}. */
  @JavascriptInterface
  fun getVoices(): String {
    val arr = JSONArray()
    if (ready) {
      // tts.voices can throw on some engines; treat that as "no voices".
      val voices: Set<android.speech.tts.Voice> =
        try { tts.voices ?: emptySet() } catch (e: Exception) { emptySet() }
      for (v in voices) {
        arr.put(
          JSONObject()
            .put("name", v.name)
            .put("locale", v.locale.toLanguageTag())
            .put("network", v.isNetworkConnectionRequired)
        )
      }
    }
    return arr.toString()
  }

  /**
   * Speak `text`, replacing anything currently queued. `rate`/`pitch` are
   * multipliers (1.0 = normal). Returns false if the engine isn't ready or
   * rejected the request.
   */
  @JavascriptInterface
  fun speak(text: String, voiceName: String, rate: Float, pitch: Float, id: String): Boolean {
    if (!ready) return false
    try {
      tts.voices?.firstOrNull { it.name == voiceName }?.let { tts.voice = it }
    } catch (e: Exception) {
      // Unknown voice: fall through and speak with the engine default.
    }
    tts.setSpeechRate(rate)
    tts.setPitch(pitch)
    return tts.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id) == TextToSpeech.SUCCESS
  }

  @JavascriptInterface
  fun stop() {
    tts.stop()
  }

  /** Called from MainActivity.onDestroy — releases the engine connection. */
  fun shutdown() {
    tts.shutdown()
  }
}
