import Foundation

/** Settles accepted bridge operations when their owning generation is retired. */
final class LynxBridgeReplies {
    struct Ticket: Hashable { fileprivate let id: Int }

    private let lock = NSLock()
    private var callbacks: [Int: (Error) -> Void] = [:]
    private var nextID = 0
    private var closed = false

    func register(_ cancellation: @escaping (Error) -> Void) -> Ticket? {
        lock.lock()
        guard !closed else {
            lock.unlock()
            cancellation(Self.contextRejected)
            return nil
        }
        let ticket = Ticket(id: nextID)
        nextID += 1
        callbacks[ticket.id] = cancellation
        lock.unlock()
        return ticket
    }

    func settle(_ ticket: Ticket, _ completion: () -> Void) {
        lock.lock()
        let accepted = callbacks.removeValue(forKey: ticket.id) != nil
        lock.unlock()
        if accepted { completion() }
    }

    /** Transfers an accepted reply to a host operation that survives retirement. */
    func claim(_ ticket: Ticket) -> Bool {
        lock.lock()
        let accepted = callbacks.removeValue(forKey: ticket.id) != nil
        lock.unlock()
        return accepted
    }

    func close() {
        lock.lock()
        guard !closed else {
            lock.unlock()
            return
        }
        closed = true
        let pending = Array(callbacks.values)
        callbacks.removeAll()
        lock.unlock()
        pending.forEach { $0(Self.contextRejected) }
    }

    private static let contextRejected = LynxPolicyError(
        code: "CONTEXT_REJECTED",
        message: "The native Lynx context was retired before the operation completed"
    )
}

/** Protects a host-owned asynchronous reply from duplicate completion. */
final class LynxOnceReply<Value> {
    private let lock = NSLock()
    private var callback: ((Result<Value, Error>) -> Void)?

    init(_ callback: @escaping (Result<Value, Error>) -> Void) {
        self.callback = callback
    }

    func settle(_ result: Result<Value, Error>) {
        lock.lock()
        let callback = self.callback
        self.callback = nil
        lock.unlock()
        callback?(result)
    }
}
