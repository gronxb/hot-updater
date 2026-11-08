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
import kotlin.coroutines.EmptyCoroutineContext

private fun selection(
    channel: String = "pr-1",
    bundleId: String = "ota",
) = HotUpdaterSandboxSelection(channel, "sandbox-release", bundleId, bundleId == "built-in")

/**
 * Three launches the SDK can leave, as its own files state them. Each expectation
 * comes from what happened to the device, not from what the derivation returns.
 */
class HotUpdaterSandboxLastLaunchTest {
    private val kindCrashedBefore = HotUpdaterSandboxLastLaunch.Kind.CRASHED_BEFORE_CONTENT
    private val kindEnded = HotUpdaterSandboxLastLaunch.Kind.ENDED_BEFORE_CONTENT
    private val kindCrashed = HotUpdaterSandboxLastLaunch.Kind.CRASHED

    @Test
    fun `a crash before first content rolled back`() {
        val evidence =
            HotUpdaterSandboxLaunchEvidence(
                HotUpdaterSandboxCrashMarker("ota", true),
                HotUpdaterSandboxRollback("ota", "built-in"),
            )
        assertEquals(
            HotUpdaterSandboxLastLaunch(kindCrashedBefore, "ota", "built-in"),
            HotUpdaterSandboxLastLaunch.derive(evidence, "built-in"),
        )
    }

    @Test
    fun `a verified crash did not roll back`() {
        val evidence = HotUpdaterSandboxLaunchEvidence(HotUpdaterSandboxCrashMarker("ota", false))
        assertEquals(
            HotUpdaterSandboxLastLaunch(kindCrashed, "ota", null),
            HotUpdaterSandboxLastLaunch.derive(evidence, "ota"),
        )
    }

    @Test
    fun `leaving before first content leaves no marker and no crash is claimed`() {
        val evidence = HotUpdaterSandboxLaunchEvidence(rollback = HotUpdaterSandboxRollback("ota", "built-in"))
        assertEquals(
            HotUpdaterSandboxLastLaunch(kindEnded, "ota", "built-in"),
            HotUpdaterSandboxLastLaunch.derive(evidence, "built-in"),
        )
    }

    @Test
    fun `a marker of another bundle is not that rollback's crash`() {
        val evidence =
            HotUpdaterSandboxLaunchEvidence(
                HotUpdaterSandboxCrashMarker("other", true),
                HotUpdaterSandboxRollback("ota", "built-in"),
            )
        assertEquals(kindEnded, HotUpdaterSandboxLastLaunch.derive(evidence, "built-in")?.kind)
    }

    @Test
    fun `no rollback is claimed when the selection is somewhere else`() {
        val evidence =
            HotUpdaterSandboxLaunchEvidence(
                HotUpdaterSandboxCrashMarker("ota", true),
                HotUpdaterSandboxRollback("ota", "built-in"),
            )
        val last = HotUpdaterSandboxLastLaunch.derive(evidence, "newer")
        assertEquals(kindCrashed, last?.kind)
        assertNull(last?.rolledBackToBundleId)
    }

    @Test
    fun `nothing left says nothing`() {
        assertNull(HotUpdaterSandboxLastLaunch.derive(HotUpdaterSandboxLaunchEvidence(), "ota"))
    }
}

private class ScreenHost : HotUpdaterSandboxHost {
    var serverConfig = true
    var channel = "sandbox-release"
    var bundleId = "built-in"
    var evidence = HotUpdaterSandboxLaunchEvidence()
    var stage: HotUpdaterSandboxStaged = HotUpdaterSandboxStaged.Update("ota")
    var preflightGate: CompletableDeferred<Boolean>? = null
    val calls = ArrayList<String>()

    override fun fingerprintHash() = "abc"

    override fun hasServerConfig() = serverConfig

    override fun launchEvidence() = evidence

    override fun details() = HotUpdaterSandboxDetails("built-in", "abc", null)

    override suspend fun selection() = HotUpdaterSandboxSelection(channel, "sandbox-release", bundleId, bundleId == "built-in")

    /** Set to read a launch apart from what's next, as over a running app. */
    var launchOverride: String? = null

    override suspend fun launchBundleId() = launchOverride ?: bundleId

    var appRunning = false

    override fun isAppRunning() = appRunning

    override suspend fun preflight(channel: String): Boolean {
        calls += "preflight $channel"
        return preflightGate?.await() ?: true
    }

