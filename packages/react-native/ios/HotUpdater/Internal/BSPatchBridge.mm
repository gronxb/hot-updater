#import "BSPatchBridge.h"
#import "../../../cpp/bspatch/hotupdater_bspatch.h"

static NSString *const kBSPatchBridgeErrorDomain = @"HotUpdater.BSPatchBridge";

@implementation BSPatchBridge

+ (BOOL)applyPatchFrom:(NSString *)oldPath
             patchPath:(NSString *)patchPath
            outputPath:(NSString *)outputPath
                 error:(NSError * _Nullable * _Nullable)error {
    if (oldPath.length == 0 || patchPath.length == 0 || outputPath.length == 0) {
        if (error) {
            *error = [NSError errorWithDomain:kBSPatchBridgeErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey: @"Invalid bspatch path parameters"}];
        }
        return NO;
    }

    char errorBuffer[1024] = {0};
    int result = hotupdater_bspatch_file(
        oldPath.fileSystemRepresentation,
        patchPath.fileSystemRepresentation,
        outputPath.fileSystemRepresentation,
        errorBuffer,
        sizeof(errorBuffer)
    );

    if (result == 0) {
        return YES;
    }

    if (error) {
        NSString *message = errorBuffer[0] != '\0'
            ? [NSString stringWithUTF8String:errorBuffer]
            : @"Failed to apply bspatch";
        *error = [NSError errorWithDomain:kBSPatchBridgeErrorDomain
                                     code:2
                                 userInfo:@{NSLocalizedDescriptionKey: message}];
    }
    return NO;
}

@end
