import Foundation

public enum HotUpdaterSparklingNavigationError: Error, LocalizedError,
    Equatable {
    case invalidRoute(String)
    case unknownPage(String)
    case invalidOptions(String)
    case staleSource
    case nonTopSource
    case reconstructionFailed(String)

    public var errorDescription: String? {
        switch self {
        case .invalidRoute(let message), .invalidOptions(let message),
             .reconstructionFailed(let message):
            return message
        case .unknownPage(let entry):
            return "The managed page is not allowlisted: \(entry)"
        case .staleSource:
            return "STALE_CONTEXT: The route source is not a live managed page"
        case .nonTopSource:
            return "The route source is not the live managed top page"
        }
    }
}

public struct HotUpdaterSparklingRoute: Equatable {
    public let entry: String
    public let parameters: [HotUpdaterSparklingParameter]

    public static func == (
        lhs: HotUpdaterSparklingRoute,
        rhs: HotUpdaterSparklingRoute
    ) -> Bool {
        lhs.entry == rhs.entry && lhs.parameters == rhs.parameters
    }
}

public struct HotUpdaterSparklingParameter: Codable, Equatable {
    public let name: String
    public let value: String

    public init(name: String, value: String) {
        self.name = name
        self.value = value
    }
}

enum HotUpdaterSparklingPageLaunchConfiguration {
    static func merge(
        host: [String: String],
        page: [String: String]
    ) -> [String: String] {
        host.merging(page) { _, pageValue in pageValue }
    }
}

public enum HotUpdaterSparklingRouteParser {
    public static let maximumRawRouteBytes = 4_096
    public static let maximumCustomParameters = 32
    public static let maximumDecodedKeyBytes = 128
    public static let maximumDecodedValueBytes = 1_024
    public static let maximumAggregateDecodedQueryBytes = 2_048

    private static let base = "hybrid://lynxview_page"
    private static let reservedParameters: Set<String> = [
        "baseScheme", "replace", "replaceType", "useSysBrowser", "animated",
        "interceptor", "extra", "url",
    ]
    private static let pagePattern =
        "^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/)*" +
        "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\\.lynx\\.bundle$"

    public static func parse(
        _ rawURL: String,
        allowlistedEntries: Set<String>
    ) throws -> HotUpdaterSparklingRoute {
        guard rawURL.utf8.count <= maximumRawRouteBytes else {
            throw HotUpdaterSparklingNavigationError.invalidRoute(
                "The managed route exceeds the UTF-8 byte limit"
            )
        }
        guard rawURL.hasPrefix(base + "?"),
              String(rawURL.prefix(base.count)) == base,
              !rawURL.contains("#") else {
            throw HotUpdaterSparklingNavigationError.invalidRoute(
                "Only the canonical hybrid://lynxview_page route is supported"
            )
        }
        let rawQuery = String(rawURL.dropFirst(base.count + 1))
        guard !rawQuery.isEmpty else {
            throw HotUpdaterSparklingNavigationError.invalidRoute(
                "The managed route query is empty"
            )
        }
        let rawItems = rawQuery.split(
            separator: "&",
            omittingEmptySubsequences: false
        )
        guard rawItems.count <= maximumCustomParameters + 1 else {
            throw HotUpdaterSparklingNavigationError.invalidRoute(
                "The managed route has too many custom parameters"
            )
        }
        var items: [(String, String)] = []
        var aggregateDecodedBytes = 0
        for rawItem in rawItems {
            let pieces = rawItem.split(
                separator: "=",
                maxSplits: 1,
                omittingEmptySubsequences: false
            )
            guard pieces.count == 2 else {
                throw HotUpdaterSparklingNavigationError.invalidRoute(
                    "Every managed route query item requires a value"
                )
            }
            let key = try decodeFormComponent(String(pieces[0]))
            let value = try decodeFormComponent(String(pieces[1]))
            guard key.utf8.count <= maximumDecodedKeyBytes,
                  value.utf8.count <= maximumDecodedValueBytes else {
                throw HotUpdaterSparklingNavigationError.invalidRoute(
                    "A managed route parameter exceeds its decoded UTF-8 byte limit"
                )
            }
            aggregateDecodedBytes += key.utf8.count + value.utf8.count
            guard aggregateDecodedBytes
                    <= maximumAggregateDecodedQueryBytes else {
                throw HotUpdaterSparklingNavigationError.invalidRoute(
                    "The managed route query exceeds its aggregate decoded UTF-8 byte limit"
                )
            }
            items.append((key, value))
        }
        let reproduced = items.map {
            encodeFormComponent($0.0) + "=" + encodeFormComponent($0.1)
        }.joined(separator: "&")
        guard reproduced == rawQuery,
              items.first?.0 == "bundle",
              items.filter({ $0.0 == "bundle" }).count == 1 else {
            throw HotUpdaterSparklingNavigationError.invalidRoute(
                "The managed route is not canonical"
            )
        }
        let entry = items[0].1
        guard entry.range(of: pagePattern, options: .regularExpression)
                != nil else {
            throw HotUpdaterSparklingNavigationError.invalidRoute(
                "The managed page entry is not canonical"
            )
        }
        guard allowlistedEntries.contains(entry) else {
            throw HotUpdaterSparklingNavigationError.unknownPage(entry)
        }
        var names = Set(["bundle"])
        var parameters: [HotUpdaterSparklingParameter] = []
        for item in items.dropFirst() {
            guard !reservedParameters.contains(item.0), item.0 != "bundle",
                  names.insert(item.0).inserted else {
                throw HotUpdaterSparklingNavigationError.invalidRoute(
                    "Reserved or duplicate managed route parameter"
                )
            }
            parameters.append(.init(name: item.0, value: item.1))
        }
        return HotUpdaterSparklingRoute(
            entry: entry,
            parameters: parameters
        )
    }

