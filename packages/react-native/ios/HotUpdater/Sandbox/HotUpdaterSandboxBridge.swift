#if HOT_UPDATER_SANDBOX_LAYER
import UIKit

/// The gate's way into the sandbox's Swift side: the process's one coordinator,
/// and the window its screen shows in, over whatever the app has.
@objc(HotUpdaterSandboxBridge)
@MainActor
public final class HotUpdaterSandboxBridge: NSObject {
    private static var release: (() -> Void)?
    private static var startUnderScreen: (() -> Bool)?
    private static var reload: (() -> Bool)?
    private static var isReleased: (() -> Bool)?
    /// The screen started the app under itself, and nobody has seen it yet: the screen
    /// stays the first screen until it goes.
    private static var startedHidden = false
    /// What the screen says and offers: over an app a person has seen.
    private static var isOverShownApp: Bool { isReleased?() == true && !startedHidden }
    /// The screen's window, and its subscription to the coordinator.
    private static let slot = HotUpdaterSandboxScreenSlot<UIWindow>(coordinator: coordinator)
    private static var window: UIWindow? { slot.screen }
    private static var isWatchingScenes = false
    private static let devServer = HotUpdaterSandboxLiveDevServer(
        start: { launchWasPrepared in startDevSession(launchWasPrepared: launchWasPrepared) },
        reload: { NSLog("[HotUpdaterSandbox] reload triggered=%d", reload?() == true) }
    )

    private static let host: HotUpdaterSandboxLiveHost = {
        let host = HotUpdaterSandboxLiveHost(isAppRunning: { isReleased?() == true })
        host.exitSessionAction = { devServer.exitDevServer() }
        host.startStoredAction = { devServer.startStored($0) }
        host.isAppHiddenAction = { startedHidden && isReleased?() == true }
        host.canStartUnderScreenAction = { window != nil && startUnderScreen != nil && isReleased?() != true }
        host.startUnderScreenAction = {
            guard window != nil, let startUnderScreen else { return }
            startedHidden = true
            if !startUnderScreen() { startedHidden = false }
        }
        return host
    }()
    private static let coordinator = HotUpdaterSandboxCoordinator(
        host: host,
        store: HotUpdaterSandboxDefaults(),
        shelf: HotUpdaterSandboxLiveHost.shelf,
        openApp: { switched, fixed in open(switched: switched, fixed: fixed) },
        log: { NSLog("[HotUpdaterSandbox] %@", $0) },
        onServerAnswer: { askOverApp() }
    )

    /// What only the gate can do: start the held React Native, ask the SDK for a reload.
    @objc public static func configure(
        release: @escaping () -> Void,
        startUnderScreen: @escaping () -> Bool,
        reload: @escaping () -> Bool,
        isReleased: @escaping () -> Bool
    ) {
        Self.release = release
        Self.startUnderScreen = startUnderScreen
        Self.reload = reload
        Self.isReleased = isReleased
    }

    /// Before anything settles what the last process left.
    @objc public static func dropCrashOfLastDevProcess() {
        HotUpdaterSandboxDevLeftover.dropCrashOfLastProcess()
    }

    /// Reads what the last launch left, before anything settles it.
    @objc public static func captureLaunchEvidence() {
        HotUpdaterSandboxLiveHost.captureCrashMarker()
    }

    /// A launch that skipped the screen settled what the last one left, so that
    /// stays for the next screen. React Native's recovery can also roll back
    /// inside a running process, so this reads each time the app shows content.
    @objc public static func appShowedContent() {
        guard isReleased?() == true else { return }
        Task { await coordinator.noteLastLaunch() }
    }

    /// A shake opens the screen over the running app. The first screen is up by
    /// itself until then.
    @objc public static func shake(in scene: UIWindowScene?) {
        guard isReleased?() == true else { return }
        NSLog("[HotUpdaterSandbox] shake")
        present(in: scene)
    }

    /// The first screen, before the app's JavaScript starts.
    @objc public static func presentScreen(in scene: UIWindowScene?) {
        present(in: scene)
    }

