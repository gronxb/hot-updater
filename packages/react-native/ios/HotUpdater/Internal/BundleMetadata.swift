import Foundation

// MARK: - BundleMetadata

/// Strategy used to derive update identities for OTA transitions.
public enum UpdateStrategy: String, Codable {
    case appVersion
    case fingerprint
}

public struct PendingBundleTransition: Codable {
    let fromBundleId: String
    let toBundleId: String
    let updateStrategy: UpdateStrategy

    init(fromBundleId: String, toBundleId: String, updateStrategy: UpdateStrategy) {
        self.fromBundleId = fromBundleId
        self.toBundleId = toBundleId
        self.updateStrategy = updateStrategy
    }
}

/// Bundle metadata for managing stable/staging bundles and verification state
public struct BundleMetadata: Codable {
    static let schemaVersion = "metadata-v1"
    static let metadataFilename = "metadata.json"

    let schema: String
    var isolationKey: String?
    var stableBundleId: String?
    var stagingBundleId: String?
    var verificationPending: Bool
    var pendingTransition: PendingBundleTransition?
    var updatedAt: Double

    enum CodingKeys: String, CodingKey {
        case schema
        case isolationKey = "isolation_key"
        case stableBundleId = "stable_bundle_id"
        case stagingBundleId = "staging_bundle_id"
        case verificationPending = "verification_pending"
        case pendingTransition = "pending_transition"
        case updatedAt = "updated_at"
    }

    init(
        schema: String = BundleMetadata.schemaVersion,
        isolationKey: String? = nil,
        stableBundleId: String? = nil,
        stagingBundleId: String? = nil,
        verificationPending: Bool = false,
        pendingTransition: PendingBundleTransition? = nil,
        updatedAt: Double = Date().timeIntervalSince1970 * 1000
    ) {
        self.schema = schema
        self.isolationKey = isolationKey
        self.stableBundleId = stableBundleId
        self.stagingBundleId = stagingBundleId
        self.verificationPending = verificationPending
        self.pendingTransition = pendingTransition
        self.updatedAt = updatedAt
    }

    static func load(from file: URL, expectedIsolationKey: String) -> BundleMetadata? {
        guard FileManager.default.fileExists(atPath: file.path) else {
            print("[BundleMetadata] Metadata file does not exist: \(file.path)")
            return nil
        }

        do {
            let data = try Data(contentsOf: file)
            let decoder = JSONDecoder()
            let metadata = try decoder.decode(BundleMetadata.self, from: data)

            // Validate isolation key
            if let metadataKey = metadata.isolationKey {
                if metadataKey != expectedIsolationKey {
                    print("[BundleMetadata] Isolation key mismatch: expected=\(expectedIsolationKey), got=\(metadataKey)")
                    return nil
                }
            } else {
                print("[BundleMetadata] Missing isolation key in metadata, treating as invalid")
                return nil
            }

            return metadata
        } catch {
            print("[BundleMetadata] Failed to load metadata from file: \(error)")
            return nil
        }
    }

    func save(to file: URL) -> Bool {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(self)

            // Create directory if needed
            let directory = file.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }

            try data.write(to: file)
            print("[BundleMetadata] Saved metadata to file: \(file.path)")
            return true
        } catch {
            print("[BundleMetadata] Failed to save metadata to file: \(error)")
            return false
        }
    }
}

// MARK: - CrashedBundleEntry

/// Entry for a crashed bundle in history
public struct CrashedBundleEntry: Codable {
    let bundleId: String
    var crashedAt: Double
    var crashCount: Int

    init(bundleId: String, crashedAt: Double = Date().timeIntervalSince1970 * 1000, crashCount: Int = 1) {
        self.bundleId = bundleId
        self.crashedAt = crashedAt
        self.crashCount = crashCount
    }
}

// MARK: - CrashedHistory

/// History of crashed bundles
public struct CrashedHistory: Codable {
    static let defaultMaxHistorySize = 10
    static let crashedHistoryFilename = "crashed-history.json"

    var bundles: [CrashedBundleEntry]
    var maxHistorySize: Int

    init(bundles: [CrashedBundleEntry] = [], maxHistorySize: Int = CrashedHistory.defaultMaxHistorySize) {
        self.bundles = bundles
        self.maxHistorySize = maxHistorySize
    }

    static func load(from file: URL) -> CrashedHistory {
        guard FileManager.default.fileExists(atPath: file.path) else {
            print("[CrashedHistory] Crashed history file does not exist, returning empty history")
            return CrashedHistory()
        }

        do {
            let data = try Data(contentsOf: file)
            let decoder = JSONDecoder()
            let history = try decoder.decode(CrashedHistory.self, from: data)
            return history
        } catch {
            print("[CrashedHistory] Failed to load crashed history from file: \(error)")
            return CrashedHistory()
        }
    }

