import Foundation

protocol PreferencesService {
    func setItem(_ value: String?, forKey key: String)
    func getItem(forKey key: String) -> String?
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
    
    private func prefixedKey(forKey key: String) -> String {
        guard !keyPrefix.isEmpty else {
            print("[PreferencesService] Warning: PreferencesService used before configure(appVersion:) was called. Key prefix is empty.")
            return key
        }
        return "\(keyPrefix)\(key)"
    }
    
    func setItem(_ value: String?, forKey key: String) {
        let fullKey = prefixedKey(forKey: key)
        if let valueToSet = value {
            userDefaults.set(valueToSet, forKey: fullKey)
            print("[PreferencesService] Set '\(fullKey)' = '\(valueToSet)'")
        } else {
            userDefaults.removeObject(forKey: fullKey)
            print("[PreferencesService] Removed '\(fullKey)'")
        }
    }
    
    func getItem(forKey key: String) -> String? {
        let fullKey = prefixedKey(forKey: key)
        return userDefaults.string(forKey: fullKey)
    }
}