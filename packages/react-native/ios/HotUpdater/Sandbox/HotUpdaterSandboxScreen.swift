#if HOT_UPDATER_SANDBOX_LAYER
import UIKit

private let accent = UIColor(red: 0.976, green: 0.451, blue: 0.086, alpha: 1)
private let cardColor = UIColor.secondarySystemBackground
private let space: CGFloat = 16

private func appInfo() -> (name: String, version: String, icon: UIImage?) {
    let info = Bundle.main.infoDictionary ?? [:]
    let name = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? "App"
    let version = "\(info["CFBundleShortVersionString"] as? String ?? "") (\(info["CFBundleVersion"] as? String ?? ""))"
    let icons = (info["CFBundleIcons"] as? [String: Any])?["CFBundlePrimaryIcon"] as? [String: Any]
    let icon = (icons?["CFBundleIconFiles"] as? [String])?.last.flatMap { UIImage(named: $0) }
    return (name, version, icon)
}

// MARK: - Small view helpers

private func label(_ text: String, _ font: UIFont, _ color: UIColor = .label, lines: Int = 1) -> UILabel {
    let view = UILabel()
    view.text = text
    view.font = font
    view.textColor = color
    view.numberOfLines = lines
    return view
}

private func stack(
    _ axis: NSLayoutConstraint.Axis,
    _ spacing: CGFloat,
    _ views: [UIView],
    align: UIStackView.Alignment = .fill
) -> UIStackView {
    let view = UIStackView(arrangedSubviews: views)
    view.axis = axis
    view.spacing = spacing
    view.alignment = align
    return view
}

private final class Tappable: UIControl {
    var onTap: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }

    @objc private func tapped() {
        onTap?()
    }
}

private func pinned(_ child: UIView, in parent: UIView, _ inset: UIEdgeInsets) {
    child.translatesAutoresizingMaskIntoConstraints = false
    child.isUserInteractionEnabled = parent is Tappable ? false : child.isUserInteractionEnabled
    parent.addSubview(child)
    NSLayoutConstraint.activate([
        child.topAnchor.constraint(equalTo: parent.topAnchor, constant: inset.top),
        child.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -inset.bottom),
        child.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: inset.left),
        child.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -inset.right),
    ])
}

private func card(_ content: UIView, onTap: (() -> Void)? = nil) -> UIView {
    let view: UIView
    if let onTap {
        let tappable = Tappable()
        tappable.onTap = onTap
        view = tappable
    } else {
        view = UIView()
    }
    view.backgroundColor = cardColor
    view.layer.cornerRadius = 12
    pinned(content, in: view, UIEdgeInsets(top: 14, left: space, bottom: 14, right: space))
    return view
}

private func caption(_ text: String, action: (String, () -> Void)? = nil) -> UIView {
    var views: [UIView] = [label(text.uppercased(), .systemFont(ofSize: 12), .secondaryLabel), UIView()]
    if let action {
        let button = Tappable()
        button.onTap = action.1
        pinned(label(action.0.uppercased(), .systemFont(ofSize: 12), accent), in: button, .zero)
        views.append(button)
    }
    return stack(.horizontal, 8, views, align: .center)
}

private func dot(_ color: UIColor) -> UIView {
    let view = UIView()
    view.backgroundColor = color
    view.layer.cornerRadius = 6
    view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        view.widthAnchor.constraint(equalToConstant: 12),
        view.heightAnchor.constraint(equalToConstant: 12),
    ])
    return view
}

private func symbol(
    _ name: String,
    _ size: CGFloat,
    _ color: UIColor,
    weight: UIImage.SymbolWeight = .regular
) -> UIImageView {
    let config = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    let view = UIImageView(image: UIImage(systemName: name, withConfiguration: config))
    view.tintColor = color
    view.contentMode = .center
    view.setContentHuggingPriority(.required, for: .horizontal)
    return view
}

private func row(
    lead: UIView?,
    title: String,
    subtitle: String? = nil,
    detail: String? = nil,
    onTap: @escaping () -> Void
) -> UIView {
    var lines: [UIView] = [label(title, .systemFont(ofSize: 17, weight: .semibold))]
    if let subtitle { lines.append(label(subtitle, .systemFont(ofSize: 13), .secondaryLabel)) }
    if let detail { lines.append(label(detail, .systemFont(ofSize: 12), .tertiaryLabel)) }
    var views: [UIView] = []
    if let lead { views.append(lead) }
    views.append(stack(.vertical, 2, lines))
    views.append(symbol("chevron.right", 13, .tertiaryLabel, weight: .semibold))
    return card(stack(.horizontal, 12, views, align: .center), onTap: onTap)
}

