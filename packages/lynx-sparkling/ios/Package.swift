// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "HotUpdaterLynxSparklingCore",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15)],
    products: [
        .library(name: "HotUpdaterLynxSparklingCore", targets: ["HotUpdaterLynxSparklingCore"]),
    ],
    targets: [
        .target(name: "HotUpdaterLynxSparklingCore"),
        .target(name: "HotUpdaterLynxSparklingDiagnostics", dependencies: ["HotUpdaterLynxSparklingCore"]),
        .testTarget(name: "HotUpdaterLynxSparklingDiagnosticsTests", dependencies: ["HotUpdaterLynxSparklingCore", "HotUpdaterLynxSparklingDiagnostics"]),
    ]
)
