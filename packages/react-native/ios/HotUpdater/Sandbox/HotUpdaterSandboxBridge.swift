#if HOT_UPDATER_SANDBOX_LAYER
import UIKit

/// The gate's way into the sandbox's Swift side: the process's one coordinator,
/// and the window its screen shows in, over whatever the app has.
@objc(HotUpdaterSandboxBridge)
@MainActor
public final class HotUpdaterSandboxBridge: NSObject {
    /// How often, and for how long, a waiting link checks whether a server answered the app.
    private static let serverAnswerPollSeconds: UInt64 = 1
    private static let serverAnswerAttempts = 600

    private static var release: (() -> Void)?
    private static var reload: (() -> Bool)?
    private static var isReleased: (() -> Bool)?
    private static var window: UIWindow?
    private static var isWatchingForServerAnswer = false
    private static let devServer = HotUpdaterSandboxLiveDevServer(
        start: { launchWasPrepared in startDevSession(launchWasPrepared: launchWasPrepared) },
        reload: { NSLog("[HotUpdaterSandbox] reload triggered=%d", reload?() == true) }
    )

    private static let host: HotUpdaterSandboxLiveHost = {
        let host = HotUpdaterSandboxLiveHost(isAppRunning: { isReleased?() == true })
        host.exitDevServerAction = { devServer.exitDevServer() }
        return host
    }()
    private static let coordinator = HotUpdaterSandboxCoordinator(
        host: host,
        store: HotUpdaterSandboxDefaults(),
        openApp: { switched, fixed in open(switched: switched, fixed: fixed) },
        log: { NSLog("[HotUpdaterSandbox] %@", $0) }
    )

    /// What only the gate can do: start the held React Native, ask the SDK for a reload.
    @objc public static func configure(
        release: @escaping () -> Void,
        reload: @escaping () -> Bool,
        isReleased: @escaping () -> Bool
    ) {
        Self.release = release
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
        window?.isHidden = true
        window = nil
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
        let shown = screenScene(scene).map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
        shown.windowLevel = .normal + 1
        shown.rootViewController = HotUpdaterSandboxScreen(
            coordinator: coordinator,
            devServer: devServer,
            isOverApp: { isReleased?() == true },
            onClose: {
                coordinator.acknowledgeLastLaunch()
                hideScreen()
            }
        )
        window = shown
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
        watchForServerAnswer(attempts: serverAnswerAttempts)
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

    /// A link that waits for the app's first answered check is asked about as
    /// soon as a server answered, while this process lives. After that, the
    /// stored link waits for the next launch.
    private static func watchForServerAnswer(attempts: Int) {
        guard case .waitingForServer = coordinator.state.phase, !isWatchingForServerAnswer else { return }
        isWatchingForServerAnswer = true
        Task { @MainActor in
            for _ in 0 ..< attempts {
                try? await Task.sleep(nanoseconds: serverAnswerPollSeconds * 1_000_000_000)
                guard host.hasServerConfig() else { continue }
                isWatchingForServerAnswer = false
                present(in: nil)
                return
            }
            isWatchingForServerAnswer = false
        }
    }
}
#endif
