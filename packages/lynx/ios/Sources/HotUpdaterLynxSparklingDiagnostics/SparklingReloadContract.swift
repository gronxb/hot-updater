import Foundation

/** Admission and result propagation for a truthful managed-generation reload. */
public enum SparklingReloadContract {
    public static func run(
        closed: Bool,
        replacing: Bool,
        current: Bool,
        error: (_ code: String, _ message: String) -> Error,
        replacement: () -> Result<Void, Error>
    ) -> Result<Void, Error> {
        if closed {
            return .failure(error(
                "HOST_CLOSED",
                "The managed Lynx host is closed"
            ))
        }
        if replacing {
            return .failure(error(
                "RELOAD_BUSY",
                "A managed Lynx generation replacement is already running"
            ))
        }
        if !current {
            return .failure(error(
                "CONTEXT_REJECTED",
                "The requesting Lynx generation is no longer current"
            ))
        }
        return replacement()
    }
}
