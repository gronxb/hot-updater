// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "HotUpdaterNativeTests",
  platforms: [
    .iOS(.v13),
    .macOS(.v10_15)
  ],
  products: [],
  dependencies: [
    .package(url: "https://github.com/ZipArchive/ZipArchive.git", from: "2.6.0"),
    .package(url: "https://github.com/tsolomko/SWCompression.git", from: "4.8.0"),
  ],
  targets: [
    // Target containing the HotUpdater source code
    .target(
      name: "HotUpdater",
      dependencies: [
        .product(name: "ZipArchive", package: "ZipArchive"),
        .product(name: "SWCompression", package: "SWCompression"),
      ],
      path: "Sources",
      exclude: [
        "HotUpdater.mm",
        "HotUpdater-Bridging-Header.h",
      ]
    ),
    .testTarget(
      name: "HotUpdaterNativeTests",
      dependencies: ["HotUpdater"],
      path: "Tests"
    )
  ]
)
