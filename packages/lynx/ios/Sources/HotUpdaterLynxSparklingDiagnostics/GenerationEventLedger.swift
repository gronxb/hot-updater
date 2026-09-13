import Foundation

func hotUpdaterJSONValue<T>(_ value: T?) -> Any {
    value ?? NSNull()
}

final class SparklingGenerationEvents {
    let id: String
    private let sink: ((_ name: String, _ details: [String: Any]) -> Void)?
    private let lock = NSRecursiveLock()
    private var accepting = true
    private var retired = false
    private var inFlightResources = 0
    private var leases: [String: [String: Any]] = [:]

    init(
        id: String = UUID().uuidString,
        sink: ((_ name: String, _ details: [String: Any]) -> Void)?
    ) {
        self.id = id
        self.sink = sink
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
        sink?(name, details)
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
            sink?("resourceLeaseAcquired", details)
        }
        sink?(name, details)
        return true
    }

    func beginRetirement(_ details: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else { return }
        accepting = false
        sink?("generationWillRetire", details)
    }

    func finishRetirement(_ details: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard !retired else { return }
        accepting = false
        for path in leases.keys.sorted() {
            sink?("resourceLeaseReleased", leases[path]!)
        }
        leases.removeAll()
        var completed = details
        completed["inFlightResourceCount"] = inFlightResources
        sink?("generationRetired", completed)
        retired = true
    }
}
