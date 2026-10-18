import Foundation

/// Main's programmatic configuration and recorded bundle.
///
/// `HotUpdaterOptions` of the `main` instance record their `channel`,
/// `fingerprintHash`, and `publicKey` here before main's impl exists; they
/// take priority over the `HOT_UPDATER_*` Info.plist keys. The deprecated
/// `HotUpdater.configure` writes the same values. Named instances never read
/// it.
@objcMembers
public class HotUpdaterConfig: NSObject {
    public static let shared = HotUpdaterConfig()

    /// Main's values over its Info.plist keys. Nil means none; an empty
    /// fingerprint hash, which only `configure` can set, means none for the
    /// isolation key without falling back to Info.plist.
    struct Overrides: Equatable {
        var fingerprintHash: String?
        var publicKey: String?
        var channel: String?
        var isolationKey: String?
    }

    /// Which of main's values a main `HotUpdaterOptions` set, until a
    /// deprecated `configure` call takes them over.
    private struct OptionFields {
        var fingerprintHash = false
        var publicKey = false
        var channel = false

        static let all = OptionFields(fingerprintHash: true, publicKey: true, channel: true)
    }

    /// Guards the values. Lock order: `HotUpdaterMainBundle`'s lock, then
    /// this one. Code holding this lock never takes the other, and `log` runs
    /// after it is released.
    private let lock = NSLock()
    private let log: (String) -> Void
    /// Runs in `claimOptions` between its check and its record, with the
    /// lock held.
    private let onOptionsChecked: (() -> Void)?

    private var _overrides = Overrides()
    private var _optionFields = OptionFields()
    private var _bundle: Bundle = .main
    private var _buildFingerprintHash: String?

    public override convenience init() {
        self.init(log: { NSLog("%@", $0) })
    }

    /// `log` receives the warning a `configure` call over main's options
    /// logs. `onOptionsChecked` runs inside `claimOptions` between its check
    /// and its record, to show no legacy write lands there.
    init(log: @escaping (String) -> Void, onOptionsChecked: (() -> Void)? = nil) {
        self.log = log
        self.onOptionsChecked = onOptionsChecked
        super.init()
    }

    /// The bundle that holds the embedded `main.jsbundle`, which
    /// `HotUpdater.bundleURL(bundle:)` records. A brownfield XCFramework passes
    /// its own bundle, so reloads find its embedded bundle and assets, and the
    /// `HOT_UPDATER_*` keys the CLI writes into its Info.plist apply.
    public var bundle: Bundle {
        get { lock.lock(); defer { lock.unlock() }; return _bundle }
        set { lock.lock(); defer { lock.unlock() }; _bundle = newValue }
    }

    /// The fingerprint this build embedded, or nil for an app without one.
    /// The core package compiles without the generated source, so
    /// `HotUpdaterImpl` sets it on `shared` before anything resolves an
    /// instance's values.
    var buildFingerprintHash: String? {
        get { lock.lock(); defer { lock.unlock() }; return _buildFingerprintHash }
        set { lock.lock(); defer { lock.unlock() }; _buildFingerprintHash = newValue }
    }

    /// Reads a `HOT_UPDATER_*` Info.plist value from `bundle`, then from the
    /// host app's main bundle.
    @objc(infoValueForKey:)
    public func infoValue(forKey key: String) -> String? {
        Self.infoValue(forKey: key, bundle: bundle)
    }

    /// A `HOT_UPDATER_*` Info.plist value from `bundle`, then from the host
    /// app's main bundle.
    static func infoValue(forKey key: String, bundle: Bundle) -> String? {
        for source in [bundle, Bundle.main] {
            if let value = source.object(forInfoDictionaryKey: key) as? String, !value.isEmpty {
                return value
            }
        }
        return nil
    }

    /// The values main reads; Hot Updater's own code uses this, never the
    /// deprecated properties below.
    var overrides: Overrides {
        get { lock.lock(); defer { lock.unlock() }; return _overrides }
        set { lock.lock(); defer { lock.unlock() }; _overrides = newValue }
    }

    /// Checks the values a main `HotUpdaterOptions` set against the ones
    /// main holds, then records them, in one step under the lock the
    /// deprecated `configure` and setters write under: a legacy write lands
    /// before it, and conflicts, or after it, and warns. nil keeps a value,
    /// and an empty held value is none, as main resolves it.
    /// - Throws: the conflict `conflict(field)` returns, recording nothing.
    func claimOptions(
        channel: String?,
        fingerprintHash: String?,
        publicKey: String?,
        conflict: (String) -> Error
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        let fields: [(name: String, requested: String?, held: String?)] = [
            ("channel", channel, _overrides.channel),
            ("fingerprintHash", fingerprintHash, _overrides.fingerprintHash),
            ("publicKey", publicKey, _overrides.publicKey),
        ]
        for field in fields {
            guard let requested = field.requested,
                  let held = field.held, !held.isEmpty,
                  held != requested else {
                continue
            }
            throw conflict(field.name)
        }
        onOptionsChecked?()
        if let channel {
            _overrides.channel = channel
            _optionFields.channel = true
        }
        if let fingerprintHash {
            _overrides.fingerprintHash = fingerprintHash
            _optionFields.fingerprintHash = true
        }
        if let publicKey {
            _overrides.publicKey = publicKey
            _optionFields.publicKey = true
        }
    }

