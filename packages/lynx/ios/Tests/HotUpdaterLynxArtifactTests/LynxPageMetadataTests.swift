import CryptoKit
import Foundation
import XCTest
@testable import HotUpdaterLynxArtifact

final class LynxPageMetadataTests: XCTestCase {
    private let bundleId = "01900000-0000-7000-8000-000000000050"
    private let runtimeId =
        "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1"

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

    private func makeTree(metadataPages: [String: Any]) throws -> URL {
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
            "assets/shared.js": Data("shared".utf8),
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
