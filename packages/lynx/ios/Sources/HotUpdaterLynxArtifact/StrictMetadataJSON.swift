import Foundation

// Metadata has a smaller allocation budget than archive payloads. Validate depth
// before Foundation parses it, and reject duplicate keys including escaped aliases.
enum StrictMetadataJSON {
    static func read(_ file: URL, limit: Int) throws -> Data {
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= limit else { throw LynxArtifactError.invalid("Metadata size/type limit exceeded") }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: limit + 1) ?? Data()
        guard bytes.count <= limit else { throw LynxArtifactError.invalid("Metadata size limit exceeded") }
        try validate(bytes)
        return bytes
    }

    static func validate(_ data: Data) throws {
        let bytes = Array(data)
        var stack: [Set<String>?] = []
        var index = 0
        while index < bytes.count {
            switch bytes[index] {
            case 123, 91:
                guard stack.count < 32 else { throw LynxArtifactError.invalid("Metadata JSON depth limit exceeded") }
                stack.append(bytes[index] == 123 ? [] : nil)
            case 125, 93:
                guard !stack.isEmpty else { throw LynxArtifactError.invalid("Invalid metadata JSON nesting") }
                stack.removeLast()
            case 34:
                let start = index
                index += 1
                while index < bytes.count && bytes[index] != 34 {
                    if bytes[index] == 92 { index += 1 }
                    index += 1
                }
                guard index < bytes.count else { throw LynxArtifactError.invalid("Unterminated metadata JSON string") }
                var next = index + 1
                while next < bytes.count && [9, 10, 13, 32].contains(bytes[next]) { next += 1 }
                if next < bytes.count && bytes[next] == 58 {
                    guard let key = try JSONSerialization.jsonObject(with: Data(bytes[start...index]), options: .fragmentsAllowed) as? String,
                          !stack.isEmpty, var keys = stack[stack.count - 1], keys.insert(key).inserted else {
                        throw LynxArtifactError.invalid("Duplicate or invalid metadata JSON key")
                    }
                    stack[stack.count - 1] = keys
                }
            default: break
            }
            index += 1
        }
        // The structural scan is deliberately small; Foundation validates the full grammar.
        _ = try JSONSerialization.jsonObject(with: data)
    }
}