    override suspend fun reset(): Boolean {
        calls += "reset"
        return true
    }

    override suspend fun checkAndStage(
        channel: String,
        onProgress: (Double) -> Unit,
    ): HotUpdaterSandboxStaged {
        calls += "check $channel"
        this.channel = channel
        (stage as? HotUpdaterSandboxStaged.Update)?.bundleId?.let { bundleId = it }
        return stage
    }
}

private class ScreenStore(
    override var pendingLinks: List<String> = emptyList(),
) : HotUpdaterSandboxStore {
    val opened = ArrayList<String>()
    val openedBundles = ArrayList<String?>()
    override var lastLaunch: HotUpdaterSandboxLastLaunch? = null

    override fun recordSelected(selection: HotUpdaterSandboxSelection) = Unit

    override fun recordOpened(selection: HotUpdaterSandboxSelection) {
        opened += selection.channel
        openedBundles += selection.bundleId
    }
}

private class ScreenFixture(
    pendingLinks: List<String> = emptyList(),
) {
    val host = ScreenHost()
    val store = ScreenStore(pendingLinks)
    val opens = ArrayList<Pair<Boolean, Boolean>>()
    val shelf = testShelf().also { installTestBundle(it.source, "ota") }
    val coordinator =
        HotUpdaterSandboxCoordinator(
            host = host,
            store = store,
            shelf = shelf,
            scope = CoroutineScope(Dispatchers.Unconfined),
            openApp = { switched, fixed -> opens += switched to fixed },
            nowMs = { 1_000_000L },
            lock = HotUpdaterSandboxLock(),
            copyContext = EmptyCoroutineContext,
        )
}

class HotUpdaterSandboxScreenStateTest {
    private val pending = "hu-sandbox-app://hot-updater/preview?channel=pr-1&fingerprint=abc"

    @Test
    fun `opening the screen sends no request in any state`() {
        val crashed =
            ScreenFixture().apply {
                host.evidence =
                    HotUpdaterSandboxLaunchEvidence(HotUpdaterSandboxCrashMarker("built-in", false))
            }
        val fresh = ScreenFixture().apply { host.serverConfig = false }
        val waiting = ScreenFixture(listOf(pending)).apply { host.serverConfig = false }
        for (fixture in listOf(ScreenFixture(), crashed, fresh, waiting, ScreenFixture(listOf(pending)))) {
            val stop = fixture.coordinator.observe { }
            fixture.coordinator.refresh()
            fixture.coordinator.noteLastLaunch()
            stop()
            assertTrue(fixture.host.calls.isEmpty())
        }
    }

    @Test
    fun `a crash is told once a person moves on, not before`() {
        val fixture = ScreenFixture()
        fixture.host.bundleId = "ota"
        fixture.host.channel = "pr-1"
        fixture.host.evidence = HotUpdaterSandboxLaunchEvidence(HotUpdaterSandboxCrashMarker("ota", false))
        fixture.coordinator.refresh()
        assertEquals(
            HotUpdaterSandboxLastLaunch.Kind.CRASHED,
            fixture.coordinator.state.lastLaunch
                ?.kind,
        )
        assertEquals(HotUpdaterSandboxLastLaunch.Kind.CRASHED, fixture.store.lastLaunch?.kind)

        fixture.coordinator.open()
        assertNull(fixture.coordinator.state.lastLaunch)
        // The marker this process read stays readable, and it's not told again.
        fixture.coordinator.refresh()
        assertNull(fixture.coordinator.state.lastLaunch)
        assertNull(fixture.store.lastLaunch)
    }

    @Test
    fun `an unseen crash survives a restart with no evidence left`() {
        val fixture = ScreenFixture()
        fixture.store.lastLaunch =
            HotUpdaterSandboxLastLaunch(HotUpdaterSandboxLastLaunch.Kind.CRASHED_BEFORE_CONTENT, "ota", "built-in")
        fixture.coordinator.refresh()
        assertEquals(
            HotUpdaterSandboxLastLaunch.Kind.CRASHED_BEFORE_CONTENT,
            fixture.coordinator.state.lastLaunch
                ?.kind,
        )
    }

