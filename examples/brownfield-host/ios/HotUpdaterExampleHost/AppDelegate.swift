import HotUpdaterExampleBrownfield
import UIKit

/// A native app that shows the example's React Native root on every launch,
/// as the E2E scenarios expect.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  private var reactNativeStarted = false
  /// A deep link that arrived while the native update check ran; React
  /// Native's Linking does not exist yet, so it becomes the launch URL.
  private var urlBeforeStart: URL?

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
        if let url = self.urlBeforeStart {
          options[.url] = url
        }
        return options
      })
      self.reactNativeStarted = true
      self.window?.rootViewController = ReactNativeViewController(moduleName: "HotUpdaterExample")
    }
    return true
  }

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard reactNativeStarted else {
      urlBeforeStart = url
      return true
    }
    return openReactNativeURL(app, url: url, options: options)
  }
}
