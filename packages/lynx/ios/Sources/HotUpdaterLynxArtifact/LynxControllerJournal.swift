import Darwin
import Foundation

struct LynxStoredSelection: Codable {
    let receipt: Data
    let manifestDigest: String
    let rollbackFromSelection: Data?
    var policy: LynxPolicyReceipt {
        get throws {
            guard let object = try JSONSerialization.jsonObject(with: receipt) as? [String: Any] else { throw LynxArtifactError.invalid("Invalid native stored receipt") }
            return try LynxCatalogPolicy.parseReceipt(object)
        }
    }
    var rollback: LynxPolicyRollbackAuthorization? {
        get throws {
            guard let bytes = rollbackFromSelection, let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
            return .init(receipt: try policy, fromSelection: try LynxCatalogPolicy.parseReceipt(object))
        }
    }
    init(_ policy: LynxPolicyReceipt, manifestDigest: String, rollback: LynxPolicyRollbackAuthorization? = nil) throws {
        receipt = try JSONSerialization.data(withJSONObject: policy.dictionary, options: [.sortedKeys])
        self.manifestDigest = manifestDigest
        rollbackFromSelection = try rollback.map { try JSONSerialization.data(withJSONObject: $0.fromSelection.dictionary, options: [.sortedKeys]) }
    }
}
struct LynxControllerPending: Codable {
    let selection: LynxStoredSelection
    let attemptId: String
    let contextId: String
}
struct LynxStoredHighWater: Codable {
    let generation: Int64
    let hash: String
    var policy: LynxPolicyHighWater { .init(generation: generation, catalogHash: hash) }
}
struct LynxStoredCatalogAcceptance: Codable {
    let guardData: Data
    let explicitScopeSwitch: Bool
    var policyGuard: LynxPolicyGuard {
        get throws {
            guard let object = try JSONSerialization.jsonObject(with: guardData) as? [String: Any] else {
                throw LynxArtifactError.invalid("Invalid native stored catalog acceptance")
            }
            return try LynxCatalogPolicy.parseGuard(object)
        }
    }
    init(_ policyGuard: LynxPolicyGuard, explicitScopeSwitch: Bool) throws {
        guardData = try JSONSerialization.data(withJSONObject: policyGuard.dictionary, options: [.sortedKeys])
        self.explicitScopeSwitch = explicitScopeSwitch
    }
}
struct LynxStoredLaunchTransition: Codable {
    let kind: String
    let fromReceipt: Data
    let toReceipt: Data
    var policy: LynxLaunchTransition {
        get throws {
            guard ["UPDATE_APPLIED", "RECOVERED", "UNCHANGED"].contains(kind),
                  let fromObject = try JSONSerialization.jsonObject(with: fromReceipt) as? [String: Any],
                  let toObject = try JSONSerialization.jsonObject(with: toReceipt) as? [String: Any] else {
                throw LynxArtifactError.invalid("Invalid native launch transition")
            }
            let transition = LynxLaunchTransition(
                kind: kind,
                from: try LynxCatalogPolicy.parseReceipt(fromObject),
                to: try LynxCatalogPolicy.parseReceipt(toObject)
            )
            let identityChanged = transition.from.bundleId != transition.to.bundleId
                || transition.from.releaseId != transition.to.releaseId
            guard identityChanged,
                  kind != "UPDATE_APPLIED" || transition.from.bundleId != transition.to.bundleId,
                  kind != "UNCHANGED" || (
                    transition.from.bundleId == transition.to.bundleId
                        && transition.from.releaseId != nil
                        && transition.to.releaseId != nil
                        && transition.from.releaseId != transition.to.releaseId
                  ) else {
                throw LynxArtifactError.invalid("Invalid native launch transition identity")
            }
            return transition
        }
    }
    init(_ transition: LynxLaunchTransition) throws {
        kind = transition.kind
        fromReceipt = try JSONSerialization.data(withJSONObject: transition.from.dictionary, options: [.sortedKeys])
        toReceipt = try JSONSerialization.data(withJSONObject: transition.to.dictionary, options: [.sortedKeys])
    }
}
struct LynxControllerState: Codable {
    var revision = UUID().uuidString
    var selectionChannel: String?
    var selectionCohort: String?
    var confirmed: LynxStoredSelection?
    var next: LynxStoredSelection?
    var pending: LynxControllerPending?
    var unconfirmedReleaseIds: [String] = []
    var crashedBundleIds: [String] = []
    // Oldest first. Persisting the admission order lets a full cache evict one
    // entry without permanently denying future artifacts.
    var incompatibleArtifacts: [String] = []
    var highWater: [String: LynxStoredHighWater] = [:]
    var catalogs: [String: Data] = [:]
    var catalogAcceptances: [String: LynxStoredCatalogAcceptance]?
    var launchTransition: LynxStoredLaunchTransition?
    var installedDigests: [String: String] = [:]
}

// Save the next complete state before exposing it in memory. A failed write keeps
// the previous selection and leaves at most a complete, unselected immutable tree.
final class LynxControllerJournal {
    let file: URL
    private let synchronizeDirectory: (URL) throws -> Void
    init(file: URL) {
        self.file = file
        synchronizeDirectory = Self.syncDirectory
    }
    init(file: URL, synchronizeDirectory: @escaping (URL) throws -> Void) {
        self.file = file
        self.synchronizeDirectory = synchronizeDirectory
    }
    func load() throws -> LynxControllerState {
        guard FileManager.default.fileExists(atPath: file.path) else { return LynxControllerState() }
        let bytes = try StrictMetadataJSON.read(file, limit: 24 * 1024 * 1024)
        let state = try JSONDecoder().decode(LynxControllerState.self, from: bytes)
        guard state.unconfirmedReleaseIds.count <= 128, state.crashedBundleIds.count <= 10,
              state.incompatibleArtifacts.count <= 128, state.highWater.count <= 32, state.catalogs.count <= 32,
              (state.catalogAcceptances?.count ?? 0) <= 32 else {
            throw LynxArtifactError.invalid("Native journal capacity invariant violated")
        }
        return state
    }
    func save(_ state: LynxControllerState) throws {
        let bytes = try JSONEncoder().encode(state)
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".journal-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try bytes.write(to: temporary, options: .withoutOverwriting)
        let handle = try FileHandle(forWritingTo: temporary)
        try handle.synchronize(); try handle.close()
        guard rename(temporary.path, file.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        // Rename is the commit point. Once it succeeds, throwing would leave the
        // new disk state visible while the controller retains the old state.
        do {
            try synchronizeDirectory(file.deletingLastPathComponent())
        } catch {
            NSLog("[HotUpdaterLynx] Journal committed but directory sync failed: %@", error.localizedDescription)
        }
    }

    private static func syncDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
