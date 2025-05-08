import Foundation


protocol FileSystemService {
    func fileExists(atPath path: String) -> Bool
    func createDirectory(at path: String) -> Bool
    func removeItem(atPath path: String) throws
    func moveItem(at srcPath: URL, to dstPath: URL) throws
    func copyItem(atPath srcPath: String, toPath dstPath: String) throws
    func contentsOfDirectory(atPath path: String) throws -> [String]
    func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws
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
        } catch {
            print("[FileSystemService] Failed to create directory at \(path): \(error)")
            return false
        }
    }
    
    func removeItem(atPath path: String) throws {
        try fileManager.removeItem(atPath: path)
    }
    
    func moveItem(at srcPath: URL, to dstPath: URL) throws {
        try fileManager.moveItem(at: srcPath, to: dstPath)
    }
    
    func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        try fileManager.copyItem(atPath: srcPath, toPath: dstPath)
    }
    
    func contentsOfDirectory(atPath path: String) throws -> [String] {
        return try fileManager.contentsOfDirectory(atPath: path)
    }
    
    func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        try fileManager.setAttributes(attributes, ofItemAtPath: path)
    }
    
    func documentsPath() -> String {
        return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
    }
}