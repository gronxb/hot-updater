package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * Runs the Kotlin release selector against
 * packages/test-utils/fixtures/release-selection-conformance.json, which
 * @hot-updater/protocol generates, so the device selects as the server does.
 */
class ReleaseSelectionConformanceTest {
    private val fixture: JSONObject by lazy { JSONObject(locateFixture().readText()) }

    @Test
    fun `canonicalizes app versions as the protocol does`() {
        fixture.getJSONArray("appVersion").forEachCase { index, case ->
            val input = case.getString("input")
            assertEquals(
                "appVersion[$index] ${quote(input)}",
                case.nullableString("output"),
                ReleaseCatalogs.canonicalizeAppVersion(input),
            )
        }
    }

    @Test
    fun `encodes channel keys as the protocol does`() {
        fixture.getJSONArray("channelKey").forEachCase { index, case ->
            val channel = case.getString("channel")
            assertOutcome("channelKey[$index] ${quote(channel)}", case) {
                ReleaseCatalogs.encodeChannelKey(channel)
            }
        }
    }

    @Test
    fun `creates scope keys as the protocol does`() {
        fixture.getJSONObject("scopeKey").getJSONArray("create").forEachCase { index, case ->
            val scope = scopeOf(case.getJSONObject("input"))
            assertOutcome("scopeKey.create[$index] $scope", case) {
                ReleaseCatalogs.createScopeKey(scope)
            }
        }
    }

    @Test
    fun `parses scope keys as the protocol does`() {
        fixture.getJSONObject("scopeKey").getJSONArray("parse").forEachCase { index, case ->
            val scopeKey = case.getString("scopeKey")
            val label = "scopeKey.parse[$index] ${quote(scopeKey)}"
            if (case.has("error")) {
                assertThrows(label) { ReleaseCatalogs.parseScopeKey(scopeKey) }
            } else {
                assertEquals(label, scopeOf(case.getJSONObject("value")), ReleaseCatalogs.parseScopeKey(scopeKey))
            }
        }
    }

    @Test
    fun `normalizes cohorts as the protocol does`() {
        fixture.getJSONObject("cohort").getJSONArray("normalize").forEachCase { index, case ->
            val input = case.getString("input")
            assertEquals(
                "cohort.normalize[$index] ${quote(input)}",
                case.getString("output"),
                ReleaseSelector.normalizeCohortValue(input),
            )
        }
    }

    @Test
    fun `decides cohort eligibility as the protocol does`() {
        fixture.getJSONObject("cohort").getJSONArray("eligible").forEachCase { index, case ->
            val eligible =
                ReleaseSelector.isReleaseEligibleForCohort(
                    releaseId = case.getString("releaseId"),
                    rolloutCohortCount = case.getDouble("rolloutCohortCount"),
                    targetCohorts = case.getJSONArray("targetCohorts").strings(),
                    cohort = case.nullableString("cohort"),
                )
            assertEquals("cohort.eligible[$index] $case", case.getBoolean("eligible"), eligible)
        }
    }

    @Test
    fun `hashes selection contexts as the protocol does`() {
        fixture.getJSONArray("selectionContextHash").forEachCase { index, case ->
            val input = case.getJSONObject("input")
            val hash =
                ReleaseSelector.createSelectionContextHash(
                    ReleaseSelectionContextInput(
                        activeBundleId = input.nullableString("activeBundleId"),
                        activeReleaseId = input.nullableString("activeReleaseId"),
                        cohort = input.nullableString("cohort"),
                        minimumReleaseId = input.getString("minimumReleaseId"),
                        strategy = ReleaseStrategy.valueOf(input.getString("strategy")),
                        strategyValue = input.getString("strategyValue"),
                        crashedBundleIds = input.getJSONArray("crashedBundleIds").strings(),
                    ),
                )
            assertEquals("selectionContextHash[$index]", case.getString("hash"), hash)
        }
    }

    @Test
    fun `parses release catalogs as the protocol does`() {
        fixture.getJSONArray("parseReleaseCatalog").forEachCase { index, case ->
            val label = "parseReleaseCatalog[$index] ${case.getString("name")}"
            val parsed = ReleaseCatalogs.parse(case.getString("body"), scopeOf(case.getJSONObject("expectedScope")))
            if (case.isNull("catalog")) {
                assertNull(label, parsed)
            } else {
                assertEquals(label, catalogOf(case.getJSONObject("catalog")), parsed)
            }
        }
    }

