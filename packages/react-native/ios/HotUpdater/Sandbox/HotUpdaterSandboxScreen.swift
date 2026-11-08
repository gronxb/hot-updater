#if HOT_UPDATER_SANDBOX_LAYER
import SwiftUI
import UIKit

/// The app this screen stands in front of: its own name, version, and icon lead.
struct HotUpdaterSandboxApp {
    let name: String
    let version: String
    let icon: UIImage?

    static let current: HotUpdaterSandboxApp = {
        let info = Bundle.main.infoDictionary ?? [:]
        let name = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? "App"
        let version = "\(info["CFBundleShortVersionString"] as? String ?? "") (\(info["CFBundleVersion"] as? String ?? ""))"
        let icons = (info["CFBundleIcons"] as? [String: Any])?["CFBundlePrimaryIcon"] as? [String: Any]
        let icon = (icons?["CFBundleIconFiles"] as? [String])?.last.flatMap { UIImage(named: $0) }
            ?? UIImage(named: "AppIcon")
        return HotUpdaterSandboxApp(name: name, version: version, icon: icon)
    }()

    static var configuration: String {
        #if DEBUG
        return "Debug"
        #else
        return "Release"
        #endif
    }
}

/// What a phase asks, in the same words on every screen that asks it.
struct HotUpdaterSandboxQuestion: Equatable {
    enum Kind: Equatable {
        case confirm, refused, failed
    }

    let kind: Kind
    let title: String
    let message: String
    let accept: String
    let decline: String?

    /// `isOverApp`: whether a bundle runs behind the screen for a link to replace.
    init?(phase: HotUpdaterSandboxPhase, isOverApp: Bool) {
        switch phase {
        case .confirming(let link):
            kind = .confirm
            title = "Open \(link.channel)?"
            message = isOverApp
                ? "This replaces the running bundle and deletes downloaded bundles."
                : HotUpdaterSandboxHomeModel.switchNote
            accept = "Open"
            decline = "Cancel"
        case .refused(let refusal):
            kind = .refused
            switch refusal {
            case .unreadable:
                title = "This link can't be read"
                message = "It isn't a preview link for this app."
            case .invalidChannel(let channel):
                title = "That isn't a channel name"
                message = "Check \"\(channel)\" and try again."
            case .otherFingerprint(let link, _):
                title = "\(link.channel) needs another build"
                message = "Its native code differs from this build. Install the sandbox build for that fingerprint."
            }
            accept = "OK"
            decline = nil
        case .failed(_, let target, _, let failure, let selection):
            kind = .failed
            let reason: String
            switch failure {
            case .noBundle: reason = "\(target) has no bundle for this build."
            case .resetFailed: reason = "Downloaded bundles couldn't be removed."
            case .superseded: reason = "Another update check changed the selection first."
            case .error(let text): reason = text
            }
            let bundle = selection.isBuiltIn ? "built-in bundle" : "bundle \(selection.bundleId)"
            title = "Couldn't open \(target)"
            message = "\(reason)\n\nSelected now: \(selection.channel), \(bundle)."
            accept = "Retry"
            decline = "Close"
        default:
            return nil
        }
    }
}

/// The first screen, and the same screen over a running app. It renders
/// `HotUpdaterSandboxState` and calls the coordinator's actions. Reads only:
/// opening it sends the update server nothing.
@MainActor
final class HotUpdaterSandboxScreen: UIViewController {
    private let coordinator: HotUpdaterSandboxCoordinator
    private let devServer: HotUpdaterSandboxDevServer
    private let isOverApp: () -> Bool
    private let onClose: () -> Void
    private var stopObserving: (() -> Void)?

    init(
        coordinator: HotUpdaterSandboxCoordinator,
        devServer: HotUpdaterSandboxDevServer,
        isOverApp: @escaping () -> Bool,
        onClose: @escaping () -> Void
    ) {
        self.coordinator = coordinator
        self.devServer = devServer
        self.isOverApp = isOverApp
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let content: UIViewController
        let render: (HotUpdaterSandboxState) -> Void
        if #available(iOS 16.0, *) {
            let model = HotUpdaterSandboxScreenModel(
                coordinator: coordinator,
                devServer: devServer,
                isOverApp: isOverApp,
                onClose: onClose
            )
            devServer.onDevServerChange = { [weak model] in model?.devServerChanged() }
            content = UIHostingController(rootView: HotUpdaterSandboxRootView(model: model))
            render = { [weak model] in model?.receive($0) }
        } else {
            let fallback = HotUpdaterSandboxFallbackScreen(
                coordinator: coordinator,
                isOverApp: isOverApp,
                onClose: onClose
            )
            content = fallback
            render = { [weak fallback] in fallback?.render($0) }
        }
        addChild(content)
        content.view.frame = view.bounds
        content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(content.view)
        content.didMove(toParent: self)
        stopObserving = coordinator.observe(render)
    }
}