    @Test
    fun `a switch ends what the last launch left`() {
        val fixture = ScreenFixture()
        fixture.host.evidence = HotUpdaterSandboxLaunchEvidence(HotUpdaterSandboxCrashMarker("built-in", false))
        fixture.coordinator.refresh()
        assertNotNull(fixture.coordinator.state.lastLaunch)
        fixture.coordinator.switchTo("pr-1")
        assertNull(fixture.coordinator.state.lastLaunch)
    }

    @Test
    fun `a switch lists what it downloaded with its message`() {
        val fixture = ScreenFixture()
        fixture.host.stage = HotUpdaterSandboxStaged.Update("ota", "fix: login")
        fixture.coordinator.switchTo("pr-1")
        assertEquals(listOf(HotUpdaterSandboxShelfEntry("ota", "pr-1", "fix: login", "key", 1_000_000L)), fixture.shelf.entries)
        assertNotNull(fixture.shelf.stored("ota"))
        assertEquals("fix: login", fixture.coordinator.state.selectedMessage)
        assertEquals(1, fixture.coordinator.state.downloaded.size)
    }

    @Test
    fun `a message belongs to its bundle, not its channel`() {
        val fixture = ScreenFixture()
        installTestBundle(fixture.shelf.source, "older")
        fixture.shelf.add("older", "pr-1", "old words", 0, null)
        fixture.host.channel = "pr-1"
        fixture.host.bundleId = "ota"
        fixture.coordinator.refresh()
        assertNull(fixture.coordinator.state.selectedMessage)
    }

    @Test
    fun `what runs and what's next are read apart`() {
        val fixture = ScreenFixture()
        fixture.host.channel = "pr-2"
        fixture.host.bundleId = "staged"
        fixture.host.launchOverride = "running"
        installTestBundle(fixture.shelf.source, "running")
        installTestBundle(fixture.shelf.source, "staged")
        fixture.shelf.add("running", "pr-2", "what runs", 0, null)
        fixture.shelf.add("staged", "pr-2", "what's next", 1, null)
        fixture.coordinator.refresh()
        val state = fixture.coordinator.state
        assertEquals("staged", state.selection?.bundleId)
        assertEquals("running", state.runningBundleId)
        assertEquals("what's next", state.selectedMessage)
        assertEquals("what runs", state.runningMessage)
        val row = HotUpdaterSandboxHomeModel.of(state, isOverApp = true, nowMs = 0).bigRow
        assertEquals("Running bundle running", row.subtitle)
        assertEquals("Next launch: bundle staged", row.detail)
        val over = HotUpdaterSandboxInfoModel.of(state, "1", "Release", isOverApp = true)
        assertEquals("running", over.bundle.first { it.name == "Current" }.value)
        // Before the app starts, a fixed launch's Open restarts into what's next.
        val before = HotUpdaterSandboxInfoModel.of(state, "1", "Release")
        assertEquals("staged", before.bundle.first { it.name == "Current" }.value)
    }

    @Test
    fun `a rollback is claimed against what runs, not what's next`() {
        val fixture = ScreenFixture()
        fixture.host.bundleId = "staged"
        fixture.host.launchOverride = "built-in"
        fixture.host.evidence = HotUpdaterSandboxLaunchEvidence(rollback = HotUpdaterSandboxRollback("ota", "built-in"))
        fixture.coordinator.refresh()
        assertEquals(
            "built-in",
            fixture.coordinator.state.lastLaunch
                ?.rolledBackToBundleId,
        )
    }

    @Test
    fun `open records what opens, over the app and before it`() {
        val over = ScreenFixture()
        over.host.channel = "pr-2"
        over.host.bundleId = "staged"
        over.host.launchOverride = "running"
        over.host.appRunning = true
        over.coordinator.open()
        assertEquals("running", over.store.openedBundles.last())
        assertEquals(false, over.opens.last().second)

        // Before the app starts, a fixed launch's Open restarts into what's selected.
        val before = ScreenFixture()
        before.host.channel = "pr-2"
        before.host.bundleId = "staged"
        before.host.launchOverride = "running"
        before.coordinator.open()
        assertEquals("staged", before.store.openedBundles.last())
        assertEquals(true, before.opens.last().second)
    }

    @Test
    fun `opening lists nothing`() {
        val fixture = ScreenFixture()
        fixture.host.channel = "pr-3"
        fixture.coordinator.refresh()
        fixture.coordinator.open()
        assertEquals(listOf("pr-3"), fixture.store.opened)
        assertTrue(fixture.shelf.entries.isEmpty())
    }

