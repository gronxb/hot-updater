// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "HotUpdaterLynxArtifact",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15)],
    products: [.library(name: "HotUpdaterLynxArtifact", targets: ["HotUpdaterLynxArtifact"])],
    targets: [
        .target(name: "HotUpdaterLynxArtifact", linkerSettings: [.linkedLibrary("z")]),
        .testTarget(name: "HotUpdaterLynxArtifactTests", dependencies: ["HotUpdaterLynxArtifact"]),
    ]
)
