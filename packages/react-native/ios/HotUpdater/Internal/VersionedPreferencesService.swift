import Foundation

enum PreferencesError: Error {
    case configurationError
    case setItemError(String)
    case getItemError(String)
}

protocol PreferencesService {
    func setItem(_ value: String?, forKey key: String) throws
    func getItem(forKey key: String) throws -> String?
    func getIsolationKey() -> String
}

class VersionedPreferencesService: PreferencesService {
    private let userDefaults: UserDefaults
    private var isolationKey: String = ""
    
    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }
    
    /**
     * Configures the service with isolation key.
     * @param isolationKey The complete isolation key to use for storage
     */
    func configure(isolationKey: String) {
        self.isolationKey = isolationKey
        NSLog("[PreferencesService] Configured with isolation key: \(self.isolationKey)")
    }
    
    /**
     * Creates a prefixed key for UserDefaults storage.
     * @param key The base key to prefix
     * @return The prefixed key
     * @throws PreferencesError if configuration is missing
     */
    private func prefixedKey(forKey key: String) throws -> String {
        guard !isolationKey.isEmpty else {
            NSLog("[PreferencesService] Warning: PreferencesService used before configure(isolationKey:) was called. Isolation key is empty.")
            throw PreferencesError.configurationError
        }
        return "\(isolationKey)\(key)"
    }
    
    /**
     * Sets a value in preferences.
     * @param value The value to store (or nil to remove)
     * @param key The key to store under
     * @throws PreferencesError if key prefixing fails
     */
    func setItem(_ value: String?, forKey key: String) throws {
        do {
            let fullKey = try prefixedKey(forKey: key)
            if let valueToSet = value {
                userDefaults.set(valueToSet, forKey: fullKey)
                NSLog("[PreferencesService] Set '\(fullKey)' = '\(valueToSet)'")
            } else {
                userDefaults.removeObject(forKey: fullKey)
                NSLog("[PreferencesService] Removed '\(fullKey)'")
            }
        } catch {
            NSLog("[PreferencesService] Error setting key '\(key)': \(error)")
            throw PreferencesError.setItemError(key)
        }
    }
    
    /**
     * Gets a value from preferences.
     * @param key The key to retrieve
     * @return The stored value or nil if not found
     * @throws PreferencesError if key prefixing fails
     */
    func getItem(forKey key: String) throws -> String? {
        do {
            let fullKey = try prefixedKey(forKey: key)
            return userDefaults.string(forKey: fullKey)
        } catch {
            NSLog("[PreferencesService] Error getting key '\(key)': \(error)")
            throw PreferencesError.getItemError(key)
        }
    }

    /**
     * Gets the isolation key.
     * @return The isolation key
     */
    func getIsolationKey() -> String {
        return isolationKey
    }
}
