import Foundation

public struct SparklingTransitionAcceptance: Equatable {
    public let status = "TRANSITION_ACCEPTED"
    public let transitionId: String

    public init(transitionId: String) {
        self.transitionId = transitionId
    }
}

/** Authorizes a reload reply before the caller retires the old generation. */
public enum SparklingReloadContract {
    public static func run(
        closed: Bool,
        replacing: Bool,
        current: Bool,
        error: (_ code: String, _ message: String) -> Error,
        authorize: () -> Result<SparklingTransitionAcceptance, Error>,
        completion: (Result<SparklingTransitionAcceptance, Error>) -> Void,
        retire: () -> Void
    ) {
        if closed {
            completion(.failure(error(
                "HOST_CLOSED",
                "The managed Lynx host is closed"
            )))
            return
        }
        if replacing {
            completion(.failure(error(
                "RELOAD_BUSY",
                "A managed Lynx generation replacement is already running"
            )))
            return
        }
        if !current {
            completion(.failure(error(
                "CONTEXT_REJECTED",
                "The requesting Lynx generation is no longer current"
            )))
            return
        }
        let result = authorize()
        completion(result)
        if case .success = result {
            retire()
        }
    }
}
