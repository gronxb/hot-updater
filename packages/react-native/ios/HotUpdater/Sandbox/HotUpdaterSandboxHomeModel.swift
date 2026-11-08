#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// What the Home and Info tabs say, worked out from the coordinator's state with
/// no view in sight. Android's copy says the same words.
struct HotUpdaterSandboxHomeModel: Equatable {
    struct Banner: Equatable {
        let text: String
        /// A bundle that crashed and stays selected: the way out is a reset.
        let offersReset: Bool
    }

    struct BigRow: Equatable {
        let caption: String
        let title: String
        let subtitle: String?
        let detail: String?
        let isReload: Bool
    }

    struct Preview: Equatable {
        let channel: String
        let message: String?
        let opened: String
    }

    struct Status: Equatable {
        let text: String
        /// From 0 to 1 while a download reports it.
        let progress: Double?
    }

    let banner: Banner?
    let bigRow: BigRow
    let status: Status?
    let isBusy: Bool
    let previews: [Preview]
    /// In place of an empty list, or above it before a server answered.
    let previewHint: String?

    static let hint = "Shake the device to come back here."
    /// A row or a typed channel doesn't ask first, so this says it up front.
    static let switchNote = "Opening a preview deletes downloaded bundles."
    static let resetNote = "Removes the channel switch and deletes downloaded bundles."

    init(
        state: HotUpdaterSandboxState,
        isOverApp: Bool,
        runningDevServerHost: String? = nil,
        nowMs: Double
    ) {
        let history = state.history
        let selection = state.selection
        banner = state.lastLaunch.flatMap { Self.banner(of: $0, selection: selection, builtInBundleId: state.details?.builtInBundleId, history: history) }
        bigRow = Self.bigRow(
            state: state,
            isOverApp: isOverApp,
            runningDevServerHost: runningDevServerHost
        )
        status = Self.status(of: state.phase)
        if case .working = state.phase {
            isBusy = true
        } else {
            isBusy = false
        }
        previews = history
            .filter { $0.channel != selection?.channel }
            .map {
                Preview(
                    channel: $0.channel,
                    message: $0.message,
                    opened: HotUpdaterSandboxHistory.openedText(openedAtMs: $0.openedAtMs, nowMs: nowMs)
                )
            }
        if !state.hasServerConfig {
            previewHint = "No update server yet. Previews work once your update server answers one of the app's update checks."
        } else if previews.isEmpty {
            previewHint = "Scan a pull request's QR code, or enter its channel. It stays listed here."
        } else {
            previewHint = nil
        }
    }

    /// `019a3f…c2`, or the whole ID when it's short.
    static func shortId(_ bundleId: String) -> String {
        guard bundleId.count > 10 else { return bundleId }
        return "\(bundleId.prefix(6))…\(bundleId.suffix(2))"
    }

    private static func bigRow(
        state: HotUpdaterSandboxState,
        isOverApp: Bool,
        runningDevServerHost: String?
    ) -> BigRow {
        if isOverApp, let host = runningDevServerHost {
            return BigRow(caption: "Running", title: "Reload", subtitle: "Running the dev server", detail: host, isReload: true)
        }
        guard let selection = state.selection else {
            return BigRow(
                caption: isOverApp ? "Running" : "Current bundle",
                title: isOverApp ? "Reload" : "Open",
                subtitle: nil,
                detail: nil,
                isReload: isOverApp
            )
        }
        if isOverApp {
            return runningRow(
                next: selection,
                running: state.runningBundleId ?? selection.bundleId,
                builtIn: state.details?.builtInBundleId,
                message: state.runningMessage
            )
        }
        if selection.isBuiltIn {
            return BigRow(
                caption: "Current bundle",
                title: "Open built-in bundle",
                subtitle: "The bundle this build shipped with",
                detail: "Channel \(selection.channel)",
                isReload: false
            )
        }
        return BigRow(
            caption: "Current bundle",
            title: "Open \(selection.channel)",
            subtitle: state.selectedMessage,
            detail: "Bundle \(shortId(selection.bundleId))",
            isReload: false
        )
    }

    /// Running is what this process's launch runs, and the selection is the next one.
    private static func runningRow(
        next: HotUpdaterSandboxSelection,
        running: String,
        builtIn: String?,
        message: String?
    ) -> BigRow {
        let runsBuiltIn = running == builtIn
        if next.bundleId == running {
            return BigRow(
                caption: "Running",
                title: "Reload",
                subtitle: runsBuiltIn ? "Running the built-in bundle" : "Running \(next.channel)",
                detail: runsBuiltIn ? "Channel \(next.channel)" : message ?? "Bundle \(shortId(running))",
                isReload: true
            )
        }
        return BigRow(
            caption: "Running",
            title: "Reload",
            subtitle: runsBuiltIn ? "Running the built-in bundle" : "Running bundle \(shortId(running))",
            detail: "Next launch: \(next.isBuiltIn ? "the built-in bundle" : "bundle \(shortId(next.bundleId))")",
            isReload: true
        )
    }

