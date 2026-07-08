package com.stefan.desktop_novel

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat

/**
 * JS interface `window.NativeMedia`: drives the playback and download
 * notifications (PlaybackService / DownloadService). Notification and
 * lock-screen button presses come back as `native-media` CustomEvents on
 * `window` with {action: "toggle"|"next"|"prev"|"stop"|"download-stop"}.
 * The JS side lives in src/lib/nativeMedia.ts.
 *
 * The first update starts the service from the foreground (a user action in
 * the app); later updates go straight to the running instance, which avoids
 * Android's background service-start restrictions.
 */
class MediaControlBridge(private val context: Context, private val webView: WebView) {

  init {
    instance = this
  }

  fun emitAction(action: String) {
    val js =
      "window.dispatchEvent(new CustomEvent('native-media', { detail: { action: '$action' } }))"
    webView.post { webView.evaluateJavascript(js, null) }
  }

  @JavascriptInterface
  fun playbackUpdate(title: String, chapter: String, playing: Boolean) {
    val running = PlaybackService.instance
    if (running != null) {
      running.update(title, chapter, playing)
    } else {
      ContextCompat.startForegroundService(
        context,
        Intent(context, PlaybackService::class.java)
          .setAction(PlaybackService.ACTION_UPDATE)
          .putExtra("title", title)
          .putExtra("chapter", chapter)
          .putExtra("playing", playing),
      )
    }
  }

  @JavascriptInterface
  fun playbackStop() {
    PlaybackService.instance?.shutdown()
  }

  @JavascriptInterface
  fun downloadUpdate(title: String, done: Int, total: Int) {
    val running = DownloadService.instance
    if (running != null) {
      running.update(title, done, total)
    } else {
      ContextCompat.startForegroundService(
        context,
        Intent(context, DownloadService::class.java)
          .setAction(DownloadService.ACTION_UPDATE)
          .putExtra("title", title)
          .putExtra("done", done)
          .putExtra("total", total),
      )
    }
  }

  @JavascriptInterface
  fun downloadEnd() {
    DownloadService.instance?.shutdown()
  }

  companion object {
    @Volatile var instance: MediaControlBridge? = null
  }
}
