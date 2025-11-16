// swift-tools-version: 5.9
import PackageDescription

#if TUIST
    import ProjectDescription

    let packageSettings = PackageSettings(
        productTypes: [
            "SWCompression": .framework
        ]
    )
#endif

let package = Package(
    name: "HotUpdaterTestsDependencies",
    dependencies: [
        .package(url: "https://github.com/tsolomko/SWCompression.git", from: "4.8.0")
    ]
)
