import Foundation

/// One update event for `UpdateLogService`.
struct UpdateLogEvent {
    static let check = "CHECK"
    static let download = "DOWNLOAD"
    static let apply = "APPLY"
    static let rollback = "ROLLBACK"
    static let crashRecovery = "CRASH_RECOVERY"

    static let upToDate = "UP_TO_DATE"
    static let updateAvailable = "UPDATE_AVAILABLE"
    static let rollbackAvailable = "ROLLBACK_AVAILABLE"
    static let failed = "FAILED"
    static let staged = "STAGED"
    static let applied = "APPLIED"
    static let builtInSelected = "BUILT_IN_SELECTED"
    static let channelReset = "CHANNEL_RESET"
    static let rolledBackAfterCrash = "ROLLED_BACK_AFTER_CRASH"
    static let rolledBackUnfinishedLaunch = "ROLLED_BACK_UNFINISHED_LAUNCH"
    static let rolledBackMissingBundle = "ROLLED_BACK_MISSING_BUNDLE"
    static let keptAfterCrash = "KEPT_AFTER_CRASH"

    let type: String
    let outcome: String
    var bundleId: String? = nil
    var fromBundleId: String? = nil
    var releaseId: String? = nil
    var channel: String? = nil
    var error: [String: Any]? = nil

    /// The error fields of `error`: its message, and its code and
    /// classification when it has them.
    static func errorFields(of error: Error, code: String? = nil) -> [String: Any] {
        var fields: [String: Any] = ["message": error.localizedDescription]
        if let code { fields["code"] = code }
        let userInfo = (error as? UpdateFailureError)?.failure.userInfo ?? (error as NSError).userInfo
        if let stage = userInfo["stage"] as? String { fields["stage"] = stage }
        if let reason = userInfo["reason"] as? String { fields["reason"] = reason }
        return fields
    }
}

/// The update log of one instance, which an in-app diagnostics screen reads:
/// a JSON object per line in a file outside device backups, and on this device
/// only.
///
/// Appends go to a serial background queue, so no launch or first render waits
/// for the file, and a read or clear sees every append made before it. An
/// error while writing or reading never reaches the update it describes, and a
/// line that cannot be read, such as one a killed process left half written,
/// is skipped. Each line starts with its newline, so that half line never
/// takes the next one with it.
///
/// It keeps the newest `maxEntries` entries of the last `maxAge`: an update
/// takes about four entries, so that is dozens of updates, and a week is longer
/// than a support case usually takes to reach the app. The file is trimmed at
/// its first append in a process and every `trimInterval` appends, so it stays
/// small without being rewritten each time, and reads apply the same limits.
///
/// Entries hold no request headers or URLs with their queries: a message keeps
/// only the host of a URL (`sanitizeMessage`).
final class UpdateLogService {
    static let filename = "update-log.jsonl"
    static let maxEntries = 200
    static let maxAge: TimeInterval = 7 * 24 * 60 * 60
    static let trimInterval = 20
    /// More than the entries the limits keep could ever take: not a log this
    /// service wrote.
    static let maxFileBytes = 1024 * 1024
    private static let maxFieldLength = 128
    private static let maxMessageLength = 512
    private static let maxRawMessageLength = 4096
    private static let errorFields = ["code", "stage", "reason"]
    /// Native records everything else itself.
    private static let javaScriptTypes: Set<String> = [UpdateLogEvent.check, UpdateLogEvent.download]
    private static let urlPattern = try? NSRegularExpression(
        pattern: "([A-Za-z][A-Za-z0-9+.-]*://)(?:[^\\s/?#@]*@)?([^\\s/?#]*)\\S*"
    )

    private static let servicesLock = NSLock()
    private static var services: [String: UpdateLogService] = [:]

    /// One service per file, so every writer of it shares one queue and order.
    static func service(in directory: URL) -> UpdateLogService {
        let file = directory.appendingPathComponent(filename)
        servicesLock.lock()
        defer { servicesLock.unlock() }
        if let service = services[file.path] { return service }
        let service = UpdateLogService(file: file)
        services[file.path] = service
        return service
    }

    /// Cuts every URL in `message` down to its host and bounds its length.
    static func sanitizeMessage(_ message: String) -> String {
        let raw = String(message.prefix(maxRawMessageLength))
        guard let urlPattern else {
            return String(raw.prefix(maxMessageLength))
        }
        let sanitized = urlPattern.stringByReplacingMatches(
            in: raw,
            range: NSRange(raw.startIndex..., in: raw),
            withTemplate: "$1$2"
        )
        return String(sanitized.prefix(maxMessageLength))
    }

    private let file: URL
    private let clock: () -> Date
    private let queue = DispatchQueue(label: "com.hotupdater.updatelog", qos: .utility)
    /// Only `queue` reads and writes it.
    private var appendsUntilTrim = 0

    init(file: URL, clock: @escaping () -> Date = Date.init) {
        self.file = file
        self.clock = clock
    }

