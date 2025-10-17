// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "HotUpdater",
    platforms: [
        .iOS(.v13),
        .macOS(.v10_15)
    ],
    products: [
        .library(
            name: "HotUpdater",
            targets: ["HotUpdater"]
        )
    ],
    dependencies: [],
    targets: [
        .target(
            name: "HotUpdater",
            dependencies: [],
            path: ".",
            exclude: [
                "Internal/HotUpdater.mm",
                "Internal/HotUpdater-Bridging-Header.h",
                "Internal/HotUpdaterImpl.swift",
                "Internal/HotUpdaterFactory.swift",
                "Internal/SSZipArchiveUnzipService.swift",
                "Public/HotUpdater.h",
                "Test"
            ],
            sources: ["Internal", "Public"]
        ),
        .testTarget(
            name: "HotUpdaterTest",
            dependencies: ["HotUpdater"],
            path: "Test",
            exclude: [
                "TempTest.swift",
                "HotUpdaterImplTests.swift"
            ]
        ),
    ]
) 