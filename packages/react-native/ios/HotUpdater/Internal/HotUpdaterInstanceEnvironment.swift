import Foundation

/// Where one native instance keeps its state, and which config it reads.
///
/// Instances are told apart by `HotUpdaterOptions.name`. `main` is the one
/// the TurboModule and every static API use: it keeps the paths, keys, and
/// `HotUpdaterConfig.shared` of an app with a single instance. Any other name
/// keeps its state beside main's, never inside `bundle-store`, whose sweeps
/// delete the entries they don't know. The install identity and the cohort
/// stay device-level, shared by every name.
struct HotUpdaterInstanceEnvironment {
    static let mainName = "main"
    static let main = HotUpdaterInstanceEnvironment(name: mainName, namedBundle: nil, config: .shared)

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
    /// Main's programmatic config and recorded bundle; a named instance
    /// never reads it.
    private let config: HotUpdaterConfig

    private init(name: String, namedBundle: Bundle?, config: HotUpdaterConfig) {
        self.name = name
        self.namedBundle = namedBundle
        self.config = config
    }

    /// The environment of `name`. A named instance reads its `HOT_UPDATER_*`
    /// Info.plist keys from `bundle`; main reads `config`, as before. Throws
    /// when `name` is not 1 to 32 of `a-z`, `0-9`, and `-`, since it becomes
    /// a directory and a key prefix.
    init(name: String, bundle: Bundle, config: HotUpdaterConfig = .shared) throws {
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
        self.init(name: name, namedBundle: name == Self.mainName ? nil : bundle, config: config)
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
            return namedInfoValue(forKey: "HOT_UPDATER_FINGERPRINT_HASH")
        }
        if let override = config.fingerprintHash, !override.isEmpty {
            return override
        }
        return config.infoValue(forKey: "HOT_UPDATER_FINGERPRINT_HASH")
    }

    func defaultChannel() -> String {
        guard isMain else {
            return namedInfoValue(forKey: "HOT_UPDATER_CHANNEL") ?? Self.defaultChannel
        }
        if let override = config.channel, !override.isEmpty {
            return override
        }
        return config.infoValue(forKey: "HOT_UPDATER_CHANNEL") ?? Self.defaultChannel
    }

    /// The key bundle signatures are verified with; nil disables signing.
    func publicKey() -> String? {
        guard isMain else {
            return namedInfoValue(forKey: "HOT_UPDATER_PUBLIC_KEY")
        }
        return SignatureVerifier.getPublicKeyFromConfig(config)
    }

    func updateStrategy() -> UpdateStrategy {
        let fingerprintHash = isMain ? mainIsolationFingerprintHash() : fingerprintHash()
        return (fingerprintHash?.isEmpty == false) ? .fingerprint : .appVersion
    }

    /// The prefix of this instance's preferences, also stamped into its
    /// metadata: a change wipes its bundles. Main keeps
    /// `hotupdater_{fingerprint}_{appVersion}_{channel}_`, or
    /// `HotUpdaterConfig.isolationKey` verbatim; a named instance prefixes the
    /// same fields with `hotupdater_instance_<name>_`.
    func isolationKey(appVersion: String?) -> String {
        if isMain,
           let override = config.isolationKey,
           !override.isEmpty {
            return override
        }

        let fingerprintHash = isMain ? mainIsolationFingerprintHash() : fingerprintHash()
        let appVersion = appVersion ?? "unknown"
        // Include both fingerprint hash and app version for complete isolation
        let baseKey: String
        if let hash = fingerprintHash, !hash.isEmpty {
            baseKey = "\(hash)_\(appVersion)"
        } else {
            baseKey = appVersion
        }

        let prefix = isMain ? "hotupdater_" : "hotupdater_instance_\(name)_"
        return "\(prefix)\(baseKey)_\(defaultChannel())_"
    }

    /// Main's isolation key and update strategy have always taken an empty
    /// programmatic fingerprint as "none" instead of reading Info.plist.
    private func mainIsolationFingerprintHash() -> String? {
        config.fingerprintHash
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

/// The bundle main works with. Main is one service like any name: its
/// storage and isolation key come from the first bundle it is given, so a
/// main `HotUpdaterInstance` with another bundle would read that bundle's
/// fingerprint, channel, and public key over state keyed by the first.
final class HotUpdaterMainBundle {
    static let shared = HotUpdaterMainBundle()

    private let lock = NSLock()
    private var bundle: Bundle?
    private let config: HotUpdaterConfig

    init(config: HotUpdaterConfig = .shared) {
        self.config = config
    }

    /// Makes `bundle` main's for a `HotUpdaterInstance`.
    /// Throws when main already works with another bundle.
    func claim(_ bundle: Bundle) throws {
        lock.lock()
        defer { lock.unlock() }
        if let claimed = self.bundle, claimed != bundle {
            throw NativeUpdateCheckError.hotUpdater(
                "HotUpdater instance \"\(HotUpdaterInstanceEnvironment.mainName)\" was already created with another bundle"
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
}
