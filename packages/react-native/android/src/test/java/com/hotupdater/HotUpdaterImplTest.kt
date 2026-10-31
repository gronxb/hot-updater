package com.hotupdater

import android.content.ContextWrapper
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class HotUpdaterImplTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

    @Test
    fun `getBundleId returns built in while native launch selection is missing`() {
        val impl =
            createImpl(
                storageBundleId = "staged-bundle",
                storageManifest = mapOf("bundleId" to "staged-bundle"),
                storageBaseURL = "file:///bundle-store/staged-bundle",
            )

        assertNull(impl.getBundleId())
        assertTrue(impl.getManifest().isEmpty())
        assertNull(impl.getBaseURL())
    }

    @Test
    fun `getBundleId returns current launched bundle over staged metadata`() {
        val impl = createImpl(storageBundleId = "staged-bundle")

        setCurrentLaunchSelection(
            impl,
            LaunchSelection(
                bundleUrl = "file:///bundle-store/launched-bundle/index.android.bundle",
                launchedBundleId = "launched-bundle",
                shouldRollbackOnCrash = false,
            ),
        )

        assertEquals("launched-bundle", impl.getBundleId())
    }

    @Test
    fun `getBundleId returns null for built in launch even when staged metadata exists`() {
        val impl = createImpl(storageBundleId = "staged-bundle")

        setCurrentLaunchSelection(
            impl,
            LaunchSelection(
                bundleUrl = "assets://index.android.bundle",
                launchedBundleId = null,
                shouldRollbackOnCrash = false,
            ),
        )

        assertNull(impl.getBundleId())
    }

    @Test
    fun `getManifest and getBaseURL return current launched bundle over staged metadata`() {
        val impl =
            createImpl(
                storageBundleId = "staged-bundle",
                storageManifest = mapOf("bundleId" to "staged-bundle"),
                storageBaseURL = "file:///bundle-store/staged-bundle",
                launchedBundleManifests =
                    mapOf(
                        "launched-bundle" to mapOf("bundleId" to "launched-bundle"),
                    ),
                launchedBundleBaseURLs =
                    mapOf(
                        "launched-bundle" to "file:///bundle-store/launched-bundle",
                    ),
            )

        setCurrentLaunchSelection(
            impl,
            LaunchSelection(
                bundleUrl = "file:///bundle-store/launched-bundle/index.android.bundle",
                launchedBundleId = "launched-bundle",
                shouldRollbackOnCrash = false,
            ),
        )

        assertEquals(
            mapOf("bundleId" to "launched-bundle"),
            impl.getManifest(),
        )
        assertEquals("file:///bundle-store/launched-bundle", impl.getBaseURL())
    }

    @Test
    fun `getManifest and getBaseURL return built in values for built in launch`() {
        val impl =
            createImpl(
                storageBundleId = "staged-bundle",
                storageManifest = mapOf("bundleId" to "staged-bundle"),
                storageBaseURL = "file:///bundle-store/staged-bundle",
            )

        setCurrentLaunchSelection(
            impl,
            LaunchSelection(
                bundleUrl = "assets://index.android.bundle",
                launchedBundleId = null,
                shouldRollbackOnCrash = false,
            ),
        )

        assertTrue(impl.getManifest().isEmpty())
        assertNull(impl.getBaseURL())
    }

    @Test
    fun `the update check counts the bundle the launch would pick until a bundle launches`() {
        val impl = allocateWithoutConstructor<HotUpdaterImpl>()
        setField(impl, "bundleStorage", FakeBundleStorageService(bundleId = null, nextLaunchBundleId = "staged-bundle"))
        val state = HotUpdaterImplUpdateCheckState(ContextWrapper(null), impl)

        assertNull(impl.getBundleId())
        assertEquals("staged-bundle", impl.getBundleIdForUpdateCheck())
        assertEquals("staged-bundle", state.getBundleId())

        setCurrentLaunchSelection(
            impl,
            LaunchSelection(
                bundleUrl = "file:///bundle-store/launched-bundle/index.android.bundle",
                launchedBundleId = "launched-bundle",
                shouldRollbackOnCrash = false,
            ),
        )
        assertEquals("launched-bundle", state.getBundleId())

        setCurrentLaunchSelection(
            impl,
            LaunchSelection(
                bundleUrl = "assets://index.android.bundle",
                launchedBundleId = null,
                shouldRollbackOnCrash = false,
            ),
        )
        assertNull(state.getBundleId())
    }

    @Test
    fun `a channel reset keeps the bundle React Native runs until a reload`() =
        runBlocking {
            val impl = allocateWithoutConstructor<HotUpdaterImpl>()
            setField(impl, "bundleStorage", FakeBundleStorageService(bundleId = null, nextLaunchBundleId = "default-bundle"))
            setField(impl, "preferences", MapPreferences())
            val launched =
                LaunchSelection(
                    bundleUrl = "file:///bundle-store/channel-bundle/index.android.bundle",
                    launchedBundleId = "channel-bundle",
                    shouldRollbackOnCrash = false,
                )
            setField(impl, "runningLaunchSelection", launched)
            setCurrentLaunchSelection(impl, launched)

            assertTrue(impl.resetChannel())

            assertEquals("channel-bundle", impl.getBundleIdForUpdateCheck())
            // The instance's getter reports the running bundle; the TurboModule's reads the next launch's.
            assertEquals("channel-bundle", impl.getRunningBundleId())
            assertNull(impl.getBundleId())
        }

    private fun launched(bundleId: String?) =
        LaunchSelection(
            bundleUrl = "file:///bundle-store/$bundleId/index.android.bundle",
            launchedBundleId = bundleId,
            shouldRollbackOnCrash = false,
        )

    private fun statusOf(
        runningBundleId: String?,
        nextLaunchBundleId: String?,
    ): HotUpdaterRunningBundles {
        val impl = allocateWithoutConstructor<HotUpdaterImpl>()
        setField(impl, "bundleStorage", FakeBundleStorageService(bundleId = null, nextLaunchBundleId = nextLaunchBundleId))
        val selection = launched(runningBundleId)
        setField(impl, "runningLaunchSelection", selection)
        setCurrentLaunchSelection(impl, selection)
        return impl.getUpdateStatus()
    }

    private val builtInBundleId = HotUpdaterImpl.getMinBundleId()

    @Test
    fun `nothing is pending while the built-in bundle runs and stays next`() {
        val status = statusOf(runningBundleId = null, nextLaunchBundleId = null)

        assertEquals(builtInBundleId, status.bundleId)
        assertNull(status.pendingBundleId)
    }

    @Test
    fun `a bundle staged over the built-in bundle is pending`() {
        val status = statusOf(runningBundleId = null, nextLaunchBundleId = "staged")

        assertEquals(builtInBundleId, status.bundleId)
        assertEquals("staged", status.pendingBundleId)
    }

    @Test
    fun `a bundle staged over a downloaded one is pending`() {
        val status = statusOf(runningBundleId = "running", nextLaunchBundleId = "staged")

        assertEquals("running", status.bundleId)
        assertEquals("staged", status.pendingBundleId)
    }

    @Test
    fun `a bundle on its own launch is not pending, verified or not`() {
        assertNull(statusOf(runningBundleId = "running", nextLaunchBundleId = "running").pendingBundleId)
    }

    @Test
    fun `returning to the built-in bundle is pending`() {
        val status = statusOf(runningBundleId = "running", nextLaunchBundleId = null)

        assertEquals("running", status.bundleId)
        assertEquals(builtInBundleId, status.pendingBundleId)
    }

    @Test
    fun `a channel reset leaves the running bundle and makes the built-in bundle pending`() =
        runBlocking {
            val impl = allocateWithoutConstructor<HotUpdaterImpl>()
            setField(impl, "preferences", MapPreferences())
            setField(impl, "bundleStorage", FakeBundleStorageService(bundleId = null, nextLaunchBundleId = null))
            val selection = launched("channel-bundle")
            setField(impl, "runningLaunchSelection", selection)
            setCurrentLaunchSelection(impl, selection)

            assertTrue(impl.resetChannel())

            val status = impl.getUpdateStatus()
            assertEquals("channel-bundle", status.bundleId)
            assertEquals(builtInBundleId, status.pendingBundleId)
        }

    @Test
    fun `the status JSON gives JavaScript both bundles, and null when nothing is pending`() {
        val impl = allocateWithoutConstructor<HotUpdaterImpl>()
        setField(impl, "bundleStorage", FakeBundleStorageService(bundleId = null, nextLaunchBundleId = "running"))
        val selection = launched("running")
        setField(impl, "runningLaunchSelection", selection)
        setCurrentLaunchSelection(impl, selection)

        val status = org.json.JSONObject(impl.getUpdateStatusJson())

        assertEquals("running", status.getString("bundleId"))
        assertTrue(status.isNull("pendingBundleId"))
    }

    @Test
    fun `a built-in commit clears the next launch's selection and keeps the running bundle`() =
        runBlocking {
            val storage = CommitGatedStorage(committed = true)
            val impl = allocateWithoutConstructor<HotUpdaterImpl>()
            setField(impl, "bundleStorage", storage)
            val launched =
                LaunchSelection(
                    bundleUrl = "file:///bundle-store/downloaded-bundle/index.android.bundle",
                    launchedBundleId = "downloaded-bundle",
                    shouldRollbackOnCrash = false,
                )
            setField(impl, "runningLaunchSelection", launched)
            setCurrentLaunchSelection(impl, launched)

            assertTrue(impl.commitReleaseSelection(selection("BUNDLE", "downloaded-bundle")))
            assertEquals("downloaded-bundle", impl.getBundleId())

            storage.committed = false
            assertFalse(impl.commitReleaseSelection(selection("USE_BUILTIN", "built-in")))
            assertEquals("downloaded-bundle", impl.getBundleId())

            storage.committed = true
            assertTrue(impl.commitReleaseSelection(selection("USE_BUILTIN", "built-in")))

            // React Native's next read picks the built-in bundle; the running bundle stays until a reload.
            assertNull(impl.getBundleId())
            assertEquals("downloaded-bundle", impl.getRunningBundleId())
            assertEquals("downloaded-bundle", impl.getBundleIdForUpdateCheck())
        }

    @Test
    fun `a launch selection waits for a built-in commit and never picks a bundle it deletes`() {
        val storage = CommitGatedStorage(committed = true, holdCommit = true)
        val impl = allocateWithoutConstructor<HotUpdaterImpl>()
        setField(impl, "bundleStorage", storage)
        val commitResult = AtomicReference<Boolean>()
        val commit =
            thread {
                commitResult.set(runBlocking { impl.commitReleaseSelection(selection("USE_BUILTIN", "built-in")) })
            }
        assertTrue(storage.commitEntered.await(5, TimeUnit.SECONDS))

        val launchBundleId = AtomicReference<String?>("unset")
        val launchSelected = CountDownLatch(1)
        val launch =
            thread {
                launchBundleId.set(impl.getBundleIdForUpdateCheck())
                launchSelected.countDown()
            }

        // getBundleIdForUpdateCheck reads the next launch's bundle under the launch
        // lock getJSBundleFile selects under, and stands in for it here: the
        // launch's recovery hooks don't run on the JVM.
        assertFalse(launchSelected.await(300, TimeUnit.MILLISECONDS))

        storage.releaseCommit.countDown()
        commit.join(5_000)
        launch.join(5_000)
        assertEquals(true, commitResult.get())
        assertTrue(launchSelected.await(0, TimeUnit.SECONDS))
        // Selected after the commit, so it sees the built-in bundle, not the deleted download.
        assertNull(launchBundleId.get())
    }

    @Test
    fun `notifyAppReady reads the report without completing the current launch`() {
        val storage = FakeBundleStorageService(bundleId = null)
        val impl = allocateWithoutConstructor<HotUpdaterImpl>()
        setField(impl, "bundleStorage", storage)
        setCurrentLaunchSelection(
            impl,
            LaunchSelection(
                bundleUrl = "file:///bundle-store/launched-bundle/index.android.bundle",
                launchedBundleId = "launched-bundle",
                shouldRollbackOnCrash = false,
            ),
        )

        assertEquals(mapOf("status" to "UNCHANGED"), impl.notifyAppReady())
        assertNull(storage.lastCompletedBundleId)
    }

    @Test
    fun `install id and storage items come from their no backup stores`() {
        val identityFile = File(temporaryFolder.root, "hot-updater/install-identity.json")
        val storageFile = File(temporaryFolder.root, "hot-updater/storage.json")
        val impl = allocateWithoutConstructor<HotUpdaterImpl>()
        setField(impl, "installIdentity", InstallIdentityService(identityFile))
        setField(impl, "keyValueStorage", KeyValueStorageService(storageFile))

        val installId = impl.getInstallId()
        assertEquals(installId, InstallationIdentity.loadFromFile(identityFile)?.installId)

        impl.setStorageItem("plugins/insights/queue", "[]")
        assertEquals("[]", impl.getStorageItem("plugins/insights/queue"))
        assertEquals("[]", KeyValueStorageService(storageFile).getItem("plugins/insights/queue"))

        impl.setStorageItem("plugins/insights/queue", null)
        assertNull(impl.getStorageItem("plugins/insights/queue"))
    }

    /**
     * Storage whose launch picks a downloaded bundle until a built-in commit
     * deletes it, and whose commit can be held open to race a launch against it.
     */
    private class CommitGatedStorage(
        @Volatile var committed: Boolean,
        private val holdCommit: Boolean = false,
    ) : BundleStorageService by FakeBundleStorageService(bundleId = null) {
        val commitEntered = CountDownLatch(1)
        val releaseCommit = CountDownLatch(1)

        @Volatile
        private var downloadedBundleId: String? = "downloaded-bundle"

        override fun peekLaunchBundleId(): String? = downloadedBundleId

        override suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean {
            commitEntered.countDown()
            if (holdCommit) assertTrue(releaseCommit.await(5, TimeUnit.SECONDS))
            if (committed && selection.kind != "BUNDLE") downloadedBundleId = null
            return committed
        }
    }

    private fun selection(
        kind: String,
        bundleId: String,
    ) = PersistedSelection(
        kind = kind,
        releaseId = "release",
        bundleId = bundleId,
        catalogId = "catalog",
        scopeKey = "scope",
        generation = 1,
        catalogHash = "hash",
        channel = "production",
        selectionContextHash = "context",
    )

    private class MapPreferences : PreferencesService {
        private val values = mutableMapOf<String, String>()

        override fun getItem(key: String): String? = values[key]

        override fun setItem(
            key: String,
            value: String?,
        ) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private fun createImpl(
        storageBundleId: String?,
        storageManifest: Map<String, Any?> = emptyMap(),
        storageBaseURL: String = "",
        launchedBundleManifests: Map<String, Map<String, Any?>> = emptyMap(),
        launchedBundleBaseURLs: Map<String, String> = emptyMap(),
    ): HotUpdaterImpl =
        allocateWithoutConstructor<HotUpdaterImpl>().also { impl ->
            setField(
                impl,
                "bundleStorage",
                FakeBundleStorageService(
                    bundleId = storageBundleId,
                    manifest = storageManifest,
                    baseURL = storageBaseURL,
                    launchedBundleManifests = launchedBundleManifests,
                    launchedBundleBaseURLs = launchedBundleBaseURLs,
                ),
            )
        }

    private fun setCurrentLaunchSelection(
        impl: HotUpdaterImpl,
        selection: LaunchSelection,
    ) {
        setField(impl, "currentLaunchSelection", selection)
    }

    private fun setField(
        target: Any,
        fieldName: String,
        value: Any?,
    ) {
        val field = HotUpdaterImpl::class.java.getDeclaredField(fieldName)
        field.isAccessible = true
        field.set(target, value)
    }

    private inline fun <reified T> allocateWithoutConstructor(): T {
        val field = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe")
        field.isAccessible = true
        val unsafe = field.get(null)
        val allocateInstance = unsafe.javaClass.getMethod("allocateInstance", Class::class.java)

        @Suppress("UNCHECKED_CAST")
        val instance = allocateInstance.invoke(unsafe, T::class.java) as T
        // Field initializers don't run without the constructor.
        if (instance is HotUpdaterImpl) setField(instance, "launchPreparationLock", Any())
        return instance
    }
}
