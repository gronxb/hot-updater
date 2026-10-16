#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

/// Crash recovery per instance: each instance's marker, crash history, and
/// rollback are its own, and an event of one runtime never verifies or charges
/// another.
struct HotUpdaterLaunchRecoveryTests {
    private static let main = "main"
    private static let widget = "widget"

    @Test
    func mainKeepsItsMarkerPathAndANamedInstanceUsesItsOwnStore() throws {
        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle)

        #expect(HotUpdaterCrashMarker.url(for: .main, documentsPath: "/app/Documents").path
            == "/app/Documents/bundle-store/recovery-crash-marker.json")
        #expect(HotUpdaterCrashMarker.url(for: widget, documentsPath: "/app/Documents").path
            == "/app/Documents/hot-updater-instances/widget/bundle-store/recovery-crash-marker.json")
    }

    // MARK: - Per-instance markers

    @Test(arguments: ["main", "widget"])
    func aCrashMarkerRollsBackOnlyItsOwnInstance(charged: String) throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        process.coordinator.chargeFatal(owner: charged)

        for name in [Self.main, Self.widget] {
            #expect(FileManager.default.fileExists(atPath: scene.markerURL(name).path) == (name == charged))
        }

        let next = scene.nextLaunch()
        for name in [Self.main, Self.widget] {
            let crashed = name == charged
            #expect(next[name]?.launchedBundleId == (crashed ? "\(name)-stable" : "\(name)-next"))
            #expect(next[name]?.shouldRollbackOnCrash == !crashed)
            #expect(scene.crashHistory(name).contains("\(name)-next") == crashed)
            #expect(scene.crashHistory(name).bundles.count == (crashed ? 1 : 0))
        }
    }

    /// A fatal of one instance takes the whole process down, but it is that
    /// instance's crash: another instance whose launch already started is
    /// neither rolled back as crashed nor as an unfinished launch.
    @Test
    func aFatalOfOneInstanceDoesNotChargeAnotherWhoseLaunchStarted() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        // Main's launch started in the foreground; the widget's view is shown.
        process.storages[Self.main]?.markLaunchStarted(bundleId: "main-next")
        #expect(process.coordinator.arm(name: Self.widget))
        #expect(scene.metadata(Self.main)?.launchInProgress == true)

        process.coordinator.chargeFatal(owner: Self.widget)

        #expect(scene.metadata(Self.main)?.launchInProgress == false)
        #expect(scene.metadata(Self.main)?.verificationPending == true)
        let next = scene.nextLaunch()
        #expect(next[Self.main]?.launchedBundleId == "main-next")
        #expect(next[Self.main]?.shouldRollbackOnCrash == true)
        #expect(scene.crashHistory(Self.main).bundles.isEmpty)
        #expect(scene.crashHistory(Self.main).interruptedLaunch == nil)
        #expect(next[Self.widget]?.launchedBundleId == "widget-stable")
        #expect(scene.crashHistory(Self.widget).contains("widget-next"))
    }

    /// In a debug build React Native's fatal handler can return: the
    /// launches the attributed fatal stopped start again.
    @Test
    func launchesAnAttributedFatalStoppedStartAgainWhenTheProcessLivesOn() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        process.storages[Self.main]?.markLaunchStarted(bundleId: "main-next")
        #expect(coordinator.arm(name: Self.widget))
        let widgetSlot = try #require(coordinator.launch(named: Self.widget)?.slot)

        let mainClaim = try #require(coordinator.chargeFatal(owner: Self.main))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        #expect(markers(coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true])

        coordinator.clearAttribution(claim: mainClaim)
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)
        #expect(coordinator.launch(named: Self.widget)?.isArmed == true)
        #expect(process.sink.flags[widgetSlot] == true)
        #expect(markers(coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true, widgetSlot: true])
        // Main's own launch was the attributed one, so it was never stopped.
        #expect(scene.metadata(Self.main)?.launchInProgress == true)

        // The other way round: main stopped by the widget's fatal starts again.
        let widgetClaim = try #require(coordinator.chargeFatal(owner: Self.widget))
        #expect(scene.metadata(Self.main)?.launchInProgress == false)
        coordinator.clearAttribution(claim: widgetClaim)
        #expect(scene.metadata(Self.main)?.launchInProgress == true)

        // A launch that was never started stays unstarted.
        _ = coordinator.contentAppeared(owner: Self.widget)
        coordinator.startMonitoring(name: Self.widget, bundleId: "widget-next", shouldRollback: true)
        let lastClaim = try #require(coordinator.chargeFatal(owner: Self.main))
        coordinator.clearAttribution(claim: lastClaim)
        #expect(coordinator.launch(named: Self.widget)?.isArmed == false)
    }

    // MARK: - Native crash slots

    @Test
    func aNativeCrashWritesOnlyTheSlotsOfUnverifiedLaunches() throws {
        // Main verified, the widget's launch started and unverified: main's
        // marker is written as always, but only the widget's asks for rollback.
        do {
            let scene = try Scene()
            defer { scene.cleanUp() }
            let process = scene.launch()
            #expect(process.coordinator.contentAppeared(owner: nil)?.launch.name == Self.main)
            #expect(process.coordinator.arm(name: Self.widget))
            let widgetSlot = try #require(process.coordinator.launch(named: Self.widget)?.slot)
            #expect(widgetSlot != HotUpdaterRecoveryCoordinator.mainSlot)
            #expect(markers(process.coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: false, widgetSlot: true])
            #expect(process.sink.flags[HotUpdaterRecoveryCoordinator.mainSlot] == false)
            #expect(process.sink.flags[widgetSlot] == true)
            #expect(process.sink.paths[widgetSlot] == scene.markerURL(Self.widget).path)
            #expect(process.sink.bundleIds[widgetSlot] == "widget-next")
        }
        // The reverse: main unverified, the widget verified by its own content.
        do {
            let scene = try Scene()
            defer { scene.cleanUp() }
            let process = scene.launch()
            #expect(process.coordinator.arm(name: Self.widget))
            #expect(process.coordinator.contentAppeared(owner: Self.widget)?.launch.name == Self.widget)
            #expect(markers(process.coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true])
            #expect(process.sink.paths[HotUpdaterRecoveryCoordinator.mainSlot] == scene.markerURL(Self.main).path)
        }
        // Both unverified: both; then a fatal attributed to the widget: only its.
        do {
            let scene = try Scene()
            defer { scene.cleanUp() }
            let process = scene.launch()
            #expect(process.coordinator.arm(name: Self.widget))
            let widgetSlot = try #require(process.coordinator.launch(named: Self.widget)?.slot)
            #expect(markers(process.coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true, widgetSlot: true])

            let claim = try #require(process.coordinator.chargeFatal(owner: Self.widget))
            #expect(process.sink.attribution == widgetSlot)
            #expect(markers(process.coordinator) == [widgetSlot: true])
            // The uncaught exception the forwarded fatal raises charges it alone.
            process.coordinator.chargeUncaughtException()
            #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.main).path))
            #expect(FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))

            process.coordinator.clearAttribution(claim: claim)
            #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.unattributed)
        }
    }

    @Test
    func aNamedRuntimeWarmedUpWithoutUIIsNeverCharged() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()

        // Its launch never started: no slot, and a crash leaves it no marker.
        #expect(process.coordinator.launch(named: Self.widget)?.slot == nil)
        #expect(markers(process.coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true])
        process.coordinator.chargeUncaughtException()
        #expect(FileManager.default.fileExists(atPath: scene.markerURL(Self.main).path))
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
    }

    @Test
    func instancesBeyondTheSlotsGetNoNativeMarkerAndChargeNoOneElse() throws {
        let sink = RecordingSlotSink()
        let coordinator = HotUpdaterRecoveryCoordinator(sink: sink)
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let names = (1...HotUpdaterRecoveryCoordinator.slotCount).map { "named-\($0)" }
        for name in names {
            coordinator.register(
                name: name,
                markerURL: directory.appendingPathComponent("\(name).json"),
                storage: NoStorage()
            )
            coordinator.startMonitoring(name: name, bundleId: "\(name)-bundle", shouldRollback: true)
            #expect(coordinator.arm(name: name))
        }

        // Slot 0 is main's; seven named slots remain.
        #expect(Set(names.compactMap { coordinator.launch(named: $0)?.slot }) == Set(1..<HotUpdaterRecoveryCoordinator.slotCount))
        let last = try #require(names.last)
        #expect(coordinator.launch(named: last)?.slot == nil)
        coordinator.chargeFatal(owner: last)
        #expect(sink.attribution == HotUpdaterRecoveryCoordinator.attributedWithoutSlot)
        #expect(markers(coordinator).isEmpty)
    }

    // MARK: - Arming and verification

    @Test
    func aNamedLaunchStaysPendingUntilItsViewIsShownAndItsOwnContentAppears() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let widget = try #require(process.storages[Self.widget])

        // Selected, not started, not verified.
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        #expect(widget.notifyAppReady()["status"] as? String == "PENDING")
        // Main's arming stays at its selection; a view never arms it.
        #expect(!process.coordinator.arm(name: Self.main))

        // Main's content verifies main only.
        #expect(process.coordinator.contentAppeared(owner: nil)?.launch.name == Self.main)
        #expect(scene.metadata(Self.main)?.verificationPending == false)
        #expect(scene.metadata(Self.widget)?.verificationPending == true)
        #expect(widget.notifyAppReady()["status"] as? String == "PENDING")

        #expect(process.coordinator.arm(name: Self.widget))
        #expect(!process.coordinator.arm(name: Self.widget))
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)

        #expect(process.coordinator.contentAppeared(owner: Self.widget)?.launch.name == Self.widget)
        #expect(scene.metadata(Self.widget)?.verificationPending == false)
        #expect(widget.notifyAppReady()["status"] as? String == "UPDATE_APPLIED")
        // Verified: a view shown later no longer starts it.
        #expect(!process.coordinator.arm(name: Self.widget))
    }

    @Test
    func contentOfANamedRuntimeNeverVerifiesMain() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()

        #expect(process.coordinator.contentAppeared(owner: Self.widget)?.launch.name == Self.widget)
        #expect(scene.metadata(Self.main)?.verificationPending == true)
        // A second content of the widget's runtime is not main's either.
        #expect(process.coordinator.contentAppeared(owner: Self.widget) == nil)
        #expect(scene.metadata(Self.main)?.verificationPending == true)
        // A view nothing attributes is main's, as it always was.
        #expect(process.coordinator.contentAppeared(owner: nil)?.launch.name == Self.main)
        #expect(scene.metadata(Self.main)?.verificationPending == false)
    }

    @Test
    func aFatalOfMainNeverChargesANamedInstance() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        #expect(process.coordinator.arm(name: Self.widget))

        process.coordinator.chargeFatal(owner: Self.main)

        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.mainSlot)
        #expect(markers(process.coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true])
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        let next = scene.nextLaunch()
        #expect(next[Self.main]?.launchedBundleId == "main-stable")
        #expect(next[Self.widget]?.launchedBundleId == "widget-next")
        #expect(scene.crashHistory(Self.widget).interruptedLaunch == nil)
    }

    /// Its runtime threw: a named instance's own fatal, or load failure,
    /// charges it although no view of it was shown yet.
    @Test
    func aNamedInstancesOwnFatalChargesItBeforeItsLaunchStarted() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        #expect(process.coordinator.launch(named: Self.widget)?.isArmed == false)

        process.coordinator.chargeFatal(owner: Self.widget)

        // No slot yet, so the native crash that follows writes nothing else.
        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.attributedWithoutSlot)
        #expect(markers(process.coordinator).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.main).path))
        let next = scene.nextLaunch()
        #expect(next[Self.widget]?.launchedBundleId == "widget-stable")
        #expect(scene.crashHistory(Self.widget).contains("widget-next"))
        #expect(next[Self.main]?.launchedBundleId == "main-next")
    }

    @Test
    func aFatalNoModuleClaimsIsInferredOnlyWhenOneLaunchCanHaveThrownIt() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator

        // Main is still unverified: it may be main's.
        #expect(coordinator.inferredFatalOwner() == nil)
        _ = coordinator.contentAppeared(owner: nil)
        // Main verified, the widget unverified and its runtime without a module.
        #expect(coordinator.inferredFatalOwner() == Self.widget)
        // Once its runtime has a module, its fatals are attributed directly.
        coordinator.runtimeResolved(name: Self.widget)
        #expect(coordinator.inferredFatalOwner() == nil)
        // A new launch of it has no module yet again.
        coordinator.startMonitoring(name: Self.widget, bundleId: "widget-next", shouldRollback: true)
        #expect(coordinator.inferredFatalOwner() == Self.widget)
        // Two named launches that can have thrown it: neither.
        coordinator.register(name: "checkout", markerURL: scene.documents.appendingPathComponent("checkout.json"), storage: NoStorage())
        coordinator.startMonitoring(name: "checkout", bundleId: nil, shouldRollback: false)
        #expect(coordinator.inferredFatalOwner() == nil)
        // A verified named launch can't have thrown a launch's fatal.
        _ = coordinator.contentAppeared(owner: "checkout")
        #expect(coordinator.inferredFatalOwner() == Self.widget)
        _ = coordinator.contentAppeared(owner: Self.widget)
        #expect(coordinator.inferredFatalOwner() == nil)
    }

    /// A launch that wouldn't roll back, such as a built-in or retried one,
    /// may still be the runtime that threw before it finished loading.
    @Test
    func aFatalIsNotInferredWhileALaunchWithoutRollbackMayHaveThrownIt() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        func coordinator(_ launches: [(name: String, shouldRollback: Bool)]) -> HotUpdaterRecoveryCoordinator {
            let coordinator = HotUpdaterRecoveryCoordinator(sink: RecordingSlotSink())
            for launch in launches {
                coordinator.register(
                    name: launch.name,
                    markerURL: directory.appendingPathComponent("\(launch.name).json"),
                    storage: NoStorage()
                )
                coordinator.startMonitoring(name: launch.name, bundleId: nil, shouldRollback: launch.shouldRollback)
            }
            return coordinator
        }

        // Main runs its built-in bundle, which failed to load: no content.
        let mainBuiltIn = coordinator([(Self.main, false), (Self.widget, true)])
        mainBuiltIn.stopAwaitingContent(name: Self.main)
        #expect(mainBuiltIn.inferredFatalOwner() == nil)
        _ = mainBuiltIn.contentAppeared(owner: nil)
        #expect(mainBuiltIn.inferredFatalOwner() == nil)
        mainBuiltIn.startMonitoring(name: Self.main, bundleId: nil, shouldRollback: false)
        _ = mainBuiltIn.contentAppeared(owner: nil)
        #expect(mainBuiltIn.inferredFatalOwner() == Self.widget)

        // Another named instance on its built-in bundle, without a module and
        // without content (its bundle failed to load), beside a pending one.
        let namedBuiltIn = coordinator([(Self.main, false), (Self.widget, true), ("checkout", false)])
        _ = namedBuiltIn.contentAppeared(owner: nil)
        namedBuiltIn.stopAwaitingContent(name: "checkout")
        #expect(namedBuiltIn.inferredFatalOwner() == nil)
        namedBuiltIn.runtimeResolved(name: "checkout")
        #expect(namedBuiltIn.inferredFatalOwner() == Self.widget)

        // The only launch that may have thrown it wouldn't roll back.
        let onlyBuiltIn = coordinator([(Self.main, false), (Self.widget, false)])
        _ = onlyBuiltIn.contentAppeared(owner: nil)
        #expect(onlyBuiltIn.inferredFatalOwner() == nil)

        // A named instance that never launched in this process can't have.
        let unlaunched = coordinator([(Self.main, false), (Self.widget, true)])
        unlaunched.register(name: "checkout", markerURL: directory.appendingPathComponent("idle.json"), storage: NoStorage())
        _ = unlaunched.contentAppeared(owner: nil)
        #expect(unlaunched.inferredFatalOwner() == Self.widget)
    }

    /// Two named runtimes still evaluate their bundles, so neither has a
    /// module: the fatal's JavaScript stack names the one that threw.
    @Test
    func aFatalIsAttributedByTheBundlesInItsJavaScriptStack() throws {
        let documents = "/var/mobile/Containers/Data/Application/APP/Documents"
        let router = HotUpdaterInstanceRouter()
        let framework = URL(fileURLWithPath: "/private/var/containers/Bundle/Application/APP/Host.app/Frameworks/Checkout.framework/main.jsbundle")
        router.record(launchURL: framework, name: "checkout")
        let resolve: (URL) -> String = {
            router.resolve(bundleURL: $0, candidates: [Self.widget, "checkout"], documentsPath: documents)
        }
        let widgetBundle = "file://\(documents)/hot-updater-instances/widget/bundle-store/0199-widget/index.ios.bundle"
        // As RCTExceptionsManager reports them (RCTJSStackTraceKey): Hermes
        // bytecode frames carry the evaluated source URL, others none.
        func frame(_ file: String?, _ method: String) -> [String: Any] {
            var frame: [String: Any] = ["methodName": method, "lineNumber": 1, "column": 48213]
            if let file { frame["file"] = file }
            return frame
        }

        let widgetThrew: [[String: Any]] = [
            frame(widgetBundle, "render"),
            frame("unknown", "global"),
            frame(nil, "anonymous"),
            frame(widgetBundle, "loadModuleImplementation"),
        ]
        #expect(HotUpdaterJSStackOwner.owner(of: widgetThrew, resolve: resolve) == Self.widget)
        // A path without a scheme, and Hermes' "address at" form.
        #expect(HotUpdaterJSStackOwner.owner(
            of: [frame("address at \(documents)/hot-updater-instances/widget/bundle-store/0199-widget/index.ios.bundle", "f")],
            resolve: resolve
        ) == Self.widget)
        // The framework's embedded bundle the checkout instance handed out.
        #expect(HotUpdaterJSStackOwner.owner(of: [frame(framework.absoluteString, "f")], resolve: resolve) == "checkout")
        // Main's own bundle, or a development server, is main's.
        #expect(HotUpdaterJSStackOwner.owner(
            of: [frame("file://\(documents)/bundle-store/0199-main/index.ios.bundle", "f")],
            resolve: resolve
        ) == Self.main)
        // Frames of two instances, or none with a bundle: nobody's.
        #expect(HotUpdaterJSStackOwner.owner(
            of: [frame(widgetBundle, "f"), frame(framework.absoluteString, "g")],
            resolve: resolve
        ) == nil)
        #expect(HotUpdaterJSStackOwner.owner(of: [frame("unknown", "global"), frame("[native code]", "h")], resolve: resolve) == nil)
        #expect(HotUpdaterJSStackOwner.owner(of: nil, resolve: resolve) == nil)
        #expect(HotUpdaterJSStackOwner.owner(of: NSNull(), resolve: resolve) == nil)
    }

    /// A fatal of another instance can arrive before an earlier fatal's
    /// handler returns. Releasing the earlier claim leaves the later one in
    /// place; releasing the later one starts again every launch either
    /// stopped, the later owner's included.
    @Test
    func overlappingClaimsReleaseTogetherWithTheLatest() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        process.storages[Self.main]?.markLaunchStarted(bundleId: "main-next")
        #expect(coordinator.arm(name: Self.widget))
        let widgetSlot = try #require(coordinator.launch(named: Self.widget)?.slot)

        let first = try #require(coordinator.chargeFatal(owner: Self.main))
        // Main's fatal stopped the widget's launch; then the widget throws.
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        let second = try #require(coordinator.chargeFatal(owner: Self.widget))
        #expect(scene.metadata(Self.main)?.launchInProgress == false)

        // Main's handler returns first: the widget's crash is still its own.
        coordinator.clearAttribution(claim: first)
        #expect(process.sink.attribution == widgetSlot)
        #expect(coordinator.attributedOwner == Self.widget)
        #expect(scene.metadata(Self.main)?.launchInProgress == false)

        coordinator.clearAttribution(claim: second)
        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.unattributed)
        #expect(scene.metadata(Self.main)?.launchInProgress == true)
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)
        #expect(coordinator.launch(named: Self.widget)?.isArmed == true)
        #expect(markers(coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true, widgetSlot: true])
    }

    /// A named runtime can render before its module exists, so content
    /// nothing claims is held while a named launch's runtime is unresolved,
    /// instead of verifying main.
    @Test
    func contentNoRuntimeClaimsWaitsForTheNamedRuntimes() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let mainView = NSObject()
        let widgetView = NSObject()
        var owners: [ObjectIdentifier: String] = [:]
        let owner: (AnyObject) -> String? = { owners[ObjectIdentifier($0)] }

        // The widget renders before its module exists, then main does.
        #expect(coordinator.holdUnclaimedContent(widgetView))
        #expect(coordinator.holdUnclaimedContent(mainView))
        #expect(scene.metadata(Self.main)?.verificationPending == true)
        #expect(scene.metadata(Self.widget)?.verificationPending == true)

        // The widget's module appears: its content verifies it, and the rest
        // is main's once no named runtime is left unresolved.
        coordinator.runtimeResolved(name: Self.widget)
        owners[ObjectIdentifier(widgetView)] = Self.widget
        let verified = coordinator.releaseHeldContent(owner: owner)
        #expect(Set(verified.map(\.launch.name)) == [Self.main, Self.widget])
        #expect(scene.metadata(Self.widget)?.verificationPending == false)
        #expect(scene.metadata(Self.main)?.verificationPending == false)
        // Its surface start, resolved after, no longer starts the launch.
        #expect(!coordinator.arm(name: Self.widget))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        #expect(coordinator.releaseHeldContent(owner: owner).isEmpty)
    }

    @Test
    func heldContentFallsToMainWhenTheNamedLaunchStopsWaiting() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let view = NSObject()

        #expect(coordinator.holdUnclaimedContent(view))
        // Nothing resolved yet: still held.
        #expect(coordinator.releaseHeldContent(owner: { _ in nil }).isEmpty)
        #expect(scene.metadata(Self.main)?.verificationPending == true)

        // The widget's bundle failed to load: it waits for no content.
        coordinator.stopAwaitingContent(name: Self.widget)
        #expect(coordinator.releaseHeldContent(owner: { _ in nil }).map(\.launch.name) == [Self.main])
        #expect(scene.metadata(Self.main)?.verificationPending == false)
        // Now nothing waits for a runtime: content nobody claims is main's at once.
        #expect(!coordinator.holdUnclaimedContent(NSObject()))
    }

    /// A named runtime whose JavaScript never loads Hot Updater never
    /// resolves: main's content waits for it only so long.
    @Test
    func heldContentIsMainsAfterTheBoundAndStillVerifiesALateNamedRuntime() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        var clock: TimeInterval = 100
        let process = scene.launch(now: { clock })
        let coordinator = process.coordinator
        let mainView = NSObject()
        let widgetView = NSObject()
        var owners: [ObjectIdentifier: String] = [:]
        let owner: (AnyObject) -> String? = { owners[ObjectIdentifier($0)] }

        #expect(coordinator.holdUnclaimedContent(widgetView))
        clock += 2
        #expect(coordinator.holdUnclaimedContent(mainView))
        clock += HotUpdaterRecoveryCoordinator.heldContentBound - 1
        // The widget's content has waited the bound, main's not yet: main is
        // verified once, by the first.
        #expect(coordinator.releaseHeldContent(owner: owner).map(\.launch.name) == [Self.main])
        #expect(scene.metadata(Self.main)?.verificationPending == false)
        #expect(scene.metadata(Self.widget)?.verificationPending == true)
        clock += 2
        #expect(coordinator.releaseHeldContent(owner: owner).isEmpty)

        // The widget's module appears late: the content it showed verifies it,
        // and its surface start then doesn't start the launch.
        coordinator.runtimeResolved(name: Self.widget)
        owners[ObjectIdentifier(widgetView)] = Self.widget
        #expect(coordinator.releaseHeldContent(owner: owner).map(\.launch.name) == [Self.widget])
        #expect(scene.metadata(Self.widget)?.verificationPending == false)
        #expect(!coordinator.arm(name: Self.widget))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
    }

    @Test
    func mainOnlyContentIsMainsAtOnce() throws {
        let sink = RecordingSlotSink()
        let coordinator = HotUpdaterRecoveryCoordinator(sink: sink)
        coordinator.register(name: Self.main, markerURL: URL(fileURLWithPath: "/tmp/m.json"), storage: NoStorage())
        coordinator.startMonitoring(name: Self.main, bundleId: nil, shouldRollback: false)
        #expect(!coordinator.holdUnclaimedContent(NSObject()))
        // A named instance that never launched in this process holds nothing.
        coordinator.register(name: Self.widget, markerURL: URL(fileURLWithPath: "/tmp/w.json"), storage: NoStorage())
        #expect(!coordinator.holdUnclaimedContent(NSObject()))
    }

    @Test
    func aFatalNothingAttributesChargesEveryUnverifiedLaunch() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        #expect(process.coordinator.arm(name: Self.widget))

        process.coordinator.chargeFatal(owner: nil)

        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.unattributed)
        let next = scene.nextLaunch()
        #expect(next[Self.main]?.launchedBundleId == "main-stable")
        #expect(next[Self.widget]?.launchedBundleId == "widget-stable")
    }

    @Test
    func surfacesThatStartedBeforeTheirRuntimeIsKnownResolveLater() {
        let pending = HotUpdaterPendingSurfaceStarts()
        let widgetSurface = NSObject()
        let mainSurface = NSObject()
        var gone: NSObject? = NSObject()
        pending.add(widgetSurface, inForeground: true)
        pending.add(mainSurface, inForeground: false)
        pending.add(gone!, inForeground: true)
        gone = nil

        // Only the widget's runtime is known yet.
        let first = pending.resolve { $0 === widgetSurface ? Self.widget : nil }
        #expect(first.map(\.name) == [Self.widget])
        #expect(first.map(\.inForeground) == [true])
        #expect(first.first?.surface === widgetSurface)
        #expect(pending.count == 1)

        let second = pending.resolve { $0 === mainSurface ? Self.main : nil }
        #expect(second.map(\.name) == [Self.main])
        #expect(second.map(\.inForeground) == [false])
        #expect(pending.count == 0)
    }

    /// A view that started in the background starts its launch on the next
    /// foreground only if it is still shown then.
    @Test
    func aViewStartedInTheBackgroundStartsItsLaunchOnlyIfStillShown() {
        let starts = HotUpdaterBackgroundViewStarts()
        let shown = NSObject()
        var discarded: NSObject? = NSObject()
        let detached = NSObject()
        let isShown: (AnyObject) -> Bool = { $0 === shown }

        // Discarded, or stopped and out of its window: nothing to start.
        starts.add(discarded!)
        starts.add(detached)
        discarded = nil
        #expect(!starts.takeAnyShown(isShown))
        #expect(starts.isEmpty)

        // One of its views is still shown.
        starts.add(detached)
        starts.add(shown)
        #expect(starts.takeAnyShown(isShown))
        // Taken: the next foreground needs a view that starts again.
        #expect(!starts.takeAnyShown(isShown))

        starts.add(shown)
        starts.removeAll()
        #expect(!starts.takeAnyShown(isShown))
    }

    // MARK: - Sweeps

    @Test(arguments: ["main", "widget"])
    func crashMarkersSurviveBundleStoreSweeps(name: String) throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let storage = scene.makeStorage(name)
        let marker = scene.markerURL(name)
        HotUpdaterCrashMarker.write(bundleId: "\(name)-next", shouldRollback: true, to: marker)

        _ = storage.cleanupOldBundles(currentBundleId: nil, bundleId: nil)
        #expect(FileManager.default.fileExists(atPath: marker.path))
        _ = storage.resetChannel()
        #expect(FileManager.default.fileExists(atPath: marker.path))
        #expect(HotUpdaterCrashMarker.consume(at: marker)?.launchedBundleId == "\(name)-next")
    }
}

