#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

private let builtInBundleId = "01900000-0000-7000-8000-000000000000"
private let testBuild = "1.2.0|build"
private let bundle1 = "01910000-0000-7000-8000-000000000001"
private let bundle2 = "01910000-0000-7000-8000-000000000002"
private let release1 = "01920000-0000-7000-8000-000000000001"
private let release2 = "01920000-0000-7000-8000-000000000002"
private let release3 = "01920000-0000-7000-8000-000000000003"
private let catalogId = "catalog-1"
private let catalogHash = "sha256:" + String(repeating: "a", count: 64)
private let baseURL = "https://updates.example.com/api/"
private let scopeKey = "v1:app-version:ios:\(try! encodeChannelKey("production"))"
private let catalogURL =
    "https://updates.example.com/api/release-catalogs/app-version/ios/\(try! encodeChannelKey("production"))/\(canonicalizeAppVersion("1.0.0")!)"

struct NativeUpdateCheckTests {
    // MARK: checkForUpdate

    @Test
    func noCatalogReturnsNilReportedAsUnchanged() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(status: 404, headers: ["x-hot-updater-catalog": " None "], body: "")
        }
        let checker = makeChecker(host, transport)

        let update = try await checker.checkForUpdate(options(headers: ["X-API-Key": "secret"]))

        #expect(update == nil)
        let request = try #require(transport.requests.first)
        #expect(request.url.absoluteString == catalogURL)
        #expect(request.headers == ["accept": "application/json", "x-api-key": "secret"])
        #expect(request.timeout == 5)
        #expect(try await checker.checkForUpdate(options()) == nil)
        // As checkForUpdate.ts, each check that finds nothing reports the bundle the app keeps.
        let events = host.events()
        #expect(events.map { $0["name"] as? String } == ["onUpdateCheck", "onUpdateCheck"])
        let payload = try #require(events.first?["payload"] as? [String: Any])
        #expect(payload["status"] as? String == "UNCHANGED")
        #expect(payload["bundleId"] as? String == builtInBundleId)
        #expect(payload["releaseId"] is NSNull)
        #expect(payload["previousReleaseId"] is NSNull)
        // Each catalog response is queued before the check it answered, as fetchUpdateResponse.ts reports it.
        #expect(host.queued().prefix(2).map { $0["name"] as? String } == ["onHttpResponse", "onUpdateCheck"])
        let response = try #require(host.httpResponses().first)
        #expect(response["resource"] as? String == "catalog")
        #expect(response["channel"] as? String == "production")
        #expect(response["path"] as? String == URL(string: catalogURL)?.path)
        #expect(response["status"] as? Int == 404)
        #expect(response["bodyTruncated"] as? Bool == false)
    }

    @Test
    func aQueuedResponseBodyIsBoundedByUTF16CodeUnits() {
        // One character with thousands of combining marks is one grapheme but
        // far over the limit in code units, as Android and JavaScript count it.
        let combining = "e" + String(repeating: "\u{0301}", count: 5_000)
        #expect(combining.count == 1)
        let bounded = NativeUpdateChecker.queuedHttpResponseBody(combining)
        #expect(bounded.truncated)
        #expect(bounded.body.utf16.count == NativeUpdateChecker.httpResponseBodyLimit)

        let short = NativeUpdateChecker.queuedHttpResponseBody("{}")
        #expect(short == ("{}", false))

        // A surrogate pair split at the limit decodes to one replacement character.
        let split = String(repeating: "a", count: NativeUpdateChecker.httpResponseBodyLimit - 1) + "😀"
        let repaired = NativeUpdateChecker.queuedHttpResponseBody(split)
        #expect(repaired.truncated)
        #expect(repaired.body.utf16.count == NativeUpdateChecker.httpResponseBodyLimit)
        #expect(repaired.body.hasSuffix("\u{FFFD}"))
    }

    @Test
    func notModifiedUsesTheCachedCatalog() async throws {
        let host = FakeUpdateHost()
        let body = catalog(releases: [descriptor(release2, bundle2)])
        let responses = Responses([
            NativeUpdateResponse(status: 200, headers: ["etag": "\"v1\""], body: body),
            NativeUpdateResponse(status: 304, headers: [:], body: ""),
        ])
        let transport = FakeUpdateTransport { _, _ in responses.next() }
        let checker = makeChecker(host, transport)

        let first = try await checker.checkForUpdate(options())
        let second = try await checker.checkForUpdate(options())

        #expect(first?.id == release2)
        #expect(second?.id == release2)
        #expect(transport.requests.count == 2)
        #expect(transport.requests[0].headers["if-none-match"] == nil)
        #expect(transport.requests[1].headers["if-none-match"] == "\"v1\"")
        let cached = try #require(host.catalogCache.values.first)
        #expect(cached == "1\n\"v1\"\n\(body)")
        #expect(host.catalogCache.keys.first?.hasPrefix("native:") == true)
    }

    @Test
    func notModifiedWithoutACachedCatalogRefetches() async throws {
        let host = FakeUpdateHost()
        let responses = Responses([
            NativeUpdateResponse(status: 304, headers: [:], body: ""),
            NativeUpdateResponse(status: 200, headers: [:], body: catalog(releases: [descriptor(release2, bundle2)])),
        ])
        let transport = FakeUpdateTransport { _, _ in responses.next() }
        let checker = makeChecker(host, transport)

        let update = try await checker.checkForUpdate(options())

        #expect(update?.id == release2)
        #expect(transport.requests.count == 2)
        #expect(transport.requests.allSatisfy { $0.headers["if-none-match"] == nil })
    }

    @Test
    func updateStagesThroughNativeUpdateBundle() async throws {
        let host = FakeUpdateHost()
        host.stage = { _, _ in ["delivery": "patch", "patchFallback": true] }
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2, message: "Fixes")])
        )
        let occurredAt = Date(timeIntervalSince1970: 1_700_000_000.123)
        let checker = NativeUpdateChecker(host: host, transport: transport, now: { occurredAt })

        let update = try #require(try await checker.checkForUpdate(options()))

        #expect(update.id == release2)
        #expect(update.releaseId == release2)
        #expect(update.status == .update)
        #expect(update.transitionKind == "INSTALL")
        #expect(update.shouldForceUpdate == false)
        #expect(update.message == "Fixes")
        #expect(update.rolloutCohortCount == 1000)
        #expect(update.targetCohorts.isEmpty)
        #expect(update.transitionKind == "INSTALL")
        #expect(host.stagedParams.isEmpty)

        #expect(try await update.updateBundle())

        #expect(transport.requests.last?.url.absoluteString
            == "https://updates.example.com/api/artifacts/v2/\(bundle2)/from/\(builtInBundleId)")
        let params = try #require(host.stagedParams.first)
        // installArtifact's parameters, as checkForUpdate.ts sends them: no assets.
        #expect(Set(params.keys) == [
            "bundleId", "channel", "filesUrl", "manifestFileHash", "manifestUrl",
            "requestHeaders", "requestTimeout", "selection",
        ])
        #expect(params["bundleId"] as? String == bundle2)
        #expect(params["channel"] as? String == "production")
        #expect(params["manifestUrl"] as? String == "https://cdn.example.com/manifest.json")
        #expect(params["manifestFileHash"] as? String == "sha256:manifest")
        // The staging asks for the URLs of the files it downloads, with the
        // check's headers and timeout, as checkForUpdate.ts passes them.
        #expect(params["filesUrl"] as? String == "https://updates.example.com/api/artifacts/v2/\(bundle2)/files")
        #expect(params["requestHeaders"] as? [String: String] == [:])
        #expect(params["requestTimeout"] as? Double == 5_000)
        // The staging's files responses are reported like the other artifact requests.
        let reportFiles = try #require(host.filesResponse)
        reportFiles(500, "boom")
        let files = try #require(host.httpResponses().last)
        #expect(files["resource"] as? String == "artifact")
        #expect(files["path"] as? String == "/api/artifacts/v2/\(bundle2)/files")
        #expect(files["status"] as? Int == 500)
        #expect(files["body"] as? String == "boom")
        let selection = try #require(params["selection"] as? [String: Any])
        #expect(selection["kind"] as? String == "BUNDLE")
        #expect(selection["releaseId"] as? String == release2)
        #expect(selection["bundleId"] as? String == bundle2)
        #expect(selection["catalogId"] as? String == catalogId)
        #expect(selection["scopeKey"] as? String == scopeKey)
        #expect((selection["generation"] as? NSNumber)?.int64Value == 1)
        #expect(selection["catalogHash"] as? String == catalogHash)
        #expect(selection["channel"] as? String == "production")
        #expect(selection["selectionContextHash"] as? String == host.acceptedGuards.first?["selectionContextHash"] as? String)

        let events = host.events()
        #expect(events.map { $0["name"] as? String } == ["onUpdateCheck", "onBundleDownloaded"])
        #expect(events.allSatisfy { ($0["occurredAt"] as? NSNumber)?.int64Value == 1_700_000_000_123 })
        let check = try #require(events[0]["payload"] as? [String: Any])
        #expect(check["status"] as? String == "UPDATE_AVAILABLE")
        #expect(check["fromBundleId"] as? String == builtInBundleId)
        #expect(check["fromReleaseId"] is NSNull)
        #expect(check["toBundleId"] as? String == bundle2)
        #expect(check["toReleaseId"] as? String == release2)
        #expect(check["transitionKind"] as? String == "INSTALL")
        #expect(check["updateStatus"] as? String == "UPDATE")
        #expect(check["shouldForceUpdate"] as? Bool == false)
        #expect(check["updateStrategy"] as? String == "appVersion")
        let downloaded = try #require(events[1]["payload"] as? [String: Any])
        #expect(downloaded["channel"] as? String == "production")
        #expect(downloaded["fromBundleId"] as? String == builtInBundleId)
        #expect(downloaded["toBundleId"] as? String == bundle2)
        #expect(downloaded["toReleaseId"] as? String == release2)
        #expect(downloaded["delivery"] as? String == "patch")
        #expect(downloaded["patchFallback"] as? Bool == true)
        #expect(downloaded["updateStrategy"] as? String == "appVersion")
    }

    @Test
    func adoptReleaseCommitsWithoutDownloadAndReportsItUnchanged() async throws {
        let host = FakeUpdateHost()
        host.bundleIdValue = bundle2
        host.active = receipt(release2, bundle2, generation: 1)
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(generation: 2, releases: [descriptor(release3, bundle2, force: true)])
        )
        let checker = makeChecker(host, transport)

        let update = try #require(try await checker.checkForUpdate(options()))

        #expect(update.transitionKind == "ADOPT_RELEASE")
        #expect(update.shouldForceUpdate == false)
        #expect(try await update.updateBundle())
        #expect(host.stagedParams.isEmpty)
        #expect(transport.requests.count == 1)
        let committed = try #require(host.committedParams.first)
        #expect((committed["selection"] as? [String: Any])?["releaseId"] as? String == release3)
        #expect((committed["guard"] as? [String: Any])?["catalogId"] as? String == catalogId)
        let payloads = host.events().compactMap { $0["payload"] as? [String: Any] }
        #expect(payloads.map { $0["status"] as? String } == ["UPDATE_AVAILABLE", "UNCHANGED"])
        // As checkForUpdate.ts, the running bundle is now selected as the newer Release.
        #expect(payloads.last?["bundleId"] as? String == bundle2)
        #expect(payloads.last?["releaseId"] as? String == release3)
        #expect(payloads.last?["previousReleaseId"] as? String == release2)
    }

    @Test
    func adoptingAStagedBundlesReleaseDoesNotReportItUnchanged() async throws {
        let host = FakeUpdateHost()
        // React Native runs bundle 1; bundle 2 is staged for the next launch.
        host.bundleIdValue = bundle1
        host.active = receipt(release2, bundle2, generation: 1)
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(generation: 2, releases: [descriptor(release3, bundle2, force: true)])
        )
        let checker = makeChecker(host, transport)

        let update = try #require(try await checker.checkForUpdate(options()))
        #expect(update.transitionKind == "ADOPT_RELEASE")
        #expect(try await update.updateBundle())

        #expect(host.committedParams.count == 1)
        let payloads = host.events().compactMap { $0["payload"] as? [String: Any] }
        #expect(payloads.map { $0["status"] as? String } == ["UPDATE_AVAILABLE"])
    }

    @Test
    func rollbackToBuiltInCommits() async throws {
        let host = FakeUpdateHost()
        host.bundleIdValue = bundle1
        host.active = receipt(release1, bundle1, generation: 1)
        let transport = FakeUpdateTransport.serving(catalog: catalog(generation: 2, releases: []))
        let checker = makeChecker(host, transport)
        // A download an earlier check queued, which the built-in bundle replaces.
        NativeUpdateEvents.append(
            name: "onBundleDownloaded",
            payload: [:],
            occurredAt: Date(),
            build: NativeUpdateEvents.build(appVersion: host.appVersion, minBundleId: host.minBundleId, cohort: host.cohort()),
            to: host
        )

        let update = try #require(try await checker.checkForUpdate(options()))

        #expect(update.transitionKind == "USE_BUILTIN")
        #expect(update.status == .rollback)
        #expect(update.id == builtInBundleId)
        #expect(update.releaseId == nil)
        #expect(update.shouldForceUpdate)
        #expect(try await update.updateBundle())
        #expect(host.stagedParams.isEmpty)
        let selection = try #require(host.committedParams.first?["selection"] as? [String: Any])
        #expect(selection["kind"] as? String == "BUILTIN")
        #expect(selection["bundleId"] as? String == builtInBundleId)
        #expect(selection["releaseId"] is NSNull)
        #expect(!host.events().contains { $0["name"] as? String == "onBundleDownloaded" })
        let check = try #require(host.events().first?["payload"] as? [String: Any])
        #expect(check["fromReleaseId"] as? String == release1)
        #expect(check["toReleaseId"] is NSNull)
        #expect(check["updateStatus"] as? String == "ROLLBACK")
    }

    @Test
    func aCheckMergesItsOptionsOverTheInstancesAsJavaScriptDoes() {
        let instance = HotUpdaterOptions(
            baseURL: baseURL,
            requestHeaders: ["X-API-Key": "instance", "x-tenant": "a"],
            requestTimeout: 7
        )

        let merged = NativeCheckRequest(instance, HotUpdaterCheckOptions(
            updateStrategy: .fingerprint,
            channel: "beta",
            requestHeaders: ["x-api-key": "check"]
        ))
        #expect(merged.baseURL == baseURL)
        #expect(merged.updateStrategy == .fingerprint)
        #expect(merged.channel == "beta")
        // The check's header replaces the instance's of the same name, whatever its case.
        #expect(merged.requestHeaders == ["x-api-key": "check", "x-tenant": "a"])
        #expect(merged.requestTimeout == 7)

        let ownTimeout = NativeCheckRequest(instance, HotUpdaterCheckOptions(updateStrategy: .appVersion, requestTimeout: 2))
        #expect(ownTimeout.requestTimeout == 2)
    }

    @Test
    func invalidBaseURLFailsWithoutARequest() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport.serving(catalog: catalog(releases: []))
        let checker = makeChecker(host, transport)

        for url in ["", "updates.example.com", "ftp://updates.example.com", "https://"] {
            await #expect(throws: NativeUpdateCheckError.self) {
                _ = try await checker.checkForUpdate(options(baseURL: url))
            }
        }
        #expect(transport.requests.isEmpty)
        // Reported as JavaScript reports a check whose request fails.
        let events = host.events()
        #expect(events.count == 4)
        #expect(events.allSatisfy { $0["name"] as? String == "onUpdateError" })
        #expect((events.first?["payload"] as? [String: Any])?["stage"] as? String == "check")
    }

    @Test
    func invalidRequestTimeoutFailsWithoutARequest() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport.serving(catalog: catalog(releases: []))
        let checker = makeChecker(host, transport)

        for requestTimeout in [0, -1, TimeInterval.nan, TimeInterval.infinity] {
            let invalid = NativeCheckRequest(
                baseURL: baseURL,
                updateStrategy: .appVersion,
                requestTimeout: requestTimeout
            )
            do {
                _ = try await checker.checkForUpdate(invalid)
                Issue.record("Expected the check to throw")
            } catch {
                #expect(error.localizedDescription == "requestTimeout must be a positive number of seconds")
            }
        }
        #expect(transport.requests.isEmpty)
        #expect(host.events().count == 4)
        #expect(host.events().allSatisfy { $0["name"] as? String == "onUpdateError" })
    }

    @Test
    func aCheckWithNoAppVersionThrowsWithoutReporting() async throws {
        let host = FakeUpdateHost()
        host.appVersion = nil
        let transport = FakeUpdateTransport.serving(catalog: catalog(releases: []))
        let checker = makeChecker(host, transport)

        await #expect(throws: NativeUpdateCheckError.self) { _ = try await checker.checkForUpdate(options()) }
        #expect(transport.requests.isEmpty)
        // As checkForUpdate.ts, which passes it only to onError.
        #expect(host.events().isEmpty)
    }

    @Test
    func explicitChannelWhileSwitchedThrows() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "beta"
        let transport = FakeUpdateTransport.serving(catalog: catalog(releases: []))
        let checker = makeChecker(host, transport)

        do {
            _ = try await checker.checkForUpdate(options(channel: "staging"))
            Issue.record("Expected the check to throw")
        } catch {
            #expect(error.localizedDescription
                == "Runtime channel is already switched to \"beta\". Call hotUpdater.resetChannel() before checking \"staging\".")
        }
        #expect(transport.requests.isEmpty)
        // As checkForUpdate.ts: a refused call, not an update failure, queues no onUpdateError.
        #expect(host.events().isEmpty)
    }

    // MARK: A switched channel that holds nothing for this build

    @Test
    func aSwitchedChannelWithAnEmptyCatalogIsLeftOnStaging() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        host.bundleIdValue = bundle1
        // What the server answers for a deleted channel's scope.
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(generation: 3, releases: [], channel: "pr-2")
        )
        let checker = makeChecker(host, transport)

        let update = try #require(try await checker.checkForUpdate(options()))

        #expect(transport.requests.first?.url.path.contains(try encodeChannelKey("pr-2")) == true)
        #expect(update.id == builtInBundleId)
        #expect(update.releaseId == nil)
        #expect(update.status == .rollback)
        #expect(update.transitionKind == "USE_BUILTIN")
        #expect(update.shouldForceUpdate == true)
        // The check itself changes nothing.
        #expect(host.resetCalls == 0)

        #expect(try await update.updateBundle())

        #expect(host.resetCalls == 1)
        // Nothing is selected inside the channel it leaves.
        #expect(host.committedParams.isEmpty)
        #expect(host.stagedParams.isEmpty)
    }

    @Test
    func aSwitchedChannelWithoutACatalogStays() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(status: 404, headers: ["x-hot-updater-catalog": "none"], body: "")
        }
        let checker = makeChecker(host, transport)

        // A scope without a catalog proves nothing about the channel.
        #expect(try await checker.checkForUpdate(options()) == nil)
        #expect(host.resetCalls == 0)
    }

    @Test
    func aSwitchedChannelThatSawANewerCatalogBeforeStagingIsKept() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        host.bundleIdValue = bundle1
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(generation: 3, releases: [], channel: "pr-2")
        )
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))
        #expect(host.acceptedGuards.last?["generation"] as? NSNumber == 3)
        host.isCurrent = false

        await #expect(throws: NativeUpdateCheckError.self) { _ = try await update.updateBundle() }
        #expect(host.resetCalls == 0)
    }

    @Test
    func aChannelTheDeviceLeftBeforeStagingIsKept() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        host.bundleIdValue = bundle1
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(generation: 3, releases: [], channel: "pr-2")
        )
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))
        host.channelValue = "pr-3"

        await #expect(throws: NativeUpdateCheckError.self) { _ = try await update.updateBundle() }
        #expect(host.resetCalls == 0)
    }

    @Test
    func anotherResultOfTheSameCatalogCountsTheLeaveAsDone() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        host.bundleIdValue = bundle1
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(generation: 3, releases: [], channel: "pr-2")
        )
        let checker = makeChecker(host, transport)
        let first = try #require(try await checker.checkForUpdate(options()))
        let second = try #require(try await checker.checkForUpdate(options()))

        #expect(try await first.updateBundle())
        // The reset left the channel, as native resetChannel does.
        host.channelValue = host.defaultChannelValue
        #expect(try await second.updateBundle())
        #expect(host.resetCalls == 1)
    }

    @Test
    func aDuplicateLeaveStillSucceedsAfterALaterStaging() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        host.bundleIdValue = bundle1
        let prCatalog = catalog(generation: 3, releases: [], channel: "pr-2")
        let defaultCatalog = catalog(releases: [descriptor(release2, bundle2)])
        let transport = FakeUpdateTransport(artifactV2: { _ in
            NativeUpdateResponse(status: 200, headers: [:], body: artifactV2Body)
        }) { url, _ in
            if url.path.contains("/artifacts/v1/") {
                return NativeUpdateResponse(status: 200, headers: [:], body: artifactBody)
            }
            let body = url.path.contains(try! encodeChannelKey("pr-2")) ? prCatalog : defaultCatalog
            return NativeUpdateResponse(status: 200, headers: [:], body: body)
        }
        let checker = makeChecker(host, transport)
        let first = try #require(try await checker.checkForUpdate(options()))
        let second = try #require(try await checker.checkForUpdate(options()))
        #expect(try await first.updateBundle())
        // Back on the default channel, the app stages its update.
        host.channelValue = host.defaultChannelValue
        host.bundleIdValue = nil
        let staged = try #require(try await checker.checkForUpdate(options()))
        #expect(staged.transitionKind == "INSTALL")
        #expect(try await staged.updateBundle())
        #expect(host.events().contains { $0["name"] as? String == "onBundleDownloaded" })

        #expect(try await second.updateBundle())

        #expect(host.resetCalls == 1)
        #expect(host.events().contains { $0["name"] as? String == "onBundleDownloaded" })
    }

    @Test
    func leavesFromDifferentCatalogsNeverJoin() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        host.bundleIdValue = bundle1
        var generation = 3
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(
                status: 200,
                headers: [:],
                body: catalog(generation: generation, releases: [], channel: "pr-2")
            )
        }
        let checker = makeChecker(host, transport)

        let first = try #require(try await checker.checkForUpdate(options()))
        let again = try #require(try await checker.checkForUpdate(options()))
        generation = 4
        let newer = try #require(try await checker.checkForUpdate(options()))

        #expect(first.targetKey == again.targetKey)
        #expect(first.targetKey != newer.targetKey)
    }

    @Test
    func theDefaultChannelEmptiedRollsBackWithoutAReset() async throws {
        let host = FakeUpdateHost()
        host.bundleIdValue = bundle1
        host.active = receipt(release1, bundle1, generation: 1)
        host.stable = host.active
        let transport = FakeUpdateTransport.serving(catalog: catalog(generation: 3, releases: []))
        let checker = makeChecker(host, transport)

        let update = try #require(try await checker.checkForUpdate(options()))

        #expect(update.transitionKind == "USE_BUILTIN")
        #expect(try await update.updateBundle())
        #expect(host.committedParams.count == 1)
        #expect(host.resetCalls == 0)
    }

    @Test
    func aSwitchedChannelWithReleasesKeepsTheSwitch() async throws {
        let host = FakeUpdateHost()
        host.channelValue = "pr-2"
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2)], channel: "pr-2")
        )
        let checker = makeChecker(host, transport)

        let update = try #require(try await checker.checkForUpdate(options()))

        #expect(update.transitionKind == "INSTALL")
        #expect(try await update.updateBundle())
        #expect(host.resetCalls == 0)
    }

    // MARK: Checks and stagings

    @Test
    func a200WhoseBodyBreaksIsReportedBeforeTheCheckFails() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            throw NativeUpdateResponseBodyError(
                response: NativeUpdateResponse(status: 200, headers: [:], body: "", bodyReadFailed: true),
                underlying: URLError(.networkConnectionLost)
            )
        }
        let checker = makeChecker(host, transport)

        await #expect(throws: URLError.self) {
            _ = try await checker.checkForUpdate(options())
        }

        let response = try #require(host.httpResponses().first)
        #expect(response["status"] as? Int == 200)
        #expect(response["body"] is NSNull)
        #expect(host.events().map { $0["name"] as? String } == ["onUpdateError"])
    }

    @Test
    func cancellingTheCheckReportsNoFailure() async throws {
        let host = FakeUpdateHost()
        let requested = Latch()
        let transport = FakeUpdateTransport { _, _ in
            requested.open()
            try await Task.sleep(nanoseconds: 30_000_000_000)
            throw CancellationError()
        }
        let checker = makeChecker(host, transport)

        let check = Task { try await checker.checkForUpdate(options()) }
        await requested.wait()
        check.cancel()

        await #expect(throws: CancellationError.self) {
            _ = try await check.value
        }
        #expect(host.events().isEmpty)
    }

    @Test
    func updateBundleJoinsTheDownloadInProgress() async throws {
        let host = FakeUpdateHost()
        let download = Latch()
        host.stage = { _, _ in
            await download.wait()
            return ["delivery": "archive", "patchFallback": false]
        }
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2)])
        )
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))
        let first = Task { try await update.updateBundle() }
        await host.stageStarted.wait()

        let cancelled = Task { try await update.updateBundle() }
        cancelled.cancel()
        await #expect(throws: CancellationError.self) {
            _ = try await cancelled.value
        }
        // Joined while the download runs, or after it staged this update:
        // either way there is one download.
        let joined = Task { try await update.updateBundle() }
        download.open()

        #expect(try await first.value)
        #expect(try await joined.value)
        #expect(try await update.updateBundle())
        #expect(host.stageCalls == 1)
    }

    @Test
    func anArtifactProtocolV2PatchStagesWithItsAssetPath() async throws {
        let host = FakeUpdateHost()
        let body = """
        {"artifactProtocolVersion":2,"manifestUrl":"https://cdn.example.com/manifest.json",\
        "manifestFileHash":"sha256:manifest","archiveUrl":"https://cdn.example.com/bundle.zip",\
        "patch":{"assetPath":"index.ios.bundle","patchUrl":"https://cdn.example.com/index.patch",\
        "patchFileHash":"sha256:patch","baseBundleId":"\(builtInBundleId)","baseFileHash":"sha256:base"}}
        """
        let transport = FakeUpdateTransport(artifactV2: { _ in
            NativeUpdateResponse(status: 200, headers: [:], body: body)
        }) { _, _ in
            NativeUpdateResponse(status: 200, headers: [:], body: catalog(releases: [descriptor(release2, bundle2)]))
        }
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options(headers: ["x-api-key": "key"])))

        #expect(try await update.updateBundle())

        let params = try #require(host.stagedParams.first)
        #expect(params["archiveUrl"] as? String == "https://cdn.example.com/bundle.zip")
        #expect(params["requestHeaders"] as? [String: String] == ["x-api-key": "key"])
        #expect(params["assets"] == nil)
        let patch = try #require(params["patch"] as? [String: Any])
        #expect(patch["assetPath"] as? String == "index.ios.bundle")
        #expect(patch["patchUrl"] as? String == "https://cdn.example.com/index.patch")
        #expect(patch["patchFileHash"] as? String == "sha256:patch")
    }

    @Test
    func aServerOlderThanArtifactProtocolV2GetsTheV1Request() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { url, _ in
            if url.path.contains("/artifacts/v1/") {
                return NativeUpdateResponse(status: 200, headers: [:], body: artifactBody)
            }
            return NativeUpdateResponse(status: 200, headers: [:], body: catalog(releases: [descriptor(release2, bundle2)]))
        }
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))

        #expect(try await update.updateBundle())

        #expect(Array(transport.requests.dropFirst().map(\.url.absoluteString)) == [
            "https://updates.example.com/api/artifacts/v2/\(bundle2)/from/\(builtInBundleId)",
            "https://updates.example.com/api/artifacts/v1/\(bundle2)/from/\(builtInBundleId)",
        ])
        let params = try #require(host.stagedParams.first)
        #expect(Set(params.keys) == ["assets", "bundleId", "channel", "manifestFileHash", "manifestUrl", "selection"])
        let assets = try #require(params["assets"] as? [String: Any])
        #expect((assets["index.ios.bundle"] as? [String: Any])?["fileHash"] as? String == "hash")
        #expect(host.httpResponses().map { $0["status"] as? Int } == [200, 404, 200])
    }

    @Test
    func anArtifactProtocolV2ErrorOtherThan404DoesNotFallBack() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport(artifactV2: { _ in
            NativeUpdateResponse(status: 500, headers: [:], body: "")
        }) { _, _ in
            NativeUpdateResponse(status: 200, headers: [:], body: catalog(releases: [descriptor(release2, bundle2)]))
        }
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))

        await #expect(throws: NativeUpdateCheckError.self) { _ = try await update.updateBundle() }
        #expect(!transport.requests.contains { $0.url.path.contains("/artifacts/v1/") })
        #expect(host.stageCalls == 0)
    }

    @Test
    func anArtifactProtocolV2ResponseThatIsNotV2IsInvalid() async throws {
        let bodies = [
            artifactBody,
            #"{"artifactProtocolVersion":2,"manifestUrl":"https://cdn.example.com/m.json"}"#,
            #"{"artifactProtocolVersion":2,"manifestUrl":"https://cdn.example.com/m.json","manifestFileHash":"h","patch":null}"#,
            #"{"artifactProtocolVersion":2,"manifestUrl":"https://cdn.example.com/m.json","manifestFileHash":"h","patch":{"assetPath":"a"}}"#,
            #"{"artifactProtocolVersion":2,"manifestUrl":"/m.json","manifestFileHash":"h"}"#,
        ]
        for body in bodies {
            let host = FakeUpdateHost()
            let transport = FakeUpdateTransport(artifactV2: { _ in
                NativeUpdateResponse(status: 200, headers: [:], body: body)
            }) { _, _ in
                NativeUpdateResponse(status: 200, headers: [:], body: catalog(releases: [descriptor(release2, bundle2)]))
            }
            let checker = makeChecker(host, transport)
            let update = try #require(try await checker.checkForUpdate(options()))

            await #expect(throws: NativeUpdateCheckError.self) { _ = try await update.updateBundle() }
            #expect(host.stageCalls == 0)
        }
    }

    @Test
    func objectiveCSetsEveryCheckOption() throws {
        // Objective-C reaches the per-check headers and timeout through these.
        let initializer = NSSelectorFromString("initWithUpdateStrategy:channel:requestHeaders:requestTimeout:")
        #expect(HotUpdaterCheckOptions.instancesRespond(to: initializer))
        let options = HotUpdaterCheckOptions(updateStrategy: .fingerprint, requestHeaders: ["x": "1"], requestTimeout: 3)
        #expect(options.value(forKey: "requestTimeout") as? NSNumber == 3)
        #expect(options.value(forKey: "requestHeaders") as? [String: String] == ["x": "1"])
        #expect(HotUpdaterCheckOptions(updateStrategy: .fingerprint).value(forKey: "requestTimeout") == nil)
    }

    @Test
    func anArtifactResponseThatIsNotStrictJSONIsInvalid() async throws {
        let host = FakeUpdateHost()
        // JSONSerialization accepts the trailing comma; JSON.parse does not.
        let body = String(artifactBody.dropLast()) + ",}"
        let transport = FakeUpdateTransport { url, _ in
            if url.path.contains("/artifacts/v1/") {
                return NativeUpdateResponse(status: 200, headers: [:], body: body)
            }
            return NativeUpdateResponse(status: 200, headers: [:],
                body: catalog(releases: [descriptor(release2, bundle2)]))
        }
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))

        await #expect(throws: NativeUpdateCheckError.self) { _ = try await update.updateBundle() }
        #expect(host.stageCalls == 0)
    }

    @Test
    func aPatchThatIsNotAnObjectIsInvalid() async throws {
        for patch in ["true", "\"patch\"", "[]"] {
            let host = FakeUpdateHost()
            let body = artifactBody.replacingOccurrences(
                of: "\"fileHash\":\"hash\",",
                with: "\"fileHash\":\"hash\",\"patch\":\(patch),"
            )
            let transport = FakeUpdateTransport { url, _ in
                if url.path.contains("/artifacts/v1/") {
                    return NativeUpdateResponse(status: 200, headers: [:], body: body)
                }
                return NativeUpdateResponse(status: 200, headers: [:],
                    body: catalog(releases: [descriptor(release2, bundle2)]))
            }
            let checker = makeChecker(host, transport)
            let update = try #require(try await checker.checkForUpdate(options()))

            await #expect(throws: NativeUpdateCheckError.self) { _ = try await update.updateBundle() }
            #expect(host.stageCalls == 0)
        }
    }

    @Test
    func updateBundleJoinsOnlyTheSameSelection() async throws {
        // The same bundle promoted to a newer Release is another selection: it
        // stages and commits its own receipt instead of joining the first.
        let host = FakeUpdateHost()
        let download = Latch()
        host.stage = { _, _ in
            await download.wait()
            return ["delivery": "archive", "patchFallback": false]
        }
        let catalogBody = LockedValue(catalog(generation: 1, releases: [descriptor(release2, bundle2)]))
        let transport = FakeUpdateTransport { url, _ in
            if url.path.contains("/artifacts/v1/") {
                return NativeUpdateResponse(status: 200, headers: [:], body: artifactBody)
            }
            return NativeUpdateResponse(status: 200, headers: [:], body: catalogBody.value)
        }
        let checker = makeChecker(host, transport)
        let first = try #require(try await checker.checkForUpdate(options()))
        catalogBody.value = catalog(generation: 2, releases: [descriptor(release3, bundle2)])
        let second = try #require(try await checker.checkForUpdate(options()))
        // The same Release from a newer catalog is another selection too.
        catalogBody.value = catalog(generation: 3, releases: [descriptor(release3, bundle2)])
        let third = try #require(try await checker.checkForUpdate(options()))

        let firstStaging = Task { try await first.updateBundle() }
        await host.stageStarted.wait()
        let secondStaging = Task { try await second.updateBundle() }
        let thirdStaging = Task { try await third.updateBundle() }
        download.open()

        #expect(try await firstStaging.value)
        #expect(try await secondStaging.value)
        #expect(try await thirdStaging.value)
        #expect(host.stageCalls == 3)
    }

    @Test
    func anUpdateThatJoinedAStagingIsStaged() async throws {
        let host = FakeUpdateHost()
        let download = Latch()
        host.stage = { _, _ in
            await download.wait()
            return ["delivery": "archive", "patchFallback": false]
        }
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2)])
        )
        let checker = makeChecker(host, transport)
        let first = try #require(try await checker.checkForUpdate(options()))
        let second = try #require(try await checker.checkForUpdate(options()))
        #expect(first.targetKey == second.targetKey)

        let firstStaging = Task { try await first.updateBundle() }
        await host.stageStarted.wait()
        let joined = Task { try await second.updateBundle() }
        // Gives the second call time to join before the download ends.
        try await Task.sleep(nanoseconds: 100_000_000)
        download.open()
        #expect(try await firstStaging.value)
        #expect(try await joined.value)
        let requests = transport.requests.count

        #expect(try await second.updateBundle())
        #expect(host.stageCalls == 1)
        #expect(transport.requests.count == requests)
    }

    @Test
    func aRetainedResultOfACommittedTargetIsStagedWhileItsSelectionIsCurrent() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2)])
        )
        let checker = makeChecker(host, transport)
        let first = try #require(try await checker.checkForUpdate(options()))
        let second = try #require(try await checker.checkForUpdate(options()))
        let third = try #require(try await checker.checkForUpdate(options()))

        #expect(try await first.updateBundle())
        let requests = transport.requests.count
        #expect(try await second.updateBundle())
        #expect(host.stageCalls == 1)
        #expect(transport.requests.count == requests)

        // A newer catalog superseded the selection without staging anything.
        host.isCurrent = false
        await #expect(throws: NativeUpdateCheckError.self) {
            _ = try await third.updateBundle()
        }
        // So does the result that staged it.
        await #expect(throws: NativeUpdateCheckError.self) {
            _ = try await first.updateBundle()
        }
        #expect(host.stageCalls == 1)
    }

    @Test
    func updateBundleOnAStagedUpdateDoesNotDownloadAgain() async throws {
        let host = FakeUpdateHost()
        let download = Latch()
        host.stage = { _, _ in
            await download.wait()
            return ["delivery": "archive", "patchFallback": false]
        }
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2)])
        )
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))
        download.open()

        #expect(try await update.updateBundle())
        #expect(try await update.updateBundle())

        #expect(host.stageCalls == 1)
        #expect(transport.requests.count == 2)
    }

    @Test
    func cancellingUpdateBundleEndsTheWaitButNotTheDownload() async throws {
        let host = FakeUpdateHost()
        let download = Latch()
        host.stage = { _, _ in
            await download.wait()
            return ["delivery": "archive", "patchFallback": false]
        }
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2, force: true)])
        )
        let checker = makeChecker(host, transport)

        let update = try #require(try await checker.checkForUpdate(options()))
        let task = Task { try await update.updateBundle() }
        await host.stageStarted.wait()
        task.cancel()
        await #expect(throws: CancellationError.self) {
            _ = try await task.value
        }

        #expect(!host.stageFinished.isOpen)
        download.open()
        #expect(try await update.updateBundle())
        #expect(host.stageCalls == 1)
        #expect(host.events().last?["name"] as? String == "onBundleDownloaded")
        #expect(host.httpResponses().map { $0["resource"] as? String } == ["catalog", "artifact"])
    }

    @Test
    func progressArrivesOnTheMainQueue() async throws {
        let host = FakeUpdateHost()
        host.stage = { _, progress in
            for value in [0.0, 0.001, 0.25, 0.5, 1.0] {
                progress(value)
            }
            return ["delivery": "archive", "patchFallback": false]
        }
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2, force: true)])
        )
        let checker = makeChecker(host, transport)
        let received = ProgressRecorder()

        let update = try #require(try await checker.checkForUpdate(options()))
        #expect(try await update.updateBundle { received.record($0) })
        await received.complete.wait()
        #expect(received.values == [0.0, 0.25, 0.5, 1.0])
        #expect(received.allOnMain)
    }

    @Test
    func aResetDropsTheQueuedDownloadsOfTheBundlesItDeletes() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2)])
        )
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))
        #expect(try await update.updateBundle())
        #expect(host.events().contains { $0["name"] as? String == "onBundleDownloaded" })

        #expect(await checker.resetChannel())

        #expect(!host.events().contains { $0["name"] as? String == "onBundleDownloaded" })
        #expect(host.events().contains { $0["name"] as? String == "onUpdateCheck" })
    }

    @Test
    func resetChannelWaitsForTheDownloadInProgress() async throws {
        let host = FakeUpdateHost()
        let download = Latch()
        host.stage = { _, _ in
            await download.wait()
            return ["delivery": "archive", "patchFallback": false]
        }
        let transport = FakeUpdateTransport.serving(
            catalog: catalog(releases: [descriptor(release2, bundle2)])
        )
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))
        let staging = Task { try await update.updateBundle() }
        await host.stageStarted.wait()

        let reset = Task { await checker.resetChannel() }
        // Whenever the reset task runs, the held download keeps it waiting.
        for _ in 0..<100 {
            await Task.yield()
        }
        #expect(host.resetCalls == 0)
        download.open()

        #expect(await reset.value)
        #expect(try await staging.value)
        #expect(host.resetCalls == 1)
        #expect(host.stageFinished.isOpen)
    }

    // MARK: Recovery request

    /// A check the server answered, with a catalog or with none yet, is the
    /// request main's check after a crash repeats.
    @Test(arguments: [false, true])
    func anAnsweredCheckIsKeptForTheCheckAfterACrash(hasCatalog: Bool) async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            hasCatalog
                ? NativeUpdateResponse(status: 200, headers: [:], body: catalog(releases: [descriptor(release2, bundle2)]))
                : NativeUpdateResponse(status: 404, headers: ["x-hot-updater-catalog": "none"], body: "")
        }
        let checker = makeChecker(host, transport)

        _ = try await checker.checkForUpdate(options(headers: ["X-API-Key": "secret"]))

        let kept = try #require(host.recoveryRequests.first)
        #expect(host.recoveryRequests.count == 1)
        #expect(kept.requestHeaders == ["X-API-Key": "secret"])
    }

    /// A check the server never answered keeps the request kept before.
    @Test
    func aFailedCheckKeepsNoRecoveryRequest() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(status: 500, headers: [:], body: "oops")
        }
        let checker = makeChecker(host, transport)

        _ = try? await checker.checkForUpdate(options())

        #expect(host.recoveryRequests.isEmpty)
    }

    // MARK: Errors

    @Test
    func aCatalogResponseIsReportedAsTheCatalogUnderAnArtifactsBasePath() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(status: 500, headers: [:], body: "oops")
        }
        let checker = makeChecker(host, transport)

        _ = try? await checker.checkForUpdate(options(baseURL: "https://updates.example.com/artifacts/hot-updater"))

        #expect(host.httpResponses().map { $0["resource"] as? String } == ["catalog"])
    }

    @Test
    func catalogHTTPErrorReportsCheckFailure() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(status: 500, headers: [:], body: "oops")
        }
        let checker = makeChecker(host, transport)

        for _ in 0..<2 {
            do {
                _ = try await checker.checkForUpdate(options())
                Issue.record("Expected the check to throw")
            } catch {
                #expect(error.localizedDescription == "Request failed with HTTP 500")
            }
        }

        let events = host.events()
        #expect(events.count == 2)
        #expect(events.allSatisfy { $0["name"] as? String == "onUpdateError" })
        let payload = try #require(events[0]["payload"] as? [String: Any])
        #expect(payload["stage"] as? String == "check")
        #expect(payload["reason"] as? String == "http")
        #expect(payload["resource"] as? String == "catalog")
        #expect(payload["httpStatus"] as? Int == 500)
        #expect(payload["channel"] as? String == "production")
        #expect(payload["bundleId"] as? String == builtInBundleId)
        #expect(payload["releaseId"] is NSNull)
        #expect(payload["updateStrategy"] as? String == "appVersion")
        #expect(payload["message"] as? String == "Request failed with HTTP 500")
        #expect(payload["targetBundleId"] == nil)
        #expect(payload["transport"] == nil)
    }

    @Test
    func invalidCatalogReportsInvalidResponse() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(status: 200, headers: ["etag": "v1"], body: "{}")
        }
        let checker = makeChecker(host, transport)

        await #expect(throws: NativeUpdateCheckError.self) {
            _ = try await checker.checkForUpdate(options())
        }

        let payload = try #require(host.events().first?["payload"] as? [String: Any])
        #expect(payload["reason"] as? String == "invalid_response")
        #expect(host.catalogCache.isEmpty)
    }

    @Test
    func networkFailureNamesItsTransport() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in throw URLError(.notConnectedToInternet) }
        let checker = makeChecker(host, transport)

        await #expect(throws: URLError.self) {
            _ = try await checker.checkForUpdate(options())
        }

        let payload = try #require(host.events().first?["payload"] as? [String: Any])
        #expect(payload["reason"] as? String == "network")
        #expect(payload["transport"] as? String == "offline")
    }

    @Test
    func nativeStagingFailureReportsItsClassification() async throws {
        let host = FakeUpdateHost()
        host.stage = { _, _ in
            throw NativeUpdateRejection(
                code: "DOWNLOAD_FAILED",
                message: "Forbidden",
                userInfo: [
                    "stage": "download",
                    "reason": "http",
                    "resource": "file",
                    "httpStatus": NSNumber(value: 403),
                    "originCode": "AccessDenied",
                ]
            )
        }
        let transport = FakeUpdateTransport.serving(catalog: catalog(releases: [descriptor(release2, bundle2)]))
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))

        await #expect(throws: NativeUpdateRejection.self) {
            _ = try await update.updateBundle()
        }

        let events = host.events()
        #expect(events.map { $0["name"] as? String } == ["onUpdateCheck", "onUpdateError"])
        let payload = try #require(events[1]["payload"] as? [String: Any])
        #expect(payload["stage"] as? String == "download")
        #expect(payload["reason"] as? String == "http")
        #expect(payload["resource"] as? String == "file")
        #expect(payload["httpStatus"] as? Int == 403)
        #expect(payload["originCode"] as? String == "AccessDenied")
        #expect(payload["targetBundleId"] as? String == bundle2)
        #expect(payload["targetReleaseId"] as? String == release2)
        #expect(payload["message"] as? String == "Forbidden")
    }

    @Test
    func staleSelectionIsNotAnUpdateFailure() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport.serving(catalog: catalog(releases: [descriptor(release2, bundle2)]))
        let checker = makeChecker(host, transport)
        let update = try #require(try await checker.checkForUpdate(options()))
        host.isCurrent = false

        await #expect(throws: NativeUpdateCheckError.self) {
            _ = try await update.updateBundle()
        }

        #expect(host.events().count == 1)
        #expect(host.stagedParams.isEmpty)
    }

    // MARK: Event queue

    @Test
    func eventsQueuedBeforeACohortChangeAreNotReplayedUnderTheNewCohort() async throws {
        let host = FakeUpdateHost()
        let transport = FakeUpdateTransport { _, _ in
            NativeUpdateResponse(status: 404, headers: ["x-hot-updater-catalog": "none"], body: "")
        }
        _ = try await makeChecker(host, transport).checkForUpdate(options())
        #expect(!host.events().isEmpty)

        host.cohortValue = "2"

        let build = NativeUpdateEvents.build(appVersion: host.appVersion, minBundleId: host.minBundleId, cohort: host.cohort())
        #expect(NativeUpdateEvents.take(from: host, build: build) == nil)
    }

    @Test
    func takingTheEventsDropsThoseOfAnotherNativeBuild() throws {
        let storage = MemoryEventStorage()
        NativeUpdateEvents.append(name: "onBundleDownloaded", payload: [:], occurredAt: Date(), build: "1.2.0|first", to: storage)
        // The app was upgraded before JavaScript took the event.
        NativeUpdateEvents.append(name: "onUpdateCheck", payload: [:], occurredAt: Date(), build: "1.3.0|second", to: storage)

        let taken = try #require(NativeUpdateEvents.take(from: storage, build: "1.3.0|second"))
        let events = try #require(try JSONSerialization.jsonObject(with: Data(taken.utf8)) as? [[String: Any]])

        #expect(events.map { $0["name"] as? String } == ["onUpdateCheck"])
        #expect(storage.storageItem(NativeUpdateEvents.storageKey) == nil)
    }

    @Test
    func eventQueueKeepsTheNewestTwentyOfEachName() {
        let storage = MemoryEventStorage()
        storage.setStorageItem(NativeUpdateEvents.storageKey, value: "not json")
        for index in 0..<25 {
            NativeUpdateEvents.append(
                name: "onUpdateError",
                payload: ["index": index],
                occurredAt: Date(timeIntervalSince1970: Double(index)),
                build: testBuild,
                to: storage
            )
            if index < 3 {
                NativeUpdateEvents.append(name: "onUpdateCheck", payload: ["index": index], occurredAt: Date(), build: testBuild, to: storage)
            }
        }

        let events = storage.events()
        let errors = events.filter { $0["name"] as? String == "onUpdateError" }
        #expect(errors.count == NativeUpdateEvents.maxEventsPerName)
        #expect(errors.map { ($0["payload"] as? [String: Any])?["index"] as? Int } == Array(5..<25))
        #expect((errors.first?["occurredAt"] as? NSNumber)?.int64Value == 5_000)
        #expect(events.filter { $0["name"] as? String == "onUpdateCheck" }.count == 3)
    }

    @Test
    func takingEventsReturnsAndClearsThem() {
        let storage = MemoryEventStorage()
        #expect(NativeUpdateEvents.take(from: storage, build: testBuild) == nil)

        NativeUpdateEvents.append(name: "onUpdateCheck", payload: [:], occurredAt: Date(), build: testBuild, to: storage)
        let taken = NativeUpdateEvents.take(from: storage, build: testBuild)

        let events = try? JSONSerialization.jsonObject(with: Data((taken ?? "").utf8)) as? [[String: Any]]
        #expect(events?.count == 1)
        #expect(storage.storageItem(NativeUpdateEvents.storageKey) == nil)
        #expect(NativeUpdateEvents.take(from: storage, build: testBuild) == nil)

        storage.setStorageItem(NativeUpdateEvents.storageKey, value: "[]")
        #expect(NativeUpdateEvents.take(from: storage, build: testBuild) == nil)
        #expect(storage.storageItem(NativeUpdateEvents.storageKey) == nil)
    }

    @Test
    func takingEventsNeverLosesAConcurrentAppend() async {
        let storage = MemoryEventStorage()
        let names = (0..<50).map { "event-\($0)" }
        let taken = TakenEvents()

        await withTaskGroup(of: Void.self) { group in
            for name in names {
                group.addTask {
                    for _ in 0..<4 {
                        NativeUpdateEvents.append(name: name, payload: [:], occurredAt: Date(), build: testBuild, to: storage)
                    }
                }
            }
            for _ in 0..<20 {
                group.addTask {
                    taken.add(NativeUpdateEvents.take(from: storage, build: testBuild))
                }
            }
        }
        taken.add(NativeUpdateEvents.take(from: storage, build: testBuild))

        #expect(taken.count == names.count * 4)
    }

    @Test
    func encodesURIComponentsAsJavaScript() {
        #expect(NativeUpdateChecker.encodeURIComponent("a b/c?d=e&f+g!~*'()") == "a%20b%2Fc%3Fd%3De%26f%2Bg!~*'()")
    }
}

