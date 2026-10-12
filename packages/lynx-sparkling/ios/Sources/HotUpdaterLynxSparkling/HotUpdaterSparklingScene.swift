import UIKit

/// Mount this container normally. Its own active scene admits foreground recovery.
/// Constructing it during a silent application launch does not open the OTA store.
public final class HotUpdaterSparklingScene: UIViewController {
    private let admission: SparklingForegroundAdmission<HotUpdaterSparklingHost>
    private let onError: (Error) -> Void
    private var observer: NSObjectProtocol?
    private var navigation: HotUpdaterSparklingViewController?
    private var creatingNavigation = false
    private var closed = false

    public init(
        configuration: HotUpdaterSparklingConfiguration,
        events: HotUpdaterSparklingEventHandler? = nil,
        launchConfiguration: [String: String] = [:],
        onError: @escaping (Error) -> Void = {
            NSLog("Managed Lynx scene failed: %@", $0.localizedDescription)
        }
    ) {
        precondition(Thread.isMainThread)
        self.onError = onError
        admission = SparklingForegroundAdmission(create: {
            try HotUpdaterSparklingHost(
                configuration: configuration,
                events: events,
                launchConfiguration: launchConfiguration
            )
        }, dispose: { $0.close() })
        super.init(nibName: nil, bundle: nil)
        observer = NotificationCenter.default.addObserver(
            forName: UIScene.didActivateNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let self, let scene = notification.object as? UIWindowScene,
                  scene === self.viewIfLoaded?.window?.windowScene else { return }
            self.activateIfForeground()
        }
    }

    public required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    public override func loadView() {
        view = SceneAttachmentView { [weak self] in self?.activateIfForeground() }
    }

    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        activateIfForeground()
    }

    private func activateIfForeground() {
        precondition(Thread.isMainThread)
        do {
            guard let host = try admission.activate(
                isForegroundActive: viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive
            ), navigation == nil, !creatingNavigation else { return }
            creatingNavigation = true
            defer { creatingNavigation = false }
            // Publish the host before navigation emits events. A callback may
            // close this scene, and must close the host before evaluation resumes.
            let child = try host.makeViewController()
            guard !admission.isClosed else { return }
            navigation = child
            addChild(child)
            guard !admission.isClosed else { return }
            child.view.frame = view.bounds
            child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(child.view)
            guard !admission.isClosed else { return }
            child.didMove(toParent: self)
        } catch {
            guard !closed else { return }
            close()
            onError(error)
        }
    }

    public func close() {
        precondition(Thread.isMainThread)
        guard !closed else { return }
        closed = true
        admission.close()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        let child = navigation
        navigation = nil
        child?.willMove(toParent: nil)
        child?.view.removeFromSuperview()
        child?.removeFromParent()
    }

    deinit { close() }
}

private final class SceneAttachmentView: UIView {
    private let attached: () -> Void

    init(attached: @escaping () -> Void) {
        self.attached = attached
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attached()
    }
}
