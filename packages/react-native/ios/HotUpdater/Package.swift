// swift-tools-version: 5.10
import PackageDescription

let archiveSources = [
    "ArchiveExtractionUtilities.swift",
    "DecompressService.swift",
    "DecompressionStrategy.swift",
    "StreamingTarArchiveExtractor.swift",
    "TarArchiveExtractor.swift",
    "TarBrDecompressionStrategy.swift",
    "TarGzDecompressionStrategy.swift",
    "ZipArchiveExtractor.swift",
    "ZipDecompressionStrategy.swift",
]

let archiveExcludedFiles = [
    "BundleFileStorageService.swift",
    "BundleMetadata.swift",
    "CohortService.swift",
    "FileManagerService.swift",
    "HashUtils.swift",
    "HotUpdater-Bridging-Header.h",
    "HotUpdater.mm",
    "HotUpdaterCrashHandler.h",
    "HotUpdaterCrashHandler.mm",
    "HotUpdaterImpl.swift",
    "NotificationExtension.swift",
    "SignatureVerifier.swift",
    "URLSessionDownloadService.swift",
    "VersionedPreferencesService.swift",
]

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
        // React Native's full native module cannot be built through SPM yet,
        // but the pure-Swift archive extraction code can be.
        .target(
            name: "HotUpdaterArchive",
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
