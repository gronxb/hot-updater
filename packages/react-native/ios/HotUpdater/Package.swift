// swift-tools-version: 5.10
import PackageDescription

let archiveSources = [
    "ArchiveExtractionUtilities.swift",
    "BundleFileStorageService.swift",
    "BundleMetadata.swift",
    "DecompressService.swift",
    "DecompressionStrategy.swift",
    "FileManagerService.swift",
    "HashUtils.swift",
    "NotificationExtension.swift",
    "SignatureVerifier.swift",
    "StreamingTarArchiveExtractor.swift",
    "TarArchiveExtractor.swift",
    "TarBrDecompressionStrategy.swift",
    "TarGzDecompressionStrategy.swift",
    "URLSessionDownloadService.swift",
    "VersionedPreferencesService.swift",
    "ZipArchiveExtractor.swift",
    "ZipDecompressionStrategy.swift",
]

let archiveExcludedFiles = [
    "BsdiffPatchBridge.h",
    "BsdiffPatchBridge.mm",
    "CohortService.swift",
    "HotUpdater-Bridging-Header.h",
    "HotUpdater.mm",
    "HotUpdaterCrashHandler.h",
    "HotUpdaterCrashHandler.mm",
    "HotUpdaterImpl.swift",
]

let bsdiffPatchBridgeExcludedFiles =
    archiveSources + archiveExcludedFiles.filter {
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
            name: "HotUpdaterArchive",
            targets: ["HotUpdaterArchive"]
        )
    ],
    dependencies: [],
    targets: [
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
        // but the pure-Swift archive extraction code can be.
        .target(
            name: "HotUpdaterArchive",
            dependencies: ["HotUpdaterBsdiffPatch"],
            path: "Internal",
            exclude: archiveExcludedFiles,
            sources: archiveSources
        ),
        .testTarget(
            name: "HotUpdaterTest",
            dependencies: ["HotUpdaterArchive"],
            path: "Test",
            exclude: ["Fixtures"]
        ),
    ]
) 
