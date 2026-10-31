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
    /// Main's values as its impl was created with them; nil reads `config`
    /// at each use.
    private let mainSnapshot: MainValues?

    /// Main's channel, fingerprint hash, public key, and isolation key
    /// override, resolved from one read of `config` so they always agree.
    struct MainValues: Equatable {
        let defaultChannel: String
        let fingerprintHash: String?
        /// nil for the appVersion strategy.
        let isolationFingerprintHash: String?
        let publicKey: String?
        let isolationKeyOverride: String?
    }

    private init(
        name: String,
        namedBundle: Bundle?,
        config: HotUpdaterConfig,
        options: HotUpdaterConfig.Overrides = HotUpdaterConfig.Overrides(),
        mainSnapshot: MainValues? = nil
    ) {
        self.name = name
        self.namedBundle = namedBundle
        self.config = config
        self.options = options
        self.mainSnapshot = mainSnapshot
    }

    /// Main, reading `config` at each use.
    static func main(config: HotUpdaterConfig) -> HotUpdaterInstanceEnvironment {
        HotUpdaterInstanceEnvironment(name: mainName, namedBundle: nil, config: config)
    }

    /// Main with `values` fixed, which main's impl is built from: a
    /// `configure` call during or after its creation can't leave its key,
    /// channel, and public key apart.
    func snapshot(_ values: MainValues) -> HotUpdaterInstanceEnvironment {
        guard isMain else {
            return self
        }
        return HotUpdaterInstanceEnvironment(
            name: name,
            namedBundle: nil,
            config: config,
            mainSnapshot: values
        )
    }

    /// Main's values: the snapshot, or resolved now from one read of
    /// `config`'s values and bundle.
    func mainValues() -> MainValues {
        if let mainSnapshot {
            return mainSnapshot
        }
        return Self.resolveMain(
            overrides: config.overrides,
            bundle: config.bundle,
            buildFingerprintHash: config.buildFingerprintHash
        )
    }

    /// How main resolves its values: `overrides`, then `bundle`'s Info.plist,
    /// then the app's, then the default channel. The fingerprint comes from
    /// `overrides`, then the build.
    static func resolveMain(
        overrides: HotUpdaterConfig.Overrides,
        bundle: Bundle,
        buildFingerprintHash: String?
    ) -> MainValues {
        MainValues(
            defaultChannel: optionValue(overrides.channel)
                ?? HotUpdaterConfig.infoValue(forKey: "HOT_UPDATER_CHANNEL", bundle: bundle)
                ?? defaultChannel,
            fingerprintHash: optionValue(overrides.fingerprintHash) ?? buildFingerprintHash,
            // Main's isolation key and update strategy have always taken an
            // empty programmatic fingerprint as "none" instead of reading
            // the build's.
            isolationFingerprintHash: optionValue(overrides.fingerprintHash ?? buildFingerprintHash),
            publicKey: optionValue(overrides.publicKey)
                ?? HotUpdaterConfig.infoValue(forKey: "HOT_UPDATER_PUBLIC_KEY", bundle: bundle),
            isolationKeyOverride: optionValue(overrides.isolationKey)
        )
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
    /// instance of a name must have the same bundle and resolve to the same
    /// channel, fingerprint hash, and public key, from its options or its
    /// bundle's Info.plist alike.
    func hasSameConfiguration(_ other: HotUpdaterInstanceEnvironment) -> Bool {
        name == other.name
            && bundle == other.bundle
            && defaultChannel() == other.defaultChannel()
            && fingerprintHash() == other.fingerprintHash()
            && publicKey() == other.publicKey()
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

    /// The directory of the update log, beside the key-value store and outside
    /// the bundle store, whose sweeps delete it.
    func updateLogDirectory(in fileSystem: FileSystemService) -> URL {
        keyValueStorageDirectory(in: fileSystem)
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
            // Every instance's bundle comes from the project the build
            // fingerprinted.
            return options.fingerprintHash ?? config.buildFingerprintHash
        }
        return mainValues().fingerprintHash
    }

    func defaultChannel() -> String {
        guard isMain else {
            return options.channel ?? namedInfoValue(forKey: "HOT_UPDATER_CHANNEL") ?? Self.defaultChannel
        }
        return mainValues().defaultChannel
    }

    /// The key bundle signatures are verified with; nil disables signing.
    func publicKey() -> String? {
        guard isMain else {
            return options.publicKey ?? namedInfoValue(forKey: "HOT_UPDATER_PUBLIC_KEY")
        }
        return mainValues().publicKey
    }

    func updateStrategy() -> UpdateStrategy {
        isolationFingerprintHash() != nil ? .fingerprint : .appVersion
    }

    /// The fingerprint hash the isolation key and the update strategy use,
    /// or nil for the appVersion strategy.
    func isolationFingerprintHash() -> String? {
        isMain ? mainValues().isolationFingerprintHash : fingerprintHash()
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
        // One read of main's values, so the key's fields agree.
        let main = isMain ? mainValues() : nil
        if let override = main?.isolationKeyOverride {
            return override
        }

        let baseKey: String
        if let hash = main?.isolationFingerprintHash ?? (isMain ? nil : fingerprintHash()) {
            let minBundleId = minBundleId.trimmingCharacters(in: .whitespacesAndNewlines)
            baseKey = "\(hash)_\(minBundleId.isEmpty ? "unknown" : minBundleId)"
        } else {
            baseKey = appVersion ?? "unknown"
        }

        let prefix = isMain ? "hotupdater_" : "hotupdater_instance_\(name)_"
        return "\(prefix)\(baseKey)_\(main?.defaultChannel ?? defaultChannel())_"
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

    /// Lock order: this lock, then `HotUpdaterConfig`'s, which `claim` and
    /// `implEnvironment` take while holding it.
    private let lock = NSLock()
    private var bundle: Bundle?
    /// What main's impl was created from, which fixed its isolation key:
    /// the config's values, the bundle, and the values they resolved to.
    /// Nil until the impl exists.
    private var created: (
        overrides: HotUpdaterConfig.Overrides,
        bundle: Bundle,
        values: HotUpdaterInstanceEnvironment.MainValues
    )?
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
        if let created {
            // The impl's key is fixed: what this instance resolves to, its
            // options, then the config the impl was created with, then the
            // proposed bundle's Info.plist and the app's, must be it.
            let proposed = HotUpdaterInstanceEnvironment.resolveMain(
                overrides: HotUpdaterConfig.Overrides(
                    fingerprintHash: fingerprintHash ?? created.overrides.fingerprintHash,
                    publicKey: publicKey ?? created.overrides.publicKey,
                    channel: channel ?? created.overrides.channel,
                    isolationKey: created.overrides.isolationKey
                ),
                bundle: bundle,
                buildFingerprintHash: config.buildFingerprintHash
            )
            try Self.check(proposed.defaultChannel, against: created.values.defaultChannel, field: "channel")
            try Self.check(
                proposed.isolationFingerprintHash,
                against: created.values.isolationFingerprintHash,
                field: "fingerprintHash"
            )
            try Self.check(proposed.publicKey, against: created.values.publicKey, field: "publicKey")
        } else {
            // Checked and recorded in one step under the config's lock.
            try config.claimOptions(
                channel: channel,
                fingerprintHash: fingerprintHash,
                publicKey: publicKey,
                conflict: Self.conflict
            )
        }
        self.bundle = bundle
        config.bundle = bundle
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

    /// The environment main's impl is built from: main's values fixed from
    /// one read of `config`, which from then on a main instance must match.
    /// The impl reads only this snapshot, so a `configure` call racing its
    /// creation can't leave it apart from what is recorded here.
    /// The impl reads the bundle it was created with as main's bundle, so
    /// that bundle becomes main's: a later main instance with another bundle
    /// throws, as after a claim.
    func implEnvironment() -> HotUpdaterInstanceEnvironment {
        lock.lock()
        defer { lock.unlock() }
        let overrides = config.overrides
        let bundle = config.bundle
        let values = HotUpdaterInstanceEnvironment.resolveMain(
            overrides: overrides,
            bundle: bundle,
            buildFingerprintHash: config.buildFingerprintHash
        )
        if created == nil {
            created = (overrides, bundle, values)
            if self.bundle == nil {
                self.bundle = bundle
            }
        }
        return HotUpdaterInstanceEnvironment.main(config: config).snapshot(values)
    }

    /// A value the instance resolves to conflicts with the one main's impl
    /// uses whenever they differ, even where one of them is none.
    private static func check(_ value: String?, against inUse: String?, field: String) throws {
        guard value != inUse else {
            return
        }
        throw conflict(field)
    }

    private static func conflict(_ field: String) -> Error {
        NativeUpdateCheckError.hotUpdater(
            "HotUpdater instance \"\(HotUpdaterInstanceEnvironment.mainName)\" was already created with another \(field)"
        )
    }
}
