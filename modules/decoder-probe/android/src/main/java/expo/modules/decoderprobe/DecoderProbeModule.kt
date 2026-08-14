package expo.modules.decoderprobe

import android.media.MediaCodecList
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

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
  }
}
