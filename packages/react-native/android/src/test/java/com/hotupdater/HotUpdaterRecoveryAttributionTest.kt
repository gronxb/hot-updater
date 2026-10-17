package com.hotupdater

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
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

    @Test
    fun `a root view in a window of its own is found through its runtime`() {
        // A dialog's root view: no activity's decor view contains it.
        val activity = Activity()
        val attribution = attribution(roots(mapOf(21 to CURRENT_URL), shown = listOf(CURRENT_URL)))

        assertEquals(WIDGET, attribution.instanceOfRootTag(21))
        assertNull(attribution.instanceOfRootTag(31))
        assertTrue(attribution.showsViewOf(activity, WIDGET))
        // Main takes the views no named instance claims, as it always has.
        assertFalse(attribution.showsViewOf(activity, MAIN))
    }

    @Test
    fun `a root view of an earlier launch's runtime neither arms nor verifies the current launch`() {
        // The host started its next launch while its previous runtime's view is still shown.
        val activity = Activity()
        val attribution = attribution(roots(mapOf(21 to EARLIER_URL, 31 to CURRENT_URL), shown = listOf(EARLIER_URL)))

        val earlier = attribution.instanceOfRootTag(21)
        assertNotEquals(WIDGET, earlier)
        assertNotEquals(MAIN, earlier)
        assertEquals(WIDGET, attribution.instanceOfRootTag(31))
        assertFalse(attribution.showsViewOf(activity, WIDGET))
        assertFalse(attribution.showsViewOf(activity, MAIN))
    }

    @Test
    fun `a decor view's root view of an earlier launch's runtime neither arms nor verifies the current launch`() {
        // No registered runtime holds the views: they are found in the activity's decor view.
        val activity = Activity()
        val decorViews = mutableListOf(HotUpdaterDecorRoots.Root(21, EARLIER_URL))
        val attribution = attribution(roots(emptyMap(), shown = emptyList()), decorRoots = { decorViews.toList() })
        attribution.noteActivity(activity)

        val earlier = attribution.instanceOfRootTag(21)
        assertNotEquals(WIDGET, earlier)
        assertNotEquals(MAIN, earlier)
        assertFalse(attribution.showsViewOf(activity, WIDGET))
        assertFalse(attribution.showsViewOf(activity, MAIN))

        // The replacement launch's view counts once it is shown.
        decorViews += HotUpdaterDecorRoots.Root(31, CURRENT_URL)
        assertEquals(WIDGET, attribution.instanceOfRootTag(31))
        assertTrue(attribution.showsViewOf(activity, WIDGET))
        // A view whose runtime isn't known yet is main's, as it always was.
        decorViews.clear()
        decorViews += HotUpdaterDecorRoots.Root(41, null)
        assertNull(attribution.instanceOfRootTag(41))
        assertTrue(attribution.showsViewOf(activity, MAIN))
        assertFalse(attribution.showsViewOf(activity, WIDGET))
    }

    private fun attribution(
        runtimeRoots: HotUpdaterRuntimeRoots,
        decorRoots: HotUpdaterDecorRoots = HotUpdaterDecorRoots { emptyList() },
    ) = HotUpdaterRecoveryAttribution(
        resolveName = { _, url -> if (url.contains("/hot-updater-instances/widget/")) WIDGET else MAIN },
        runtimeRoots = runtimeRoots,
        decorRoots = decorRoots,
        runsCurrentLaunch = { _, url -> url == CURRENT_URL },
    ).apply {
        track(
            InstanceTestContext(
                kotlin.io.path
                    .createTempDirectory()
                    .toFile(),
            ),
        )
    }

    private fun roots(
        rootURLs: Map<Int, String>,
        shown: List<String>,
    ) = object : HotUpdaterRuntimeRoots {
        override fun runtimeOfRootTag(rootTag: Int): HotUpdaterRuntimeRoots.Runtime? =
            rootURLs[rootTag]?.let { HotUpdaterRuntimeRoots.Runtime(it) }

        override fun runtimeURLsShownIn(activity: Activity): List<String?> = shown
    }

    @Test
    fun `the counter React Native hands root tags out from can be read`() {
        assertNotNull(HotUpdaterRecoveryAttribution.RootViews.nextRootViewTag())
    }

    @Test
    fun `a live root is found however many root tags were handed out before it was shown`() {
        val tags = HotUpdaterLiveRootTags()
        val held = mutableSetOf<Int>()
        assertEquals(emptyList<Int>(), tags.liveTags(1) { it in held })

        // A named runtime's root in a dialog, then 70 more roots of main's or gone.
        held += 1
        assertEquals(listOf(1), tags.liveTags(711) { it in held })
        assertEquals(listOf(1), tags.liveTags(5_001) { it in held })

        // Handed out long before the gate first looks: still found, as every tag is looked at once.
        val late = HotUpdaterLiveRootTags()
        assertEquals(listOf(1), late.liveTags(5_001) { it in held })

        // A root that goes is forgotten; a newer live one is found.
        held -= 1
        held += 5_001
        assertEquals(listOf(5_001), tags.liveTags(5_011) { it in held })
    }

    @Test
    fun `root tags no runtime holds are looked at again only while recent`() {
        val tags = HotUpdaterLiveRootTags(maxUnheld = 2)
        val looked = mutableListOf<Int>()
        tags.liveTags(41) {
            looked += it
            false
        }
        assertEquals(listOf(1, 11, 21, 31), looked)

        // A runtime that registers after its root was handed out is found while the tag is recent.
        looked.clear()
        assertEquals(
            listOf(31),
            tags.liveTags(41) {
                looked += it
                it == 31
            },
        )
        assertEquals(listOf(21, 31), looked)
    }

    @Test
    fun `a root view belongs to the activity its context wraps`() {
        val roots = HotUpdaterRecoveryAttribution.RootViews
        val activity = Activity()
        // A dialog's themed context wraps its activity.
        val themed =
            object : ContextWrapper(null) {
                override fun getBaseContext(): Context = activity
            }

        assertSame(activity, roots.ownerActivity(activity))
        assertSame(activity, roots.ownerActivity(themed))
        assertNull(roots.ownerActivity(null))
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
        private const val MAIN = HotUpdaterInstanceEnvironment.MAIN_NAME
        private const val FILES = "/data/user/0/com.example.app/files"
        private const val EARLIER_URL = "$FILES/hot-updater-instances/widget/bundle-store/earlier/index.android.bundle"
        private const val CURRENT_URL = "$FILES/hot-updater-instances/widget/bundle-store/current/index.android.bundle"
        private const val WIDGET_BUNDLE = "$FILES/hot-updater-instances/widget/bundle-store/0199e5c2-widget/index.android.bundle"
        private const val CHAT_BUNDLE = "$FILES/hot-updater-instances/chat/bundle-store/0199e5c2-chat/index.android.bundle"
        private const val MAIN_BUNDLE = "$FILES/bundle-store/0199e5c2-main/index.android.bundle"
    }
}