private func circleButton(_ glyph: UIImageView, name: String, onTap: @escaping () -> Void) -> UIView {
    let button = Tappable()
    button.backgroundColor = cardColor
    button.layer.cornerRadius = 18
    button.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        button.widthAnchor.constraint(equalToConstant: 36),
        button.heightAnchor.constraint(equalToConstant: 36),
    ])
    pinned(glyph, in: button, .zero)
    button.isAccessibilityElement = true
    button.accessibilityLabel = name
    button.accessibilityTraits = .button
    button.onTap = onTap
    return button
}

/// Scrolls a page, keeps what it holds wide enough, and leaves room for the keyboard.
private func page(_ content: UIView, in view: UIView, top: UIView?) -> UIScrollView {
    let scroll = UIScrollView()
    scroll.alwaysBounceVertical = true
    scroll.keyboardDismissMode = .interactive
    pinned(content, in: scroll, UIEdgeInsets(top: 12, left: space, bottom: 24, right: space))
    content.widthAnchor.constraint(equalTo: scroll.widthAnchor, constant: -2 * space).isActive = true
    let column = stack(.vertical, 0, [top, scroll].compactMap { $0 })
    column.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(column)
    NSLayoutConstraint.activate([
        column.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
        column.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        column.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        column.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    return scroll
}

// MARK: - An expanding "enter" row

private final class EntryRow: UIStackView, UITextFieldDelegate {
    private let chevron = symbol("chevron.right", 13, .label, weight: .semibold)
    private let field = UITextField()
    private let form: UIStackView
    private let submit: (String) -> Void
    /// After the form shows or hides, so the page can bring it into view.
    var onLayoutChange: ((EntryRow) -> Void)?

    init(
        title: String,
        placeholder: String,
        action: String,
        keyboard: UIKeyboardType = .default,
        submit: @escaping (String) -> Void
    ) {
        self.submit = submit
        field.placeholder = placeholder
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.keyboardType = keyboard
        field.borderStyle = .roundedRect
        field.returnKeyType = .go
        let button = Tappable()
        let buttonTitle = label(action, .systemFont(ofSize: 17, weight: .semibold), .white)
        buttonTitle.textAlignment = .center
        pinned(buttonTitle, in: button, .zero)
        button.backgroundColor = accent
        button.layer.cornerRadius = 10
        button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        form = stack(.vertical, 10, [field, button])
        super.init(frame: .zero)
        axis = .vertical
        spacing = 12
        field.delegate = self
        button.onTap = { [weak self] in self?.send() }
        let toggle = Tappable()
        pinned(
            stack(.horizontal, 10, [chevron, label(title, .systemFont(ofSize: 15)), UIView()], align: .center),
            in: toggle,
            UIEdgeInsets(top: 2, left: 0, bottom: 2, right: 0)
        )
        toggle.onTap = { [weak self] in self?.setExpanded(self?.form.isHidden == true) }
        addArrangedSubview(toggle)
        addArrangedSubview(form)
        form.isHidden = true
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var isEditing: Bool {
        field.isFirstResponder
    }

    func setExpanded(_ expanded: Bool) {
        UIView.animate(
            withDuration: 0.2,
            animations: {
                self.form.isHidden = !expanded
                self.chevron.transform = expanded ? CGAffineTransform(rotationAngle: .pi / 2) : .identity
            },
            completion: { [weak self] _ in
                guard let self else { return }
                self.onLayoutChange?(self)
            }
        )
        if expanded {
            field.becomeFirstResponder()
        } else {
            field.resignFirstResponder()
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        send()
        return false
    }

    private func send() {
        guard let text = field.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        field.text = ""
        setExpanded(false)
        submit(text)
    }
}

// MARK: - Home

private final class HomeController: UIViewController, UIGestureRecognizerDelegate {
    private let coordinator: HotUpdaterSandboxCoordinator
    private let devServer: HotUpdaterSandboxDevServer
    private let isOverApp: () -> Bool
    private let onClose: () -> Void
    private let onScan: () -> Void
    private let onDevServerError: (String, String) -> Void
    private let sections = stack(.vertical, 22, [])
    private let closeSlot = UIView()
    private var scroll: UIScrollView?
    private var urlEntry: EntryRow?
    private var channelEntry: EntryRow?
    private var shown: HotUpdaterSandboxHomeModel?
    private var shownOverApp: Bool?
    private var state: HotUpdaterSandboxState?

    init(
        coordinator: HotUpdaterSandboxCoordinator,
        devServer: HotUpdaterSandboxDevServer,
        isOverApp: @escaping () -> Bool,
        onClose: @escaping () -> Void,
        onScan: @escaping () -> Void,
        onDevServerError: @escaping (String, String) -> Void
    ) {
        self.coordinator = coordinator
        self.devServer = devServer
        self.isOverApp = isOverApp
        self.onClose = onClose
        self.onScan = onScan
        self.onDevServerError = onDevServerError
        super.init(nibName: nil, bundle: nil)
        tabBarItem = UITabBarItem(title: "Home", image: UIImage(systemName: "house.fill"), tag: 0)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        scroll = page(sections, in: view, top: makeHeader())
        let entryChanged: (EntryRow) -> Void = { [weak self] in self?.reveal($0) }
        let url = EntryRow(
            title: "Enter URL manually",
            placeholder: "192.168.0.10:8081",
            action: "Connect",
            keyboard: .URL
        ) { [weak self] in self?.connect($0) }
        url.onLayoutChange = entryChanged
        urlEntry = url
        let channel = EntryRow(title: "Enter a channel", placeholder: "pr-123", action: "Open") { [weak self] in
            self?.coordinator.switchTo($0)
        }
        channel.onLayoutChange = entryChanged
        channelEntry = channel
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardMoved),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        let tapOutside = UITapGestureRecognizer(target: self, action: #selector(endEditing))
        tapOutside.cancelsTouchesInView = false
        tapOutside.delegate = self
        view.addGestureRecognizer(tapOutside)
        devServer.onDevServerChange = { [weak self] in
            guard let self, let state = self.state else { return }
            self.shown = nil
            self.render(state)
        }
    }

    @objc private func endEditing() {
        view.endEditing(true)
    }

    /// A tap on a control is that control's, not a tap outside the field. Taking the
    /// keyboard away under it would move the control from under the finger.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        !(touch.view is UIControl)
    }

    func render(_ next: HotUpdaterSandboxState) {
        state = next
        let overApp = isOverApp()
        let model = HotUpdaterSandboxHomeModel(
            state: next,
            isOverApp: overApp,
            runningDevServerHost: devServer.runningDevServerHost,
            nowMs: Date().timeIntervalSince1970 * 1000
        )
        if overApp != shownOverApp {
            shownOverApp = overApp
            closeSlot.isHidden = !overApp
        }
        guard model != shown else { return }
        shown = model
        for old in sections.arrangedSubviews {
            sections.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        makeSections(model).forEach(sections.addArrangedSubview)
    }

    /// Makes room for the keyboard, then shows the whole form of the field in use.
    @objc private func keyboardMoved(_ note: Notification) {
        guard let scroll,
              let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let window = view.window else { return }
        let bottom = scroll.convert(scroll.bounds, to: window).maxY
        let covered = max(0, bottom - window.convert(frame, from: nil).minY - scroll.safeAreaInsets.bottom)
        scroll.contentInset.bottom = covered
        scroll.verticalScrollIndicatorInsets.bottom = covered
        guard let editing = [urlEntry, channelEntry].compactMap({ $0 }).first(where: { $0.isEditing }) else { return }
        reveal(editing)
    }

    private func reveal(_ entry: EntryRow) {
        guard let scroll, entry.isEditing else { return }
        view.layoutIfNeeded()
        scroll.scrollRectToVisible(entry.convert(entry.bounds, to: scroll).insetBy(dx: 0, dy: -12), animated: true)
    }

    private func makeHeader() -> UIView {
        let app = appInfo()
        let icon = UIImageView(image: app.icon)
        icon.backgroundColor = app.icon == nil ? accent : cardColor
        icon.layer.cornerRadius = 8
        icon.clipsToBounds = true
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 32),
            icon.heightAnchor.constraint(equalToConstant: 32),
        ])
        if app.icon == nil {
            let monogram = label(String(app.name.prefix(1)).uppercased(), .systemFont(ofSize: 17, weight: .bold), .white)
            monogram.textAlignment = .center
            pinned(monogram, in: icon, .zero)
        }
        let name = stack(.vertical, 0, [
            label(app.name, .systemFont(ofSize: 17, weight: .semibold)),
            label("Sandbox · \(app.version)", .systemFont(ofSize: 12), .secondaryLabel),
        ])
        let close = circleButton(symbol("xmark", 15, .secondaryLabel, weight: .semibold), name: "Back to the app") { [weak self] in
            self?.onClose()
        }
        pinned(close, in: closeSlot, .zero)
        closeSlot.isHidden = true
        let header = stack(.horizontal, 12, [icon, name, UIView(), closeSlot], align: .center)
        let wrap = UIView()
        pinned(header, in: wrap, UIEdgeInsets(top: 8, left: space, bottom: 8, right: space))
        return wrap
    }

    private func makeSections(_ model: HotUpdaterSandboxHomeModel) -> [UIView] {
        var views: [UIView] = []
        if let status = model.status {
            views.append(statusCard(status))
        }
        if let banner = model.banner {
            views.append(bannerCard(banner))
        }
        views.append(primarySection(model))
        views.append(devServerSection(model))
        views.append(previewSection(model))
        views.append(label(HotUpdaterSandboxHomeModel.hint, .systemFont(ofSize: 13), .secondaryLabel, lines: 0))
        return views
    }

    private func statusCard(_ status: HotUpdaterSandboxHomeModel.Status) -> UIView {
        var lines: [UIView] = [label(status.text, .systemFont(ofSize: 15), .label, lines: 0)]
        if let progress = status.progress {
            let bar = UIProgressView(progressViewStyle: .default)
            bar.progress = Float(progress)
            bar.progressTintColor = accent
            lines.append(bar)
        }
        return card(stack(.vertical, 10, lines))
    }

    private func bannerCard(_ banner: HotUpdaterSandboxHomeModel.Banner) -> UIView {
        let text = stack(.horizontal, 12, [
            symbol("exclamationmark.triangle.fill", 20, .systemOrange),
            label(banner.text, .systemFont(ofSize: 15), .label, lines: 0),
        ], align: .center)
        guard banner.offersReset else { return card(text) }
        let reset = Tappable()
        pinned(label("Reset to built-in bundle", .systemFont(ofSize: 15, weight: .semibold), .systemRed), in: reset, .zero)
        reset.onTap = { [weak self] in self?.coordinator.resetToBuiltIn() }
        return card(stack(.vertical, 12, [text, reset]))
    }

    private func primarySection(_ model: HotUpdaterSandboxHomeModel) -> UIView {
        let tile = UIView()
        tile.backgroundColor = accent
        tile.layer.cornerRadius = 10
        tile.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            tile.widthAnchor.constraint(equalToConstant: 44),
            tile.heightAnchor.constraint(equalToConstant: 44),
        ])
        pinned(symbol(model.bigRow.isReload ? "arrow.clockwise" : "play.fill", 20, .white), in: tile, .zero)
        let open = row(
            lead: tile,
            title: model.bigRow.title,
            subtitle: model.bigRow.subtitle,
            detail: model.bigRow.detail
        ) { [weak self] in self?.openTapped() }
        open.accessibilityIdentifier = "hot-updater-sandbox-open"
        open.isUserInteractionEnabled = !model.isBusy
        open.alpha = model.isBusy ? 0.5 : 1
        return stack(.vertical, 10, [caption(model.bigRow.caption), open])
    }

    private func openTapped() {
        view.endEditing(true)
        if shown?.bigRow.isReload == true {
            if devServer.isRunningDevServer {
                devServer.reloadDevServer()
            } else {
                coordinator.reloadApp()
            }
            return
        }
        Task { await coordinator.open() }
    }

    private func devServerSection(_ model: HotUpdaterSandboxHomeModel) -> UIView {
        let help = caption("Dev server", action: ("Help", {
            guard let url = URL(string: "https://hot-updater.dev/docs/native-builds/sandbox") else { return }
            UIApplication.shared.open(url)
        }))
        var views: [UIView] = [help]
        if let running = devServer.runningDevServerHost {
            views.append(row(lead: dot(.systemGreen), title: running, subtitle: devServer.lastDevServerError ?? "Dev server running") { [weak self] in
                self?.devServer.reloadDevServer()
            })
            views.append(row(lead: nil, title: "Exit dev server") { [weak self] in
                self?.devServer.exitDevServer()
                self?.onClose()
            })
        } else {
            for host in devServer.devServerHosts {
                views.append(row(
                    lead: dot(host.isRunning == true ? .systemGreen : .systemGray),
                    title: host.address,
                    subtitle: Self.subtitle(of: host)
                ) { [weak self] in self?.connect(host.address) })
            }
            if let urlEntry {
                views.append(card(urlEntry))
            }
        }
        views.forEach { $0.isUserInteractionEnabled = !model.isBusy }
        return stack(.vertical, 10, views)
    }

    private static func subtitle(of host: HotUpdaterSandboxDevServerHost) -> String {
        switch host.isRunning {
        case true:
            return "Dev server running"
        case false:
            return "Not running. Start your dev server, then tap to retry."
        default:
            return "Tap to connect"
        }
    }

    private func connect(_ host: String) {
        view.endEditing(true)
        devServer.connect(host: host) { [weak self] problem in
            if let problem {
                self?.onDevServerError(host, problem)
            }
        }
    }

    private func previewSection(_ model: HotUpdaterSandboxHomeModel) -> UIView {
        var clear: (String, () -> Void)?
        if !model.previews.isEmpty {
            clear = ("Clear", { [weak self] in self?.coordinator.clearHistory() })
        }
        var views: [UIView] = [caption("OTA previews", action: clear)]
        let scan = Tappable()
        pinned(
            stack(
                .horizontal,
                10,
                [symbol("qrcode.viewfinder", 15, .label), label("Scan QR code", .systemFont(ofSize: 15)), UIView()],
                align: .center
            ),
            in: scan,
            UIEdgeInsets(top: 2, left: 0, bottom: 2, right: 0)
        )
        scan.onTap = { [weak self] in self?.onScan() }
        views.append(card(scan))
        if let hint = model.previewHint {
            views.append(label(hint, .systemFont(ofSize: 15), .secondaryLabel, lines: 0))
        }
        for preview in model.previews {
            let open = row(
                lead: dot(.systemGray),
                title: preview.channel,
                subtitle: preview.message,
                detail: preview.opened
            ) { [weak self] in
                self?.view.endEditing(true)
                self?.coordinator.switchTo(preview.channel)
            }
            open.isUserInteractionEnabled = !model.isBusy
            views.append(open)
        }
        if let channelEntry {
            let entry = card(channelEntry)
            entry.isUserInteractionEnabled = !model.isBusy
            views.append(entry)
        }
        views.append(label(HotUpdaterSandboxHomeModel.switchNote, .systemFont(ofSize: 13), .secondaryLabel, lines: 0))
        return stack(.vertical, 10, views)
    }
}

