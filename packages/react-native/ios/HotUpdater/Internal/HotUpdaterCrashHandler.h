#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HotUpdaterCrashHandler : NSObject

+ (void)install;
+ (void)markLaunchCompleted;
+ (void)resetLaunchCompletion;

@end

NS_ASSUME_NONNULL_END