    func append(_ event: UpdateLogEvent) {
        let timestamp = clock()
        queue.async { [self] in
            appendLine(line(of: event, at: timestamp))
        }
    }

    /// Appends one JSON entry of a check or download JavaScript ran, keeping
    /// only what the log knows.
    func appendJson(_ entry: String) {
        let timestamp = clock()
        queue.async { [self] in
            guard let data = entry.data(using: .utf8),
                  let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let type = Self.nonEmptyString(event["type"]),
                  Self.javaScriptTypes.contains(type),
                  let outcome = Self.nonEmptyString(event["outcome"]) else {
                return
            }
            appendLine(line(
                of: UpdateLogEvent(
                    type: type,
                    outcome: outcome,
                    bundleId: Self.nonEmptyString(event["bundleId"]),
                    fromBundleId: Self.nonEmptyString(event["fromBundleId"]),
                    releaseId: Self.nonEmptyString(event["releaseId"]),
                    channel: Self.nonEmptyString(event["channel"]),
                    error: event["error"] as? [String: Any]
                ),
                at: timestamp
            ))
        }
    }

    /// The retained entries as a JSON array, oldest first. Waits, so never call
    /// it on the main thread.
    func read() -> String {
        queue.sync {
            let entries = retainedLines().compactMap { line -> Any? in
                guard let data = line.data(using: .utf8) else { return nil }
                return try? JSONSerialization.jsonObject(with: data)
            }
            guard let data = try? JSONSerialization.data(withJSONObject: entries) else { return "[]" }
            return String(decoding: data, as: UTF8.self)
        }
    }

    /// Deletes the log; false only when the file could not be deleted.
    func clear() -> Bool {
        queue.sync {
            appendsUntilTrim = 0
            guard FileManager.default.fileExists(atPath: file.path) else { return true }
            return (try? FileManager.default.removeItem(at: file)) != nil
        }
    }

    private func appendLine(_ line: String?) {
        guard let line else { return }
        let directory = file.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            NSLog("[UpdateLog] Failed to create \(directory.path): \(error)")
            return
        }
        if appendsUntilTrim <= 0 {
            trim()
            appendsUntilTrim = Self.trimInterval
        }
        appendsUntilTrim -= 1

        let isNewFile = !FileManager.default.fileExists(atPath: file.path)
        // fopen, because FileHandle raises an Objective-C exception on a failed write.
        guard let handle = fopen(file.path, "a") else {
            NSLog("[UpdateLog] Failed to open \(file.path)")
            return
        }
        defer { fclose(handle) }
        fputs("\n\(line)", handle)
        if isNewFile {
            NoBackupStorage.excludeFromBackup(directory)
            NoBackupStorage.excludeFromBackup(file)
        }
    }

    private func trim() {
        let retained = retainedLines()
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        let data = Data(retained.map { "\n\($0)" }.joined().utf8)
        do {
            try NoBackupStorage.write(data, to: file)
        } catch {
            NSLog("[UpdateLog] Failed to trim \(file.path): \(error)")
        }
    }

    private func retainedLines() -> [String] {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = attributes[.size] as? NSNumber else {
            return []
        }
        if size.intValue > Self.maxFileBytes {
            try? FileManager.default.removeItem(at: file)
            return []
        }
        guard let data = try? Data(contentsOf: file) else { return [] }
        let oldest = clock().addingTimeInterval(-Self.maxAge).timeIntervalSince1970 * 1000
        let retained = String(decoding: data, as: UTF8.self)
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)
            .filter { line in
                guard let timestamp = Self.timestamp(of: line) else { return false }
                return timestamp >= oldest
            }
        return Array(retained.suffix(Self.maxEntries))
    }

    /// The entry's time, or nil for a line that is not an entry.
    private static func timestamp(of line: String) -> Double? {
        guard let data = line.data(using: .utf8),
              let entry = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              nonEmptyString(entry["type"]) != nil,
              let timestamp = entry["timestamp"] as? NSNumber else {
            return nil
        }
        return timestamp.doubleValue
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        return string
    }

    private func line(of event: UpdateLogEvent, at date: Date) -> String? {
        var entry: [String: Any] = [
            "timestamp": Int64(date.timeIntervalSince1970 * 1000),
            "type": event.type,
            "outcome": Self.bounded(event.outcome),
        ]
        entry["bundleId"] = event.bundleId.map(Self.bounded)
        entry["fromBundleId"] = event.fromBundleId.map(Self.bounded)
        entry["releaseId"] = event.releaseId.map(Self.bounded)
        entry["channel"] = event.channel.map(Self.bounded)
        if let error = event.error {
            var fields: [String: Any] = [:]
            for field in Self.errorFields {
                fields[field] = Self.nonEmptyString(error[field]).map(Self.bounded)
            }
            fields["message"] = Self.nonEmptyString(error["message"]).map(Self.sanitizeMessage)
            entry["error"] = fields
        }
        guard let data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func bounded(_ value: String) -> String {
        String(value.prefix(maxFieldLength))
    }
}
