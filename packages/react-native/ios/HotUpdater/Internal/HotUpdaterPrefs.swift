import Foundation

public class HotUpdaterPrefs {

    public static let shared = HotUpdaterPrefs()

    private let userDefaults: UserDefaults
    private var keyPrefix: String = ""

    private init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    public func configure(appVersion: String?) {
        self.keyPrefix = "hotupdater_\(appVersion ?? "unknown")_"
        print("[HotUpdaterPrefs] Configured with appVersion: \(appVersion). Key prefix: \(self.keyPrefix)")
    }

    private func prefixedKey(forKey key: String) -> String {
        guard !keyPrefix.isEmpty else {
            print("[HotUpdaterPrefs] Warning: HotUpdaterPrefs used before configure(appVersion:) was called. Key prefix is empty.")
            return key
        }
        return "\(keyPrefix)\(key)"
    }

    public func setItem(_ value: String?, forKey key: String) {
        let fullKey = prefixedKey(forKey: key)
        if let valueToSet = value {
            userDefaults.set(valueToSet, forKey: fullKey)
            print("[HotUpdaterPrefs] Set '\(fullKey)' = '\(valueToSet)'")
        } else {
            userDefaults.removeObject(forKey: fullKey)
            print("[HotUpdaterPrefs] Removed '\(fullKey)'")
        }
    }

    public func getItem(forKey key: String) -> String? {
        let fullKey = prefixedKey(forKey: key)
        let value = userDefaults.string(forKey: fullKey)
        return value
    }
}