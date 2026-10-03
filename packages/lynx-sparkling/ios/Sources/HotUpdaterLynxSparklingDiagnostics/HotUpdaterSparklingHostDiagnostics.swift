#if canImport(Sparkling)
import Foundation
import HotUpdaterLynxArtifact
import Lynx

struct StaleAuthority {
    let controller: LynxController
    let context: LynxLaunchContext
    let details: [String: Any]
}

extension HotUpdaterSparklingHost {
    public func installRuntimeJournalFixtureForDiagnostics(
        _ mode: String
    ) throws {
        try eventJournal.installDiagnosticsFixture(mode)
    }

    public func appendRuntimeJournalFixtureEventForDiagnostics() -> Bool {
        eventJournal.append(
            name: "diagnosticFixtureEvent",
            details: hotUpdaterDiagnosticRuntimeEventDetails([
                "fixture": "append",
            ])
        )
    }

    public func reopenRuntimeJournalFixtureForDiagnostics() throws {
        try eventJournal.reopenDiagnosticsFixture()
    }

    public func runtimeJournalFixtureReceiptForDiagnostics() throws
        -> [String: Any] {
        try eventJournal.diagnosticsReceipt()
    }

    public func restoreRuntimeJournalFixtureForDiagnostics() throws {
        try eventJournal.restoreDiagnosticsFixture()
    }

    public func exerciseRuntimeEventFieldBoundariesForDiagnostics() throws
        -> [String: Any] {
        let liveIdentity: [String: Any] = [
            "processId": String(ProcessInfo.processInfo.processIdentifier),
            "identitySource": "live-diagnostic",
        ]
        let before = try eventJournal.snapshot()["latestSequence"] ?? NSNull()
        let exactName = String(repeating: "n", count: 128)
        let exactNameAccepted = eventJournal.append(
            name: exactName,
            details: hotUpdaterDiagnosticRuntimeEventDetails(liveIdentity)
        )
        let namePlusOneRejected = !eventJournal.append(
            name: exactName + "n",
            details: hotUpdaterDiagnosticRuntimeEventDetails(liveIdentity)
        )
        let emptyDetails = hotUpdaterDiagnosticRuntimeEventDetails([
            "payload": "",
        ].merging(liveIdentity) { _, new in new })
        let detailsOverhead = try JSONSerialization.data(
            withJSONObject: emptyDetails,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ).count
        let exactPayload = String(
            repeating: "x",
            count: 64 * 1_024 - detailsOverhead
        )
        let exactDetailsAccepted = eventJournal.append(
            name: "details",
            details: hotUpdaterDiagnosticRuntimeEventDetails([
                "payload": exactPayload,
            ].merging(liveIdentity) { _, new in new })
        )
        let detailsPlusOneRejected = !eventJournal.append(
            name: "details",
            details: hotUpdaterDiagnosticRuntimeEventDetails([
                "payload": exactPayload + "x",
            ].merging(liveIdentity) { _, new in new })
        )
        let after = try eventJournal.snapshot()["latestSequence"] ?? NSNull()
        return [
            "exactNameAccepted": exactNameAccepted,
            "namePlusOneRejected": namePlusOneRejected,
            "exactDetailsAccepted": exactDetailsAccepted,
            "detailsPlusOneRejected": detailsPlusOneRejected,
            "beforeLatestSequence": before,
            "afterLatestSequence": after,
            "acceptedSequenceCount": 2,
        ]
    }

    public func captureDiagnosticAuthorities() -> HotUpdaterSparklingStaleProbe {
        HotUpdaterSparklingStaleProbe(
            authorities: pages.map {
                StaleAuthority(
                    controller: $0.generation.controller,
                    context: $0.generation.context,
                    details: details(for: $0)
                )
            },
            journal: eventJournal,
            events: events
        )
    }

    public func triggerReloadForDiagnostics(
        completion: @escaping (
            Result<LynxManagedTransitionAcceptance, Error>
        ) -> Void
    ) {
        guard let primary = pages.first else {
            completion(.failure(HotUpdaterSparklingError.navigationUnavailable))
            return
        }
        transition(
            "reload",
            from: primary.generation.controller,
            context: primary.generation.context,
            generation: primary.generation.events,
            completion: completion
        )
    }

    public func armNextPageFatalFailureForDiagnostics() {
        failNextSecondaryAdmissionForDiagnostics = true
    }

    public func armNextPageAdmissionPendingForDiagnostics() {
        holdNextSecondaryAdmissionForDiagnostics = true
    }