// MARK: - Fixtures

private func options(
    baseURL: String = baseURL,
    headers: [String: String] = [:],
    channel: String? = nil
) -> NativeCheckRequest {
    NativeCheckRequest(
        baseURL: baseURL,
        updateStrategy: .appVersion,
        requestHeaders: headers,
        channel: channel
    )
}

private func descriptor(
    _ releaseId: String,
    _ bundleId: String,
    force: Bool = false,
    message: String? = nil
) -> [String: Any] {
    [
        "releaseId": releaseId,
        "kind": "BUNDLE",
        "bundleId": bundleId,
        "rolloutCohortCount": 1000,
        "targetCohorts": [String](),
        "shouldForceUpdate": force,
        "message": message ?? NSNull(),
    ]
}

private func catalog(generation: Int = 1, releases: [[String: Any]], channel: String = "production") -> String {
    let object: [String: Any] = [
        "schemaVersion": 1,
        "catalogId": catalogId,
        "scopeKey": "v1:app-version:ios:\(try! encodeChannelKey(channel))",
        "generation": generation,
        "catalogHash": catalogHash,
        "fallbackPolicy": "BUILTIN_IF_ACTIVE_INELIGIBLE",
        "releases": releases,
        "rollbackReleases": releases,
    ]
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
}

private func receipt(_ releaseId: String, _ bundleId: String, generation: Int64) -> PersistedSelection {
    PersistedSelection(
        kind: "BUNDLE",
        releaseId: releaseId,
        bundleId: bundleId,
        catalogId: catalogId,
        scopeKey: scopeKey,
        generation: generation,
        catalogHash: catalogHash,
        channel: "production",
        selectionContextHash: "previous"
    )
}

