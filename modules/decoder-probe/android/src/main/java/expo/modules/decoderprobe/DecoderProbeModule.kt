package expo.modules.decoderprobe

import android.media.MediaCodecList
import android.os.Build
import androidx.media3.common.C
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.video.player.VideoPlayer

// The device's REAL decoder list, straight from MediaCodecList - every decoder
// the OS would hand ExoPlayer, with the facts the capability mapper needs. This
// module only REPORTS; the policy that turns a decoder list into a capability
// declaration lives in src/capabilities.js, where Node can test it against
// captured fixtures. The suite lesson behind that split: chips lie about codecs
// (the TCL threw MediaCodec 0x80000000 on a real HEVC film), so the raw facts
// and the judgment of them must be separable.
class DecoderProbeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DecoderProbe")

    Function("probe") {
      val out = mutableListOf<Map<String, Any?>>()
      for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
        if (info.isEncoder) continue
        for (mime in info.supportedTypes) {
          val lower = mime.lowercase()
          if (!lower.startsWith("video/") && !lower.startsWith("audio/")) continue
          val caps = try {
            info.getCapabilitiesForType(mime)
          } catch (e: Exception) {
            continue
          }
          // isHardwareAccelerated arrived in API 29; before that the stock
          // software decoders are the OMX.google.* and c2.android.* names.
          val hardware = if (Build.VERSION.SDK_INT >= 29) {
            info.isHardwareAccelerated
          } else {
            !(info.name.startsWith("OMX.google.") || info.name.startsWith("c2.android."))
          }
          out.add(mapOf(
            "name" to info.name,
            "mime" to lower,
            "hardware" to hardware,
            "profiles" to caps.profileLevels.map { it.profile },
            "maxWidth" to caps.videoCapabilities?.supportedWidths?.upper,
            "maxHeight" to caps.videoCapabilities?.supportedHeights?.upper
          ))
        }
      }
      out
    }

    // WHAT THE PLAYER ACTUALLY CHOSE TO HEAR. ExoPlayer raises no error for a
    // soundtrack it has no decoder for: it plays the picture and simply selects
    // no audio track, so a film with tracks and nothing selected is the whole
    // signal for "silent on this device". expo-video's own `audioTrack` cannot
    // answer this on Android - it reports a track only when a language
    // preference or an override names one, never ExoPlayer's real pick - so
    // this reads the track groups underneath. Main thread, because ExoPlayer
    // checks the calling thread on every access. Reports only, like probe():
    // the retry policy lives in the JS that reads it.
    AsyncFunction("audioSelection") { player: VideoPlayer ->
      val formats = mutableListOf<Map<String, Any?>>()
      var selected = false
      var supported = false
      for (group in player.player.currentTracks.groups) {
        if (group.type != C.TRACK_TYPE_AUDIO) continue
        for (i in 0 until group.length) {
          val f = group.getTrackFormat(i)
          val isSelected = group.isTrackSelected(i)
          val isSupported = group.isTrackSupported(i)
          selected = selected || isSelected
          supported = supported || isSupported
          formats.add(mapOf(
            "mime" to f.sampleMimeType,
            "codecs" to f.codecs,
            "channels" to f.channelCount,
            "language" to f.language,
            "supported" to isSupported,
            "selected" to isSelected
          ))
        }
      }
      mapOf(
        "tracks" to formats.size,
        "selected" to selected,
        "supported" to supported,
        "formats" to formats
      )
    }.runOnQueue(Queues.MAIN)
  }
}
