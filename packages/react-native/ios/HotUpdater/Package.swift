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
        .target(
            name: "HotUpdater",
            dependencies: [
                .product(name: "ZipArchive", package: "ZipArchive"),
                .product(name: "SWCompression", package: "SWCompression"),
            ],
            path: "Internal",
            exclude: [
                "HotUpdater.mm",
                "HotUpdater-Bridging-Header.h",
                "HotUpdaterImpl.swift",
                "HotUpdaterFactory.swift",
                "URLSessionDownloadService.swift",
                "TarGzDecompressionStrategy.swift",
                "TarBrDecompressionStrategy.swift",
                "ZipDecompressionStrategy.swift",
            ]
        ),
        .testTarget(
            name: "HotUpdaterTest",
            dependencies: ["HotUpdater"],
            path: "Test"
        ),
    ]
) 