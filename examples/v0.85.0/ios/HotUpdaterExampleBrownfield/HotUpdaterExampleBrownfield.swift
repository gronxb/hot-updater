import Foundation
import UIKit

// The brownfield E2E host imports only this framework, as the brownfield
// guide describes: Hot Updater and React stay internal.
@_exported import ReactBrownfield
internal import HotUpdater
internal import React

/// The framework's bundle: its `main.jsbundle` and `HOT_UPDATER_*` keys.
public let ReactNativeBundle = Bundle(for: InternalClassForBundle.self)

class InternalClassForBundle {}

/// Starts React Native with Hot Updater choosing the JavaScript bundle.
@MainActor
public func startReactNativeWithHotUpdater(
  launchOptions: [UIApplication.LaunchOptionsKey: Any]?
) {
  ReactNativeBrownfield.shared.bundle = ReactNativeBundle
  ReactNativeBrownfield.shared.bundleURLOverride = {
    HotUpdater.bundleURL(bundle: ReactNativeBundle)
  }
  ReactNativeBrownfield.shared.startReactNative(
    launchOptions: launchOptions.map { options in
      Dictionary(uniqueKeysWithValues: options.map { (AnyHashable($0.key), $0.value) })
    },
    preloadBundle: false,
    onBundleLoaded: nil
  )
}

/// Hands a deep link to React Native's `Linking`.
@MainActor
public func openReactNativeURL(
  _ application: UIApplication,
  url: URL,
  options: [UIApplication.OpenURLOptionsKey: Any]
) -> Bool {
  RCTLinkingManager.application(application, open: url, options: options)
}
