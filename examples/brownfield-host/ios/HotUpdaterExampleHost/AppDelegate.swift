import HotUpdaterExampleBrownfield
import UIKit

/// A native app that shows the example's React Native root on every launch,
/// as the E2E scenarios expect.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  private var reactNativeStarted = false
  /// Deep links that arrived while the native update check ran, before React
  /// Native's Linking exists: the first becomes the launch URL, and the rest
  /// open once React Native has started.
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
      })
      self.reactNativeStarted = true
      self.window?.rootViewController = ReactNativeViewController(moduleName: "HotUpdaterExample")
      let laterURLs = self.urlsBeforeStart
      self.urlsBeforeStart = []
      for url in laterURLs {
        _ = openReactNativeURL(application, url: url, options: [:])
      }
    }
    return true
  }

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard reactNativeStarted else {
      urlsBeforeStart.append(url)
      return true
    }
    return openReactNativeURL(app, url: url, options: options)
  }
}
