import CoreFoundation
import CryptoKit
import Darwin
import Foundation

func hotUpdaterJSONValue<T>(_ value: T?) -> Any {
    value ?? NSNull()
}

#if HOT_UPDATER_LYNX_DIAGNOSTICS
func hotUpdaterDiagnosticRuntimeEventDetails(
    _ extra: [String: Any] = [:]
) -> [String: Any] {
    [
        "runtimeId": "diagnostic-runtime",
        "processId": "1",
        "generationId": "diagnostic-generation",
        "bundleId": "diagnostic-bundle",
        "releaseId": NSNull(),
        "contextId": NSNull(),
        "pageAttemptId": NSNull(),
        "transitionId": NSNull(),
        "identitySource": "synthetic-fixture",
    ].merging(extra) { _, new in new }
}
#endif

final class SparklingGenerationEventJournal {
    static let capacity = 256
    static let maximumEventNameBytes = 128
    static let maximumDetailsBytes = 64 * 1_024
    static let maximumSerializedFileBytes = 16 * 1_024 * 1_024
    static let repairedHistory = Data(
        "{\"events\":[],\"nextSequence\":\"1\",\"schemaVersion\":1,\"truncated\":true}".utf8
    )
    private static let managedEventNames: Set<String> = [
        "firstContent", "generationFailed", "generationReconstructionFailed",
        "generationRetired", "generationStarted", "generationWillEvaluate",
        "generationWillRetire", "jsReady",
        "fontLoaded", "imageLoaded", "nativeBack", "pageAdmitted",
        "pageAttemptTerminal", "pageClosed", "pageOpened",
        "resourceFailed", "resourceLeaseAcquired", "resourceLeaseReleased",
        "resourceLoaded", "runtimeFailed", "runtimeWarning", "scriptLoaded",
        "staleContentRejected", "staleContextRejected",
        "staleRecoveryRejected", "staleReloadRejected", "transitionAccepted",
    ]

    enum Unavailable: Error, LocalizedError, Equatable {
        case corruptHistory
        case persistenceFailed
        case invalidEvent

        var errorDescription: String? {
            switch self {
            case .corruptHistory:
                return "Runtime event history is corrupt"
            case .persistenceFailed:
                return "Runtime event history could not be persisted"
            case .invalidEvent:
                return "Runtime event could not be serialized"
            }
        }
    }

    private struct StoredEvent {
        let sequence: String
        let name: String
        let details: [String: Any]
        let canonicalDetails: Data
    }

    private struct StoredJournal {
        var nextSequence = "1"
        var truncated = false
        var events: [StoredEvent] = []
    }

    private let file: URL?
    private let serializedFileByteLimit: Int
    private let directorySynchronizer: ((URL) throws -> Void)?
    private let lock = NSLock()
    private var state = StoredJournal()
    private var unavailable: Unavailable?
    private var diagnosticsBackup: Data?

    init(
        file: URL? = nil,
        serializedFileByteLimit: Int = maximumSerializedFileBytes,
        directorySynchronizer: ((URL) throws -> Void)? = nil
    ) {
        precondition(serializedFileByteLimit > 0)
        self.file = file
        self.serializedFileByteLimit = serializedFileByteLimit
        self.directorySynchronizer = directorySynchronizer
        guard let file,
              FileManager.default.fileExists(atPath: file.path) else {
            return
        }
        do {
            let attributes = try FileManager.default.attributesOfItem(
                atPath: file.path
            )
            guard let fileSize = attributes[.size] as? NSNumber,
                  fileSize.intValue <= serializedFileByteLimit else {
                throw Unavailable.corruptHistory
            }
            let data = try Data(contentsOf: file)
            guard data.count <= serializedFileByteLimit else {
                throw Unavailable.corruptHistory
            }
            state = try Self.decode(data)
        } catch {
            state = StoredJournal(truncated: true)
            guard let repair = try? Self.encode(state),
                  repair == Self.repairedHistory,
                  repair.count <= serializedFileByteLimit,
                  persist(repair) else {
                unavailable = .persistenceFailed
                return
            }
        }
    }

