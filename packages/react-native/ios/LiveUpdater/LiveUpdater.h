#import <React/RCTBridgeModule.h>
#import <React/RCTBundleURLProvider.h>

@interface LiveUpdater : NSObject <RCTBridgeModule>

+ (void)setBundleURL:(NSURL *)url;
+ (NSURL *)bundleURL;

@end