import Foundation

/// Where one native instance keeps its state, and which config it reads.
///
/// Instances are told apart by `HotUpdaterOptions.name`. `main` is the one
/// the TurboModule and every static API use: it keeps the paths and
/// `HotUpdaterConfig.shared` of an app with a single instance, where main's
/// options are recorded. Any other name keeps its state beside main's, never
/// inside `bundle-store`, whose sweeps delete the entries they don't know,
/// and reads only its options and its own bundle. The install identity and
/// the cohort stay device-level, shared by every name.
struct HotUpdaterInstanceEnvironment {
    static let mainName = "main"
    static let main = HotUpdaterInstanceEnvironment.main(config: .shared)

    static let maxNameLength = 32
    /// `Documents/hot-updater-instances/<name>` holds a named instance's
    /// `bundle-store` and `bundle-temp`.
    static let instancesDirectoryName = "hot-updater-instances"
    /// `Application Support/HotUpdater/instances/<name>` holds a named
    /// instance's key-value store and Release catalog cache.
    static let noBackupInstancesDirectoryName = "instances"
    static let bundleStoreDirectoryName = "bundle-store"
    static let tempDirectoryName = "bundle-temp"
    static let releaseCatalogCacheDirectoryName = "ReleaseCatalogCache"
    static let backgroundSessionIdentifierBase = "com.hotupdater.background.download"
    private static let defaultChannel = "production"

    let name: String
    /// nil for main, which reads its bundle from `config` at each use.
    private let namedBundle: Bundle?
    /// Main's recorded options, programmatic config, and bundle; a named
    /// instance never reads it.
    private let config: HotUpdaterConfig
    /// A named instance's `HotUpdaterOptions` values, over its Info.plist.
    /// Main's options are recorded in `config` instead.
    private let options: HotUpdaterConfig.Overrides

    private init(
        name: String,
        namedBundle: Bundle?,
        config: HotUpdaterConfig,
        options: HotUpdaterConfig.Overrides = HotUpdaterConfig.Overrides()
    ) {
        self.name = name
        self.namedBundle = namedBundle
        self.config = config
        self.options = options
    }

    /// Main, reading `config`.
    static func main(config: HotUpdaterConfig) -> HotUpdaterInstanceEnvironment {
        HotUpdaterInstanceEnvironment(name: mainName, namedBundle: nil, config: config)
    }

    /// The environment of `name`. A named instance reads `channel`,
    /// `fingerprintHash`, and `publicKey`, then its `HOT_UPDATER_*` Info.plist
    /// keys from `bundle`; main reads `config`, where
    /// `HotUpdaterMainBundle.claim` records main's options. Throws when `name`
    /// is not 1 to 32 of `a-z`, `0-9`, and `-`, since it becomes a directory
    /// and a key prefix.
    init(
        name: String,
        bundle: Bundle,
        config: HotUpdaterConfig = .shared,
        channel: String? = nil,
        fingerprintHash: String? = nil,
        publicKey: String? = nil
    ) throws {
        guard Self.isValidName(name) else {
            throw NativeUpdateCheckError.hotUpdater(
                "Invalid name: \(name). Use 1 to \(Self.maxNameLength) of a-z, 0-9, and -."
            )
        }
        // Main's runtime is told apart by the bundle it runs, so a named
        // instance embeds a bundle of its own.
        if name != Self.mainName, bundle == Bundle.main {
            throw NativeUpdateCheckError.hotUpdater(
                "A named HotUpdater instance needs its own bundle, not Bundle.main: \(name)"
            )
        }
        let isMain = name == Self.mainName
        self.init(
            name: name,
            namedBundle: isMain ? nil : bundle,
            config: config,
            options: isMain ? HotUpdaterConfig.Overrides() : HotUpdaterConfig.Overrides(
                fingerprintHash: Self.optionValue(fingerprintHash),
                publicKey: Self.optionValue(publicKey),
                channel: Self.optionValue(channel)
            )
        )
    }

    /// The environment of `options`.
    init(options: HotUpdaterOptions, config: HotUpdaterConfig = .shared) throws {
        try self.init(
            name: options.name,
            bundle: options.bundle,
            config: config,
            channel: options.channel,
            fingerprintHash: options.fingerprintHash,
            publicKey: options.publicKey
        )
    }

    /// An option left nil or empty reads Info.plist.
    static func optionValue(_ value: String?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }

    /// Whether `other` is the same named instance: one service, so a second
    /// instance of a name must match the first, as on Android.
    func hasSameConfiguration(_ other: HotUpdaterInstanceEnvironment) -> Bool {
        name == other.name && bundle == other.bundle && options == other.options
    }

    static func isValidName(_ name: String) -> Bool {
        let scalars = name.unicodeScalars
        guard (1...maxNameLength).contains(scalars.count) else {
            return false
        }
        return scalars.allSatisfy { scalar in
            ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "-"
        }
    }

    var isMain: Bool { namedBundle == nil }

    /// The bundle with the embedded `main.jsbundle` and, for a named instance,
    /// the `HOT_UPDATER_*` keys.
    var bundle: Bundle { namedBundle ?? config.bundle }