    @discardableResult
    func append(name: String, details: [String: Any]) -> Bool {
        guard !name.isEmpty,
              name.utf8.count <= Self.maximumEventNameBytes,
              let canonicalDetails = try? Self.canonicalData(details),
              canonicalDetails.count <= Self.maximumDetailsBytes,
              let ownedDetails = try? JSONSerialization.jsonObject(
                  with: canonicalDetails
              ) as? [String: Any],
              !Self.managedEventNames.contains(name)
                || Self.validManagedIdentity(ownedDetails) else {
            return false
        }
        lock.lock()
        defer { lock.unlock() }
        guard unavailable == nil,
              let followingSequence = Self.increment(state.nextSequence)
        else { return false }

        var next = state
        next.events.append(StoredEvent(
            sequence: next.nextSequence,
            name: name,
            details: ownedDetails,
            canonicalDetails: canonicalDetails
        ))
        next.nextSequence = followingSequence
        if next.events.count > Self.capacity {
            next.events.removeFirst(next.events.count - Self.capacity)
            next.truncated = true
        }

        var serialized: Data
        while true {
            guard let candidate = try? Self.encode(next) else { return false }
            if candidate.count <= serializedFileByteLimit {
                serialized = candidate
                break
            }
            guard next.events.count > 1 else { return false }
            next.events.removeFirst()
            next.truncated = true
        }
        guard persist(serialized) else { return false }
        state = next
        return true
    }

    func snapshot() throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        if let unavailable { throw unavailable }
        let events: [[String: Any]] = try state.events.map { event in
            guard let details = try JSONSerialization.jsonObject(
                with: event.canonicalDetails
            ) as? [String: Any] else {
                throw Unavailable.corruptHistory
            }
            return [
                "sequence": event.sequence,
                "name": event.name,
                "details": details,
            ]
        }
        return [
            "schemaVersion": 1,
            "oldestSequence": state.events.first?.sequence ?? NSNull(),
            "latestSequence": state.events.last?.sequence ?? NSNull(),
            "truncated": state.truncated,
            "events": events,
        ]
    }

    func containsPageAttemptTerminal(_ attemptId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard unavailable == nil else { return false }
        return state.events.contains { event in
            event.name == "pageAttemptTerminal"
                && event.details["pageAttemptId"] as? String == attemptId
        }
    }

