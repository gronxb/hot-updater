#if HOT_UPDATER_SANDBOX_LAYER
import AVFoundation
import SwiftUI
import UIKit

private let helpURL = URL(string: "https://hot-updater.dev/docs/native-builds/sandbox")!

/// The questions a person asks for: they confirm before anything destructive.
enum HotUpdaterSandboxConfirm: Hashable {
    case clear, bannerReset, infoReset
}

enum HotUpdaterSandboxSheet: Hashable, Identifiable {
    case scanner, license

    var id: Self { self }
}

/// The screen's two forms.
enum HotUpdaterSandboxEntry: Hashable {
    case url, channel
}

/// What the SwiftUI screen reads: the coordinator's state, the dev server, and the
/// one alert on screen. A question waits while a sheet is up, so it presents once
/// the sheet is gone.
@available(iOS 16.0, *)
@MainActor
final class HotUpdaterSandboxScreenModel: ObservableObject {
    enum Prompt: Equatable {
        case question(HotUpdaterSandboxQuestion)
        case connectProblem(host: String, problem: String)
    }

    @Published private(set) var state: HotUpdaterSandboxState
    @Published private(set) var devServerRevision = 0
    /// What a person is in the middle of: the tab, the open form, and what's typed
    /// in each. They live here, not in a pane, so a fold or a rotation that lays the
    /// panes out again keeps them.
    @Published var tab = 0
    @Published var expanded: HotUpdaterSandboxEntry?
    @Published var urlText = ""
    @Published var channelText = ""
    /// Info pushed over Home, the question a person asked for, the sheet, and where
    /// each page is scrolled to: all here, so a fold that lays the panes out again keeps them.
    @Published var showsInfo = false
    @Published var confirming: HotUpdaterSandboxConfirm?
    @Published var sheet: HotUpdaterSandboxSheet?
    @Published var homeAnchor: String?
    @Published var infoAnchor: String?
    /// Whether the arrangement shows Info beside Home: when it shows Home alone,
    /// such as a closed foldable on its side, Home links to Info.
    @Published var isInfoPaneShown = false
    private var scanned: URL?
    /// Whatever goes, a question waiting behind it comes next, once that alert has left.
    @Published var prompt: Prompt? {
        didSet {
            guard prompt == nil, oldValue != nil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.showQuestion() }
        }
    }

    let coordinator: HotUpdaterSandboxCoordinator
    let devServer: HotUpdaterSandboxDevServer
    let isOverApp: () -> Bool
    let onClose: () -> Void

    var isSheetUp = false {
        didSet { if !isSheetUp { showQuestion() } }
    }

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
        state = coordinator.state
    }

    func receive(_ next: HotUpdaterSandboxState) {
        state = next
        showQuestion()
    }

    func devServerChanged() {
        devServerRevision += 1
    }

    var home: HotUpdaterSandboxHomeModel {
        HotUpdaterSandboxHomeModel(
            state: state,
            isOverApp: isOverApp(),
            runningDevServerHost: devServer.runningDevServerHost,
            nowMs: Date().timeIntervalSince1970 * 1000
        )
    }

    var info: HotUpdaterSandboxInfoModel {
        HotUpdaterSandboxInfoModel(
            state: state,
            version: HotUpdaterSandboxApp.current.version,
            configuration: HotUpdaterSandboxApp.configuration,
            isOverApp: isOverApp(),
            runningDevServerHost: devServer.runningDevServerHost
        )
    }

    /// Without a server, a reset has nothing to go back from, and can't run.
    var canReset: Bool {
        if case .working = state.phase { return false }
        return state.hasServerConfig
    }

    /// The phase's question, once nothing else is on screen. A new question in
    /// place of a shown one waits for that alert to leave.
    func showQuestion() {
        guard !isSheetUp else { return }
        let question = HotUpdaterSandboxQuestion(phase: state.phase, isOverApp: isOverApp())
        if prompt == question.map(Prompt.question) { return }
        if prompt != nil {
            if case .question = prompt { prompt = nil }
            return
        }
        guard let question else { return }
        prompt = .question(question)
        if question.kind == .confirm { SandboxHaptic.warning() } else { SandboxHaptic.error() }
    }

    func present(_ next: HotUpdaterSandboxSheet) {
        isSheetUp = true
        sheet = next
    }

    func scanned(_ url: URL) {
        scanned = url
        sheet = nil
    }

    /// A scanned link is handed over once the sheet is gone, so its question can present.
    func sheetClosed() {
        isSheetUp = false
        guard let url = scanned else { return }
        scanned = nil
        coordinator.receiveLink(url.absoluteString)
    }

    func isConfirming(_ which: HotUpdaterSandboxConfirm) -> Binding<Bool> {
        Binding(get: { self.confirming == which }, set: { if !$0, self.confirming == which { self.confirming = nil } })
    }

    func closeIfOverApp() {
        if isOverApp() { onClose() }
    }

    func answer(_ question: HotUpdaterSandboxQuestion, accept: Bool) {
        switch (question.kind, accept) {
        case (.confirm, true): coordinator.confirmLink()
        case (.confirm, false), (.refused, _): coordinator.dismiss { [weak self] in self?.closeIfOverApp() }
        case (.failed, true): coordinator.retry()
        case (.failed, false): coordinator.dismiss()
        }
    }

    func connect(_ host: String) {
        devServer.connect(host: host) { [weak self] problem in
            guard let self, let problem else { return }
            SandboxHaptic.error()
            if self.prompt == nil { self.prompt = .connectProblem(host: host, problem: problem) }
        }
    }

    func openOrReload() {
        SandboxHaptic.tap()
        if home.bigRow.isReload {
            if devServer.isRunningDevServer {
                devServer.reloadDevServer()
            } else {
                coordinator.reloadApp()
            }
            return
        }
        Task { await coordinator.open() }
    }
}

