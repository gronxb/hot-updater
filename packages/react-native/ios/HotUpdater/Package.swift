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
            // targets: ["HotUpdater"]
            targets: ["HotUpdaterTest"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ZipArchive/ZipArchive.git", from: "2.6.0"),
        .package(url: "https://github.com/tsolomko/SWCompression.git", from: "4.8.0"),
    ],
    targets: [
        // Target for Swift code
        // Since React Native doesn't support SPM yet, we can't build properly. Will add proper unit tests when it's officially supported
        // .target(
        //     name: "HotUpdater",
        //     path: "Internal",
        //     exclude: [
        //         "HotUpdater.mm",
        //         "HotUpdater-Bridging-Header.h",
        //     ]
        // ),
        .testTarget(
            name: "HotUpdaterTest",
            // dependencies: ["HotUpdater"],
            path: "Test"
        ),
    ]
) 