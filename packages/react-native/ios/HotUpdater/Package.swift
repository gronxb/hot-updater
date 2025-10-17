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
    dependencies: [
        .package(url: "https://github.com/ZipArchive/ZipArchive.git", from: "2.6.0"),
    ],
    targets: [
        .target(
            name: "HotUpdater",
            dependencies: [
                .product(name: "ZipArchive", package: "ZipArchive")
            ],
            path: ".",
            exclude: [
                "Internal/HotUpdater.mm",
                "Internal/HotUpdater-Bridging-Header.h",
                "Internal/HotUpdaterImpl.swift",
                "Internal/HotUpdaterFactory.swift",
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