    @discardableResult
    public func triggerTopPendingAdmissionFailureForDiagnostics(
        _ message: String = "diagnostic fatal failure"
    ) -> Bool {
        guard let page = pages.last, !page.primary,
              (try? controller.pendingPageAttemptId(
                  page.generation.context
              )) != nil else {
            return false
        }
        let failure = ManagedPageFailure(message: message)
        page.generation.events.emit(
            "runtimeFailed",
            details(for: page).merging([
                "message": failure.message,
                "failureCode": NSNull(),
                "failureResourcePath": NSNull(),
            ]) { _, new in new }
        )
        pageFailed(
            failure,
            controller: page.generation.controller,
            context: page.generation.context,
            generation: page.generation.events
        )
        return true
    }
}

final class HotUpdaterLynxDiagnosticsContext {
    weak var host: HotUpdaterSparklingHost?
    var staleProbe: HotUpdaterSparklingStaleProbe?

    init(host: HotUpdaterSparklingHost) {
        self.host = host
    }
}

@objc final class HotUpdaterLynxDiagnostics: NSObject, LynxModule {
    static var name: String { "HotUpdaterLynxDiagnostics" }
    static var methodLookup: [String: String] {
        [
            "armNextPageFatalFailure": NSStringFromSelector(
                #selector(armNextPageFatalFailure(_:))
            ),
            "armNextPageAdmissionPending": NSStringFromSelector(
                #selector(armNextPageAdmissionPending(_:))
            ),
            "triggerTopPendingAdmissionFailure": NSStringFromSelector(
                #selector(triggerTopPendingAdmissionFailure(_:))
            ),
            "triggerReload": NSStringFromSelector(
                #selector(triggerReload(_:))
            ),
            "captureStaleAuthorities": NSStringFromSelector(
                #selector(captureStaleAuthorities(_:))
            ),
            "verifyStaleAuthorities": NSStringFromSelector(
                #selector(verifyStaleAuthorities(_:))
            ),
            "exerciseNavigationStackBoundary": NSStringFromSelector(
                #selector(exerciseNavigationStackBoundary(_:))
            ),
            "installRuntimeJournalFixture": NSStringFromSelector(
                #selector(installRuntimeJournalFixture(_:callback:))
            ),
            "appendRuntimeJournalFixtureEvent": NSStringFromSelector(
                #selector(appendRuntimeJournalFixtureEvent(_:))
            ),
            "reopenRuntimeJournalFixture": NSStringFromSelector(
                #selector(reopenRuntimeJournalFixture(_:))
            ),
            "getRuntimeJournalFixtureReceipt": NSStringFromSelector(
                #selector(getRuntimeJournalFixtureReceipt(_:))
            ),
            "restoreRuntimeJournalFixture": NSStringFromSelector(
                #selector(restoreRuntimeJournalFixture(_:))
            ),
            "exerciseRuntimeEventFieldBoundaries": NSStringFromSelector(
                #selector(exerciseRuntimeEventFieldBoundaries(_:))
            ),
        ]
    }

    private let context: HotUpdaterLynxDiagnosticsContext?

    required init(param: Any) {
        context = param as? HotUpdaterLynxDiagnosticsContext
        super.init()
    }

    override required init() {
        context = nil
        super.init()
    }

