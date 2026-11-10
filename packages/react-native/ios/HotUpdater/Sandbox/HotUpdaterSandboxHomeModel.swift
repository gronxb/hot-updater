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
        /// A stored bundle runs: a row under it goes back to the current bundle.
        var showsBack = false
        /// Over the app, the reload runs the selection in place of what runs, so
        /// the row shows Open's icon.
        var opensSelection = false
    }

    /// A row of the Downloaded list.
    struct Downloaded: Equatable {
        let bundleId: String
        let channel: String
        let message: String?
        let detail: String
        let isRunning: Bool
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
    let downloaded: [Downloaded]
    /// The count and size, or what the list is for while it's empty.
    let downloadedFooter: String
    /// Before a server answered, what previews wait for.
    let previewHint: String?

    static let hint = "Shake the device to come back here."
    /// A typed channel doesn't ask first, so this says it up front.
    static let switchNote = "Opening a channel runs its latest bundle. Downloaded bundles stay listed."
    static let resetNote = "Removes the channel switch. Downloaded bundles stay listed."
    static let emptyDownloaded = "Bundles you open from a QR code, a link, or a channel stay here."

    init(
        state: HotUpdaterSandboxState,
        isOverApp: Bool,
        runningDevServerHost: String? = nil,
        nowMs: Double
    ) {
        let history = state.downloaded
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
        downloaded = history.map {
            Downloaded(
                bundleId: $0.bundleId,
                channel: $0.channel,
                message: $0.message,
                detail: "Bundle \(Self.shortId($0.shownId)) · \(Self.downloadedText(atMs: $0.downloadedAtMs, nowMs: nowMs))",
                isRunning: $0.bundleId == state.storedSessionBundleId
            )
        }
        downloadedFooter = history.isEmpty
            ? Self.emptyDownloaded
            : "\(history.count) of \(HotUpdaterSandboxShelf.limit)" + (state.downloadedBytes > 0 ? " · \(Self.sizeText(state.downloadedBytes))" : "")
        previewHint = state.hasServerConfig
            ? nil
            : "No update server yet. Channels open after the app's first update check."
    }

    static func downloadedText(atMs: Double, nowMs: Double) -> String {
        let minutes = Int(max(0, nowMs - atMs) / 60_000)
        switch minutes {
        case 0: return "downloaded just now"
        case ..<60: return "downloaded \(minutes) min ago"
        case ..<1440: return "downloaded \(minutes / 60) h ago"
        case ..<2880: return "downloaded 1 day ago"
        default: return "downloaded \(minutes / 1440) days ago"
        }
    }

    /// Decimal units, as the system shows file sizes.
    static func sizeText(_ bytes: Int64) -> String {
        if bytes < 1_000_000 { return "\(max(1, bytes / 1000)) KB" }
        let megabytes = Double(bytes) / 1_000_000
        return megabytes < 10 ? String(format: "%.1f MB", megabytes) : "\(Int(megabytes.rounded())) MB"
    }

    /// The channel of a stored bundle this device downloaded.
    private static func channel(of bundleId: String?, in history: [HotUpdaterSandboxShelfEntry]) -> String? {
        history.first { $0.bundleId == bundleId }?.channel
    }

    /// What the list calls a stored bundle: its release's ID when it was kept.
    static func shownId(of bundleId: String, in history: [HotUpdaterSandboxShelfEntry]) -> String {
        history.first { $0.bundleId == bundleId }?.shownId ?? bundleId
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
        if let stored = state.storedSessionBundleId {
            let channel = channel(of: stored, in: state.downloaded).map { " \($0)" } ?? ""
            // Its deploy message, as a running row shows one, or its bundle.
            let message = state.downloaded.first { $0.bundleId == stored }?.message
            return BigRow(
                caption: "Running",
                title: "Reload",
                subtitle: "Running stored\(channel)",
                detail: message ?? "Bundle \(shortId(shownId(of: stored, in: state.downloaded)))",
                isReload: true,
                showsBack: true
            )
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
        // The built-in bundle is next and another runs: the reload opens it.
        if next.isBuiltIn {
            return BigRow(
                caption: "Current bundle",
                title: "Open built-in bundle",
                subtitle: "The bundle this build shipped with",
                detail: "Running bundle \(shortId(running))",
                isReload: true,
                opensSelection: true
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
        history: [HotUpdaterSandboxShelfEntry]
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
        } else if let stored = state.storedSessionBundleId {
            current = "Stored \(HotUpdaterSandboxHomeModel.shortId(HotUpdaterSandboxHomeModel.shownId(of: stored, in: state.downloaded)))"
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

/// What a phase asks, in the same words on every screen that asks it.
struct HotUpdaterSandboxQuestion: Equatable {
    enum Kind: Equatable {
        case confirm, refused, failed
    }

    let kind: Kind
    let title: String
    let message: String
    let accept: String
    let decline: String?

    /// `isOverApp`: whether a bundle runs behind the screen for a link to replace.
    init?(phase: HotUpdaterSandboxPhase, isOverApp: Bool) {
        switch phase {
        case .confirming(let link):
            kind = .confirm
            title = "Open latest on \(link.channel)?"
            message = isOverApp
                ? "This replaces the running bundle. Downloaded bundles stay listed."
                : HotUpdaterSandboxHomeModel.switchNote
            accept = "Open latest"
            decline = "Cancel"
        case .refused(let refusal):
            kind = .refused
            switch refusal {
            case .unreadable:
                title = "This link can't be read"
                message = "It isn't a link for this app."
            case .invalidChannel(let channel):
                title = "That isn't a channel name"
                message = "Check \"\(channel)\" and try again."
            case .otherFingerprint(let link, _):
                title = "\(link.channel) needs another build"
                message = "Its native code differs from this build. Install the sandbox build for that fingerprint."
            }
            accept = "OK"
            decline = nil
        case .failed(_, let target, _, let failure, let selection):
            kind = .failed
            let reason: String
            switch failure {
            case .noBundle: reason = "\(target) has no bundle for this build."
            case .resetFailed: reason = "Downloaded bundles couldn't be removed."
            case .superseded: reason = "Another update check changed the selection first."
            case .inStoredSession: reason = "A stored bundle is running. Go back to the current bundle, then try again."
            case .error(let text): reason = text
            }
            let bundle = selection.isBuiltIn ? "built-in bundle" : "bundle \(selection.bundleId)"
            title = "Couldn't open \(target)"
            message = "\(reason)\n\nSelected now: \(selection.channel), \(bundle)."
            accept = failure == .inStoredSession ? "Back" : "Retry"
            decline = "Close"
        default:
            return nil
        }
    }
}

/// Camera access as the system reports it.
enum HotUpdaterSandboxCameraAccess: Equatable {
    case undetermined, allowed, denied, restricted
}

/// What the QR scanner's sheet shows for the camera access it has.
enum HotUpdaterSandboxScannerContent: Equatable {
    /// The system is asking for access.
    case waiting
    case camera
    /// A line in place of the camera, and whether Settings can change it: a person
    /// can turn access back on there, but not lift a restriction a parent or an
    /// organization set.
    case message(String, opensSettings: Bool)

    /// `problem`: why an allowed camera can't scan, such as a simulator's missing one.
    init(access: HotUpdaterSandboxCameraAccess, problem: String? = nil) {
        switch access {
        case .undetermined:
            self = .waiting
        case .allowed:
            self = problem.map { .message($0, opensSettings: false) } ?? .camera
        case .denied:
            self = .message("Allow camera access to scan QR codes.", opensSettings: true)
        case .restricted:
            self = .message("Camera access is restricted on this device.", opensSettings: false)
        }
    }
}
#endif
