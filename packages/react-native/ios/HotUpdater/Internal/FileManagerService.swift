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
    
    func moveItem(at srcPath: URL, to dstPath: URL) throws {
        do {
            try fileManager.moveItem(at: srcPath, to: dstPath)
        } catch let error {
            NSLog("[FileSystemService] Failed to move item from \(srcPath) to \(dstPath): \(error)")
            throw FileSystemError.fileOperationFailed(srcPath.path, error)
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
    
    func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        do {
            try fileManager.setAttributes(attributes, ofItemAtPath: path)
        } catch let error {
            NSLog("[FileSystemService] Failed to set attributes for \(path): \(error)")
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
        return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
    }
}