    @Test
    fun `reload asks for the reload and waits for a switch`() {
        val fixture = ScreenFixture()
        fixture.coordinator.reloadApp()
        assertEquals(listOf(true to true), fixture.opens)

        val busy = ScreenFixture()
        busy.host.preflightGate = CompletableDeferred()
        busy.coordinator.switchTo("pr-1")
        busy.coordinator.reloadApp()
        assertTrue(busy.opens.isEmpty())
        busy.host.preflightGate?.complete(false)
    }

    @Test
    fun `downloaded says when and how much`() {
        val minute = 60_000L
        assertEquals("downloaded just now", HotUpdaterSandboxHomeModel.downloadedText(0, 30_000))
        assertEquals("downloaded 5 min ago", HotUpdaterSandboxHomeModel.downloadedText(0, 5 * minute))
        assertEquals("downloaded 2 h ago", HotUpdaterSandboxHomeModel.downloadedText(0, 125 * minute))
        assertEquals("downloaded 1 day ago", HotUpdaterSandboxHomeModel.downloadedText(0, 1500 * minute))
        assertEquals("downloaded 3 days ago", HotUpdaterSandboxHomeModel.downloadedText(0, 4400 * minute))
        assertEquals("1 KB", HotUpdaterSandboxHomeModel.sizeText(400))
        assertEquals("2.3 MB", HotUpdaterSandboxHomeModel.sizeText(2_340_000))
        assertEquals("120 MB", HotUpdaterSandboxHomeModel.sizeText(120_400_000))
    }
}

class HotUpdaterSandboxHomeModelTest {
    private fun state(
        selection: HotUpdaterSandboxSelection?,
        running: String? = null,
        hasServerConfig: Boolean = true,
        phase: HotUpdaterSandboxPhase = HotUpdaterSandboxPhase.Idle,
        lastLaunch: HotUpdaterSandboxLastLaunch? = null,
        history: List<HotUpdaterSandboxShelfEntry> = emptyList(),
        storedSession: String? = null,
        message: String? = null,
    ) = HotUpdaterSandboxState(
        selection = selection,
        hasServerConfig = hasServerConfig,
        phase = phase,
        queuedLinks = 0,
        details = HotUpdaterSandboxDetails("built-in", "abc", null),
        lastLaunch = lastLaunch,
        downloaded = history,
        storedSessionBundleId = storedSession,
        selectedMessage = message,
        runningBundleId = running,
    )

    private fun home(
        state: HotUpdaterSandboxState,
        isOverApp: Boolean = false,
    ) = HotUpdaterSandboxHomeModel.of(state, isOverApp, nowMs = 0)

    @Test
    fun `the big row follows the bundle, not the channel`() {
        val otaOnDefault = home(state(selection("sandbox-release", "019a3f00aabbc2")))
        assertEquals("Open sandbox-release", otaOnDefault.bigRow.title)
        assertEquals("Bundle 019a3f…c2", otaOnDefault.bigRow.detail)

        val builtInOnPreview = home(state(selection("pr-1", "built-in")))
        assertEquals("Open built-in bundle", builtInOnPreview.bigRow.title)
        assertEquals("Channel pr-1", builtInOnPreview.bigRow.detail)
    }

    @Test
    fun `a message is shown only when known`() {
        assertNull(home(state(selection())).bigRow.subtitle)
        assertEquals("fix: login", home(state(selection(), message = "fix: login")).bigRow.subtitle)
    }

    @Test
    fun `over the app it says Running and Reload`() {
        val row = home(state(selection()), isOverApp = true).bigRow
        assertEquals("Running", row.caption)
        assertEquals("Reload", row.title)
        assertEquals("Running pr-1", row.subtitle)
        assertTrue(row.isReload)
    }

    @Test
    fun `over the app, running and next are separate when they differ`() {
        val toBuiltIn = home(state(selection(bundleId = "built-in"), running = "ota"), isOverApp = true).bigRow
        assertEquals("Running bundle ota", toBuiltIn.subtitle)
        assertEquals("Next launch: the built-in bundle", toBuiltIn.detail)

        val toOta = home(state(selection(bundleId = "ota"), running = "built-in"), isOverApp = true).bigRow
        assertEquals("Running the built-in bundle", toOta.subtitle)
        assertEquals("Next launch: bundle ota", toOta.detail)
    }

