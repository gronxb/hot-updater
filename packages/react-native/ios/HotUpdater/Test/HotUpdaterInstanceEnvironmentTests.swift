#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct HotUpdaterInstanceEnvironmentTests {
    @Test(arguments: ["main", "widget", "a", "checkout-2", String(repeating: "a", count: 32)])
    func acceptsAName(name: String) throws {
        #expect(try HotUpdaterInstanceEnvironment(name: name, bundle: namedTestBundle).name == name)
    }

    @Test
    func aNamedInstanceNeedsABundleOtherThanMains() {
        // Main's runtime is told apart by the bundle it runs.
        #expect(throws: NativeUpdateCheckError.self) {
            try HotUpdaterInstanceEnvironment(name: "widget", bundle: .main)
        }
        #expect(throws: Never.self) { try HotUpdaterInstanceEnvironment(name: "main", bundle: .main) }
    }

    @Test(arguments: ["", "Widget", "WIDGET", String(repeating: "a", count: 33), "a/b", "../main", "a_b", "a b", "위젯"])
    func refusesAName(name: String) {
        #expect(throws: NativeUpdateCheckError.self) {
            try HotUpdaterInstanceEnvironment(name: name, bundle: namedTestBundle)
        }
    }

    @Test
    func mainKeepsTheFirstBundleItIsGiven() throws {
        let framework = try makeBundle(info: [:])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        let main = HotUpdaterMainBundle(config: config)

        try main.claim(framework)
        try main.claim(framework)
        #expect(config.bundle == framework)
        // Main's state was keyed by the framework's Info.plist.
        #expect(throws: NativeUpdateCheckError.self) { try main.claim(.main) }
        #expect(config.bundle == framework)
    }

    @Test
    func aLaunchRecordsMainsBundleForLaterInstances() throws {
        let framework = try makeBundle(info: [:])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        let main = HotUpdaterMainBundle(config: config)

        main.note(framework)
        #expect(throws: NativeUpdateCheckError.self) { try main.claim(.main) }
        try main.claim(framework)

        // The static launch API records whatever it is given, as it always has.
        main.note(.main)
        #expect(config.bundle == .main)
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
        #expect(try !HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle).isMain)
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
        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle)

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
        #expect(main.isolationKey(appVersion: "1.0", minBundleId: minBundleId)
            == "hotupdater_plist-hash_\(minBundleId)_brownfield_")

        legacy(config).configureWithFingerprintHash("override-hash", publicKey: "override-key", channel: "beta", isolationKey: nil)
        #expect(main.fingerprintHash() == "override-hash")
        #expect(main.defaultChannel() == "beta")
        #expect(main.publicKey() == "override-key")
        #expect(main.isolationKey(appVersion: nil, minBundleId: minBundleId)
            == "hotupdater_override-hash_\(minBundleId)_beta_")

        // An empty programmatic fingerprint has always meant none for the key.
        legacy(config).fingerprintHash = ""
        #expect(main.isolationKey(appVersion: "1.0", minBundleId: minBundleId) == "hotupdater_1.0_beta_")
        #expect(main.updateStrategy() == .appVersion)

        legacy(config).isolationKey = "custom_"
        #expect(main.isolationKey(appVersion: "1.0", minBundleId: minBundleId) == "custom_")
    }

    // MARK: - Isolation key

    @Test
    func theFingerprintKeyHasTheMinBundleIdAndNoAppVersion() throws {
        let framework = try makeBundle(info: ["HOT_UPDATER_FINGERPRINT_HASH": "plist-hash"])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        config.bundle = framework
        let main = try HotUpdaterInstanceEnvironment(name: "main", bundle: .main, config: config)
        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: framework, config: config)

        for environment in [main, widget] {
            let key = environment.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId)
            #expect(key.contains("plist-hash_\(minBundleId)_production_"))
            #expect(!key.contains("1.0.0"))
            // A host release that ships the same artifact keeps its key...
            #expect(environment.isolationKey(appVersion: "2.0.0", minBundleId: minBundleId) == key)
            // ...and a new build of the artifact, with a new min id, does not.
            #expect(environment.isolationKey(appVersion: "1.0.0", minBundleId: newerMinBundleId) != key)
        }
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId)
            == "hotupdater_plist-hash_\(minBundleId)_production_")
        #expect(widget.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId)
            == "hotupdater_instance_widget_plist-hash_\(minBundleId)_production_")
        // Never an empty field in the key.
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: " ")
            == "hotupdater_plist-hash_unknown_production_")
    }

    @Test
    func theAppVersionKeyIsUnchanged() throws {
        let bare = try makeBundle(info: [:])
        defer { try? FileManager.default.removeItem(at: bare.bundleURL) }
        let config = HotUpdaterConfig()
        let main = try HotUpdaterInstanceEnvironment(name: "main", bundle: .main, config: config)
        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: bare, config: config)

        #expect(main.updateStrategy() == .appVersion)
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId) == "hotupdater_1.0.0_production_")
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: newerMinBundleId) == "hotupdater_1.0.0_production_")
        #expect(main.isolationKey(appVersion: nil, minBundleId: minBundleId) == "hotupdater_unknown_production_")
        #expect(widget.isolationKey(appVersion: "1.0.0", minBundleId: newerMinBundleId)
            == "hotupdater_instance_widget_1.0.0_production_")
    }

    @Test
    func anExplicitIsolationKeyStillWins() throws {
        let config = HotUpdaterConfig()
        legacy(config).configureWithFingerprintHash("override-hash", publicKey: nil, channel: "beta", isolationKey: "custom_")
        let main = try HotUpdaterInstanceEnvironment(name: "main", bundle: .main, config: config)

        #expect(main.updateStrategy() == .fingerprint)
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId) == "custom_")
        #expect(main.isolationKey(appVersion: "2.0.0", minBundleId: newerMinBundleId) == "custom_")
        // Main's own key: options leave it alone, and a named instance never uses it.
        try HotUpdaterMainBundle(config: config).claim(
            HotUpdaterOptions(baseURL: "https://example.com", fingerprintHash: "override-hash")
        )
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId) == "custom_")
        #expect(try HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle, config: config)
            .isolationKey(appVersion: "1.0.0", minBundleId: minBundleId) == "hotupdater_instance_widget_1.0.0_production_")
    }

    // MARK: - Main's options

    @Test
    func mainHonorsItsOptions() throws {
        let framework = try makeBundle(info: [
            "HOT_UPDATER_CHANNEL": "plist-channel",
            "HOT_UPDATER_FINGERPRINT_HASH": "plist-hash",
            "HOT_UPDATER_PUBLIC_KEY": "plist-key",
        ])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        let claims = HotUpdaterMainBundle(config: config)

        try claims.claim(HotUpdaterOptions(
            baseURL: "https://example.com",
            bundle: framework,
            channel: "beta",
            fingerprintHash: "option-hash",
            publicKey: "option-key"
        ))

        let main = HotUpdaterInstanceEnvironment.main(config: config)
        #expect(main.bundle == framework)
        #expect(main.defaultChannel() == "beta")
        #expect(main.fingerprintHash() == "option-hash")
        #expect(main.publicKey() == "option-key")
        #expect(main.updateStrategy() == .fingerprint)
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId)
            == "hotupdater_option-hash_\(minBundleId)_beta_")

        // An option left nil (or empty) reads the bundle's Info.plist.
        let plistOnly = HotUpdaterConfig()
        try HotUpdaterMainBundle(config: plistOnly).claim(HotUpdaterOptions(
            baseURL: "https://example.com",
            bundle: framework,
            channel: "",
            publicKey: "option-key"
        ))
        let plistMain = HotUpdaterInstanceEnvironment.main(config: plistOnly)
        #expect(plistMain.defaultChannel() == "plist-channel")
        #expect(plistMain.fingerprintHash() == "plist-hash")
        #expect(plistMain.publicKey() == "option-key")
    }

    @Test
    func mainOptionsConflictingWithEarlierOptionsThrow() throws {
        let config = HotUpdaterConfig()
        let claims = HotUpdaterMainBundle(config: config)
        try claims.claim(.main, channel: "beta", fingerprintHash: "hash", publicKey: "key")

        // The same values, or none, are the same instance.
        try claims.claim(.main, channel: "beta", fingerprintHash: "hash", publicKey: "key")
        try claims.claim(.main)
        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(.main, channel: "alpha") }
        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(.main, fingerprintHash: "other-hash") }
        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(.main, publicKey: "other-key") }
        // A throwing claim records nothing.
        #expect(throws: NativeUpdateCheckError.self) {
            try claims.claim(.main, channel: "beta", fingerprintHash: "hash", publicKey: "other-key")
        }
        #expect(config.overrides == HotUpdaterConfig.Overrides(fingerprintHash: "hash", publicKey: "key", channel: "beta"))
    }

    @Test
    func mainOptionsConflictingWithConfigureThrow() throws {
        let config = HotUpdaterConfig()
        legacy(config).configureWithFingerprintHash("configured-hash", publicKey: "configured-key", channel: "configured", isolationKey: nil)
        let claims = HotUpdaterMainBundle(config: config)

        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(.main, channel: "beta") }
        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(.main, fingerprintHash: "option-hash") }
        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(.main, publicKey: "option-key") }
        try claims.claim(.main, channel: "configured", fingerprintHash: "configured-hash", publicKey: "configured-key")
    }

    @Test
    func mainOptionsAfterMainsImplExistsMustMatchIt() throws {
        let framework = try makeBundle(info: [
            "HOT_UPDATER_CHANNEL": "plist-channel",
            "HOT_UPDATER_FINGERPRINT_HASH": "plist-hash",
        ])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        config.bundle = framework
        let claims = HotUpdaterMainBundle(config: config)
        claims.note(framework)

        // As HotUpdater.bundleURL(bundle:) creates main's impl.
        claims.noteImplCreated()

        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(framework, channel: "beta") }
        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(framework, fingerprintHash: "option-hash") }
        // The impl was created without a public key, so signing stays off.
        #expect(throws: NativeUpdateCheckError.self) { try claims.claim(framework, publicKey: "option-key") }
        try claims.claim(framework, channel: "plist-channel", fingerprintHash: "plist-hash")
        try claims.claim(framework)
        #expect(config.overrides == HotUpdaterConfig.Overrides())

        // The values the impl was created with, not a configure call after it.
        let recorded = HotUpdaterConfig()
        let recordedClaims = HotUpdaterMainBundle(config: recorded)
        try recordedClaims.claim(.main, channel: "beta")
        recordedClaims.noteImplCreated()
        legacy(recorded).configureWithFingerprintHash(nil, publicKey: nil, channel: "alpha", isolationKey: nil)
        #expect(throws: NativeUpdateCheckError.self) { try recordedClaims.claim(.main, channel: "alpha") }
        try recordedClaims.claim(.main, channel: "beta")
    }

    @Test
    func mainOptionsLeftNilKeepTheConfigureValues() throws {
        let config = HotUpdaterConfig()
        legacy(config).configureWithFingerprintHash("configured-hash", publicKey: "configured-key", channel: "configured", isolationKey: "configured_")

        try HotUpdaterMainBundle(config: config).claim(HotUpdaterOptions(baseURL: "https://example.com"))

        let main = HotUpdaterInstanceEnvironment.main(config: config)
        #expect(main.defaultChannel() == "configured")
        #expect(main.fingerprintHash() == "configured-hash")
        #expect(main.publicKey() == "configured-key")
        #expect(main.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId) == "configured_")
    }

    @Test
    func configureOverMainsOptionsWarnsOnceNamingTheChangedValues() throws {
        let logs = LogRecorder()
        let config = HotUpdaterConfig(log: logs.append)
        let claims = HotUpdaterMainBundle(config: config)
        let pem = "-----BEGIN PUBLIC KEY-----\noption\n-----END PUBLIC KEY-----"
        try claims.claim(.main, channel: "beta", fingerprintHash: "option-hash", publicKey: pem)

        legacy(config).configureWithFingerprintHash("configured-hash", publicKey: "configured-key", channel: "alpha", isolationKey: nil)

        // It still replaces them, as it always has.
        #expect(config.overrides == HotUpdaterConfig.Overrides(
            fingerprintHash: "configured-hash", publicKey: "configured-key", channel: "alpha"
        ))
        #expect(logs.messages.count == 1)
        let message = try #require(logs.messages.first)
        #expect(message.contains("channel \"beta\" -> \"alpha\""))
        #expect(message.contains("fingerprintHash \"option-hash\" -> \"configured-hash\""))
        #expect(message.contains("publicKey"))
        #expect(message.contains("HotUpdaterOptions"))
        #expect(!message.contains("BEGIN PUBLIC KEY") && !message.contains("configured-key"))

        // The values now belong to configure.
        legacy(config).configureWithFingerprintHash(nil, publicKey: nil, channel: "gamma", isolationKey: nil)
        #expect(logs.messages.count == 1)

        // Until options set them again.
        try claims.claim(.main, channel: "gamma")
        legacy(config).configureWithFingerprintHash(nil, publicKey: nil, channel: "delta", isolationKey: nil)
        #expect(logs.messages.count == 2)
        let changes = try #require(logs.messages.last?.components(separatedBy: ". configure is deprecated").first)
        #expect(changes.hasSuffix("channel \"gamma\" -> \"delta\""))
        #expect(!changes.contains("fingerprintHash") && !changes.contains("publicKey"))
    }

    @Test
    func configureWithoutOptionsOrChangesDoesNotWarn() throws {
        let logs = LogRecorder()
        let config = HotUpdaterConfig(log: logs.append)
        legacy(config).configureWithFingerprintHash("hash", publicKey: "key", channel: "beta", isolationKey: nil)
        legacy(config).configureWithFingerprintHash(nil, publicKey: nil, channel: "alpha", isolationKey: nil)
        #expect(logs.messages.isEmpty)

        // Options that set only the channel; configure keeps it and sets
        // what the options left alone.
        try HotUpdaterMainBundle(config: config).claim(.main, channel: "alpha")
        legacy(config).configureWithFingerprintHash("hash", publicKey: "key", channel: "alpha", isolationKey: "custom_")
        #expect(logs.messages.isEmpty)
        #expect(config.overrides.fingerprintHash == "hash")
    }

    // MARK: - Named instances' options

    @Test
    func aNamedInstanceOfTheSameNameMustHaveTheSameOptions() throws {
        let first = try HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle, channel: "beta")

        #expect(first.hasSameConfiguration(try HotUpdaterInstanceEnvironment(
            name: "widget", bundle: namedTestBundle, channel: "beta"
        )))
        #expect(!first.hasSameConfiguration(try HotUpdaterInstanceEnvironment(
            name: "widget", bundle: namedTestBundle, channel: "alpha"
        )))
        #expect(!first.hasSameConfiguration(try HotUpdaterInstanceEnvironment(
            name: "widget", bundle: namedTestBundle
        )))
        #expect(!first.hasSameConfiguration(try HotUpdaterInstanceEnvironment(
            name: "widget", bundle: namedTestBundle, channel: "beta", fingerprintHash: "hash"
        )))
        #expect(!first.hasSameConfiguration(try HotUpdaterInstanceEnvironment(
            name: "widget", bundle: namedTestBundle, channel: "beta", publicKey: "key"
        )))
        let other = try makeBundle(info: [:])
        defer { try? FileManager.default.removeItem(at: other.bundleURL) }
        #expect(!first.hasSameConfiguration(try HotUpdaterInstanceEnvironment(
            name: "widget", bundle: other, channel: "beta"
        )))
    }

    @Test
    func aNamedInstanceReadsItsOptionsOverItsOwnBundle() throws {
        let framework = try makeBundle(info: [
            "HOT_UPDATER_CHANNEL": "widget-channel",
            "HOT_UPDATER_FINGERPRINT_HASH": "widget-hash",
            "HOT_UPDATER_PUBLIC_KEY": "widget-key",
        ])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }

        let widget = try HotUpdaterInstanceEnvironment(options: HotUpdaterOptions(
            baseURL: "https://example.com",
            bundle: framework,
            name: "widget",
            channel: "option-channel",
            fingerprintHash: "option-hash",
            publicKey: "option-key"
        ), config: HotUpdaterConfig())

        #expect(widget.defaultChannel() == "option-channel")
        #expect(widget.fingerprintHash() == "option-hash")
        #expect(widget.publicKey() == "option-key")
        #expect(widget.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId)
            == "hotupdater_instance_widget_option-hash_\(minBundleId)_option-channel_")
    }

    @Test
    func aNamedInstanceDoesNotInheritMainsOptions() throws {
        let bare = try makeBundle(info: [:])
        defer { try? FileManager.default.removeItem(at: bare.bundleURL) }
        let config = HotUpdaterConfig()
        try HotUpdaterMainBundle(config: config).claim(
            .main, channel: "main-channel", fingerprintHash: "main-hash", publicKey: "main-key"
        )

        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: bare, config: config)
        #expect(widget.defaultChannel() == "production")
        #expect(widget.fingerprintHash() == nil)
        #expect(widget.publicKey() == nil)
        #expect(widget.updateStrategy() == .appVersion)
        #expect(widget.isolationKey(appVersion: "1.0.0", minBundleId: minBundleId)
            == "hotupdater_instance_widget_1.0.0_production_")
        // Main's, recorded in config.
        #expect(HotUpdaterInstanceEnvironment.main(config: config).defaultChannel() == "main-channel")
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
        legacy(config).configureWithFingerprintHash("main-hash", publicKey: "main-key", channel: "main-channel", isolationKey: "main_")

        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: framework, config: config)
        #expect(widget.bundle == framework)
        #expect(widget.fingerprintHash() == "widget-hash")
        #expect(widget.defaultChannel() == "widget-channel")
        #expect(widget.publicKey() == "widget-key")
        #expect(widget.updateStrategy() == .fingerprint)
        #expect(widget.isolationKey(appVersion: "1.0", minBundleId: minBundleId)
            == "hotupdater_instance_widget_widget-hash_\(minBundleId)_widget-channel_")

        let checkout = try HotUpdaterInstanceEnvironment(name: "checkout", bundle: bare, config: config)
        #expect(checkout.fingerprintHash() == nil)
        #expect(checkout.defaultChannel() == "production")
        #expect(checkout.publicKey() == nil)
        #expect(checkout.updateStrategy() == .appVersion)
        #expect(checkout.isolationKey(appVersion: "1.0", minBundleId: minBundleId)
            == "hotupdater_instance_checkout_1.0_production_")
    }

    @Test
    func preferencesOfMainAndANamedInstanceStayApart() throws {
        let suiteName = "HotUpdaterInstanceEnvironmentTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let config = HotUpdaterConfig()
        let main = VersionedPreferencesService(userDefaults: defaults)
        main.configure(isolationKey: try HotUpdaterInstanceEnvironment(name: "main", bundle: .main, config: config)
            .isolationKey(appVersion: "1.0", minBundleId: minBundleId))
        let widget = VersionedPreferencesService(userDefaults: defaults)
        widget.configure(isolationKey: try HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle, config: config)
            .isolationKey(appVersion: "1.0", minBundleId: minBundleId))

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
        let widgetDirectory = try HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle)
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

private let minBundleId = "0199b0f2-6c3a-7000-8000-000000000001"
private let newerMinBundleId = "0199c4e1-0f2b-7000-8000-000000000002"

/// The deprecated programmatic config, through a protocol so the tests that
/// keep it working don't warn.
protocol LegacyHotUpdaterConfig: AnyObject {
    var fingerprintHash: String? { get set }
    var isolationKey: String? { get set }
    func configureWithFingerprintHash(_ fingerprintHash: String?, publicKey: String?, channel: String?, isolationKey: String?)
}

extension HotUpdaterConfig: LegacyHotUpdaterConfig {}

func legacy(_ config: HotUpdaterConfig) -> LegacyHotUpdaterConfig { config }

final class LogRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _messages: [String] = []

    var messages: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _messages
    }

    func append(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        _messages.append(message)
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

/// A bundle other than `Bundle.main`, which a named instance needs.
let namedTestBundle: Bundle = {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("hot-updater-named-instance-\(UUID().uuidString).bundle", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return Bundle(path: url.path)!
}()

