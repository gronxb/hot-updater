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

    private static let host = HotUpdaterSandboxLiveHost()
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

    private static func present(in scene: UIWindowScene?) {
        Task { await coordinator.refresh() }
        guard window == nil else { return }
        let shown = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
        shown.windowLevel = .normal + 1
        shown.rootViewController = HotUpdaterSandboxScreen(
            coordinator: coordinator,
            isOverApp: { isReleased?() == true },
            onClose: { hideScreen() }
        )
        window = shown
        shown.makeKeyAndVisible()
        NSLog("[HotUpdaterSandbox] screen shown overApp=%d", isReleased?() == true)
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
                let scene = UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .first { $0.activationState == .foregroundActive }
                present(in: scene)
                return
            }
            isWatchingForServerAnswer = false
        }
    }
}