/// The screen: Home and Info as tabs, or side by side once the window is wide,
/// such as an open foldable, an iPad, or a phone on its side.
@available(iOS 16.0, *)
struct HotUpdaterSandboxRootView: View {
    @ObservedObject var model: HotUpdaterSandboxScreenModel

    var body: some View {
        GeometryReader { proxy in
            Group {
                if proxy.size.width >= 600 {
                    wide
                } else {
                    tabs
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .tint(SandboxColor.accent)
        .sheet(item: $model.sheet, onDismiss: model.sheetClosed) { sheet in
            switch sheet {
            case .scanner: HotUpdaterSandboxScanSheet(onLink: model.scanned)
            case .license: HotUpdaterSandboxLicenseSheet()
            }
        }
        .alert(
            promptTitle,
            isPresented: Binding(get: { model.prompt != nil }, set: { if !$0 { model.prompt = nil } }),
            presenting: model.prompt,
            actions: promptActions,
            message: { prompt in Text(promptMessage(prompt)) }
        )
    }

    private var tabs: some View {
        TabView(selection: $model.tab) {
            HomeScreen(model: model, showsInfoLink: false)
                .tabItem { Label("Home", systemImage: "house") }
                .tag(0)
            InfoScreen(model: model)
                .tabItem { Label("Info", systemImage: "info.circle") }
                .tag(1)
        }
    }

    @ViewBuilder
    private var wide: some View {
        #if canImport(SwiftUI, _version: 8.1)
        if #available(iOS 27.1, *) {
            // The system places the two around a fold and decides whether the
            // second one fits: when it doesn't, Home links to Info.
            ArrangementView {
                HomeScreen(model: model, showsInfoLink: !model.isInfoPaneShown)
            } secondary: {
                InfoScreen(model: model)
                    .background(GeometryReader { pane in
                        Color.clear
                            .onAppear { model.isInfoPaneShown = pane.size.width > 1 }
                            .onChange(of: pane.size.width) { model.isInfoPaneShown = $0 > 1 }
                            .onDisappear { model.isInfoPaneShown = false }
                    })
            }
            .arrangementViewStyle(.split)
        } else {
            sideBySide
        }
        #else
        sideBySide
        #endif
    }

    private var sideBySide: some View {
        HStack(spacing: 0) {
            HomeScreen(model: model, showsInfoLink: false)
            SandboxVerticalRule()
            InfoScreen(model: model)
        }
    }

    private var promptTitle: String {
        switch model.prompt {
        case .question(let question): return question.title
        case .connectProblem(let host, _): return "Couldn't connect to \(host)"
        case nil: return ""
        }
    }

    private func promptMessage(_ prompt: HotUpdaterSandboxScreenModel.Prompt) -> String {
        switch prompt {
        case .question(let question): return question.message
        case .connectProblem(_, let problem): return problem
        }
    }

    @ViewBuilder
    private func promptActions(_ prompt: HotUpdaterSandboxScreenModel.Prompt) -> some View {
        switch prompt {
        case .question(let question):
            if let decline = question.decline {
                Button(decline, role: .cancel) { model.answer(question, accept: false) }
                Button(question.accept) { model.answer(question, accept: true) }
            } else {
                Button(question.accept) { model.answer(question, accept: false) }
            }
        case .connectProblem:
            Button("OK", role: .cancel) {}
        }
    }
}

@available(iOS 16.0, *)
private struct SandboxVerticalRule: View {
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Rectangle().fill(SandboxColor.separator).frame(width: 1 / displayScale).ignoresSafeArea()
    }
}


// MARK: - Home

@available(iOS 16.0, *)
private struct HomeScreen: View {
    private typealias Entry = HotUpdaterSandboxEntry