    /// A sandbox link from anywhere. Over a running app, the screen comes up for it.
    @objc public static func receiveLink(_ url: URL, scene: UIWindowScene?) {
        coordinator.receiveLink(url.absoluteString)
        if isReleased?() == true {
            present(in: scene)
        }
    }

    /// The screen's window goes, when the app starts by another route.
    @objc public static func hideScreen() {
        startedHidden = false
        slot.hide()?.isHidden = true
    }

    /// Something for the app arrived after the screen started it hidden: the app shows.
    @objc public static func revealIfHidden() {
        guard startedHidden else { return }
        NSLog("[HotUpdaterSandbox] revealing the app started under the screen")
        hideScreen()
    }

    /// Text entry and alerts stay in the screen when the app makes its own window key after it.
    @objc(keepKeyWindow:) public static func keepKey(window other: UIWindow) {
        if let window, other !== window {
            window.makeKey()
        }
    }

    /// The scene to show in: a window with no scene never shows on a scene host, and
    /// a scene can be between states as the app comes up.
    private static func screenScene(_ scene: UIWindowScene?) -> UIWindowScene? {
        if let scene { return scene }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive }
            ?? scenes.first { $0.activationState == .foregroundInactive }
            ?? scenes.first
    }

    private static func present(in scene: UIWindowScene?) {
        Task { await coordinator.refresh() }
        guard window == nil else { return }
        watchScenes()
        let shown = screenScene(scene).map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
        shown.windowLevel = .normal + 1
        let screen = HotUpdaterSandboxScreen(
            coordinator: coordinator,
            devServer: devServer,
            isOverApp: { isOverShownApp },
            onClose: {
                coordinator.acknowledgeLastLaunch()
                hideScreen()
            }
        )
        shown.rootViewController = screen
        screen.loadViewIfNeeded()
        slot.show(shown) { window, state in
            (window.rootViewController as? HotUpdaterSandboxScreen)?.render(state)
        }
        shown.makeKeyAndVisible()
        NSLog("[HotUpdaterSandbox] screen shown overApp=%d inScene=%d", isReleased?() == true, shown.windowScene != nil)
    }

    /// A session starts where the first screen would: over a running app it reloads
    /// in place, and a URL a host already holds is replaced the same way.
    private static func startDevSession(launchWasPrepared: Bool) {
        if isReleased?() == true {
            NSLog("[HotUpdaterSandbox] dev reload triggered=%d", reload?() == true)
            hideScreen()
            return
        }
        if launchWasPrepared {
            NSLog("[HotUpdaterSandbox] launch already fixed, dev reload triggered=%d", reload?() == true)
        }
        release?()
    }

    private static func open(switched: Bool, fixed: Bool) {
        if isReleased?() == true {
            if switched || fixed {
                NSLog("[HotUpdaterSandbox] reload triggered=%d", reload?() == true)
            }
            hideScreen()
            return
        }
        // Before React Native starts, the host's next bundleURL() reads the switch,
        // unless something already fixed this launch: a bundleURL prefetch or a
        // host that started React Native early. The reload lets go of it.
        if fixed {
            NSLog("[HotUpdaterSandbox] launch already fixed, reload triggered=%d", reload?() == true)
        }
        release?()
    }

    /// A scene that goes takes the screen's window with it: the next screen opens a new one.
    private static func watchScenes() {
        guard !isWatchingScenes else { return }
        isWatchingScenes = true
        NotificationCenter.default.addObserver(
            forName: UIScene.didDisconnectNotification,
            object: nil,
            queue: .main
        ) { note in
            MainActor.assumeIsolated {
                guard let scene = note.object as? UIWindowScene, scene === window?.windowScene else { return }
                hideScreen()
            }
        }
    }

    /// A link that waited for the app's first answered check asks now, over the
    /// app when no screen is up. After this process, the stored link waits for
    /// the next launch.
    private static func askOverApp() {
        guard window == nil, case .confirming = coordinator.state.phase else { return }
        present(in: nil)
    }
}
#endif