/// Before iOS 16: opens the app, takes a channel, and asks what a link asks.
private final class HotUpdaterSandboxFallbackScreen: UIViewController {
    private let coordinator: HotUpdaterSandboxCoordinator
    private let isOverApp: () -> Bool
    private let onClose: () -> Void
    private let open = UIButton(type: .system)
    private var shownQuestion: HotUpdaterSandboxQuestion?
    private var state: HotUpdaterSandboxState?

    init(coordinator: HotUpdaterSandboxCoordinator, isOverApp: @escaping () -> Bool, onClose: @escaping () -> Void) {
        self.coordinator = coordinator
        self.isOverApp = isOverApp
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        let name = UILabel()
        name.text = HotUpdaterSandboxApp.current.name
        name.font = .preferredFont(forTextStyle: .title2)
        name.adjustsFontForContentSizeCategory = true
        open.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        open.accessibilityIdentifier = "hot-updater-sandbox-open"
        open.addTarget(self, action: #selector(openTapped), for: .touchUpInside)
        let channel = UIButton(type: .system)
        channel.setTitle("Enter a channel", for: .normal)
        channel.titleLabel?.font = .preferredFont(forTextStyle: .body)
        channel.addTarget(self, action: #selector(channelTapped), for: .touchUpInside)
        let close = UIButton(type: .system)
        close.setTitle("Back to the app", for: .normal)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        close.isHidden = !isOverApp()
        let column = UIStackView(arrangedSubviews: [name, open, channel, close])
        column.axis = .vertical
        column.spacing = 20
        column.alignment = .center
        column.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(column)
        NSLayoutConstraint.activate([
            column.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            column.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let state { render(state) }
    }

    func render(_ next: HotUpdaterSandboxState) {
        state = next
        guard isViewLoaded else { return }
        let home = HotUpdaterSandboxHomeModel(state: next, isOverApp: isOverApp(), nowMs: Date().timeIntervalSince1970 * 1000)
        open.setTitle(home.bigRow.title, for: .normal)
        open.isEnabled = !home.isBusy
        ask(HotUpdaterSandboxQuestion(phase: next.phase, isOverApp: isOverApp()))
    }

    @objc private func openTapped() {
        guard let state else { return }
        if HotUpdaterSandboxHomeModel(state: state, isOverApp: isOverApp(), nowMs: 0).bigRow.isReload {
            coordinator.reloadApp()
        } else {
            Task { await coordinator.open() }
        }
    }

    @objc private func channelTapped() {
        let alert = UIAlertController(title: "Enter a channel", message: HotUpdaterSandboxHomeModel.switchNote, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "pr-123"
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open", style: .default) { [weak self, weak alert] _ in
            guard let text = alert?.textFields?.first?.text, !text.isEmpty else { return }
            self?.coordinator.switchTo(text)
        })
        present(alert, animated: true)
    }

    @objc private func closeTapped() {
        onClose()
    }

    private func ask(_ question: HotUpdaterSandboxQuestion?) {
        guard view.window != nil, question != shownQuestion else { return }
        shownQuestion = question
        if presentedViewController is UIAlertController { dismiss(animated: false) }
        guard let question else { return }
        let alert = UIAlertController(title: question.title, message: question.message, preferredStyle: .alert)
        if let decline = question.decline {
            alert.addAction(UIAlertAction(title: decline, style: .cancel) { [weak self] _ in self?.answer(question, accept: false) })
        }
        alert.addAction(UIAlertAction(title: question.accept, style: .default) { [weak self] _ in
            self?.answer(question, accept: question.decline != nil)
        })
        present(alert, animated: true)
    }

    private func answer(_ question: HotUpdaterSandboxQuestion, accept: Bool) {
        switch (question.kind, accept) {
        case (.confirm, true): coordinator.confirmLink()
        case (.failed, true): coordinator.retry()
        case (.failed, false): coordinator.dismiss()
        default:
            coordinator.dismiss { [weak self] in
                guard let self, self.isOverApp() else { return }
                self.onClose()
            }
        }
    }
}
#endif