    private func withHost(
        _ callback: LynxCallbackBlock?,
        action: @escaping (HotUpdaterSparklingHost) -> Void
    ) {
        DispatchQueue.main.async { [context] in
            guard let host = context?.host else {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "HOST_CLOSED",
                        "message": "The diagnostics host is unavailable",
                    ],
                ])
                return
            }
            action(host)
        }
    }

    @objc func armNextPageFatalFailure(_ callback: LynxCallbackBlock?) {
        withHost(callback) { host in
            host.armNextPageFatalFailureForDiagnostics()
            callback?(["ok": true, "data": ["armed": true]])
        }
    }

    @objc func armNextPageAdmissionPending(_ callback: LynxCallbackBlock?) {
        withHost(callback) { host in
            host.armNextPageAdmissionPendingForDiagnostics()
            callback?(["ok": true, "data": ["armed": true]])
        }
    }

    @objc func triggerTopPendingAdmissionFailure(
        _ callback: LynxCallbackBlock?
    ) {
        withHost(callback) { host in
            callback?([
                "ok": true,
                "data": [
                    "triggered": host
                        .triggerTopPendingAdmissionFailureForDiagnostics(),
                ],
            ])
        }
    }

    @objc func triggerReload(_ callback: LynxCallbackBlock?) {
        withHost(callback) { host in
            host.triggerReloadForDiagnostics { result in
                switch result {
                case .success(let acceptance):
                    callback?([
                        "ok": true,
                        "data": acceptance.dictionary,
                    ])
                case .failure(let error):
                    callback?([
                        "ok": false,
                        "error": [
                            "code": "NATIVE_ERROR",
                            "message": error.localizedDescription,
                        ],
                    ])
                }
            }
        }
    }

    @objc func captureStaleAuthorities(_ callback: LynxCallbackBlock?) {
        withHost(callback) { [context] host in
            context?.staleProbe = host.captureDiagnosticAuthorities()
            callback?(["ok": true, "data": ["captured": true]])
        }
    }

    @objc func verifyStaleAuthorities(_ callback: LynxCallbackBlock?) {
        withHost(callback) { [context] _ in
            guard let probe = context?.staleProbe else {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "MISSING_STALE_CAPTURE",
                        "message": "No stale authorities were captured",
                    ],
                ])
                return
            }
            let rejectedCount = probe.verifyStaleAuthorities()
            context?.staleProbe = nil
            callback?([
                "ok": true,
                "data": [
                    "verified": true,
                    "rejectedCount": rejectedCount,
                ],
            ])
        }
    }

    @objc func exerciseNavigationStackBoundary(
        _ callback: LynxCallbackBlock?
    ) {
        withHost(callback) { host in
            do {
                callback?([
                    "ok": true,
                    "data": try host
                        .exerciseNavigationStackBoundaryForDiagnostics(),
                ])
            } catch {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "NATIVE_ERROR",
                        "message": error.localizedDescription,
                    ],
                ])
            }
        }
    }

    @objc func installRuntimeJournalFixture(
        _ params: [String: Any],
        callback: LynxCallbackBlock?
    ) {
        withHost(callback) { host in
            do {
                guard let mode = params["mode"] as? String else {
                    throw NSError(
                        domain: "HotUpdaterLynxDiagnostics",
                        code: 1,
                        userInfo: [
                            NSLocalizedDescriptionKey: "Missing fixture mode",
                        ]
                    )
                }
                try host.installRuntimeJournalFixtureForDiagnostics(mode)
                callback?(["ok": true, "data": ["mode": mode]])
            } catch {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "INVALID_FIXTURE",
                        "message": error.localizedDescription,
                    ],
                ])
            }
        }
    }

    @objc func appendRuntimeJournalFixtureEvent(
        _ callback: LynxCallbackBlock?
    ) {
        withHost(callback) { host in
            callback?([
                "ok": true,
                "data": [
                    "appended": host
                        .appendRuntimeJournalFixtureEventForDiagnostics(),
                ],
            ])
        }
    }

    @objc func reopenRuntimeJournalFixture(_ callback: LynxCallbackBlock?) {
        withHost(callback) { host in
            do {
                try host.reopenRuntimeJournalFixtureForDiagnostics()
                callback?(["ok": true, "data": ["reopened": true]])
            } catch {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "JOURNAL_UNAVAILABLE",
                        "message": error.localizedDescription,
                    ],
                ])
            }
        }
    }

    @objc func getRuntimeJournalFixtureReceipt(
        _ callback: LynxCallbackBlock?
    ) {
        withHost(callback) { host in
            do {
                callback?([
                    "ok": true,
                    "data": try host
                        .runtimeJournalFixtureReceiptForDiagnostics(),
                ])
            } catch {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "JOURNAL_UNAVAILABLE",
                        "message": error.localizedDescription,
                    ],
                ])
            }
        }
    }

    @objc func restoreRuntimeJournalFixture(_ callback: LynxCallbackBlock?) {
        withHost(callback) { host in
            do {
                try host.restoreRuntimeJournalFixtureForDiagnostics()
                callback?(["ok": true, "data": ["restored": true]])
            } catch {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "JOURNAL_UNAVAILABLE",
                        "message": error.localizedDescription,
                    ],
                ])
            }
        }
    }

    @objc func exerciseRuntimeEventFieldBoundaries(
        _ callback: LynxCallbackBlock?
    ) {
        withHost(callback) { host in
            do {
                callback?([
                    "ok": true,
                    "data": try host
                        .exerciseRuntimeEventFieldBoundariesForDiagnostics(),
                ])
            } catch {
                callback?([
                    "ok": false,
                    "error": [
                        "code": "JOURNAL_UNAVAILABLE",
                        "message": error.localizedDescription,
                    ],
                ])
            }
        }
    }
}

public final class HotUpdaterSparklingStaleProbe {
    private let authorities: [StaleAuthority]
    private let journal: SparklingGenerationEventJournal
    private let events: HotUpdaterSparklingEventHandler?

    init(
        authorities: [StaleAuthority],
        journal: SparklingGenerationEventJournal,
        events: HotUpdaterSparklingEventHandler?
    ) {
        self.authorities = authorities
        self.journal = journal
        self.events = events
    }

    @discardableResult
    public func verifyStaleAuthorities() -> Int {
        authorities.forEach { authority in
            let rejected = (try? authority.controller.getState(
                authority.context
            )) == nil
            precondition(rejected, "A retired Lynx context retained authority")
            let details = authority.details.merging([
                "code": "STALE_CONTEXT",
            ]) { old, _ in old }
            if journal.append(
                name: "staleContextRejected",
                details: details
            ) {
                events?("staleContextRejected", details)
            }
        }
        return authorities.count
    }
}
#endif