    /// The deprecated `configure` and setters: `update` writes the values,
    /// as it always has. When it changes a value main's options set, it logs
    /// one warning naming them; the `touched` values then belong to the
    /// legacy API, so a later call warns only after options set them again.
    private func replace(touching touched: OptionFields, _ update: (inout Overrides) -> Void) {
        lock.lock()
        let previous = _overrides
        update(&_overrides)
        let overrides = _overrides
        let fields = OptionFields(
            fingerprintHash: _optionFields.fingerprintHash && touched.fingerprintHash,
            publicKey: _optionFields.publicKey && touched.publicKey,
            channel: _optionFields.channel && touched.channel
        )
        _optionFields.fingerprintHash = _optionFields.fingerprintHash && !touched.fingerprintHash
        _optionFields.publicKey = _optionFields.publicKey && !touched.publicKey
        _optionFields.channel = _optionFields.channel && !touched.channel
        lock.unlock()

        var changes: [String] = []
        if fields.channel, previous.channel != overrides.channel {
            changes.append("channel \(Self.describe(previous.channel)) -> \(Self.describe(overrides.channel))")
        }
        if fields.fingerprintHash, previous.fingerprintHash != overrides.fingerprintHash {
            changes.append(
                "fingerprintHash \(Self.describe(previous.fingerprintHash)) -> \(Self.describe(overrides.fingerprintHash))"
            )
        }
        // Never the key itself.
        if fields.publicKey, previous.publicKey != overrides.publicKey {
            changes.append("publicKey")
        }
        guard !changes.isEmpty else {
            return
        }
        log(
            "[HotUpdater] HotUpdater.configure replaced values HotUpdaterOptions set: "
                + changes.joined(separator: ", ")
                + ". configure is deprecated: pass channel, fingerprintHash, and publicKey to HotUpdaterOptions."
        )
    }

    private static func describe(_ value: String?) -> String {
        value.map { "\"\($0)\"" } ?? "nil"
    }

    @available(*, deprecated, message: "Pass fingerprintHash to HotUpdaterOptions.")
    public var fingerprintHash: String? {
        get { overrides.fingerprintHash }
        set { replace(touching: OptionFields(fingerprintHash: true)) { $0.fingerprintHash = newValue } }
    }

    @available(*, deprecated, message: "Pass publicKey to HotUpdaterOptions.")
    public var publicKey: String? {
        get { overrides.publicKey }
        set { replace(touching: OptionFields(publicKey: true)) { $0.publicKey = newValue } }
    }

    @available(*, deprecated, message: "Pass channel to HotUpdaterOptions.")
    public var channel: String? {
        get { overrides.channel }
        set { replace(touching: OptionFields(channel: true)) { $0.channel = newValue } }
    }

    /// When set, used verbatim as the storage isolation key, bypassing the
    /// default `hotupdater_{fingerprint}_{minBundleId}_{channel}_` (fingerprint
    /// strategy) or `hotupdater_{appVersion}_{channel}_` composition.
    @available(*, deprecated, message: "Fingerprint downloads now survive native releases that ship the same artifact, so no isolation key is needed.")
    public var isolationKey: String? {
        get { overrides.isolationKey }
        set { replace(touching: OptionFields()) { $0.isolationKey = newValue } }
    }

    /// Replaces all four values. Deprecated with `HotUpdater.configure`.
    @available(*, deprecated, message: "Pass channel, fingerprintHash, and publicKey to HotUpdaterOptions. Fingerprint downloads now survive native releases that ship the same artifact.")
    @objc(configureWithFingerprintHash:publicKey:channel:isolationKey:)
    public func configureWithFingerprintHash(_ fingerprintHash: String?, publicKey: String?, channel: String?, isolationKey: String?) {
        replace(touching: .all) {
            $0 = Overrides(
                fingerprintHash: fingerprintHash,
                publicKey: publicKey,
                channel: channel,
                isolationKey: isolationKey
            )
        }
    }

    @available(*, deprecated, message: "Pass channel, fingerprintHash, and publicKey to HotUpdaterOptions.")
    public func clear() {
        replace(touching: .all) { $0 = Overrides() }
    }
}
