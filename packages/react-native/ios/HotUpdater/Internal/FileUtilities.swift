import Foundation

enum FileUtilities {
    static func readUpToCount(from handle: FileHandle, count: Int) throws -> Data? {
        guard count >= 0 else {
            throw NSError(
                domain: "FileUtilities",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid read size: \(count)"]
            )
        }

        if count == 0 {
            return Data()
        }

        if #available(macOS 10.15.4, iOS 13.4, watchOS 6.2, tvOS 13.4, *) {
            return try handle.read(upToCount: count)
        }

        return handle.readData(ofLength: count)
    }

    static func normalizedRelativePath(from rawPath: String) -> String? {
        let candidate = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty,
              !candidate.contains("\0"),
              !candidate.contains("\\"),
              !candidate.hasPrefix("/"),
              candidate.range(of: #"^[A-Za-z]:"#, options: .regularExpression) == nil
        else {
            return nil
        }

        let components = candidate.split(separator: "/").map(String.init)
        guard !components.isEmpty,
              components.count == candidate.split(separator: "/", omittingEmptySubsequences: false).count,
              !components.contains(".."),
              !components.contains(".")
        else {
            return nil
        }

        return components.joined(separator: "/")
    }

    static func fileURL(for relativePath: String, destinationRoot: String) throws -> URL {
        let rootURL = URL(fileURLWithPath: destinationRoot, isDirectory: true)
        let targetURL = rootURL.appendingPathComponent(relativePath)
        let standardizedRoot = rootURL.standardizedFileURL.path
        let standardizedTarget = targetURL.standardizedFileURL.path

        guard standardizedTarget == standardizedRoot ||
                standardizedTarget.hasPrefix(standardizedRoot + "/") else {
            throw NSError(
                domain: "FileUtilities",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Path traversal attempt detected: \(relativePath)"]
            )
        }

        return targetURL
    }
}
