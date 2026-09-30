import Foundation

// MARK: - File System Service

enum FileSystemError: Error {
    case createDirectoryFailed(String)
    case fileOperationFailed(String, Error)
    case fileNotFound(String)
}

protocol FileSystemService {
    func fileExists(atPath path: String) -> Bool
    func createDirectory(atPath path: String) -> Bool
    func removeItem(atPath path: String) throws
    func moveItem(atPath srcPath: String, toPath dstPath: String) throws
    func copyItem(atPath srcPath: String, toPath dstPath: String) throws
    func contentsOfDirectory(atPath path: String) throws -> [String]
    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any]
    func documentsPath() -> String
    /// Base directory for data that lives as long as the installation.
    func applicationSupportPath() -> String
}

/// `Application Support/HotUpdater`: data the SDK keeps for the life of an
/// installation, such as the install id and plugin storage. Device backups
/// skip it, so restoring a backup onto another device never copies it there.
enum NoBackupStorage {
    static let directoryName = "HotUpdater"

    static func directory(in fileSystem: FileSystemService) -> URL {
        URL(fileURLWithPath: fileSystem.applicationSupportPath(), isDirectory: true)
            .appendingPathComponent(directoryName, isDirectory: true)
    }

    /// Atomically replaces `file` with `data`, creating its directory when
    /// needed, and excludes the directory and the file from device backups.
    static func write(_ data: Data, to file: URL) throws {
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        excludeFromBackup(directory)
        try data.write(to: file, options: .atomic)
        // An atomic write replaces the file, which drops its previous flag.
        excludeFromBackup(file)
    }

    static func excludeFromBackup(_ url: URL) {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try url.setResourceValues(values)
        } catch {
            NSLog("[NoBackupStorage] Failed to exclude \(url.path) from backups: \(error)")
        }
    }
}

class FileManagerService: FileSystemService {
    private let fileManager = FileManager.default
    
    func fileExists(atPath path: String) -> Bool {
        return fileManager.fileExists(atPath: path)
    }
    
    func createDirectory(atPath path: String) -> Bool {
        do {
            try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
            return true
        } catch let error {
            NSLog("[FileSystemService] Failed to create directory at \(path): \(error)")
            return false
        }
    }
    
    func removeItem(atPath path: String) throws {
        do {
            try fileManager.removeItem(atPath: path)
        } catch let error {
            NSLog("[FileSystemService] Failed to remove item at \(path): \(error)")
            throw FileSystemError.fileOperationFailed(path, error)
        }
    }
    
    func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        do {
            try fileManager.moveItem(atPath: srcPath, toPath: dstPath)
        } catch let error {
            NSLog("[FileSystemService] Failed to move item from \(srcPath) to \(dstPath): \(error)")
            throw FileSystemError.fileOperationFailed(srcPath, error)
        }
    }
    
    func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        do {
            try fileManager.copyItem(atPath: srcPath, toPath: dstPath)
        } catch let error {
            NSLog("[FileSystemService] Failed to copy item from \(srcPath) to \(dstPath): \(error)")
            throw FileSystemError.fileOperationFailed(srcPath, error)
        }
    }
    
    func contentsOfDirectory(atPath path: String) throws -> [String] {
        do {
            return try fileManager.contentsOfDirectory(atPath: path)
        } catch let error {
            NSLog("[FileSystemService] Failed to get directory contents at \(path): \(error)")
            throw FileSystemError.fileOperationFailed(path, error)
        }
    }

    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        do {
            return try fileManager.attributesOfItem(atPath: path)
        } catch let error {
            NSLog("[FileSystemService] Failed to get attributes for \(path): \(error)")
            throw FileSystemError.fileOperationFailed(path, error)
        }
    }
    
    func documentsPath() -> String {
        #if os(tvOS)
        // tvOS doesn't have persistent Documents directory, use Caches instead
        return NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true)[0]
        #else
        return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
        #endif
    }

    func applicationSupportPath() -> String {
        #if os(tvOS)
        // tvOS apps can only write purgeable files, so use Caches like documentsPath().
        return NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true)[0]
        #else
        return NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true)[0]
        #endif
    }
}
