import Foundation
import HotUpdaterLynxSparkling
import SwiftUI

/** Native scaffold configuration for the packaged Sparkling integration. */
final class PublicHost {
    static let runtimeId =
        "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    static var shared: PublicHost?

    static var requestedFramework: String? {
        let argument = ProcessInfo.processInfo.arguments.first {
            $0.hasPrefix("--ota-framework=")
        }
        guard let name = argument.map({
            String($0.dropFirst("--ota-framework=".count))
        }), ["react", "vue", "octane"].contains(name) else { return nil }
        return name
    }

    static var requestedChannel: String? {
        let argument = ProcessInfo.processInfo.arguments.first {
            $0.hasPrefix("--ota-channel=")
        }
        guard let channel = argument.map({
            String($0.dropFirst("--ota-channel=".count))
        }), !channel.isEmpty else { return nil }
        return channel
    }

    static var requestedEmbeddedDir: URL? {
        let argument = ProcessInfo.processInfo.arguments.first {
            $0.hasPrefix("--ota-embedded-dir=")
        }
        guard let path = argument.map({
            String($0.dropFirst("--ota-embedded-dir=".count))
        }), !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path)
    }

    static var requestedResourceSet: String? {
        ProcessInfo.processInfo.arguments.first {
            $0.hasPrefix("--ota-resource-set=")
        }.map { String($0.dropFirst("--ota-resource-set=".count)) }
    }

    static func startupResources(for resourceSet: String) throws -> Set<String> {
        switch resourceSet {
        case "sdk1": return ["main.lynx.bundle", "assets/probe.png"]
        case "sdk2": return [
            "main.lynx.bundle", "assets/probe.png", "assets/probe.ttf",
            "assets/bootstrap.js",
            "dynamic/component.lynx.bundle",
        ]
        case "sdk3": return [
            "main.lynx.bundle", "assets/probe.png", "assets/probe.ttf",
            "assets/bootstrap.js",
            "dynamic/component.lynx.bundle",
        ]
        default: throw HotUpdaterSparklingError.invalidEmbeddedArtifact
        }
    }

    let managed: HotUpdaterSparklingHost

    init(
        framework: String,
        events: HotUpdaterSparklingEventHandler? = nil
    ) throws {
        let home = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("HotUpdaterLynxPublic")
        try FileManager.default.createDirectory(
            at: home,
            withIntermediateDirectories: true
        )
        let embeddedRoot = Bundle.main.resourceURL!
            .appendingPathComponent("Embedded/Public")
        let embeddedDirectory = Self.requestedEmbeddedDir
            ?? embeddedRoot.appendingPathComponent(framework)
        let native = try JSONSerialization.jsonObject(
            with: Data(contentsOf: embeddedRoot.appendingPathComponent(
                framework + "-native.json"
            ))
        ) as! [String: String]
        guard native["runtimeId"] == Self.runtimeId,
              let packagedResourceSet = native["variant"],
              let embeddedBundleId = native["bundleId"],
              let minimumBundleId = native["minimumBundleId"],
              let embeddedManifestDigest = native["manifestDigest"] else {
            throw HotUpdaterSparklingError.invalidEmbeddedArtifact
        }
        let startupResources = try Self.startupResources(
            for: Self.requestedResourceSet ?? packagedResourceSet
        )
        let configuration = try HotUpdaterSparklingConfiguration(
            storeURL: home.appendingPathComponent("stores"),
            runtimeId: Self.runtimeId,
            embeddedDirectory: embeddedDirectory,
            embeddedBundleId: embeddedBundleId,
            embeddedManifestDigest: embeddedManifestDigest,
            minimumBundleId: minimumBundleId,
            appVersion: "1.0.0",
            channel: Self.requestedChannel ?? "ota-\(framework)",
            cohort: "1",
            publicKeyPEM: Bundle.main.object(
                forInfoDictionaryKey: "HOT_UPDATER_PUBLIC_KEY"
            ) as? String,
            startupResourcePaths: startupResources,
            fingerprintHash: Bundle.main.object(
                forInfoDictionaryKey: "HOT_UPDATER_FINGERPRINT_HASH"
            ) as? String
        )
        managed = try HotUpdaterSparklingHost(
            configuration: configuration,
            events: events
        )
    }
}

struct PublicView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        do {
            return try PublicHost.shared!.managed.makeViewController()
        } catch {
            preconditionFailure("Could not create managed Lynx view: \(error)")
        }
    }

    func updateUIViewController(
        _ uiViewController: UIViewController,
        context: Context
    ) {}
}