// MARK: - Fixtures

/// What a native crash writes now: each slot, and whether it asks for rollback.
private func markers(_ coordinator: HotUpdaterRecoveryCoordinator) -> [Int: Bool] {
    Dictionary(uniqueKeysWithValues: coordinator.nativeCrashMarkers().map { ($0.slot, $0.shouldRollback) })
}

/// Main and `widget`, each with a stable bundle and a pending `<name>-next`.
private final class Scene {
    struct Process {
        let coordinator: HotUpdaterRecoveryCoordinator
        let sink: RecordingSlotSink
        let storages: [String: BundleFileStorageService]
    }

    let documents: URL
    private let environments: [String: HotUpdaterInstanceEnvironment]
    private let preferences: [String: InMemoryPreferences]

    init() throws {
        documents = try makeTemporaryDirectory()
        let widget = try HotUpdaterInstanceEnvironment(name: "widget", bundle: namedTestBundle)
        environments = ["main": .main, "widget": widget]
        preferences = ["main": InMemoryPreferences(), "widget": InMemoryPreferences()]
        for (name, environment) in environments {
            let store = storeURL(environment)
            for bundleId in ["\(name)-stable", "\(name)-next"] {
                let directory = store.appendingPathComponent(bundleId, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try Data("bundle-content\n".utf8).write(to: directory.appendingPathComponent("index.ios.bundle"))
                let manifest: [String: Any] = [
                    "bundleId": bundleId,
                    "assets": ["index.ios.bundle": ["fileHash": "bundle-hash"]],
                ]
                try JSONSerialization.data(withJSONObject: manifest)
                    .write(to: directory.appendingPathComponent("manifest.json"))
            }
            #expect(BundleMetadata(
                isolationKey: isolationKey(name),
                stableBundleId: "\(name)-stable",
                stagingBundleId: "\(name)-next",
                verificationPending: true
            ).save(to: store.appendingPathComponent(BundleMetadata.metadataFilename)))
        }
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: documents)
    }

    func markerURL(_ name: String) -> URL {
        HotUpdaterCrashMarker.url(for: environments[name]!, documentsPath: documents.path)
    }

    func makeStorage(_ name: String) -> BundleFileStorageService {
        BundleFileStorageService(
            fileSystem: DocumentsFileSystem(documents: documents),
            downloadService: NoDownloads(),
            preferences: preferences[name]!,
            isolationKey: isolationKey(name),
            instance: environments[name]!,
            builtInBundleIdProvider: { "builtin-bundle" },
            downloadRetryDelay: 0
        )
    }

    /// One process that selected both pending bundles and watches both
    /// launches, as HotUpdaterImpl's launch does.
    func launch(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) -> Process {
        let sink = RecordingSlotSink()
        let coordinator = HotUpdaterRecoveryCoordinator(sink: sink, now: now)
        var storages: [String: BundleFileStorageService] = [:]
        for name in ["main", "widget"] {
            let storage = makeStorage(name)
            let selection = storage.prepareLaunch(bundle: bundle(name), pendingRecovery: nil)
            #expect(selection.launchedBundleId == "\(name)-next")
            coordinator.register(name: name, markerURL: markerURL(name), storage: storage)
            coordinator.startMonitoring(
                name: name,
                bundleId: selection.launchedBundleId,
                shouldRollback: selection.shouldRollbackOnCrash
            )
            storages[name] = storage
        }
        return Process(coordinator: coordinator, sink: sink, storages: storages)
    }

    /// The next process: each instance consumes its own marker.
    func nextLaunch() -> [String: LaunchSelection] {
        var selections: [String: LaunchSelection] = [:]
        for name in ["main", "widget"] {
            selections[name] = makeStorage(name).prepareLaunch(
                bundle: bundle(name),
                pendingRecovery: HotUpdaterCrashMarker.consume(at: markerURL(name))
            )
        }
        return selections
    }

    func metadata(_ name: String) -> BundleMetadata? {
        BundleMetadata.load(
            from: storeURL(environments[name]!).appendingPathComponent(BundleMetadata.metadataFilename),
            expectedIsolationKey: isolationKey(name)
        )
    }

    func crashHistory(_ name: String) -> CrashedHistory {
        CrashedHistory.load(
            from: storeURL(environments[name]!).appendingPathComponent(CrashedHistory.crashedHistoryFilename)
        )
    }

    private func storeURL(_ environment: HotUpdaterInstanceEnvironment) -> URL {
        URL(fileURLWithPath: environment.bundleStorePath(documentsPath: documents.path), isDirectory: true)
    }

    private func isolationKey(_ name: String) -> String { "\(name)-isolation-key" }

    private func bundle(_ name: String) -> Bundle { name == "main" ? .main : namedTestBundle }
}

