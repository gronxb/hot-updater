package com.hotupdater.lynx

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class LynxHostConfigurationTest {
    private val bundleId = "00000000-0000-0000-0000-000000000000"

    @Test fun writableManifestCannotReplaceNativeEmbeddedIdentity() {
        val packaged = """{"bundleId":"$bundleId","assets":{}}"""
            .toByteArray()
        val config = configuration(packaged)

        assertEquals(bundleId, verifyEmbeddedIdentity(packaged, config)
            .getString("bundleId"))
        assertThrows(IllegalStateException::class.java) {
            verifyEmbeddedIdentity(
                """{"bundleId":"01900000-0000-7000-8000-000000000020","assets":{}}"""
                    .toByteArray(),
                config,
            )
        }

        val forged = """{"bundleId":"01900000-0000-7000-8000-000000000020","assets":{}}"""
            .toByteArray()
        assertThrows(IllegalStateException::class.java) {
            verifyEmbeddedIdentity(forged, configuration(forged))
        }
    }

    private fun configuration(manifest: ByteArray) = LynxHostConfiguration(
        runtimeId = "runtime",
        channel = "channel",
        appVersion = "1.0.0",
        embeddedAssetDirectory = "/writable/fixture",
        embeddedBundleId = bundleId,
        embeddedManifestHash = MessageDigest.getInstance("SHA-256")
            .digest(manifest)
            .joinToString("") { "%02x".format(it) },
        minimumBundleId = bundleId,
        cohort = "1",
    )
}
