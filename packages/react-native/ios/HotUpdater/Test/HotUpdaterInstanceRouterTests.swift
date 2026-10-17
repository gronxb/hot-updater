#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct HotUpdaterInstanceRouterTests {
    private let documents = "/app/Documents"

    private func file(_ path: String) -> URL {
        URL(fileURLWithPath: path)
    }

    @Test
    func aURLANamedInstanceHandedOutIsThatName() {
        let router = HotUpdaterInstanceRouter()
        // The embedded bundle of a framework lies outside every storage root.
        let embedded = file("/app/Frameworks/Widget.framework/main.jsbundle")
        router.record(launchURL: embedded, name: "widget")

        #expect(router.resolve(bundleURL: embedded, candidates: ["main", "widget"], documentsPath: documents) == "widget")
        #expect(router.resolve(
            bundleURL: file("/app/Frameworks/Checkout.framework/main.jsbundle"),
            candidates: ["main", "widget"],
            documentsPath: documents
        ) == "main")
    }

    @Test
    func aNewLaunchURLIsRecordedBesideTheEarlierOnes() {
        let router = HotUpdaterInstanceRouter()
        let embedded = file("/app/Frameworks/Widget.framework/main.jsbundle")
        let downloaded = URL(string: "https://cdn.example.com/widget/index.ios.bundle")!
        router.record(launchURL: embedded, name: "widget")
        #expect(router.resolve(bundleURL: downloaded, candidates: ["widget"], documentsPath: documents) == "main")

        router.record(launchURL: downloaded, name: "widget")

        #expect(router.resolve(bundleURL: downloaded, candidates: ["widget"], documentsPath: documents) == "widget")
        // A runtime that started on the earlier URL still finds its instance.
        #expect(router.resolve(bundleURL: embedded, candidates: ["widget"], documentsPath: documents) == "widget")
    }

    @Test
    func twoNamesThatHandOutTheSameURLCantClaimIt() {
        let router = HotUpdaterInstanceRouter()
        let shared = file("/app/Frameworks/Shared.framework/main.jsbundle")
        router.record(launchURL: shared, name: "widget")
        router.record(launchURL: shared, name: "checkout")

        #expect(router.resolve(bundleURL: shared, candidates: ["main", "widget", "checkout"], documentsPath: documents) == "main")
        // Only one of them is created in this process: the URL is its.
        #expect(router.resolve(bundleURL: shared, candidates: ["main", "widget"], documentsPath: documents) == "widget")
    }

    @Test
    func aFileInsideANamedStorageRootIsThatName() {
        let router = HotUpdaterInstanceRouter()
        let staged = file("/app/Documents/hot-updater-instances/widget/bundle-store/0195/index.ios.bundle")

        #expect(router.resolve(bundleURL: staged, candidates: ["main", "widget"], documentsPath: documents) == "widget")
    }

    @Test
    func similarNamesNeverClaimEachOthersFiles() {
        let router = HotUpdaterInstanceRouter()
        let candidates = ["app", "app-2"]

        #expect(router.resolve(
            bundleURL: file("/app/Documents/hot-updater-instances/app-2/bundle-store/0195/index.ios.bundle"),
            candidates: candidates,
            documentsPath: documents
        ) == "app-2")
        #expect(router.resolve(
            bundleURL: file("/app/Documents/hot-updater-instances/app/bundle-store/0195/index.ios.bundle"),
            candidates: candidates,
            documentsPath: documents
        ) == "app")

        router.record(launchURL: file("/app/Frameworks/App2.framework/main.jsbundle"), name: "app-2")
        #expect(router.resolve(
            bundleURL: file("/app/Frameworks/App.framework/main.jsbundle"),
            candidates: candidates,
            documentsPath: documents
        ) == "main")
    }

    @Test
    func mainsBundlesMetroAndUnknownURLsAreMain() {
        let router = HotUpdaterInstanceRouter()
        router.record(launchURL: file("/app/Frameworks/Widget.framework/main.jsbundle"), name: "widget")
        let candidates = ["main", "widget"]

        for url: URL? in [
            nil,
            file("/app/Documents/bundle-store/0195/index.ios.bundle"),
            file("/app/HotUpdaterExample.app/main.jsbundle"),
            URL(string: "http://localhost:8081/index.bundle?platform=ios&dev=true")!,
            // The instances directory itself belongs to no name.
            file("/app/Documents/hot-updater-instances/index.ios.bundle"),
            file("/elsewhere/hot-updater-instances/widget/bundle-store/0195/index.ios.bundle"),
        ] {
            #expect(router.resolve(bundleURL: url, candidates: candidates, documentsPath: documents) == "main")
        }
    }

    @Test
    func aNameWithoutAnImplNeverMatches() {
        let router = HotUpdaterInstanceRouter()
        let embedded = file("/app/Frameworks/Widget.framework/main.jsbundle")
        router.record(launchURL: embedded, name: "widget")

        #expect(router.resolve(bundleURL: embedded, candidates: ["main"], documentsPath: documents) == "main")
        #expect(router.resolve(
            bundleURL: file("/app/Documents/hot-updater-instances/widget/bundle-store/0195/index.ios.bundle"),
            candidates: ["main", "checkout"],
            documentsPath: documents
        ) == "main")
    }

    @Test
    func mainsURLsAreNeverRecorded() {
        let router = HotUpdaterInstanceRouter()
        let embedded = file("/app/HotUpdaterExample.app/main.jsbundle")
        router.record(launchURL: embedded, name: "main")

        #expect(router.resolve(bundleURL: embedded, candidates: ["main"], documentsPath: documents) == "main")
    }

    @Test
    func aPathThroughASymlinkMatchesItsTarget() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("HotUpdaterInstanceRouterTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let realDocuments = root.appendingPathComponent("real/Documents", isDirectory: true)
        let bundleDirectory = realDocuments
            .appendingPathComponent("hot-updater-instances/widget/bundle-store/0195", isDirectory: true)
        try FileManager.default.createDirectory(at: bundleDirectory, withIntermediateDirectories: true)
        let bundle = bundleDirectory.appendingPathComponent("index.ios.bundle")
        try Data("bundle".utf8).write(to: bundle)
        let linkedDocuments = root.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedDocuments, withDestinationURL: realDocuments)
        let linkedBundle = linkedDocuments
            .appendingPathComponent("hot-updater-instances/widget/bundle-store/0195/index.ios.bundle")

        // React Native may hold the resolved path of a URL handed out through
        // a symlink, such as `/private/var` for `/var`.
        let router = HotUpdaterInstanceRouter()
        #expect(router.resolve(
            bundleURL: bundle,
            candidates: ["widget"],
            documentsPath: linkedDocuments.path
        ) == "widget")

        let embedded = HotUpdaterInstanceRouter()
        embedded.record(launchURL: linkedBundle, name: "widget")
        #expect(embedded.resolve(bundleURL: bundle, candidates: ["widget"], documentsPath: "/unrelated") == "widget")
    }
}
#endif
