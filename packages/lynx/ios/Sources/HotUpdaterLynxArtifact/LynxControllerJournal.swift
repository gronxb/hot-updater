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
struct LynxControllerState: Codable {
    var revision = UUID().uuidString
    var selectionChannel: String?
    var selectionCohort: String?
    var confirmed: LynxStoredSelection?
    var next: LynxStoredSelection?
    var pending: LynxControllerPending?
    var unconfirmedReleaseIds: [String] = []
    var crashedBundleIds: [String] = []
    var incompatibleArtifacts: Set<String> = []
    var highWater: [String: LynxStoredHighWater] = [:]
    var catalogs: [String: Data] = [:]
    var installedDigests: [String: String] = [:]
}

// Save the next complete state before exposing it in memory. A failed write keeps
// the previous selection and leaves at most a complete, unselected immutable tree.
final class LynxControllerJournal {
    let file: URL
    init(file: URL) { self.file = file }
    func load() throws -> LynxControllerState {
        guard FileManager.default.fileExists(atPath: file.path) else { return LynxControllerState() }
        let bytes = try StrictMetadataJSON.read(file, limit: 24 * 1024 * 1024)
        let state = try JSONDecoder().decode(LynxControllerState.self, from: bytes)
        guard state.unconfirmedReleaseIds.count <= 128, state.crashedBundleIds.count <= 10,
              state.incompatibleArtifacts.count <= 128, state.highWater.count <= 32, state.catalogs.count <= 32 else {
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
        let descriptor = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
