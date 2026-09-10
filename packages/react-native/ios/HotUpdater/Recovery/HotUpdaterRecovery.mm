#import "HotUpdaterRecovery.h"

static NSString *const failedRuntimeKey = @"HotUpdater.failedRuntime";
static NSString *const surfaceStartsKey = @"HotUpdater.surfaceStarts";

static BOOL isRuntimeThread(void)
{
  return [[NSThread currentThread].name isEqualToString:@"com.facebook.react.runtime.JavaScript"];
}

static NSMutableDictionary *pendingStarts(void)
{
  static NSMutableDictionary *starts;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{ starts = [NSMutableDictionary new]; });
  return starts;
}

BOOL HotUpdaterIsFailedRuntime(void)
{
  return [[[NSThread currentThread] threadDictionary][failedRuntimeKey] boolValue];
}

void HotUpdaterMarkFailedRuntime(void)
{
#ifdef RCT_NEW_ARCH_ENABLED
  // A bridgeless runtime owns this thread. Never mark shared native workers.
  if (isRuntimeThread()) {
    [NSThread currentThread].threadDictionary[failedRuntimeKey] = @YES;
  }
#endif
}

BOOL HotUpdaterBeginSurfaceStart(const void *surfaceHandler)
{
  if (HotUpdaterIsFailedRuntime()) {
    return NO;
  }
  if (!isRuntimeThread()) {
    return YES;
  }

  NSMutableDictionary *starts = pendingStarts();
  NSValue *key = [NSValue valueWithPointer:surfaceHandler];
  @synchronized (starts) {
    if (starts[key]) {
      return NO;
    }
    NSMutableDictionary *runtime = [NSThread currentThread].threadDictionary;
    dispatch_group_t group = runtime[surfaceStartsKey];
    if (!group) {
      group = dispatch_group_create();
      runtime[surfaceStartsKey] = group;
    }
    dispatch_group_enter(group);
    starts[key] = group;
  }
  return YES;
}

void HotUpdaterFinishSurfaceStart(const void *surfaceHandler)
{
  NSMutableDictionary *starts = pendingStarts();
  NSValue *key = [NSValue valueWithPointer:surfaceHandler];
  dispatch_group_t group;
  @synchronized (starts) {
    group = starts[key];
    [starts removeObjectForKey:key];
  }
  if (group) {
    dispatch_group_leave(group);
  }
}

void HotUpdaterAfterSurfaceStarts(dispatch_block_t action)
{
  dispatch_group_t group = [NSThread currentThread].threadDictionary[surfaceStartsKey];
  if (group) {
    dispatch_group_notify(group, dispatch_get_main_queue(), action);
  } else {
    dispatch_async(dispatch_get_main_queue(), action);
  }
}
