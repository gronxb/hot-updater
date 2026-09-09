#import <Foundation/Foundation.h>

#ifdef __cplusplus
extern "C" {
#endif

void HotUpdaterMarkFailedRuntime(void);
BOOL HotUpdaterIsFailedRuntime(void);
void HotUpdaterInstallRecoveryHooks(void);
BOOL HotUpdaterBeginSurfaceStart(const void *surfaceHandler);
void HotUpdaterFinishSurfaceStart(const void *surfaceHandler);
void HotUpdaterAfterSurfaceStarts(dispatch_block_t action);

#ifdef __cplusplus
}
#endif