private final class RecordingSlotSink: HotUpdaterCrashSlotSink {
    var paths: [Int: String] = [:]
    var bundleIds: [Int: String?] = [:]
    var flags: [Int: Bool] = [:]
    var attribution = HotUpdaterRecoveryCoordinator.unattributed

    func updateSlot(_ slot: Int, markerPath: String, bundleId: String?, shouldRollback: Bool) {
        paths[slot] = markerPath
        bundleIds[slot] = bundleId
        flags[slot] = shouldRollback
    }

    func attributeCrash(toSlot slot: Int) {
        attribution = slot
    }
}

private final class DocumentsFileSystem: FileManagerService {
    private let documents: URL

    init(documents: URL) {
        self.documents = documents
    }

    override func documentsPath() -> String { documents.path }

    override func applicationSupportPath() -> String {
        documents.appendingPathComponent("ApplicationSupport", isDirectory: true).path
    }
}

private final class InMemoryPreferences: PreferencesService {
    private var values: [String: String] = [:]

    func getItem(forKey key: String) throws -> String? { values[key] }

    func setItem(_ value: String?, forKey key: String) throws { values[key] = value }
}

private final class NoDownloads: DownloadService {
    func downloadFile(
        from _: URL,
        to _: String,
        fileSizeHandler _: ((Int64) -> Void)?,
        progressHandler _: @escaping (DownloadProgress) -> Void,
        completion _: @escaping (Result<URL, Error>) -> Void
    ) -> URLSessionDownloadTask? {
        Issue.record("downloadFile should not be called")
        return nil
    }
}

