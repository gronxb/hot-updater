package com.hotupdater.lynx

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ManagedFontUrlTest {
    @Test fun canonicalEncodingPreservesTheManifestPath() {
        val encoded = "https://hot-updater-font.invalid/assets/%ED%95%9C%EA%B8%80%20caf%C3%A9%20%281%29%21~.ttf?hot-updater-generation=2"
        assertEquals("assets/한글 café (1)!~.ttf", ManagedFontUrl.path(encoded))
        for (path in listOf("%2E%2E/probe.ttf", "assets%2Fprobe.ttf", "assets/%FF.ttf", "assets/%25.ttf")) {
            assertThrows(IllegalArgumentException::class.java) {
                ManagedFontUrl.path("https://hot-updater-font.invalid/$path?hot-updater-generation=2")
            }
        }
    }
}