private let artifactBody = """
{"artifactProtocolVersion":1,"manifestUrl":"https://cdn.example.com/manifest.json",\
"manifestFileHash":"sha256:manifest","assets":{"index.ios.bundle":{"fileHash":"hash",\
"file":{"url":"https://cdn.example.com/index.ios.bundle"}}}}
"""

private let artifactV2Body = """
{"artifactProtocolVersion":2,"manifestUrl":"https://cdn.example.com/manifest.json",\
"manifestFileHash":"sha256:manifest"}
"""

private let frozenNow = Date(timeIntervalSince1970: 1_700_000_000)

private func makeChecker(_ host: FakeUpdateHost, _ transport: FakeUpdateTransport) -> NativeUpdateChecker {
    NativeUpdateChecker(host: host, transport: transport, now: { frozenNow })
}

private func parseEvents(_ value: String?) -> [[String: Any]] {
    guard let value,
          let events = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [[String: Any]] else {
        return []
    }
    return events
}

// MARK: - Fakes

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}

private final class Latch: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if opened {
                lock.unlock()
                continuation.resume()
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return opened
    }

    func open() {
        lock.lock()
        opened = true
        let waiters = self.waiters
        self.waiters = []
        lock.unlock()
        waiters.forEach { $0.resume() }
    }
}