    private static func decodeFormComponent(_ raw: String) throws -> String {
        let bytes = Array(raw.utf8)
        var decoded: [UInt8] = []
        var index = 0
        while index < bytes.count {
            switch bytes[index] {
            case 0x2b:
                decoded.append(0x20)
                index += 1
            case 0x25:
                guard index + 2 < bytes.count,
                      let high = hex(bytes[index + 1]),
                      let low = hex(bytes[index + 2]) else {
                    throw HotUpdaterSparklingNavigationError.invalidRoute(
                        "Malformed route percent escape"
                    )
                }
                decoded.append(high << 4 | low)
                index += 3
            default:
                guard bytes[index] < 0x80 else {
                    throw HotUpdaterSparklingNavigationError.invalidRoute(
                        "A canonical route percent-encodes non-ASCII bytes"
                    )
                }
                decoded.append(bytes[index])
                index += 1
            }
        }
        guard let value = String(bytes: decoded, encoding: .utf8) else {
            throw HotUpdaterSparklingNavigationError.invalidRoute(
                "Managed route query is not valid UTF-8"
            )
        }
        return value
    }

    private static func encodeFormComponent(_ value: String) -> String {
        var result = ""
        for byte in value.utf8 {
            switch byte {
            case 0x41...0x5a, 0x61...0x7a, 0x30...0x39,
                 0x2a, 0x2d, 0x2e, 0x5f:
                result.append(Character(UnicodeScalar(byte)))
            case 0x20:
                result.append("+")
            default:
                result += String(format: "%%%02X", byte)
            }
        }
        return result
    }

    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 0x30...0x39: return byte - 0x30
        case 0x41...0x46: return byte - 0x41 + 10
        case 0x61...0x66: return byte - 0x61 + 10
        default: return nil
        }
    }
}

public struct HotUpdaterSparklingOpenOptions: Equatable {
    public let animated: Bool

    public init(
        replace: Bool = false,
        replaceType: String? = nil,
        useSystemBrowser: Bool = false,
        animated: Bool = false,
        interceptor: String? = nil,
        extraPresent: Bool = false,
        unknownKeys: Set<String> = []
    ) throws {
        guard !replace, replaceType == nil, !useSystemBrowser,
              interceptor == nil, !extraPresent, unknownKeys.isEmpty else {
            throw HotUpdaterSparklingNavigationError.invalidOptions(
                "Managed navigation supports push and boolean animation only"
            )
        }
        self.animated = animated
    }
}

public struct HotUpdaterSparklingLogicalPage: Codable, Equatable {
    public let entry: String
    public let parameters: [HotUpdaterSparklingParameter]

    public init(
        entry: String,
        parameters: [HotUpdaterSparklingParameter] = []
    ) {
        self.entry = entry
        self.parameters = parameters
    }
}

public enum HotUpdaterSparklingStackContract {
    public static let maximumPageCount = 16

    public static func validatePageCount(_ count: Int) throws {
        guard count <= maximumPageCount else {
            throw HotUpdaterSparklingNavigationError.reconstructionFailed(
                "A managed native stack supports at most \(maximumPageCount) pages"
            )
        }
    }

    public static func validateReconstruction(
        _ pages: [HotUpdaterSparklingLogicalPage],
        allowlistedEntries: Set<String>
    ) throws {
        guard !pages.isEmpty else {
            throw HotUpdaterSparklingNavigationError.reconstructionFailed(
                "A managed generation requires a primary page"
            )
        }
        try validatePageCount(pages.count)
        for page in pages where !allowlistedEntries.contains(page.entry) {
            throw HotUpdaterSparklingNavigationError.reconstructionFailed(
                "The selected release cannot supply \(page.entry)"
            )
        }
    }

    public static func authorizeTop(
        sourceContextId: String?,
        requestedContainerId: String?,
        topContextId: String,
        topContainerId: String
    ) throws {
        guard let sourceContextId else {
            throw HotUpdaterSparklingNavigationError.staleSource
        }
        guard sourceContextId == topContextId else {
            throw HotUpdaterSparklingNavigationError.nonTopSource
        }
        if let requestedContainerId,
           requestedContainerId != topContainerId {
            throw HotUpdaterSparklingNavigationError.nonTopSource
        }
    }
}

public final class HotUpdaterSparklingPageAdmission {
    public enum Terminal: String, Equatable {
        case admitted
        case fatal
        case cancelled
        case interrupted
    }

    public let requiredResources: Set<String>
    public private(set) var terminal: Terminal?
    private var loadedResources = Set<String>()
    private var firstContent = false
    private var appReady = false

    public init(requiredResources: Set<String>) {
        precondition(!requiredResources.isEmpty)
        self.requiredResources = requiredResources
    }

    @discardableResult
    public func observeResource(_ path: String) -> Bool {
        guard terminal == nil, requiredResources.contains(path) else {
            return false
        }
        loadedResources.insert(path)
        return admitIfReady()
    }

    @discardableResult
    public func observeFirstContent() -> Bool {
        guard terminal == nil else { return false }
        firstContent = true
        return admitIfReady()
    }

    @discardableResult
    public func observeAppReady() -> Bool {
        guard terminal == nil else { return false }
        appReady = true
        return admitIfReady()
    }

    @discardableResult
    public func finish(_ outcome: Terminal) -> Bool {
        guard terminal == nil else { return false }
        terminal = outcome
        return true
    }

    private func admitIfReady() -> Bool {
        guard terminal == nil, firstContent, appReady,
              requiredResources.isSubset(of: loadedResources) else {
            return false
        }
        terminal = .admitted
        return true
    }
}
