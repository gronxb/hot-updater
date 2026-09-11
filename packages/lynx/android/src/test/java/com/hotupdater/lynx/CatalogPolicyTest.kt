package com.hotupdater.lynx

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class CatalogPolicyTest {
    @Test fun nativeChannelRouteIsCanonicalUtf8WithoutJavascriptNormalization() {
        assertEquals("b3RhLXJlYWN0", CatalogPolicy.channelKey("ota-react"))
        assertEquals("Y2Fmw6k", CatalogPolicy.channelKey("café"))
        assertTrue(runCatching { CatalogPolicy.channelKey("cafe\u0301") }.isFailure)
        assertTrue(runCatching { CatalogPolicy.channelKey(" café ") }.isFailure)
    }

    private val vectors: List<JSONObject> by lazy {
        val fixture = generateSequence(File(checkNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { File(it, "packages/lynx/fixtures/catalog-policy.json") }.first { it.isFile }
        val cases = JSONArray(fixture.readText())
        (0 until cases.length()).map { cases.getJSONObject(it) }.filter { it.getString("name").startsWith("android/") }
    }

    private fun vector(name: String): JSONObject = clone(vectors.first { it.getString("name") == "android/$name" })
    private fun clone(value: JSONObject): JSONObject = JSONObject(value.toString())
    private fun strings(value: JSONArray): List<String> = (0 until value.length()).map { value.getString(it) }
    private fun snapshot(json: JSONObject): CatalogPolicy.NativeSnapshot = CatalogPolicy.NativeSnapshot(
        revision = json.getString("revision"), appVersion = json.getString("appVersion"),
        channel = json.getString("channel"), runtimeId = json.getString("runtimeId"),
        embeddedBundleId = json.getString("embeddedBundleId"), minimumBundleId = json.getString("minimumBundleId"),
        cohort = json.getString("cohort"), runningSelection = CatalogPolicy.parseReceipt(json.getJSONObject("runningSelection")),
        nextSelection = if (json.isNull("nextSelection")) null else CatalogPolicy.parseReceipt(json.getJSONObject("nextSelection")),
        crashedBundleIds = strings(json.getJSONArray("crashedBundleIds")),
        unconfirmedReleaseIds = strings(json.getJSONArray("unconfirmedReleaseIds")),
    )

    private fun accept(vector: JSONObject, highWater: CatalogPolicy.HighWater? = null): CatalogPolicy.AcceptedCatalog {
        val state = snapshot(vector.getJSONObject("snapshot"))
        return CatalogPolicy.accept(vector.getJSONObject("catalog").toString(), state, state.revision, CatalogPolicy.selectionContextHash(state), highWater)
    }

    private fun rejected(code: String? = null, action: () -> Unit) {
        try { action(); fail("Expected native policy rejection") } catch (error: CatalogPolicy.Rejected) {
            if (code != null) assertEquals(code, error.code)
        }
    }

    private fun storedBWithNewerC(): JSONObject {
        val input = vector("confirmed-current-retained")
        val b = clone(input.getJSONObject("catalog").getJSONArray("releases").getJSONObject(0))
        val c = vector("next-selection-is-policy-base").getJSONObject("catalog").getJSONArray("releases").getJSONObject(0)
        // Older B may only survive in rollbackReleases after catalog reduction.
        input.getJSONObject("catalog").put("releases", JSONArray().put(c))
            .put("rollbackReleases", JSONArray().put(c).put(b))
        return input
    }

    @Test fun matchesSharedCoreGeneratedSelectionAndAuthorizationVectors() {
        assertTrue("Missing generated Android parity cases", vectors.size >= 14)
        for (vector in vectors) {
            val name = vector.getString("name")
            val state = snapshot(vector.getJSONObject("snapshot"))
            val expected = vector.getJSONObject("expected")
            assertEquals(name, expected.getString("contextHash"), CatalogPolicy.selectionContextHash(state))
            if (!expected.isNull("authorization") && !expected.getJSONObject("authorization").getBoolean("authorized")) {
                rejected(expected.getJSONObject("authorization").getString("reason")) {
                    val accepted = accept(vector)
                    CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), expected.getJSONObject("selection").toString())
                }
                continue
            }
            val accepted = accept(vector)
            val desired = CatalogPolicy.desiredSelection(accepted, state)
            if (expected.isNull("selection")) {
                assertNull(name, desired)
                continue
            }
            assertNotNull(name, desired)
            val receiptJson = expected.getJSONObject("selection")
            assertEquals(name, CatalogPolicy.parseReceipt(receiptJson), desired!!.receipt)
            assertEquals(name, expected.getString("status"), desired.status)
            val authorization = expected.getJSONObject("authorization")
            if (authorization.getBoolean("authorized")) {
                val verified = CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), receiptJson.toString())
                assertEquals(name, authorization.getString("reason"), verified.authorizationReason)
            } else {
                rejected(authorization.getString("reason")) {
                    CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), receiptJson.toString())
                }
            }
        }
    }

    @Test fun numericRolloutMatchesAllThousandCoreCohorts() {
        // Generated by core getRolledOutNumericCohorts(releaseId(120), 137).
        val included = setOf(7,12,17,30,35,40,48,53,58,71,76,81,94,99,104,117,122,127,140,145,150,163,168,173,186,191,196,204,209,214,227,232,237,250,255,260,273,278,283,296,301,306,319,324,329,337,342,347,360,365,370,383,388,393,406,411,416,429,434,439,452,457,462,470,475,480,485,493,498,503,516,521,526,539,544,549,562,567,572,585,590,595,608,613,618,626,631,636,649,654,659,672,677,682,695,700,705,718,723,728,741,746,751,759,764,769,774,782,787,792,805,810,815,828,833,838,851,856,861,874,879,884,897,902,907,915,920,925,938,943,948,961,966,971,984,989,994)
        for (cohort in 1..1000) {
            val input = vector("first-update")
            input.getJSONObject("snapshot").put("cohort", cohort.toString())
            input.getJSONObject("catalog").getJSONArray("releases").getJSONObject(0).put("rolloutCohortCount", 137)
            val selected = CatalogPolicy.desiredSelection(accept(input), snapshot(input.getJSONObject("snapshot")))
            assertEquals("cohort $cohort", if (cohort in included) "BUNDLE" else "BUILTIN", selected!!.receipt.kind)
        }
    }

    @Test fun rejectsReceiptThatIsCatalogMemberButExcludedByNativePolicy() {
        val input = vector("two-unknown-exits-do-not-reenable-b")
        val accepted = accept(input)
        val state = snapshot(input.getJSONObject("snapshot"))
        val selected = input.getJSONObject("expected").getJSONObject("selection")
        val excluded = input.getJSONObject("catalog").getJSONArray("releases").getJSONObject(0)
        selected.put("releaseId", excluded.getString("releaseId")).put("bundleId", excluded.getString("bundleId"))
        rejected("INVALID_SELECTION") { CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), selected.toString()) }
    }

    @Test fun rejectsForgedGuardContextReceiptIdentityAndWrongNextBase() {
        val input = vector("next-selection-is-policy-base")
        val state = snapshot(input.getJSONObject("snapshot"))
        val accepted = accept(input)
        val correct = input.getJSONObject("expected").getJSONObject("selection")
        val forgedGuard = accepted.guard.toJson().put("selectionContextHash", "v1:0000000000000000")
        rejected("STALE_SELECTION") { CatalogPolicy.verifySelection(accepted, state, forgedGuard.toString(), correct.toString()) }
        for (key in listOf("bundleId", "releaseId", "catalogId", "channel", "selectionContextHash")) {
            val receipt = clone(correct).put(key, if (key.endsWith("Id") && key != "catalogId") "01900000-0000-7000-8000-000000000999" else "forged")
            rejected { CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), receipt.toString()) }
        }
        val running = input.getJSONObject("snapshot").getJSONObject("runningSelection")
        val stale = clone(correct).put("releaseId", running.getString("releaseId")).put("bundleId", running.getString("bundleId"))
        rejected("INVALID_SELECTION") { CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), stale.toString()) }
    }

    @Test fun exclusionOrRevisionChangesInvalidatePreparedAuthorization() {
        val input = vector("first-update")
        val accepted = accept(input)
        val receipt = input.getJSONObject("expected").getJSONObject("selection")
        val changed = clone(input.getJSONObject("snapshot"))
        changed.getJSONArray("unconfirmedReleaseIds").put(receipt.getString("releaseId"))
        rejected("STALE_SELECTION") { CatalogPolicy.verifySelection(accepted, snapshot(changed), accepted.guard.toJson().toString(), receipt.toString()) }
        val revision = clone(input.getJSONObject("snapshot")).put("revision", "native-new-revision")
        rejected("STALE_SELECTION") { CatalogPolicy.verifySelection(accepted, snapshot(revision), accepted.guard.toJson().toString(), receipt.toString()) }
        val state = snapshot(input.getJSONObject("snapshot"))
        rejected("INVALID_CONTEXT") { CatalogPolicy.accept(input.getJSONObject("catalog").toString(), state, state.revision, "v1:0000000000000000") }
    }

    @Test fun highWaterRejectsStaleOrConflictingCatalogsAndCannotSwitchScope() {
        val input = vector("first-update")
        val initial = accept(input)
        assertEquals(initial.highWater, accept(input, initial.highWater).highWater)
        val stale = vector("first-update")
        stale.getJSONObject("catalog").put("generation", 1)
        rejected("STALE_GENERATION") { accept(stale, initial.highWater) }
        val changed = vector("first-update")
        changed.getJSONObject("catalog").put("catalogHash", "sha256:${"b".repeat(64)}")
        rejected("GENERATION_HASH_MISMATCH") { accept(changed, initial.highWater) }
        changed.getJSONObject("catalog").put("generation", 3)
        assertEquals(3L, accept(changed, initial.highWater).highWater.generation)
        val scope = vector("first-update")
        scope.getJSONObject("catalog").put("scopeKey", "v1:app-version:ios:cHJvZHVjdGlvbg")
        rejected("INVALID_SCOPE") { accept(scope) }
        val project = vector("confirmed-current-retained")
        project.getJSONObject("catalog").put("catalogId", "another-project")
        rejected("UNSOLICITED_SCOPE") { accept(project) }
    }

    @Test fun transitionMustHaveNewerGenerationOrChangedNativeContext() {
        val input = vector("confirmed-current-retained")
        val original = snapshot(input.getJSONObject("snapshot"))
        val current = input.getJSONObject("snapshot").getJSONObject("runningSelection")
        current.put("generation", 2).put("selectionContextHash", CatalogPolicy.selectionContextHash(original))
        val state = snapshot(input.getJSONObject("snapshot"))
        val accepted = accept(input)
        val receipt = CatalogPolicy.desiredSelection(accepted, state)!!.receipt.toJson()
        rejected("BACKWARD_NOT_AUTHORIZED") { CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), receipt.toString()) }
        current.put("generation", 3)
        val newerState = snapshot(input.getJSONObject("snapshot"))
        val oldCatalog = accept(input)
        rejected("STALE_GENERATION") { CatalogPolicy.verifySelection(oldCatalog, newerState, oldCatalog.guard.toJson().toString(), receipt.toString()) }
    }

    @Test fun strictCatalogParsingRejectsCoercedNumbersIdsDuplicatesAndBounds() {
        for (number in listOf<Any>(true, false, "2", 0, -1, 2.5, 9007199254740992L)) {
            val input = vector("first-update")
            input.getJSONObject("catalog").put("generation", number)
            rejected("INVALID_CATALOG") { accept(input) }
        }
        for (schema in listOf<Any>(true, "1", 2)) {
            val input = vector("first-update")
            input.getJSONObject("catalog").put("schemaVersion", schema)
            rejected("INVALID_CATALOG") { accept(input) }
        }
        val duplicate = vector("first-update")
        val releases = duplicate.getJSONObject("catalog").getJSONArray("releases")
        releases.put(clone(releases.getJSONObject(0)))
        rejected("INVALID_CATALOG") { accept(duplicate) }
        for ((key, value) in listOf("releaseId" to "../release", "bundleId" to "not-a-uuid", "rolloutCohortCount" to true, "rolloutCohortCount" to 1001, "shouldForceUpdate" to 1)) {
            val input = vector("first-update")
            input.getJSONObject("catalog").getJSONArray("releases").getJSONObject(0).put(key, value)
            rejected("INVALID_CATALOG") { accept(input) }
        }
        val collision = vector("first-update")
        val other = clone(collision.getJSONObject("catalog").getJSONArray("releases").getJSONObject(0)).put("rolloutCohortCount", 0)
        collision.getJSONObject("catalog").put("rollbackReleases", JSONArray().put(other))
        rejected("INVALID_CATALOG") { accept(collision) }
        val oversized = vector("first-update")
        oversized.getJSONObject("catalog").put("padding", "x".repeat(530000))
        rejected("INVALID_CATALOG") { accept(oversized) }
    }

    @Test fun exclusionHashIsCanonicalAndKeepsEveryNativeEntry() {
        val input = vector("context-keeps-all-exclusions-canonically")
        val original = input.getJSONObject("snapshot")
        val hash = CatalogPolicy.selectionContextHash(snapshot(original))
        val ids = strings(original.getJSONArray("unconfirmedReleaseIds")).distinct().sorted()
        val canonical = clone(original).put("unconfirmedReleaseIds", JSONArray(ids))
        assertEquals(hash, CatalogPolicy.selectionContextHash(snapshot(canonical)))
        canonical.put("unconfirmedReleaseIds", JSONArray(ids.dropLast(1)))
        assertNotEquals(hash, CatalogPolicy.selectionContextHash(snapshot(canonical)))
        val mutable = ids.toMutableList()
        val state = snapshot(original)
        val isolated = CatalogPolicy.NativeSnapshot(state.revision, state.appVersion, state.channel, state.runtimeId, state.embeddedBundleId, state.minimumBundleId, state.cohort, state.runningSelection, state.nextSelection, state.crashedBundleIds, mutable)
        mutable.clear()
        assertEquals(hash, CatalogPolicy.selectionContextHash(isolated))
    }

    @Test fun acceptedProjectionCannotChangeUnderTheSameNativeAppVersionAndWatermark() {
        val input = vector("first-update")
        val state = snapshot(input.getJSONObject("snapshot"))
        val original = accept(input)
        val changed = clone(input.getJSONObject("catalog"))
        changed.getJSONArray("releases").getJSONObject(0).put("rolloutCohortCount", 0)
        rejected("CATALOG_BODY_MISMATCH") {
            CatalogPolicy.accept(changed.toString(), state, state.revision, CatalogPolicy.selectionContextHash(state), original.highWater, original)
        }
        val equivalent = clone(input.getJSONObject("catalog"))
        equivalent.put("rollbackReleases", equivalent.getJSONArray("releases"))
        CatalogPolicy.accept(equivalent.toString(), state, state.revision, CatalogPolicy.selectionContextHash(state), original.highWater, original)
        // The server legitimately projects another appVersion from the same compiled catalog.
        val otherVersion = snapshot(clone(input.getJSONObject("snapshot")).put("appVersion", "1.0.1"))
        CatalogPolicy.accept(changed.toString(), otherVersion, otherVersion.revision, CatalogPolicy.selectionContextHash(otherVersion), original.highWater, original)
    }

    @Test fun normalizesNativeCohortWithTheSameWhitespaceAsJavaScript() {
        val input = vector("custom-cohort-target")
        val original = snapshot(input.getJSONObject("snapshot"))
        val padded = snapshot(clone(input.getJSONObject("snapshot")).put("cohort", "\ufeff BETA\u00a0"))
        assertEquals(CatalogPolicy.selectionContextHash(original), CatalogPolicy.selectionContextHash(padded))
    }

    @Test fun storedBRemainsEligibleWhenNewerCIsDesiredButNotInstalled() {
        val input = storedBWithNewerC()
        val state = snapshot(input.getJSONObject("snapshot"))
        val accepted = accept(input)
        val b = state.runningSelection
        assertNotEquals(b.releaseId, CatalogPolicy.desiredSelection(accepted, state)!!.receipt.releaseId)
        assertTrue(CatalogPolicy.isStoredSelectionEligible(accepted, state, b, accepted.highWater))
        val restarted = clone(input.getJSONObject("snapshot")).put("revision", "next-process")
        restarted.put("nextSelection", b.toJson())
            .put("runningSelection", vector("first-update").getJSONObject("snapshot").getJSONObject("runningSelection"))
        restarted.getJSONArray("unconfirmedReleaseIds").put("01900000-0000-7000-8000-000000000999")
        // Neither an old staging context nor recovery revision invalidates an eligible stored B.
        assertTrue(CatalogPolicy.isStoredSelectionEligible(accepted, snapshot(restarted), b, accepted.highWater))
    }

    @Test fun storedBIsRejectedWhenRevokedExcludedCrashedBelowMinimumOrOutOfRollout() {
        for (reason in listOf("revoked", "excluded", "crashed", "minimum", "rollout", "identity")) {
            val input = storedBWithNewerC()
            val native = input.getJSONObject("snapshot")
            val b = CatalogPolicy.parseReceipt(native.getJSONObject("runningSelection"))
            val rollback = input.getJSONObject("catalog").getJSONArray("rollbackReleases")
            when (reason) {
                "revoked" -> input.getJSONObject("catalog").put("rollbackReleases", JSONArray().put(rollback.getJSONObject(0)))
                "excluded" -> native.put("unconfirmedReleaseIds", JSONArray((200..211).map { "01900000-0000-7000-8000-${it.toString().padStart(12, '0')}" }).put(b.releaseId))
                "crashed" -> native.put("crashedBundleIds", JSONArray().put(b.bundleId))
                "minimum" -> native.put("minimumBundleId", "01900000-0000-7000-8000-000000000025")
                "rollout" -> rollback.getJSONObject(1).put("rolloutCohortCount", 0)
                "identity" -> rollback.getJSONObject(1).put("bundleId", "01900000-0000-7000-8000-000000000021")
            }
            val accepted = accept(input)
            assertFalse(reason, CatalogPolicy.isStoredSelectionEligible(accepted, snapshot(native), b, accepted.highWater))
        }
    }

    @Test fun storedReceiptRequiresMatchingScopeProjectionAndNativeHighWater() {
        val input = storedBWithNewerC()
        val accepted = accept(input)
        val state = snapshot(input.getJSONObject("snapshot"))
        val b = state.runningSelection
        for (invalid in listOf(b.copy(catalogId = "another-project"),
            b.copy(channel = "beta", scopeKey = "v1:app-version:android:YmV0YQ"),
            b.copy(generation = accepted.guard.generation + 1),
            b.copy(generation = accepted.guard.generation, catalogHash = "sha256:${"b".repeat(64)}"))) {
            assertFalse(CatalogPolicy.isStoredSelectionEligible(accepted, state, invalid, accepted.highWater))
        }
        for (watermark in listOf(accepted.highWater.copy(generation = accepted.guard.generation + 1),
            accepted.highWater.copy(catalogHash = "sha256:${"b".repeat(64)}"),
            accepted.highWater.copy(catalogId = "another-project"))) {
            assertFalse(CatalogPolicy.isStoredSelectionEligible(accepted, state, b, watermark))
        }
        assertFalse(CatalogPolicy.isStoredSelectionEligible(accepted,
            snapshot(clone(input.getJSONObject("snapshot")).put("appVersion", "1.0.1")), b, accepted.highWater))
        for (base in listOf(b.copy(catalogId = "another-project"),
            b.copy(generation = accepted.guard.generation + 1),
            b.copy(generation = accepted.guard.generation, catalogHash = "sha256:${"b".repeat(64)}"))) {
            val inconsistent = snapshot(clone(input.getJSONObject("snapshot")).put("nextSelection", base.toJson()))
            assertFalse(CatalogPolicy.isStoredSelectionEligible(accepted, inconsistent, b, accepted.highWater))
        }
        // A receipt's older generation may legitimately have a different catalog hash.
        assertTrue(CatalogPolicy.isStoredSelectionEligible(accepted, state,
            b.copy(catalogHash = "sha256:${"b".repeat(64)}"), accepted.highWater))
    }

    @Test fun nativeRollbackProvenancePreservesAnAuthorizedOutOfRolloutPredecessor() {
        val input = vector("rollback-predecessor-does-not-require-rollout-cohort")
        val state = snapshot(input.getJSONObject("snapshot"))
        val accepted = accept(input)
        val desired = CatalogPolicy.desiredSelection(accepted, state)!!
        assertEquals("ROLLBACK", desired.status)
        val checked = CatalogPolicy.verifySelection(accepted, state, accepted.guard.toJson().toString(), desired.receipt.toJson().toString())
        val proof = checkNotNull(checked.rollbackAuthorization)
        val b = checked.receipt
        assertEquals(state.base, proof.fromSelection)
        assertFalse(CatalogPolicy.isStoredSelectionEligible(accepted, state, b, accepted.highWater))
        assertTrue(CatalogPolicy.isStoredSelectionEligible(accepted, state, b, accepted.highWater, proof))
        for (invalid in listOf(proof.copy(receipt = b.copy(generation = 1)), proof.copy(fromSelection = b),
            proof.copy(fromSelection = proof.fromSelection.copy(catalogId = "another-project")),
            proof.copy(fromSelection = proof.fromSelection.copy(generation = b.generation!! + 1)))) {
            assertFalse(CatalogPolicy.isStoredSelectionEligible(accepted, state, b, accepted.highWater, invalid))
        }
        val excluded = clone(input.getJSONObject("snapshot"))
        excluded.getJSONArray("unconfirmedReleaseIds").put(b.releaseId)
        assertFalse(CatalogPolicy.isStoredSelectionEligible(accepted, snapshot(excluded), b, accepted.highWater, proof))
        val revoked = clone(input)
        revoked.getJSONObject("catalog").put("rollbackReleases", JSONArray())
        val latest = accept(revoked)
        assertFalse(CatalogPolicy.isStoredSelectionEligible(latest, state, b, latest.highWater, proof))
    }

    @Test fun nilUuidIsOnlyAllowedForNativeEmbeddedAndMinimumIdentities() {
        val nil = "00000000-0000-0000-0000-000000000000"
        for (name in listOf("first-update", "empty-keeps-embedded", "explicit-embedded-rollback")) {
            val input = vector(name)
            val native = input.getJSONObject("snapshot").put("embeddedBundleId", nil).put("minimumBundleId", nil)
            if (native.getJSONObject("runningSelection").getString("kind") == "BUILTIN") {
                native.getJSONObject("runningSelection").put("bundleId", nil)
            }
            val state = snapshot(native)
            val accepted = accept(input)
            val selected = CatalogPolicy.desiredSelection(accepted, state)!!.receipt
            if (name == "first-update") assertNotEquals(nil, selected.bundleId) else assertEquals(nil, selected.bundleId)
            CatalogPolicy.parseReceipt(selected.toJson())
            if (name != "first-update") assertTrue(CatalogPolicy.isStoredSelectionEligible(accepted, state, selected, accepted.highWater))
        }
        val ota = vector("confirmed-current-retained").getJSONObject("snapshot").getJSONObject("runningSelection")
        rejected("INVALID_RECEIPT") { CatalogPolicy.parseReceipt(clone(ota).put("bundleId", nil)) }
        rejected("INVALID_RECEIPT") { CatalogPolicy.parseReceipt(clone(ota).put("releaseId", nil)) }
        val invalid = vector("first-update")
        invalid.getJSONObject("catalog").getJSONArray("releases").getJSONObject(0).put("bundleId", nil)
        rejected("INVALID_CATALOG") { accept(invalid) }
    }
}
