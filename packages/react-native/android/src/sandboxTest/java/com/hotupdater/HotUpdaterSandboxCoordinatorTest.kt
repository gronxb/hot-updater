package com.hotupdater

import android.content.Context
import android.content.ContextWrapper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.coroutines.EmptyCoroutineContext

private const val FINGERPRINT = "abc"

private fun link(
    channel: String,
    fingerprintHash: String = FINGERPRINT,
) = "hu-sandbox-app://hot-updater/preview?channel=$channel&fingerprint=$fingerprintHash"

/**
 * An application context whose only real part is its files directory: all the live
 * host's handoff path reads. The rest is the unit tests' stubbed Android.
 */
private class TestAppContext(
    private val files: File,
) : ContextWrapper(null) {
    override fun getApplicationContext(): Context = this

    override fun getFilesDir(): File = files
}

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
    var isRunningDevServer = false
    var storedBundleId: String? = null
    val startedStored = ArrayList<String>()
    val startedBundles = ArrayList<HotUpdaterSandboxStoredBundle>()
    var exits = 0

    override val isInSession get() = isRunningDevServer || storedBundleId != null

    override val storedSessionBundleId get() = storedBundleId

    /** Whether the relaunch's intent can't go out. */
    var handoffFails = false

    /** Handoffs the screen called off. */
    var abandoned = 0

    /** An app whose files directory is a temporary one, for the live host's handoff path. */
    private val app = TestAppContext(Files.createTempDirectory("sandbox-app").toFile())

    /** The live host itself calls each handoff off, as on a device. */
    private val live = HotUpdaterSandboxLiveHost(app)

    /** The handoffs' files, where the live host and the relaunch's helper take them. */
    val handoffFiles get() = HotUpdaterSandboxDev.filesOf(app)

    /** The nonces of the handoffs that went out, oldest first. */
    val handoffs = ArrayList<String>()

    /** What each of the live host's call-offs returned, in order. */
    val callOffs = ArrayList<Boolean>()

    override fun abandonStoredSession(handoff: String): Boolean =
        live.abandonStoredSession(handoff).also { tookIt ->
            callOffs += tookIt
            if (tookIt) abandoned += 1
        }

    /** As the live host: the session's ID changes only in the process that replaces this one. */
    override fun startStoredSession(
        bundle: HotUpdaterSandboxStoredBundle,
        handoff: String,
    ): Boolean {
        if (handoffFails) return false
        // What the live host's relaunch records before its intent goes out.
        handoffFiles.writeHandoff(handoff)
        handoffs += handoff
        startedStored += bundle.bundleId
        startedBundles += bundle
        return true
    }

    /** The relaunch's helper for the handoff [index] went out as: whether it may relaunch. */
    fun helperClaims(index: Int = handoffs.lastIndex) = handoffFiles.claimHandoff(handoffs[index])

    override fun exitSession() {
        exits += 1
    }

    var evidence = HotUpdaterSandboxLaunchEvidence()
    var pendingBundleId: String? = null

    override fun launchEvidence() = evidence

    override fun details() = HotUpdaterSandboxDetails("built-in", fingerprint, pendingBundleId)

    /** The OTA this process launched, which stays what it runs after a reset deletes it. */
    var runningBundleId: String? = null

    override suspend fun launchBundleId() = runningBundleId ?: bundleId

    var appRunning = false

    override fun isAppRunning() = appRunning

    override fun fingerprintHash() = fingerprint

    override fun hasServerConfig() = serverConfig

    /** While set, a read of the selection waits for it. */
    var selectionGate: CompletableDeferred<Unit>? = null

    override suspend fun selection(): HotUpdaterSandboxSelection {
        selectionGate?.await()
        return HotUpdaterSandboxSelection(channel, "sandbox-release", bundleId, bundleId == "built-in")
    }

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

