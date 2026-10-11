package com.hotupdater.lynx

import android.os.Looper
import android.system.Os
import android.view.View
import android.widget.FrameLayout
import com.hotupdater.lynx.internal.HashUtils
import java.io.File
import java.io.FileDescriptor
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.IdentityHashMap
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [HostFileSystem::class])
@LooperMode(LooperMode.Mode.PAUSED)
class HotUpdaterLynxHostTest {
    private class Engine(val session: LynxLaunchSession, val detached: () -> Unit) : ManagedLynxRuntime {
        override val view = View(RuntimeEnvironment.getApplication())
        var loads = 0
        var destroys = 0
        var ready: Result<JSONObject>? = null
        var loadFailure: Throwable? = null
        override fun load() { loads++; loadFailure?.let { throw it } }
        override fun destroy() { destroys++ }
        fun missingManagedResource() {
            var failed = false
            session.resources.generic.fetchResource(
                com.lynx.tasm.resourceprovider.LynxResourceRequest(
                    "hot-updater:///missing-resource.js",
                    com.lynx.tasm.resourceprovider.LynxResourceRequest.LynxResourceType.LynxResourceTypeGeneric,
                ),
                object : com.lynx.tasm.resourceprovider.LynxResourceCallback<ByteArray> {
                    override fun onResponse(response: com.lynx.tasm.resourceprovider.LynxResourceResponse<ByteArray>) {
                        failed = response.state == com.lynx.tasm.resourceprovider.LynxResourceResponse.ResponseState.FAILED
                    }
                },
            )
            assertTrue(failed)
        }
        fun contentAndReady() {
            session.resolveEssential(session.pageEntry)
            session.firstScreen = true
            session.notifyReady { ready = it }
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private class Fixture(private val failLoad: Boolean = false) : AutoCloseable {
        val root = Files.createTempDirectory("lynx-plain-host-").toFile()
        val context = RuntimeEnvironment.getApplication()
        val engines = mutableListOf<Engine>()
        val errors = mutableListOf<Throwable>()
        val embedded = File(root, "embedded").apply { mkdirs() }
        val files = listOf("main.lynx.bundle", "detail.lynx.bundle").associateWith {
            HashUtils.calculateSHA256(File(embedded, it).apply { writeText("verified-$it") })
        }
        val configuration = LynxHostConfiguration("plain-lynx4", "production", "1.0.0",
            embedded.path, "00000000-0000-0000-0000-000000000000", "e".repeat(64),
            "00000000-0000-0000-0000-000000000000", "1", pageHostMode = LynxPageHostMode.MOUNTED)
        val runtime = LynxRuntimeHost(root, File(root, "app.apk").apply { writeText("native") },
            VerifiedLynxInstallation(configuration.embeddedBundleId, embedded, "main.lynx.bundle",
                configuration.runtimeId, configuration.embeddedManifestHash, files,
                pageEntries = files.keys.toList(),
                pageEssentialResources = files.keys.map { LynxPageEssentialResources(it, listOf(it)) }),
            configuration, processIdentity = { "4321" })
        val host = HotUpdaterLynxHost(runtime, emptyMap(), errors::add) { _, session, _, detached ->
            Engine(session, detached).also {
                if (failLoad) it.loadFailure = IllegalStateException("Native load failed")
                engines.add(it)
            }
        }
        fun primary() = host.mountPrimary(context)
        fun detail() = host.mount(context, "detail.lynx.bundle")
        fun journal(): JSONObject {
            val scope = File(root, "hot-updater-lynx/scopes").listFiles()!!.single()
            return JSONObject(File(scope, "state.json").readText())
        }
        fun idle() = shadowOf(Looper.getMainLooper()).idle()
        fun reload(): Result<JSONObject> {
            var result: Result<JSONObject>? = null
            engines.first().session.reloadAction().invoke("reload") { result = it }
            return checkNotNull(result)
        }
        override fun close() {
            host.close()
            engines.toList().forEach { it.detached() }
            idle()
            root.deleteRecursively()
        }
    }

    @Test fun ownerDoesNotAcquireForegroundUntilPrimaryMounts(): Unit = Fixture().use { f ->
        assertFalse(File(f.root, "hot-updater-lynx/scopes").exists())
        assertTrue(f.engines.isEmpty())
        val primary = f.primary()
        assertEquals(1, primary.childCount)
        assertEquals(1, f.engines.single().loads)
        assertThrows(IllegalStateException::class.java) { f.runtime.createForegroundForMounts(
            listOf(LynxLogicalPage("main.lynx.bundle", mountId = "another"))) }
    }

    @Test fun aFailedEmbeddedLoadCannotRestartTheSamePayloadIndefinitely(): Unit = Fixture(failLoad = true).use { f ->
        f.primary(); f.idle()
        assertEquals(1, f.engines.single().destroys)
        f.engines.single().detached(); f.idle()
        assertEquals(1, f.engines.size)
        assertEquals(1, f.errors.size)
        assertThrows(IllegalStateException::class.java) { f.detail() }
    }

    @Test fun identicalPagesDeclareWhilePendingAndMiddleRemovalPreservesTheOtherView(): Unit = Fixture().use { f ->
        f.primary()
        val a = f.detail()
        val b = f.detail()
        assertEquals(2, f.engines.size)
        assertEquals(0, b.childCount)
        assertEquals(3, f.journal().getJSONArray("logicalStack").length())
        val primary = f.engines[0]
        primary.contentAndReady()
        assertNull(primary.ready)
        f.engines[1].contentAndReady()
        val bEngine = f.engines[2]
        val pending = f.journal().getJSONObject("pageAttempt").toString()
        a.close()
        assertEquals(0, a.childCount)
        assertEquals(1, b.childCount)
        assertEquals(pending, f.journal().getJSONObject("pageAttempt").toString())
        assertNotEquals(f.engines[1].session.mountId, bEngine.session.mountId)
        bEngine.contentAndReady()
        assertTrue(primary.ready?.isSuccess == true)
        assertEquals(2, f.journal().getJSONArray("logicalStack").length())
        assertTrue(f.errors.isEmpty())
    }

    @Test fun pendingAndQueuedRemovalCannotConfirmOrResurrectOldContexts(): Unit = Fixture().use { f ->
        f.primary()
        val a = f.detail()
        val b = f.detail()
        val old = f.engines[1]
        val pending = f.journal().getJSONObject("pageAttempt").toString()
        b.close()
        assertEquals(pending, f.journal().getJSONObject("pageAttempt").toString())
        a.close()
        assertEquals("authorized-cancel", f.journal().getJSONObject("lastPageAttempt").getString("terminal"))
        assertFalse(f.journal().has("pageAttempt"))
        old.session.notifyReady { assertTrue(it.isFailure) }
        f.detail()
        assertNotEquals(old.session.mountId, f.engines.last().session.mountId)
        assertEquals(3, f.engines.size)
    }

    @Test fun reparentingIsNotUnmountingAndPrimaryRemovalNeverPromotesSecondary(): Unit = Fixture().use { f ->
        val primary = f.primary()
        val detail = f.detail()
        val parent = FrameLayout(f.context)
        val other = FrameLayout(f.context)
        parent.addView(detail)
        parent.removeView(detail)
        other.addView(detail)
        assertEquals(0, f.engines[1].destroys)
        assertEquals(2, f.journal().getJSONArray("logicalStack").length())
        primary.close()
        assertEquals(listOf(1, 1), f.engines.map { it.destroys })
        assertEquals(0, detail.childCount)
        assertFalse(f.engines[1].session.live)
        assertThrows(IllegalStateException::class.java) { f.detail() }
    }

    @Test fun replacementWaitsForEveryRuntimeIncludingAnAlreadyUnmountedView(): Unit = Fixture().use { f ->
        val primary = f.primary()
        val a = f.detail()
        f.engines[1].contentAndReady()
        val b = f.detail()
        val old = f.engines.toList()
        a.close()
        val accepted = f.reload()
        assertEquals("TRANSITION_ACCEPTED", accepted.getOrThrow().getString("status"))
        assertEquals(0, old[0].destroys)
        f.idle()
        assertEquals(listOf(1, 1, 1), old.map { it.destroys })
        old[0].detached(); old[2].detached(); f.idle()
        assertEquals(3, f.engines.size)
        assertThrows(IllegalStateException::class.java) { f.runtime.createForegroundForMounts(
            listOf(LynxLogicalPage("main.lynx.bundle", mountId = "competing"))) }
        old[1].detached(); f.idle()
        assertEquals(5, f.engines.size)
        assertEquals(1, primary.childCount)
        assertEquals(0, a.childCount)
        assertEquals(1, b.childCount)
        assertNotEquals(old[0].session.generationId, f.engines[3].session.generationId)
        assertEquals(old[2].session.mountId, f.engines[4].session.mountId)
        old.forEach { it.session.notifyReady { result -> assertTrue(result.isFailure) }; it.detached() }
        f.idle()
        assertEquals(5, f.engines.size)
        assertTrue(f.errors.isEmpty())
    }

    @Test fun mountChangesDuringReplacementAreAppliedBeforeNewTemplatesExecute(): Unit = Fixture().use { f ->
        f.primary()
        val removed = f.detail()
        val old = f.engines.toList()
        f.reload().getOrThrow()
        removed.close()
        val added = f.detail()
        assertEquals(0, added.childCount)
        f.idle()
        old.forEach { it.detached() }; f.idle()
        assertEquals(4, f.engines.size)
        assertEquals(0, removed.childCount)
        assertEquals(1, added.childCount)
        val pages = f.journal().getJSONArray("logicalStack")
        assertEquals(2, pages.length())
        assertEquals(f.engines.last().session.mountId, pages.getJSONObject(1).getString("mountId"))
        assertNotEquals(old[1].session.mountId, f.engines.last().session.mountId)
        assertTrue(f.errors.isEmpty())
    }

    @Test fun closingDuringReplacementCannotStartAnotherGeneration(): Unit = Fixture().use { f ->
        f.primary(); f.detail()
        f.reload().getOrThrow()
        f.host.close()
        f.idle()
        f.engines.toList().forEach { it.detached() }; f.idle()
        assertEquals(2, f.engines.size)
        assertTrue(f.engines.all { !it.session.live && it.destroys == 1 })
    }

    @Test fun confirmedPrimaryResourceFailureRetiresTheWholeHost(): Unit = Fixture().use { f ->
        f.primary(); f.detail()
        f.engines[1].contentAndReady(); f.engines[0].contentAndReady()
        assertTrue(f.engines[0].ready?.isSuccess == true)
        val old = f.engines.toList()
        old[0].missingManagedResource()
        assertTrue(old[0].session.controller.generationFailed)
        assertEquals(old[0].session.id, f.journal().getJSONObject("generationFailure").getString("pageAttemptId"))
        f.idle()
        assertTrue(old.all { it.destroys == 1 && !it.session.live })
        old.forEach { it.detached() }; f.idle()
        assertEquals(1, f.errors.size)
        assertEquals(old.size, f.engines.size)
    }

    @Test fun admittedMemberFailureCancelsAnotherPendingPageWithoutBlamingIt(): Unit = Fixture().use { f ->
        f.primary(); f.detail()
        f.engines[1].contentAndReady(); f.engines[0].contentAndReady()
        val admitted = f.engines[1]
        f.detail()
        val pending = f.engines[2]
        val old = f.engines.toList()
        admitted.missingManagedResource()
        assertTrue(admitted.session.controller.generationFailed)
        val journal = f.journal()
        assertEquals(admitted.session.id, journal.getJSONObject("generationFailure").getString("pageAttemptId"))
        assertFalse(journal.has("pageAttempt"))
        val terminals = journal.getJSONArray("pageAttemptTerminals")
        val admittedTerminals = (0 until terminals.length()).map(terminals::getJSONObject)
            .filter { it.getString("attemptId") == admitted.session.id }
        val pendingTerminals = (0 until terminals.length()).map(terminals::getJSONObject)
            .filter { it.getString("attemptId") == pending.session.id }
        assertEquals(listOf("admitted"), admittedTerminals.map { it.getString("terminal") })
        assertEquals(listOf("authorized-cancel"), pendingTerminals.map { it.getString("terminal") })
        assertEquals("generationFailure", pendingTerminals.single().getString("reason"))
        f.idle()
        assertTrue(old.all { it.destroys == 1 && !it.session.live })
        old.forEach { it.detached() }; f.idle()
        assertEquals(1, f.errors.size)
    }

    @Test fun failedFatalWriteRetriesWithoutAnotherResourceCallback(): Unit = Fixture().use { f ->
        f.primary(); f.engines[0].contentAndReady()
        val old = f.engines.single()
        val state = File(File(f.root, "hot-updater-lynx/scopes").listFiles()!!.single(), "state.json")
        val saved = File(f.root, "saved-state.json")
        assertTrue(state.renameTo(saved)); assertTrue(state.mkdir())
        try {
            old.missingManagedResource()
            assertTrue(old.session.controller.generationFailed)
            assertEquals(0, old.destroys)
            // Duplicate engine/resource reports cannot replace the retained intent.
            repeat(3) { old.session.resources.onFailure?.invoke("duplicate failure") }
        } finally {
            assertTrue(state.deleteRecursively()); assertTrue(saved.renameTo(state))
        }
        assertFalse(f.journal().has("generationFailure"))
        f.idle()
        assertEquals(old.session.id, f.journal().getJSONObject("generationFailure").getString("pageAttemptId"))
        assertTrue(f.journal().getJSONObject("generationFailure").getString("message").contains("missing-resource.js"))
        assertEquals(1, old.destroys)
        old.detached(); f.idle()
        assertEquals(1, f.errors.size)
        assertEquals(1, f.engines.size)
    }

    @Test fun permanentFatalWriteFailureClosesEveryRuntimeWithoutReopening(): Unit = Fixture().use { f ->
        f.primary(); f.detail()
        f.engines[1].contentAndReady(); f.engines[0].contentAndReady()
        val old = f.engines.toList()
        val state = File(File(f.root, "hot-updater-lynx/scopes").listFiles()!!.single(), "state.json")
        val saved = File(f.root, "saved-state.json")
        assertTrue(state.renameTo(saved)); assertTrue(state.mkdir())
        try {
            old[1].missingManagedResource()
            f.idle()
            assertEquals(1, f.errors.size)
            assertTrue(old.all { it.destroys == 1 && !it.session.live })
            old.forEach { it.detached() }; f.idle()
            assertEquals(old.size, f.engines.size)
            assertThrows(IllegalStateException::class.java) { f.detail() }
        } finally {
            assertTrue(state.deleteRecursively()); assertTrue(saved.renameTo(state))
        }
        assertThrows(IllegalStateException::class.java) { f.runtime.createForegroundForMounts(
            listOf(LynxLogicalPage("main.lynx.bundle", mountId = "replacement"))) }
        assertThrows(IllegalStateException::class.java) { f.runtime.backgroundSnapshot() }
    }

    @Test fun closingBeforeFatalRetryCannotForgetTheUnpersistedFailure(): Unit = Fixture().use { f ->
        f.primary(); f.engines[0].contentAndReady()
        val old = f.engines.single()
        val state = File(File(f.root, "hot-updater-lynx/scopes").listFiles()!!.single(), "state.json")
        val saved = File(f.root, "saved-state.json")
        assertTrue(state.renameTo(saved)); assertTrue(state.mkdir())
        try { old.missingManagedResource() } finally {
            assertTrue(state.deleteRecursively()); assertTrue(saved.renameTo(state))
        }
        val before = state.readText()
        f.host.close(); old.detached(); f.idle()
        assertEquals(before, state.readText())
        assertThrows(IllegalStateException::class.java) { f.runtime.createForegroundForMounts(
            listOf(LynxLogicalPage("main.lynx.bundle", mountId = "replacement"))) }
        assertEquals(1, f.engines.size)
    }

    @Test fun failureAfterReloadAcceptanceCannotChangeTheReplacementSelection(): Unit = Fixture().use { f ->
        f.primary(); f.detail()
        f.engines[1].contentAndReady(); f.engines[0].contentAndReady()
        f.reload().getOrThrow()
        val before = f.journal().toString()
        f.engines[0].missingManagedResource()
        f.engines[1].missingManagedResource()
        assertEquals(before, f.journal().toString())
        assertFalse(f.engines[0].session.controller.generationFailed)
        f.idle()
        assertTrue(f.errors.isEmpty())
    }

    @Test fun exhaustedRecoveryClosesAllViewsAfterPersistingTheFailure(): Unit = Fixture().use { f ->
        val primary = f.primary(); val detail = f.detail()
        // There is no eligible fallback after the only embedded installation fails.
        f.engines[1].session.recordFatalFailure("real member failure")
        f.engines[1].detached(); f.idle()
        assertEquals(1, f.engines[0].destroys)
        f.engines[0].detached(); f.idle()
        assertEquals(1, f.errors.size)
        assertEquals(0, primary.childCount)
        assertEquals(0, detail.childCount)
        assertTrue(f.journal().has("failedEmbedded"))
        assertThrows(IllegalStateException::class.java) { f.detail() }
    }
}

/** Robolectric's Linux.open uses RandomAccessFile, which cannot open macOS directories. */
@Implements(Os::class)
class HostFileSystem {
    companion object {
        private val directories = IdentityHashMap<FileDescriptor, FileChannel>()
        @JvmStatic @Implementation fun open(path: String, flags: Int, mode: Int): FileDescriptor {
            check(File(path).isDirectory && flags == 0 && mode == 0)
            return FileDescriptor().also { directories[it] = FileChannel.open(File(path).toPath(), StandardOpenOption.READ) }
        }
        @JvmStatic @Implementation fun fsync(fd: FileDescriptor) { checkNotNull(directories[fd]).force(true) }
        @JvmStatic @Implementation fun close(fd: FileDescriptor) { checkNotNull(directories.remove(fd)).close() }
        @JvmStatic @Implementation fun rename(from: String, to: String) {
            Files.move(File(from).toPath(), File(to).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
