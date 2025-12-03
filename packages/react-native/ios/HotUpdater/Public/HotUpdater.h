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
 * Initializes a HotUpdater instance with a custom identifier for isolated storage.
 * Use this for brownfield apps that need multiple React Native instances.
 * @param identifier Custom identifier for storage isolation (nil for default behavior)
 * @return Initialized HotUpdater instance
 */
- (instancetype)initWithIdentifier:(NSString *)identifier NS_DESIGNATED_INITIALIZER;

/**
 * Returns the bundle URL for this specific instance.
 * @return The bundle URL for this instance
 */
- (NSURL *)bundleURL;

/**
 * 다운로드 진행 상황 업데이트 시간을 추적하는 속성
 */
@property (nonatomic, assign) NSTimeInterval lastUpdateTime;

// No need to declare the exported methods (reload, etc.) here
// as RCT_EXPORT_METHOD handles their exposure to JavaScript.
// We also don't need to declare supportedEvents or requiresMainQueueSetup here
// as they are implemented in the .mm file (calling Swift).

@end
