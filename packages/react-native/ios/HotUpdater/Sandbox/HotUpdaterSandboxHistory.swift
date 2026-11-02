#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// A preview this device opened. Local memory, so it can be stale: it says what
/// was opened, not what the server has now.
struct HotUpdaterSandboxHistoryEntry: Equatable, Codable {
    let channel: String
    let bundleId: String
    /// The deploy message of `bundleId`, when this device saw one.
    let message: String?
    let openedAtMs: Double
}

/// A deploy message, kept with its bundle: a channel's next bundle says something else.
struct HotUpdaterSandboxBundleMessage: Equatable, Codable {
    let bundleId: String
    let message: String
}

enum HotUpdaterSandboxHistory {
    static let limit = 10
    private static let messageLimit = 20
    private static let dayMs = 86_400_000.0

    /// Newest first, one entry per channel, at most `limit`.
    static func adding(
        _ entry: HotUpdaterSandboxHistoryEntry,
        to history: [HotUpdaterSandboxHistoryEntry]
    ) -> [HotUpdaterSandboxHistoryEntry] {
        Array(([entry] + history.filter { $0.channel != entry.channel }).prefix(limit))
    }

    static func remembering(
        _ message: HotUpdaterSandboxBundleMessage,
        in messages: [HotUpdaterSandboxBundleMessage]
    ) -> [HotUpdaterSandboxBundleMessage] {
        Array(([message] + messages.filter { $0.bundleId != message.bundleId }).prefix(messageLimit))
    }

    static func openedText(openedAtMs: Double, nowMs: Double) -> String {
        let days = Int(max(0, nowMs - openedAtMs) / dayMs)
        switch days {
        case 0:
            return "Opened today"
        case 1:
            return "Opened yesterday"
        default:
            return "Opened \(days) days ago"
        }
    }
}
#endif