// MARK: - Info

private final class InfoController: UIViewController {
    private let coordinator: HotUpdaterSandboxCoordinator
    private let devServer: HotUpdaterSandboxDevServer
    private let isOverApp: () -> Bool
    private let groups = stack(.vertical, 22, [])
    private let reset = Tappable()
    private var shown: HotUpdaterSandboxInfoModel?

    init(
        coordinator: HotUpdaterSandboxCoordinator,
        devServer: HotUpdaterSandboxDevServer,
        isOverApp: @escaping () -> Bool
    ) {
        self.coordinator = coordinator
        self.devServer = devServer
        self.isOverApp = isOverApp
        super.init(nibName: nil, bundle: nil)
        tabBarItem = UITabBarItem(title: "Info", image: UIImage(systemName: "info.circle.fill"), tag: 1)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = label("Info", .systemFont(ofSize: 34, weight: .bold))
        reset.backgroundColor = cardColor
        reset.layer.cornerRadius = 12
        pinned(
            label("Reset to built-in bundle", .systemFont(ofSize: 17), .systemRed),
            in: reset,
            UIEdgeInsets(top: 14, left: space, bottom: 14, right: space)
        )
        reset.onTap = { [weak self] in self?.coordinator.resetToBuiltIn() }
        let note = label(HotUpdaterSandboxHomeModel.resetNote, .systemFont(ofSize: 13), .secondaryLabel, lines: 0)
        let content = stack(.vertical, 22, [title, groups, stack(.vertical, 8, [reset, note])])
        _ = page(content, in: view, top: nil)
        render(coordinator.state)
    }

