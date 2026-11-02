package com.hotupdater

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.text.Normalizer

/** What a preview link asks this build to run. */
internal data class HotUpdaterSandboxLink(
    /** The link as it arrived: links dedupe by it. */
    val url: String,
    val urlScheme: String,
    val channel: String,
    val fingerprintHash: String,
) {
    companion object {
        private const val SCHEME_PREFIX = "hu-sandbox-"
        private const val MAX_FINGERPRINT_LENGTH = 256
        private const val MAX_CHANNEL_CODE_POINTS = 255
        private val LINK =
            Regex(
                "^(hu-sandbox-[a-z0-9-]+)://hot-updater/preview\\?([^#]*)$",
                RegexOption.IGNORE_CASE,
            )

        /** Whether a URL scheme is the sandbox's, so its links never reach the app. */
        fun isSandboxScheme(scheme: String?): Boolean = scheme != null && scheme.lowercase().startsWith(SCHEME_PREFIX)

        /**
         * `parsePreviewLink` of `@hot-updater/protocol`, which shares its
         * vectors in test-utils' `sandbox-preview-links.json`: null for
         * anything else, or a channel no release can target.
         */
        fun parse(url: String): HotUpdaterSandboxLink? {
            val match = LINK.matchEntire(url) ?: return null
            val parameters = HashMap<String, String>()
            for (parameter in match.groupValues[2].split("&")) {
                val separator = parameter.indexOf('=')
                if (separator == -1) return null
                val name = parameter.substring(0, separator)
                if (parameters.containsKey(name)) return null
                parameters[name] = percentDecode(parameter.substring(separator + 1)) ?: return null
            }
            val channel = parameters["channel"] ?: return null
            val fingerprintHash = parameters["fingerprint"] ?: return null
            if (fingerprintHash.isEmpty() || fingerprintHash.length > MAX_FINGERPRINT_LENGTH) return null
            if (!isChannelName(channel)) return null
            return HotUpdaterSandboxLink(url, match.groupValues[1].lowercase(), channel, fingerprintHash)
        }

        /** `assertCanonicalChannelName`: non-empty, trimmed, NFC, at most 255 code points. */
        fun isChannelName(channel: String): Boolean =
            channel.isNotEmpty() &&
                channel == channel.trim { it.isJsWhitespace() } &&
                Normalizer.isNormalized(channel, Normalizer.Form.NFC) &&
                channel.codePointCount(0, channel.length) <= MAX_CHANNEL_CODE_POINTS

        private fun Char.isJsWhitespace() = isWhitespace() || this == '\uFEFF'

        /** `decodeURIComponent`: null for a malformed escape or malformed UTF-8. */
        private fun percentDecode(value: String): String? {
            val bytes = ByteArrayOutputStream(value.length)
            var at = 0
            while (at < value.length) {
                val character = value[at]
                if (character != '%') {
                    val end =
                        (at + 1 until value.length).firstOrNull { value[it] == '%' } ?: value.length
                    bytes.write(value.substring(at, end).toByteArray(Charsets.UTF_8))
                    at = end
                    continue
                }
                if (at + 2 >= value.length) return null
                val high = Character.digit(value[at + 1], 16)
                val low = Character.digit(value[at + 2], 16)
                if (high < 0 || low < 0) return null
                bytes.write(high * 16 + low)
                at += 3
            }
            return try {
                Charsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray()))
                    .toString()
            } catch (_: CharacterCodingException) {
                null
            }
        }
    }
}
