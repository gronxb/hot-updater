#import <React/RCTEventEmitter.h>
#import <React/RCTBundleURLProvider.h>

@class HotUpdaterCheckOptions;
@class HotUpdaterPrepareResult;
@class HotUpdaterUpdate;

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
 * This is implemented in HotUpdater.mm and calls the Swift static method.
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
 * Programmatic configuration for brownfield / XCFramework setups where
 * Info.plist (host) or string resources (Android) are not desirable.
 * A nil argument means no override.
 *
 * `channel` is the app's fixed default channel, not a runtime switch: keep it
 * the same from the first launch on. It is part of the storage isolation
 * key, so changing it deletes the downloaded bundles. To check another
 * channel at runtime, pass `channel` in `HotUpdaterCheckOptions`, and undo
 * that with `resetChannel`.
 */
+ (void)configureWithFingerprintHash:(nullable NSString *)fingerprintHash
                           publicKey:(nullable NSString *)publicKey
                             channel:(nullable NSString *)channel
                        isolationKey:(nullable NSString *)isolationKey;

NS_ASSUME_NONNULL_BEGIN

// Native update checks for apps that check and stage updates before React
// Native starts. Completions and progress run on the main queue: do not block
// the main thread waiting for them.

/**
 * Checks for an update without the JavaScript runtime, as JavaScript's
 * `checkForUpdate` does. Completes with nil when there is no update. Waits
 * for other native update work without a deadline; `prepare` is the bounded
 * call. Swift: `try await HotUpdater.checkForUpdate(options)`.
 */
+ (void)checkForUpdate:(HotUpdaterCheckOptions *)options
            completion:(void (^)(HotUpdaterUpdate * _Nullable_result update, NSError * _Nullable error))completion
    NS_SWIFT_NAME(checkForUpdate(_:completion:));

/**
 * Checks for an update and stages it before React Native starts. `timeout`
 * is one deadline, in seconds, for waiting on other native update work, the
 * catalog and artifact requests, and a required update's download; it must
 * be greater than 0. A required update staged before React Native reads the
 * bundle completes `ready`. When the deadline passes, or the update is not
 * required, the download continues and the call completes `pending`: the
 * update applies at the first start after it is staged, and a later `prepare`
 * or `updateBundle` joins it. Selecting the bundle this start already runs
 * completes `upToDate`. Never
 * fails with an exception: a failure completes `failed` with `error`.
 * Swift: `await HotUpdater.prepare(options, timeout: 3)`.
 */
+ (void)prepare:(HotUpdaterCheckOptions *)options
        timeout:(NSTimeInterval)timeout
     onProgress:(void (^ _Nullable)(double progress))onProgress
     completion:(void (^)(HotUpdaterPrepareResult *result))completion
    NS_SWIFT_NAME(__prepare(_:timeout:onProgress:completion:));

/**
 * Clears the runtime channel switch and returns to the default channel's
 * bundle at the next start, as JavaScript's `resetChannel` does.
 * Swift: `await HotUpdater.resetChannel()`.
 */
+ (void)resetChannelWithCompletion:(void (^)(BOOL success))completion
    NS_SWIFT_NAME(resetChannel(completion:));

NS_ASSUME_NONNULL_END

/**
 * 다운로드 진행 상황 업데이트 시간을 추적하는 속성
 */
@property (nonatomic, assign) NSTimeInterval lastUpdateTime;

// No need to declare the exported methods (reload, etc.) here
// as RCT_EXPORT_METHOD handles their exposure to JavaScript.
// We also don't need to declare supportedEvents or requiresMainQueueSetup here
// as they are implemented in the .mm file (calling Swift).

@end