private final class Responses: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [NativeUpdateResponse]

    init(_ responses: [NativeUpdateResponse]) {
        self.responses = responses
    }

    func next() -> NativeUpdateResponse {
        lock.lock()
        defer { lock.unlock() }
        return responses.removeFirst()
    }
}

private final class ProgressRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Double] = []
    private var onMain = true

    var values: [Double] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    var allOnMain: Bool {
        lock.lock()
        defer { lock.unlock() }
        return onMain
    }

    let complete = Latch()

    func record(_ value: Double) {
        lock.lock()
        recorded.append(value)
        onMain = onMain && Thread.isMainThread
        lock.unlock()
        if value >= 1 {
            complete.open()
        }
    }
}

private final class TakenEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var total = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return total
    }

    func add(_ value: String?) {
        let events = parseEvents(value).count
        lock.lock()
        total += events
        lock.unlock()
    }
}

private class MemoryEventStorage: NativeUpdateEventStorage, @unchecked Sendable {
    private let storageLock = NSLock()
    private var storage: [String: String] = [:]

    /// The queued lifecycle events, without the HTTP responses (`httpResponses()`).
    func events() -> [[String: Any]] {
        queued().filter { $0["name"] as? String != "onHttpResponse" }
    }

    func httpResponses() -> [[String: Any]] {
        queued()
            .filter { $0["name"] as? String == "onHttpResponse" }
            .compactMap { $0["payload"] as? [String: Any] }
    }

