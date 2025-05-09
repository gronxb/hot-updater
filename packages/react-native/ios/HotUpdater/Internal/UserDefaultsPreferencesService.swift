import Foundation

enum PreferencesError: Error {
    case configurationError
    case setItemError(String)
    case getItemError(String)
}

protocol PreferencesService {
    func setItem(_ value: String?, forKey key: String) throws
    func getItem(forKey key: String) throws -> String?
}

class UserDefaultsPreferencesService: PreferencesService {
    private let userDefaults: UserDefaults
    private var keyPrefix: String = ""
    
    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }
    
    func configure(appVersion: String?) {
        self.keyPrefix = "hotupdater_\(appVersion ?? "unknown")_"
        print("[PreferencesService] Configured with appVersion: \(appVersion ?? "nil"). Key prefix: \(self.keyPrefix)")
    }
    
    private func prefixedKey(forKey key: String) throws -> String {
        guard !keyPrefix.isEmpty else {
            print("[PreferencesService] Warning: PreferencesService used before configure(appVersion:) was called. Key prefix is empty.")
            throw PreferencesError.configurationError
        }
        return "\(keyPrefix)\(key)"
    }
    
    func setItem(_ value: String?, forKey key: String) throws {
        do {
            let fullKey = try prefixedKey(forKey: key)
            if let valueToSet = value {
                userDefaults.set(valueToSet, forKey: fullKey)
                print("[PreferencesService] Set '\(fullKey)' = '\(valueToSet)'")
            } else {
                userDefaults.removeObject(forKey: fullKey)
                print("[PreferencesService] Removed '\(fullKey)'")
            }
        } catch {
            print("[PreferencesService] Error setting key '\(key)': \(error)")
            throw PreferencesError.setItemError(key)
        }
    }
    
    func getItem(forKey key: String) throws -> String? {
        do {
            let fullKey = try prefixedKey(forKey: key)
            return userDefaults.string(forKey: fullKey)
        } catch {
            print("[PreferencesService] Error getting key '\(key)': \(error)")
            throw PreferencesError.getItemError(key)
        }
    }
}