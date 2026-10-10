import CryptoKit
import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxPageMetadataTests: XCTestCase {
    private let bundleId = "01900000-0000-7000-8000-000000000050"
    private let runtimeId =
        "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-4.0.3-primjs-4.0.0-ios-managed-pages-v1"

    func testSchemaCompatibilityWithTheSameRuntimeIdBeforePagePayloads() throws {
        for version: Any in [1, 2, 3, "2", true, 1.5] {
            let root = try makeTree(metadataPages: ["schemaVersion": version])
            defer { try? FileManager.default.removeItem(at: root) }
            let metadataData = try Data(contentsOf: root.appendingPathComponent("hot-updater-lynx.json"))
            try FileManager.default.removeItem(at: root.appendingPathComponent("main.lynx.bundle"))
            let verifyMetadata = {
                try VerifiedLynxTree.validateMetadata(at: root, bundleId: self.bundleId,
                    files: ["main.lynx.bundle": String(repeating: "a", count: 64),
                            "hot-updater-lynx.json": self.hash(metadataData)],
                    configuration: .init(runtimeId: self.runtimeId), verifyPageFiles: false)
            }
            if let value = version as? Int, type(of: version) == Int.self, [1, 2].contains(value) {
                XCTAssertNoThrow(try verifyMetadata())
            } else {
                XCTAssertThrowsError(try verifyMetadata())
            }
        }
    }

    func testBackgroundScriptIsDeclaredAndCopiedWithoutDependingOnInstalledFiles() throws {
        let root = try makeTree(metadataPages: ["backgroundEntry": "assets/shared.js"])
        defer { try? FileManager.default.removeItem(at: root) }
        let tree = try verify(root)
        XCTAssertEqual(tree.backgroundEntry, "assets/shared.js")
        XCTAssertEqual(tree.pageEntries, ["main.lynx.bundle"])
        let copied = try LynxBackgroundScript.read(root: root, entry: tree.backgroundEntry!,
            expectedHash: tree.files["assets/shared.js"]!)
        try Data("untrusted".utf8).write(to: root.appendingPathComponent("assets/shared.js"))
        XCTAssertThrowsError(try LynxBackgroundScript.read(root: root, entry: tree.backgroundEntry!,
            expectedHash: tree.files["assets/shared.js"]!))
        try FileManager.default.removeItem(at: root)
        XCTAssertEqual(copied, "shared")
    }

    func testInvalidBackgroundDeclarationOrBytesFailClosed() throws {
        for entry: Any in ["missing.js", "./assets/shared.js", "main.lynx.bundle", NSNull(), 1] {
            let root = try makeTree(metadataPages: ["backgroundEntry": entry])
            defer { try? FileManager.default.removeItem(at: root) }
            XCTAssertThrowsError(try verify(root))
        }
        for bytes in [Data(), Data([0xff, 0x80]), Data("globalThis.marker = 'A';//\0\nglobalThis.marker = 'B';".utf8), Data(repeating: 32, count: LynxBackgroundScript.maximumBytes + 1)] {
            let root = try makeTree(metadataPages: ["backgroundEntry": "assets/shared.js"], backgroundBytes: bytes)
            defer { try? FileManager.default.removeItem(at: root) }
            XCTAssertThrowsError(try verify(root))
        }
    }

    func testMetadataCheckDoesNotRequireDownloadingBackgroundScript() throws {
        let root = try makeTree(metadataPages: ["backgroundEntry": "assets/shared.js"])
        defer { try? FileManager.default.removeItem(at: root) }
        let tree = try verify(root)
        try FileManager.default.removeItem(at: root.appendingPathComponent("assets/shared.js"))
        let metadata = try VerifiedLynxTree.validateMetadata(at: root, bundleId: bundleId,
            files: tree.files, configuration: .init(runtimeId: runtimeId), verifyPageFiles: false)
        XCTAssertEqual(metadata.backgroundEntry, "assets/shared.js")
        XCTAssertThrowsError(try verify(root))
    }

    func testSchemaV1PagesAndManifestCoveredResourcesAreAccepted() throws {
        let root = try makeTree(metadataPages: validPages)
        defer { try? FileManager.default.removeItem(at: root) }
        let tree = try verify(root)
        XCTAssertTrue(tree.hasManagedPageMetadata)
        XCTAssertEqual(tree.pageEntries, [
            "detail.lynx.bundle", "main.lynx.bundle",
        ])
        XCTAssertEqual(tree.pageEssentialResources, [
            .init(
                entry: "detail.lynx.bundle",
                resources: ["assets/detail.png", "detail.lynx.bundle"]
            ),
            .init(
                entry: "main.lynx.bundle",
                resources: ["assets/shared.js", "main.lynx.bundle"]
            ),
        ])
    }

    func testBothAbsentUsesTheSinglePageLegacyFallback() throws {
        let root = try makeTree(metadataPages: [:])
        defer { try? FileManager.default.removeItem(at: root) }
        let tree = try verify(root)
        XCTAssertFalse(tree.hasManagedPageMetadata)
        XCTAssertNil(tree.backgroundEntry)
        XCTAssertEqual(tree.pageEntries, ["main.lynx.bundle"])
        XCTAssertEqual(tree.pageEssentialResources, [
            .init(
                entry: "main.lynx.bundle",
                resources: ["main.lynx.bundle"]
            ),
        ])
    }

    func testPartialUnsortedAndUncoveredPageMetadataFailClosed() throws {
        let invalid: [[String: Any]] = [
            ["pageEntries": ["detail.lynx.bundle", "main.lynx.bundle"]],
            [
                "pageEntries": ["main.lynx.bundle", "detail.lynx.bundle"],
                "pageEssentialResources": [
                    ["entry": "main.lynx.bundle", "resources": ["main.lynx.bundle"]],
                    ["entry": "detail.lynx.bundle", "resources": ["detail.lynx.bundle"]],
                ],
            ],
            [
                "pageEntries": ["detail.lynx.bundle", "main.lynx.bundle"],
                "pageEssentialResources": [
                    [
                        "entry": "detail.lynx.bundle",
                        "resources": ["detail.lynx.bundle", "missing.png"],
                    ],
                    ["entry": "main.lynx.bundle", "resources": ["main.lynx.bundle"]],
                ],
            ],
        ]
        for pages in invalid {
            let root = try makeTree(metadataPages: pages)
            XCTAssertThrowsError(try verify(root))
            try? FileManager.default.removeItem(at: root)
        }
    }

    private var validPages: [String: Any] {
        [
            "pageEntries": ["detail.lynx.bundle", "main.lynx.bundle"],
            "pageEssentialResources": [
                [
                    "entry": "detail.lynx.bundle",
                    "resources": ["assets/detail.png", "detail.lynx.bundle"],
                ],
                [
                    "entry": "main.lynx.bundle",
                    "resources": ["assets/shared.js", "main.lynx.bundle"],
                ],
            ],
        ]
    }

    private func makeTree(metadataPages: [String: Any], backgroundBytes: Data = Data("shared".utf8)) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "lynx-pages-\(UUID().uuidString)"
        )
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        var metadata: [String: Any] = [
            "schemaVersion": 1,
            "bundleId": bundleId,
            "platform": "ios",
            "runtimeId": runtimeId,
            "entry": "main.lynx.bundle",
        ]
        metadataPages.forEach { metadata[$0.key] = $0.value }
        let metadataBytes = try JSONSerialization.data(
            withJSONObject: metadata,
            options: [.sortedKeys]
        )
        let files: [String: Data] = [
            "main.lynx.bundle": Data("main".utf8),
            "detail.lynx.bundle": Data("detail".utf8),
            "assets/detail.png": Data([0x89, 0x50, 0x4e, 0x47]),
            "assets/shared.js": backgroundBytes,
            "hot-updater-lynx.json": metadataBytes,
        ]
        var assets: [String: [String: String]] = [:]
        for (path, data) in files {
            let url = root.appendingPathComponent(path)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: url)
            assets[path] = ["fileHash": hash(data)]
        }
        let manifest = try JSONSerialization.data(
            withJSONObject: ["bundleId": bundleId, "assets": assets],
            options: [.sortedKeys]
        )
        try manifest.write(to: root.appendingPathComponent("manifest.json"))
        return root
    }

    private func verify(_ root: URL) throws -> VerifiedLynxTree {
        try VerifiedLynxTree.verify(
            at: root,
            bundleId: bundleId,
            manifestToken: nil,
            configuration: .init(runtimeId: runtimeId)
        )
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