    @Test
    fun `the dev server is what runs when it runs`() {
        val model = HotUpdaterSandboxHomeModel.of(state(selection()), true, "localhost:8081", 0)
        assertEquals("Running the dev server", model.bigRow.subtitle)
        val info = HotUpdaterSandboxInfoModel.of(state(selection()), "1.0 (1)", "Release", runningDevServerHost = "localhost:8081")
        assertEquals("Dev server", info.bundle.first { it.name == "Current" }.value)
    }

    @Test
    fun `a rollback is claimed only by its own banner`() {
        val rolledBack =
            home(
                state(
                    selection(bundleId = "built-in"),
                    lastLaunch = HotUpdaterSandboxLastLaunch(HotUpdaterSandboxLastLaunch.Kind.CRASHED_BEFORE_CONTENT, "ota", "built-in"),
                    history = listOf(entry("ota", "pr-9")),
                ),
            ).banner
        assertEquals("pr-9 crashed before its first screen. The device rolled back to the built-in bundle.", rolledBack?.text)
        assertEquals(false, rolledBack?.offersReset)

        val verified =
            home(
                state(
                    selection(bundleId = "ota"),
                    lastLaunch = HotUpdaterSandboxLastLaunch(HotUpdaterSandboxLastLaunch.Kind.CRASHED, "ota", null),
                ),
            ).banner
        assertEquals("Bundle ota crashed on its last launch, and it's still selected.", verified?.text)
        assertEquals(true, verified?.offersReset)
        assertFalse(verified?.text.orEmpty().contains("rolled back"))

        val left =
            home(
                state(
                    selection(bundleId = "built-in"),
                    lastLaunch = HotUpdaterSandboxLastLaunch(HotUpdaterSandboxLastLaunch.Kind.ENDED_BEFORE_CONTENT, "ota", "built-in"),
                ),
            ).banner
        assertEquals("Bundle ota didn't reach its first screen. The device rolled back to the built-in bundle.", left?.text)
        assertFalse(left?.text.orEmpty().contains("crashed"))
    }

    @Test
    fun `a crashed built-in bundle has no reset to offer`() {
        val banner =
            home(
                state(
                    selection(bundleId = "built-in"),
                    lastLaunch = HotUpdaterSandboxLastLaunch(HotUpdaterSandboxLastLaunch.Kind.CRASHED, "built-in", null),
                ),
            ).banner
        assertEquals("The built-in bundle crashed on its last launch, and it's still selected.", banner?.text)
        assertEquals(false, banner?.offersReset)
    }

    @Test
    fun `a crashed bundle that's no longer selected says what is`() {
        val banner =
            home(
                state(
                    selection(bundleId = "newer"),
                    lastLaunch = HotUpdaterSandboxLastLaunch(HotUpdaterSandboxLastLaunch.Kind.CRASHED, "ota", null),
                ),
            ).banner
        assertEquals("Bundle ota crashed on its last launch. Bundle newer is selected now.", banner?.text)
        assertEquals(false, banner?.offersReset)
    }

    @Test
    fun `the first launch says a server answer is needed`() {
        val hint = home(state(selection(bundleId = "built-in"), hasServerConfig = false)).previewHint.orEmpty()
        assertTrue(hint.contains("answers one of the app's update checks"))
        assertFalse(hint.contains("Open the app once"))
    }

    private fun entry(
        bundleId: String,
        channel: String,
        message: String? = null,
    ) = HotUpdaterSandboxShelfEntry(bundleId, channel, message, "key", 0)

    @Test
    fun `every downloaded bundle is a row, the selected one too`() {
        val model =
            home(
                state(
                    selection("pr-1"),
                    history = listOf(entry("019a3f00aabbc2", "pr-1"), entry("b", "pr-2", "words")),
                    storedSession = "b",
                ),
            )
        assertEquals(
            listOf(
                HotUpdaterSandboxHomeModel.Downloaded("019a3f00aabbc2", "pr-1", null, "Bundle 019a3f…c2 · downloaded just now", false),
                HotUpdaterSandboxHomeModel.Downloaded("b", "pr-2", "words", "Bundle b · downloaded just now", true),
            ),
            model.downloaded,
        )
        assertEquals("2 of 10", model.downloadedFooter)
        assertEquals(
            "Bundles you open from a QR code, a link, or a channel stay here.",
            home(state(selection())).downloadedFooter,
        )
    }

