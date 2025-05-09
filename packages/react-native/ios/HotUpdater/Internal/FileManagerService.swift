import Foundation

// MARK: - File System Service

enum FileSystemError: Error {
    case createDirectoryFailed(String)
    case fileOperationFailed(String, Error)
    case fileNotFound(String)
}

protocol FileSystemService {
    func fileExists(atPath path: String) -> Bool
    func createDirectory(at path: String) -> Bool
    func removeItem(atPath path: String) throws
    func moveItem(at srcPath: URL, to dstPath: URL) throws
    func copyItem(atPath srcPath: String, toPath dstPath: String) throws
    func contentsOfDirectory(atPath path: String) throws -> [String]
    func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws
    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any]
    func documentsPath() -> String
}

class FileManagerService: FileSystemService {
    private let fileManager = FileManager.default
    
    func fileExists(atPath path: String) -> Bool {
        return fileManager.fileExists(atPath: path)
    }
    
    func createDirectory(at path: String) -> Bool {
        do {
            try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
            return true
        } catch let error {
            print("[FileSystemService] Failed to create directory at \(path): \(error)")
            return false
        }
    }
    
    func removeItem(atPath path: String) throws {
        do {
            try fileManager.removeItem(atPath: path)
        } catch let error {
            print("[FileSystemService] Failed to remove item at \(path): \(error)")
            throw FileSystemError.fileOperationFailed(path, error)
        }
    }
    
    func moveItem(at srcPath: URL, to dstPath: URL) throws {
        do {
            try fileManager.moveItem(at: srcPath, to: dstPath)
        } catch let error {
            print("[FileSystemService] Failed to move item from \(srcPath) to \(dstPath): \(error)")
            throw FileSystemError.fileOperationFailed(srcPath.path, error)
        }
    }
    
    func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        do {
            try fileManager.copyItem(atPath: srcPath, toPath: dstPath)
        } catch let error {
            print("[FileSystemService] Failed to copy item from \(srcPath) to \(dstPath): \(error)")
            throw FileSystemError.fileOperationFailed(srcPath, error)
        }
    }
    
    func contentsOfDirectory(atPath path: String) throws -> [String] {
        do {
            return try fileManager.contentsOfDirectory(atPath: path)
        } catch let error {
            print("[FileSystemService] Failed to get directory contents at \(path): \(error)")
            throw FileSystemError.fileOperationFailed(path, error)
        }
    }
    
    func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        do {
            try fileManager.setAttributes(attributes, ofItemAtPath: path)
        } catch let error {
            print("[FileSystemService] Failed to set attributes for \(path): \(error)")
            throw FileSystemError.fileOperationFailed(path, error)
        }
    }

    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        do {
            return try fileManager.attributesOfItem(atPath: path)
        } catch let error {
            print("[FileSystemService] Failed to get attributes for \(path): \(error)")
            throw FileSystemError.fileOperationFailed(path, error)
        }
    }
    
    func documentsPath() -> String {
        return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
    }
}

// MARK: - Preferences Service

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
    
    /**
     * Configures the service with app version for key prefixing.
     * @param appVersion The app version to use for key prefixing
     */
    func configure(appVersion: String?) {
        self.keyPrefix = "hotupdater_\(appVersion ?? "unknown")_"
        print("[PreferencesService] Configured with appVersion: \(appVersion ?? "nil"). Key prefix: \(self.keyPrefix)")
    }
    
    /**
     * Creates a prefixed key for UserDefaults storage.
     * @param key The base key to prefix
     * @return The prefixed key
     * @throws PreferencesError if configuration is missing
     */
    private func prefixedKey(forKey key: String) throws -> String {
        guard !keyPrefix.isEmpty else {
            print("[PreferencesService] Warning: PreferencesService used before configure(appVersion:) was called. Key prefix is empty.")
            throw PreferencesError.configurationError
        }
        return "\(keyPrefix)\(key)"
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
            print("[PreferencesService] Error getting key '\(key)': \(error)")
            throw PreferencesError.getItemError(key)
        }
    }
}
