import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class CatalogPolicyTests: XCTestCase {
    private func vectors() throws -> [[String: Any]] {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let value = try JSONSerialization.jsonObject(with: Data(contentsOf: package.appendingPathComponent("fixtures/catalog-policy.json"))) as! [[String: Any]]
        return value.filter { ($0["name"] as! String).hasPrefix("ios/") }
    }

    private func snapshot(_ object: [String: Any]) throws -> LynxPolicySnapshot {
        LynxPolicySnapshot(revision: object["revision"] as! String, platform: object["platform"] as! String,
            appVersion: object["appVersion"] as! String, channel: object["channel"] as! String,
            embeddedBundleId: object["embeddedBundleId"] as! String, minimumBundleId: object["minimumBundleId"] as! String,
            cohort: object["cohort"] as! String, runningSelection: try LynxCatalogPolicy.parseReceipt(object["runningSelection"] as! [String: Any]),
            nextSelection: try (object["nextSelection"] as? [String: Any]).map(LynxCatalogPolicy.parseReceipt),
            crashedBundleIds: object["crashedBundleIds"] as! [String], unconfirmedReleaseIds: object["unconfirmedReleaseIds"] as? [String] ?? [])
    }

    private func parse(_ object: [String: Any], _ state: LynxPolicySnapshot) throws -> LynxPolicyCatalog {
        try LynxCatalogPolicy.parseCatalog(json: JSONSerialization.data(withJSONObject: object, options: .sortedKeys), snapshot: state)
    }

    private func assertCode(_ code: String, file: StaticString = #filePath, line: UInt = #line, _ action: () throws -> Void) {
        XCTAssertThrowsError(try action(), file: file, line: line) { error in
            XCTAssertEqual((error as? LynxPolicyError)?.code, code, "\(error)", file: file, line: line)
        }
    }

    func testCoreGeneratedSelectionContextAndAuthorizationParity() throws {
        let fixtures = try vectors()
        XCTAssertGreaterThanOrEqual(fixtures.count, 24)
        for fixture in fixtures {
            let name = fixture["name"] as! String
            let state = try snapshot(fixture["snapshot"] as! [String: Any])
            let catalog = try parse(fixture["catalog"] as! [String: Any], state)
            let expected = fixture["expected"] as! [String: Any]
            let context = expected["contextHash"] as! String
            XCTAssertEqual(LynxCatalogPolicy.contextHash(snapshot: state), context, name)
            let accepted = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: state.revision,
                claimedContextHash: context, highestSeen: nil)
            let desired = LynxCatalogPolicy.desired(catalog: catalog, snapshot: state)
            guard let expectedReceipt = expected["selection"] as? [String: Any] else {
                XCTAssertNil(desired, name)
                continue
            }
            let receipt = try LynxCatalogPolicy.parseReceipt(expectedReceipt)
            XCTAssertEqual(desired?.receipt, receipt, name)
            XCTAssertEqual(desired?.status, expected["status"] as? String, name)
            let authorization = expected["authorization"] as! [String: Any]
            if authorization["authorized"] as! Bool {
                let result = try LynxCatalogPolicy.authorize(catalog: catalog, snapshot: state,
                    selectionGuard: accepted.selectionGuard, requestedReceipt: receipt)
                XCTAssertEqual(result.reason, authorization["reason"] as? String, name)
                XCTAssertEqual(result.rollback != nil, receipt.kind == "BUNDLE" && desired?.status == "ROLLBACK", name)
            } else {
                assertCode(authorization["reason"] as! String) {
                    _ = try LynxCatalogPolicy.authorize(catalog: catalog, snapshot: state,
                        selectionGuard: accepted.selectionGuard, requestedReceipt: receipt)
                }
            }
        }
    }

    func testForgedReceiptCannotChooseAnotherCatalogMemberOrChangeAuthority() throws {
        let fixture = try vectors().first { ($0["name"] as! String).contains("fresh-release-retries-unknown") }!
        let state = try snapshot(fixture["snapshot"] as! [String: Any])
        let catalog = try parse(fixture["catalog"] as! [String: Any], state)
        let accepted = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: state.revision,
            claimedContextHash: LynxCatalogPolicy.contextHash(snapshot: state), highestSeen: nil)
        let desired = try XCTUnwrap(LynxCatalogPolicy.desired(catalog: catalog, snapshot: state))
        var otherMember = desired.receipt.dictionary
        otherMember["releaseId"] = catalog.releases[1].releaseId
        otherMember["bundleId"] = catalog.releases[1].bundleId
        let alterations: [[String: Any]] = [otherMember] + [
            ("bundleId", state.embeddedBundleId as Any), ("catalogId", "forged"),
            ("scopeKey", "v1:app-version:android:cHJvZHVjdGlvbg"), ("generation", 999),
            ("catalogHash", "sha256:" + String(repeating: "b", count: 64)), ("channel", "beta"),
            ("selectionContextHash", "v1:0000000000000000")
        ].map { key, value in var changed = desired.receipt.dictionary; changed[key] = value; return changed }
        for changed in alterations {
            let receipt = try LynxCatalogPolicy.parseReceipt(changed)
            assertCode("INVALID_RECEIPT") {
                _ = try LynxCatalogPolicy.authorize(catalog: catalog, snapshot: state,
                    selectionGuard: accepted.selectionGuard, requestedReceipt: receipt)
            }
        }
    }

    func testFreshNativeStateAndHighWaterAreRequired() throws {
        let fixture = try vectors()[0]
        var stateJSON = fixture["snapshot"] as! [String: Any]
        let state = try snapshot(stateJSON)
        let catalog = try parse(fixture["catalog"] as! [String: Any], state)
        let hash = LynxCatalogPolicy.contextHash(snapshot: state)
        assertCode("STALE_STATE") { _ = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: "old", claimedContextHash: hash, highestSeen: nil) }
        assertCode("CONTEXT_MISMATCH") { _ = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: state.revision, claimedContextHash: "forged", highestSeen: nil) }
        assertCode("STALE_GENERATION") {
            _ = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: state.revision,
                claimedContextHash: hash, highestSeen: LynxPolicyHighWater(generation: catalog.generation + 1, catalogHash: catalog.catalogHash))
        }
        assertCode("GENERATION_HASH_MISMATCH") {
            _ = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: state.revision,
                claimedContextHash: hash, highestSeen: LynxPolicyHighWater(generation: catalog.generation, catalogHash: "other"))
        }
        let accepted = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: state.revision,
            claimedContextHash: hash, highestSeen: LynxPolicyHighWater(generation: catalog.generation, catalogHash: catalog.catalogHash))
        XCTAssertFalse(accepted.shouldAdvanceHighWater)
        XCTAssertEqual(try LynxCatalogPolicy.parseGuard(accepted.selectionGuard.dictionary), accepted.selectionGuard)
        var boolGuard = accepted.selectionGuard.dictionary
        boolGuard["generation"] = true
        assertCode("INVALID_GUARD") { _ = try LynxCatalogPolicy.parseGuard(boolGuard) }
        let desired = try XCTUnwrap(LynxCatalogPolicy.desired(catalog: catalog, snapshot: state))
        stateJSON["unconfirmedReleaseIds"] = [desired.receipt.releaseId!]
        let excluded = try snapshot(stateJSON)
        assertCode("STALE_SELECTION") {
            _ = try LynxCatalogPolicy.authorize(catalog: catalog, snapshot: excluded,
                selectionGuard: accepted.selectionGuard, requestedReceipt: desired.receipt)
        }
    }

    func testAcceptedProjectionCannotChangeUnderSameGenerationAndHash() throws {
        let fixture = try vectors()[0]
        let state = try snapshot(fixture["snapshot"] as! [String: Any])
        var data = fixture["catalog"] as! [String: Any]
        let original = try parse(data, state)
        data["releases"] = []
        let changed = try parse(data, state)
        assertCode("CATALOG_BODY_MISMATCH") {
            _ = try LynxCatalogPolicy.accept(catalog: changed, snapshot: state, expectedRevision: state.revision,
                claimedContextHash: LynxCatalogPolicy.contextHash(snapshot: state),
                highestSeen: LynxPolicyHighWater(generation: original.generation, catalogHash: original.catalogHash),
                previouslyAcceptedCatalog: original)
        }
    }

    func testRejectsMalformedCatalogNumbersScopeDuplicatesAndBounds() throws {
        let fixture = try vectors()[0]
        let state = try snapshot(fixture["snapshot"] as! [String: Any])
        let base = fixture["catalog"] as! [String: Any]
        let release = (base["releases"] as! [[String: Any]])[0]
        var invalid: [[String: Any]] = []
        for (key, value): (String, Any) in [("schemaVersion", true), ("schemaVersion", 2), ("generation", true),
            ("generation", 0), ("generation", -1), ("generation", 1.5), ("generation", UInt64(9_007_199_254_740_992)),
            ("scopeKey", "v1:app-version:android:cHJvZHVjdGlvbg"), ("scopeKey", "v1:app-version:ios:cHJvZHVjdGlvbg=="),
            ("scopeKey", "v1:fingerprint:ios:cHJvZHVjdGlvbg:hash"), ("rollbackReleases", NSNull())] {
            var valueJSON = base; valueJSON[key] = value; invalid.append(valueJSON)
        }
        for (key, value): (String, Any) in [("rolloutCohortCount", true), ("rolloutCohortCount", 1001),
            ("shouldForceUpdate", 1), ("bundleId", NSNull()), ("targetCohorts", ["1", "01"]),
            ("targetCohorts", Array(repeating: "qa", count: 101))] {
            var item = release; item[key] = value; var valueJSON = base; valueJSON["releases"] = [item]; invalid.append(valueJSON)
        }
        var duplicate = base; duplicate["releases"] = [release, release]; invalid.append(duplicate)
        var conflictItem = release; conflictItem["rolloutCohortCount"] = 0
        var conflict = base; conflict["rollbackReleases"] = [conflictItem]; invalid.append(conflict)
        var manyCohorts = base
        manyCohorts["releases"] = (1...6).reversed().map { index -> [String: Any] in
            var item = release
            item["releaseId"] = String(format: "01900000-0000-7000-8000-%012d", index)
            item["targetCohorts"] = (0..<100).map { "group-\(index)-\($0)" }
            return item
        }
        invalid.append(manyCohorts)
        for value in invalid { assertCode("INVALID_CATALOG") { _ = try parse(value, state) } }
        let ordinary = String(data: try JSONSerialization.data(withJSONObject: base), encoding: .utf8)!
        let duplicateKey = "{\"schemaVersion\":2," + ordinary.dropFirst()
        assertCode("INVALID_CATALOG") { _ = try LynxCatalogPolicy.parseCatalog(json: Data(duplicateKey.utf8), snapshot: state) }
        assertCode("INVALID_CATALOG") { _ = try LynxCatalogPolicy.parseCatalog(json: Data(repeating: 32, count: LynxCatalogPolicy.maxCatalogBytes + 1), snapshot: state) }
    }

    func testAbsentAndEmptyExclusionsPreserveLegacyContext() throws {
        var data = try vectors()[0]["snapshot"] as! [String: Any]
        let present = LynxCatalogPolicy.contextHash(snapshot: try snapshot(data))
        data.removeValue(forKey: "unconfirmedReleaseIds")
        XCTAssertEqual(LynxCatalogPolicy.contextHash(snapshot: try snapshot(data)), present)
        data["cohort"] = "\u{feff}0001\u{feff}"
        XCTAssertEqual(LynxCatalogPolicy.contextHash(snapshot: try snapshot(data)), present)
    }

    func testStoredReleaseStaysOnBWhenNewerCIsUnstagedButRejectsRevocation() throws {
        let fixture = try vectors().first { ($0["name"] as! String).contains("same-generation-same-context-denied") }!
        let stateJSON = fixture["snapshot"] as! [String: Any]
        let state = try snapshot(stateJSON)
        let data = fixture["catalog"] as! [String: Any]
        let catalog = try parse(data, state)
        let stored = state.runningSelection
        let highWater = LynxPolicyHighWater(generation: catalog.generation, catalogHash: catalog.catalogHash)
        XCTAssertNotEqual(LynxCatalogPolicy.desired(catalog: catalog, snapshot: state)?.receipt.releaseId, stored.releaseId)
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: catalog, snapshot: state, highestSeen: highWater))
        let releases = data["releases"] as! [[String: Any]]
        var revoked = data; revoked["releases"] = [releases[0]]
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: parse(revoked, state), snapshot: state, highestSeen: highWater))
        var rollbackOnly = data; rollbackOnly["releases"] = []; rollbackOnly["rollbackReleases"] = releases
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: parse(rollbackOnly, state), snapshot: state, highestSeen: highWater))
        var ineligible = data; var changedReleases = releases; changedReleases[1]["rolloutCohortCount"] = 0; ineligible["releases"] = changedReleases
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: parse(ineligible, state), snapshot: state, highestSeen: highWater))
        for (key, value): (String, Any) in [("unconfirmedReleaseIds", [stored.releaseId!]),
            ("crashedBundleIds", [stored.bundleId]), ("minimumBundleId", releases[0]["bundleId"]!)] {
            var changed = stateJSON; changed[key] = value
            XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: catalog, snapshot: snapshot(changed), highestSeen: highWater), key)
        }
        var forged = stored.dictionary; forged["bundleId"] = releases[0]["bundleId"]
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: LynxCatalogPolicy.parseReceipt(forged), catalog: catalog, snapshot: state, highestSeen: highWater))
    }

    func testStoredReceiptRequiresRetainedScopeAndExactLatestHighWater() throws {
        let fixture = try vectors().first { ($0["name"] as! String).contains("same-generation-same-context-denied") }!
        let state = try snapshot(fixture["snapshot"] as! [String: Any])
        let catalog = try parse(fixture["catalog"] as! [String: Any], state)
        let stored = state.runningSelection
        let highWater = LynxPolicyHighWater(generation: catalog.generation, catalogHash: catalog.catalogHash)
        for highest in [nil, LynxPolicyHighWater(generation: catalog.generation - 1, catalogHash: catalog.catalogHash)] {
            XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: catalog, snapshot: state, highestSeen: highest))
        }
        assertCode("STALE_GENERATION") {
            _ = try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: catalog, snapshot: state,
                highestSeen: LynxPolicyHighWater(generation: catalog.generation + 1, catalogHash: catalog.catalogHash))
        }
        let otherHash = "sha256:" + String(repeating: "b", count: 64)
        assertCode("GENERATION_HASH_MISMATCH") {
            _ = try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: catalog, snapshot: state,
                highestSeen: LynxPolicyHighWater(generation: catalog.generation, catalogHash: otherHash))
        }
        for (key, value): (String, Any) in [("catalogId", "other"), ("scopeKey", "v1:app-version:android:cHJvZHVjdGlvbg"),
            ("channel", "beta"), ("generation", catalog.generation + 1), ("catalogHash", otherHash), ("selectionContextHash", NSNull())] {
            var changed = stored.dictionary; changed[key] = value
            XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: LynxCatalogPolicy.parseReceipt(changed), catalog: catalog, snapshot: state, highestSeen: highWater), key)
        }
        var older = stored.dictionary; older["generation"] = catalog.generation - 1; older["catalogHash"] = otherHash
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: LynxCatalogPolicy.parseReceipt(older), catalog: catalog, snapshot: state, highestSeen: highWater))
        var futureBase = stored.dictionary; futureBase["generation"] = catalog.generation + 1
        var inconsistent = fixture["snapshot"] as! [String: Any]; inconsistent["nextSelection"] = futureBase
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: catalog, snapshot: snapshot(inconsistent), highestSeen: highWater))
        var otherVersion = fixture["snapshot"] as! [String: Any]; otherVersion["appVersion"] = "2.0.0"
        assertCode("INVALID_CATALOG") {
            _ = try LynxCatalogPolicy.isEligibleStored(receipt: stored, catalog: catalog, snapshot: snapshot(otherVersion), highestSeen: highWater)
        }
    }

    func testNativeRollbackProvenanceRetainsIneligiblePredecessorWithoutBypassingRevocation() throws {
        let fixture = try vectors().first { ($0["name"] as! String).contains("rollback-predecessor-does-not-require-rollout-cohort") }!
        let state = try snapshot(fixture["snapshot"] as! [String: Any])
        let data = fixture["catalog"] as! [String: Any]
        let catalog = try parse(data, state)
        let expected = fixture["expected"] as! [String: Any]
        let receipt = try LynxCatalogPolicy.parseReceipt(expected["selection"] as! [String: Any])
        let accepted = try LynxCatalogPolicy.accept(catalog: catalog, snapshot: state, expectedRevision: state.revision,
            claimedContextHash: expected["contextHash"] as! String, highestSeen: nil)
        let authorization = try LynxCatalogPolicy.authorize(catalog: catalog, snapshot: state,
            selectionGuard: accepted.selectionGuard, requestedReceipt: receipt)
        let proof = try XCTUnwrap(authorization.rollback)
        XCTAssertEqual(proof.receipt, receipt); XCTAssertEqual(proof.fromSelection, state.policyBase)
        let highWater = LynxPolicyHighWater(generation: catalog.generation, catalogHash: catalog.catalogHash)
        var startup = fixture["snapshot"] as! [String: Any]; startup["runningSelection"] = receipt.dictionary
        let startupState = try snapshot(startup)
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: catalog, snapshot: startupState, highestSeen: highWater))
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: catalog, snapshot: startupState,
            highestSeen: highWater, rollbackAuthorization: proof))
        var newerData = data
        var rollback = data["rollbackReleases"] as! [[String: Any]]; rollback[0]["rolloutCohortCount"] = 1000
        newerData["releases"] = [rollback[0]]; newerData["rollbackReleases"] = rollback
        newerData["generation"] = 3; newerData["catalogHash"] = "sha256:" + String(repeating: "b", count: 64)
        let newer = try parse(newerData, startupState)
        let newerHighWater = LynxPolicyHighWater(generation: newer.generation, catalogHash: newer.catalogHash)
        XCTAssertNotEqual(LynxCatalogPolicy.desired(catalog: newer, snapshot: startupState)?.receipt.releaseId, receipt.releaseId)
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: newer, snapshot: startupState,
            highestSeen: newerHighWater, rollbackAuthorization: proof))
        newerData["rollbackReleases"] = [rollback[0]]
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: parse(newerData, startupState), snapshot: startupState,
            highestSeen: newerHighWater, rollbackAuthorization: proof))
        for (key, value): (String, Any) in [("unconfirmedReleaseIds", [receipt.releaseId!]), ("crashedBundleIds", [receipt.bundleId]),
            ("minimumBundleId", state.runningSelection.bundleId)] {
            var changed = startup; changed[key] = value
            XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: catalog, snapshot: snapshot(changed),
                highestSeen: highWater, rollbackAuthorization: proof), key)
        }
        var otherScope = proof.fromSelection.dictionary; otherScope["scopeKey"] = "v1:app-version:android:cHJvZHVjdGlvbg"
        var futureSource = proof.fromSelection.dictionary; futureSource["generation"] = receipt.generation! + 1
        for from in [receipt, try LynxCatalogPolicy.parseReceipt(otherScope), try LynxCatalogPolicy.parseReceipt(futureSource)] {
            XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: receipt, catalog: catalog, snapshot: startupState,
                highestSeen: highWater, rollbackAuthorization: .init(receipt: receipt, fromSelection: from)))
        }
        var changedTarget = receipt.dictionary; changedTarget["selectionContextHash"] = "v1:0000000000000000"
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: LynxCatalogPolicy.parseReceipt(changedTarget), catalog: catalog,
            snapshot: startupState, highestSeen: highWater, rollbackAuthorization: proof))
    }

    func testNilIdentityIsNativeEmbeddedOnlyAndExplicitEmbeddedCanBeExcluded() throws {
        let nilID = "00000000-0000-0000-0000-000000000000"
        let fixture = try vectors().first { ($0["name"] as! String).contains("explicit-embedded-rollback") }!
        var stateJSON = fixture["snapshot"] as! [String: Any]
        stateJSON["embeddedBundleId"] = nilID; stateJSON["minimumBundleId"] = nilID
        let state = try snapshot(stateJSON)
        let catalog = try parse(fixture["catalog"] as! [String: Any], state)
        let highWater = LynxPolicyHighWater(generation: catalog.generation, catalogHash: catalog.catalogHash)
        let embedded = try XCTUnwrap(LynxCatalogPolicy.desired(catalog: catalog, snapshot: state)?.receipt)
        XCTAssertEqual(embedded.kind, "EMBEDDED"); XCTAssertEqual(embedded.bundleId, nilID)
        XCTAssertEqual(try LynxCatalogPolicy.parseReceipt(embedded.dictionary), embedded)
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: embedded, catalog: catalog, snapshot: state, highestSeen: highWater))
        stateJSON["unconfirmedReleaseIds"] = [embedded.releaseId!]
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: embedded, catalog: catalog, snapshot: snapshot(stateJSON), highestSeen: highWater))
        var notAnOTABundle = embedded.dictionary; notAnOTABundle["kind"] = "BUNDLE"
        assertCode("INVALID_RECEIPT") { _ = try LynxCatalogPolicy.parseReceipt(notAnOTABundle) }
        let builtin = LynxPolicyReceipt(kind: "BUILTIN", releaseId: nil, bundleId: nilID, catalogId: nil, scopeKey: nil,
            generation: nil, catalogHash: nil, channel: state.channel, selectionContextHash: nil)
        XCTAssertEqual(try LynxCatalogPolicy.parseReceipt(builtin.dictionary), builtin)
        var omittedReleaseId = builtin.dictionary
        omittedReleaseId.removeValue(forKey: "releaseId")
        XCTAssertEqual(try LynxCatalogPolicy.parseReceipt(omittedReleaseId), builtin)
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: builtin, catalog: catalog, snapshot: snapshot(stateJSON), highestSeen: nil))
        var authorizedBuiltin = embedded.dictionary; authorizedBuiltin["kind"] = "BUILTIN"; authorizedBuiltin["releaseId"] = NSNull()
        let builtinReceipt = try LynxCatalogPolicy.parseReceipt(authorizedBuiltin)
        XCTAssertTrue(try LynxCatalogPolicy.isEligibleStored(receipt: builtinReceipt, catalog: catalog, snapshot: state, highestSeen: highWater))
        XCTAssertFalse(try LynxCatalogPolicy.isEligibleStored(receipt: builtinReceipt, catalog: catalog, snapshot: state, highestSeen: nil))
        var invalidCatalog = fixture["catalog"] as! [String: Any]
        var invalidDescriptor = (invalidCatalog["releases"] as! [[String: Any]])[0]
        invalidDescriptor["kind"] = "BUNDLE"; invalidDescriptor["bundleId"] = nilID; invalidCatalog["releases"] = [invalidDescriptor]
        assertCode("INVALID_CATALOG") { _ = try parse(invalidCatalog, state) }
        for key in ["minimumBundleId", "embeddedBundleId"] {
            var invalid = stateJSON; invalid[key] = "invalid"
            assertCode("INVALID_STATE") { _ = try parse(fixture["catalog"] as! [String: Any], snapshot(invalid)) }
        }
    }

    func testEveryNumericCohortMatchesCorePartialRollout() throws {
        // Generated by @hot-updater/core getRolledOutNumericCohorts(
        // "01900000-0000-7000-8000-000000000120", 137), also used by Android.
        let included: Set<Int> = [7,12,17,30,35,40,48,53,58,71,76,81,94,99,104,117,122,127,140,145,150,163,168,173,186,191,196,204,209,214,227,232,237,250,255,260,273,278,283,296,301,306,319,324,329,337,342,347,360,365,370,383,388,393,406,411,416,429,434,439,452,457,462,470,475,480,485,493,498,503,516,521,526,539,544,549,562,567,572,585,590,595,608,613,618,626,631,636,649,654,659,672,677,682,695,700,705,718,723,728,741,746,751,759,764,769,774,782,787,792,805,810,815,828,833,838,851,856,861,874,879,884,897,902,907,915,920,925,938,943,948,961,966,971,984,989,994]
        XCTAssertEqual(included.count, 137)
        let fixture = try vectors()[0]
        var stateJSON = fixture["snapshot"] as! [String: Any]
        var catalogJSON = fixture["catalog"] as! [String: Any]
        var releases = catalogJSON["releases"] as! [[String: Any]]
        releases[0]["rolloutCohortCount"] = 137
        catalogJSON["releases"] = releases
        for cohort in 1...1000 {
            stateJSON["cohort"] = String(cohort)
            let state = try snapshot(stateJSON)
            let catalog = try parse(catalogJSON, state)
            XCTAssertEqual(LynxCatalogPolicy.desired(catalog: catalog, snapshot: state)?.receipt.kind,
                           included.contains(cohort) ? "BUNDLE" : "BUILTIN", "cohort \(cohort)")
        }
    }
}
