#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface BSPatchBridge : NSObject

+ (BOOL)applyPatchFrom:(NSString *)oldPath
             patchPath:(NSString *)patchPath
            outputPath:(NSString *)outputPath
                 error:(NSError * _Nullable * _Nullable)error;

@end

NS_ASSUME_NONNULL_END
