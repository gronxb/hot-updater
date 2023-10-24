#import <React/RCTBridgeModule.h>

@interface InternalCodePush : NSObject <RCTBridgeModule>

+ (void)setBundleURL:(NSURL *)url;
+ (NSURL *)bundleURL;

@end