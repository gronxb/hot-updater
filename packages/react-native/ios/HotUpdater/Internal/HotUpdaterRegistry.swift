import Foundation

/// Weak reference wrapper for registry storage
class WeakRef<T: AnyObject> {
    weak var value: T?

    init(_ value: T) {
        self.value = value
    }
}

/// Global registry for HotUpdater instances.
/// Uses weak references to allow automatic memory cleanup when instances are deallocated.
@objcMembers
public class HotUpdaterRegistry: NSObject {
    // Thread-safe weak reference storage
    private static var delegates: [String: WeakRef<HotUpdaterImpl>] = [:]
    private static let lock = NSLock()

    // Track the identifier currently used by bundleURL()
    private static var defaultIdentifier: String? = nil

    /// Register a HotUpdaterImpl instance with an identifier.
    /// The instance is stored as a weak reference.
    /// - Parameters:
    ///   - delegate: The HotUpdaterImpl instance to register
    ///   - identifier: Unique identifier for the instance
    public static func register(_ delegate: HotUpdaterImpl, identifier: String) {
        lock.lock()
        defer { lock.unlock() }

        delegates[identifier] = WeakRef(delegate)
        NSLog("[HotUpdaterRegistry] Registered instance with identifier: \(identifier)")
    }

    /// Get a HotUpdaterImpl instance by identifier.
    /// Automatically cleans up nil weak references.
    /// - Parameter identifier: The identifier to look up
    /// - Returns: The HotUpdaterImpl instance or nil if not found or deallocated
    public static func get(_ identifier: String) -> HotUpdaterImpl? {
        lock.lock()
        defer { lock.unlock() }

        // Clean up nil weak references
        if let weakRef = delegates[identifier], weakRef.value == nil {
            delegates.removeValue(forKey: identifier)
            NSLog("[HotUpdaterRegistry] Cleaned up deallocated instance: \(identifier)")
            return nil
        }

        return delegates[identifier]?.value
    }

    /// Remove an instance from the registry.
    /// This is optional - instances are automatically cleaned up when deallocated.
    /// - Parameter identifier: The identifier to remove
    public static func unregister(_ identifier: String) {
        lock.lock()
        defer { lock.unlock() }

        delegates.removeValue(forKey: identifier)
        NSLog("[HotUpdaterRegistry] Unregistered instance: \(identifier)")
    }

    /// Set the default identifier that is currently being used by bundleURL().
    /// This is used for validation to ensure updateBundle uses the same identifier.
    /// - Parameter identifier: The identifier currently in use (nil for default)
    public static func setDefaultIdentifier(_ identifier: String?) {
        lock.lock()
        defer { lock.unlock() }

        defaultIdentifier = identifier
        NSLog("[HotUpdaterRegistry] Set default identifier: \(identifier ?? "<nil>")")
    }

    /// Get the default identifier currently being used by bundleURL().
    /// - Returns: The default identifier or nil
    public static func getDefaultIdentifier() -> String? {
        lock.lock()
        defer { lock.unlock() }

        return defaultIdentifier
    }

    /// Resolve a HotUpdaterImpl instance based on identifier.
    /// If identifier is provided, looks it up in the registry.
    /// If identifier is nil, returns the fallback instance.
    /// - Parameters:
    ///   - identifier: The identifier to look up (nil to use fallback)
    ///   - fallback: The fallback instance to use when identifier is nil
    /// - Returns: The resolved instance or nil if identifier is provided but not found
    public static func resolveInstance(identifier: String?, fallback: HotUpdaterImpl) -> HotUpdaterImpl? {
        if let id = identifier {
            // identifier provided - look up in registry
            let instance = get(id)
            if instance != nil {
                NSLog("[HotUpdaterRegistry] Using instance with identifier: \(id)")
            }
            return instance
        } else {
            // No identifier - use fallback
            NSLog("[HotUpdaterRegistry] Using fallback instance")
            return fallback
        }
    }
}
