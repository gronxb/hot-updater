import Foundation
import PackagePlugin

// Runs ios/scripts/generate-fingerprint-hash.zsh before every build of the
// target, the SwiftPM counterpart of the podspec's script phase. The script
// writes a Swift file defining HotUpdaterBuildFingerprintHash(), which
// HotUpdater.mm calls.
@main
struct HotUpdaterFingerprintPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) throws -> [Command] {
        let script = context.package.directoryURL
            .appending(path: "ios/scripts/generate-fingerprint-hash.zsh")
        let outputDirectory = context.pluginWorkDirectoryURL
            .appending(path: "Fingerprint")
        // React Native's autolinker references this package through
        // <app>/ios/build/generated/autolinking/libs/HotUpdater, as
        // Package.swift's relative paths assume.
        let appRoot = context.package.directoryURL
            .appending(path: "../../../../../..")
            .standardized
        // A prebuild command gets only this environment. PATH lets the
        // script find node, as React Native's own script phases do, when
        // ios/.xcode.env.local sets no NODE_BINARY.
        var environment: [String: String] = [:]
        for key in ["HOT_UPDATER_APP_ROOT", "CONFIGURATION", "NODE_BINARY", "PATH"] {
            if let value = ProcessInfo.processInfo.environment[key] {
                environment[key] = value
            }
        }
        return [
            .prebuildCommand(
                displayName: "[HotUpdater] Generate fingerprint",
                executable: URL(filePath: "/bin/zsh"),
                arguments: [
                    script.path(percentEncoded: false),
                    "--swift",
                    outputDirectory.path(percentEncoded: false),
                    appRoot.path(percentEncoded: false),
                ],
                environment: environment,
                outputFilesDirectory: outputDirectory
            ),
        ]
    }
}
