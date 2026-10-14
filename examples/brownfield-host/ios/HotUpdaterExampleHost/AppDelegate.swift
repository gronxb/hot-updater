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
      })
      self.window?.rootViewController = ReactNativeViewController(moduleName: "HotUpdaterExample")
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
