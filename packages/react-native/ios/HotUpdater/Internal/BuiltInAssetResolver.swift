import Foundation

protocol BuiltInAssetResolver: AnyObject {
    func use(bundle: Bundle)
    func copyIfMatches(assetPath: String, expectedHash: String, destination: String) -> Bool
}

final class IOSBuiltInAssetResolver: BuiltInAssetResolver {
    private struct CachedIndex: Codable {
        let schemaVersion: Int
        let packageIdentity: String
        var locators: [String: String]
    }

    private let cacheURL: URL
    private let lock = NSLock()
    private var bundle: Bundle = .main

    init(cacheURL: URL) {
        self.cacheURL = cacheURL
    }

    func use(bundle: Bundle) {
        lock.lock()
        self.bundle = bundle
        lock.unlock()
    }

    func copyIfMatches(
        assetPath: String,
        expectedHash: String,
        destination: String
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard FileUtilities.normalizedRelativePath(from: assetPath) == assetPath else {
            return false
        }
        let packageIdentity = packageIdentity(for: bundle)
        var index = readIndex(packageIdentity: packageIdentity)

        if let cachedLocator = index.locators[assetPath],
           copyLocatorIfMatches(
            cachedLocator,
            expectedHash: expectedHash,
            destination: destination
           ) {
            return true
        }

        guard let locator = resolveLocator(assetPath: assetPath),
              copyLocatorIfMatches(
                locator,
                expectedHash: expectedHash,
                destination: destination
              ) else {
            return false
        }

        index.locators[assetPath] = locator
        writeIndex(index)
        return true
    }

    private func resolveLocator(assetPath: String) -> String? {
        if assetPath == "index.ios.bundle" {
            guard let bundleURL = bundle.url(forResource: "main", withExtension: "jsbundle"),
                  let relativePath = relativePath(of: bundleURL, inside: bundle.bundleURL) else {
                return nil
            }
            return "bundle:\(relativePath)"
        }

        guard let resourceURL = bundle.resourceURL else { return nil }
        let sourceURL = resourceURL.appendingPathComponent(assetPath).standardizedFileURL
        guard relativePath(of: sourceURL, inside: resourceURL) == assetPath,
              isRegularFile(sourceURL) else {
            return nil
        }
        return "resource:\(assetPath)"
    }

    private func copyLocatorIfMatches(
        _ locator: String,
        expectedHash: String,
        destination: String
    ) -> Bool {
        guard let sourceURL = sourceURL(for: locator), isRegularFile(sourceURL) else {
            return false
        }
        let destinationURL = URL(fileURLWithPath: destination)
        let temporaryURL = destinationURL
            .deletingLastPathComponent()
            .appendingPathComponent("\(destinationURL.lastPathComponent).builtin.tmp")
        do {
            try FileManager.default.createDirectory(
                at: destinationURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? FileManager.default.removeItem(at: temporaryURL)
            try FileManager.default.copyItem(at: sourceURL, to: temporaryURL)
            guard HashUtils.verifyHash(fileURL: temporaryURL, expectedHash: expectedHash) else {
                try? FileManager.default.removeItem(at: temporaryURL)
                return false
            }
            try? FileManager.default.removeItem(at: destinationURL)
            try FileManager.default.moveItem(at: temporaryURL, to: destinationURL)
            return true
        } catch {
            try? FileManager.default.removeItem(at: temporaryURL)
            return false
        }
    }

    private func sourceURL(for locator: String) -> URL? {
        if locator.hasPrefix("bundle:") {
            let relativePath = String(locator.dropFirst("bundle:".count))
            let sourceURL = bundle.bundleURL.appendingPathComponent(relativePath).standardizedFileURL
            return self.relativePath(of: sourceURL, inside: bundle.bundleURL) == relativePath
                ? sourceURL
                : nil
        }
        if locator.hasPrefix("resource:"), let resourceURL = bundle.resourceURL {
            let relativePath = String(locator.dropFirst("resource:".count))
            let sourceURL = resourceURL.appendingPathComponent(relativePath).standardizedFileURL
            return self.relativePath(of: sourceURL, inside: resourceURL) == relativePath
                ? sourceURL
                : nil
        }
        return nil
    }

    private func relativePath(of fileURL: URL, inside directoryURL: URL) -> String? {
        let directory = directoryURL.standardizedFileURL.resolvingSymlinksInPath().path
        let file = fileURL.standardizedFileURL.resolvingSymlinksInPath().path
        let prefix = directory.hasSuffix("/") ? directory : "\(directory)/"
        guard file.hasPrefix(prefix) else { return nil }
        return String(file.dropFirst(prefix.count))
    }

    private func isRegularFile(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
    }

    private func packageIdentity(for bundle: Bundle) -> String {
        let values = try? bundle.bundleURL.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let bundleIdentifier = bundle.bundleIdentifier ?? ""
        let shortVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let bundleVersion = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        let bundlePath = bundle.bundleURL.standardizedFileURL.path
        let fileSize = String(values?.fileSize ?? -1)
        let modificationTime = String(values?.contentModificationDate?.timeIntervalSince1970 ?? -1)

        return [
            bundleIdentifier,
            shortVersion,
            bundleVersion,
            bundlePath,
            fileSize,
            modificationTime,
        ].joined(separator: "|")
    }

    private func readIndex(packageIdentity: String) -> CachedIndex {
        if let data = try? Data(contentsOf: cacheURL),
           let index = try? JSONDecoder().decode(CachedIndex.self, from: data),
           index.schemaVersion == Self.schemaVersion,
           index.packageIdentity == packageIdentity {
            return index
        }
        return CachedIndex(
            schemaVersion: Self.schemaVersion,
            packageIdentity: packageIdentity,
            locators: [:]
        )
    }

    private func writeIndex(_ index: CachedIndex) {
        do {
            try FileManager.default.createDirectory(
                at: cacheURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let temporaryURL = cacheURL.appendingPathExtension("tmp")
            let data = try JSONEncoder().encode(index)
            try data.write(to: temporaryURL, options: .atomic)
            try? FileManager.default.removeItem(at: cacheURL)
            try FileManager.default.moveItem(at: temporaryURL, to: cacheURL)
        } catch {
            // Cache persistence must never block a valid install.
        }
    }

    private static let schemaVersion = 1
}