#if HOT_UPDATER_LYNX_DIAGNOSTICS
    func installDiagnosticsFixture(_ mode: String) throws {
        try captureDiagnosticsBackupIfNeeded()
        switch mode {
        case "corrupt-json":
            try installRawDiagnosticsFixture(Data("{".utf8))
            try reopenDiagnosticsFixture()
        case "noncanonical":
            try installRawDiagnosticsFixture(Data(
                "{ \"schemaVersion\": 1, \"nextSequence\": \"1\", \"truncated\": false, \"events\": [] }".utf8
            ))
            try reopenDiagnosticsFixture()
        case "already-oversized":
            try installRawDiagnosticsFixture(Data(
                count: Self.maximumSerializedFileBytes + 1
            ))
            try reopenDiagnosticsFixture()
        case "retention-limit":
            try installDiagnosticsEvents(
                count: Self.capacity,
                fixture: "retention"
            )
        case "count-plus-one":
            try installDiagnosticsEvents(
                count: Self.capacity + 1,
                fixture: "count"
            )
        case "byte-plus-one":
            try installBytePlusOneDiagnosticsFixture()
        default:
            throw Unavailable.invalidEvent
        }
    }

    func reopenDiagnosticsFixture() throws {
        lock.lock()
        defer { lock.unlock() }
        guard let file else { throw Unavailable.persistenceFailed }
        do {
            let attributes = try FileManager.default.attributesOfItem(
                atPath: file.path
            )
            guard let size = attributes[.size] as? NSNumber,
                  size.intValue <= serializedFileByteLimit else {
                throw Unavailable.corruptHistory
            }
            let data = try Data(contentsOf: file)
            guard data.count <= serializedFileByteLimit else {
                throw Unavailable.corruptHistory
            }
            state = try Self.decode(data)
            unavailable = nil
        } catch {
            let repaired = StoredJournal(truncated: true)
            let bytes = try Self.encode(repaired)
            guard persist(bytes) else {
                unavailable = .persistenceFailed
                throw Unavailable.persistenceFailed
            }
            state = repaired
            unavailable = nil
        }
    }

    func restoreDiagnosticsFixture() throws {
        lock.lock()
        defer { lock.unlock() }
        let bytes = diagnosticsBackup ?? (try Self.encode(StoredJournal()))
        diagnosticsBackup = nil
        guard persist(bytes) else { throw Unavailable.persistenceFailed }
        state = (try? Self.decode(bytes)) ?? StoredJournal()
        unavailable = nil
    }

    private func captureDiagnosticsBackupIfNeeded() throws {
        guard diagnosticsBackup == nil else { return }
        if let file, FileManager.default.fileExists(atPath: file.path) {
            diagnosticsBackup = try Data(contentsOf: file)
        } else {
            diagnosticsBackup = try Self.encode(StoredJournal())
        }
    }

    private func resetDiagnosticsJournalPreservingBackup() throws {
        lock.lock()
        defer { lock.unlock() }
        let clean = StoredJournal()
        let bytes = try Self.encode(clean)
        guard persist(bytes) else { throw Unavailable.persistenceFailed }
        state = clean
        unavailable = nil
    }

    func diagnosticsReceipt() throws -> [String: Any] {
        let snapshot = try snapshot()
        guard let file else { throw Unavailable.persistenceFailed }
        let data = try Data(contentsOf: file)
        return [
            "processId": String(ProcessInfo.processInfo.processIdentifier),
            "snapshot": snapshot,
            "byteLength": data.count,
            "sha256": SHA256.hash(data: data).map {
                String(format: "%02x", $0)
            }.joined(),
            "canonicalUtf8": data.count <= 1_024
                ? String(data: data, encoding: .utf8) ?? NSNull()
                : NSNull(),
        ]
    }

    private func installRawDiagnosticsFixture(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let file else { throw Unavailable.persistenceFailed }
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: file, options: .atomic)
        unavailable = .corruptHistory
    }

    private func installDiagnosticsEvents(count: Int, fixture: String) throws {
        try resetDiagnosticsJournalPreservingBackup()
        for _ in 1...count {
            guard append(
                name: "retentionFixture",
                details: hotUpdaterDiagnosticRuntimeEventDetails([
                    "fixture": fixture,
                ])
            ) else {
                throw Unavailable.persistenceFailed
            }
        }
    }

    private func installBytePlusOneDiagnosticsFixture() throws {
        let emptyOverhead = try Self.canonicalData(
            hotUpdaterDiagnosticRuntimeEventDetails(["payload": ""])
        ).count
        var payloadCounts = Array(
            repeating: Self.maximumDetailsBytes - emptyOverhead,
            count: Self.capacity
        )
        func fixture(_ counts: [Int]) throws -> StoredJournal {
            var events: [StoredEvent] = []
            for (offset, count) in counts.enumerated() {
                let details = hotUpdaterDiagnosticRuntimeEventDetails([
                    "payload": String(repeating: "x", count: count),
                ])
                let canonical = try Self.canonicalData(details)
                events.append(.init(
                    sequence: String(offset + 1),
                    name: "fixture",
                    details: details,
                    canonicalDetails: canonical
                ))
            }
            return StoredJournal(
                nextSequence: String(Self.capacity + 1),
                truncated: false,
                events: events
            )
        }
        var candidate = try fixture(payloadCounts)
        var excess = try Self.encode(candidate).count
            - (Self.maximumSerializedFileBytes + 1)
        guard excess >= 0 else { throw Unavailable.invalidEvent }
        for index in payloadCounts.indices.reversed() where excess > 0 {
            let reduction = min(payloadCounts[index], excess)
            payloadCounts[index] -= reduction
            excess -= reduction
        }
        candidate = try fixture(payloadCounts)
        guard try Self.encode(candidate).count
                == Self.maximumSerializedFileBytes + 1 else {
            throw Unavailable.invalidEvent
        }
        candidate.events.removeFirst()
        candidate.truncated = true
        let persisted = try Self.encode(candidate)
        guard persisted.count <= Self.maximumSerializedFileBytes else {
            throw Unavailable.invalidEvent
        }
        lock.lock()
        defer { lock.unlock() }
        guard persist(persisted) else { throw Unavailable.persistenceFailed }
        state = candidate
        unavailable = nil
    }
