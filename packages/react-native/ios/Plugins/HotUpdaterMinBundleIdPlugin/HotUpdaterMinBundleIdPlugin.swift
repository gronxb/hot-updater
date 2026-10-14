import Foundation
import PackagePlugin

// Runs ios/scripts/generate-min-bundle-id.zsh before every build of the target,
// the SwiftPM counterpart of the podspec's script phase. The script writes a
// Swift file defining HotUpdaterBuildMinBundleId(), which HotUpdater.mm calls.
@main
struct HotUpdaterMinBundleIdPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) throws -> [Command] {
        let script = context.package.directoryURL
            .appending(path: "ios/scripts/generate-min-bundle-id.zsh")
        let outputDirectory = context.pluginWorkDirectoryURL
            .appending(path: "MinBundleId")
        var environment: [String: String] = [:]
        if let minBundleId = ProcessInfo.processInfo.environment["HOT_UPDATER_MIN_BUNDLE_ID"] {
            environment["HOT_UPDATER_MIN_BUNDLE_ID"] = minBundleId
        }
        return [
            .prebuildCommand(
                displayName: "[HotUpdater] Generate MIN_BUNDLE_ID",
                executable: URL(filePath: "/bin/zsh"),
                arguments: [script.path(percentEncoded: false), "--swift", outputDirectory.path(percentEncoded: false)],
                environment: environment,
                outputFilesDirectory: outputDirectory
            ),
        ]
    }
}
