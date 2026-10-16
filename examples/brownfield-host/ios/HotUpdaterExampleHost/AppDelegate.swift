import HotUpdaterExampleBrownfield
import UIKit

/// A native app that shows the example's React Native root on every launch,
/// as the E2E scenarios expect.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  /// Whether the JavaScript bundle has loaded, so Linking can receive URLs.
  private var bundleLoaded = false
  /// Deep links that arrived before the JavaScript bundle loaded, when React
  /// Native's Linking cannot receive them: the first becomes the launch URL
  /// when React Native starts, and the rest open once the bundle has loaded.
  private var urlsBeforeStart: [URL] = []

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    let launchScreen = UIViewController()
    launchScreen.view.backgroundColor = .systemBackground
    window?.rootViewController = launchScreen
    window?.makeKeyAndVisible()

    Task { @MainActor in
      // E2E: a scenario can turn on a second Hot Updater instance, `widget`,
      // shown in a strip under the example. Every other scenario runs the
      // example alone, as before.
      let example = ReactNativeViewController(moduleName: "HotUpdaterExample")
      let widgetHost = isHotUpdaterWidgetEnabled ? WidgetHostViewController(example: example) : nil
      await startReactNativeWithHotUpdater(launchOptions: {
        var options = launchOptions ?? [:]
        if options[.url] == nil, !self.urlsBeforeStart.isEmpty {
          options[.url] = self.urlsBeforeStart.removeFirst()
        }
        return options
      }, onBundleLoaded: {
        self.bundleLoaded = true
        let laterURLs = self.urlsBeforeStart
        self.urlsBeforeStart = []
        for url in laterURLs {
          _ = openReactNativeURL(application, url: url, options: [:])
        }
        // The widget's runtime starts after the example's bundle has loaded,
        // once its own native update check is done.
        if let widgetHost {
          Task { @MainActor in
            widgetHost.showWidget(await makeHotUpdaterWidgetView())
          }
        }
      })
      self.window?.rootViewController = widgetHost ?? example
    }
    return true
  }

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard bundleLoaded else {
      urlsBeforeStart.append(url)
      return true
    }
    return openReactNativeURL(app, url: url, options: options)
  }
}

/// The example on top and the widget instance's React Native root in a
/// fixed-height strip under it, both in one screen.
final class WidgetHostViewController: UIViewController {
  private static let widgetHeight: CGFloat = 132
  private let example: UIViewController
  private let widgetContainer = UIView()

  init(example: UIViewController) {
    self.example = example
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    addChild(example)
    example.view.translatesAutoresizingMaskIntoConstraints = false
    widgetContainer.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(example.view)
    view.addSubview(widgetContainer)
    NSLayoutConstraint.activate([
      example.view.topAnchor.constraint(equalTo: view.topAnchor),
      example.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      example.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      example.view.bottomAnchor.constraint(equalTo: widgetContainer.topAnchor),
      widgetContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      widgetContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      widgetContainer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      widgetContainer.heightAnchor.constraint(equalToConstant: Self.widgetHeight),
    ])
    example.didMove(toParent: self)
  }

  func showWidget(_ widget: UIView?) {
    guard let widget, widget.superview == nil else { return }
    loadViewIfNeeded()
    widget.translatesAutoresizingMaskIntoConstraints = false
    widgetContainer.addSubview(widget)
    NSLayoutConstraint.activate([
      widget.topAnchor.constraint(equalTo: widgetContainer.topAnchor),
      widget.leadingAnchor.constraint(equalTo: widgetContainer.leadingAnchor),
      widget.trailingAnchor.constraint(equalTo: widgetContainer.trailingAnchor),
      widget.bottomAnchor.constraint(equalTo: widgetContainer.bottomAnchor),
    ])
  }
}
