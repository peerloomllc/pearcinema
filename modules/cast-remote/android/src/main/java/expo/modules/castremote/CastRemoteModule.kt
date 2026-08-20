package expo.modules.castremote

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.content.pm.PackageManager
import android.os.Build
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URL

// THE PHONE AS A REMOTE, on the lock screen.
//
// This module publishes nothing about what the PHONE is playing - expo-video already
// does that for its own player. It is for the other case: a film playing on a
// television, with this phone driving it. Answering a message then meant unlocking,
// finding the app and waiting for it to come back before you could pause the room
// (Tim, 2026-08-19).
//
// WHY A MEDIA SESSION AND NOT JUST A NOTIFICATION WITH BUTTONS. The lock-screen media
// widget is drawn by the system from a session token; an ordinary notification is a
// row of buttons in the shade. The session is also what gives the widget a scrubber
// that MOVES - Android extrapolates the position from the last state and the playback
// speed, so the bar stays honest between updates without this phone polling the
// television every second. And it is what makes a headset's play/pause button work.
//
// NOTHING IS PLAYING HERE, so there is no foreground service and no audio focus: this
// is a remote control, and taking focus would duck or stop whatever the phone itself
// is doing. The notification is an ordinary one, cancelled the moment the cast ends.
class CastRemoteModule : Module() {
  companion object {
    private const val CHANNEL = "pearcinema.cast"
    private const val NOTIF_ID = 4771
    private const val ACTION = "com.pearcinema.CAST_REMOTE_ACTION"
    private const val EXTRA_WHAT = "what"
  }

  private var session: MediaSessionCompat? = null
  private var receiver: BroadcastReceiver? = null
  private var artUrl: String? = null
  private var art: Bitmap? = null

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no context" }

  override fun definition() = ModuleDefinition {
    Name("CastRemote")

    Events("onAction")

    // Show or update. One call does both, because a cast that pauses is the same
    // remote in a different state and tearing the notification down to rebuild it
    // makes the widget flicker off the lock screen and back.
    AsyncFunction("show") { info: Map<String, Any?> ->
      val title = info["title"] as? String ?: "Playing"
      val subtitle = info["subtitle"] as? String ?: ""
      val paused = info["paused"] as? Boolean ?: false
      val canSkip = info["canSkip"] as? Boolean ?: true
      val positionMs = (info["positionMs"] as? Number)?.toLong() ?: 0L
      val durationMs = (info["durationMs"] as? Number)?.toLong() ?: 0L
      val nextArt = info["artUrl"] as? String

      ensureChannel()
      askIfNeeded()
      val s = ensureSession()

      // Fetched once per film, off the calling thread, and skipped entirely if the
      // artwork is the same one already showing.
      if (nextArt != artUrl) {
        artUrl = nextArt
        art = nextArt?.let { fetchArt(it) }
      }

      val meta = MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, subtitle)
        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, if (durationMs > 0) durationMs else -1L)
      art?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
      s.setMetadata(meta.build())

      // THE SPEED IS WHAT MAKES THE BAR MOVE. With 1.0 the system advances the
      // position itself from the moment this state was set, so a phone in a pocket
      // shows a scrubber that is right without asking the television anything.
      val actions = PlaybackStateCompat.ACTION_PLAY or
        PlaybackStateCompat.ACTION_PAUSE or
        PlaybackStateCompat.ACTION_PLAY_PAUSE or
        PlaybackStateCompat.ACTION_STOP or
        (if (canSkip) PlaybackStateCompat.ACTION_FAST_FORWARD or PlaybackStateCompat.ACTION_REWIND else 0L)
      s.setPlaybackState(
        PlaybackStateCompat.Builder()
          .setActions(actions)
          .setState(
            if (paused) PlaybackStateCompat.STATE_PAUSED else PlaybackStateCompat.STATE_PLAYING,
            positionMs,
            if (paused) 0f else 1f
          )
          .build()
      )
      s.isActive = true

