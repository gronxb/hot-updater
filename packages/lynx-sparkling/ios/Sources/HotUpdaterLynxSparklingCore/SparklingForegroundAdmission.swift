import Foundation

/// Foreground recovery belongs to an active scene, never application startup.
final class SparklingForegroundAdmission<Value> {
    private enum State {
        case waiting
        case opening
        case open(Value)
        case closed
    }

    private var state = State.waiting
    private let create: () throws -> Value
    private let dispose: (Value) -> Void

    init(create: @escaping () throws -> Value, dispose: @escaping (Value) -> Void) {
        self.create = create
        self.dispose = dispose
    }

    var isClosed: Bool {
        if case .closed = state { return true }
        return false
    }

    func activate(isForegroundActive: Bool) throws -> Value? {
        guard isForegroundActive else { return nil }
        switch state {
        case .open(let value): return value
        case .opening, .closed: return nil
        case .waiting: break
        }
        state = .opening
        do {
            let value = try create()
            guard !isClosed else {
                dispose(value)
                return nil
            }
            state = .open(value)
            return value
        } catch {
            state = .closed
            throw error
        }
    }

    func close() {
        let previous = state
        state = .closed
        if case .open(let value) = previous { dispose(value) }
    }
}
