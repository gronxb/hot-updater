#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct HotUpdaterConfigTests {
    @Test
    func readsKeysFromTheRecordedBundle() throws {
        let framework = try makeBundle(info: [
            "HOT_UPDATER_CHANNEL": "brownfield",
            "HOT_UPDATER_FINGERPRINT_HASH": "abc123",
        ])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()

        #expect(config.bundle == Bundle.main)
        #expect(config.infoValue(forKey: "HOT_UPDATER_CHANNEL") == nil)

        config.bundle = framework
        #expect(config.infoValue(forKey: "HOT_UPDATER_CHANNEL") == "brownfield")
        #expect(config.infoValue(forKey: "HOT_UPDATER_FINGERPRINT_HASH") == "abc123")
        #expect(config.infoValue(forKey: "HOT_UPDATER_PUBLIC_KEY") == nil)
    }

    @Test
    func skipsEmptyValues() throws {
        // An unset build setting leaves an Info.plist slot empty.
        let framework = try makeBundle(info: ["HOT_UPDATER_FINGERPRINT_HASH": ""])
        defer { try? FileManager.default.removeItem(at: framework.bundleURL) }
        let config = HotUpdaterConfig()
        config.bundle = framework

        #expect(config.infoValue(forKey: "HOT_UPDATER_FINGERPRINT_HASH") == nil)
    }

    private func makeBundle(info: [String: String]) throws -> Bundle {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("HotUpdaterConfigTests-\(UUID().uuidString).framework")
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
#endif
