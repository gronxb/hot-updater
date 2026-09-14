import Foundation
import HotUpdaterLynxSparkling
import SwiftUI

/** Native scaffold configuration for the packaged Sparkling integration. */
final class PublicHost {
    static let runtimeId =
        "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1"
    static var shared: PublicHost?

    let managed: HotUpdaterSparklingHost

    private static func productionLaunchConfiguration() -> [String: String] {
        guard let value = Bundle.main.object(
            forInfoDictionaryKey: "HOT_UPDATER_APP_BASE_URL"
        ) as? String, !value.isEmpty else {
            return [:]
        }
        let components = URLComponents(string: value)
        let host = components?.host?.lowercased() ?? ""
        let reservedSuffixes = [
            ".localhost", ".local", ".test", ".example", ".invalid",
        ]
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              components?.scheme == "https", !host.isEmpty,
              components?.user == nil, components?.password == nil,
              components?.fragment == nil, host != "localhost",
              host != "0.0.0.0", !host.hasPrefix("127."), host != "::1",
              !reservedSuffixes.contains(where: host.hasSuffix) else {
            NSLog("HOT_UPDATER_APP_BASE_URL must be a nonlocal HTTPS URL without credentials or a fragment")
            return [:]
        }
        return ["appBaseURL": value]
    }

    init() throws {
        let home = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("HotUpdaterLynxPublic")
        try FileManager.default.createDirectory(
            at: home,
            withIntermediateDirectories: true
        )
        let productionEmbedded = Bundle.main.resourceURL!
            .appendingPathComponent("ProductionEmbedded")
        let embeddedRoot = (FileManager.default.fileExists(
            atPath: productionEmbedded.path
        ) ? productionEmbedded : Bundle.main.resourceURL!
            .appendingPathComponent("Embedded"))
            .appendingPathComponent("Public")
        let embeddedDirectory = embeddedRoot.appendingPathComponent("react")
        let native = try HotUpdaterSparklingEmbeddedDescriptor(
            data: Data(contentsOf: embeddedRoot.appendingPathComponent(
                "react-native.json"
            ))
        )
        guard native.runtimeId == Self.runtimeId,
              native.variant == "sdk3" else {
            throw HotUpdaterSparklingError.invalidEmbeddedArtifact
        }
        let configuration = try HotUpdaterSparklingConfiguration(
            storeURL: home.appendingPathComponent("stores"),
            runtimeId: Self.runtimeId,
            embeddedDirectory: embeddedDirectory,
            embeddedBundleId: native.bundleId,
            embeddedManifestDigest: native.manifestDigest,
            minimumBundleId: native.minimumBundleId,
            appVersion: "1.0.0",
            channel: "ota-react",
            cohort: "1",
            publicKeyPEM: Bundle.main.object(
                forInfoDictionaryKey: "HOT_UPDATER_PUBLIC_KEY"
            ) as? String,
            fingerprintHash: Bundle.main.object(
                forInfoDictionaryKey: "HOT_UPDATER_FINGERPRINT_HASH"
            ) as? String
        )
#if HOT_UPDATER_LYNX_DIAGNOSTICS
        let launchConfiguration = try HotUpdaterSparklingLaunchConfiguration
            .parse(arguments: ProcessInfo.processInfo.arguments)
#else
        let launchConfiguration = Self.productionLaunchConfiguration()
#endif
        managed = try HotUpdaterSparklingHost(
            configuration: configuration,
            launchConfiguration: launchConfiguration
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