    // MARK: - Paths

    /// The directory holding `bundle-store` and `bundle-temp`: Documents for
    /// main, `Documents/hot-updater-instances/<name>` otherwise.
    func storageRootPath(documentsPath: String) -> String {
        Self.storageRootPath(name: name, documentsPath: documentsPath)
    }

    /// The storage root of `name`, which the router needs without the
    /// instance's bundle.
    static func storageRootPath(name: String, documentsPath: String) -> String {
        guard name != mainName else {
            return documentsPath
        }
        return ((documentsPath as NSString)
            .appendingPathComponent(instancesDirectoryName) as NSString)
            .appendingPathComponent(name)
    }

    func bundleStorePath(documentsPath: String) -> String {
        (storageRootPath(documentsPath: documentsPath) as NSString)
            .appendingPathComponent(Self.bundleStoreDirectoryName)
    }

    /// Wiped before each update, so each instance needs its own.
    func tempPath(documentsPath: String) -> String {
        (storageRootPath(documentsPath: documentsPath) as NSString)
            .appendingPathComponent(Self.tempDirectoryName)
    }

    /// The directory of the key-value store, which also holds the native
    /// update event queue.
    func keyValueStorageDirectory(in fileSystem: FileSystemService) -> URL {
        let base = NoBackupStorage.directory(in: fileSystem)
        guard !isMain else {
            return base
        }
        return base
            .appendingPathComponent(Self.noBackupInstancesDirectoryName, isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
    }

    /// Per name, so one instance's entry limit never evicts another's.
    func releaseCatalogCacheDirectory(in fileSystem: FileSystemService) -> URL {
        guard !isMain else {
            return ReleaseCatalogCacheService.defaultRootDirectory()
        }
        return keyValueStorageDirectory(in: fileSystem)
            .appendingPathComponent(Self.releaseCatalogCacheDirectoryName, isDirectory: true)
    }

    /// A background URLSession identifier must be unique in the process.
    var backgroundSessionIdentifier: String {
        isMain ? Self.backgroundSessionIdentifierBase : "\(Self.backgroundSessionIdentifierBase).\(name)"
    }

    // MARK: - Config

    /// App-wide: every instance ships in the same app version.
    static var appVersion: String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    func fingerprintHash() -> String? {
        guard isMain else {
            return options.fingerprintHash ?? namedInfoValue(forKey: "HOT_UPDATER_FINGERPRINT_HASH")
        }
        if let override = config.overrides.fingerprintHash, !override.isEmpty {
            return override
        }
        return config.infoValue(forKey: "HOT_UPDATER_FINGERPRINT_HASH")
    }

    func defaultChannel() -> String {
        guard isMain else {
            return options.channel ?? namedInfoValue(forKey: "HOT_UPDATER_CHANNEL") ?? Self.defaultChannel
        }
        if let override = config.overrides.channel, !override.isEmpty {
            return override
        }
        return config.infoValue(forKey: "HOT_UPDATER_CHANNEL") ?? Self.defaultChannel
    }

    /// The key bundle signatures are verified with; nil disables signing.
    func publicKey() -> String? {
        guard isMain else {
            return options.publicKey ?? namedInfoValue(forKey: "HOT_UPDATER_PUBLIC_KEY")
        }
        return SignatureVerifier.getPublicKeyFromConfig(config)
    }

    func updateStrategy() -> UpdateStrategy {
        isolationFingerprintHash() != nil ? .fingerprint : .appVersion
    }

    /// The fingerprint hash the isolation key and the update strategy use,
    /// or nil for the appVersion strategy.
    func isolationFingerprintHash() -> String? {
        Self.optionValue(isMain ? mainIsolationFingerprintHash() : fingerprintHash())
    }

    /// The prefix of this instance's preferences, also stamped into its
    /// metadata: a change wipes its bundles. Main keeps
    /// `hotupdater_{fingerprint}_{minBundleId}_{channel}_` under the
    /// fingerprint strategy and `hotupdater_{appVersion}_{channel}_` under the
    /// appVersion strategy, or the deprecated `HotUpdaterConfig.isolationKey`
    /// verbatim; a named instance prefixes the same fields with
    /// `hotupdater_instance_<name>_`.
    ///
    /// A fingerprint build's state is keyed by the artifact, not the host
    /// app's version: a host release that ships the same artifact keeps its
    /// downloads, and a new build, which has a new `minBundleId`, starts from
    /// its newer embedded bundle. A key written before this format differs,
    /// so the stored bundles are discarded once.
    func isolationKey(appVersion: String?, minBundleId: String) -> String {
        if isMain,
           let override = config.overrides.isolationKey,
           !override.isEmpty {
            return override
        }

        let baseKey: String
        if let hash = isolationFingerprintHash() {
            let minBundleId = minBundleId.trimmingCharacters(in: .whitespacesAndNewlines)
            baseKey = "\(hash)_\(minBundleId.isEmpty ? "unknown" : minBundleId)"
        } else {
            baseKey = appVersion ?? "unknown"
        }

        let prefix = isMain ? "hotupdater_" : "hotupdater_instance_\(name)_"
        return "\(prefix)\(baseKey)_\(defaultChannel())_"
    }

    /// Main's isolation key and update strategy have always taken an empty
    /// programmatic fingerprint as "none" instead of reading Info.plist.
    private func mainIsolationFingerprintHash() -> String? {
        config.overrides.fingerprintHash
            ?? config.infoValue(forKey: "HOT_UPDATER_FINGERPRINT_HASH")
    }

    /// Only the instance's own bundle: falling back to the host app's
    /// Info.plist would hand a framework the app's fingerprint, channel, or key.
    private func namedInfoValue(forKey key: String) -> String? {
        guard let value = namedBundle?.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty else {
            return nil
        }
        return value
    }
}

/// The bundle and options main works with. Main is one service like any
/// name: its storage and isolation key come from the first bundle and values
/// it is given, so a main `HotUpdaterInstance` with another bundle, channel,
/// fingerprint hash, or public key would read them over state keyed by the
/// first.
final class HotUpdaterMainBundle {
    static let shared = HotUpdaterMainBundle()

