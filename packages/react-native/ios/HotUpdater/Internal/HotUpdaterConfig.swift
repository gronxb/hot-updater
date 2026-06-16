import Foundation

/// Thread-safe programmatic configuration holder for HotUpdater.
///
/// When values are set here, they take priority over `Info.plist` (iOS) and
/// manifest metadata / string resources (Android). This enables brownfield /
/// prebuilt-framework setups where the RN module cannot rely on the host app's
/// `Info.plist` for configuration.
@objcMembers
public class HotUpdaterConfig: NSObject {
    public static let shared = HotUpdaterConfig()

    private let lock = NSLock()

    private var _fingerprintHash: String?
    private var _publicKey: String?
    private var _channel: String?
    private var _isolationKey: String?

    public var fingerprintHash: String? {
        get { lock.lock(); defer { lock.unlock() }; return _fingerprintHash }
        set { lock.lock(); defer { lock.unlock() }; _fingerprintHash = newValue }
    }

    public var publicKey: String? {
        get { lock.lock(); defer { lock.unlock() }; return _publicKey }
        set { lock.lock(); defer { lock.unlock() }; _publicKey = newValue }
    }

    public var channel: String? {
        get { lock.lock(); defer { lock.unlock() }; return _channel }
        set { lock.lock(); defer { lock.unlock() }; _channel = newValue }
    }

    /// When set, used verbatim as the storage isolation key, bypassing the default
    /// `hotupdater_{fingerprint}_{appVersion}_{channel}_` composition. Use this to keep
    /// the OTA cache stable across host app version bumps (e.g. key only by fingerprint + channel).
    public var isolationKey: String? {
        get { lock.lock(); defer { lock.unlock() }; return _isolationKey }
        set { lock.lock(); defer { lock.unlock() }; _isolationKey = newValue }
    }

    @objc(configureWithFingerprintHash:publicKey:channel:isolationKey:)
    public func configureWithFingerprintHash(_ fingerprintHash: String?, publicKey: String?, channel: String?, isolationKey: String?) {
        self.fingerprintHash = fingerprintHash
        self.publicKey = publicKey
        self.channel = channel
        self.isolationKey = isolationKey
    }

    public func clear() {
        configureWithFingerprintHash(nil, publicKey: nil, channel: nil, isolationKey: nil)
    }
}
