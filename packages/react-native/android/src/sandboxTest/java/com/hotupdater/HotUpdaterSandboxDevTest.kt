package com.hotupdater

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.lang.reflect.Modifier

class HotUpdaterSandboxDevTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun files() = HotUpdaterSandboxDevFiles(File(folder.root, "dev"))

    private fun HotUpdaterSandboxDevFiles.withSession(id: String): HotUpdaterSandboxDevFiles {
        session(id).mkdirs()
        bundle(id).writeText("bundle")
        return this
    }

    private fun claim(
        session: String = "one",
        witness: Int = 7,
        at: Long = 1_000,
    ) = HotUpdaterSandboxDevClaim(session, "http://localhost:8081", witness, at)

    @Test
    fun `a relaunch with its helper alive runs the session`() {
        val files = files().withSession("one")
        files.writeClaim(claim())
        val session = files.takeSession({ it == 7 }, 1_500)
        assertEquals("one", session?.id)
        assertEquals("http://localhost:8081", session?.host)
        assertEquals(files.bundle("one"), session?.bundle)
    }

    @Test
    fun `an icon tap after an abandoned relaunch finds its helper gone`() {
        val files = files().withSession("one")
        files.writeClaim(claim())
        assertNull(files.takeSession({ false }, 1_500))
        assertFalse(files.claim.exists())
    }

    @Test
    fun `a claim is read once, so a crash re-arms nothing`() {
        val files = files().withSession("one")
        files.writeClaim(claim())
        assertNotNull(files.takeSession({ true }, 1_500))
        assertNull(files.takeSession({ true }, 1_500))
    }

    @Test
    fun `a claim too old, or from before a reboot, arms nothing`() {
        val files = files().withSession("one")
        files.writeClaim(claim(at = 1_000))
        assertNull(files.takeSession({ true }, 1_000 + HotUpdaterSandboxDevFiles.CLAIM_MAX_AGE_MS + 1))
        files.writeClaim(claim(at = 1_000))
        assertNull(files.takeSession({ true }, 500))
    }

    @Test
    fun `a claim without its bundle or a corrupt one arms nothing`() {
        val files = files()
        files.writeClaim(claim(session = "gone"))
        assertNull(files.takeSession({ true }, 1_500))
        files.root.mkdirs()
        files.claim.writeText("{")
        assertNull(files.takeSession({ true }, 1_500))
        assertFalse(files.claim.exists())
    }

    @Test
    fun `a normal process removes everything, a dev process keeps its own session and values`() {
        val files = files().withSession("one").withSession("two")
        files.keyValueFile.writeText("{}")
        val running = HotUpdaterSandboxDevSession("one", "host", files.bundle("one"))
        assertEquals(listOf(files.session("two")), files.staleEntries(running))
        assertEquals(setOf("sessions", "storage.json"), files.staleEntries(null).map { it.name }.toSet())
    }

    private class Recording : BundleStorageService {
        val calls = ArrayList<String>()

        private fun record(name: String) {
            calls += name
        }

        override fun setBundleURL(localPath: String?) = true.also { record("setBundleURL") }

        override fun getCachedBundleURL() = "cached".also { record("getCachedBundleURL") }

        override fun getFallbackBundleURL() = "assets://index.android.bundle"

        override fun prepareLaunch(pendingRecovery: PendingCrashRecovery?) =
            LaunchSelection("ota", "ota", true).also { record("prepareLaunch") }

        override fun settlePreviousLaunch(pendingRecovery: () -> PendingCrashRecovery?) {
            record("settlePreviousLaunch")
            pendingRecovery()
        }

        override fun peekLaunchBundleId() = "ota".also { record("peekLaunchBundleId") }

        override suspend fun updateBundle(
            bundleId: String,
            manifestUrl: String,
            manifestFileHash: String,
            assets: Map<String, ChangedAssetDescriptor>,
            archiveUrl: String?,
            fileResolver: ArtifactFileResolver?,
            selection: PersistedSelection?,
            progressCallback: (UpdateProgressPayload) -> Unit,
        ) = UpdateBundleResult(BundleDelivery.PATCH, false).also { record("updateBundle") }

        override fun acceptReleaseCatalog(
            catalogId: String,
            scopeKey: String,
            generation: Long,
            catalogHash: String,
            channel: String,
            selectionContextHash: String,
        ) = false.also { record("acceptReleaseCatalog") }

        override fun getActiveUpdateState() =
            mapOf<String, Any?>("activeSelection" to mapOf("channel" to "pr-1")).also {
                record("getActiveUpdateState")
            }

        override fun isReleaseSelectionCurrent(
            catalogId: String,
            scopeKey: String,
            generation: Long,
            catalogHash: String,
            channel: String,
            selectionContextHash: String,
        ) = false.also { record("isReleaseSelectionCurrent") }

        override suspend fun commitReleaseSelection(selection: PersistedSelection) = false.also { record("commitReleaseSelection") }

        override fun markLaunchStarted(launchedBundleId: String?) = record("markLaunchStarted")

        override fun clearLaunchStarted(launchedBundleId: String?) = record("clearLaunchStarted")

        override fun markLaunchCompleted(currentBundleId: String?) = record("markLaunchCompleted")

        override fun notifyAppReady() = mapOf<String, Any?>("status" to "UPDATE_APPLIED").also { record("notifyAppReady") }

        override fun getCrashHistory() = CrashedHistory(bundles = mutableListOf()).also { record("getCrashHistory") }

        override fun clearCrashHistory() = true.also { record("clearCrashHistory") }

        override fun getBaseURL() = "base".also { record("getBaseURL") }

        override fun getBaseURLForBundle(bundleId: String?) = "base".also { record("getBaseURLForBundle") }

        override fun getBundleId() = "ota".also { record("getBundleId") }

        override fun getManifest() = mapOf<String, Any?>("a" to 1).also { record("getManifest") }

        override fun getManifestForBundle(bundleId: String?) = mapOf<String, Any?>("a" to 1).also { record("getManifestForBundle") }

        override suspend fun resetChannel() = false.also { record("resetChannel") }

        override suspend fun resetChannelIfSelectionCurrent(
            catalogId: String,
            scopeKey: String,
            generation: Long,
            catalogHash: String,
            channel: String,
            selectionContextHash: String,
        ) = false.also { record("resetChannelIfSelectionCurrent") }
    }

    @Test
    fun `the dev storage never reaches the normal selection's store`() =
        runBlocking {
            val normal = Recording()
            val dev = HotUpdaterSandboxDevStorage(normal)
            var settled = false

            assertFalse(dev.setBundleURL("x"))
            assertNull(dev.getCachedBundleURL())
            dev.settlePreviousLaunch {
                settled = true
                null
            }
            assertNull(dev.peekLaunchBundleId())
            assertEquals(
                BundleDelivery.ARCHIVE,
                dev.updateBundle("b", "u", "h", emptyMap(), null, null, null) {}.delivery,
            )
            assertTrue(dev.acceptReleaseCatalog("c", "s", 1, "h", "ch", "sc"))
            assertNull(dev.getActiveUpdateState()["activeSelection"])
            assertNull(dev.getActiveUpdateState()["stableSelection"])
            assertTrue(dev.isReleaseSelectionCurrent("c", "s", 1, "h", "ch", "sc"))
            dev.markLaunchStarted("b")
            dev.clearLaunchStarted("b")
            dev.markLaunchCompleted("b")
            assertEquals("UNCHANGED", dev.notifyAppReady()["status"])
            assertTrue(dev.getCrashHistory().bundles.isEmpty())
            assertTrue(dev.clearCrashHistory())
            assertEquals("", dev.getBaseURL())
            assertEquals("", dev.getBaseURLForBundle("b"))
            assertNull(dev.getBundleId())
            assertTrue(dev.getManifest().isEmpty())
            assertTrue(dev.getManifestForBundle("b").isEmpty())
            assertTrue(dev.resetChannel())
            assertTrue(dev.resetChannelIfSelectionCurrent("c", "s", 1, "h", "ch", "sc"))

            assertFalse("a dev session consumed a crash marker", settled)
            assertEquals(emptyList<String>(), normal.calls)
        }

    @Test
    fun `the dev storage declares every method itself, so none falls through to a default`() {
        val declared =
            HotUpdaterSandboxDevStorage::class.java.declaredMethods
                .map { it.name }
                .toSet()
        val missing =
            BundleStorageService::class.java.methods
                .filter { Modifier.isAbstract(it.modifiers) || it.isDefault }
                .map { it.name }
                .filterNot { it in declared }
        assertEquals(emptyList<String>(), missing)
    }

    private class Preferences : PreferencesService {
        val values = HashMap<String, String?>()

        override fun getItem(key: String) = values[key]

        override fun setItem(
            key: String,
            value: String?,
        ) {
            values[key] = value
        }
    }

    @Test
    fun `a dev process reads a channel without releases and writes nothing`() {
        val normal = Preferences().apply { values[HotUpdaterSandboxDev.CHANNEL_STORAGE_KEY] = "pr-1" }
        val dev = HotUpdaterSandboxDevPreferences(normal)
        assertEquals(HotUpdaterSandboxDev.DEV_CHANNEL, dev.getItem(HotUpdaterSandboxDev.CHANNEL_STORAGE_KEY))
        dev.setItem(HotUpdaterSandboxDev.CHANNEL_STORAGE_KEY, "pr-2")
        assertEquals("pr-1", normal.getItem(HotUpdaterSandboxDev.CHANNEL_STORAGE_KEY))
    }

    @Test
    fun `hosts normalize as a person types them`() {
        assertEquals("http://192.168.0.2:8081", HotUpdaterSandboxDevHost.normalize(" 192.168.0.2 "))
        assertEquals("http://192.168.0.2:9000", HotUpdaterSandboxDevHost.normalize("192.168.0.2:9000/"))
        assertEquals("https://dev.example.com:8081", HotUpdaterSandboxDevHost.normalize("https://dev.example.com"))
        assertEquals("http://[::1]:8081", HotUpdaterSandboxDevHost.normalize("[::1]"))
        assertNull(HotUpdaterSandboxDevHost.normalize(""))
        assertNull(HotUpdaterSandboxDevHost.normalize("ftp://host"))
        assertNull(HotUpdaterSandboxDevHost.normalize("host/path"))
        assertNull(HotUpdaterSandboxDevHost.normalize("two words"))
        assertEquals("[::1]", HotUpdaterSandboxDevHost.hostname("http://[::1]:8081").let { "[$it]" })
        assertEquals("localhost", HotUpdaterSandboxDevHost.hostname("http://localhost:8081"))
    }

    @Test
    fun `recent hosts come first, each once`() {
        assertEquals(
            listOf("http://a:1", "http://10.0.2.2:8081", "http://localhost:8081"),
            HotUpdaterSandboxDevHost.listed(true, listOf("http://a:1", "http://localhost:8081").take(1)),
        )
        assertEquals(
            listOf("http://localhost:8081"),
            HotUpdaterSandboxDevHost.listed(false, listOf("http://localhost:8081")),
        )
    }

    @Test
    fun `an Expo manifest names the entry, without its query or host`() {
        assertEquals(
            "examples/expo-52/index.ts",
            HotUpdaterSandboxDevFetcher.entryOfManifest(
                """{"launchAsset":{"url":"http://127.0.0.1:8099/examples/expo-52/index.ts.bundle?platform=android&dev=true"}}""",
            ),
        )
        assertNull(HotUpdaterSandboxDevFetcher.entryOfManifest("<html>"))
        assertNull(HotUpdaterSandboxDevFetcher.entryOfManifest("""{"launchAsset":{}}"""))
    }

    @Test
    fun `assets take the names React Native reads beside a bundle file`() {
        assertEquals("src_assets_logo", HotUpdaterSandboxDevFetcher.resourceName("/assets/src/assets", "logo"))
        assertEquals("node_modules_foo_logo2", HotUpdaterSandboxDevFetcher.resourceName("/assets/node_modules/foo", "logo-2"))
        assertEquals("xhdpi", HotUpdaterSandboxDevFetcher.scaleFolder(2.0))
    }
}