private class FakeDevServer(
    override val isRunningDevServer: Boolean,
    override val runningDevServerHost: String?,
) : HotUpdaterSandboxDevServer {
    override val devServerHosts: List<HotUpdaterSandboxDevServerHost> = emptyList()
    override var onDevServerChange: (() -> Unit)? = null
    var reloads = 0

    override fun connect(
        host: String,
        completion: (String?) -> Unit,
    ) = completion(null)

    override fun reloadDevServer() {
        reloads += 1
    }

    override fun exitDevServer() = Unit
}

private class FakeStore(
    override var pendingLinks: List<String> = emptyList(),
) : HotUpdaterSandboxStore {
    override var lastLaunch: HotUpdaterSandboxLastLaunch? = null
}

private class Fixture(
    pendingLinks: List<String> = emptyList(),
    shelfContext: kotlin.coroutines.CoroutineContext = EmptyCoroutineContext,
    ownScheme: String? = null,
) {
    val host = FakeHost()
    val store = FakeStore(pendingLinks)
    val lock = HotUpdaterSandboxLock()
    val opens = ArrayList<Pair<Boolean, Boolean>>()
    val shelf = testShelf().also { installTestBundle(it.source, "ota") }
    val coordinator =
        HotUpdaterSandboxCoordinator(
            host = host,
            store = store,
            shelf = shelf,
            // Each step runs at once on the test's thread; a gate holds one open.
            scope = CoroutineScope(Dispatchers.Unconfined),
            openApp = { switched, fixed -> opens += switched to fixed },
            nowMs = { 1_000_000L },
            lock = lock,
            shelfContext = shelfContext,
            isOwnScheme = { HotUpdaterSandboxLink.isOwnScheme(it, ownScheme) },
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
    fun `opening in a dev session opens the app`() {
        val fixture = Fixture()
        fixture.host.isRunningDevServer = true
        fixture.coordinator.open()
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
    fun `a session that starts during a switch stops it before anything changes`() {
        val fixture = Fixture()
        val preflight = CompletableDeferred<Boolean>()
        fixture.host.preflightGate = preflight
        assertTrue(fixture.coordinator.switchTo("pr-1"))
        assertEquals(listOf("preflight pr-1"), fixture.host.calls)
        // A dev server's session starts while the preflight suspends.
        fixture.host.isRunningDevServer = true
        preflight.complete(true)
        assertEquals("the switch went on in a dev session", listOf("preflight pr-1"), fixture.host.calls)
        val failed = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals(HotUpdaterSandboxFailure.Error("The dev server is running. Exit it, then try again."), failed.failure)
    }

    @Test
    fun `a switch while a dev server connects is refused and changes nothing`() {
        val fixture = Fixture()
        assertTrue(fixture.lock.take(HotUpdaterSandboxLock.Holder.DEV_SERVER))
        assertTrue(fixture.coordinator.switchTo("pr-1"))
        val failed = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals(HotUpdaterSandboxFailure.Error("A dev server is connecting. Wait for it, then try again."), failed.failure)
        fixture.coordinator.dismiss()
        assertTrue(fixture.coordinator.resetToBuiltIn())
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Failed)
        assertTrue(fixture.host.calls.isEmpty())
        fixture.coordinator.dismiss()
        fixture.lock.release(HotUpdaterSandboxLock.Holder.DEV_SERVER)
        assertTrue(fixture.coordinator.switchTo("pr-1"))
        assertEquals(listOf("preflight pr-1", "reset", "check pr-1"), fixture.host.calls)
    }

    @Test
    fun `a switch holds the lock until it ends, either way`() {
        val fixture = Fixture()
        val preflight = CompletableDeferred<Boolean>()
        fixture.host.preflightGate = preflight
        assertTrue(fixture.coordinator.switchTo("pr-1"))
        assertEquals(HotUpdaterSandboxLock.Holder.SWITCHING, fixture.lock.holder)
        assertFalse("a connect got the lock during a switch", fixture.lock.take(HotUpdaterSandboxLock.Holder.DEV_SERVER))
        preflight.completeExceptionally(IOException("offline"))
        assertNull(fixture.lock.holder)
        fixture.host.preflightGate = null
        fixture.coordinator.retry()
        assertEquals(listOf("preflight pr-1", "preflight pr-1", "reset", "check pr-1"), fixture.host.calls)
        assertNull(fixture.lock.holder)
        assertTrue(fixture.coordinator.resetToBuiltIn())
        assertNull(fixture.lock.holder)
    }

    @Test
    fun `the lock has one holder, and only its holder releases it`() {
        val lock = HotUpdaterSandboxLock()
        assertTrue(lock.take(HotUpdaterSandboxLock.Holder.DEV_SERVER))
        assertFalse(lock.take(HotUpdaterSandboxLock.Holder.SWITCHING))
        lock.release(HotUpdaterSandboxLock.Holder.SWITCHING)
        assertEquals(HotUpdaterSandboxLock.Holder.DEV_SERVER, lock.holder)
        lock.release(HotUpdaterSandboxLock.Holder.DEV_SERVER)
        assertTrue(lock.take(HotUpdaterSandboxLock.Holder.SWITCHING))
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
    fun `a link of its own scheme is asked about`() {
        val fixture = Fixture(ownScheme = "acme-preview")
        val url = "acme-preview://hot-updater/preview?channel=pr-1&fingerprint=${fixture.host.fingerprintHash()}"
        fixture.coordinator.receiveLink(url)
        assertEquals(HotUpdaterSandboxPhase.Confirming(HotUpdaterSandboxLink.parse(url)!!), fixture.phase)
    }

    @Test
    fun `a link of another scheme isn't for this app`() {
        val fixture = Fixture(ownScheme = "acme-preview")
        fixture.coordinator.receiveLink(link("pr-1"))
        val refusal = (fixture.phase as HotUpdaterSandboxPhase.Refused).refusal
        assertEquals(HotUpdaterSandboxRefusal.Unreadable(link("pr-1")), refusal)
        assertTrue(fixture.store.pendingLinks.isEmpty())
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
    }

    @Test
    fun `every stored session names the release its row kept, and a row from before releases names none`() {
        val fixture = Fixture()
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.Update("ota", null, "019a0000-0000-7000-8000-0000000000a2"))
        fixture.coordinator.switchTo("pr-1")
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        assertEquals(
            "019a0000-0000-7000-8000-0000000000a2",
            fixture.host.startedBundles
                .single()
                .releaseId,
        )

        val legacy = Fixture()
        legacy.shelf.add("ota", "pr-1", null, 0)
        legacy.coordinator.refresh()
        assertTrue(legacy.coordinator.openDownloaded("ota"))
        assertNull(
            legacy.host.startedBundles
                .single()
                .releaseId,
        )
    }

    @Test
    fun `a row runs its stored bundle with no request`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        fixture.host.calls.clear()
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        assertTrue(fixture.host.calls.isEmpty())
        assertEquals(listOf("ota"), fixture.host.startedStored)

        // In the stored session's process, Reload runs the same stored bundle again.
        val session = Fixture()
        session.host.storedBundleId = "ota"
        session.shelf.add("ota", "pr-1", null, 0)
        session.coordinator.refresh()
        session.coordinator.reloadApp()
        assertEquals(listOf("ota"), session.host.startedStored)
        assertTrue(session.host.calls.isEmpty())
    }

    @Test
    fun `a handoff keeps its bundle and its guard until the process is replaced`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        installTestBundle(fixture.shelf.source, "other")
        fixture.shelf.add("other", "pr-2", null, 0)
        fixture.coordinator.refresh()
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        assertEquals(listOf("ota"), fixture.host.startedStored)
        // The relaunch is on its way: a second tap, Delete, Clear, or a switch changes nothing of it.
        assertFalse(fixture.coordinator.openDownloaded("ota"))
        assertFalse(fixture.coordinator.openDownloaded("other"))
        assertFalse(fixture.coordinator.switchTo("pr-2"))
        fixture.coordinator.deleteDownloaded("ota")
        fixture.coordinator.clearDownloaded()
        assertEquals(listOf("ota"), fixture.host.startedStored)
        assertNotNull(fixture.shelf.stored("ota"))
        assertNull(fixture.shelf.stored("other"))
    }

    @Test
    fun `a relaunch the system never starts lets go once the screen is back`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        // The intent went out, but the system kept the relaunch from starting: the screen comes back.
        assertFalse(fixture.coordinator.openDownloaded("ota"))
        fixture.coordinator.resumed()
        assertEquals(1, fixture.host.abandoned)
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        assertEquals(listOf("ota", "ota"), fixture.host.startedStored)
        // A screen that comes back with nothing pending calls nothing off.
        val idle = Fixture()
        idle.coordinator.resumed()
        assertEquals(0, idle.host.abandoned)
    }

    @Test
    fun `a screen back while the relaunch has taken its handoff keeps the guard, every time`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        fixture.coordinator.receiveLink(link("pr-new"))
        assertTrue(fixture.host.helperClaims())
        // The relaunch is replacing this process: on the first resume and the next, nothing
        // else starts, and the link waits for the new one.
        repeat(2) { round ->
            fixture.coordinator.resumed()
            // The live host's call-off loses, this time and the next.
            assertEquals(List(round + 1) { false }, fixture.host.callOffs)
            assertEquals(0, fixture.host.abandoned)
            assertFalse(fixture.coordinator.openDownloaded("ota"))
            assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
            assertEquals(1, fixture.coordinator.state.queuedLinks)
            fixture.coordinator.clearDownloaded()
            assertNotNull(fixture.shelf.stored("ota"))
        }
        assertEquals(listOf("ota"), fixture.host.startedStored)
    }

    @Test
    fun `a helper that asks after the screen called its handoff off doesn't relaunch`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        // The helper has its request but hasn't claimed it; the screen comes back first.
        fixture.coordinator.resumed()
        assertEquals(1, fixture.host.abandoned)
        assertFalse(fixture.host.helperClaims())
        assertFalse(fixture.host.helperClaims())
    }

    @Test
    fun `a called-off helper can't claim after another row opens`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        installTestBundle(fixture.shelf.source, "other")
        fixture.shelf.add("other", "pr-2", null, 0)
        fixture.coordinator.refresh()
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        fixture.coordinator.resumed()
        assertTrue(fixture.coordinator.openDownloaded("other"))
        // The first row's helper, late, loses for good; the second row's goes on.
        assertFalse(fixture.host.helperClaims(0))
        assertTrue(fixture.host.helperClaims(1))
        assertFalse(fixture.host.helperClaims(0))
    }

    @Test
    fun `a check still running when the screen comes back hands nothing off`() {
        val shelfThread = Executors.newSingleThreadExecutor()
        val fixture = Fixture(shelfContext = shelfThread.asCoroutineDispatcher())
        val drain = { repeat(10) { shelfThread.submit {}.get() } }
        fixture.coordinator.switchTo("pr-1")
        drain()
        val disk = CountDownLatch(1)
        shelfThread.submit { disk.await() }
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        fixture.coordinator.resumed()
        disk.countDown()
        drain()
        assertTrue(fixture.host.startedStored.isEmpty())
        shelfThread.shutdown()
    }

    @Test
    fun `a link during a handoff waits, and the pending bundle outlasts the cap`() {
        val fixture = Fixture()
        // Ten bundles listed, the one being opened the oldest.
        fixture.shelf.add("ota", "pr-1", null, 0)
        for (index in 1 until HotUpdaterSandboxShelf.LIMIT) {
            installTestBundle(fixture.shelf.source, "b$index")
            fixture.shelf.add("b$index", "pr-b$index", null, index.toLong())
        }
        fixture.coordinator.refresh()
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        fixture.coordinator.receiveLink(link("pr-new"))
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        assertEquals(1, fixture.coordinator.state.queuedLinks)
        fixture.coordinator.confirmLink()
        assertTrue(fixture.host.calls.isEmpty())
        assertNotNull(fixture.shelf.stored("ota"))
        assertEquals(HotUpdaterSandboxShelf.LIMIT, fixture.shelf.entries.size)
        // Once the handoff resolves, the link is asked about.
        fixture.coordinator.resumed()
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Confirming)
    }

    @Test
    fun `a handoff that never goes out lets go`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        fixture.host.handoffFails = true
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        fixture.host.handoffFails = false
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        assertEquals(listOf("ota"), fixture.host.startedStored)
    }

    @Test
    fun `a row whose files are gone checks its channel`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        java.io.File(fixture.shelf.root, "ota").deleteRecursively()
        fixture.host.calls.clear()
        fixture.coordinator.openDownloaded("ota")
        assertTrue(fixture.host.startedStored.isEmpty())
        assertEquals(listOf("preflight pr-1", "check pr-1"), fixture.host.calls)
    }

    @Test
    fun `a row without files stays when its channel has nothing new`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        java.io.File(fixture.shelf.root, "ota").deleteRecursively()
        val row = fixture.shelf.entries
        fixture.host.stageResult = Result.success(HotUpdaterSandboxStaged.NoUpdate)
        repeat(2) {
            fixture.host.calls.clear()
            assertTrue(fixture.coordinator.openDownloaded("ota"))
            assertEquals(listOf("preflight pr-1", "check pr-1"), fixture.host.calls)
            assertEquals(row, fixture.shelf.entries)
            assertEquals(row, fixture.coordinator.state.downloaded)
        }
        assertTrue(fixture.host.startedStored.isEmpty())
    }

    @Test
    fun `a row without files stays when its channel can't be checked`() {
        val fixture = Fixture()
        fixture.coordinator.switchTo("pr-1")
        java.io.File(fixture.shelf.root, "ota").deleteRecursively()
        val row = fixture.shelf.entries
        fixture.host.preflights["pr-1"] = Result.failure(IOException("offline"))
        fixture.coordinator.openDownloaded("ota")
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Failed)
        assertEquals(row, fixture.shelf.entries)
        assertEquals(row, fixture.coordinator.state.downloaded)
    }

    @Test
    fun `in a stored session a typed channel is refused with a way back`() {
        val fixture = Fixture()
        fixture.host.storedBundleId = "ota"
        fixture.coordinator.switchTo("pr-2")
        val phase = fixture.phase as HotUpdaterSandboxPhase.Failed
        assertEquals(HotUpdaterSandboxFailure.InStoredSession, phase.failure)
        assertEquals("Back", HotUpdaterSandboxQuestion.of(phase, isOverApp = true)?.accept)
        assertTrue(fixture.host.calls.isEmpty())
        fixture.coordinator.retry()
        assertEquals(1, fixture.host.exits)
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
    }

    @Test
    fun `in a stored session a link exits only once confirmed`() {
        val fixture = Fixture()
        fixture.host.storedBundleId = "ota"
        fixture.coordinator.receiveLink(link("pr-1"))
        assertTrue(fixture.phase is HotUpdaterSandboxPhase.Confirming)
        assertEquals(0, fixture.host.exits)
        fixture.coordinator.confirmLink()
        assertEquals(1, fixture.host.exits)
        assertTrue(fixture.host.calls.isEmpty())
    }

    @Test
    fun `a refresh during a switch leaves its copy alone`() {
        val fixture = Fixture()
        val partial = java.io.File(fixture.shelf.root, "ota.tmp").apply { mkdirs() }
        fixture.host.stageGate = CompletableDeferred()
        fixture.coordinator.switchTo("pr-1")
        fixture.coordinator.refresh()
        assertTrue(partial.exists())
        fixture.host.stageGate?.complete(HotUpdaterSandboxStaged.Update("ota"))
        fixture.coordinator.refresh()
        assertFalse(partial.exists())
    }

    @Test
    fun `the main thread never waits for the shelf's files`() {
        val shelfThread = Executors.newSingleThreadExecutor()
        val fixture = Fixture(shelfContext = shelfThread.asCoroutineDispatcher())
        // Work on the shelf's thread can queue more of it: let it all run.
        val drain = { repeat(10) { shelfThread.submit {}.get() } }
        fixture.coordinator.switchTo("pr-1")
        drain()
        // The shelf is busy for as long as the test says: a slow disk.
        installTestBundle(fixture.shelf.source, "other")
        fixture.shelf.add("other", "pr-2", null, 0)
        val disk = CountDownLatch(1)
        shelfThread.submit { disk.await() }
        assertTrue(fixture.coordinator.openDownloaded("ota"))
        // The bundle being opened stays whole through Delete and Clear.
        fixture.coordinator.deleteDownloaded("ota")
        fixture.coordinator.clearDownloaded()
        assertTrue(fixture.host.startedStored.isEmpty())
        assertNotNull(fixture.shelf.stored("ota"))
        disk.countDown()
        drain()
        assertEquals(listOf("ota"), fixture.host.startedStored)
        assertNotNull(fixture.shelf.stored("ota"))
        assertNull(fixture.shelf.stored("other"))
        assertEquals(listOf("ota"), fixture.shelf.entries.map { it.bundleId })
        shelfThread.shutdown()
    }

    @Test
    fun `clear and delete keep the running bundle`() {
        val fixture = Fixture()
        installTestBundle(fixture.shelf.source, "other")
        installTestBundle(fixture.shelf.source, "third")
        fixture.shelf.add("ota", "pr-1", null, 0)
        fixture.shelf.add("other", "pr-2", null, 1)
        fixture.shelf.add("third", "pr-3", null, 2)
        fixture.host.storedBundleId = "ota"
        fixture.coordinator.deleteDownloaded("ota")
        assertNotNull(fixture.shelf.stored("ota"))
        fixture.coordinator.deleteDownloaded("third")
        assertEquals(listOf("other", "ota"), fixture.shelf.entries.map { it.bundleId })
        fixture.coordinator.clearDownloaded()
        assertEquals(listOf("ota"), fixture.shelf.entries.map { it.bundleId })
        assertNull(fixture.shelf.stored("other"))
        assertTrue(fixture.host.calls.isEmpty())
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

    @Test
    fun `open over a running app leaves what's staged for its launch`() {
        val host =
            FakeHost().apply {
                bundleId = "next"
                runningBundleId = "ota-0"
                appRunning = true
            }
        val opens = ArrayList<Pair<Boolean, Boolean>>()
        HotUpdaterSandboxCoordinator(
            host,
            FakeStore(),
            testShelf(),
            CoroutineScope(Dispatchers.Unconfined),
            { a, b -> opens += a to b },
            shelfContext = EmptyCoroutineContext,
        ).open()
        assertEquals(listOf(false to false), opens)
    }

    @Test
    fun `open before the app starts restarts a fixed launch into what's selected`() {
        val host =
            FakeHost().apply {
                bundleId = "built-in"
                runningBundleId = "ota-0"
            }
        val opens = ArrayList<Pair<Boolean, Boolean>>()
        HotUpdaterSandboxCoordinator(
            host,
            FakeStore(),
            testShelf(),
            CoroutineScope(Dispatchers.Unconfined),
            { a, b -> opens += a to b },
            shelfContext = EmptyCoroutineContext,
        ).open()
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
    fun `reset over the app opens nothing, and its row runs the built-in bundle`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.appRunning = true
        assertTrue(fixture.coordinator.resetToBuiltIn())
        assertEquals(listOf("reset"), fixture.host.calls)
        assertTrue("a reset ran the app", fixture.opens.isEmpty())
        assertEquals(HotUpdaterSandboxPhase.Idle, fixture.phase)
        assertEquals(
            true,
            fixture.coordinator.state.selection
                ?.isBuiltIn,
        )
        val row = HotUpdaterSandboxHomeModel.of(fixture.coordinator.state, isOverApp = true, nowMs = 0).bigRow
        assertEquals("Open built-in bundle", row.title)
        assertEquals(HotUpdaterSandboxHomeModel.Action.OPEN_OVER_APP, row.action)
        // Its reload is what runs the built-in bundle over a fixed launch.
        fixture.coordinator.tap(row.action, devServer = null)
        assertEquals(listOf(true to true), fixture.opens)
    }

    @Test
    fun `reset before the app starts opens nothing, and its row opens the built-in bundle`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        assertTrue(fixture.coordinator.resetToBuiltIn())
        assertTrue("a reset ran the app", fixture.opens.isEmpty())
        val row = HotUpdaterSandboxHomeModel.of(fixture.coordinator.state, isOverApp = false, nowMs = 0).bigRow
        assertEquals("Open built-in bundle", row.title)
        assertEquals(HotUpdaterSandboxHomeModel.Action.OPEN, row.action)
        assertEquals(
            true,
            fixture.coordinator.state.selection
                ?.isBuiltIn,
        )
        fixture.coordinator.tap(row.action, devServer = null)
        assertEquals(listOf(false to false), fixture.opens)
    }

    @Test
    fun `a dev server running without a host leaves the row and its tap to the app`() {
        val fixture = Fixture()
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota-1"
        fixture.host.runningBundleId = "ota-1"
        fixture.host.appRunning = true
        assertTrue(fixture.coordinator.resetToBuiltIn())
        val devServer = FakeDevServer(isRunningDevServer = true, runningDevServerHost = null)
        val row = HotUpdaterSandboxHomeModel.of(fixture.coordinator.state, true, devServer.runningDevServerHost, 0).bigRow
        assertEquals("Open built-in bundle", row.title)
        assertEquals(HotUpdaterSandboxHomeModel.Action.OPEN_OVER_APP, row.action)
        // The tap does what the row says: it runs the built-in bundle.
        fixture.coordinator.tap(row.action, devServer)
        assertEquals(0, devServer.reloads)
        assertEquals(listOf(true to true), fixture.opens)
    }

    @Test
    fun `a running dev server's row reloads it`() {
        val fixture = Fixture()
        val devServer = FakeDevServer(isRunningDevServer = true, runningDevServerHost = "localhost:8081")
        val row = HotUpdaterSandboxHomeModel.of(fixture.coordinator.state, true, devServer.runningDevServerHost, 0).bigRow
        assertEquals(HotUpdaterSandboxHomeModel.Action.RELOAD_DEV_SERVER, row.action)
        fixture.coordinator.tap(row.action, devServer)
        assertEquals(1, devServer.reloads)
        assertTrue(fixture.opens.isEmpty())
    }

    @Test
    fun `a second Open while one runs opens nothing more`() {
        val fixture = Fixture()
        val held = CompletableDeferred<Unit>()
        fixture.host.selectionGate = held
        fixture.coordinator.tap(HotUpdaterSandboxHomeModel.Action.OPEN, devServer = null)
        fixture.coordinator.tap(HotUpdaterSandboxHomeModel.Action.OPEN, devServer = null)
        held.complete(Unit)
        assertEquals(listOf(false to false), fixture.opens)
        // Once it opened, Open opens again.
        fixture.coordinator.open()
        assertEquals(2, fixture.opens.size)
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
    fun `open doesn't read as a switch`() {
        val fixture = Fixture()
        fixture.coordinator.open()
        assertEquals(listOf(false to false), fixture.opens)
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