/// Storage of a launch these tests only count slots for.
private final class NoStorage: BundleStorageService {
    func setBundleURL(localPath _: String?) -> Result<Void, Error> { .success(()) }
    func getCachedBundleURL() -> URL? { nil }
    func getFallbackBundleURL(bundle _: Bundle) -> URL? { nil }
    func prepareLaunch(bundle _: Bundle, pendingRecovery _: PendingCrashRecovery?) -> LaunchSelection {
        LaunchSelection(bundleURL: nil, launchedBundleId: nil, shouldRollbackOnCrash: false)
    }
    func updateBundle(
        bundleId _: String,
        manifestUrl _: URL,
        manifestFileHash _: String,
        archiveUrl _: URL?,
        assets _: [String: ChangedAssetDescriptor],
        fileResolver _: ArtifactFileResolver?,
        selection _: PersistedSelection?,
        progressHandler _: @escaping (UpdateProgressPayload) -> Void,
        completion _: @escaping (Result<UpdateDelivery, Error>) -> Void
    ) {}
    func markLaunchStarted(bundleId _: String?) {}
    func markLaunchCompleted(bundleId _: String?) {}
    func notifyAppReady() -> [String: Any] { [:] }
    func getCrashHistory() -> CrashedHistory { CrashedHistory() }
    func clearCrashHistory() -> Bool { true }
    func getInstallId() -> String { "" }
    func getBaseURL() -> String { "" }
    func getBaseURL(forBundleId _: String?) -> String { "" }
    func getBundleId() -> String? { nil }
    func getManifest() -> ManifestAssets { [:] }
    func getManifest(forBundleId _: String?) -> ManifestAssets { [:] }
    func resetChannel() -> Result<Bool, Error> { .success(true) }
}

private func makeTemporaryDirectory() throws -> URL {
    try FileManager.default.url(
        for: .itemReplacementDirectory,
        in: .userDomainMask,
        appropriateFor: FileManager.default.temporaryDirectory,
        create: true
    )
}
#endif
