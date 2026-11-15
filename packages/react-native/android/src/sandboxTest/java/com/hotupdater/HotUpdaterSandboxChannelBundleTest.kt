package com.hotupdater

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The preflight's question, "does this channel have a bundle for this build",
 * over a catalog whose bundles are older than the build's built-in one: a
 * shared sandbox build built after the channel's last deploy.
 */
class HotUpdaterSandboxChannelBundleTest {
    private val builtIn = "01a1de2a-a425-7000-8000-000000000000"
    private val older = "01a1de2a-12dc-72ba-8be7-31132da311e4"
    private val oldest = "01a1dd00-0000-7000-8000-000000000001"
    private val newer = "01a1df00-0000-7000-8000-000000000002"

    private fun release(
        releaseId: String,
        bundleId: String,
    ) = ReleaseCatalogDescriptor(
        releaseId = releaseId,
        kind = "BUNDLE",
        bundleId = bundleId,
        rolloutCohortCount = 1000,
        targetCohorts = emptyList(),
        shouldForceUpdate = false,
        message = null,
    )

    private fun catalog(vararg releases: ReleaseCatalogDescriptor) =
        ReleaseCatalog(
            schemaVersion = 1,
            catalogId = "catalog-1",
            scopeKey = "v1:fingerprint:android:cHItMQ:abc",
            generation = 1,
            catalogHash = "sha256:" + "a".repeat(64),
            fallbackPolicy = ReleaseCatalogs.FALLBACK_POLICY,
            releases = releases.toList(),
            rollbackReleases = releases.toList(),
        )

    private fun hasBundle(
        catalog: ReleaseCatalog,
        crashed: List<String> = emptyList(),
    ) = hotUpdaterSandboxChannelHasBundle(catalog, builtInBundleId = builtIn, cohort = "500", crashedBundleIds = crashed)

    @Test
    fun `a channel whose latest bundle is older than the built-in one has a bundle for this build`() {
        assertTrue(hasBundle(catalog(release("01a1de2a-48b2-74b9-8772-a199ef1e2133", older))))
    }

    @Test
    fun `a channel with a newer bundle has one, as before`() {
        assertTrue(hasBundle(catalog(release("01a1df00-0000-7000-8000-0000000000a1", newer))))
    }

    @Test
    fun `an empty channel has no bundle for this build`() {
        assertFalse(hasBundle(catalog()))
    }

    @Test
    fun `a channel whose only bundles crashed has no bundle for this build`() {
        val catalog =
            catalog(
                release("01a1de2a-48b2-74b9-8772-a199ef1e2133", older),
                release("01a1dd00-0000-7000-8000-0000000000a1", oldest),
            )
        assertFalse(hasBundle(catalog, crashed = listOf(older, oldest)))
        // The crashed newest is skipped for the one before it.
        assertTrue(hasBundle(catalog, crashed = listOf(older)))
    }

    @Test
    fun `a stale selection is told apart from a failed download, also wrapped`() {
        assertTrue(hotUpdaterSandboxIsStaleSelection(StaleReleaseCatalogException()))
        assertTrue(hotUpdaterSandboxIsStaleSelection(StaleReleaseSelectionException()))
        assertTrue(hotUpdaterSandboxIsStaleSelection(IllegalStateException("wrapped", StaleReleaseSelectionException())))
        assertFalse(hotUpdaterSandboxIsStaleSelection(java.io.IOException("offline")))
        assertFalse(hotUpdaterSandboxIsStaleSelection(IllegalStateException("Release transition rejected: UNSOLICITED_SCOPE")))
    }
}
