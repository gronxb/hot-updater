#import <React/RCTBridgeModule.h>

#import <React/RCTBundleURLProvider.h>
#import <React/RCTReloadCommand.h>

@interface HotUpdater : NSObject <RCTBridgeModule>

+ (NSURL *)bundleURL;
+ (NSURL *)bundleURLWithoutFallback;

@end