    @Test
    fun `a stored session says what runs and the way back`() {
        val current = state(selection(), history = listOf(entry("019a3f00aabbc2", "pr-12")), storedSession = "019a3f00aabbc2")
        val row = home(current, isOverApp = true).bigRow
        assertEquals("Running stored pr-12", row.subtitle)
        assertEquals("Bundle 019a3f…c2", row.detail)
        assertTrue(row.isReload)
        assertTrue(row.showsBack)
        val info = HotUpdaterSandboxInfoModel.of(current, "1", "Release", isOverApp = true)
        assertEquals("Stored 019a3f…c2", info.bundle.first { it.name == "Current" }.value)
    }

    @Test
    fun `a switch shows its step and holds the rows`() {
        val model =
            home(
                state(
                    selection(),
                    phase = HotUpdaterSandboxPhase.Working(1, "pr-2", HotUpdaterSandboxStep.DOWNLOAD, 0.5),
                ),
            )
        assertEquals(HotUpdaterSandboxHomeModel.Status("Downloading pr-2… 50%", 0.5), model.status)
        assertTrue(model.isBusy)
    }

    @Test
    fun `info shows what the store holds`() {
        val withPending =
            state(selection(bundleId = "019a3f00aabbc2")).copy(
                details = HotUpdaterSandboxDetails("built-in", null, "019a3f00aabbc2"),
            )
        val info = HotUpdaterSandboxInfoModel.of(withPending, "1.0 (1)", "Release")
        assertEquals(listOf("Version", "Configuration", "Fingerprint", "Built-in bundle", "Default channel"), info.build.map { it.name })
        assertEquals("None", info.build.first { it.name == "Fingerprint" }.value)
        assertEquals(listOf("Channel", "Current", "Pending"), info.bundle.map { it.name })
        assertEquals("019a3f…c2", info.bundle.first { it.name == "Current" }.value)
        assertEquals("019a3f…c2", info.bundle.first { it.name == "Pending" }.value)
    }

    @Test
    fun `a link says it replaces the running bundle only over the app`() {
        val phase =
            HotUpdaterSandboxPhase.Confirming(
                HotUpdaterSandboxLink("hu-sandbox-app://hot-updater/preview?channel=pr-1", "hu-sandbox-app", "pr-1", "fp"),
            )
        assertEquals(
            "This replaces the running bundle. Downloaded bundles stay listed.",
            HotUpdaterSandboxQuestion.of(phase, isOverApp = true)?.message,
        )
        assertEquals(HotUpdaterSandboxHomeModel.SWITCH_NOTE, HotUpdaterSandboxQuestion.of(phase, isOverApp = false)?.message)
    }

    @Test
    fun `the license reflows into paragraphs`() {
        val text =
            listOf(
                "Copyright 2024 The Authors",
                "",
                "-----------------------------------------------------------",
                "SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007",
                "-----------------------------------------------------------",
                "",
                "PREAMBLE",
                "The goals of the Open Font License (OFL) are to stimulate ",
                "worldwide development.",
                "",
                "DISCLAIMER",
                "THE FONT SOFTWARE IS PROVIDED \"AS IS\",",
                "WITHOUT WARRANTY OF ANY KIND.",
            ).joinToString("\n")
        assertEquals(
            listOf(
                "Copyright 2024 The Authors",
                "SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007",
                "PREAMBLE",
                "The goals of the Open Font License (OFL) are to stimulate worldwide development.",
                "DISCLAIMER",
                "THE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND.",
            ).joinToString("\n\n"),
            HotUpdaterSandboxInfoModel.reflow(text),
        )
    }
}

class HotUpdaterSandboxCrashMarkerFileTest {
    /** The SDK keeps the file's name private, so its own reader says this is the one. */
    @Test
    fun `the marker the process reads at start is the one the SDK reads`() {
        val filesDir =
            java.nio.file.Files
                .createTempDirectory("marker")
                .toFile()
        val marker = HotUpdaterSandboxProcess.crashMarkerFile(filesDir)
        marker.parentFile?.mkdirs()
        marker.writeText("""{"bundleId":"ota","shouldRollback":true}""")
        assertTrue(HotUpdaterRecoveryManager.crashMarkerRequestsRollback(filesDir, listOf(HotUpdaterInstanceEnvironment.MAIN_NAME)))
        assertEquals("ota", PendingCrashRecovery.loadFromFile(marker)?.launchedBundleId)
        filesDir.deleteRecursively()
    }
}
