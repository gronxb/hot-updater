package com.hotupdater.lynx

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LynxEngineDiagnosticTest {
    private val message =
        """{"error_code":302,"sub_code":30201,"src":"hot-updater:///assets/probe.ttf","type":"font"}"""

    @Test
    fun extractsOnlyTheExactCanonicalManagedDiagnostic() {
        assertEquals(
            linkedMapOf(
                "fatal" to false,
                "code" to 302,
                "subcode" to 30201,
                "type" to "font",
                "path" to "assets/probe.ttf",
            ),
            managedEngineDiagnostic(
                fatal = false,
                code = 302,
                message = message,
                managedPaths = setOf("assets/probe.ttf"),
            ),
        )
    }

    @Test
    fun rejectsUnboundOrNoncanonicalDiagnosticPayloads() {
        listOf(
            message.replace("30201", "\"30201\""),
            message.replace("\"font\"", "\"\""),
            message.replace("assets/probe.ttf", "assets/%70robe.ttf"),
            message.replace("assets/probe.ttf", "assets/probe.ttf?stale=1"),
            message.replace("\"error_code\":302", "\"error_code\":301"),
            "not-json",
        ).forEach { invalid ->
            assertNull(
                invalid,
                managedEngineDiagnostic(
                    fatal = false,
                    code = 302,
                    message = invalid,
                    managedPaths = setOf("assets/probe.ttf"),
                ),
            )
        }
        assertNull(
            managedEngineDiagnostic(
                fatal = false,
                code = 302,
                message = message,
                managedPaths = setOf("assets/other.ttf"),
            ),
        )
    }
}
