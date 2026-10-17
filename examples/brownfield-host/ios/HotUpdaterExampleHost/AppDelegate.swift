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
    startReactNativeWithHotUpdater(launchOptions: launchOptions)

    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = ReactNativeViewController(moduleName: "HotUpdaterExample")
    window?.makeKeyAndVisible()
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
