#import <React/RCTEventEmitter.h>
#import <React/RCTBundleURLProvider.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <HotUpdaterSpec/HotUpdaterSpec.h>
@interface HotUpdater : RCTEventEmitter <NativeHotUpdaterSpec>
#else
#import <React/RCTBridgeModule.h>
@interface HotUpdater : RCTEventEmitter <RCTBridgeModule>
#endif // RCT_NEW_ARCH_ENABLED

/**
 * Returns the currently active bundle URL from the default (static) instance.
 * Callable from Objective-C (e.g., AppDelegate).
 * This is implemented in HotUpdater.mm and calls the Swift static method.
 */
+ (NSURL *)bundleURL;

 /**
 * Returns the currently active bundle URL with specific bundle from the default (static) instance.
 * Callable from Objective-C (e.g., AppDelegate).
 * The bundle holds the embedded main.jsbundle, such as a brownfield XCFramework's
 * bundle. Hot Updater reuses it for reloads and reads its HOT_UPDATER_* Info.plist
 * keys before the main bundle's.
 */
+ (NSURL *)bundleURLWithBundle:(NSBundle *)bundle NS_SWIFT_NAME(bundleURL(bundle:));

/**
 * Returns the bundle URL for this specific instance.
 * @return The bundle URL for this instance
 */
- (NSURL *)bundleURL;

/**
 * Returns the bundle URL with specific bundle for this specific instance.
 * @return The bundle URL for this instance
 */
- (NSURL *)bundleURLWithBundle:(NSBundle *)bundle NS_SWIFT_NAME(bundleURL(bundle:));

/**
 * Deprecated: pass `channel`, `fingerprintHash`, and `publicKey` to the
 * `HotUpdaterOptions` of the `main` `HotUpdaterInstance` instead. Still
 * honored for main; named instances never read it.
 *
 * Programmatic configuration for brownfield / XCFramework setups where
 * Info.plist (host) or string resources (Android) are not desirable.
 * A nil argument means no override. Each call replaces all four values.
 *
 * `channel` is the app's fixed default channel, not a runtime switch: keep it
 * the same from the first launch on. It is part of the storage isolation
 * key, so changing it deletes the downloaded bundles. To check another
 * channel at runtime, pass `channel` to `HotUpdaterInstance.checkForUpdate`,
 * and undo that with its `resetChannel`.
 *
 * `isolationKey`, when set, replaces main's storage isolation key verbatim.
 * It is no longer needed: under the fingerprint strategy the default key is
 * the fingerprint, the build's MIN_BUNDLE_ID, and the channel, so a native
 * release that ships the same artifact keeps its downloads.
 */
+ (void)configureWithFingerprintHash:(nullable NSString *)fingerprintHash
                           publicKey:(nullable NSString *)publicKey
                             channel:(nullable NSString *)channel
                        isolationKey:(nullable NSString *)isolationKey
    DEPRECATED_MSG_ATTRIBUTE("Pass channel, fingerprintHash, and publicKey to HotUpdaterOptions. Fingerprint downloads now survive native releases that ship the same artifact.");

/**
 * 다운로드 진행 상황 업데이트 시간을 추적하는 속성
 */
@property (nonatomic, assign) NSTimeInterval lastUpdateTime;

// No need to declare the exported methods (reload, etc.) here
// as RCT_EXPORT_METHOD handles their exposure to JavaScript.
// We also don't need to declare supportedEvents or requiresMainQueueSetup here
// as they are implemented in the .mm file (calling Swift).

@end