    @ObservedObject var model: HotUpdaterSandboxScreenModel
    let showsInfoLink: Bool
    @FocusState private var focus: Entry?
    @Environment(\.openURL) private var openURL

    var body: some View {
        let home = model.home
        NavigationStack {
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        HotUpdaterSandboxHeader().id("header")
                        if let status = home.status { statusCard(status).id("status") }
                        if let banner = home.banner { bannerCard(banner).id("banner") }
                        primary(home).id("primary")
                        devServer(home).id("devServer")
                        previews(home).id("previews")
                        downloaded(home).id("downloaded")
                        Text(HotUpdaterSandboxHomeModel.hint)
                            .font(SandboxFont.footnote)
                            .foregroundColor(SandboxColor.textSecondary)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                            .id("hint")
                    }
                    .sandboxScrollTargets()
                    .padding(16)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                .sandboxScrollPosition($model.homeAnchor)
                .modifier(SandboxStatusBarBackdrop())
                .background(SandboxColor.background.ignoresSafeArea())
                .onAppear {
                    // A pane laid out again by a fold goes back to where it was, and
                    // gets back the field that had focus.
                    if let anchor = model.homeAnchor {
                        DispatchQueue.main.async { scroll.scrollTo(anchor, anchor: .top) }
                    }
                    guard let entry = model.expanded else { return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { focus = entry }
                }
                .onChange(of: focus) { entry in
                    guard let entry else { return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { reveal(entry, scroll) }
                }
                // Once the keyboard is up, the page's inset is its height: before
                // that, the page can't scroll far enough for the form to clear it.
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                    if let entry = focus { reveal(entry, scroll) }
                }
            }
            .navigationTitle(HotUpdaterSandboxApp.current.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            // The header names the app, so the bar shows only when it holds an item.
            .toolbar(model.isOverApp() || showsInfoLink ? .visible : .hidden, for: .navigationBar)
            // Info is pushed only while it has no pane of its own: once a fold or a
            // rotation gives it one, or takes Home's link away, the push goes.
            .navigationDestination(
                isPresented: Binding(get: { showsInfoLink && model.showsInfo }, set: { model.showsInfo = $0 })
            ) { InfoScreen(model: model, isPushed: true) }
            .onAppear { if !showsInfoLink { model.showsInfo = false } }
            .onChange(of: showsInfoLink) { linked in if !linked { model.showsInfo = false } }
        }
    }

    /// The whole form in view: its bottom, the button, goes to the bottom of
    /// what the keyboard leaves.
    private func reveal(_ entry: Entry, _ scroll: ScrollViewProxy) {
        guard focus == entry else { return }
        withAnimation(SandboxMotion.spring) { scroll.scrollTo(entry, anchor: .bottom) }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            // The header below names the app.
            Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
        }
        if model.isOverApp() {
            ToolbarItem(placement: .cancellationAction) {
                Button { model.onClose() } label: { Label("Back to the app", systemImage: "xmark") }
                        .tint(SandboxColor.text)
            }
        }
        if showsInfoLink {
            ToolbarItem(placement: .primaryAction) {
                Button { model.showsInfo = true } label: { Label("Info", systemImage: "info.circle") }
            }
        }
    }

