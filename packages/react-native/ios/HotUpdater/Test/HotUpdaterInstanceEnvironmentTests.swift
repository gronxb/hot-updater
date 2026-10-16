#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct HotUpdaterInstanceEnvironmentTests {
    @Test(arguments: ["main", "widget", "a", "checkout-2", String(repeating: "a", count: 32)])
    func acceptsAName(name: String) throws {
        #expect(try HotUpdaterInstanceEnvironment(name: name, bundle: .main).name == name)
    }

    @Test(arguments: ["", "Widget", "WIDGET", String(repeating: "a", count: 33), "a/b", "../main", "a_b", "a b", "위젯"])
    func refusesAName(name: String) {
        #expect(throws: NativeUpdateCheckError.self) {
            try HotUpdaterInstanceEnvironment(name: name, bundle: .main)
        }
    }

    @Test
    func mainIsMainWhateverBundleItIsGiven() throws {
        let framework = try makeBundle(info: [:])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        config.bundle = framework

        let main = try HotUpdaterInstanceEnvironment(name: "main", bundle: .main, config: config)

        #expect(main.isMain)
        // Main reads the bundle HotUpdaterConfig recorded, as before.
        #expect(main.bundle == framework)
        #expect(try !HotUpdaterInstanceEnvironment(name: "widget", bundle: .main).isMain)
    }

    @Test
    func mainKeepsTodaysPaths() {
        let documents = "/app/Documents"
        let fileSystem = PathsFileSystemService(
            documents: documents,
            applicationSupport: "/app/Library/Application Support"
        )
        let main = HotUpdaterInstanceEnvironment.main

        #expect(main.storageRootPath(documentsPath: documents) == "/app/Documents")
        #expect(main.bundleStorePath(documentsPath: documents) == "/app/Documents/bundle-store")
        #expect(main.tempPath(documentsPath: documents) == "/app/Documents/bundle-temp")
        #expect(main.keyValueStorageDirectory(in: fileSystem).path
            == "/app/Library/Application Support/HotUpdater")
        let defaultCacheDirectory = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
            .appendingPathComponent("HotUpdater", isDirectory: true)
            .appendingPathComponent("ReleaseCatalogCache", isDirectory: true)
        #expect(main.releaseCatalogCacheDirectory(in: fileSystem) == defaultCacheDirectory)
        #expect(main.backgroundSessionIdentifier == "com.hotupdater.background.download")
    }

    @Test
    func aNamedInstanceKeepsItsStateBesideMains() throws {
        let documents = "/app/Documents"
        let fileSystem = PathsFileSystemService(
            documents: documents,
            applicationSupport: "/app/Library/Application Support"
        )
        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: .main)

        #expect(widget.bundleStorePath(documentsPath: documents)
            == "/app/Documents/hot-updater-instances/widget/bundle-store")
        #expect(widget.tempPath(documentsPath: documents)
            == "/app/Documents/hot-updater-instances/widget/bundle-temp")
        #expect(widget.keyValueStorageDirectory(in: fileSystem).path
            == "/app/Library/Application Support/HotUpdater/instances/widget")
        #expect(widget.releaseCatalogCacheDirectory(in: fileSystem).path
            == "/app/Library/Application Support/HotUpdater/instances/widget/ReleaseCatalogCache")
        #expect(widget.backgroundSessionIdentifier == "com.hotupdater.background.download.widget")
        // Never inside main's store, whose sweeps delete unknown entries.
        #expect(!widget.bundleStorePath(documentsPath: documents)
            .hasPrefix(HotUpdaterInstanceEnvironment.main.bundleStorePath(documentsPath: documents) + "/"))
    }

    @Test
    func mainKeepsTodaysConfigAndIsolationKey() throws {
        let framework = try makeBundle(info: [
            "HOT_UPDATER_CHANNEL": "brownfield",
            "HOT_UPDATER_FINGERPRINT_HASH": "plist-hash",
            "HOT_UPDATER_PUBLIC_KEY": "plist-key",
        ])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        config.bundle = framework
        let main = try HotUpdaterInstanceEnvironment(name: "main", bundle: .main, config: config)

        #expect(main.fingerprintHash() == "plist-hash")
        #expect(main.defaultChannel() == "brownfield")
        #expect(main.publicKey() == "plist-key")
        #expect(main.updateStrategy() == .fingerprint)
        #expect(main.isolationKey(appVersion: "1.0") == "hotupdater_plist-hash_1.0_brownfield_")

        config.configureWithFingerprintHash("override-hash", publicKey: "override-key", channel: "beta", isolationKey: nil)
        #expect(main.fingerprintHash() == "override-hash")
        #expect(main.defaultChannel() == "beta")
        #expect(main.publicKey() == "override-key")
        #expect(main.isolationKey(appVersion: nil) == "hotupdater_override-hash_unknown_beta_")

        // An empty programmatic fingerprint has always meant none for the key.
        config.fingerprintHash = ""
        #expect(main.isolationKey(appVersion: "1.0") == "hotupdater_1.0_beta_")
        #expect(main.updateStrategy() == .appVersion)

        config.isolationKey = "custom_"
        #expect(main.isolationKey(appVersion: "1.0") == "custom_")
    }

    @Test
    func aNamedInstanceReadsOnlyItsOwnBundle() throws {
        let framework = try makeBundle(info: [
            "HOT_UPDATER_CHANNEL": "widget-channel",
            "HOT_UPDATER_FINGERPRINT_HASH": "widget-hash",
            "HOT_UPDATER_PUBLIC_KEY": "widget-key",
        ])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let bare = try makeBundle(info: [:])
        defer { try? FileManager.default.removeItem(at: bare.bundleURL) }
        // Main's programmatic config never reaches a named instance.
        let config = HotUpdaterConfig()
        config.configureWithFingerprintHash("main-hash", publicKey: "main-key", channel: "main-channel", isolationKey: "main_")

        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: framework, config: config)
        #expect(widget.bundle == framework)
        #expect(widget.fingerprintHash() == "widget-hash")
        #expect(widget.defaultChannel() == "widget-channel")
        #expect(widget.publicKey() == "widget-key")
        #expect(widget.updateStrategy() == .fingerprint)
        #expect(widget.isolationKey(appVersion: "1.0") == "hotupdater_instance_widget_widget-hash_1.0_widget-channel_")

        let checkout = try HotUpdaterInstanceEnvironment(name: "checkout", bundle: bare, config: config)
        #expect(checkout.fingerprintHash() == nil)
        #expect(checkout.defaultChannel() == "production")
        #expect(checkout.publicKey() == nil)
        #expect(checkout.updateStrategy() == .appVersion)
        #expect(checkout.isolationKey(appVersion: "1.0") == "hotupdater_instance_checkout_1.0_production_")
    }

    @Test
    func preferencesOfMainAndANamedInstanceStayApart() throws {
        let suiteName = "HotUpdaterInstanceEnvironmentTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let config = HotUpdaterConfig()
        let main = VersionedPreferencesService(userDefaults: defaults)
        main.configure(isolationKey: try HotUpdaterInstanceEnvironment(name: "main", bundle: .main, config: config)
            .isolationKey(appVersion: "1.0"))
        let widget = VersionedPreferencesService(userDefaults: defaults)
        widget.configure(isolationKey: try HotUpdaterInstanceEnvironment(name: "widget", bundle: .main, config: config)
            .isolationKey(appVersion: "1.0"))

        try main.setItem("beta", forKey: "HotUpdaterChannel")
        #expect(try widget.getItem(forKey: "HotUpdaterChannel") == nil)
        try widget.setItem("canary", forKey: "HotUpdaterChannel")
        try main.setItem(nil, forKey: "HotUpdaterChannel")
        #expect(try widget.getItem(forKey: "HotUpdaterChannel") == "canary")
        #expect(defaults.dictionaryRepresentation().keys.contains("hotupdater_instance_widget_1.0_production_HotUpdaterChannel"))
    }

    @Test
    func theKeyValueStoreAndItsEventQueueArePerName() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("HotUpdaterInstanceEnvironmentTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fileSystem = PathsFileSystemService(
            documents: root.appendingPathComponent("Documents").path,
            applicationSupport: root.appendingPathComponent("Application Support").path
        )
        let main = KeyValueStorageService(
            directory: HotUpdaterInstanceEnvironment.main.keyValueStorageDirectory(in: fileSystem)
        )
        let widgetDirectory = try HotUpdaterInstanceEnvironment(name: "widget", bundle: .main)
            .keyValueStorageDirectory(in: fileSystem)

        #expect(KeyValueStorageService(directory: widgetDirectory).setItem("queue", value: "[\"widget\"]"))
        #expect(main.setItem("queue", value: "[\"main\"]"))

        // A fresh read of each file, as the next process makes.
        #expect(KeyValueStorageService(directory: widgetDirectory).getItem("queue") == "[\"widget\"]")
        #expect(KeyValueStorageService(
            directory: HotUpdaterInstanceEnvironment.main.keyValueStorageDirectory(in: fileSystem)
        ).getItem("queue") == "[\"main\"]")
    }

    private func makeBundle(info: [String: String]) throws -> Bundle {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("HotUpdaterInstanceEnvironmentTests-\(UUID().uuidString).framework")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var plist: [String: String] = [
            "CFBundleIdentifier": "dev.hot-updater.tests.\(UUID().uuidString)",
            "CFBundlePackageType": "FMWK",
        ]
        plist.merge(info) { _, new in new }
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url.appendingPathComponent("Info.plist"))
        return try #require(Bundle(url: url))
    }
}

/// Only the two base directories matter to the environment's paths.
private final class PathsFileSystemService: FileSystemService {
    private let documents: String
    private let applicationSupport: String

    init(documents: String, applicationSupport: String) {
        self.documents = documents
        self.applicationSupport = applicationSupport
    }

    func fileExists(atPath path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
    func createDirectory(atPath path: String) -> Bool {
        (try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)) != nil
    }
    func removeItem(atPath path: String) throws { try FileManager.default.removeItem(atPath: path) }
    func moveItem(atPath srcPath: String, toPath dstPath: String) throws {
        try FileManager.default.moveItem(atPath: srcPath, toPath: dstPath)
    }
    func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        try FileManager.default.copyItem(atPath: srcPath, toPath: dstPath)
    }
    func contentsOfDirectory(atPath path: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: path)
    }
    func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        try FileManager.default.attributesOfItem(atPath: path)
    }
    func documentsPath() -> String { documents }
    func applicationSupportPath() -> String { applicationSupport }
}
#endif