      NotificationManagerCompat.from(context).notify(NOTIF_ID, build(title, subtitle, paused, canSkip, s))
    }

    AsyncFunction("hide") {
      NotificationManagerCompat.from(context).cancel(NOTIF_ID)
      session?.let {
        it.isActive = false
        it.release()
      }
      session = null
      artUrl = null
      art = null
      receiver?.let { r -> runCatching { context.unregisterReceiver(r) } }
      receiver = null
    }

    OnDestroy {
      runCatching { NotificationManagerCompat.from(context).cancel(NOTIF_ID) }
      runCatching { session?.release() }
      receiver?.let { r -> runCatching { context.unregisterReceiver(r) } }
    }
  }

  // ANDROID 13 WANTS ASKING. Requested at the moment a cast starts rather than at
  // launch, which is the only moment the request means anything to the person reading
  // it - and if they say no, the app is exactly what it was before: a remote inside the
  // app and nothing outside it. The first cast may go without a notification; the ask
  // is not awaited, because a film should start on the television either way.
  private fun askIfNeeded () {
    if (Build.VERSION.SDK_INT < 33) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    val activity = appContext.activityProvider?.currentActivity ?: return
    runCatching { ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIF_ID) }
  }

  private fun ensureChannel () {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL) != null) return
    // LOW, so a film starting on the television does not make a sound on the phone -
    // the notification is a control surface, not news.
    val channel = NotificationChannel(CHANNEL, "Casting", NotificationManager.IMPORTANCE_LOW)
    channel.description = "Controls for a film playing on a television"
    channel.setShowBadge(false)
    nm.createNotificationChannel(channel)
  }

  private fun ensureSession (): MediaSessionCompat {
    session?.let { return it }

    // Registered at runtime rather than declared in a manifest: the app is alive for
    // as long as it is driving a cast, and a receiver that outlives it would leave
    // buttons on a notification that nothing answers.
    val r = object : BroadcastReceiver() {
      override fun onReceive (c: Context?, intent: Intent?) {
        val what = intent?.getStringExtra(EXTRA_WHAT) ?: return
        sendEvent("onAction", mapOf("action" to what))
      }
    }
    val filter = IntentFilter(ACTION)
    if (Build.VERSION.SDK_INT >= 33) {
      context.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(r, filter)
    }
    receiver = r

    val s = MediaSessionCompat(context, "PearCinemaCast")
    // The session's own callback covers what the WIDGET and a headset send; the
    // notification's buttons go through the broadcast above. Both end in one event,
    // so the JS side has one place to answer.
    s.setCallback(object : MediaSessionCompat.Callback() {
      override fun onPlay () = sendEvent("onAction", mapOf("action" to "play"))
      override fun onPause () = sendEvent("onAction", mapOf("action" to "pause"))
      override fun onStop () = sendEvent("onAction", mapOf("action" to "stop"))
      override fun onFastForward () = sendEvent("onAction", mapOf("action" to "forward"))
      override fun onRewind () = sendEvent("onAction", mapOf("action" to "back"))
      override fun onSeekTo (pos: Long) = sendEvent("onAction", mapOf("action" to "seek", "positionMs" to pos))
    })
    session = s
    return s
  }

  private fun intentFor (what: String): PendingIntent {
    val i = Intent(ACTION).setPackage(context.packageName).putExtra(EXTRA_WHAT, what)
    return PendingIntent.getBroadcast(
      context, what.hashCode(), i,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun build (title: String, subtitle: String, paused: Boolean, canSkip: Boolean, s: MediaSessionCompat): android.app.Notification {
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    val b = NotificationCompat.Builder(context, CHANNEL)
      .setContentTitle(title)
      .setContentText(subtitle)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setLargeIcon(art)
      .setContentIntent(open)
      .setDeleteIntent(intentFor("stop"))
      .setOngoing(!paused)
      .setShowWhen(false)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_LOW)

    // THE COMPACT ROW IS THREE BUTTONS, which is all the system will show above the
    // fold: back, play/pause, forward. Stop is in the expanded view and on the swipe.
    val compact = mutableListOf<Int>()
    var idx = 0
    if (canSkip) {
      b.addAction(android.R.drawable.ic_media_rew, "Back 30 seconds", intentFor("back"))
      compact.add(idx++)
    }
    if (paused) {
      b.addAction(android.R.drawable.ic_media_play, "Resume", intentFor("play"))
    } else {
      b.addAction(android.R.drawable.ic_media_pause, "Pause", intentFor("pause"))
    }
    compact.add(idx++)
    if (canSkip) {
      b.addAction(android.R.drawable.ic_media_ff, "Forward 30 seconds", intentFor("forward"))
      compact.add(idx++)
    }
    b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", intentFor("stop"))

    b.setStyle(
      androidx.media.app.NotificationCompat.MediaStyle()
        .setMediaSession(s.sessionToken)
        .setShowActionsInCompactView(*compact.toIntArray())
        .setShowCancelButton(true)
        .setCancelButtonIntent(intentFor("stop"))
    )
    return b.build()
  }

  // The poster, if the phone can reach it. A remote with no picture on it is still a
  // remote, so every failure here is silent.
  private fun fetchArt (url: String): Bitmap? = runCatching {
    URL(url).openStream().use { BitmapFactory.decodeStream(it) }
  }.getOrNull()
}
