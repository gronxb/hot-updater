// swift-tools-version: 5.10
import PackageDescription

let coreSources = [
    "FileUtilities.swift",
    "BrotliFileDecompressor.swift",
    "BundleFileStorageService.swift",
    "BuiltInAssetResolver.swift",
    "BundleMetadata.swift",
    "FileManagerService.swift",
    "HashUtils.swift",
    "HotUpdaterConfig.swift",
    "NotificationExtension.swift",
    "ReleaseCatalogCacheService.swift",
    "SignatureVerifier.swift",
    "URLSessionDownloadService.swift",
    "VersionedPreferencesService.swift",
]

let coreExcludedFiles = [
    "BsdiffPatchBridge.h",
    "BsdiffPatchBridge.mm",
    "CohortService.swift",
    "HotUpdater-Bridging-Header.h",
    "HotUpdater.mm",
    "HotUpdaterImpl.swift",
]

let bsdiffPatchBridgeExcludedFiles =
    coreSources + coreExcludedFiles.filter {
        $0 != "BsdiffPatchBridge.h" && $0 != "BsdiffPatchBridge.mm"
    }

let package = Package(
    name: "HotUpdater",
    platforms: [
        .iOS(.v13),
        .macOS(.v10_15)
    ],
    products: [
        .library(
            name: "HotUpdaterCore",
            targets: ["HotUpdaterCore"]
        )
    ],
    dependencies: [],
    targets: [
        .target(
            name: "HotUpdaterRecovery",
            path: "Recovery",
            exclude: ["HotUpdaterRecoveryHooks.mm"],
            sources: ["HotUpdaterRecovery.mm"],
            publicHeadersPath: ".",
            cxxSettings: [.define("RCT_NEW_ARCH_ENABLED")]
        ),
        .target(
            name: "HotUpdaterBsdiffPatch",
            path: "Internal",
            exclude: bsdiffPatchBridgeExcludedFiles,
            sources: ["BsdiffPatchBridge.mm"],
            publicHeadersPath: ".",
            linkerSettings: [
                .linkedFramework("Foundation"),
                .linkedLibrary("bz2"),
            ]
        ),
        // React Native's full native module cannot be built through SPM yet,
        // but the pure-Swift update core can be.
        .target(
            name: "HotUpdaterCore",
            dependencies: ["HotUpdaterBsdiffPatch"],
            path: "Internal",
            exclude: coreExcludedFiles,
            sources: coreSources
        ),
        .testTarget(
            name: "HotUpdaterTest",
            dependencies: ["HotUpdaterCore", "HotUpdaterRecovery"],
            path: "Test"
        ),
    ]
) 
