#import <React/RCTBridgeModule.h>
#import <React/RCTBundleURLProvider.h>

@interface InternalCodePush : NSObject <RCTBridgeModule>

+ (void)setBundleURL:(NSURL *)url;
+ (NSURL *)bundleURL;

@end