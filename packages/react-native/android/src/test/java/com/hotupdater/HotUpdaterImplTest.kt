package com.hotupdater

import android.content.ContextWrapper
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class HotUpdaterImplTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

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
