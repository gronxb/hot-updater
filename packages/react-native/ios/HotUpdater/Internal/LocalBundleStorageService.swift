// DefaultBundleStorageService.swift
import Foundation


/// 번들 저장 및 관리를 담당하는 프로토콜
protocol BundleStorageService {
    func bundleStoreDir() -> String
    func tempDir() -> String
    func findBundleFile(in directoryPath: String) -> String?
    func cleanupOldBundles(currentBundleId: String?)
}


class LocalBundleStorageService: BundleStorageService {
    private let fileSystem: FileSystemService
    
    init(fileSystem: FileSystemService) {
        self.fileSystem = fileSystem
    }
    
    func bundleStoreDir() -> String {
        return (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-store")
    }
    
    func tempDir() -> String {
        return (fileSystem.documentsPath() as NSString).appendingPathComponent("bundle-temp")
    }
    
    func findBundleFile(in directoryPath: String) -> String? {
        do {
            let items = try fileSystem.contentsOfDirectory(atPath: directoryPath)
            if let bundleFile = items.first(where: { $0 == "index.ios.bundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            } else if let bundleFile = items.first(where: { $0 == "main.jsbundle" }) {
                 return (directoryPath as NSString).appendingPathComponent(bundleFile)
            }
        } catch {
            print("[BundleStorageService] Error listing directory contents at \(directoryPath): \(error)")
        }
        print("[BundleStorageService] Bundle file (index.ios.bundle or main.jsbundle) not found in \(directoryPath)")
        return nil
    }
    
    func cleanupOldBundles(currentBundleId: String?) {
        let storeDir = bundleStoreDir()
        guard let contents = try? fileSystem.contentsOfDirectory(atPath: storeDir) else {
             print("[BundleStorageService] Failed to list contents of bundle store directory: \(storeDir)")
            return
        }

        var bundleDirs = [(path: String, modDate: Date)]()

        for item in contents {
            let fullPath = (storeDir as NSString).appendingPathComponent(item)
            var isDir: ObjCBool = false
            if fileSystem.fileExists(atPath: fullPath) {
                do {
                    let attributes = try fileSystem.setAttributes([.modificationDate: Date()], ofItemAtPath: fullPath)
                    if let modDate = attributes[.modificationDate] as? Date {
                        bundleDirs.append((path: fullPath, modDate: modDate))
                    } else {
                        bundleDirs.append((path: fullPath, modDate: .distantPast))
                         print("[BundleStorageService] Warning: Could not get modification date for \(fullPath), treating as old.")
                    }
                } catch {
                     print("[BundleStorageService] Warning: Could not get attributes for \(fullPath): \(error)")
                     bundleDirs.append((path: fullPath, modDate: .distantPast))
                }
            }
        }

        bundleDirs.sort { $0.modDate > $1.modDate }

        var bundlesToKeep = Set<String>()

        if let currentId = currentBundleId, let currentPath = bundleDirs.first(where: { ($0.path as NSString).lastPathComponent == currentId })?.path {
            bundlesToKeep.insert(currentPath)
            print("[BundleStorageService] Keeping current bundle: \(currentId)")
        }

        if let latestBundle = bundleDirs.first {
            bundlesToKeep.insert(latestBundle.path)
             print("[BundleStorageService] Keeping latest bundle (by mod date): \((latestBundle.path as NSString).lastPathComponent)")
        }

        let bundlesToRemove = bundleDirs.filter { !bundlesToKeep.contains($0.path) }

        if bundlesToRemove.isEmpty {
            print("[BundleStorageService] No old bundles to remove.")
        } else {
            print("[BundleStorageService] Found \(bundlesToRemove.count) old bundle(s) to remove.")
        }

        for oldBundle in bundlesToRemove {
            do {
                try fileSystem.removeItem(atPath: oldBundle.path)
                print("[BundleStorageService] Removed old bundle: \((oldBundle.path as NSString).lastPathComponent)")
            } catch {
                print("[BundleStorageService] Failed to remove old bundle at \(oldBundle.path): \(error)")
            }
        }
    }
}