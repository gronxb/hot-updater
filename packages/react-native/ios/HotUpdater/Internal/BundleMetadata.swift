import Foundation

// MARK: - BundleMetadata

/// Bundle metadata for managing stable/staging bundles and verification state
public struct BundleMetadata: Codable {
    static let schemaVersion = "metadata-v1"
    static let metadataFilename = "metadata.json"

    let schema: String
    var stableBundleId: String?
    var stagingBundleId: String?
    var verificationPending: Bool
    var verificationAttemptedAt: Double?
    var stagingExecutionCount: Int?
    var updatedAt: Double

    enum CodingKeys: String, CodingKey {
        case schema
        case stableBundleId = "stable_bundle_id"
        case stagingBundleId = "staging_bundle_id"
        case verificationPending = "verification_pending"
        case verificationAttemptedAt = "verification_attempted_at"
        case stagingExecutionCount = "staging_execution_count"
        case updatedAt = "updated_at"
    }

    init(
        schema: String = BundleMetadata.schemaVersion,
        stableBundleId: String? = nil,
        stagingBundleId: String? = nil,
        verificationPending: Bool = false,
        verificationAttemptedAt: Double? = nil,
        stagingExecutionCount: Int? = nil,
        updatedAt: Double = Date().timeIntervalSince1970 * 1000
    ) {
        self.schema = schema
        self.stableBundleId = stableBundleId
        self.stagingBundleId = stagingBundleId
        self.verificationPending = verificationPending
        self.verificationAttemptedAt = verificationAttemptedAt
        self.stagingExecutionCount = stagingExecutionCount
        self.updatedAt = updatedAt
    }

    static func load(from file: URL) -> BundleMetadata? {
        guard FileManager.default.fileExists(atPath: file.path) else {
            print("[BundleMetadata] Metadata file does not exist: \(file.path)")
            return nil
        }

        do {
            let data = try Data(contentsOf: file)
            let decoder = JSONDecoder()
            let metadata = try decoder.decode(BundleMetadata.self, from: data)
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