    private let lock = NSLock()
    private var bundle: Bundle?
    /// The channel, fingerprint hash, and public key main's impl was created
    /// with, which fixed its isolation key. Nil until the impl exists.
    private var created: HotUpdaterConfig.Overrides?
    private let config: HotUpdaterConfig

    init(config: HotUpdaterConfig = .shared) {
        self.config = config
    }

    /// Makes `options.bundle` main's and records `options`' channel,
    /// fingerprint hash, and public key in `config` for a main
    /// `HotUpdaterInstance`, before main's impl exists. A value left nil
    /// keeps what main has. Throws when main already works with another
    /// bundle, or already holds another of these values: from an earlier
    /// main instance, from the deprecated `HotUpdater.configure`, or because
    /// main's impl was created with another.
    func claim(_ options: HotUpdaterOptions) throws {
        try claim(
            options.bundle,
            channel: options.channel,
            fingerprintHash: options.fingerprintHash,
            publicKey: options.publicKey
        )
    }

    func claim(
        _ bundle: Bundle,
        channel: String? = nil,
        fingerprintHash: String? = nil,
        publicKey: String? = nil
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        if let claimed = self.bundle, claimed != bundle {
            throw Self.conflict("bundle")
        }
        let channel = HotUpdaterInstanceEnvironment.optionValue(channel)
        let fingerprintHash = HotUpdaterInstanceEnvironment.optionValue(fingerprintHash)
        let publicKey = HotUpdaterInstanceEnvironment.optionValue(publicKey)
        let recorded = config.overrides
        if let created {
            // The impl's key is fixed: every value counts, nil included.
            try Self.check(channel, against: created.channel, always: true, field: "channel")
            try Self.check(fingerprintHash, against: created.fingerprintHash, always: true, field: "fingerprintHash")
            try Self.check(publicKey, against: created.publicKey, always: true, field: "publicKey")
        } else {
            try Self.check(channel, against: recorded.channel, always: false, field: "channel")
            try Self.check(fingerprintHash, against: recorded.fingerprintHash, always: false, field: "fingerprintHash")
            try Self.check(publicKey, against: recorded.publicKey, always: false, field: "publicKey")
        }
        self.bundle = bundle
        config.bundle = bundle
        guard created == nil else {
            return
        }
        config.recordOptions(channel: channel, fingerprintHash: fingerprintHash, publicKey: publicKey)
    }

    /// Records the bundle `HotUpdater.bundleURL(bundle:)` launches main with,
    /// so a later instance with another bundle throws. That static API keeps
    /// recording each bundle it is given, as it always has.
    func note(_ bundle: Bundle) {
        lock.lock()
        defer { lock.unlock() }
        if self.bundle == nil {
            self.bundle = bundle
        }
        config.bundle = bundle
    }

    /// Called as main's impl is created, before it reads its isolation key:
    /// from then on a main instance must match the values it was created
    /// with.
    func noteImplCreated() {
        lock.lock()
        defer { lock.unlock() }
        guard created == nil else {
            return
        }
        let main = HotUpdaterInstanceEnvironment.main(config: config)
        created = HotUpdaterConfig.Overrides(
            fingerprintHash: main.isolationFingerprintHash(),
            publicKey: main.publicKey(),
            channel: main.defaultChannel()
        )
    }

    /// `value` conflicts with `held` when both are set and differ, or, when
    /// `always`, whenever `value` is set and differs.
    private static func check(_ value: String?, against held: String?, always: Bool, field: String) throws {
        guard let value, always || held != nil, value != held else {
            return
        }
        throw conflict(field)
    }

    private static func conflict(_ field: String) -> NativeUpdateCheckError {
        NativeUpdateCheckError.hotUpdater(
            "HotUpdater instance \"\(HotUpdaterInstanceEnvironment.mainName)\" was already created with another \(field)"
        )
    }
}
