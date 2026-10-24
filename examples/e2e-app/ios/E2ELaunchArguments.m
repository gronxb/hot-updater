#import <React/RCTBridgeModule.h>

/// Exposes `-KEY value` process arguments, as `simctl launch` passes them, as
/// the constant `value`.
@interface E2ELaunchArguments : NSObject <RCTBridgeModule>
@end

@implementation E2ELaunchArguments

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  NSArray<NSString *> *arguments = [[NSProcessInfo processInfo] arguments];
  NSMutableDictionary<NSString *, NSString *> *values = [NSMutableDictionary dictionary];
  for (NSUInteger index = 1; index + 1 < arguments.count; index += 1) {
    NSString *key = arguments[index];
    NSString *value = arguments[index + 1];
    if ([key hasPrefix:@"-"] && ![key hasPrefix:@"--"] && ![value hasPrefix:@"-"]) {
      values[[key substringFromIndex:1]] = value;
      index += 1;
    }
  }
  return @{@"value": values};
}

@end