    @Test
    fun `selects desired releases as the protocol does`() {
        fixture.getJSONArray("selectDesiredRelease").forEachCase { index, case ->
            val pool = case.getJSONArray("pool").objects().map(::descriptorOf)
            val catalog =
                ReleaseCatalog(
                    schemaVersion = 1,
                    catalogId = "catalog-1",
                    scopeKey = "v1:app-version:ios:cHJvZHVjdGlvbg",
                    generation = 1,
                    catalogHash = "sha256:" + "b".repeat(64),
                    fallbackPolicy = case.getString("fallbackPolicy"),
                    releases = case.getJSONArray("releases").ints().map { pool[it] },
                    rollbackReleases = case.getJSONArray("rollbackReleases").ints().map { pool[it] },
                )
            val input = case.getJSONObject("input")
            val desired =
                ReleaseSelector.selectDesiredRelease(
                    catalog,
                    ReleaseSelectionInput(
                        builtInBundleId = input.getString("builtInBundleId"),
                        currentBundleId = input.getString("currentBundleId"),
                        activeReleaseId = input.nullableString("activeReleaseId"),
                        runningReleaseId =
                            if (input.has("runningReleaseId")) {
                                RunningReleaseId.Explicit(input.nullableString("runningReleaseId"))
                            } else {
                                RunningReleaseId.SameAsActive
                            },
                        minimumReleaseId = input.getString("minimumReleaseId"),
                        cohort = input.nullableString("cohort"),
                        crashedBundleIds = input.getJSONArray("crashedBundleIds").strings(),
                    ),
                )
            val label = "selectDesiredRelease[$index] input=$input"
            if (case.isNull("desired")) {
                assertNull(label, desired)
            } else {
                val expected = case.getJSONObject("desired")
                assertNotNull(label, desired)
                assertEquals(
                    label,
                    listOf(
                        expected.getString("bundleId"),
                        expected.getString("kind"),
                        expected.nullableString("releaseId"),
                        expected.getBoolean("shouldForceUpdate"),
                        expected.getString("status"),
                    ),
                    listOf(
                        desired!!.bundleId,
                        desired.kind.name,
                        desired.releaseId,
                        desired.shouldForceUpdate,
                        desired.status.name,
                    ),
                )
            }
        }
    }

    @Test
    fun `authorizes release transitions as the protocol does`() {
        fixture.getJSONArray("authorizeReleaseTransition").forEachCase { index, case ->
            val reason =
                ReleaseSelector.authorizeReleaseTransition(
                    active = if (case.isNull("active")) null else receiptOf(case.getJSONObject("active")),
                    desired = receiptOf(case.getJSONObject("desired")),
                    explicitScopeSwitch = case.getBoolean("explicitScopeSwitch"),
                )
            val expected = case.getJSONObject("result")
            assertEquals(
                "authorizeReleaseTransition[$index]",
                expected.getBoolean("authorized") to expected.getString("reason"),
                reason.authorized to reason.name,
            )
        }
    }

    @Test
    fun `rejects a catalog body one byte over the wire limit`() {
        val limit = fixture.getInt("maxReleaseCatalogWireBytes")
        assertEquals(limit, ReleaseCatalogs.MAX_RELEASE_CATALOG_WIRE_BYTES)

        val case = fixture.getJSONArray("parseReleaseCatalog").getJSONObject(0)
        val body = case.getString("body")
        val scope = scopeOf(case.getJSONObject("expectedScope"))
        val marker = "\"message\":\"Fix\""
        assertTrue(body.contains(marker))
        val padding = limit - ReleaseCatalogs.utf8ByteLength(body)
        val atLimit = body.replace(marker, "\"message\":\"Fix" + "x".repeat(padding) + "\"")
        assertEquals(limit, ReleaseCatalogs.utf8ByteLength(atLimit))
        assertNotNull(ReleaseCatalogs.parse(atLimit, scope))

        val overLimit = body.replace(marker, "\"message\":\"Fix" + "x".repeat(padding + 1) + "\"")
        assertEquals(limit + 1, ReleaseCatalogs.utf8ByteLength(overLimit))
        assertNull(ReleaseCatalogs.parse(overLimit, scope))
    }

    @Test
    fun `counts UTF-8 bytes as the protocol does`() {
        assertEquals(0, ReleaseCatalogs.utf8ByteLength(""))
        assertEquals(1 + 2 + 3 + 4, ReleaseCatalogs.utf8ByteLength("aé한🚀"))
        // A lone surrogate counts as the 3 bytes of its replacement.
        assertEquals(3, ReleaseCatalogs.utf8ByteLength("\ud83d"))
        assertEquals(3, ReleaseCatalogs.utf8ByteLength("\ude80"))
    }

