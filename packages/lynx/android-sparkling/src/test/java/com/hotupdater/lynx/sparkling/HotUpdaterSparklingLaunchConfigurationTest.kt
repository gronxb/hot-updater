package com.hotupdater.lynx.sparkling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class HotUpdaterSparklingLaunchConfigurationTest {
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
