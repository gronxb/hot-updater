#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// The crash marker as this process found it, before settling consumed it. A
/// crash writes one. A launch the system killed, or a person left, doesn't.
struct HotUpdaterSandboxCrashMarker: Equatable {
    /// The built-in bundle's ID when the marker names no bundle.
    let bundleId: String
    let shouldRollback: Bool
}

/// The rollback the SDK's launch report states, the only proof that one happened.
struct HotUpdaterSandboxRollback: Equatable {
    let fromBundleId: String
    let toBundleId: String
}

struct HotUpdaterSandboxLaunchEvidence: Equatable {
    var marker: HotUpdaterSandboxCrashMarker?
    var rollback: HotUpdaterSandboxRollback?
}

/// What the last launch left: from the settled transition and the resulting
/// selection, never from a change in the crash history's IDs.
struct HotUpdaterSandboxLastLaunch: Equatable, Codable {
    enum Kind: String, Codable {
        /// It crashed before first content, and the device rolled back.
        case crashedBeforeContent
        /// It ended before first content with no crash: the device rolled back,
        /// and the cause is unknown. A person left, or the app hung.
        case endedBeforeContent
        /// It crashed and nothing rolled back, such as after first content
        /// verified it. A verified bundle stays selected.
        case crashed
    }

    let kind: Kind
    let bundleId: String
    /// Where a rollback went, only when one happened.
    let rolledBackToBundleId: String?

    static func derive(
        evidence: HotUpdaterSandboxLaunchEvidence,
        launchBundleId: String
    ) -> HotUpdaterSandboxLastLaunch? {
        // A rollback is claimed only when the report and what this launch runs agree.
        if let rollback = evidence.rollback, rollback.toBundleId == launchBundleId {
            return HotUpdaterSandboxLastLaunch(
                kind: evidence.marker?.bundleId == rollback.fromBundleId ? .crashedBeforeContent : .endedBeforeContent,
                bundleId: rollback.fromBundleId,
                rolledBackToBundleId: rollback.toBundleId
            )
        }
        guard let marker = evidence.marker else { return nil }
        return HotUpdaterSandboxLastLaunch(kind: .crashed, bundleId: marker.bundleId, rolledBackToBundleId: nil)
    }
}
#endif
