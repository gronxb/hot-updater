package com.hotupdater

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

private const val FINGERPRINT = "abc"

private fun link(
    channel: String,
    fingerprintHash: String = FINGERPRINT,
) = "hu-sandbox-app://hot-updater/preview?channel=$channel&fingerprint=$fingerprintHash"

private class FakeHost : HotUpdaterSandboxHost {
    var fingerprint: String? = FINGERPRINT
    var serverConfig = true
    var channel = "sandbox-release"
    var bundleId = "built-in"
    val calls = ArrayList<String>()
    var preflightGate: CompletableDeferred<Boolean>? = null
    val preflights = HashMap<String, Result<Boolean>>()
    var resetResult: Result<Boolean> = Result.success(true)
    var stageGate: CompletableDeferred<HotUpdaterSandboxStaged>? = null
    var stageResult: Result<HotUpdaterSandboxStaged> = Result.success(HotUpdaterSandboxStaged.Update("ota"))
    var progress: ((Double) -> Unit)? = null
    var channelAfterStaging: String? = null
    override var isRunningDevServer = false
    var exits = 0

    override fun exitDevServer() {
        exits += 1
    }

    /** The OTA this process launched, which stays what it runs after a reset deletes it. */
    var runningBundleId: String? = null

    override suspend fun launchBundleId() = runningBundleId ?: bundleId

    var appRunning = false

    override fun isAppRunning() = appRunning

    override fun fingerprintHash() = fingerprint

    override fun hasServerConfig() = serverConfig

    override suspend fun selection() = HotUpdaterSandboxSelection(channel, "sandbox-release", bundleId, bundleId == "built-in")

    override suspend fun preflight(channel: String): Boolean {
        calls += "preflight $channel"
        preflightGate?.let { return it.await() }
        return (preflights[channel] ?: Result.success(true)).getOrThrow()
    }

    override suspend fun reset(): Boolean {
        calls += "reset"
        val reset = resetResult.getOrThrow()
        if (reset) {
            channel = "sandbox-release"
            bundleId = "built-in"
        }
        return reset
    }

    override suspend fun checkAndStage(
        channel: String,
        onProgress: (Double) -> Unit,
    ): HotUpdaterSandboxStaged {
        calls += "check $channel"
        progress = onProgress
        val staged = stageGate?.await() ?: stageResult.getOrThrow()
        if (staged is HotUpdaterSandboxStaged.Update) {
            this.channel = channelAfterStaging ?: channel
            bundleId = staged.bundleId ?: "built-in"
        }
        return staged
    }
}

private class FakeStore(
    override var pendingLinks: List<String> = emptyList(),
) : HotUpdaterSandboxStore {
    val selected = ArrayList<String>()
    val opened = ArrayList<String>()

    override fun recordSelected(selection: HotUpdaterSandboxSelection) {
        selected += selection.channel
    }

    override fun recordOpened(selection: HotUpdaterSandboxSelection) {
        opened += selection.channel
    }
}

private class Fixture(
    pendingLinks: List<String> = emptyList(),
) {
    val host = FakeHost()
    val store = FakeStore(pendingLinks)
    val opens = ArrayList<Pair<Boolean, Boolean>>()
    val coordinator =
        HotUpdaterSandboxCoordinator(
            host = host,
            store = store,
            // Each step runs at once on the test's thread; a gate holds one open.
            scope = CoroutineScope(Dispatchers.Unconfined),
            openApp = { switched, fixed -> opens += switched to fixed },
        )

    val phase get() = coordinator.state.phase
}

class HotUpdaterSandboxCoordinatorTest {
    @Test
    fun `in a dev session a confirmed link exits it, and stays stored for the new process`() {
        val fixture = Fixture()
        fixture.host.isRunningDevServer = true
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.confirmLink()
        assertEquals(1, fixture.host.exits)
        assertTrue(fixture.host.calls.isEmpty())
        assertEquals(listOf(link("pr-1")), fixture.store.pendingLinks)
    }

