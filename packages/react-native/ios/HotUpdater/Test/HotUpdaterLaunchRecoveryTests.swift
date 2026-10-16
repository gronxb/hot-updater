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

        // It takes a slot that asks for rollback, and the native crash that
        // follows writes only that one.
        let widgetSlot = try #require(process.coordinator.launch(named: Self.widget)?.slot)
        #expect(process.sink.attribution == widgetSlot)
        #expect(markers(process.coordinator) == [widgetSlot: true])
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
    /// The later fatal's handler returns first while the earlier fatal is
    /// still forwarded: the earlier one's claim stays published and nothing
    /// starts again until it returns too.
    @Test
    func aLaterClaimReturningFirstLeavesTheEarlierOneInPlace() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        process.storages[Self.main]?.markLaunchStarted(bundleId: "main-next")
        #expect(coordinator.arm(name: Self.widget))
        let widgetSlot = try #require(coordinator.launch(named: Self.widget)?.slot)

        let first = try #require(coordinator.chargeFatal(owner: Self.main))
        let second = try #require(coordinator.chargeFatal(owner: Self.widget))
        #expect(process.sink.attribution == widgetSlot)

        coordinator.clearAttribution(claim: second)
        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.mainSlot)
        #expect(coordinator.attributedOwner == Self.main)
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        #expect(scene.metadata(Self.main)?.launchInProgress == false)
        #expect(markers(coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true])

        coordinator.clearAttribution(claim: first)
        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.unattributed)
        #expect(coordinator.attributedOwner == nil)
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)
        #expect(scene.metadata(Self.main)?.launchInProgress == true)
    }

    /// A load failure, then the fatal React Native reports for it: one
    /// crash, one claim, released when the fatal's handler returns.
    @Test
    func aLoadFailuresFatalTakesOverItsClaim() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        process.storages[Self.main]?.markLaunchStarted(bundleId: "main-next")

        let loadFailure = try #require(coordinator.chargeLoadFailure(owner: Self.widget))
        #expect(coordinator.attributedOwner == Self.widget)
        let fatal = try #require(coordinator.chargeFatal(owner: Self.widget))
        #expect(fatal == loadFailure)
        #expect(coordinator.activeClaimCount == 1)
        coordinator.clearAttribution(claim: fatal)
        #expect(coordinator.activeClaimCount == 0)
        #expect(coordinator.attributedOwner == nil)
        #expect(scene.metadata(Self.main)?.launchInProgress == true)
        // Taken over: the bound no longer applies to it.
        #expect(coordinator.chargeFatal(owner: Self.widget) != loadFailure)
    }

    /// A load failure whose fatal never comes doesn't keep other launches
    /// stopped: its claim ends after the bound, or when the instance
    /// launches again.
    @Test
    func aLoadFailureWithoutItsFatalIsReleased() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        var clock: TimeInterval = 0
        let process = scene.launch(now: { clock })
        let coordinator = process.coordinator
        process.storages[Self.main]?.markLaunchStarted(bundleId: "main-next")

        coordinator.chargeLoadFailure(owner: Self.widget)
        clock += HotUpdaterRecoveryCoordinator.loadFailureClaimBound - 1
        coordinator.releaseExpiredLoadFailureClaims()
        #expect(coordinator.activeClaimCount == 1)
        #expect(scene.metadata(Self.main)?.launchInProgress == false)
        clock += 1
        coordinator.releaseExpiredLoadFailureClaims()
        #expect(coordinator.activeClaimCount == 0)
        #expect(coordinator.attributedOwner == nil)
        #expect(scene.metadata(Self.main)?.launchInProgress == true)

        coordinator.chargeLoadFailure(owner: Self.widget)
        #expect(coordinator.activeClaimCount == 1)
        coordinator.startMonitoring(name: Self.widget, bundleId: "widget-next", shouldRollback: true)
        #expect(coordinator.activeClaimCount == 0)
    }

    /// The widget's load failure is waiting for its fatal when main's fatal
    /// claims a crash: the widget's fatal still takes over its own claim.
    @Test
    func aLoadFailuresFatalFindsItsClaimBehindAnotherOne() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let loadFailure = try #require(coordinator.chargeLoadFailure(owner: Self.widget))
        let mainFatal = try #require(coordinator.chargeFatal(owner: Self.main))
        #expect(coordinator.chargeFatal(owner: Self.widget) == loadFailure)
        #expect(coordinator.activeClaimCount == 2)
        coordinator.clearAttribution(claim: loadFailure)
        coordinator.clearAttribution(claim: mainFatal)
        #expect(coordinator.activeClaimCount == 0)
    }

    /// A module-less runtime's fatal with a stack of its own is its own,
    /// even while another runtime's fatal holds a claim; the claim decides
    /// only for a follow-up fatal with nothing of its own to tell.
    @Test
    func aFatalsOwnerComesFromItsModuleThenStackThenClaim() {
        typealias Coordinator = HotUpdaterRecoveryCoordinator
        let stack = Coordinator.fatalOwner(
            module: nil,
            stack: (Self.widget, nil),
            claim: Self.main,
            inference: { "checkout" }
        )
        #expect(stack?.name == Self.widget)
        #expect(stack?.attribution == .stack)
        let module = Coordinator.fatalOwner(
            module: ("checkout", nil),
            stack: (Self.widget, nil),
            claim: Self.main,
            inference: { nil }
        )
        #expect(module?.attribution == .runtimeModule)
        #expect(Coordinator.fatalOwner(module: nil, stack: nil, claim: Self.main, inference: { Self.widget })?.attribution == .claim)
        #expect(Coordinator.fatalOwner(module: nil, stack: nil, claim: nil, inference: { Self.widget })?.attribution == .inference)
        #expect(Coordinator.fatalOwner(module: nil, stack: nil, claim: nil, inference: { nil }) == nil)
    }

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

    /// Callbacks posted to the main queue, scheduled checks, and launches on
    /// other threads interleave: whatever was scheduled for one launch never
    /// acts on a later one.
    @Test
    func callbacksOfAnEarlierLaunchNeverActOnALaterOne() throws {
        let coordinator = HotUpdaterRecoveryCoordinator(sink: RecordingSlotSink())
        for name in [Self.main, Self.widget] {
            coordinator.register(name: name, markerURL: URL(fileURLWithPath: "/tmp/\(name).json"), storage: NoStorage())
        }
        let mainFirst = coordinator.startMonitoring(name: Self.main, bundleId: "m", shouldRollback: true)
        let widgetFirst = coordinator.startMonitoring(name: Self.widget, bundleId: "w", shouldRollback: true)
        #expect(coordinator.generations() == [Self.main: mainFirst, Self.widget: widgetFirst])

        // Main's recovery reload, in a process with only main: the reload of
        // its first launch is requested, then a second launch requests its own.
        let mainOnly = HotUpdaterRecoveryCoordinator(sink: RecordingSlotSink())
        mainOnly.register(name: Self.main, markerURL: URL(fileURLWithPath: "/tmp/main-only.json"), storage: NoStorage())
        let reloadFirst = mainOnly.startMonitoring(name: Self.main, bundleId: "m", shouldRollback: true)
        #expect(mainOnly.requestRecovery(name: Self.main) != .notNeeded)
        let reloadSecond = mainOnly.startMonitoring(name: Self.main, bundleId: "m", shouldRollback: true)
        #expect(mainOnly.requestRecovery(name: Self.main) == .requested(generation: reloadSecond, bundleId: "m"))
        // The first reload's failure arrives late: the second's request stays.
        mainOnly.recoveryReloadFailed(name: Self.main, generation: reloadFirst)
        #expect(mainOnly.requestRecovery(name: Self.main) == .alreadyRequested)
        // Its own failure lets it request again.
        mainOnly.recoveryReloadFailed(name: Self.main, generation: reloadSecond)
        #expect(mainOnly.requestRecovery(name: Self.main) == .requested(generation: reloadSecond, bundleId: "m"))

        // The widget launches again on another thread.
        let widgetSecond = coordinator.startMonitoring(name: Self.widget, bundleId: "w", shouldRollback: true)
        // A view of its first launch, a load failure of it, and its content
        // reach the main queue late.
        #expect(!coordinator.arm(name: Self.widget, generation: widgetFirst))
        coordinator.stopAwaitingContent(name: Self.widget, generation: widgetFirst)
        #expect(coordinator.awaitingContentGeneration(name: Self.widget) == widgetSecond)
        #expect(coordinator.contentAppeared(owner: Self.widget, generation: widgetFirst) == nil)
        // The grace period of the first launch ends: the second is still watched.
        coordinator.finishMonitoring(name: Self.widget, generation: widgetFirst)
        #expect(coordinator.awaitingContentGeneration(name: Self.widget) == widgetSecond)

        #expect(coordinator.arm(name: Self.widget, generation: widgetSecond))
        #expect(coordinator.contentAppeared(owner: Self.widget, generation: widgetSecond)?.generation == widgetSecond)
    }

    /// Main-queue work queued for launch N runs after launch N+1's: it does
    /// nothing, so N+1's foreground observers stay.
    @Test
    func workQueuedForAnEarlierLaunchRunsAfterALaterOnesAsNothing() {
        var latest = HotUpdaterLatestGeneration()
        let newer = latest.admit(2)
        let stale = latest.admit(1)
        let again = latest.admit(2)
        let next = latest.admit(3)
        #expect(newer)
        #expect(!stale)
        #expect(again)
        #expect(next)
        #expect(latest.latest == 3)
    }

    @Test
    func heldContentNeverVerifiesALaterLaunch() throws {
        var clock: TimeInterval = 0
        let coordinator = HotUpdaterRecoveryCoordinator(sink: RecordingSlotSink(), now: { clock })
        for name in [Self.main, Self.widget, "checkout"] {
            coordinator.register(name: name, markerURL: URL(fileURLWithPath: "/tmp/\(name).json"), storage: NoStorage())
            coordinator.startMonitoring(name: name, bundleId: nil, shouldRollback: true)
        }
        let mainView = NSObject()
        let widgetView = NSObject()
        #expect(coordinator.holdUnclaimedContent(mainView))
        #expect(coordinator.holdUnclaimedContent(widgetView))

        // Both launch again before the content is credited.
        let mainSecond = coordinator.startMonitoring(name: Self.main, bundleId: nil, shouldRollback: true)
        let widgetSecond = coordinator.startMonitoring(name: Self.widget, bundleId: nil, shouldRollback: true)
        clock += HotUpdaterRecoveryCoordinator.heldContentBound
        coordinator.runtimeResolved(name: Self.widget)
        let verified = coordinator.releaseHeldContent(owner: { $0 === widgetView ? Self.widget : nil })
        #expect(verified.isEmpty)
        #expect(coordinator.awaitingContentGeneration(name: Self.main) == mainSecond)
        #expect(coordinator.awaitingContentGeneration(name: Self.widget) == widgetSecond)
    }

    @Test
    func aSurfaceKeepsTheLaunchItStartedIn() {
        let pending = HotUpdaterPendingSurfaceStarts()
        let surface = NSObject()
        pending.add(surface, inForeground: true, generations: [Self.main: 1, Self.widget: 3])
        let resolved = pending.resolve { _ in Self.widget }
        #expect(resolved.map(\.generation) == [3])
        let other = NSObject()
        pending.add(other, inForeground: true, generations: [Self.main: 1])
        #expect(pending.resolve { _ in Self.widget }.map(\.generation) == [nil])
    }

    /// A load failure no runtime claims, while a named runtime that has no
    /// module may be the one that failed, starts no recovery of main: the
    /// fatal that follows charges every launch that may have failed.
    @Test
    func anUnclaimedLoadFailureIsLeftToItsFatalWhileANamedRuntimeIsUnknown() throws {
        let mainOnly = HotUpdaterRecoveryCoordinator(sink: RecordingSlotSink())
        mainOnly.register(name: Self.main, markerURL: URL(fileURLWithPath: "/tmp/m.json"), storage: NoStorage())
        mainOnly.startMonitoring(name: Self.main, bundleId: nil, shouldRollback: true)
        #expect(!mainOnly.deferUnclaimedLoadFailure())
        #expect(!mainOnly.takeDeferredLoadFailure())

        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        #expect(coordinator.deferUnclaimedLoadFailure())
        #expect(coordinator.takeDeferredLoadFailure())
        #expect(!coordinator.takeDeferredLoadFailure())
        // Two runtimes fail close together: each unclaimed fatal takes one.
        #expect(coordinator.deferUnclaimedLoadFailure())
        #expect(coordinator.deferUnclaimedLoadFailure())
        #expect(coordinator.takeDeferredLoadFailure())
        #expect(coordinator.takeDeferredLoadFailure())
        #expect(!coordinator.takeDeferredLoadFailure())

        // The widget's view hasn't shown, yet its bundle may be the one.
        #expect(coordinator.launch(named: Self.widget)?.isArmed == false)
        coordinator.chargeUnclaimedLoadFailure()
        let next = scene.nextLaunch()
        #expect(next[Self.widget]?.launchedBundleId == "widget-stable")
        #expect(next[Self.main]?.launchedBundleId == "main-stable")
    }

    /// The fatal after a deferred load failure may be attributed by its
    /// stack: it takes the deferral, so a later unrelated fatal doesn't.
    /// A fatal of a runtime with a module, or of a claimed crash, never does.
    @Test
    func onlyAFatalOfAModulelessRuntimeTakesADeferredLoadFailure() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator

        #expect(coordinator.deferUnclaimedLoadFailure())
        #expect(coordinator.takeDeferredLoadFailure(for: .runtimeModule, owner: Self.widget) == nil)
        #expect(coordinator.takeDeferredLoadFailure(for: .claim, owner: Self.widget) == nil)
        #expect(coordinator.takeDeferredLoadFailure(for: .stack, owner: Self.widget) != nil)
        // Taken: the next unattributed fatal is an ordinary one.
        #expect(coordinator.takeDeferredLoadFailure(for: .none) == nil)

        #expect(coordinator.deferUnclaimedLoadFailure())
        #expect(coordinator.takeDeferredLoadFailure(for: .inference, owner: Self.widget) != nil)
        #expect(coordinator.deferUnclaimedLoadFailure())
        // While an earlier runtime's claim accounts for an unattributed fatal.
        let claim = try #require(coordinator.chargeFatal(
            owner: Self.widget,
            runtimeBundleURL: scene.launchURL(Self.widget, bundleId: "widget-stable")
        ))
        #expect(coordinator.takeDeferredLoadFailure(for: .none) == nil)
        coordinator.clearAttribution(claim: claim)
        #expect(coordinator.takeDeferredLoadFailure(for: .none) != nil)
    }

    /// A deferred load failure belongs to the launches that could have
    /// failed when it was reported: a runtime started since then neither
    /// takes it with its own fatal nor is charged for it.
    @Test
    func aDeferredLoadFailureKeepsTheLaunchesItWasReportedFor() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        _ = coordinator.contentAppeared(owner: nil)
        #expect(coordinator.deferUnclaimedLoadFailure())

        // Checkout starts after the load failure and throws, by its stack.
        let checkoutMarker = scene.documents.appendingPathComponent("checkout-marker.json")
        coordinator.register(name: "checkout", markerURL: checkoutMarker, storage: NoStorage())
        coordinator.startMonitoring(name: "checkout", bundleId: "checkout-next", shouldRollback: true)
        #expect(coordinator.takeDeferredLoadFailure(for: .stack, owner: "checkout") == nil)

        // The widget's fatal, unattributed, takes it and charges only the widget.
        let deferred = try #require(coordinator.takeDeferredLoadFailure(for: .none))
        #expect(deferred.possibleOwners.keys.sorted() == [Self.widget])
        let claim = coordinator.chargeUnclaimedLoadFailure(deferred)
        #expect(!FileManager.default.fileExists(atPath: checkoutMarker.path))
        #expect(HotUpdaterCrashMarker.consume(at: scene.markerURL(Self.widget))?.shouldRollback == true)
        coordinator.clearAttribution(claim: claim)
    }

    /// An unclaimed load failure's fatal is forwarded while the widget,
    /// whose runtime is known, is armed: a native crash or exception it
    /// causes writes only the possible owners' markers, never the widget's.
    @Test
    func anUnclaimedLoadFailureChargesOnlyItsPossibleOwnersWhileForwarded() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let checkoutMarker = scene.documents.appendingPathComponent("checkout-marker.json")
        coordinator.register(name: "checkout", markerURL: checkoutMarker, storage: NoStorage())
        coordinator.startMonitoring(name: "checkout", bundleId: "checkout-next", shouldRollback: true)
        _ = coordinator.contentAppeared(owner: nil)
        coordinator.runtimeResolved(name: Self.widget)
        #expect(coordinator.arm(name: Self.widget))
        let widgetSlot = try #require(coordinator.launch(named: Self.widget)?.slot)

        let claim = coordinator.chargeUnclaimedLoadFailure()
        let checkoutSlot = try #require(coordinator.launch(named: "checkout")?.slot)
        #expect(markers(coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: false, checkoutSlot: true])
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        coordinator.chargeUncaughtException()
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))
        #expect(HotUpdaterCrashMarker.consume(at: checkoutMarker)?.shouldRollback == true)

        coordinator.clearAttribution(claim: claim)
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)
        #expect(coordinator.launch(named: Self.widget)?.isArmed == true)
        #expect(markers(coordinator)[widgetSlot] == true)
    }

    /// A deferred load failure whose fatal never comes (a development
    /// build shows the error instead) doesn't turn a later, unrelated fatal
    /// into a load failure.
    @Test
    func aDeferredLoadFailureExpires() throws {
        // After the bound.
        do {
            let scene = try Scene()
            defer { scene.cleanUp() }
            var clock: TimeInterval = 0
            let process = scene.launch(now: { clock })
            #expect(process.coordinator.deferUnclaimedLoadFailure())
            clock += HotUpdaterRecoveryCoordinator.loadFailureClaimBound - 1
            #expect(process.coordinator.takeDeferredLoadFailure())
            #expect(process.coordinator.deferUnclaimedLoadFailure())
            clock += HotUpdaterRecoveryCoordinator.loadFailureClaimBound
            #expect(!process.coordinator.takeDeferredLoadFailure())
        }
        // Once the launch it was deferred for is known not to have failed.
        for settle in [
            { (coordinator: HotUpdaterRecoveryCoordinator) in coordinator.runtimeResolved(name: Self.widget) },
            { (coordinator: HotUpdaterRecoveryCoordinator) in _ = coordinator.contentAppeared(owner: Self.widget) },
            { (coordinator: HotUpdaterRecoveryCoordinator) in
                coordinator.startMonitoring(name: Self.widget, bundleId: "widget-next", shouldRollback: true)
            },
        ] {
            let scene = try Scene()
            defer { scene.cleanUp() }
            let process = scene.launch()
            // Main has shown content: only the widget could have failed.
            _ = process.coordinator.contentAppeared(owner: nil)
            #expect(process.coordinator.deferUnclaimedLoadFailure())
            settle(process.coordinator)
            #expect(!process.coordinator.takeDeferredLoadFailure())
        }
    }

    /// Deferred for main and the widget, whose runtime then resolves: main
    /// may still be the one that failed, so the record stays, and its fatal
    /// charges main alone.
    @Test
    func aDeferredLoadFailureBecomesMainsWhenTheNamedRuntimesSettle() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        #expect(coordinator.arm(name: Self.widget))
        #expect(coordinator.deferUnclaimedLoadFailure())
        coordinator.runtimeResolved(name: Self.widget)

        let deferred = try #require(coordinator.takeDeferredLoadFailure(for: .none))
        let claim = coordinator.chargeUnclaimedLoadFailure(deferred)
        #expect(HotUpdaterCrashMarker.consume(at: scene.markerURL(Self.main))?.shouldRollback == true)
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))
        // The widget's armed launch is held while the fatal is forwarded.
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        coordinator.clearAttribution(claim: claim)
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)
    }

    @Test
    func aLoadFailureIsMainsOnceEveryNamedRuntimeIsKnown() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        process.coordinator.runtimeResolved(name: Self.widget)
        #expect(!process.coordinator.deferUnclaimedLoadFailure())
        // A named launch that showed content is known too.
        let other = try Scene()
        defer { other.cleanUp() }
        let second = other.launch()
        _ = second.coordinator.contentAppeared(owner: Self.widget)
        #expect(!second.coordinator.deferUnclaimedLoadFailure())
    }

    /// A runtime of an earlier launch of the widget, still being torn down
    /// after a later launch started, reports an error: it is no current
    /// launch's, and none is charged.
    @Test
    func anErrorOfAnEarlierRuntimeChargesNoCurrentLaunch() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        process.storages[Self.main]?.markLaunchStarted(bundleId: "main-next")
        #expect(coordinator.arm(name: Self.widget))
        let current = try #require(scene.launchURL(Self.widget, bundleId: "widget-next"))
        let earlier = try #require(scene.launchURL(Self.widget, bundleId: "widget-stable"))

        #expect(coordinator.isCurrentRuntime(name: Self.widget, runtimeBundleURL: current))
        // Compared as the router does: the same file through /private.
        #expect(coordinator.isCurrentRuntime(
            name: Self.widget,
            runtimeBundleURL: URL(fileURLWithPath: current.resolvingSymlinksInPath().path)
        ))
        #expect(!coordinator.isCurrentRuntime(name: Self.widget, runtimeBundleURL: earlier))
        #expect(coordinator.isCurrentRuntime(name: Self.widget, runtimeBundleURL: nil))
        #expect(coordinator.isCurrentRuntime(name: Self.main, runtimeBundleURL: earlier))

        let claim = try #require(coordinator.chargeFatal(owner: Self.widget, runtimeBundleURL: earlier))
        #expect(coordinator.earlierRuntimeClaim == claim)
        #expect(coordinator.attributedOwner == nil)
        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.attributedWithoutSlot)
        #expect(markers(coordinator).isEmpty)
        // The exception the forwarded fatal raises charges nobody either.
        coordinator.chargeUncaughtException()
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.main).path))
        // Neither started launch is left for the unfinished-launch rule.
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        #expect(scene.metadata(Self.main)?.launchInProgress == false)

        let next = scene.nextLaunch()
        #expect(next[Self.widget]?.launchedBundleId == "widget-next")
        #expect(next[Self.main]?.launchedBundleId == "main-next")
        #expect(scene.crashHistory(Self.widget).bundles.isEmpty)
        #expect(scene.crashHistory(Self.widget).interruptedLaunch == nil)

        // If the process lives on, both start again.
        coordinator.clearAttribution(claim: claim)
        #expect(coordinator.earlierRuntimeClaim == nil)
        #expect(coordinator.launch(named: Self.widget)?.isArmed == true)
    }

    /// A module of an earlier runtime of the widget resolves late: the
    /// current launch's runtime is still unknown, so content nothing claims
    /// is still held for it and an unclaimed load failure still deferred.
    @Test
    func aModuleOfAnEarlierRuntimeDoesNotResolveTheCurrentLaunch() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let current = try #require(scene.launchURL(Self.widget, bundleId: "widget-next"))
        let earlier = try #require(scene.launchURL(Self.widget, bundleId: "widget-stable"))

        coordinator.runtimeResolved(name: Self.widget, runtimeBundleURL: earlier)
        #expect(coordinator.holdUnclaimedContent(NSObject()))
        #expect(coordinator.deferUnclaimedLoadFailure())
        _ = coordinator.takeDeferredLoadFailure()

        coordinator.runtimeResolved(name: Self.widget, runtimeBundleURL: current)
        #expect(!coordinator.holdUnclaimedContent(NSObject()))
        #expect(!coordinator.deferUnclaimedLoadFailure())
    }

    /// Main's foreground mark goes through crash recovery once its launch is
    /// registered: a named fatal's claim holds it, and its release starts it.
    @Test
    func mainsForegroundMarkWaitsForAnotherInstancesClaim() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let generation = try #require(coordinator.generations()[Self.main])

        let claim = try #require(coordinator.chargeFatal(owner: Self.widget))
        // The foreground mark queued before the widget's fatal runs now.
        #expect(!coordinator.markMainLaunchStarted(generation: generation))
        #expect(scene.metadata(Self.main)?.launchInProgress == false)
        // The process ends: main's healthy launch is selected again.
        #expect(scene.nextLaunch()[Self.main]?.launchedBundleId == "main-next")
        #expect(scene.crashHistory(Self.main).interruptedLaunch == nil)

        // In a process that lives on, it starts when the claim is released.
        coordinator.clearAttribution(claim: claim)
        #expect(scene.metadata(Self.main)?.launchInProgress == true)
    }

    @Test
    func mainsForegroundMarkStartsOnlyItsOwnUnverifiedLaunch() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let first = try #require(coordinator.generations()[Self.main])

        // As before in an app with only main: marked once it is in the foreground.
        #expect(coordinator.markMainLaunchStarted(generation: first))
        #expect(scene.metadata(Self.main)?.launchInProgress == true)
        #expect(!coordinator.markMainLaunchStarted(generation: first))

        // A mark of an earlier launch, or after first content, does nothing.
        let second = coordinator.startMonitoring(name: Self.main, bundleId: "main-next", shouldRollback: true)
        process.storages[Self.main]?.clearLaunchStarted(bundleId: "main-next")
        #expect(!coordinator.markMainLaunchStarted(generation: first))
        _ = coordinator.contentAppeared(owner: nil)
        #expect(!coordinator.markMainLaunchStarted(generation: second))
    }

    /// A view of the widget shown while main's fatal is on its way starts
    /// its launch only once that claim is released.
    @Test
    func aViewShownDuringAnotherInstancesClaimStartsItsLaunchOnRelease() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let claim = try #require(coordinator.chargeFatal(owner: Self.main))
        #expect(!coordinator.arm(name: Self.widget))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        coordinator.clearAttribution(claim: claim)
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)
        let widgetSlot = try #require(coordinator.launch(named: Self.widget)?.slot)
        #expect(markers(coordinator)[widgetSlot] == true)
    }

    /// A named launch that begins after main's fatal claimed the crash, but
    /// before the process ends, starts disarmed and joins what the claim
    /// stopped.
    @Test
    func aLaunchThatBeginsDuringAnotherInstancesClaimStartsOnlyOnRelease() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let claim = try #require(coordinator.chargeFatal(owner: Self.main))

        let generation = coordinator.startMonitoring(
            name: Self.widget,
            bundleId: "widget-next",
            shouldRollback: true,
            launchURL: scene.launchURL(Self.widget, bundleId: "widget-next")
        )
        #expect(!coordinator.arm(name: Self.widget, generation: generation))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        #expect(markers(coordinator) == [HotUpdaterRecoveryCoordinator.mainSlot: true])
        #expect(scene.nextLaunch()[Self.widget]?.launchedBundleId == "widget-next")

        coordinator.clearAttribution(claim: claim)
        #expect(scene.metadata(Self.widget)?.launchInProgress == true)
        #expect(coordinator.launch(named: Self.widget)?.isArmed == true)
    }

    /// The widget's fatal claimed the crash, and its host starts a new
    /// launch before the process ends: that launch is not the claim's, so it
    /// is held like any other and never stands in for the crashed one.
    @Test
    func aLaterLaunchOfTheClaimedInstanceIsHeldUntilRelease() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        #expect(coordinator.arm(name: Self.widget))
        let widgetSlot = try #require(coordinator.launch(named: Self.widget)?.slot)
        let claim = try #require(coordinator.chargeFatal(owner: Self.widget))
        #expect(process.sink.attribution == widgetSlot)
        try FileManager.default.removeItem(at: scene.markerURL(Self.widget))

        let replacement = coordinator.startMonitoring(
            name: Self.widget,
            bundleId: "widget-next",
            shouldRollback: true,
            launchURL: scene.launchURL(Self.widget, bundleId: "widget-next")
        )
        // The native crash the claimed fatal causes writes no slot now.
        #expect(process.sink.attribution == HotUpdaterRecoveryCoordinator.attributedWithoutSlot)
        #expect(!coordinator.arm(name: Self.widget, generation: replacement))
        #expect(coordinator.launch(named: Self.widget)?.isArmed == false)
        // Its exception, or the fatal going on, doesn't charge the new launch.
        coordinator.chargeUncaughtException()
        coordinator.chargeFatal(owner: Self.widget)
        #expect(!FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))

        coordinator.clearAttribution(claim: claim)
        #expect(coordinator.earlierRuntimeClaim != nil)
        coordinator.clearAttribution(claim: try #require(coordinator.earlierRuntimeClaim))
        #expect(coordinator.launch(named: Self.widget)?.isArmed == true)
    }

    /// While the widget's host is torn down and recreated, a surface of the
    /// earlier runtime starts or shows content after the replacement launch
    /// began: it neither starts nor verifies the replacement, nor main.
    @Test
    func viewsOfAnEarlierRuntimeNeitherStartNorVerifyTheCurrentLaunch() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        var clock: TimeInterval = 0
        let process = scene.launch(now: { clock })
        let coordinator = process.coordinator
        let current = try #require(scene.launchURL(Self.widget, bundleId: "widget-next"))
        let earlier = try #require(scene.launchURL(Self.widget, bundleId: "widget-stable"))
        let generation = try #require(coordinator.generations()[Self.widget])

        #expect(!coordinator.arm(name: Self.widget, generation: generation, runtimeBundleURL: earlier))
        #expect(scene.metadata(Self.widget)?.launchInProgress == false)
        #expect(coordinator.contentAppeared(owner: Self.widget, runtimeBundleURL: earlier) == nil)
        #expect(scene.metadata(Self.widget)?.verificationPending == true)
        #expect(scene.metadata(Self.main)?.verificationPending == true)

        // Held content that turns out to be the earlier runtime's is dropped.
        let earlierView = NSObject()
        #expect(coordinator.holdUnclaimedContent(earlierView))
        coordinator.runtimeResolved(name: Self.widget, runtimeBundleURL: current)
        clock += HotUpdaterRecoveryCoordinator.heldContentBound
        #expect(coordinator.releaseHeldContent(
            owner: { $0 === earlierView ? Self.widget : nil },
            runtimeBundleURL: { _ in earlier }
        ).isEmpty)
        #expect(scene.metadata(Self.widget)?.verificationPending == true)

        // The current runtime's views do.
        #expect(coordinator.arm(name: Self.widget, generation: generation, runtimeBundleURL: current))
        #expect(coordinator.contentAppeared(owner: Self.widget, runtimeBundleURL: current) != nil)
        #expect(scene.metadata(Self.widget)?.verificationPending == false)
    }

    /// Once the widget's launch is no longer watched, its runtime's later
    /// content, or an earlier runtime's, is still the widget's: it never
    /// verifies main.
    @Test
    func contentOfANamedRuntimeNeverVerifiesMainAfterItsMonitoringEnded() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        let verified = try #require(coordinator.contentAppeared(owner: Self.widget))
        coordinator.finishMonitoring(name: Self.widget, generation: verified.generation)

        #expect(coordinator.contentAppeared(owner: Self.widget) == nil)
        let earlier = try #require(scene.launchURL(Self.widget, bundleId: "widget-stable"))
        #expect(coordinator.contentAppeared(owner: Self.widget, runtimeBundleURL: earlier) == nil)
        #expect(scene.metadata(Self.main)?.verificationPending == true)
        // Unclaimed content, with every named runtime known, is main's.
        #expect(!coordinator.holdUnclaimedContent(NSObject()))
        #expect(coordinator.contentAppeared(owner: nil)?.launch.name == Self.main)
    }

    /// The widget's fatal returns (a development build) and its host starts
    /// it again in the same process: its launch is prepared anew, consumes
    /// its marker, and rolls back.
    @Test
    func aNamedFatalTheProcessSurvivesRollsBackItsNextLaunchInProcess() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        var invalidated: [String] = []
        coordinator.onRollbackCharged = { invalidated.append($0) }

        let claim = try #require(coordinator.chargeFatal(owner: Self.widget))
        #expect(invalidated == [Self.widget])
        coordinator.clearAttribution(claim: claim)

        // The same storage the widget's impl keeps prepares its next launch.
        let widget = try #require(process.storages[Self.widget])
        let relaunch = widget.prepareLaunch(
            bundle: namedTestBundle,
            pendingRecovery: HotUpdaterCrashMarker.consume(at: scene.markerURL(Self.widget))
        )
        #expect(relaunch.launchedBundleId == "widget-stable")
        #expect(widget.getCrashHistory().contains("widget-next"))
    }

    /// Main recovers in-process from a fatal no runtime claims, and the
    /// charge leaves the unverified widget a marker: the widget's next
    /// launch in this process is prepared anew too, and every other path
    /// that marks a named launch reports it the same way.
    @Test
    func everyNamedRollbackMarkerPreparesItsLaunchAgain() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        var invalidated: [String] = []
        coordinator.onRollbackCharged = { invalidated.append($0) }
        #expect(coordinator.arm(name: Self.widget))

        coordinator.chargeUnverifiedNamedLaunches()
        #expect(invalidated == [Self.widget])
        let widget = try #require(process.storages[Self.widget])
        #expect(widget.prepareLaunch(
            bundle: namedTestBundle,
            pendingRecovery: HotUpdaterCrashMarker.consume(at: scene.markerURL(Self.widget))
        ).launchedBundleId == "widget-stable")

        // The other charges: an unattributed fatal, an uncaught exception, an
        // unclaimed load failure.
        for charge in [
            { coordinator.chargeFatal(owner: nil) as Int? },
            { coordinator.chargeUncaughtException(); return nil },
            { coordinator.chargeUnclaimedLoadFailure(); return nil },
        ] as [() -> Int?] {
            invalidated = []
            coordinator.startMonitoring(name: Self.widget, bundleId: "widget-next", shouldRollback: true)
            #expect(coordinator.arm(name: Self.widget))
            _ = charge()
            // Main's pending launch is charged too, beside a named instance.
            #expect(Set(invalidated) == [Self.main, Self.widget])
        }
    }

    /// A rollback marked while a launch is being prepared, or after, makes
    /// the prepared selection stale, whatever the order.
    @Test
    func aRollbackMarkedDuringOrAfterPreparationPreparesTheLaunchAgain() {
        let epoch = HotUpdaterLaunchEpoch()
        // Prepared, then a rollback is marked.
        let prepared = epoch.current
        #expect(epoch.isCurrent(prepared))
        epoch.invalidate()
        #expect(!epoch.isCurrent(prepared))
        // A preparation that started before the rollback and publishes after.
        let started = epoch.current
        epoch.invalidate()
        let published = started
        #expect(!epoch.isCurrent(published))
        // Prepared again after it: current.
        let again = epoch.current
        #expect(epoch.isCurrent(again))
    }

    @Test
    func onlyANamedLaunchThatWouldRollBackIsPreparedAgain() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let coordinator = process.coordinator
        var invalidated: [String] = []
        coordinator.onRollbackCharged = { invalidated.append($0) }

        // An earlier runtime's error charges no launch.
        coordinator.chargeFatal(
            owner: Self.widget,
            runtimeBundleURL: scene.launchURL(Self.widget, bundleId: "widget-stable")
        )
        // A verified launch has nothing to roll back.
        _ = coordinator.contentAppeared(owner: Self.widget)
        coordinator.chargeFatal(owner: Self.widget)
        #expect(invalidated.isEmpty)
    }

    /// A native crash while the owner's marker file is written must charge
    /// the owner alone: by the time the file is written, its slot asks for
    /// rollback and the crash is already published as its, so no other
    /// armed slot writes.
    @Test
    func anAttributedFatalPublishesItsSlotAndAttributionBeforeItsMarker() throws {
        for armed in [false, true] {
            let scene = try Scene()
            defer { scene.cleanUp() }
            let process = scene.launch()
            let coordinator = process.coordinator
            if armed {
                #expect(coordinator.arm(name: Self.widget))
            }
            var markerAtAttribution: Bool?
            var slotAtAttribution: Bool?
            process.sink.onAttribute = { slot in
                markerAtAttribution = FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path)
                slotAtAttribution = slot >= 0 ? process.sink.flags[slot] : nil
            }
            coordinator.chargeFatal(owner: Self.widget)
            // Armed or not, its slot asks for rollback when the attribution
            // is published, and the marker file comes after.
            #expect(slotAtAttribution == true)
            #expect(markerAtAttribution == false)
            #expect(HotUpdaterCrashMarker.consume(at: scene.markerURL(Self.widget))?.shouldRollback == true)
        }
    }

    /// A signal while the marker file of a charged launch is written must
    /// still leave a marker: its native slot asks for rollback first, even
    /// for a named launch no view of which showed.
    @Test
    func aChargedLaunchsSlotAsksForRollbackBeforeItsMarkerIsWritten() throws {
        let charges: [(String, (HotUpdaterRecoveryCoordinator) -> Void)] = [
            ("attributed fatal", { _ = $0.chargeFatal(owner: Self.widget) }),
            ("unclaimed load failure", { $0.chargeUnclaimedLoadFailure() }),
        ]
        for (_, charge) in charges {
            let scene = try Scene()
            defer { scene.cleanUp() }
            let process = scene.launch()
            #expect(process.coordinator.launch(named: Self.widget)?.slot == nil)
            var markerWhenSlotAsked: Bool?
            process.sink.onUpdate = { slot, shouldRollback in
                guard shouldRollback, slot != HotUpdaterRecoveryCoordinator.mainSlot, markerWhenSlotAsked == nil else { return }
                markerWhenSlotAsked = FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path)
            }
            charge(process.coordinator)
            #expect(markerWhenSlotAsked == false)
            let widgetSlot = try #require(process.coordinator.launch(named: Self.widget)?.slot)
            #expect(process.sink.flags[widgetSlot] == true)
            #expect(process.sink.paths[widgetSlot] == scene.markerURL(Self.widget).path)
            #expect(FileManager.default.fileExists(atPath: scene.markerURL(Self.widget).path))
        }
    }

    @Test
    func anErrorOfTheCurrentRuntimeStillChargesItsLaunch() throws {
        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        let current = try #require(scene.launchURL(Self.widget, bundleId: "widget-next"))
        process.coordinator.chargeFatal(owner: Self.widget, runtimeBundleURL: current)
        #expect(scene.nextLaunch()[Self.widget]?.launchedBundleId == "widget-stable")
    }

    /// Main's in-process reload without main's own bridge falls back to
    /// reloading whatever bridge is known only when there is no named one.
    /// Beside a named instance, main never reloads in-process (React
    /// Native would reload every host): its fatal is charged to main, whose
    /// next same-process launch is prepared again to roll back.
    @Test
    func mainRecoversInProcessOnlyWithoutNamedInstances() throws {
        let mainOnly = HotUpdaterRecoveryCoordinator(sink: RecordingSlotSink())
        var mainOnlyInvalidated: [String] = []
        mainOnly.onRollbackCharged = { mainOnlyInvalidated.append($0) }
        mainOnly.register(name: Self.main, markerURL: URL(fileURLWithPath: "/tmp/only-main.json"), storage: NoStorage())
        let generation = mainOnly.startMonitoring(name: Self.main, bundleId: "m", shouldRollback: true)
        #expect(mainOnly.requestRecovery(name: Self.main) == .requested(generation: generation, bundleId: "m"))
        // As before: its in-process reload prepares the launch again itself.
        #expect(mainOnlyInvalidated.isEmpty)

        let scene = try Scene()
        defer { scene.cleanUp() }
        let process = scene.launch()
        var invalidated: [String] = []
        process.coordinator.onRollbackCharged = { invalidated.append($0) }
        #expect(process.coordinator.requestRecovery(name: Self.main) == .notNeeded)
        process.coordinator.chargeFatal(owner: Self.main)
        #expect(invalidated == [Self.main])
        let main = try #require(process.storages[Self.main])
        #expect(main.prepareLaunch(
            bundle: .main,
            pendingRecovery: HotUpdaterCrashMarker.consume(at: scene.markerURL(Self.main))
        ).launchedBundleId == "main-stable")
    }

    @Test
    func aNamedInstanceIsKnownOnceCreated() {
        let coordinator = HotUpdaterRecoveryCoordinator(sink: RecordingSlotSink())
        coordinator.register(name: Self.main, markerURL: URL(fileURLWithPath: "/tmp/m.json"), storage: NoStorage())
        #expect(!coordinator.hasNamedInstance)
        coordinator.register(name: Self.widget, markerURL: URL(fileURLWithPath: "/tmp/w.json"), storage: NoStorage())
        #expect(coordinator.hasNamedInstance)
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

    /// The bundle file `name` launches for `bundleId`.
    func launchURL(_ name: String, bundleId: String) -> URL? {
        storeURL(environments[name]!)
            .appendingPathComponent(bundleId, isDirectory: true)
            .appendingPathComponent("index.ios.bundle")
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
                shouldRollback: selection.shouldRollbackOnCrash,
                launchURL: selection.bundleURL
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

    /// Called as a slot is updated, before it takes effect.
    var onUpdate: ((Int, Bool) -> Void)?

    func updateSlot(_ slot: Int, markerPath: String, bundleId: String?, shouldRollback: Bool) {
        onUpdate?(slot, shouldRollback)
        paths[slot] = markerPath
        bundleIds[slot] = bundleId
        flags[slot] = shouldRollback
    }

    /// Called as an attribution is published, before it takes effect.
    var onAttribute: ((Int) -> Void)?

    func attributeCrash(toSlot slot: Int) {
        onAttribute?(slot)
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
