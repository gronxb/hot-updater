package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HotUpdaterRecoveryAttributionTest {
    @Test
    fun `the frames of an engine's stack name the bundles they run from`() {
        // Hermes, as React Native keeps it in a fatal error's extra data.
        val hermes =
            """
            Error: widget failed
                at anonymous (address at $WIDGET_BUNDLE:1:20480)
                at loadModuleImplementation (address at $WIDGET_BUNDLE:1:3456)
                at apply (native)
                at anonymous (address at InternalBytecode.js:1:9010)
            """.trimIndent()
        assertEquals(listOf(WIDGET_BUNDLE), HotUpdaterRecoveryAttribution.frameSources(hermes))

        // A bundle loaded from the app's assets, and JavaScriptCore's format.
        assertEquals(
            listOf("assets://widget.android.bundle"),
            HotUpdaterRecoveryAttribution.frameSources("    at anonymous (address at assets://widget.android.bundle:1:2345)"),
        )
        assertEquals(
            listOf(WIDGET_BUNDLE),
            HotUpdaterRecoveryAttribution.frameSources("anonymous@$WIDGET_BUNDLE:1:2345\nglobal code@$WIDGET_BUNDLE:1:9"),
        )
        assertEquals(
            listOf("http://localhost:8081/index.bundle?platform=android&dev=true"),
            HotUpdaterRecoveryAttribution.frameSources("at f (http://localhost:8081/index.bundle?platform=android&dev=true:12:3)"),
        )

        // React Native's own message drops each frame's file.
        assertEquals(
            emptyList<String>(),
            HotUpdaterRecoveryAttribution.frameSources(
                "Error: widget failed, stack:\nanonymous@1:20480\nloadModuleImplementation@1:3456\n",
            ),
        )
    }

    @Test
    fun `an error belongs to the named instance every located frame runs from`() {
        val hermes = "Error: widget failed\n    at anonymous (address at $WIDGET_BUNDLE:1:20480)\n    at apply (native)"

        assertEquals(WIDGET, owner(hermes))
        assertEquals(WIDGET, owner("    at anonymous (address at assets://widget.android.bundle:1:2345)"))
        assertEquals(WIDGET, owner("Error: widget failed, stack:\nanonymous@1:20480\n", hermes))
        // Frames of two instances, or of main's or an unknown bundle, tell nothing.
        assertNull(owner("$hermes\n    at g (address at $CHAT_BUNDLE:1:9)"))
        assertNull(owner("$hermes\n    at g (address at $MAIN_BUNDLE:1:9)"))
        assertNull(owner("    at g (address at $MAIN_BUNDLE:1:9)"))
        assertNull(owner("Error: widget failed, stack:\nanonymous@1:20480\n"))
    }

    private fun owner(vararg stacks: String): String? =
        HotUpdaterRecoveryAttribution.namedInstanceOfStack(stacks.toList()) { source ->
            when {
                source.contains("/hot-updater-instances/widget/") || source == "assets://widget.android.bundle" -> WIDGET
                source.contains("/hot-updater-instances/chat/") -> "chat"
                else -> HotUpdaterInstanceEnvironment.MAIN_NAME
            }
        }

    companion object {
        private const val WIDGET = "widget"
        private const val FILES = "/data/user/0/com.example.app/files"
        private const val WIDGET_BUNDLE = "$FILES/hot-updater-instances/widget/bundle-store/0199e5c2-widget/index.android.bundle"
        private const val CHAT_BUNDLE = "$FILES/hot-updater-instances/chat/bundle-store/0199e5c2-chat/index.android.bundle"
        private const val MAIN_BUNDLE = "$FILES/bundle-store/0199e5c2-main/index.android.bundle"
    }
}