    func queued() -> [[String: Any]] {
        parseEvents(storageItem(NativeUpdateEvents.storageKey))
    }

    func storageItem(_ key: String) -> String? {
        storageLock.lock()
        defer { storageLock.unlock() }
        return storage[key]
    }

    func setStorageItem(_ key: String, value: String?) {
        storageLock.lock()
        defer { storageLock.unlock() }
        storage[key] = value
    }
}

private final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) {
        stored = value
    }

    var value: Value {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}

private final class FakeUpdateTransport: NativeUpdateTransport, @unchecked Sendable {
    struct Request {
        let url: URL
        let headers: [String: String]
        let timeout: TimeInterval
    }

    private let lock = NSLock()
    private var recorded: [Request] = []
    private let respond: (URL, TimeInterval) async throws -> NativeUpdateResponse
    private let artifactV2: ((URL) -> NativeUpdateResponse)?

    /// `artifactV2` answers artifact protocol v2 requests. Without it they get
    /// 404, as from a server older than v2, and the check falls back to v1.
    init(
        artifactV2: ((URL) -> NativeUpdateResponse)? = nil,
        _ respond: @escaping (URL, TimeInterval) async throws -> NativeUpdateResponse
    ) {
        self.artifactV2 = artifactV2
        self.respond = respond
    }

