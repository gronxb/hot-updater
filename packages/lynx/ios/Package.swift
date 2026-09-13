// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "HotUpdaterLynxArtifact",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15)],
    products: [.library(name: "HotUpdaterLynxArtifact", targets: ["HotUpdaterLynxArtifact"])],
    targets: [
        .target(name: "HotUpdaterLynxBsdiff", linkerSettings: [.linkedLibrary("bz2"), .linkedLibrary("c++")]),
        .target(name: "HotUpdaterLynxArtifact", dependencies: ["HotUpdaterLynxBsdiff"], linkerSettings: [.linkedLibrary("z")]),
        .target(name: "HotUpdaterLynxSparklingDiagnostics"),
        .testTarget(name: "HotUpdaterLynxArtifactTests", dependencies: ["HotUpdaterLynxArtifact"]),
        .testTarget(name: "HotUpdaterLynxSparklingDiagnosticsTests", dependencies: ["HotUpdaterLynxSparklingDiagnostics"]),
    ]
)