    func render(_ state: HotUpdaterSandboxState) {
        guard isViewLoaded else { return }
        var busy = false
        if case .working = state.phase { busy = true }
        // Without a server, a reset has nothing to go back from, and can't run.
        let canReset = state.hasServerConfig && !busy
        reset.isEnabled = canReset
        reset.alpha = canReset ? 1 : 0.5
        let model = HotUpdaterSandboxInfoModel(
            state: state,
            version: appInfo().version,
            configuration: Self.configuration,
            isOverApp: isOverApp(),
            runningDevServerHost: devServer.runningDevServerHost
        )
        guard model != shown else { return }
        shown = model
        for old in groups.arrangedSubviews {
            groups.removeArrangedSubview(old)
            old.removeFromSuperview()
        }
        groups.addArrangedSubview(group("Build", model.build))
        groups.addArrangedSubview(group("Bundle", model.bundle))
    }

    private static var configuration: String {
        #if DEBUG
        return "Debug"
        #else
        return "Release"
        #endif
    }

    private func group(_ name: String, _ rows: [HotUpdaterSandboxInfoModel.Row]) -> UIView {
        var lines: [UIView] = []
        for (index, entry) in rows.enumerated() {
            if index > 0 {
                let rule = UIView()
                rule.backgroundColor = .separator
                rule.translatesAutoresizingMaskIntoConstraints = false
                rule.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true
                lines.append(rule)
            }
            let value = label(entry.value, .systemFont(ofSize: 15), .secondaryLabel)
            value.textAlignment = .right
            value.lineBreakMode = .byTruncatingMiddle
            lines.append(stack(.horizontal, 12, [label(entry.name, .systemFont(ofSize: 15)), value]))
        }
        return stack(.vertical, 10, [caption(name), card(stack(.vertical, 12, lines))])
    }
}

