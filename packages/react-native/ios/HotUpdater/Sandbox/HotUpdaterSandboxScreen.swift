import UIKit

/// A plain placeholder until the sandbox's real screen: the current channel and
/// bundle, an Open button, and every question the coordinator asks. It only
/// renders `HotUpdaterSandboxState` and calls the coordinator's actions.
@MainActor
final class HotUpdaterSandboxScreen: UIViewController {
    private let coordinator: HotUpdaterSandboxCoordinator
    private let isOverApp: () -> Bool
    private let onClose: () -> Void
    private let channelLabel = UILabel()
    private let bundleLabel = UILabel()
    private let statusLabel = UILabel()
    private let openButton = UIButton(type: .system)
    private var stopObserving: (() -> Void)?
    private var shownPhase: HotUpdaterSandboxPhase?

    init(
        coordinator: HotUpdaterSandboxCoordinator,
        isOverApp: @escaping () -> Bool,
        onClose: @escaping () -> Void
    ) {
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
        view.backgroundColor = .systemBackground
        let name = UILabel()
        name.text = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
        name.font = .preferredFont(forTextStyle: .title1)
        let sandbox = UILabel()
        sandbox.text = "Sandbox"
        sandbox.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.textColor = .secondaryLabel
        bundleLabel.numberOfLines = 0
        bundleLabel.textAlignment = .center
        openButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        openButton.addTarget(self, action: #selector(openTapped), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [name, sandbox, channelLabel, bundleLabel, statusLabel, openButton])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
        stopObserving = coordinator.observe { [weak self] in self?.render($0) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        ask(coordinator.state.phase)
    }

    @objc private func openTapped() {
        Task { await coordinator.open() }
    }

    private func render(_ state: HotUpdaterSandboxState) {
        channelLabel.text = "Channel: \(state.selection?.channel ?? "")"
        if let selection = state.selection {
            bundleLabel.text = selection.isBuiltIn ? "Bundle: built-in" : "Bundle: \(selection.bundleId)"
        } else {
            bundleLabel.text = "Bundle:"
        }
        var working = false
        if case .working = state.phase { working = true }
        openButton.isEnabled = !working
        openButton.setTitle(isOverApp() ? "Back to the app" : "Open", for: .normal)
        statusLabel.text = statusOf(state)
        ask(state.phase)
    }

    private func statusOf(_ state: HotUpdaterSandboxState) -> String {
        switch state.phase {
        case .working(_, let target, let step, let progress):
            switch step {
            case .preflight, .check:
                return "Checking \(target)…"
            case .reset:
                return "Removing downloaded bundles…"
            case .download:
                return "Downloading \(target)… \(Int((progress ?? 0) * 100))%"
            }
        case .waitingForServer(let link):
            return "\(link.channel) needs an answer from your update server first. Open the app so it can check for updates."
        default:
            return state.hasServerConfig ? "" : "No update server yet. Open the app so it can check for updates."
        }
    }

    private func ask(_ phase: HotUpdaterSandboxPhase) {
        guard view.window != nil, phase != shownPhase else { return }
        shownPhase = phase
        // A question left over from the last phase goes first.
        if presentedViewController != nil {
            dismiss(animated: false)
        }
        let alert: UIAlertController
        switch phase {
        case .confirming(let link):
            alert = UIAlertController(
                title: "Open \(link.channel)?",
                message: "This replaces the running bundle and deletes downloaded bundles.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
                self?.dismissQuestion()
            })
            alert.addAction(UIAlertAction(title: "Open", style: .default) { [weak self] _ in
                self?.coordinator.confirmLink()
            })
        case .refused(let refusal):
            alert = UIAlertController(title: titleOf(refusal), message: messageOf(refusal), preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
                self?.dismissQuestion()
            })
        case .failed(_, let target, _, let failure, let selection):
            let bundle = selection.isBuiltIn ? "built-in bundle" : "bundle \(selection.bundleId)"
            alert = UIAlertController(
                title: "Couldn't open \(target)",
                message: "\(messageOf(failure, target: target))\n\nSelected now: \(selection.channel), \(bundle).",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Close", style: .cancel) { [weak self] _ in
                self?.coordinator.dismiss()
            })
            alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self] _ in
                self?.coordinator.retry()
            })
        default:
            return
        }
        present(alert, animated: false)
    }

    /// The screen closes itself over the app once nothing is left to answer.
    private func dismissQuestion() {
        coordinator.dismiss { [weak self] in
            guard let self, self.isOverApp() else { return }
            self.onClose()
        }
    }

    private func titleOf(_ refusal: HotUpdaterSandboxRefusal) -> String {
        switch refusal {
        case .unreadable:
            return "This link can't be read"
        case .invalidChannel:
            return "That isn't a channel name"
        case .otherFingerprint(let link, _):
            return "\(link.channel) needs another build"
        }
    }

    private func messageOf(_ refusal: HotUpdaterSandboxRefusal) -> String {
        switch refusal {
        case .unreadable:
            return "It isn't a preview link for this app."
        case .invalidChannel(let channel):
            return "Check \"\(channel)\" and try again."
        case .otherFingerprint:
            return "Its native code differs from this build. Install the sandbox build for that fingerprint."
        }
    }

    private func messageOf(_ failure: HotUpdaterSandboxFailure, target: String) -> String {
        switch failure {
        case .noBundle:
            return "\(target) has no bundle for this build."
        case .resetFailed:
            return "Downloaded bundles couldn't be removed."
        case .superseded:
            return "Another update check changed the selection first."
        case .error(let message):
            return message
        }
    }
}
