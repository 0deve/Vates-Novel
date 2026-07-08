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
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service backing a batch chapter download: shows a progress
 * notification with a Stop action and holds a partial wake lock + wifi lock
 * so the download (which runs in the webview's JS, see lib/downloads.ts)
 * keeps going with the screen off.
 */
class DownloadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    if (android.os.Build.VERSION.SDK_INT >= 26) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW)
          .apply { description = "Chapter download progress" }
      )
    }
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VatesNovel:Download")
    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    @Suppress("DEPRECATION")
    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "VatesNovel:Download")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_UPDATE -> update(
        intent.getStringExtra("title") ?: "",
        intent.getIntExtra("done", 0),
        intent.getIntExtra("total", 0),
      )
      ACTION_STOP -> MediaControlBridge.instance?.emitAction("download-stop")
      ACTION_SHUTDOWN -> shutdown()
    }
    return START_NOT_STICKY
  }

  fun update(title: String, done: Int, total: Int) {
    wakeLock?.takeIf { !it.isHeld }?.acquire(2 * 60 * 60 * 1000L)
    wifiLock?.takeIf { !it.isHeld }?.acquire()
    ServiceCompat.startForeground(
      this, NOTIFICATION_ID, buildNotification(title, done, total),
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )
  }

  fun shutdown() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wifiLock?.takeIf { it.isHeld }?.release()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun buildNotification(title: String, done: Int, total: Int): Notification {
    val openIntent = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java)
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val stopIntent = PendingIntent.getService(
      this, 1,
      Intent(this, DownloadService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Downloading: $title")
      .setContentText("Chapter $done of $total")
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentIntent(openIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setProgress(total, done, total == 0)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopIntent)
      .build()
  }

  override fun onDestroy() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wifiLock?.takeIf { it.isHeld }?.release()
    instance = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    const val ACTION_UPDATE = "com.stefan.desktop_novel.download.UPDATE"
    const val ACTION_STOP = "com.stefan.desktop_novel.download.STOP"
    const val ACTION_SHUTDOWN = "com.stefan.desktop_novel.download.SHUTDOWN"
    private const val CHANNEL_ID = "downloads"
    private const val NOTIFICATION_ID = 101

    @Volatile var instance: DownloadService? = null
  }
}
