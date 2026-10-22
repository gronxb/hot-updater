import React
import React_RCTAppDelegate
import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  /// The options of a scene that connected while the app was in the
  /// background, kept until it enters the foreground.
  private var pendingConnectionOptions: UIScene.ConnectionOptions?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    window = UIWindow(windowScene: windowScene)

    // E2E: a silent push launches the app in the background, and the system
    // connects its scene then too. Starting React Native here would render
    // the app in that launch, which the AppDelegate's headless root view
    // runs without UI, so the scene starts it once it enters the foreground.
    if UIApplication.shared.applicationState == .background {
      pendingConnectionOptions = connectionOptions
      return
    }
    startReactNative(connectionOptions)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    guard let connectionOptions = pendingConnectionOptions else { return }
    pendingConnectionOptions = nil
    startReactNative(connectionOptions)
  }

  private func startReactNative(_ connectionOptions: UIScene.ConnectionOptions) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    let reactNativeFactory = appDelegate.reactNativeFactory

    #if DEBUG
    let devMenuConfiguration = RCTDevMenuConfiguration(
      devMenuEnabled: true,
      shakeGestureEnabled: true,
      keyboardShortcutsEnabled: true
    )
    reactNativeFactory.devMenuConfiguration = devMenuConfiguration
    #endif

    reactNativeFactory.startReactNative(
      withModuleName: "HotUpdaterExample",
      in: window,
      initialProperties: ["isHeadless": false],
      connectionOptions: connectionOptions
    )
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    RCTLinkingManager.scene(scene, openURLContexts: URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.scene(scene, continue: userActivity)
  }
}
