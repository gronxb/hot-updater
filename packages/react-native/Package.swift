// swift-tools-version: 6.0
import PackageDescription

// Swift Package Manager support for React Native's SwiftPM autolinking
// (`npx react-native spm`, react-native >= 0.87). CocoaPods builds use
// HotUpdater.podspec instead and never read this file.
//
// The autolinker references this package through
// <app>/ios/build/generated/autolinking/libs/HotUpdater (`spm.name` in
// react-native.config.js), so the two React Native packages below resolve
// relative to that symlink.
//
// SwiftPM compiles one language per target, so the module is split:
// HotUpdaterSwift holds the Swift implementation, and HotUpdaterObjC, the
// Objective-C++ module React Native loads, calls it through the protocols in
// HotUpdaterInterface (see HotUpdaterInterface.h for why). Swift reaches the
// Objective-C++ side through `@_silgen_name` symbols only. HotUpdater, the
// module apps import, re-exports both and adds the async Swift API.
let reactNativeDependencies: [Target.Dependency] = [
    .product(name: "ReactHeaders", package: "ReactNative"),
    .product(name: "ReactNativeHeaders", package: "ReactNative"),
    .product(name: "ReactNativeDependenciesHeaders", package: "ReactNative"),
    .product(name: "ReactAppHeaders", package: "React-GeneratedCode"),
]

let reactNativeCxxSettings: [CXXSetting] = [
    .define("RCT_NEW_ARCH_ENABLED", to: "1"),
    .define("DEBUG", .when(configuration: .debug)),
    .define("NDEBUG", .when(configuration: .release)),
]

let package = Package(
    name: "HotUpdater",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "HotUpdater", targets: ["HotUpdater"]),
    ],
    dependencies: [
        .package(name: "ReactNative", path: "../../../../xcframeworks"),
        .package(name: "React-GeneratedCode", path: "../../../ios"),
    ],
    targets: [
        // The module apps import: re-exports HotUpdaterObjC and
        // HotUpdaterSwift, and adds the async API, which needs both.
        .target(
            name: "HotUpdater",
            dependencies: [
                "HotUpdaterObjC",
                "HotUpdaterSwift",
            ] + reactNativeDependencies,
            path: "ios/HotUpdater/Internal",
            sources: ["HotUpdaterAsync.swift"]
        ),
        .target(
            name: "HotUpdaterObjC",
            dependencies: [
                "HotUpdaterInterface",
                "HotUpdaterSwift",
            ] + reactNativeDependencies,
            path: "ios/HotUpdater",
            sources: ["Internal/HotUpdater.mm"],
            publicHeadersPath: "Public",
            cxxSettings: reactNativeCxxSettings
        ),
        .target(
            name: "HotUpdaterSwift",
            dependencies: [
                "HotUpdaterBsdiffPatch",
                "HotUpdaterInterface",
                "HotUpdaterRecovery",
            ] + reactNativeDependencies,
            path: "ios/HotUpdater/Internal",
            exclude: [
                "BsdiffPatchBridge.h",
                "BsdiffPatchBridge.mm",
                "HotUpdater-Bridging-Header.h",
                "HotUpdater.mm",
                "HotUpdaterAsync.swift",
                "HotUpdaterMinBundleId.m",
            ],
            plugins: ["HotUpdaterMinBundleIdPlugin"]
        ),
        .target(
            name: "HotUpdaterInterface",
            dependencies: reactNativeDependencies,
            path: "ios/HotUpdater/Interface",
            publicHeadersPath: "."
        ),
        .target(
            name: "HotUpdaterRecovery",
            dependencies: reactNativeDependencies,
            path: "ios/HotUpdater/Recovery",
            publicHeadersPath: ".",
            cxxSettings: reactNativeCxxSettings
        ),
        .target(
            name: "HotUpdaterBsdiffPatch",
            path: "ios/HotUpdater/Internal",
            sources: ["BsdiffPatchBridge.mm"],
            publicHeadersPath: ".",
            linkerSettings: [.linkedLibrary("bz2")]
        ),
        // Writes this build's MIN_BUNDLE_ID before every build, as the
        // podspec's script phase does for CocoaPods.
        .plugin(
            name: "HotUpdaterMinBundleIdPlugin",
            capability: .buildTool(),
            path: "ios/Plugins/HotUpdaterMinBundleIdPlugin"
        ),
    ],
    swiftLanguageModes: [.v5],
    cxxLanguageStandard: .cxx20
)
