#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT BOOL HotUpdaterLynxApplyBsdiffPatch(NSString *patchPath,
                                                  NSString *basePath,
                                                  NSString *outputPath,
                                                  uint64_t maximumOutputBytes);

@interface HotUpdaterLynxBsdiffPatchBridge : NSObject
+ (BOOL)applyPatchAtPath:(NSString *)patchPath
             toBaseAtPath:(NSString *)basePath
            outputAtPath:(NSString *)outputPath
          maximumOutputBytes:(uint64_t)maximumOutputBytes
                   error:(NSError * _Nullable * _Nullable)error;
@end

NS_ASSUME_NONNULL_END
