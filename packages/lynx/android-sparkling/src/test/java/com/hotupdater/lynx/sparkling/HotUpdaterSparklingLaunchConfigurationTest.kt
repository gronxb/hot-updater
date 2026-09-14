package com.hotupdater.lynx.sparkling

import android.app.Activity
import android.content.Intent
import com.hotupdater.lynx.LynxHostConfiguration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class HotUpdaterSparklingLaunchConfigurationTest {
    @Test
    fun mergesHostThenDiagnosticsThenPageConfiguration() {
        assertEquals(
            mapOf(
                "hostOnly" to "host",
                "diagnosticOnly" to "diagnostic",
                "pageOnly" to "page",
                "shared" to "page",
            ),
            HotUpdaterSparklingLaunchConfiguration.merge(
                host = mapOf("hostOnly" to "host", "shared" to "host"),
                diagnostics = mapOf(
                    "diagnosticOnly" to "diagnostic",
                    "shared" to "diagnostic",
                ),
                page = mapOf("pageOnly" to "page", "shared" to "page"),
            ),
        )
    }

    @Test
    fun defaultProductionConfigurationDoesNotReadIntentOverrides() {
        val activity = Robolectric.buildActivity(Activity::class.java)
            .setup()
            .get()
        val configuration = HotUpdaterSparklingConfiguration(
            lynx = LynxHostConfiguration(
                runtimeId = "runtime",
                channel = "production",
                appVersion = "1.0.0",
                embeddedAssetDirectory = "ota/react/A",
                embeddedBundleId = "embedded",
                embeddedManifestHash = "0".repeat(64),
                minimumBundleId = "embedded",
                cohort = "1",
            ),
            launchConfiguration = mapOf(
                "appBaseURL" to "https://updates.company.com/hot-updater",
            ),
        )
        activity.intent = Intent().putExtra(
            HotUpdaterSparklingLaunchConfiguration.EXTRA,
            "{",
        )

        assertFalse(configuration.allowDiagnosticIntentLaunchConfiguration)
        assertEquals(
            mapOf(
                "appBaseURL" to "https://updates.company.com/hot-updater",
                "title" to "Detail",
            ),
            HotUpdaterSparklingLaunchConfiguration.resolve(
                host = configuration.launchConfiguration,
                allowDiagnosticIntent =
                    configuration.allowDiagnosticIntentLaunchConfiguration,
                context = activity,
                page = mapOf("title" to "Detail"),
            ),
        )
    }

    @Test
    fun diagnosticsOptInOverridesHostBeforeAuthorizedPageParameters() {
        val activity = Robolectric.buildActivity(Activity::class.java)
            .setup()
            .get()
        activity.intent = Intent().putExtra(
            HotUpdaterSparklingLaunchConfiguration.EXTRA,
            """{"appBaseURL":"http://diagnostics.test/hot-updater","title":"Intent"}""",
        )

        assertEquals(
            mapOf(
                "appBaseURL" to "http://diagnostics.test/hot-updater",
                "title" to "Page",
            ),
            HotUpdaterSparklingLaunchConfiguration.resolve(
                host = mapOf(
                    "appBaseURL" to "https://updates.company.com/hot-updater",
                    "title" to "Host",
                ),
                allowDiagnosticIntent = true,
                context = activity,
                page = mapOf("title" to "Page"),
            ),
        )
    }

    @Test
    fun acceptsOnlyAStringMap() {
        assertEquals(
            mapOf(
                "runtimeConfigURL" to "http://localhost:3111/e2e/runtime-config",
                "appBaseURL" to "http://localhost:3011/hot-updater",
            ),
            HotUpdaterSparklingLaunchConfiguration.parse(
                """{"runtimeConfigURL":"http://localhost:3111/e2e/runtime-config","appBaseURL":"http://localhost:3011/hot-updater"}""",
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            HotUpdaterSparklingLaunchConfiguration.parse(
                """{"runtimeConfigURL":3111}""",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            HotUpdaterSparklingLaunchConfiguration.parse(
                """{"":"http://localhost:3111/e2e/runtime-config"}""",
            )
        }
        assertThrows(org.json.JSONException::class.java) {
            HotUpdaterSparklingLaunchConfiguration.parse("{")
        }
    }
}
