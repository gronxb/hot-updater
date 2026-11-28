#if HOT_UPDATER_SANDBOX_LAYER
#import <Foundation/Foundation.h>

// Holds the literal the CLI reads from a built app to tell a sandbox build:
// SANDBOX_CODE_MARKER in @hot-updater/protocol. An Objective-C literal, since
// Swift can store a short one outside __TEXT,__cstring, where the CLI reads.
@interface HotUpdaterSandboxMarker : NSObject
@end

@implementation HotUpdaterSandboxMarker

+ (NSString *)value {
  return @"HOT_UPDATER_SANDBOX_NATIVE_LAYER";
}

@end
#endif