#endif

    private func persist(_ data: Data) -> Bool {
        guard let file else { return true }
        guard data.count <= serializedFileByteLimit else { return false }
        let directory = file.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(
            ".generation-events-\(UUID().uuidString)"
        )
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            try data.write(to: temporary, options: .withoutOverwriting)
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.synchronize()
            try handle.close()
            guard rename(temporary.path, file.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            // Rename is the commit point. A later directory-sync failure must
            // not leave memory behind the new envelope already visible on disk.
            do {
                if let directorySynchronizer {
                    try directorySynchronizer(directory)
                } else {
                    let descriptor = Darwin.open(directory.path, O_RDONLY)
                    guard descriptor >= 0 else {
                        throw POSIXError(
                            POSIXErrorCode(rawValue: errno) ?? .EIO
                        )
                    }
                    defer { Darwin.close(descriptor) }
                    guard fsync(descriptor) == 0 else {
                        throw POSIXError(
                            POSIXErrorCode(rawValue: errno) ?? .EIO
                        )
                    }
                }
            } catch {
                NSLog(
                    "[HotUpdaterLynx] Runtime event journal committed but directory sync failed: %@",
                    error.localizedDescription
                )
            }
            return true
        } catch { return false }
    }

    private static func decode(_ data: Data) throws -> StoredJournal {
        guard let envelope = try JSONSerialization.jsonObject(with: data)
                as? [String: Any],
              Set(envelope.keys) == Set([
                  "events", "nextSequence", "schemaVersion", "truncated",
              ]),
              let schemaVersion = envelope["schemaVersion"] as? NSNumber,
              CFGetTypeID(schemaVersion) != CFBooleanGetTypeID(),
              schemaVersion.intValue == 1,
              schemaVersion.doubleValue == 1,
              let nextSequence = envelope["nextSequence"] as? String,
              validSequence(nextSequence),
              let truncatedNumber = envelope["truncated"] as? NSNumber,
              CFGetTypeID(truncatedNumber) == CFBooleanGetTypeID(),
              let rawEvents = envelope["events"] as? [Any],
              rawEvents.count <= capacity else {
            throw Unavailable.corruptHistory
        }

        var events: [StoredEvent] = []
        var previous: String?
        for rawEvent in rawEvents {
            guard let event = rawEvent as? [String: Any],
                  Set(event.keys) == Set(["sequence", "name", "details"]),
                  let sequence = event["sequence"] as? String,
                  validSequence(sequence),
                  let name = event["name"] as? String,
                  !name.isEmpty,
                  name.utf8.count <= maximumEventNameBytes,
                  let details = event["details"] as? [String: Any],
                  !managedEventNames.contains(name)
                    || validManagedIdentity(details),
                  let canonicalDetails = try? canonicalData(details),
                  canonicalDetails.count <= maximumDetailsBytes,
                  previous.map({ increment($0) == sequence }) ?? true else {
                throw Unavailable.corruptHistory
            }
            events.append(StoredEvent(
                sequence: sequence,
                name: name,
                details: details,
                canonicalDetails: canonicalDetails
            ))
            previous = sequence
        }
        if let last = events.last {
            guard increment(last.sequence) == nextSequence else {
                throw Unavailable.corruptHistory
            }
        } else {
            guard nextSequence == "1" else {
                throw Unavailable.corruptHistory
            }
        }
        if !truncatedNumber.boolValue,
           let first = events.first,
           first.sequence != "1" {
            throw Unavailable.corruptHistory
        }

        let stored = StoredJournal(
            nextSequence: nextSequence,
            truncated: truncatedNumber.boolValue,
            events: events
        )
        guard try encode(stored) == data else {
            throw Unavailable.corruptHistory
        }
        return stored
    }

    private static func encode(_ state: StoredJournal) throws -> Data {
        try canonicalData([
            "events": state.events.map { event in
                [
                    "sequence": event.sequence,
                    "name": event.name,
                    "details": event.details,
                ] as [String: Any]
            },
            "nextSequence": state.nextSequence,
            "schemaVersion": 1,
            "truncated": state.truncated,
        ] as [String: Any])
    }

    private static func validSequence(_ value: String) -> Bool {
        guard let first = value.utf8.first,
              first >= 0x31, first <= 0x39 else { return false }
        return value.utf8.dropFirst().allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    private static func validManagedIdentity(_ details: [String: Any]) -> Bool {
        guard let runtimeId = details["runtimeId"] as? String,
              !runtimeId.isEmpty,
              let processId = details["processId"] as? String,
              validSequence(processId),
              let generationId = details["generationId"] as? String,
              !generationId.isEmpty,
              let bundleId = details["bundleId"] as? String,
              !bundleId.isEmpty else { return false }
        for key in ["releaseId", "contextId", "pageAttemptId", "transitionId"] {
            guard let value = details[key],
                  value is NSNull || (value as? String)?.isEmpty == false else {
                return false
            }
        }
        return true
    }

    private static func increment(_ value: String) -> String? {
        guard validSequence(value) else { return nil }
        var digits = Array(value.utf8)
        var index = digits.count
        while index > 0 {
            index -= 1
            if digits[index] < 0x39 {
                digits[index] += 1
                return String(bytes: digits, encoding: .utf8)
            }
            digits[index] = 0x30
        }
        digits.insert(0x31, at: 0)
        return String(bytes: digits, encoding: .utf8)
    }

    private static func decimalLess(_ lhs: String, _ rhs: String) -> Bool {
        lhs.count == rhs.count ? lhs < rhs : lhs.count < rhs.count
    }

    private static func canonicalData(_ value: Any) throws -> Data {
        var output = ""
        try appendCanonical(value, to: &output)
        guard let data = output.data(using: .utf8) else {
            throw Unavailable.invalidEvent
        }
        return data
    }

    private static func appendCanonical(
        _ value: Any,
        to output: inout String
    ) throws {
        if value is NSNull {
            output += "null"
        } else if let string = value as? String {
            appendJSONString(string, to: &output)
        } else if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                output += number.boolValue ? "true" : "false"
            } else {
                output += try canonicalNumber(number)
            }
        } else if let array = value as? [Any] {
            output += "["
            for (index, item) in array.enumerated() {
                if index > 0 { output += "," }
                try appendCanonical(item, to: &output)
            }
            output += "]"
        } else if let object = value as? [String: Any] {
            output += "{"
            let keys = object.keys.sorted { lhs, rhs in
                lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
            }
            for (index, key) in keys.enumerated() {
                if index > 0 { output += "," }
                appendJSONString(key, to: &output)
                output += ":"
                guard let item = object[key] else {
                    throw Unavailable.invalidEvent
                }
                try appendCanonical(item, to: &output)
            }
            output += "}"
        } else {
            throw Unavailable.invalidEvent
        }
    }

    private static func appendJSONString(
        _ value: String,
        to output: inout String
    ) {
        output += "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x08: output += "\\b"
            case 0x09: output += "\\t"
            case 0x0A: output += "\\n"
            case 0x0C: output += "\\f"
            case 0x0D: output += "\\r"
            case 0x22: output += "\\\""
            case 0x5C: output += "\\\\"
            case 0x00...0x1F:
                output += String(format: "\\u%04x", scalar.value)
            default:
                output.unicodeScalars.append(scalar)
            }
        }
        output += "\""
    }

    private static func canonicalNumber(_ number: NSNumber) throws -> String {
        let value = number.doubleValue
        guard value.isFinite else { throw Unavailable.invalidEvent }
        if value == 0 { return "0" }

        let negative = value < 0
        var text = String(negative ? -value : value).lowercased()
        let exponent: Int
        if let marker = text.firstIndex(of: "e") {
            exponent = Int(text[text.index(after: marker)...]) ?? 0
            text = String(text[..<marker])
        } else {
            exponent = 0
        }
        let point = text.firstIndex(of: ".")
        var decimalPosition = point.map { text.distance(from: text.startIndex, to: $0) }
            ?? text.count
        var digits = text.filter { $0 != "." }
        decimalPosition += exponent
        while digits.first == "0" {
            digits.removeFirst()
            decimalPosition -= 1
        }
        while digits.last == "0" { digits.removeLast() }
        guard !digits.isEmpty else { return "0" }

        let scientificExponent = decimalPosition - 1
        let magnitude: String
        if scientificExponent >= -6 && scientificExponent < 21 {
            if decimalPosition <= 0 {
                magnitude = "0." + String(repeating: "0", count: -decimalPosition)
                    + digits
            } else if decimalPosition >= digits.count {
                magnitude = digits + String(
                    repeating: "0",
                    count: decimalPosition - digits.count
                )
            } else {
                let split = digits.index(
                    digits.startIndex,
                    offsetBy: decimalPosition
                )
                magnitude = digits[..<split] + "." + digits[split...]
            }
        } else {
            let first = digits.removeFirst()
            magnitude = String(first)
                + (digits.isEmpty ? "" : "." + digits)
                + "e" + (scientificExponent >= 0 ? "+" : "")
                + String(scientificExponent)
        }
        return negative ? "-" + magnitude : magnitude
    }
}