    static func serving(catalog body: String) -> FakeUpdateTransport {
        FakeUpdateTransport(artifactV2: { _ in
            NativeUpdateResponse(status: 200, headers: [:], body: artifactV2Body)
        }) { url, _ in
            if url.path.contains("/artifacts/v1/") {
                return NativeUpdateResponse(status: 200, headers: [:], body: artifactBody)
            }
            return NativeUpdateResponse(status: 200, headers: [:], body: body)
        }
    }

    var requests: [Request] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func get(_ url: URL, headers: [String: String], timeout: TimeInterval) async throws -> NativeUpdateResponse {
        record(Request(url: url, headers: headers, timeout: timeout))
        if url.path.contains("/artifacts/v2/") {
            return artifactV2?(url) ?? NativeUpdateResponse(status: 404, headers: [:], body: "Not Found")
        }
        return try await respond(url, timeout)
    }

    private func record(_ request: Request) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(request)
    }
}

private final class FakeUpdateHost: MemoryEventStorage, NativeUpdateHost, @unchecked Sendable {
    private let lock = NSLock()

    var appVersion: String? = "1.0.0"
    let minBundleId = builtInBundleId
    var bundleIdValue: String?
    var channelValue = "production"
    var defaultChannelValue = "production"
    var active: PersistedSelection?
    var stable: PersistedSelection?
    var isCurrent = true
    var catalogCache: [String: String] = [:]
    var stage: ([String: Any], @escaping (Double) -> Void) async throws -> Any? = { _, _ in
        ["delivery": "archive", "patchFallback": false]
    }
    private(set) var acceptedGuards: [[String: Any]] = []
    private(set) var committedParams: [[String: Any]] = []
    private(set) var stagedParams: [[String: Any]] = []
    /// The last staging's files response reporter.
    private(set) var filesResponse: ((Int, String?) -> Void)?
    private(set) var resets = 0
    /// The requests the server answered, as main keeps them for its check after a crash.
    private(set) var recoveryRequests: [NativeCheckRequest] = []
    /// Opened when native `updateBundle` is first called, and when it first returns.
    let stageStarted = Latch()
    let stageFinished = Latch()

