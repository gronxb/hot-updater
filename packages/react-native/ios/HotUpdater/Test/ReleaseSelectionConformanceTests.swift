#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

/// Runs every case of @hot-updater/test-utils' release selection conformance
/// fixture, which @hot-updater/protocol generates, against the Swift port.
struct ReleaseSelectionConformanceTests {
    private static let fixture: [String: Any] = {
        let packages = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Test
            .deletingLastPathComponent() // HotUpdater
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // react-native
            .deletingLastPathComponent() // packages
        let url = packages.appendingPathComponent("test-utils/fixtures/release-selection-conformance.json")
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fatalError("Cannot read the conformance fixture at \(url.path)")
        }
        return object
    }()

    @Test
    func appVersion() {
        for (index, testCase) in cases("appVersion").enumerated() {
            let input = testCase["input"] as! String
            let expected = string(testCase["output"])
            #expect(
                canonicalizeAppVersion(input) == expected,
                "appVersion[\(index)] \(input.debugDescription)"
            )
        }
    }

    @Test
    func channelKey() {
        for (index, testCase) in cases("channelKey").enumerated() {
            let channel = testCase["channel"] as! String
            let actual = try? encodeChannelKey(channel)
            #expect(
                actual.jsEquals(expectedValue(testCase) as? String),
                "channelKey[\(index)] \(channel.debugDescription)"
            )
        }
    }

    @Test
    func scopeKeyCreate() {
        let section = Self.fixture["scopeKey"] as! [String: Any]
        for (index, testCase) in (section["create"] as! [[String: Any]]).enumerated() {
            let scope = scopeInput(testCase["input"] as! [String: Any])
            let actual = try? createReleaseCatalogScopeKey(scope)
            #expect(
                actual.jsEquals(expectedValue(testCase) as? String),
                "scopeKey.create[\(index)]"
            )
        }
    }

    @Test
    func scopeKeyParse() {
        let section = Self.fixture["scopeKey"] as! [String: Any]
        for (index, testCase) in (section["parse"] as! [[String: Any]]).enumerated() {
            let scopeKey = testCase["scopeKey"] as! String
            let actual = (try? parseReleaseCatalogScopeKey(scopeKey)).map(scopeDictionary)
            let expected = expectedValue(testCase) as? [String: Any]
            #expect(
                actual.map { NSDictionary(dictionary: $0) } == expected.map { NSDictionary(dictionary: $0) },
                "scopeKey.parse[\(index)] \(scopeKey.debugDescription)"
            )
        }
    }

    @Test
    func cohortNormalize() {
        let section = Self.fixture["cohort"] as! [String: Any]
        for (index, testCase) in (section["normalize"] as! [[String: Any]]).enumerated() {
            let input = testCase["input"] as! String
            let expected = testCase["output"] as! String
            #expect(
                normalizeCohortValue(input).jsEquals(expected),
                "cohort.normalize[\(index)] \(input.debugDescription)"
            )
        }
    }

    @Test
    func cohortEligible() {
        let section = Self.fixture["cohort"] as! [String: Any]
        for (index, testCase) in (section["eligible"] as! [[String: Any]]).enumerated() {
            let eligible = isReleaseEligibleForCohort(
                releaseId: testCase["releaseId"] as! String,
                rolloutCohortCount: (testCase["rolloutCohortCount"] as! NSNumber).doubleValue,
                targetCohorts: testCase["targetCohorts"] as! [String],
                cohort: string(testCase["cohort"])
            )
            #expect(
                eligible == (testCase["eligible"] as! Bool),
                "cohort.eligible[\(index)]"
            )
        }
    }

    @Test
    func selectionContextHash() {
        for (index, testCase) in cases("selectionContextHash").enumerated() {
            let input = testCase["input"] as! [String: Any]
            let context = ReleaseSelectionContext(
                activeBundleId: string(input["activeBundleId"]),
                activeReleaseId: string(input["activeReleaseId"]),
                cohort: string(input["cohort"]),
                minimumReleaseId: input["minimumReleaseId"] as! String,
                strategy: ReleaseStrategy(rawValue: input["strategy"] as! String)!,
                strategyValue: input["strategyValue"] as! String,
                crashedBundleIds: input["crashedBundleIds"] as! [String]
            )
            #expect(
                createReleaseSelectionContextHash(context) == testCase["hash"] as! String,
                "selectionContextHash[\(index)]"
            )
        }
    }

    @Test
    func parseCatalog() {
        // The protocol returns the parsed object itself, so the fixture records
        // unknown fields; the port keeps only the schema's.
        let schemaFields: Set<String> = [
            "schemaVersion", "catalogId", "scopeKey", "generation", "catalogHash",
            "fallbackPolicy", "releases", "rollbackReleases",
        ]
        for (index, testCase) in cases("parseReleaseCatalog").enumerated() {
            let name = testCase["name"] as! String
            let actual = parseReleaseCatalog(
                testCase["body"] as! String,
                expectedScope: scopeInput(testCase["expectedScope"] as! [String: Any])
            ).map(catalogDictionary)
            let expected = (testCase["catalog"] as? [String: Any])?
                .filter { schemaFields.contains($0.key) }
            #expect(
                actual.map { NSDictionary(dictionary: $0) } == expected.map { NSDictionary(dictionary: $0) },
                "parseReleaseCatalog[\(index)] \(name)"
            )
        }
    }

    @Test
    func parseCatalogWireLimit() throws {
        let limit = (Self.fixture["maxReleaseCatalogWireBytes"] as! NSNumber).intValue
        #expect(ReleaseCatalogLimits.maxReleaseCatalogWireBytes == limit)

        let valid = cases("parseReleaseCatalog")[0]
        let body = valid["body"] as! String
        let scope = scopeInput(valid["expectedScope"] as! [String: Any])
        let padding = limit - body.utf8.count
        try #require(padding > 0)

        let atLimit = body + String(repeating: " ", count: padding)
        #expect(parseReleaseCatalog(atLimit, expectedScope: scope) != nil)
        #expect(parseReleaseCatalog(atLimit + " ", expectedScope: scope) == nil)
    }

    @Test
    func parseKeepsAnUnpairedSurrogateAsJSONParseDoes() throws {
        // The fixture can't hold this case: JSONSerialization, which loads it,
        // rejects an unpaired surrogate. JSON.parse accepts the catalog.
        let valid = try #require(cases("parseReleaseCatalog").first { $0["name"] as? String == "valid app-version catalog" })
        let body = (valid["body"] as! String).replacingOccurrences(of: "\"message\":\"Fix\"", with: "\"message\":\"Fix \\ud800\"")
        let catalog = try #require(parseReleaseCatalog(body, expectedScope: scopeInput(valid["expectedScope"] as! [String: Any])))
        #expect(catalog.releases.first?.message == "Fix \u{FFFD}")
    }

    @Test
    func unpairedSurrogatesStayAsDistinctAsJSONParseKeepsThem() throws {
        let text = "[\"\\ud800\",\"\\ud801\",\"\\ud800\",\"\\ufffd\",\"\\ue000qa\",\"plain\"]"
        let values = try #require(StrictJson.parse(text) as? [String])
        #expect(values.count == 6)
        // Two different unpaired surrogates, as JSON.parse keeps them apart.
        #expect(values[0] != values[1])
        #expect(values[0] == values[2])
        // U+FFFD itself is a different string.
        #expect(values[3] == "\u{FFFD}")
        #expect(values[3] != values[0])
        // Every other value, even one that starts with a private-use
        // character, is kept as is.
        #expect(values[4] == "\u{E000}qa")
        #expect(values[5] == "plain")
        #expect(StrictJson.originalValue(values[0]) == "\u{FFFD}")
        #expect(StrictJson.originalValue(values[4]) == "\u{E000}qa")
        // A value that only looks escaped is returned as is.
        #expect(StrictJson.originalValue("\u{E000}\u{E001}\u{1F600}\u{1F600}") == "\u{E000}\u{E001}\u{1F600}\u{1F600}")
    }

    @Test
    func distinctUnpairedSurrogateCohortsCountAsDistinct() throws {
        let valid = try #require(cases("parseReleaseCatalog").first { $0["name"] as? String == "valid app-version catalog" })
        let body = try #require(valid["body"] as? String)
        let range = try #require(body.range(of: "\"targetCohorts\":[]"))
        let patched = body.replacingCharacters(in: range, with: "\"targetCohorts\":[\"\\ud800\",\"\\ud801\"]")
        let catalog = try #require(parseReleaseCatalog(patched, expectedScope: scopeInput(valid["expectedScope"] as! [String: Any])))
        #expect(Set(catalog.releases.flatMap(\.targetCohorts)).count == 2)
    }

    @Test
    func objectKeysCompareByCodeUnitsAsInJavaScript() throws {
        let text = "{\"scopeKey\":1,\"scope\\u212aey\":2,\"\\u00e9\":3,\"e\\u0301\":4}"
        let object = try #require(StrictJson.parse(text) as? [String: Any])
        // Four distinct keys, as JSON.parse keeps them.
        #expect(object.count == 4)
        #expect((object["scopeKey"] as? NSNumber)?.intValue == 1)
        let originals = object.keys.map { Array(StrictJson.originalKey($0).utf16) }
        #expect(originals.contains(Array("scope\u{212A}ey".utf16)))
        #expect(originals.contains(Array("\u{00E9}".utf16)))
        #expect(originals.contains(Array("e\u{0301}".utf16)))
    }

    @Test
    func selectDesired() {
        for (index, testCase) in cases("selectDesiredRelease").enumerated() {
            let pool = (testCase["pool"] as! [[String: Any]]).map(descriptor)
            let catalog = ReleaseCatalog(
                schemaVersion: 1,
                catalogId: "catalog-1",
                scopeKey: "v1:app-version:ios:cHJvZHVjdGlvbg",
                generation: 1,
                catalogHash: "sha256:" + String(repeating: "b", count: 64),
                fallbackPolicy: testCase["fallbackPolicy"] as! String,
                releases: (testCase["releases"] as! [Int]).map { pool[$0] },
                rollbackReleases: (testCase["rollbackReleases"] as! [Int]).map { pool[$0] }
            )
            let input = testCase["input"] as! [String: Any]
            let runningReleaseId: String?? = input.keys.contains("runningReleaseId")
                ? .some(string(input["runningReleaseId"]))
                : .none
            let desired = selectDesiredRelease(catalog, input: ReleaseSelectionInput(
                builtInBundleId: input["builtInBundleId"] as! String,
                currentBundleId: input["currentBundleId"] as! String,
                activeReleaseId: string(input["activeReleaseId"]),
                runningReleaseId: runningReleaseId,
                minimumReleaseId: input["minimumReleaseId"] as! String,
                cohort: string(input["cohort"]),
                crashedBundleIds: input["crashedBundleIds"] as! [String]
            ))
            let actual = desired.map { desired -> NSDictionary in
                [
                    "bundleId": desired.bundleId,
                    "kind": desired.kind.rawValue,
                    "releaseId": desired.releaseId ?? NSNull(),
                    "shouldForceUpdate": desired.shouldForceUpdate,
                    "status": desired.status.rawValue,
                ]
            }
            let expected = (testCase["desired"] as? [String: Any]).map { NSDictionary(dictionary: $0) }
            #expect(actual == expected, "selectDesiredRelease[\(index)]")
        }
    }

    @Test
    func authorizeTransition() {
        for (index, testCase) in cases("authorizeReleaseTransition").enumerated() {
            let result = authorizeReleaseTransition(
                active: (testCase["active"] as? [String: Any]).map(receipt),
                desired: receipt(testCase["desired"] as! [String: Any]),
                explicitScopeSwitch: testCase["explicitScopeSwitch"] as! Bool
            )
            let expected = testCase["result"] as! [String: Any]
            #expect(
                result.authorized == (expected["authorized"] as! Bool)
                    && result.reason.rawValue == expected["reason"] as! String,
                "authorizeReleaseTransition[\(index)]"
            )
        }
    }

    // MARK: - Fixture readers

    private func cases(_ section: String) -> [[String: Any]] {
        Self.fixture[section] as! [[String: Any]]
    }

    private func string(_ value: Any?) -> String? {
        value as? String
    }

    /// The fixture's `value`, or nil when the protocol threw.
    private func expectedValue(_ testCase: [String: Any]) -> Any? {
        testCase["error"] as? Bool == true ? nil : testCase["value"]
    }

    private func scopeInput(_ input: [String: Any]) -> ReleaseCatalogScope {
        ReleaseCatalogScope(
            platform: ReleasePlatform(rawValue: input["platform"] as! String)!,
            channelKey: input["channelKey"] as! String,
            strategy: ReleaseStrategy(rawValue: input["strategy"] as! String)!,
            fingerprintHash: string(input["fingerprintHash"])
        )
    }

    private func scopeDictionary(_ scope: ReleaseCatalogScope) -> [String: Any] {
        var dictionary: [String: Any] = [
            "channelKey": scope.channelKey,
            "platform": scope.platform.rawValue,
            "strategy": scope.strategy.rawValue,
        ]
        if let fingerprintHash = scope.fingerprintHash {
            dictionary["fingerprintHash"] = fingerprintHash
        }
        return dictionary
    }

    private func descriptor(_ value: [String: Any]) -> ReleaseCatalogDescriptor {
        ReleaseCatalogDescriptor(
            releaseId: value["releaseId"] as! String,
            kind: SelectionKind(rawValue: value["kind"] as! String)!,
            bundleId: string(value["bundleId"]),
            rolloutCohortCount: (value["rolloutCohortCount"] as! NSNumber).intValue,
            targetCohorts: value["targetCohorts"] as! [String],
            shouldForceUpdate: value["shouldForceUpdate"] as! Bool,
            message: string(value["message"])
        )
    }

    private func descriptorDictionary(_ descriptor: ReleaseCatalogDescriptor) -> [String: Any] {
        [
            "bundleId": descriptor.bundleId ?? NSNull(),
            "kind": descriptor.kind.rawValue,
            "message": descriptor.message ?? NSNull(),
            "releaseId": descriptor.releaseId,
            "rolloutCohortCount": descriptor.rolloutCohortCount,
            "shouldForceUpdate": descriptor.shouldForceUpdate,
            "targetCohorts": descriptor.targetCohorts,
        ]
    }

    private func catalogDictionary(_ catalog: ReleaseCatalog) -> [String: Any] {
        [
            "catalogHash": catalog.catalogHash,
            "catalogId": catalog.catalogId,
            "fallbackPolicy": catalog.fallbackPolicy,
            "generation": NSNumber(value: catalog.generation),
            "releases": catalog.releases.map(descriptorDictionary),
            "rollbackReleases": catalog.rollbackReleases.map(descriptorDictionary),
            "schemaVersion": catalog.schemaVersion,
            "scopeKey": catalog.scopeKey,
        ]
    }

    private func receipt(_ value: [String: Any]) -> PersistedSelection {
        PersistedSelection(
            kind: value["kind"] as! String,
            releaseId: string(value["releaseId"]),
            bundleId: value["bundleId"] as! String,
            catalogId: string(value["catalogId"]),
            scopeKey: string(value["scopeKey"]),
            generation: (value["generation"] as? NSNumber)?.int64Value,
            catalogHash: string(value["catalogHash"]),
            channel: value["channel"] as! String,
            selectionContextHash: string(value["selectionContextHash"])
        )
    }
}
#endif