final class SparklingGenerationEvents {
    let id: String
    private let journal: SparklingGenerationEventJournal
    private let sink: ((_ name: String, _ details: [String: Any]) -> Void)?
    private let lock = NSRecursiveLock()
    private var accepting = true
    private var retired = false
    private var inFlightResources = 0
    private var leases: [String: [String: Any]] = [:]
    private let identity: [String: Any]?

    init(
        id: String = UUID().uuidString,
        journal: SparklingGenerationEventJournal = .init(),
        runtimeId: String? = nil,
        processId: String? = nil,
        bundleId: String? = nil,
        releaseId: String? = nil,
        sink: ((_ name: String, _ details: [String: Any]) -> Void)?
    ) {
        self.id = id
        self.journal = journal
        self.sink = sink
        if let runtimeId, let processId, let bundleId {
            identity = [
                "runtimeId": runtimeId,
                "processId": processId,
                "generationId": id,
                "bundleId": bundleId,
                "releaseId": releaseId ?? NSNull(),
                "contextId": NSNull(),
                "pageAttemptId": NSNull(),
                "transitionId": NSNull(),
            ]
        } else {
            identity = nil
        }
    }

    @discardableResult
    private func publish(_ name: String, _ details: [String: Any]) -> Bool {
        let owned = identity?.merging(details) { _, new in new } ?? details
        guard journal.append(name: name, details: owned) else {
            return false
        }
        sink?(name, owned)
        return true
    }