    func save(to file: URL) -> Bool {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(self)

            // Create directory if needed
            let directory = file.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }

            try data.write(to: file)
            print("[CrashedHistory] Saved crashed history to file: \(file.path)")
            return true
        } catch {
            print("[CrashedHistory] Failed to save crashed history to file: \(error)")
            return false
        }
    }

    func contains(_ bundleId: String) -> Bool {
        return bundles.contains { $0.bundleId == bundleId }
    }

    mutating func addEntry(_ bundleId: String) {
        if let index = bundles.firstIndex(where: { $0.bundleId == bundleId }) {
            // Update existing entry
            bundles[index].crashedAt = Date().timeIntervalSince1970 * 1000
            bundles[index].crashCount += 1
        } else {
            // Add new entry
            bundles.append(CrashedBundleEntry(bundleId: bundleId))
        }

        // Trim to max size (keep most recent)
        if bundles.count > maxHistorySize {
            bundles.sort { $0.crashedAt < $1.crashedAt }
            bundles = Array(bundles.suffix(maxHistorySize))
        }
    }

    mutating func clear() {
        bundles.removeAll()
    }
}

public struct PendingCrashRecovery {
    let launchedBundleId: String?
    let shouldRollback: Bool

    static func from(json: [String: Any]) -> PendingCrashRecovery {
        PendingCrashRecovery(
            launchedBundleId: (json["bundleId"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            shouldRollback: json["shouldRollback"] as? Bool ?? false
        )
    }
}

public struct LaunchSelection {
    let bundleURL: URL?
    let launchedBundleId: String?
    let shouldRollbackOnCrash: Bool
}

public enum LaunchReportStatus: String, Codable {
    case unchanged = "UNCHANGED"
    case updateApplied = "UPDATE_APPLIED"
    case recovered = "RECOVERED"
}

public struct LaunchReport: Codable {
    static let launchReportFilename = "launch-report.json"

    let status: LaunchReportStatus
    let fromBundleId: String?
    let toBundleId: String?
    let updateStrategy: UpdateStrategy?

    init(
        status: LaunchReportStatus = .unchanged,
        fromBundleId: String? = nil,
        toBundleId: String? = nil,
        updateStrategy: UpdateStrategy? = nil
    ) {
        self.status = status
        self.fromBundleId = fromBundleId
        self.toBundleId = toBundleId
        self.updateStrategy = updateStrategy
    }

    static func load(from file: URL) -> LaunchReport? {
        guard FileManager.default.fileExists(atPath: file.path) else {
            return nil
        }

        do {
            let data = try Data(contentsOf: file)
            return try JSONDecoder().decode(LaunchReport.self, from: data)
        } catch {
            print("[LaunchReport] Failed to load launch report: \(error)")
            return nil
        }
    }

    func save(to file: URL) -> Bool {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(self)
            let directory = file.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            try data.write(to: file)
            return true
        } catch {
            print("[LaunchReport] Failed to save launch report: \(error)")
            return false
        }
    }
}

public struct InstallIdentity: Codable {
    static let installIdentityFilename = "install-identity.json"

    let installId: String

    init(installId: String = UUID().uuidString) {
        self.installId = installId
    }

    static func load(from file: URL) -> InstallIdentity? {
        guard FileManager.default.fileExists(atPath: file.path) else {
            return nil
        }

        do {
            let data = try Data(contentsOf: file)
            let identity = try JSONDecoder().decode(InstallIdentity.self, from: data)
            return identity.installId.isEmpty ? nil : identity
        } catch {
            print("[InstallIdentity] Failed to load install identity: \(error)")
            return nil
        }
    }

    func save(to file: URL) -> Bool {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(self)
            let directory = file.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            try data.write(to: file)
            return true
        } catch {
            print("[InstallIdentity] Failed to save install identity: \(error)")
            return false
        }
    }
}

public struct UserIdentity: Codable {
    static let userIdentityFilename = "user-identity.json"

    let userId: String?
    let username: String?

    init(userId: String?, username: String?) {
        self.userId = userId
        self.username = username
    }

    var isEmpty: Bool {
        userId == nil && username == nil
    }

    static func load(from file: URL) -> UserIdentity? {
        guard FileManager.default.fileExists(atPath: file.path) else {
            return nil
        }

        do {
            let data = try Data(contentsOf: file)
            let identity = try JSONDecoder().decode(UserIdentity.self, from: data)
            return identity.isEmpty ? nil : identity
        } catch {
            print("[UserIdentity] Failed to load user identity: \(error)")
            return nil
        }
    }

    func save(to file: URL) -> Bool {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(self)
            let directory = file.deletingLastPathComponent()
            if !FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            try data.write(to: file)
            return true
        } catch {
            print("[UserIdentity] Failed to save user identity: \(error)")
            return false
        }
    }
}
