#import <React/RCTEventEmitter.h>
#import <React/RCTBundleURLProvider.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import "HotUpdaterSpec.h"
@interface HotUpdater : RCTEventEmitter <NativeHotUpdaterSpec>
#else
#import <React/RCTBridgeModule.h>
@interface HotUpdater : RCTEventEmitter <RCTBridgeModule>
#endif // RCT_NEW_ARCH_ENABLED

@property (nonatomic, assign) NSTimeInterval lastUpdateTime;
+ (NSURL *)bundleURL;

@end
