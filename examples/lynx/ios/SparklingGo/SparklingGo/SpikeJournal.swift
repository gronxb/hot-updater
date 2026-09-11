// Private G1 persistence. This journal is not the production catalog/installer.
import Darwin
import Foundation

struct SpikePending: Codable {
    let selection: [String: String]
    let attemptId: String
    let contextId: String
}

struct SpikeJournalState: Codable {
    var confirmed: [String: String]?
    var pending: SpikePending?
    var excludedReleaseIds: [String] = []
    var crashedBundleIds: [String] = []
    var incompatibleArtifacts: [String: String] = [:]
    var selectionRevision = 0
}

final class SpikeJournal {
    static let capacity = 128
    let file: URL
    private(set) var state: SpikeJournalState
    private(set) var recoveredReleaseId: String?

    init(home: URL, binaryHash: String, scope: String) throws {
        let scopeHash = SpikeArtifact.hash(Data(scope.utf8))
        file = home.appendingPathComponent("journal-\(binaryHash)-\(scopeHash).json")
        if FileManager.default.fileExists(atPath: file.path) {
            state = try JSONDecoder().decode(SpikeJournalState.self, from: Data(contentsOf: file))
        } else {
            state = SpikeJournalState()
        }
        guard state.excludedReleaseIds.count <= Self.capacity,
              state.incompatibleArtifacts.count <= Self.capacity else {
            throw SpikeAdmissionError.invalid("Journal capacity invariant violated")
        }
        if let pending = state.pending {
            guard let releaseId = pending.selection["releaseId"] else { throw SpikeAdmissionError.invalid("Invalid pending receipt") }
            if !state.excludedReleaseIds.contains(releaseId) {
                guard state.excludedReleaseIds.count < Self.capacity else { throw SpikeAdmissionError.invalid("No reserved recovery slot") }
                state.excludedReleaseIds.append(releaseId)
                state.selectionRevision += 1
            }
            state.pending = nil
            recoveredReleaseId = releaseId
            try save()
        }
    }

    func isEligible(_ selection: [String: String]) -> Bool {
        guard let release = selection["releaseId"], let bundle = selection["bundleId"] else { return false }
        return !state.excludedReleaseIds.contains(release) && !state.crashedBundleIds.contains(bundle)
    }

    func isConfirmed(_ selection: [String: String]) -> Bool {
        guard let current = state.confirmed else { return false }
        return current["releaseId"] == selection["releaseId"] && current["bundleId"] == selection["bundleId"]
            && current["manifestFileHash"] == selection["manifestFileHash"]
    }

    func canBegin(_ selection: [String: String]) -> Bool {
        selection["embedded"] == "true" || isConfirmed(selection) || state.excludedReleaseIds.count < Self.capacity
    }

    func begin(_ selection: [String: String], attemptId: String, contextId: String) throws {
        guard isEligible(selection), canBegin(selection) else { throw SpikeAdmissionError.invalid("Candidate excluded or capacity exhausted") }
        // Embedded bytes and already-confirmed selections are not new OTA trials.
        guard selection["embedded"] != "true", !isConfirmed(selection) else { return }
        guard state.pending == nil else { throw SpikeAdmissionError.invalid("A native primary attempt already exists") }
        state.pending = SpikePending(selection: selection, attemptId: attemptId, contextId: contextId)
        try save()
    }

    func confirm(_ selection: [String: String], attemptId: String, contextId: String) throws {
        guard isEligible(selection) else { throw SpikeAdmissionError.invalid("Release no longer eligible") }
        if let pending = state.pending {
            guard pending.attemptId == attemptId, pending.contextId == contextId,
                  pending.selection["releaseId"] == selection["releaseId"] else { throw SpikeAdmissionError.invalid("Stale startup confirmation") }
        } else if selection["embedded"] != "true" && !isConfirmed(selection) {
            throw SpikeAdmissionError.invalid("No pending startup attempt")
        }
        state.confirmed = selection
        state.pending = nil
        try save()
    }

    func fail(_ selection: [String: String], attemptId: String) throws {
        guard let bundleId = selection["bundleId"] else { throw SpikeAdmissionError.invalid("Missing failed Bundle ID") }
        state.crashedBundleIds.removeAll { $0 == bundleId }
        state.crashedBundleIds.append(bundleId)
        if state.crashedBundleIds.count > 10 { state.crashedBundleIds.removeFirst(state.crashedBundleIds.count - 10) }
        if state.pending?.attemptId == attemptId { state.pending = nil }
        state.selectionRevision += 1
        try save()
    }

    func rememberIncompatible(_ key: String, reason: String) throws {
        guard state.incompatibleArtifacts[key] != nil || state.incompatibleArtifacts.count < Self.capacity else {
            throw SpikeAdmissionError.invalid("Compatibility rejection cache full")
        }
        state.incompatibleArtifacts[key] = reason
        try save()
    }

    private func save() throws {
        let data = try JSONEncoder().encode(state)
        let temp = file.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temp) }
        try data.write(to: temp, options: .withoutOverwriting)
        let handle = try FileHandle(forWritingTo: temp)
        try handle.synchronize()
        try handle.close()
        guard rename(temp.path, file.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let directory = open(file.deletingLastPathComponent().path, O_RDONLY)
        guard directory >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(directory) }
        guard fsync(directory) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
}