    @Test
    fun `opening in a dev session records no bundle as opened`() {
        val fixture = Fixture()
        fixture.host.isRunningDevServer = true
        fixture.coordinator.open()
        assertEquals(emptyList<String>(), fixture.store.opened)
        assertEquals(listOf(false to false), fixture.opens)
    }

    @Test
    fun `a dev session's Open never restarts, whatever this launch and the next one say`() {
        val fixture = Fixture()
        // What makes a normal launch fixed: it runs one bundle, and the next selects another.
        fixture.host.runningBundleId = "ota-1"
        fixture.host.bundleId = "ota-2"
        fixture.coordinator.open()
        assertEquals("a normal process restarts", listOf(false to true), fixture.opens)

        val dev = Fixture()
        dev.host.isRunningDevServer = true
        dev.host.runningBundleId = "ota-1"
        dev.host.bundleId = "ota-2"
        dev.coordinator.refresh()
        dev.coordinator.open()
        assertEquals(listOf(false to false), dev.opens)
        assertEquals(emptyList<String>(), dev.store.opened)
    }

    @Test
    fun `in a dev session a row or a reset asks to exit first and changes nothing`() {
        val fixture = Fixture()
        fixture.host.isRunningDevServer = true
        assertTrue(fixture.coordinator.switchTo("pr-1"))
        val failed = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals(HotUpdaterSandboxFailure.Error("The dev server is running. Exit it, then try again."), failed.failure)
        assertTrue(fixture.host.calls.isEmpty())
        fixture.coordinator.dismiss()
        assertTrue(fixture.coordinator.resetToBuiltIn())
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Failed)
        assertTrue(fixture.host.calls.isEmpty())
        assertEquals(0, fixture.host.exits)
    }

    @Test
    fun `a link confirms, then runs every step in order and opens`() {
        val fixture = Fixture()
        fixture.coordinator.receiveLink(link("pr-1"))
        val phase = fixture.phase as HotUpdaterSandboxPhase.Confirming
        assertEquals("pr-1", phase.link.channel)
        assertTrue(fixture.host.calls.isEmpty())

        fixture.coordinator.confirmLink()
        assertEquals(listOf("preflight pr-1", "reset", "check pr-1"), fixture.host.calls)
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        assertEquals(listOf(true to false), fixture.opens)
        assertTrue(fixture.store.pendingLinks.isEmpty())
        assertEquals(listOf("pr-1"), fixture.store.selected)
        assertEquals(listOf("pr-1"), fixture.store.opened)
    }

    @Test
    fun `another fingerprint is refused before any request`() {
        val fixture = Fixture()
        fixture.coordinator.receiveLink(link("pr-1", "other"))
        val refusal = (fixture.phase as HotUpdaterSandboxPhase.Refused).refusal as HotUpdaterSandboxRefusal.OtherFingerprint
        assertEquals("abc", refusal.buildFingerprintHash)
        assertTrue(fixture.host.calls.isEmpty())
        assertTrue(fixture.store.pendingLinks.isEmpty())
    }

    @Test
    fun `a refused link delivered twice asks once`() {
        val fixture = Fixture()
        fixture.coordinator.receiveLink(link("pr-1", "other"))
        fixture.coordinator.receiveLink(link("pr-1", "other"))
        assertTrue(fixture.store.pendingLinks.isEmpty())
        fixture.coordinator.dismiss()
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        // Sent again after the answer, it's a new question.
        fixture.coordinator.receiveLink(link("pr-1", "other"))
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Refused)
    }

    @Test
    fun `a build without a fingerprint refuses every link`() {
        val fixture = Fixture()
        fixture.host.fingerprint = null
        fixture.coordinator.receiveLink(link("pr-1"))
        val refusal = (fixture.phase as HotUpdaterSandboxPhase.Refused).refusal as HotUpdaterSandboxRefusal.OtherFingerprint
        assertNull(refusal.buildFingerprintHash)
    }

    @Test
    fun `a pasted link has the fingerprint check and confirms like a scanned one`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("  ${link("pr-1", "other")} ")
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Refused)
        fixture.coordinator.dismiss()
        fixture.coordinator.switchTo(link("pr-2"))
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Confirming)
        assertTrue(fixture.host.calls.isEmpty())
    }

    @Test
    fun `a row runs without a confirmation`() {
        val fixture = Fixture()
        assertTrue(fixture.coordinator.switchTo("pr-1"))
        assertEquals(listOf("preflight pr-1", "reset", "check pr-1"), fixture.host.calls)
    }

    @Test
    fun `an invalid typed channel is refused`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("")
        val refusal = (fixture.phase as HotUpdaterSandboxPhase.Refused).refusal
        assertEquals(HotUpdaterSandboxRefusal.InvalidChannel(""), refusal)
    }

    @Test
    fun `an unreadable link is refused and consumed`() {
        val fixture = Fixture()
        fixture.coordinator.receiveLink("hu-sandbox-app://hot-updater/other")
        val refusal = (fixture.phase as HotUpdaterSandboxPhase.Refused).refusal
        assertEquals(HotUpdaterSandboxRefusal.Unreadable("hu-sandbox-app://hot-updater/other"), refusal)
        assertTrue(fixture.store.pendingLinks.isEmpty())
    }

    @Test
    fun `the same url counts once whether waiting or running`() {
        val fixture = Fixture()
        val gate = CompletableDeferred<Boolean>()
        fixture.host.preflightGate = gate
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.receiveLink(link("pr-1"))
        assertEquals(listOf(link("pr-1")), fixture.store.pendingLinks)
        fixture.coordinator.confirmLink()
        fixture.coordinator.receiveLink(link("pr-1"))
        assertEquals(listOf(link("pr-1")), fixture.store.pendingLinks)
        assertEquals(0, fixture.coordinator.state.queuedLinks)
        gate.complete(true)
        assertEquals(1, fixture.host.calls.count { it == "reset" })
    }

    @Test
    fun `a second link queues for its own confirmation and holds the open`() {
        val fixture = Fixture()
        val gate = CompletableDeferred<HotUpdaterSandboxStaged>()
        fixture.host.stageGate = gate
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.confirmLink()
        fixture.coordinator.receiveLink(link("pr-2"))
        assertEquals("pr-1", (fixture.phase as HotUpdaterSandboxPhase.Working).target)
        assertEquals(1, fixture.coordinator.state.queuedLinks)

        gate.complete(HotUpdaterSandboxStaged.Update("ota-1"))
        assertEquals("pr-2", (fixture.phase as HotUpdaterSandboxPhase.Confirming).link.channel)
        assertTrue(fixture.opens.isEmpty())

        fixture.coordinator.dismiss()
        assertEquals(1, fixture.opens.size)
        assertTrue(fixture.store.pendingLinks.isEmpty())
    }

    @Test
    fun `a row or reset can't start during a switch`() {
        val fixture = Fixture()
        val gate = CompletableDeferred<Boolean>()
        fixture.host.preflightGate = gate
        assertTrue(fixture.coordinator.switchTo("pr-1"))
        assertFalse(fixture.coordinator.switchTo("pr-2"))
        assertFalse(fixture.coordinator.resetToBuiltIn())
        gate.complete(true)
        assertEquals(listOf("preflight pr-1", "reset", "check pr-1"), fixture.host.calls)
    }

    @Test
    fun `a failed preflight leaves everything downloaded in place`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.preflights["pr-1"] = Result.failure(IOException("offline"))
        fixture.coordinator.switchTo("pr-1")
        val phase = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals(HotUpdaterSandboxStep.PREFLIGHT, phase.step)
        assertEquals("pr-0", phase.selection.channel)
        assertEquals("ota-0", phase.selection.bundleId)
        assertFalse(fixture.host.calls.contains("reset"))
        assertTrue(fixture.opens.isEmpty())
    }

    @Test
    fun `an empty channel stops before the reset`() {
        val fixture = Fixture()
        fixture.host.preflights["pr-1"] = Result.success(false)
        fixture.coordinator.switchTo("pr-1")
        assertEquals(HotUpdaterSandboxFailure.NoBundle, (fixture.phase as HotUpdaterSandboxPhase.Failed).failure)
        assertEquals(listOf("preflight pr-1"), fixture.host.calls)
    }

    @Test
    fun `going offline after the preflight shows the built-in selection and retries`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.stageResult = Result.failure(IOException("offline"))
        fixture.coordinator.switchTo("pr-1")
        val phase = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals(HotUpdaterSandboxStep.CHECK, phase.step)
        // The reset ran: the bundle that's gone isn't what the screen says.
        assertEquals("sandbox-release", phase.selection.channel)
        assertTrue(phase.selection.isBuiltIn)
        assertEquals(phase.selection, fixture.coordinator.state.selection)
        assertTrue(fixture.opens.isEmpty())

        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.Update("ota-1"))
        fixture.coordinator.retry()
        assertEquals(1, fixture.opens.size)
        assertEquals("pr-1", fixture.host.channel)
        assertEquals(2, fixture.host.calls.count { it == "preflight pr-1" })
    }

    @Test
    fun `going offline over a running OTA shows the built-in selection, not the deleted bundle`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.runningBundleId = "ota-0"
        fixture.host.stageResult = Result.failure(IOException("offline"))
        fixture.coordinator.switchTo("pr-1")
        val phase = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals("built-in", phase.selection.bundleId)
        assertTrue(phase.selection.isBuiltIn)
        assertEquals(listOf("sandbox-release"), fixture.store.selected)
    }

    @Test
    fun `the next launch is what storage holds once a launch is fixed`() {
        val builtIn = "built-in"
        // Before any launch, the SDK's read is what a launch would pick.
        assertEquals("ota", hotUpdaterSandboxNextLaunchBundleId(null, "ota", "ota", builtIn))
        assertEquals(builtIn, hotUpdaterSandboxNextLaunchBundleId(null, null, null, builtIn))
        // A running OTA a reset deleted: its read still names it, and storage holds nothing.
        assertEquals(builtIn, hotUpdaterSandboxNextLaunchBundleId("ota", "ota", null, builtIn))
        // A running OTA with another staged.
        assertEquals("next", hotUpdaterSandboxNextLaunchBundleId("ota", "ota", "next", builtIn))
        // A launch of the built-in bundle with an OTA staged since.
        assertEquals("next", hotUpdaterSandboxNextLaunchBundleId(null, null, "next", builtIn))
    }

    /** A store that keeps which bundle opened. */
    private class OpenedStore : HotUpdaterSandboxStore {
        override var pendingLinks: List<String> = emptyList()
        var opened: String? = null

        override fun recordSelected(selection: HotUpdaterSandboxSelection) = Unit

        override fun recordOpened(selection: HotUpdaterSandboxSelection) {
            opened = selection.bundleId
        }
    }

    @Test
    fun `open over a running app records what it runs, and leaves what's staged for its launch`() {
        val host =
            FakeHost().apply {
                bundleId = "next"
                runningBundleId = "ota-0"
                appRunning = true
            }
        val store = OpenedStore()
        val opens = ArrayList<Pair<Boolean, Boolean>>()
        HotUpdaterSandboxCoordinator(host, store, CoroutineScope(Dispatchers.Unconfined), { a, b -> opens += a to b }).open()
        assertEquals("ota-0", store.opened)
        assertEquals(listOf(false to false), opens)
    }

    @Test
    fun `open before the app starts restarts a fixed launch into what's selected`() {
        val host =
            FakeHost().apply {
                bundleId = "built-in"
                runningBundleId = "ota-0"
            }
        val store = OpenedStore()
        val opens = ArrayList<Pair<Boolean, Boolean>>()
        HotUpdaterSandboxCoordinator(host, store, CoroutineScope(Dispatchers.Unconfined), { a, b -> opens += a to b }).open()
        assertEquals("built-in", store.opened)
        assertEquals(listOf(false to true), opens)
    }

    @Test
    fun `the default channel with nothing published needs a restart over a fixed launch`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.preflights["sandbox-release"] = Result.success(false)
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.NoUpdate)
        fixture.coordinator.switchTo("sandbox-release")
        assertEquals(listOf(true to true), fixture.opens)
        assertEquals(
            "built-in",
            fixture.coordinator.state.selection
                ?.bundleId,
        )
    }

    @Test
    fun `reset needs a restart over a fixed launch`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.coordinator.resetToBuiltIn()
        assertEquals(listOf(true to true), fixture.opens)
    }

    @Test
    fun `a launch that already runs the selection needs no restart`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.NoUpdate)
        fixture.coordinator.switchTo("pr-1")
        assertEquals(listOf(true to false), fixture.opens)
    }

    @Test
    fun `no fixed launch needs no restart, whatever the switch did`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.preflights["sandbox-release"] = Result.success(false)
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.NoUpdate)
        fixture.coordinator.switchTo("sandbox-release")
        assertEquals(listOf(true to false), fixture.opens)
    }

    @Test
    fun `open after a failed switch restarts a fixed launch out of the deleted bundle`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-0"
        fixture.host.runningBundleId = "ota-0"
        fixture.host.stageResult = Result.failure(IOException("offline"))
        fixture.coordinator.switchTo("pr-1")
        fixture.coordinator.dismiss()
        assertTrue(fixture.opens.isEmpty())
        fixture.coordinator.open()
        assertEquals(listOf(false to true), fixture.opens)
    }

    @Test
    fun `a queued link that fails decides the restart, not the switch before it`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-0"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.Update("ota-1"))
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.receiveLink(link("pr-2"))
        fixture.coordinator.confirmLink()
        // The first switch selects what this launch already runs.
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Confirming)
        fixture.host.stageResult = Result.failure(IOException("offline"))
        fixture.coordinator.confirmLink()
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Failed)
        assertTrue(fixture.opens.isEmpty())
        // The second reset deleted it, so the first switch's open can't keep its answer.
        fixture.coordinator.dismiss()
        assertEquals(listOf(true to true), fixture.opens)
    }

    @Test
    fun `nothing for the target after the reset is a failure that says so`() {
        val fixture = Fixture()
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.NoUpdate)
        fixture.coordinator.switchTo("pr-1")
        assertEquals(HotUpdaterSandboxFailure.NoBundle, (fixture.phase as HotUpdaterSandboxPhase.Failed).failure)
        assertTrue(fixture.opens.isEmpty())
    }

    @Test
    fun `the default channel with nothing newer is the built-in bundle`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.preflights["sandbox-release"] = Result.success(false)
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.NoUpdate)
        fixture.coordinator.switchTo("sandbox-release")
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        assertEquals(1, fixture.opens.size)
        assertTrue(fixture.host.calls.contains("reset"))
        assertEquals(
            true,
            fixture.coordinator.state.selection
                ?.isBuiltIn,
        )
    }

    @Test
    fun `a switch to the current channel keeps what is downloaded`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.NoUpdate)
        fixture.coordinator.switchTo("pr-1")
        assertFalse(fixture.host.calls.contains("reset"))
        assertEquals(1, fixture.opens.size)
    }

    @Test
    fun `a superseded staging is a failure`() {
        val fixture = Fixture()
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.Superseded)
        fixture.coordinator.switchTo("pr-1")
        assertEquals(HotUpdaterSandboxFailure.Superseded, (fixture.phase as HotUpdaterSandboxPhase.Failed).failure)
    }

    @Test
    fun `a running check's channel switch is detected`() {
        val fixture = Fixture()
        fixture.host.channelAfterStaging = "other"
        fixture.coordinator.switchTo("pr-1")
        val phase = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals(HotUpdaterSandboxFailure.Superseded, phase.failure)
        assertEquals("other", phase.selection.channel)
        assertTrue(fixture.opens.isEmpty())
    }

    @Test
    fun `a fixed launch needs a restart`() {
        val fixture = Fixture()
        fixture.host.bundleId = "ota-0"
        fixture.host.runningBundleId = "ota-0"
        fixture.coordinator.switchTo("pr-1")
        assertEquals(listOf(true to true), fixture.opens)
        // The screen says what the next launch runs, not what this one does.
        assertEquals(
            "ota",
            fixture.coordinator.state.selection
                ?.bundleId,
        )
    }

    @Test
    fun `a late progress report changes nothing`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        fixture.host.progress?.invoke(0.5)
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
    }

    @Test
    fun `progress belongs to its operation`() {
        val fixture = Fixture()
        val gate = CompletableDeferred<HotUpdaterSandboxStaged>()
        fixture.host.stageGate = gate
        fixture.coordinator.switchTo("pr-1")
        val first = (fixture.phase as HotUpdaterSandboxPhase.Working).operationId
        fixture.host.progress?.invoke(0.5)
        val phase = fixture.phase as HotUpdaterSandboxPhase.Working
        assertEquals(first, phase.operationId)
        assertEquals(HotUpdaterSandboxStep.DOWNLOAD, phase.step)
        assertEquals(0.5, phase.progress!!, 0.0)
        gate.complete(HotUpdaterSandboxStaged.Update("ota"))
    }

    @Test
    fun `a pending link waits for a server answer and survives a restart`() {
        val first = Fixture()
        first.host.serverConfig = false
        first.coordinator.receiveLink(link("pr-1"))
        assertTrue(first.phase is HotUpdaterSandboxPhase.WaitingForServer)
        assertEquals(listOf(link("pr-1")), first.store.pendingLinks)

        // The next process reads it back, and a server has answered by then.
        val second = Fixture(first.store.pendingLinks)
        second.coordinator.refresh()
        assertTrue(second.phase is HotUpdaterSandboxPhase.Confirming)
    }

    @Test
    fun `a pending link revalidates its fingerprint`() {
        val fixture = Fixture(listOf(link("pr-1", "old")))
        fixture.coordinator.refresh()
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Refused)
        assertTrue(fixture.store.pendingLinks.isEmpty())
    }

    @Test
    fun `a screen closes only once nothing is left to answer`() {
        val fixture = Fixture()
        var closes = 0
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.receiveLink(link("pr-2", "other"))
        fixture.coordinator.receiveLink(link("pr-3"))

        // Declined: the refusal behind it is on screen now.
        fixture.coordinator.dismiss { closes += 1 }
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Refused)
        assertEquals(0, closes)

        // Acknowledged: the third link asks next.
        fixture.coordinator.dismiss { closes += 1 }
        assertEquals("pr-3", (fixture.phase as HotUpdaterSandboxPhase.Confirming).link.channel)
        assertEquals(0, closes)

        fixture.coordinator.dismiss { closes += 1 }
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        assertEquals(1, closes)
    }

    @Test
    fun `a declined link is forgotten`() {
        val fixture = Fixture()
        fixture.coordinator.receiveLink(link("pr-1"))
        fixture.coordinator.dismiss()
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        assertTrue(fixture.store.pendingLinks.isEmpty())
        assertTrue(fixture.host.calls.isEmpty())
    }

    @Test
    fun `open records what opened and doesn't read as a switch`() {
        val fixture = Fixture()
        fixture.coordinator.open()
        assertEquals(listOf(false to false), fixture.opens)
        assertEquals(listOf("sandbox-release"), fixture.store.opened)
        assertTrue(fixture.store.selected.isEmpty())
    }

    @Test
    fun `reset returns to the built-in bundle`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        assertTrue(fixture.coordinator.resetToBuiltIn())
        assertEquals(listOf("reset"), fixture.host.calls)
        assertEquals(
            true,
            fixture.coordinator.state.selection
                ?.isBuiltIn,
        )
        assertNotNull(fixture.coordinator.state.selection)
    }

    @Test
    fun `a failed reset says so`() {
        val fixture = Fixture()
        fixture.host.resetResult = Result.success(false)
        fixture.coordinator.resetToBuiltIn()
        assertEquals(HotUpdaterSandboxFailure.ResetFailed, (fixture.phase as HotUpdaterSandboxPhase.Failed).failure)
    }
}
