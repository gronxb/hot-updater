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
        assertEquals(
            "assets/probe.ttf",
            managedEngineDiagnostic(
                fatal = false,
                code = 302,
                message = message.replace(
                    "probe.ttf",
                    "probe.ttf?hot-updater-generation=2",
                ),
                managedPaths = setOf("assets/probe.ttf"),
            )?.get("path"),
        )
    }

    @Test
    fun attributesCanonicalFontAliasesToTheirVerifiedManifestPath() {
        val path = "assets/한글 font.ttf"
        val alias = message.replace(
            "hot-updater:///assets/probe.ttf",
            "https://hot-updater-font.invalid/assets/%ED%95%9C%EA%B8%80%20font.ttf?hot-updater-generation=2",
        )
        assertEquals(
            path,
            managedEngineDiagnostic(false, 302, alias, setOf(path))?.get("path"),
        )
        for (invalid in listOf(
            alias.replace("\"font\"", "\"image\""),
            alias.replace("https://", "https:/"),
            alias.replace(".invalid/", ".invalid:443/"),
            alias.replace("=2", "=0"),
        )) {
            assertNull(managedEngineDiagnostic(false, 302, invalid, setOf(path)))
        }
        assertNull(managedEngineDiagnostic(false, 302, alias, emptySet()))
    }

    @Test
    fun rejectsUnboundOrNoncanonicalDiagnosticPayloads() {
        listOf(
            message.replace("30201", "\"30201\""),
            message.replace("\"font\"", "\"\""),
            message.replace("assets/probe.ttf", "assets/%70robe.ttf"),
            message.replace("assets/probe.ttf", "assets/probe.ttf?stale=1"),
            message.replace(
                "assets/probe.ttf",
                "assets/probe.ttf?hot-updater-generation=0",
            ),
            message.replace(
                "assets/probe.ttf",
                "assets/probe.ttf?hot-updater-generation=2&stale=1",
            ),
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
