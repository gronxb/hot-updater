#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT BOOL HotUpdaterApplyBsdiffPatch(NSString *patchPath,
                                                  NSString *basePath,
                                                  NSString *outputPath);

@interface BsdiffPatchBridge : NSObject
+ (BOOL)applyPatchAtPath:(NSString *)patchPath
             toBaseAtPath:(NSString *)basePath
            outputAtPath:(NSString *)outputPath
                   error:(NSError * _Nullable * _Nullable)error;
@end

NS_ASSUME_NONNULL_END
