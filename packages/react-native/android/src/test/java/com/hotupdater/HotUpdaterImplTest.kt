package com.hotupdater

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HotUpdaterImplTest {
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
        return allocateInstance.invoke(unsafe, T::class.java) as T
    }

    private class FakeBundleStorageService(
        private val bundleId: String?,
        private val manifest: Map<String, Any?> = emptyMap(),
        private val baseURL: String = "",
        private val launchedBundleManifests: Map<String, Map<String, Any?>> =
            emptyMap(),
        private val launchedBundleBaseURLs: Map<String, String> = emptyMap(),
    ) : BundleStorageService {
        override fun setBundleURL(localPath: String?): Boolean = true

        override fun getCachedBundleURL(): String? = null

        override fun getFallbackBundleURL(): String = "assets://index.android.bundle"

        override fun prepareLaunch(pendingRecovery: PendingCrashRecovery?): LaunchSelection =
            LaunchSelection(
                bundleUrl = "assets://index.android.bundle",
                launchedBundleId = null,
                shouldRollbackOnCrash = false,
            )

        override suspend fun updateBundle(
            bundleId: String,
            fileUrl: String?,
            fileHash: String?,
            manifestUrl: String?,
            manifestFileHash: String?,
            changedAssets: Map<String, ChangedAssetDescriptor>?,
            progressCallback: (UpdateProgressPayload) -> Unit,
        ) = Unit

        override fun markLaunchCompleted(currentBundleId: String?) = Unit

        override fun notifyAppReady(): Map<String, Any?> = mapOf("status" to "STABLE")

        override fun getCrashHistory(): CrashedHistory = CrashedHistory()

        override fun clearCrashHistory(): Boolean = true

        override fun getBaseURL(): String = baseURL

        override fun getBaseURLForBundle(bundleId: String?): String =
            if (bundleId == null) {
                ""
            } else {
                launchedBundleBaseURLs[bundleId] ?: ""
            }

        override fun getBundleId(): String? = bundleId

        override fun getManifest(): Map<String, Any?> = manifest

        override fun getManifestForBundle(bundleId: String?): Map<String, Any?> =
            if (bundleId == null) {
                emptyMap()
            } else {
                launchedBundleManifests[bundleId] ?: emptyMap()
            }

        override suspend fun resetChannel(): Boolean = true
    }
}
