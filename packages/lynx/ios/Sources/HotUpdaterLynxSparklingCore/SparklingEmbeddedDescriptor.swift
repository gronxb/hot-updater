import Foundation

public struct HotUpdaterSparklingEmbeddedDescriptor: Equatable, Sendable {
    public let runtimeId: String
    public let variant: String
    public let bundleId: String
    public let minimumBundleId: String
    public let manifestDigest: String

    public init(data: Data) throws {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw HotUpdaterSparklingEmbeddedDescriptorError.invalidJSON
        }
        guard let object = value as? [String: Any] else {
            throw HotUpdaterSparklingEmbeddedDescriptorError.invalidJSON
        }

        func requiredString(_ key: String) throws -> String {
            guard let value = object[key] as? String, !value.isEmpty else {
                throw HotUpdaterSparklingEmbeddedDescriptorError
                    .missingOrInvalidString(key)
            }
            return value
        }

        runtimeId = try requiredString("runtimeId")
        variant = try requiredString("variant")
        bundleId = try requiredString("bundleId")
        minimumBundleId = try requiredString("minimumBundleId")
        manifestDigest = try requiredString("manifestDigest")
    }
}

public enum HotUpdaterSparklingEmbeddedDescriptorError: Error,
    Equatable, LocalizedError {
    case invalidJSON
    case missingOrInvalidString(String)

    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "The embedded descriptor must be a JSON object"
        case .missingOrInvalidString(let key):
            return "The embedded descriptor requires a non-empty string field '\(key)'"
        }
    }
}