    private func statusCard(_ status: HotUpdaterSandboxHomeModel.Status) -> some View {
        SandboxCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    if status.progress == nil { ProgressView() }
                    Text(status.text)
                        .font(SandboxFont.body)
                        .foregroundColor(SandboxColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let progress = status.progress {
                    ProgressView(value: progress)
                        .tint(SandboxColor.accent)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private func bannerCard(_ banner: HotUpdaterSandboxHomeModel.Banner) -> some View {
        SandboxCard {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(SandboxColor.danger)
                    .accessibilityHidden(true)
                Text(banner.text)
                    .font(SandboxFont.body)
                    .foregroundColor(SandboxColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(16)
            .accessibilityElement(children: .combine)
            if banner.offersReset {
                SandboxDivider(leading: false)
                SandboxDestructiveRow(title: "Reset to built-in bundle", isEnabled: !home.isBusy) {
                    model.confirming = .bannerReset
                }
                .resetDialog(.bannerReset, model: model)
            }
        }
    }

    private var home: HotUpdaterSandboxHomeModel { model.home }

    private func primary(_ home: HotUpdaterSandboxHomeModel) -> some View {
        SandboxSection(title: home.bigRow.caption) {
            SandboxCard {
                SandboxRow(
                    lead: .primary(home.bigRow.isReload ? "arrow.clockwise" : "play.fill"),
                    title: home.bigRow.title,
                    titleFont: SandboxFont.headline,
                    subtitle: home.bigRow.subtitle,
                    detail: home.bigRow.detail,
                    // A deploy message leads with what identifies it, such as a commit: one line keeps it in view.
                    detailLineLimit: 1,
                    isEnabled: !home.isBusy,
                    action: model.openOrReload
                )
                .accessibilityIdentifier("hot-updater-sandbox-open")
                if home.bigRow.showsBack {
                    SandboxDivider()
                    SandboxRow(lead: .icon("arrow.uturn.backward"), title: "Back to current bundle", showsChevron: false) {
                        SandboxHaptic.tap()
                        model.coordinator.leaveStoredSession()
                        model.onClose()
                    }
                }
            }
        }
    }

    private func devServer(_ home: HotUpdaterSandboxHomeModel) -> some View {
        let devServer = model.devServer
        return SandboxSection(title: "Dev server", action: ("Help", { openURL(helpURL) })) {
            SandboxCard {
                if let running = devServer.runningDevServerHost {
                    SandboxRow(
                        lead: .dot(SandboxColor.success),
                        title: running,
                        titleFont: SandboxFont.codeHeadline,
                        subtitle: devServer.lastDevServerError ?? "Dev server running",
                        action: devServer.reloadDevServer
                    )
                    SandboxDivider()
                    SandboxRow(lead: .icon("xmark.circle"), title: "Exit dev server", showsChevron: false) {
                        devServer.exitDevServer()
                        model.onClose()
                    }
                } else {
                    ForEach(devServer.devServerHosts, id: \.address) { host in
                        SandboxRow(
                            lead: .dot(host.isRunning == true ? SandboxColor.success : SandboxColor.muted),
                            title: host.address,
                            titleFont: SandboxFont.codeHeadline,
                            subtitle: Self.subtitle(of: host),
                            isEnabled: !home.isBusy
                        ) {
                            model.connect(host.address)
                        }
                        SandboxDivider()
                    }
                    accordion(
                        .url,
                        lead: .icon("link"),
                        title: "Enter URL manually",
                        placeholder: "192.168.0.10:8081",
                        fieldLabel: "Dev server address",
                        action: "Connect",
                        keyboard: .URL,
                        text: $model.urlText,
                        isEnabled: !home.isBusy
                    ) { model.connect($0) }
                }
            }
        }
    }

    private static func subtitle(of host: HotUpdaterSandboxDevServerHost) -> String {
        switch host.isRunning {
        case true: return "Dev server running"
        case false: return "Not running. Start your dev server, then tap to retry."
        default: return "Tap to connect"
        }
    }

    private func previews(_ home: HotUpdaterSandboxHomeModel) -> some View {
        let footer = [home.previewHint, HotUpdaterSandboxHomeModel.switchNote].compactMap { $0 }.joined(separator: " ")
        return SandboxSection(title: "Channels", footer: footer) {
            SandboxCard {
                SandboxRow(lead: .icon("qrcode.viewfinder"), title: "Scan QR code", isEnabled: !home.isBusy) {
                    SandboxHaptic.tap()
                    focus = nil
                    model.present(.scanner)
                }
                SandboxDivider()
                accordion(
                    .channel,
                    lead: .icon("character.cursor.ibeam"),
                    title: "Enter a channel",
                    placeholder: "Channel",
                    fieldLabel: "Channel or link",
                    action: "Open latest",
                    keyboard: .asciiCapable,
                    text: $model.channelText,
                    isEnabled: !home.isBusy
                ) { model.coordinator.switchTo($0) }
            }
        }
    }

    private func downloaded(_ home: HotUpdaterSandboxHomeModel) -> some View {
        SandboxSection(
            title: "Downloaded",
            action: home.downloaded.contains { !$0.isRunning } ? ("Clear", { model.confirming = .clear }) : nil,
            footer: home.downloadedFooter
        ) {
            if !home.downloaded.isEmpty {
                SandboxCard {
                    ForEach(Array(home.downloaded.enumerated()), id: \.element.bundleId) { index, row in
                        if index > 0 { SandboxDivider() }
                        downloadedRow(row, isEnabled: !home.isBusy)
                    }
                }
            }
        }
        .confirmationDialog("Clear downloaded bundles?", isPresented: model.isConfirming(.clear), titleVisibility: .visible) {
            Button("Clear", role: .destructive) { model.coordinator.clearDownloaded() }
        } message: {
            Text("They're only on this device. The running one stays.")
        }
    }

    /// Opens the stored bundle. Pressed and held, it offers Open latest on its channel and Delete.
    private func downloadedRow(_ row: HotUpdaterSandboxHomeModel.Downloaded, isEnabled: Bool) -> some View {
        Button {
            SandboxHaptic.tap()
            focus = nil
            model.coordinator.openDownloaded(row.bundleId)
        } label: {
            SandboxRowContent(
                lead: .icon("shippingbox"),
                title: row.channel,
                titleFont: SandboxFont.codeHeadline,
                subtitle: row.message,
                detail: row.detail
            ) {
                if row.isRunning { SandboxBadge(text: "Running") } else { SandboxChevron() }
            }
        }
        .buttonStyle(SandboxRowStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
        .contextMenu {
            Button { model.coordinator.switchTo(row.channel) } label: {
                Label("Open latest", systemImage: "arrow.down.circle")
            }
            if !row.isRunning {
                Button(role: .destructive) { model.coordinator.deleteDownloaded(row.bundleId) } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    private func accordion(
        _ entry: Entry,
        lead: SandboxLead,
        title: String,
        placeholder: String,
        fieldLabel: String,
        action: String,
        keyboard: UIKeyboardType,
        text: Binding<String>,
        isEnabled: Bool,
        submit: @escaping (String) -> Void
    ) -> some View {
        let send = {
            let value = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            SandboxHaptic.tap()
            text.wrappedValue = ""
            focus = nil
            withAnimation(SandboxMotion.spring) { model.expanded = nil }
            submit(value)
        }
        return SandboxAccordion(
            lead: lead,
            title: title,
            isExpanded: model.expanded == entry,
            isEnabled: isEnabled,
            toggle: {
                SandboxHaptic.toggle()
                let opens = model.expanded != entry
                if !opens { focus = nil }
                withAnimation(SandboxMotion.spring) { model.expanded = opens ? entry : nil }
                // The field takes focus once the card has opened.
                if opens {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        if model.expanded == entry { focus = entry }
                    }
                }
            }
        ) {
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .submitLabel(.go)
                .focused($focus, equals: entry)
                .onSubmit(send)
                .modifier(SandboxFieldStyle(isFocused: focus == entry))
                .accessibilityLabel(fieldLabel)
            Button(action, action: send)
                .buttonStyle(SandboxPrimaryButtonStyle())
                .disabled(text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .id(entry)
    }
}

// MARK: - Info

@available(iOS 16.0, *)
private struct InfoScreen: View {
    @ObservedObject var model: HotUpdaterSandboxScreenModel
    var isPushed = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if isPushed {
            content
        } else {
            NavigationStack { content }
        }
    }

    private var content: some View {
        ScrollViewReader { scroll in
            page.onAppear {
                // A pane laid out again by a fold goes back to where it was.
                guard let anchor = model.infoAnchor else { return }
                DispatchQueue.main.async { scroll.scrollTo(anchor, anchor: .top) }
            }
        }
    }

    private var page: some View {
        let info = model.info
        return ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("Info")
                    .font(SandboxFont.title)
                    .foregroundColor(SandboxColor.text)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, 16)
                    .id("title")
                group("Build", info.build).id("build")
                group("Bundle", info.bundle).id("bundle")
                SandboxSection(title: nil, footer: HotUpdaterSandboxHomeModel.resetNote) {
                    SandboxCard {
                        SandboxDestructiveRow(title: "Reset to built-in bundle", isEnabled: model.canReset) {
                            model.confirming = .infoReset
                        }
                    }
                }
                .resetDialog(.infoReset, model: model)
                .id("reset")
                SandboxSection(title: "Licenses") {
                    SandboxCard {
                        SandboxRow(lead: nil, title: HotUpdaterSandboxFonts.licenseTitle) { model.present(.license) }
                    }
                }
                .id("licenses")
            }
            .sandboxScrollTargets()
            .padding(16)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .sandboxScrollPosition($model.infoAnchor)
        .modifier(SandboxStatusBarBackdrop())
        .background(SandboxColor.background.ignoresSafeArea())
        .navigationTitle("Info")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(model.isOverApp() || isPushed ? .visible : .hidden, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
            }
            if model.isOverApp() && !isPushed {
                ToolbarItem(placement: .cancellationAction) {
                    Button { model.onClose() } label: { Label("Back to the app", systemImage: "xmark") }
                        .tint(SandboxColor.text)
                }
            }
        }
    }

    private static let codeRows: Set<String> = ["Fingerprint", "Built-in bundle", "Default channel", "Channel", "Current", "Pending"]

    private func group(_ title: String, _ rows: [HotUpdaterSandboxInfoModel.Row]) -> some View {
        SandboxSection(title: title) {
            SandboxCard {
                ForEach(Array(rows.enumerated()), id: \.element.name) { index, row in
                    if index > 0 { SandboxDivider(leading: false) }
                    infoRow(row)
                }
            }
        }
    }

    @ViewBuilder
    private func infoRow(_ row: HotUpdaterSandboxInfoModel.Row) -> some View {
        let value = Text(row.value.isEmpty ? "—" : row.value)
            .font(Self.codeRows.contains(row.name) ? SandboxFont.code : SandboxFont.body)
            .foregroundColor(SandboxColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
        let name = Text(row.name).font(SandboxFont.body).foregroundColor(SandboxColor.text)
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) { name; value }
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 12) {
                    name
                    Spacer(minLength: 12)
                    value
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
    }
}

@available(iOS 16.0, *)
private extension View {
    func resetDialog(_ which: HotUpdaterSandboxConfirm, model: HotUpdaterSandboxScreenModel) -> some View {
        confirmationDialog("Reset to built-in bundle?", isPresented: model.isConfirming(which), titleVisibility: .visible) {
            Button("Reset", role: .destructive) {
                SandboxHaptic.tap()
                model.coordinator.resetToBuiltIn()
            }
        } message: {
            Text(HotUpdaterSandboxHomeModel.resetNote)
        }
    }
}

@available(iOS 16.0, *)
private extension View {
    /// Where a page is scrolled to lives in the model from iOS 17, so a fold that
    /// lays the panes out again keeps it.
    @ViewBuilder
    func sandboxScrollTargets() -> some View {
        if #available(iOS 17.0, *) { scrollTargetLayout() } else { self }
    }

    @ViewBuilder
    func sandboxScrollPosition(_ anchor: Binding<String?>) -> some View {
        if #available(iOS 17.0, *) { scrollPosition(id: anchor, anchor: .top) } else { self }
    }
}

@available(iOS 16.0, *)
private struct HotUpdaterSandboxLicenseSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(HotUpdaterSandboxInfoModel.reflow(HotUpdaterSandboxFonts.license))
                    .font(SandboxFont.footnote)
                    .foregroundColor(SandboxColor.textSecondary)
                    .textSelection(.enabled)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(SandboxColor.surface.ignoresSafeArea())
            .navigationTitle("Geist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: { Label("Done", systemImage: "checkmark") }
                }
            }
        }
    }
}

/// With the navigation bar hidden, what scrolls under the status bar is blurred
/// the way a bar would blur it.
@available(iOS 16.0, *)
private struct SandboxStatusBarBackdrop: ViewModifier {
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            Color.clear.frame(height: 0).background(.bar, ignoresSafeAreaEdges: .top)
        }
    }
}

