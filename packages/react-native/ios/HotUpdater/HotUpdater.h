#import <React/RCTBundleURLProvider.h>
#import <React/RCTReloadCommand.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import "HotUpdaterSpec.h"
@interface HotUpdater : NSObject <NativeHotUpdaterSpec>
#else
#import <React/RCTBridgeModule.h>


@interface HotUpdater : NSObject <RCTBridgeModule>
#endif

+ (NSURL *)bundleURL;

@end