    func resourceOperation<T>(_ operation: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else {
            throw NSError(
                domain: "HotUpdaterLynxSparkling",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Generation is retired"]
            )
        }
        inFlightResources += 1
        defer { inFlightResources -= 1 }
        return try operation()
    }

    @discardableResult
    func emit(_ name: String, _ details: [String: Any]) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else { return false }
        return publish(name, details)
    }

    @discardableResult
    func replayRecoveredPageAttemptTerminal(
        pageAttemptId: String,
        details: [String: Any],
        markEmitted: () throws -> Void
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else { return false }
        if journal.containsPageAttemptTerminal(pageAttemptId) {
            try? markEmitted()
            return true
        }
        guard publish("pageAttemptTerminal", details) else { return false }
        try? markEmitted()
        return true
    }

    @discardableResult
    func resourceLoaded(
        _ name: String,
        details: [String: Any]
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard accepting,
              let contextId = details["contextId"] as? String,
              let path = details["path"] as? String else {
            return false
        }
        let key = contextId + "\u{0}" + path
        if leases.updateValue(details, forKey: key) == nil {
            guard publish("resourceLeaseAcquired", details) else {
                leases.removeValue(forKey: key)
                return false
            }
        }
        return publish(name, details)
    }

    func beginRetirement(_ details: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else { return }
        accepting = false
        publish("generationWillRetire", details)
    }

    func finishRetirement(_ details: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard !retired else { return }
        accepting = false
        for path in leases.keys.sorted() {
            publish("resourceLeaseReleased", leases[path]!)
        }
        leases.removeAll()
        var completed = details
        completed["inFlightResourceCount"] = inFlightResources
        publish("generationRetired", completed)
        retired = true
    }
}