// MARK: - The screen

/// The first screen, and the same screen over a running app. It renders
/// `HotUpdaterSandboxState` and calls the coordinator's actions. Reads only:
/// opening it sends the update server nothing.
@MainActor
final class HotUpdaterSandboxScreen: UITabBarController {
    private let coordinator: HotUpdaterSandboxCoordinator
    private let isOverApp: () -> Bool
    private var home: HomeController?
    private var infoTab: InfoController?
    private var stopObserving: (() -> Void)?
    private var shownPhase: HotUpdaterSandboxPhase?

    init(
        coordinator: HotUpdaterSandboxCoordinator,
        devServer: HotUpdaterSandboxDevServer,
        isOverApp: @escaping () -> Bool,
        onClose: @escaping () -> Void
    ) {
        self.coordinator = coordinator
        self.isOverApp = isOverApp
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
        let home = HomeController(
            coordinator: coordinator,
            devServer: devServer,
            isOverApp: isOverApp,
            onClose: onClose,
            onScan: { [weak self] in self?.scan() },
            onDevServerError: { [weak self] host, problem in self?.show(host, problem) }
        )
        let infoTab = InfoController(coordinator: coordinator, devServer: devServer, isOverApp: isOverApp)
        self.home = home
        self.infoTab = infoTab
        viewControllers = [home, infoTab]
        tabBar.tintColor = accent
    }

