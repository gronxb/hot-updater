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
    ],
    targets: [
        .testTarget(
            name: "HotUpdaterTest",
            path: "Test",
            exclude: [
                "TempTest.swift"
            ]
        ),
    ]
) 