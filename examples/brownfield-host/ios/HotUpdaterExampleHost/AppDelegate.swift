import HotUpdaterExampleBrownfield
import UIKit

/// A native app that shows the example's React Native root on every launch,
/// as the E2E scenarios expect.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

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
      await startReactNativeWithHotUpdater(launchOptions: launchOptions)
      self.window?.rootViewController = ReactNativeViewController(moduleName: "HotUpdaterExample")
    }
    return true
  }

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    openReactNativeURL(app, url: url, options: options)
  }
}