    @Test
    fun `rejects content after the catalog value`() {
        val case = fixture.getJSONArray("parseReleaseCatalog").getJSONObject(0)
        val scope = scopeOf(case.getJSONObject("expectedScope"))
        assertNotNull(ReleaseCatalogs.parse(case.getString("body") + " \n", scope))
        assertNull(ReleaseCatalogs.parse(case.getString("body") + "{}", scope))
    }

    @Test
    fun `rejects a deeply nested body`() {
        val scope = ReleaseCatalogScope.AppVersion(platform = "ios", channelKey = "cHJvZHVjdGlvbg")
        assertNull(ReleaseCatalogs.parse("{\"releases\":" + "[".repeat(200_000), scope))
    }

    private fun scopeOf(json: JSONObject): ReleaseCatalogScope =
        if (json.getString("strategy") == "FINGERPRINT") {
            ReleaseCatalogScope.Fingerprint(
                platform = json.getString("platform"),
                channelKey = json.getString("channelKey"),
                fingerprintHash = json.getString("fingerprintHash"),
            )
        } else {
            ReleaseCatalogScope.AppVersion(
                platform = json.getString("platform"),
                channelKey = json.getString("channelKey"),
            )
        }

    private fun descriptorOf(json: JSONObject): ReleaseCatalogDescriptor =
        ReleaseCatalogDescriptor(
            releaseId = json.getString("releaseId"),
            kind = json.getString("kind"),
            bundleId = json.nullableString("bundleId"),
            rolloutCohortCount = json.getInt("rolloutCohortCount"),
            targetCohorts = json.getJSONArray("targetCohorts").strings(),
            shouldForceUpdate = json.getBoolean("shouldForceUpdate"),
            message = json.nullableString("message"),
        )

    /** The catalog's schema fields: the protocol also returns fields the schema leaves out. */
    private fun catalogOf(json: JSONObject): ReleaseCatalog =
        ReleaseCatalog(
            schemaVersion = json.getInt("schemaVersion"),
            catalogId = json.getString("catalogId"),
            scopeKey = json.getString("scopeKey"),
            generation = json.getLong("generation"),
            catalogHash = json.getString("catalogHash"),
            fallbackPolicy = json.getString("fallbackPolicy"),
            releases = json.getJSONArray("releases").objects().map(::descriptorOf),
            rollbackReleases = json.getJSONArray("rollbackReleases").objects().map(::descriptorOf),
        )

    private fun receiptOf(json: JSONObject): PersistedSelection =
        PersistedSelection(
            kind = json.getString("kind"),
            releaseId = json.nullableString("releaseId"),
            bundleId = json.getString("bundleId"),
            catalogId = json.nullableString("catalogId"),
            scopeKey = json.nullableString("scopeKey"),
            generation = if (json.isNull("generation")) null else json.getLong("generation"),
            catalogHash = json.nullableString("catalogHash"),
            channel = json.getString("channel"),
            selectionContextHash = json.nullableString("selectionContextHash"),
        )

    private fun assertOutcome(
        label: String,
        case: JSONObject,
        run: () -> String,
    ) {
        if (case.has("error")) {
            assertThrows(label, run)
        } else {
            assertEquals(label, case.getString("value"), run())
        }
    }

    private fun assertThrows(
        label: String,
        run: () -> Any,
    ) {
        val result =
            try {
                run()
            } catch (_: IllegalArgumentException) {
                return
            }
        fail("$label: expected an error, got $result")
    }

    private fun quote(value: String): String = JSONObject.quote(value)

    private fun JSONObject.nullableString(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

    private fun JSONArray.ints(): List<Int> = (0 until length()).map { getInt(it) }

    private fun JSONArray.forEachCase(check: (Int, JSONObject) -> Unit) {
        assertTrue("the fixture section has cases", length() > 0)
        for (index in 0 until length()) {
            check(index, getJSONObject(index))
        }
    }

    private fun locateFixture(): File {
        val relative = "test-utils/fixtures/release-selection-conformance.json"
        var directory: File? = File("").absoluteFile.canonicalFile
        while (directory != null) {
            val candidates = listOf(File(directory, "packages/$relative"), File(directory, relative))
            candidates.firstOrNull { it.isFile }?.let { return it }
            directory = directory.parentFile
        }
        throw IllegalStateException("Cannot find packages/$relative above ${File("").absolutePath}")
    }
}
