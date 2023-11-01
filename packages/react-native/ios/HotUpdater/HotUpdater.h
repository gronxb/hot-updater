#import <React/RCTBridgeModule.h>
#import <React/RCTBundleURLProvider.h>

@interface HotUpdater : NSObject <RCTBridgeModule>

+ (NSURL *)bundleURL;
+ (NSURL *)bundleURLWithoutFallback;

@end