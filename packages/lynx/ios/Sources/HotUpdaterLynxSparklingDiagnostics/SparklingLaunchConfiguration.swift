import Foundation

/** String launch properties exposed to the managed Lynx application. */
public enum HotUpdaterSparklingLaunchConfiguration {
    public static let argumentPrefix =
        "--hot-updater-launch-configuration="

    public static func parse(arguments: [String]) throws -> [String: String] {
        guard let argument = arguments.first(where: {
            $0.hasPrefix(argumentPrefix)
        }) else { return [:] }
        let encoded = String(argument.dropFirst(argumentPrefix.count))
        guard let data = encoded.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data)
                as? [String: Any],
              object.keys.allSatisfy({ !$0.isEmpty }),
              object.values.allSatisfy({ $0 is String }) else {
            throw NSError(
                domain: "HotUpdaterSparklingLaunchConfiguration",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey:
                    "Lynx launch configuration must be a JSON string map"]
            )
        }
        return object.mapValues { $0 as! String }
    }
}