// MARK: - Header and scanner

@available(iOS 16.0, *)
private struct HotUpdaterSandboxHeader: View {
    @ScaledMetric(relativeTo: .title2) private var scaledIcon: CGFloat = 56
    @Environment(\.dynamicTypeSize) private var typeSize

    private var iconSize: CGFloat { min(scaledIcon, 80) }

    var body: some View {
        let app = HotUpdaterSandboxApp.current
        // At the accessibility sizes the name goes under the icon, with the whole width.
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(spacing: 16))
        let details = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 8))
        layout {
            Group {
                if let icon = app.icon {
                    Image(uiImage: icon).resizable()
                } else {
                    Text(String(app.name.prefix(1)).uppercased())
                        .font(SandboxFont.title)
                        .foregroundColor(SandboxColor.textSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(SandboxColor.fill)
                }
            }
            .frame(width: iconSize, height: iconSize)
            .clipShape(RoundedRectangle(cornerRadius: iconSize * 0.23, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: iconSize * 0.23, style: .continuous)
                    .strokeBorder(SandboxColor.separator, lineWidth: 0.5)
            )
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(app.name)
                    .font(SandboxFont.title)
                    .foregroundColor(SandboxColor.text)
                    .accessibilityAddTraits(.isHeader)
                details {
                    Text(app.version)
                        .font(SandboxFont.subhead)
                        .foregroundColor(SandboxColor.textSecondary)
                    SandboxBadge(text: "Sandbox")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
    }
}

@available(iOS 16.0, *)
private struct HotUpdaterSandboxScanSheet: View {
    let onLink: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
    /// Why the camera can't scan though access is allowed, such as a simulator's missing camera.
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.ignoresSafeArea())
                .navigationTitle("Scan QR code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarColorScheme(.dark, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: { Label("Cancel", systemImage: "xmark") }
                            .tint(.white)
                    }
                }
        }
        .preferredColorScheme(.dark)
        .onAppear(perform: askForAccess)
        // Access can change in Settings while the app is away: read it again on return.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            access = AVCaptureDevice.authorizationStatus(for: .video)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch HotUpdaterSandboxScannerContent(access: Self.access(access), problem: problem) {
        case .camera:
            viewfinder
        case let .message(text, opensSettings):
            message(text, opensSettings: opensSettings)
        case .waiting:
            Color.clear
        }
    }

    private static func access(_ status: AVAuthorizationStatus) -> HotUpdaterSandboxCameraAccess {
        switch status {
        case .authorized: return .allowed
        case .denied: return .denied
        case .restricted: return .restricted
        default: return .undetermined
        }
    }

    private var viewfinder: some View {
        ZStack {
            ScannerCamera(onLink: onLink) { text in
                DispatchQueue.main.async { problem = text }
            }
            .ignoresSafeArea()
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color.white.opacity(0.9), lineWidth: 3)
                .frame(width: 240, height: 240)
                .accessibilityHidden(true)
            VStack {
                Spacer()
                Text("Point the camera at a QR code.")
                    .font(SandboxFont.subhead)
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.55), in: Capsule())
                    .padding(24)
            }
        }
    }

    /// What stands in for the camera while it can't scan: no viewfinder, and no
    /// hint to aim it.
    private func message(_ text: String, opensSettings: Bool) -> some View {
        VStack(spacing: 20) {
            Text(text)
                .font(SandboxFont.body)
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if opensSettings, let settings = URL(string: UIApplication.openSettingsURLString) {
                Button("Open Settings") { openURL(settings) }
                    .buttonStyle(SandboxPrimaryButtonStyle())
            }
        }
        .padding(24)
        .frame(maxWidth: 400)
    }

    private func askForAccess() {
        guard access == .notDetermined else { return }
        AVCaptureDevice.requestAccess(for: .video) { _ in
            DispatchQueue.main.async { access = AVCaptureDevice.authorizationStatus(for: .video) }
        }
    }

    private struct ScannerCamera: UIViewControllerRepresentable {
        let onLink: (URL) -> Void
        let onUnavailable: (String) -> Void

        func makeUIViewController(context: Context) -> HotUpdaterSandboxScanner {
            HotUpdaterSandboxScanner(onLink: onLink, onUnavailable: onUnavailable)
        }

        func updateUIViewController(_ controller: HotUpdaterSandboxScanner, context: Context) {}
    }
}
#endif