    private static func banner(
        of lastLaunch: HotUpdaterSandboxLastLaunch,
        selection: HotUpdaterSandboxSelection?,
        builtInBundleId: String?,
        history: [HotUpdaterSandboxHistoryEntry]
    ) -> Banner? {
        let selectedId = selection?.bundleId
        /// A channel only when this device recorded that bundle on it.
        func name(_ bundleId: String) -> String {
            if bundleId == builtInBundleId { return "the built-in bundle" }
            if let channel = history.first(where: { $0.bundleId == bundleId })?.channel { return channel }
            return "bundle \(shortId(bundleId))"
        }
        /// A channel keeps its spelling at the start of a sentence.
        func subject(_ bundleId: String) -> String {
            let text = name(bundleId)
            return history.contains { $0.channel == text } ? text : text.prefix(1).uppercased() + text.dropFirst()
        }
        let crashed = subject(lastLaunch.bundleId)
        switch lastLaunch.kind {
        case .crashedBeforeContent:
            let target = name(lastLaunch.rolledBackToBundleId ?? selectedId ?? lastLaunch.bundleId)
            return Banner(text: "\(crashed) crashed before its first screen. The device rolled back to \(target).", offersReset: false)
        case .endedBeforeContent:
            let target = name(lastLaunch.rolledBackToBundleId ?? selectedId ?? lastLaunch.bundleId)
            return Banner(text: "\(crashed) didn't reach its first screen. The device rolled back to \(target).", offersReset: false)
        case .crashed:
            guard let selection, selection.bundleId != lastLaunch.bundleId else {
                let isBuiltIn = selection?.isBuiltIn == true
                return Banner(
                    text: "\(crashed) crashed on its last launch, and it's still selected.",
                    offersReset: !isBuiltIn
                )
            }
            return Banner(
                text: "\(crashed) crashed on its last launch. \(subject(selection.bundleId)) is selected now.",
                offersReset: false
            )
        }
    }

    private static func status(of phase: HotUpdaterSandboxPhase) -> Status? {
        switch phase {
        case .working(_, let target, let step, let progress):
            switch step {
            case .preflight, .check:
                return Status(text: "Checking \(target)…", progress: nil)
            case .reset:
                return Status(text: "Removing downloaded bundles…", progress: nil)
            case .download:
                let percent = Int((progress ?? 0) * 100)
                return Status(text: "Downloading \(target)… \(percent)%", progress: progress ?? 0)
            }
        case .waitingForServer(let link):
            return Status(
                text: "\(link.channel) needs an answer from your update server first. Open the app so it can check for updates.",
                progress: nil
            )
        default:
            return nil
        }
    }
}

/// What the build and the SDK's store hold, for the Info tab and the big row.
struct HotUpdaterSandboxDetails: Equatable {
    let builtInBundleId: String
    let fingerprintHash: String?
    /// A staged bundle no launch has verified yet.
    let pendingBundleId: String?
}

/// The Info tab's rows.
struct HotUpdaterSandboxInfoModel: Equatable {
    struct Row: Equatable {
        let name: String
        let value: String
    }

    let build: [Row]
    let bundle: [Row]

    init(
        state: HotUpdaterSandboxState,
        version: String,
        configuration: String,
        isOverApp: Bool = false,
        runningDevServerHost: String? = nil
    ) {
        let selection = state.selection
        let details = state.details
        build = [
            Row(name: "Version", value: version),
            Row(name: "Configuration", value: configuration),
            Row(name: "Fingerprint", value: details?.fingerprintHash.map(HotUpdaterSandboxHomeModel.shortId) ?? "None"),
            Row(name: "Built-in bundle", value: details.map { HotUpdaterSandboxHomeModel.shortId($0.builtInBundleId) } ?? ""),
            Row(name: "Default channel", value: selection?.defaultChannel ?? ""),
        ]
        let current: String
        if runningDevServerHost != nil {
            current = "Dev server"
        // Over the app, what it runs. Before it starts, what opens: the selection.
        } else if let shown = (isOverApp ? state.runningBundleId : nil) ?? selection?.bundleId {
            current = shown == details?.builtInBundleId ? "Built-in" : HotUpdaterSandboxHomeModel.shortId(shown)
        } else {
            current = ""
        }
        bundle = [
            Row(name: "Channel", value: selection?.channel ?? ""),
            Row(name: "Current", value: current),
            Row(name: "Pending", value: details?.pendingBundleId.map(HotUpdaterSandboxHomeModel.shortId) ?? "None"),
        ]
    }

    /// A license file's text as paragraphs that wrap to the screen: the file's
    /// hard line breaks and dashed rules go, and a heading in capitals keeps its
    /// own line.
    static func reflow(_ text: String) -> String {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var paragraphs: [String] = []
        var block: [String] = []
        func flush() {
            guard !block.isEmpty else { return }
            if block.count > 1, let first = block.first, first.lowercased() != first, first.uppercased() == first {
                paragraphs.append(first)
                block.removeFirst()
            }
            paragraphs.append(block.joined(separator: " "))
            block = []
        }
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                flush()
            } else if !trimmed.allSatisfy({ $0 == "-" }) {
                block.append(trimmed)
            }
        }
        flush()
        return paragraphs.joined(separator: "\n\n")
    }
}
#endif
