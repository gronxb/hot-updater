import Foundation

/// Finds the instance name a React Native runtime belongs to from the URL of
/// the bundle it runs. Each runtime has its own TurboModule, but JavaScript
/// never names its instance, so the module asks this with its runtime's
/// bundle URL.
///
/// 1. A URL a named instance handed out for its launch, including the
///    `main.jsbundle` embedded in its bundle, is that name's.
/// 2. A file inside a named instance's storage root
///    (`Documents/hot-updater-instances/<name>/`) is that name's, which
///    covers a bundle loaded after a reload.
/// 3. Anything else, such as main's bundles or a Metro URL, is main's.
///
/// Only names with an impl are candidates, so a URL recorded for a name
/// nothing created in this process never routes there. A URL two names
/// handed out belongs to neither.
final class HotUpdaterInstanceRouter {
    private let lock = NSLock()
    // Every URL each name handed out in this process, not only the latest:
    // a runtime that has not resolved yet may still run an earlier one.
    private var launchURLs: [String: Set<String>] = [:]

    /// Records a URL a named instance handed out for its launch. Main's are
    /// not recorded: whatever no named instance claims is main's.
    func record(launchURL: URL, name: String) {
        guard name != HotUpdaterInstanceEnvironment.mainName else {
            return
        }
        let key = Self.comparableKey(launchURL)
        lock.lock()
        launchURLs[name, default: []].insert(key)
        lock.unlock()
    }

    /// The name whose bundle `bundleURL` is, among `candidates`, or main.
    func resolve(bundleURL: URL?, candidates: [String], documentsPath: String) -> String {
        let mainName = HotUpdaterInstanceEnvironment.mainName
        guard let bundleURL else {
            return mainName
        }
        let names = candidates.filter { $0 != mainName }.sorted()
        let key = Self.comparableKey(bundleURL)

        lock.lock()
        let handedOut = names.filter { launchURLs[$0]?.contains(key) == true }
        lock.unlock()
        // Two names that hand out the same URL, such as one bundle shared by
        // both, can't be told apart by it.
        if handedOut.count == 1 {
            return handedOut[0]
        }
        if handedOut.count > 1 {
            return mainName
        }

        guard bundleURL.isFileURL else {
            return mainName
        }
        let path = Self.comparablePath(bundleURL)
        return names.first { name in
            let root = Self.comparablePath(URL(
                fileURLWithPath: HotUpdaterInstanceEnvironment.storageRootPath(
                    name: name,
                    documentsPath: documentsPath
                ),
                isDirectory: true
            ))
            // With the trailing slash, `app` never claims `app-2`'s files.
            return path.hasPrefix(root + "/")
        } ?? mainName
    }

    /// File URLs compare by their resolved path, since React Native may hold
    /// `/private/var/...` where Hot Updater handed out `/var/...`.
    static func comparableKey(_ url: URL) -> String {
        url.isFileURL ? "file://" + comparablePath(url) : url.absoluteString
    }

    private static func comparablePath(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }
}