    private let onClose: () -> Void

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        home?.loadViewIfNeeded()
        stopObserving = coordinator.observe { [weak self] in self?.render($0) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        ask(coordinator.state.phase)
    }

    private func render(_ state: HotUpdaterSandboxState) {
        home?.render(state)
        infoTab?.render(state)
        ask(state.phase)
    }

    private func scan() {
        let scanner = HotUpdaterSandboxScanner { [weak self] url in
            self?.coordinator.receiveLink(url.absoluteString)
        }
        present(scanner, animated: true)
    }

    private func show(_ host: String, _ problem: String) {
        let alert = UIAlertController(title: "Couldn't connect to \(host)", message: problem, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        alert.view.tintColor = accent
        present(alert, animated: false)
    }

    private func ask(_ phase: HotUpdaterSandboxPhase) {
        guard view.window != nil, phase != shownPhase else { return }
        shownPhase = phase
        // A question left over from the last phase goes first. A scanner goes by itself.
        if presentedViewController is UIAlertController {
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
        alert.view.tintColor = accent
        // A scanner closing with a link is still on its way out.
        if let presented = presentedViewController {
            presented.dismiss(animated: false) { [weak self] in self?.present(alert, animated: false) }
        } else {
            present(alert, animated: false)
        }
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
#endif
