#import <React/RCTEventEmitter.h>
#import <React/RCTBundleURLProvider.h>

#ifdef RCT_NEW_ARCH_ENABLED == 1
#import "HotUpdaterSpec.h"
@interface HotUpdater : RCTEventEmitter <NativeHotUpdaterSpec>
#else
#import <React/RCTBridgeModule.h>
@interface HotUpdater : RCTEventEmitter <RCTBridgeModule>
#endif // RCT_NEW_ARCH_ENABLED

+ (NSURL *)bundleURL;

@end