    var stageCalls: Int {
        lock.lock()
        defer { lock.unlock() }
        return stagedParams.count
    }

    var resetCalls: Int {
        lock.lock()
        defer { lock.unlock() }
        return resets
    }

    func bundleId() -> String? { bundleIdValue }
    func channel() -> String { channelValue }
    func defaultChannel() -> String { defaultChannelValue }
    var cohortValue = "1"
    func cohort() -> String { cohortValue }
    func fingerprintHash() -> String? { nil }
    func crashHistory() -> [String] { [] }

    func activeUpdateState() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return [
            "activeSelection": active?.dictionary ?? NSNull(),
            "stableSelection": stable?.dictionary ?? NSNull(),
            "verificationPending": false,
            "highestSeenCatalogs": [String: Any](),
        ]
    }

    func acceptReleaseCatalog(_ params: [String: Any]) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        acceptedGuards.append(params)
        return true
    }

    func isReleaseSelectionCurrent(_: [String: Any]) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return isCurrent
    }

    func commitReleaseSelection(_ params: [String: Any]) async throws -> Bool {
        recordCommit(params)
        return true
    }

    func updateBundle(
        _ params: [String: Any],
        onFilesResponse: ((Int, String?) -> Void)?,
        progress: @escaping (Double) -> Void
    ) async throws -> Any? {
        lock.lock()
        filesResponse = onFilesResponse
        lock.unlock()
        let stage = recordStage(params)
        stageStarted.open()
        defer { stageFinished.open() }
        return try await stage(params, progress)
    }

    func recordRecoveryRequest(_ request: NativeCheckRequest) {
        lock.lock()
        recoveryRequests.append(request)
        lock.unlock()
    }

    func resetChannel() async -> Bool {
        recordReset()
        return true
    }

    func resetChannelIfSelectionCurrent(_ guardParams: [String: Any]) async -> Bool {
        guard isReleaseSelectionCurrent(guardParams) else { return false }
        recordReset()
        return true
    }

    private func recordCommit(_ params: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        committedParams.append(params)
    }

    private func recordStage(
        _ params: [String: Any]
    ) -> ([String: Any], @escaping (Double) -> Void) async throws -> Any? {
        lock.lock()
        defer { lock.unlock() }
        stagedParams.append(params)
        return stage
    }

    private func recordReset() {
        lock.lock()
        defer { lock.unlock() }
        resets += 1
    }

    func releaseCatalogCache(_ partition: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return catalogCache[partition]
    }

    func setReleaseCatalogCache(_ partition: String, value: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        catalogCache[partition] = value
        return true
    }

    func removeReleaseCatalogCache(_ partition: String) {
        lock.lock()
        defer { lock.unlock() }
        catalogCache[partition] = nil
    }
}
struct URLSessionUpdateTransportTests {
    @Test
    func cancellingTheCallerCancelsTheRequest() async throws {
        let transport = URLSessionUpdateTransport(protocolClasses: [StallingURLProtocol.self])
        let request = Task {
            try await transport.get(
                URL(string: "https://updates.example.com/catalog")!,
                headers: [:],
                timeout: 30
            )
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        let started = Date()
        request.cancel()

        await #expect(throws: CancellationError.self) {
            _ = try await request.value
        }
        #expect(Date().timeIntervalSince(started) < 5)
        // URLSession stops the protocol shortly after the task cancels.
        for _ in 0..<50 where !StallingURLProtocol.stopped {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(StallingURLProtocol.stopped)
    }

    @Test
    func a200WhoseBodyBreaksFailsWithTheResponseThatArrived() async throws {
        let transport = URLSessionUpdateTransport(protocolClasses: [BrokenBodyURLProtocol.self])

        await #expect {
            _ = try await transport.get(URL(string: "https://updates.example.com/catalog")!, headers: [:], timeout: 5)
        } throws: { error in
            guard let error = error as? NativeUpdateResponseBodyError else { return false }
            return error.response.status == 200 && error.response.bodyReadFailed
        }
    }
}

