package com.stefan.desktop_novel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service backing TTS playback: shows a media-style notification
 * with prev / play-pause / next controls (also usable from the lock screen
 * via the MediaSession) and holds a partial wake lock + wifi lock while
 * playing, so chapter loads and synthesis keep working with the screen off.
 *
 * Driven from JS through MediaControlBridge; button presses flow back to JS
 * as `native-media` events, where the reader's player acts on them.
 */
class PlaybackService : Service() {
  private var session: MediaSessionCompat? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var title = ""
  private var chapter = ""
  private var playing = false

  override fun onCreate() {
    super.onCreate()
    instance = this
    if (android.os.Build.VERSION.SDK_INT >= 26) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "TTS Playback", NotificationManager.IMPORTANCE_LOW)
          .apply { description = "Playback controls while a novel is being read aloud" }
      )
    }
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VatesNovel:Playback")
    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    @Suppress("DEPRECATION")
    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "VatesNovel:Playback")

    session = MediaSessionCompat(this, "VatesNovelPlayback").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = emit("toggle")
        override fun onPause() = emit("toggle")
        override fun onSkipToNext() = emit("next")
        override fun onSkipToPrevious() = emit("prev")
        override fun onStop() = emit("stop")
      })
      isActive = true
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_UPDATE -> update(
        intent.getStringExtra("title") ?: "",
        intent.getStringExtra("chapter") ?: "",
        intent.getBooleanExtra("playing", false),
      )
      ACTION_TOGGLE -> emit("toggle")
      ACTION_NEXT -> emit("next")
      ACTION_PREV -> emit("prev")
      ACTION_SHUTDOWN -> shutdown()
    }
    return START_NOT_STICKY
  }

  fun update(title: String, chapter: String, playing: Boolean) {
    this.title = title
    this.chapter = chapter
    this.playing = playing

    if (playing) {
      wakeLock?.takeIf { !it.isHeld }?.acquire(4 * 60 * 60 * 1000L)
      wifiLock?.takeIf { !it.isHeld }?.acquire()
    } else {
      wakeLock?.takeIf { it.isHeld }?.release()
      wifiLock?.takeIf { it.isHeld }?.release()
    }

    session?.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, chapter.ifEmpty { title })
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, title)
        .build()
    )
    session?.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(
          PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE
            or PlaybackStateCompat.ACTION_PLAY_PAUSE
            or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            or PlaybackStateCompat.ACTION_STOP
        )
        .setState(
          if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
          PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
          1f,
        )
        .build()
    )

    ServiceCompat.startForeground(
      this, NOTIFICATION_ID, buildNotification(),
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
    )
  }

  fun shutdown() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wifiLock?.takeIf { it.isHeld }?.release()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun serviceAction(action: String, requestCode: Int): PendingIntent =
    PendingIntent.getService(
      this, requestCode,
      Intent(this, PlaybackService::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  private fun buildNotification(): Notification {
    val openIntent = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java)
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(chapter)
      .setSmallIcon(if (playing) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause)
      .setContentIntent(openIntent)
      .setOngoing(playing)
      .setOnlyAlertOnce(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(android.R.drawable.ic_media_previous, "Previous", serviceAction(ACTION_PREV, 1))
      .addAction(
        if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
        if (playing) "Pause" else "Play",
        serviceAction(ACTION_TOGGLE, 2),
      )
      .addAction(android.R.drawable.ic_media_next, "Next", serviceAction(ACTION_NEXT, 3))
      .setStyle(
        androidx.media.app.NotificationCompat.MediaStyle()
          .setMediaSession(session?.sessionToken)
          .setShowActionsInCompactView(0, 1, 2)
      )
      .build()
  }

  private fun emit(action: String) {
    MediaControlBridge.instance?.emitAction(action)
  }

  override fun onDestroy() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wifiLock?.takeIf { it.isHeld }?.release()
    session?.release()
    session = null
    instance = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    const val ACTION_UPDATE = "com.stefan.desktop_novel.playback.UPDATE"
    const val ACTION_TOGGLE = "com.stefan.desktop_novel.playback.TOGGLE"
    const val ACTION_NEXT = "com.stefan.desktop_novel.playback.NEXT"
    const val ACTION_PREV = "com.stefan.desktop_novel.playback.PREV"
    const val ACTION_SHUTDOWN = "com.stefan.desktop_novel.playback.SHUTDOWN"
    private const val CHANNEL_ID = "tts_playback"
    private const val NOTIFICATION_ID = 201

    @Volatile var instance: PlaybackService? = null
  }
}
