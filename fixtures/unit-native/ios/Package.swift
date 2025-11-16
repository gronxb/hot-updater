// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "HotUpdaterTests",
  platforms: [
    .iOS(.v13),
    .macOS(.v10_15),
  ],
  products: [],
  dependencies: [
    // Dependencies for compression
    .package(url: "https://github.com/ZipArchive/ZipArchive.git", from: "2.6.0"),
    .package(url: "https://github.com/tsolomko/SWCompression.git", from: "4.8.0"),
  ],
  targets: [
    // Source target - contains the actual HotUpdater implementation code
    .target(
      name: "HotUpdaterSource",
      dependencies: [
        .product(name: "ZipArchive", package: "ZipArchive"),
        .product(name: "SWCompression", package: "SWCompression"),
      ],
      path: "Sources",
      sources: ["HotUpdaterStub.swift"]
    ),
    // Test target
    .testTarget(
      name: "HotUpdaterTests",
      dependencies: [
        "HotUpdaterSource",
      ],
      path: "Tests/HotUpdaterTests"
    ),
  ]
)