struct HTTPArtifactFileResolverTests {
    @Test
    func aFilesResponseIsReadAsJSONParseReadsIt() throws {
        let bodies = [
            #"{"files":{"a.png":{"url":"https://cdn.example.com/a.png"}}} trailing"#,
            #"{'files':{"a.png":{"url":"https://cdn.example.com/a.png"}}}"#,
            #"{"files":{"a.png":{"url":"https://cdn.example.com/a.png",}}}"#,
            #"{"files":{"a.png":{"url":1}}}"#,
        ]
        for (index, body) in bodies.enumerated() {
            let filesUrl = URL(string: "https://updates.example.com/artifacts/v2/strict-\(index)/files")!
            FilesBodyURLProtocol.serve(body, at: filesUrl)
            let resolver = HTTPArtifactFileResolver(
                filesUrl: filesUrl,
                headers: [:],
                protocolClasses: [FilesBodyURLProtocol.self]
            )
            #expect(throws: (any Error).self, "\(body)") { _ = try resolver.resolve(paths: ["a.png"]) }
        }
    }

    @Test
    func aFilesResponseResolvesAPathThatIsNotItsOwnDecomposition() throws {
        // "한글.png" in NFC: Swift compares it canonically, JSON.parse by code units.
        let path = "assets/\u{D55C}\u{AE00}.png"
        let filesUrl = URL(string: "https://updates.example.com/artifacts/v2/nfc/files")!
        FilesBodyURLProtocol.serve(
            #"{"files":{"\#(path)":{"url":"https://cdn.example.com/k.png","compression":"br"}}}"#,
            at: filesUrl
        )
        let resolver = HTTPArtifactFileResolver(
            filesUrl: filesUrl,
            headers: [:],
            protocolClasses: [FilesBodyURLProtocol.self]
        )

        let files = try resolver.resolve(paths: [path])

        #expect(files[path] == ResolvedArtifactFile(url: URL(string: "https://cdn.example.com/k.png")!, compression: "br"))
    }

    @Test
    func aFailingFilesResponseIsReportedBeforeItFails() throws {
        let responses = LockedValue<[(Int, String?)]>([])
        let resolver = HTTPArtifactFileResolver(
            filesUrl: URL(string: "https://updates.example.com/artifacts/v2/b/files")!,
            headers: [:],
            protocolClasses: [FailingFilesURLProtocol.self],
            onResponse: { status, body in responses.value.append((status, body)) }
        )

        #expect(throws: (any Error).self) { _ = try resolver.resolve(paths: ["index.ios.bundle"]) }
        #expect(responses.value.map(\.0) == [500])
        #expect(responses.value.map(\.1) == ["boom"])
    }

    @Test
    func theRequestTimeoutBoundsAFilesResponseThatKeepsArriving() throws {
        let resolver = HTTPArtifactFileResolver(
            filesUrl: URL(string: "https://updates.example.com/artifacts/v2/b/files")!,
            headers: [:],
            timeout: 1,
            protocolClasses: [TricklingURLProtocol.self]
        )
        let started = Date()

        #expect(throws: (any Error).self) { _ = try resolver.resolve(paths: ["index.ios.bundle"]) }
        // The body keeps arriving for 6 s, never idle for the timeout.
        #expect(Date().timeIntervalSince(started) < 4)
    }
}

/// Answers 200 with the body served at the request's URL. Tests run in
/// parallel, so each serves its own URL.
private final class FilesBodyURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var bodies: [URL: String] = [:]

    static func serve(_ body: String, at url: URL) {
        lock.lock()
        bodies[url] = body
        lock.unlock()
    }

    private static func body(at url: URL?) -> String {
        lock.lock()
        defer { lock.unlock() }
        return url.flatMap { bodies[$0] } ?? ""
    }

    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body(at: request.url).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Answers 500 with "boom".
private final class FailingFilesURLProtocol: URLProtocol {
    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("boom".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Sends a 200, then a byte every 100 ms for 6 s, so the request is never idle.
private final class TricklingURLProtocol: URLProtocol {
    private var stopped = false
    private let lock = NSLock()

    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        trickle(remaining: 60)
    }

    private func trickle(remaining: Int) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [self] in
            lock.lock()
            let isStopped = stopped
            lock.unlock()
            guard !isStopped else { return }
            if remaining == 0 {
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            client?.urlProtocol(self, didLoad: Data(" ".utf8))
            trickle(remaining: remaining - 1)
        }
    }

    override func stopLoading() {
        lock.lock()
        stopped = true
        lock.unlock()
    }
}

/// Sends a 200's headers, then loses the connection.
private final class BrokenBodyURLProtocol: URLProtocol {
    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json", "Content-Length": "100"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"a\"".utf8))
        // The connection drops while the body is in transit.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [self] in
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        }
    }

    override func stopLoading() {}
}

/// Never answers, so only cancellation ends the request.
private final class StallingURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var stoppedValue = false
    static var stopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stoppedValue
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {}
    override func stopLoading() {
        Self.lock.lock()
        Self.stoppedValue = true
        Self.lock.unlock()
    }
}
#endif
