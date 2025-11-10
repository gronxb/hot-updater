// swift-tools-version: 6.0
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
        .package(url: "https://github.com/tsolomko/SWCompression.git", from: "4.8.0"),
    ],
    targets: [
        // Target for Swift code (for testing purposes only)
        .target(
            name: "HotUpdater",
            path: "Internal",
            exclude: [
                "HotUpdater.mm",
                "HotUpdater-Bridging-Header.h",
            ]
        ),
        // Legacy test target (kept for backwards compatibility)
        .testTarget(
            name: "HotUpdaterTest",
            dependencies: ["HotUpdater"],
            path: "Test"
        ),
        // Integration test target for OTA flow
        .testTarget(
            name: "HotUpdaterIntegrationTests",
            dependencies: ["HotUpdater"],
            path: "Tests"
        ),
    ]
) 