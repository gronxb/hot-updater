package com.hotupdater

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The native instance's `getBundleId()` names the running release, as
 * JavaScript's `hotUpdater.getBundleId()` names the selected one: the release
 * ID, never the artifact a release ships. Each test uses its own instance name,
 * since the registry keeps one impl per name for the process.
 */
class HotUpdaterInstanceBundleIdTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

    private val buildFingerprintHash = HotUpdaterConfig.buildFingerprintHash

    // Not the fingerprint the test app's build embedded.
    @Before
    fun clearBuildFingerprint() {
        HotUpdaterConfig.buildFingerprintHash = null
    }

    @After
    @Suppress("DEPRECATION")
    fun clearConfig() {
        HotUpdaterConfig.clear()
        HotUpdaterConfig.buildFingerprintHash = buildFingerprintHash
    }

    @Test
    fun `the built-in bundle is MIN_BUNDLE_ID, and nothing before a launch`() {
        val instance = instance("bid-built-in")

        assertNull(instance.getBundleId())
        assertEquals("assets://bid-built-in.android.bundle", instance.getJSBundleFile())
        assertEquals(instance.getMinBundleId(), instance.getBundleId())
    }

    @Test
    fun `a deployed release is its release ID, not its artifact's`() {
        val name = "bid-release"
        install(name, receipt(releaseId = RELEASE_1))
        val instance = instance(name)

        instance.getJSBundleFile()

        assertEquals(RELEASE_1, instance.getBundleId())
    }

    @Test
    fun `a promoted release that reuses the running artifact is the new release at once`() =
        runBlocking {
            val name = "bid-adopt"
            install(name, receipt(releaseId = RELEASE_1))
            val instance = instance(name)
            instance.getJSBundleFile()
            val impl = HotUpdaterInstanceRegistry.shared.impl(context(), environment(name))

            // ADOPT_RELEASE: a metadata-only commit of the artifact that runs.
            assertTrue(impl.acceptReleaseCatalog("project-a", "scope-production", 2, "hash-2", "production", "context-2"))
            assertTrue(impl.commitReleaseSelection(receipt(releaseId = RELEASE_2, generation = 2)))

            assertEquals(RELEASE_2, instance.getBundleId())
            assertEquals(ARTIFACT, impl.getRunningBundleId())
        }

    @Test
    fun `a receipt without a release ID is the artifact, as in JavaScript`() {
        val name = "bid-no-release"
        install(name, receipt(releaseId = null))
        val instance = instance(name)

        instance.getJSBundleFile()

        assertEquals(ARTIFACT, instance.getBundleId())
    }

    private fun context(): InstanceTestContext = InstanceTestContext(temporaryFolder.root)

    private fun options(name: String) = HotUpdaterOptions(BASE_URL, name = name, bundleAssetName = "$name.android.bundle")

    private fun environment(name: String) = HotUpdaterInstanceEnvironment.of(options(name))

    private fun instance(name: String): HotUpdaterInstance = HotUpdater.init(context(), options(name))

    /** Stores [ARTIFACT] as the stable bundle with [selection] as its receipt. */
    private fun install(
        name: String,
        selection: PersistedSelection,
    ) {
        val context = context()
        val environment = environment(name)
        val root = environment.filesRoot(context)!!
        val bundleDir = File(root, "bundle-store/$ARTIFACT").apply { mkdirs() }
        File(bundleDir, "index.android.bundle").writeText("bundle")
        File(bundleDir, "manifest.json").writeText(
            JSONObject()
                .put("bundleId", ARTIFACT)
                .put("assets", JSONObject().put("index.android.bundle", JSONObject().put("fileHash", "hash")))
                .toString(),
        )
        assertTrue(
            BundleMetadata(
                isolationKey = environment.isolationKey(context),
                stableBundleId = ARTIFACT,
                stableSelection = selection,
            ).saveToFile(File(root, "bundle-store/${BundleMetadata.METADATA_FILENAME}")),
        )
    }

    private fun receipt(
        releaseId: String?,
        generation: Long = 1,
    ) = PersistedSelection(
        kind = "BUNDLE",
        releaseId = releaseId,
        bundleId = ARTIFACT,
        catalogId = "project-a",
        scopeKey = "scope-production",
        generation = generation,
        catalogHash = "hash-$generation",
        channel = "production",
        selectionContextHash = "context-$generation",
    )

    private companion object {
        const val BASE_URL = "https://updates.example.com"
        const val ARTIFACT = "0190a1b2-0000-7000-8000-00000000000a"
        const val RELEASE_1 = "0190a1b2-0000-7000-8000-000000000001"
        const val RELEASE_2 = "0190a1b2-0000-7000-8000-000000000002"
    }
}
