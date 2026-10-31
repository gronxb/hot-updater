#import "HotUpdater.h"
#import <React/RCTExceptionsManager.h>
#import <React/RCTInitializing.h>
#import <React/RCTReloadCommand.h>
#import <React/RCTLog.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <React/RCTFabricSurface.h>
#import <React/RCTSurfacePresenter.h>
#else
#import <React/RCTBridge+Private.h>
#import <React/RCTModuleData.h>
#endif

#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <unistd.h>

#if defined(SWIFT_PACKAGE)
// Swift Package Manager: the Swift classes, through the protocols they conform
// to (see HotUpdaterInterface.h).
#import "HotUpdaterInterface.h"
typedef NSObject<HotUpdaterImplInterface> HotUpdaterImpl;
typedef NSObject<HotUpdaterConfigInterface> HotUpdaterConfig;
#else
#if __has_include("HotUpdater/HotUpdater-Swift.h")
#import "HotUpdater/HotUpdater-Swift.h"
#else
#import "HotUpdater-Swift.h"
#endif

// The process's impl, which HotUpdaterInstance uses too.
static HotUpdaterImpl *HotUpdaterMakeImpl(void)
{
  return [HotUpdaterNativeUpdateBridge sharedImpl];
}

static NSString *HotUpdaterAppVersion(void)
{
  return [HotUpdaterImpl appVersion];
}

static HotUpdaterConfig *HotUpdaterSharedConfig(void)
{
  return [HotUpdaterConfig shared];
}

// The class methods share the selectors of HotUpdaterNativeUpdatesInterface.
static Class HotUpdaterNativeUpdates(void)
{
  return [HotUpdaterNativeUpdateBridge class];
}
#endif

@interface HotUpdater (InternalSharedImpl)
+ (HotUpdaterImpl *)sharedImpl;
@end

extern "C" NSString *HotUpdaterBuildMinBundleId(void);
extern "C" NSString *HotUpdaterBuildFingerprintHash(void);

namespace {
constexpr size_t kHotUpdaterMaxBundleIdLength = 128;
const int kHotUpdaterSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};

// One slot per instance whose launch a native crash may count against, slot 0
// being main's (HotUpdaterRecoveryCoordinator in Swift assigns them and keeps
// the rule below in step). A slot's marker path is set once and never moves.
// An instance beyond the last slot gets no marker from a native crash; its
// unfinished launch still rolls back through launchInProgress.
constexpr int kHotUpdaterCrashSlotCount = 8;
// Every slot whose launch is unverified writes its marker.
constexpr sig_atomic_t kHotUpdaterUnattributedCrash = -1;

struct HotUpdaterCrashSlotData {
  // Empty while the slot is free.
  char markerPath[PATH_MAX];
  char bundleId[kHotUpdaterMaxBundleIdLength];
  // The launch started and its first content hasn't appeared.
  int shouldRollback;
};

// A sequence lock: a crash on any thread may read a slot while another thread
// rewrites it. The writer makes the sequence odd while it copies, and the
// handler keeps a copy only when the sequence was even and unchanged across
// it.
// The published copy of HotUpdaterCrashSlotData. Every field is atomic,
// copied with relaxed loads and stores, so a reader racing a writer reads
// defined (if mixed) values, which the sequence then rejects.
struct HotUpdaterAtomicCrashSlotData {
  std::atomic<char> markerPath[PATH_MAX];
  std::atomic<char> bundleId[kHotUpdaterMaxBundleIdLength];
  std::atomic<int> shouldRollback;
};

struct HotUpdaterCrashSlotBuffer {
  std::atomic<uint32_t> sequence;
  HotUpdaterAtomicCrashSlotData data;
};

// Two buffers per slot: the writer fills the one not published, then
// publishes it. A crash during a rewrite, even on the writer's own thread,
// still reads the previous whole copy.
// `published`: bit 0 is the published buffer, bit 1 says anything was
// published at all (a freshly started slot has neither).
constexpr uint32_t kPublishedIndexMask = 1U;
constexpr uint32_t kPublishedOnceFlag = 2U;

struct HotUpdaterCrashSlot {
  std::atomic<uint32_t> published;
  HotUpdaterCrashSlotBuffer buffers[2];
};
// C++11, as old React Native builds compile it: the handler needs a
// lock-free sequence.
static_assert(ATOMIC_INT_LOCK_FREE == 2 && sizeof(uint32_t) == sizeof(int), "the crash handler needs a lock-free sequence");
static_assert(ATOMIC_CHAR_LOCK_FREE == 2, "the crash handler needs lock-free slot bytes");


// Zero-initialized: static storage. Every slot starts free.
HotUpdaterCrashSlot gHotUpdaterCrashSlots[kHotUpdaterCrashSlotCount];
// The sequence lock takes one writer at a time; every rewrite of a slot holds
// this lock. Never taken by the signal handler.
std::mutex gHotUpdaterCrashSlotWriters;
// A JavaScript fatal about to crash the process is one instance's: only its
// slot writes (none when it has no slot). Otherwise kHotUpdaterUnattributedCrash.
// Lock-free (the static_assert above), so the handler on any thread reads a
// whole value published by another.
std::atomic<int> gHotUpdaterAttributedSlot(kHotUpdaterUnattributedCrash);
struct sigaction gHotUpdaterPreviousActions[NSIG];
__weak RCTBridge *gHotUpdaterBridge = nil;

void HotUpdaterTriggerReloadCommand(RCTBridge *bridge, NSString *reason)
{
#ifdef RCT_NEW_ARCH_ENABLED
  RCTTriggerReloadCommandListeners(reason);
#else
  // RCTBridge starts the next old-architecture bridge before its asynchronous
  // module invalidation finishes. Wait for this exact child bridge first.
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!bridge || !bridge.valid) {
      RCTTriggerReloadCommandListeners(reason);
      return;
    }

    __block id observer = nil;
    observer = [[NSNotificationCenter defaultCenter]
        addObserverForName:RCTBridgeDidInvalidateModulesNotification
                    object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *notification) {
                  RCTBridge *invalidatedBridge = notification.userInfo[@"bridge"];
                  if (notification.object != bridge && invalidatedBridge != bridge) {
                    return;
                  }
                  [[NSNotificationCenter defaultCenter] removeObserver:observer];
                  observer = nil;
                  RCTTriggerReloadCommandListeners(reason);
                }];

    [bridge invalidate];
  });
#endif
}

size_t HotUpdaterSafeStringLength(const char *value, size_t maxLength)
{
  size_t length = 0;
  while (length < maxLength && value[length] != '\0') {
    ++length;
  }
  return length;
}

void HotUpdaterSafeCopy(char *destination, size_t destinationSize, const char *source)
{
  if (destinationSize == 0) {
    return;
  }

  size_t index = 0;
  while (index + 1 < destinationSize && source[index] != '\0') {
    destination[index] = source[index];
    ++index;
  }
  destination[index] = '\0';
}

void HotUpdaterStoreBytes(std::atomic<char> *destination, const char *source, size_t size)
{
  for (size_t index = 0; index < size; ++index) {
    destination[index].store(source[index], std::memory_order_relaxed);
  }
}

void HotUpdaterLoadBytes(const std::atomic<char> *source, char *destination, size_t size)
{
  for (size_t index = 0; index < size; ++index) {
    destination[index] = source[index].load(std::memory_order_relaxed);
  }
}

// The strings first, the flag last with release: a reader that loads the flag
// with acquire and finds it asking for rollback sees the whole strings, even
// when it interrupts this copy (see HotUpdaterReadFirstCrashSlotWrite).
void HotUpdaterStoreCrashSlotData(HotUpdaterAtomicCrashSlotData &destination, const HotUpdaterCrashSlotData &source)
{
  HotUpdaterStoreBytes(destination.markerPath, source.markerPath, sizeof(source.markerPath));
  HotUpdaterStoreBytes(destination.bundleId, source.bundleId, sizeof(source.bundleId));
  destination.shouldRollback.store(source.shouldRollback, std::memory_order_release);
}

void HotUpdaterLoadCrashSlotData(const HotUpdaterAtomicCrashSlotData &source, HotUpdaterCrashSlotData &destination)
{
  HotUpdaterLoadBytes(source.markerPath, destination.markerPath, sizeof(destination.markerPath));
  HotUpdaterLoadBytes(source.bundleId, destination.bundleId, sizeof(destination.bundleId));
  destination.shouldRollback = source.shouldRollback.load(std::memory_order_relaxed);
  // A copy taken mid-rewrite is rejected by the sequence, but the strings must
  // still end inside their buffers.
  destination.markerPath[sizeof(destination.markerPath) - 1] = '\0';
  destination.bundleId[sizeof(destination.bundleId) - 1] = '\0';
}

constexpr int kHotUpdaterKeepShouldRollback = -1;

// Rewrites a slot; a null path or bundle id, or kHotUpdaterKeepShouldRollback,
// keeps the current value. The new fields are prepared first, so the window a
// crash skips stays one copy long.
void HotUpdaterRewriteCrashSlot(HotUpdaterCrashSlot &slot,
                                const char *markerPath,
                                const char *bundleId,
                                int shouldRollback)
{
  std::lock_guard<std::mutex> writer(gHotUpdaterCrashSlotWriters);
  const uint32_t state = slot.published.load(std::memory_order_relaxed);
  const uint32_t current = state & kPublishedIndexMask;
  HotUpdaterCrashSlotData published;
  // The writers are serialized, so the published buffer is stable here.
  HotUpdaterLoadCrashSlotData(slot.buffers[current].data, published);
  HotUpdaterCrashSlotData next = published;
  if (markerPath) {
    HotUpdaterSafeCopy(next.markerPath, sizeof(next.markerPath), markerPath);
  }
  if (bundleId) {
    HotUpdaterSafeCopy(next.bundleId, sizeof(next.bundleId), bundleId);
  }
  if (shouldRollback != kHotUpdaterKeepShouldRollback) {
    next.shouldRollback = shouldRollback != 0 ? 1 : 0;
  }

  if ((state & kPublishedOnceFlag) != 0 && std::strcmp(published.markerPath, next.markerPath) == 0 &&
      std::strcmp(published.bundleId, next.bundleId) == 0) {
    // Same marker and bundle, only the flag changes (a launch charged or
    // verified): flip it in the published buffer with one atomic store, so
    // no crash ever falls inside a copy and reads the old flag.
    slot.buffers[current].data.shouldRollback.store(next.shouldRollback, std::memory_order_release);
    return;
  }

  HotUpdaterCrashSlotBuffer &buffer = slot.buffers[current ^ 1U];
  const uint32_t sequence = buffer.sequence.load(std::memory_order_relaxed);
  buffer.sequence.store(sequence + 1, std::memory_order_relaxed);
  std::atomic_thread_fence(std::memory_order_release);
  HotUpdaterStoreCrashSlotData(buffer.data, next);
  buffer.sequence.store(sequence + 2, std::memory_order_release);
  slot.published.store((current ^ 1U) | kPublishedOnceFlag, std::memory_order_release);
}

// Copies a consistent snapshot of the slot, or returns false while it is
// being rewritten.
bool HotUpdaterReadCrashSlotBuffer(const HotUpdaterCrashSlotBuffer &buffer, HotUpdaterCrashSlotData &snapshot)
{
  const uint32_t before = buffer.sequence.load(std::memory_order_acquire);
  if ((before & 1U) != 0) {
    return false;
  }
  HotUpdaterLoadCrashSlotData(buffer.data, snapshot);
  std::atomic_thread_fence(std::memory_order_acquire);
  return buffer.sequence.load(std::memory_order_relaxed) == before;
}

// The slot's first write, before anything was published, into the buffer
// that was all zero: whole, or interrupted (a crash on the writer's own
// thread, or another thread's crash) once its flag asks for rollback, since
// the strings were stored before it. Nothing to write from otherwise.
bool HotUpdaterReadFirstCrashSlotWrite(const HotUpdaterCrashSlotBuffer &buffer, HotUpdaterCrashSlotData &snapshot)
{
  if (HotUpdaterReadCrashSlotBuffer(buffer, snapshot)) {
    return snapshot.markerPath[0] != '\0';
  }
  const int shouldRollback = buffer.data.shouldRollback.load(std::memory_order_acquire);
  if (shouldRollback == 0) {
    // Not asking for rollback yet: a marker would change nothing.
    return false;
  }
  HotUpdaterLoadBytes(buffer.data.markerPath, snapshot.markerPath, sizeof(snapshot.markerPath));
  HotUpdaterLoadBytes(buffer.data.bundleId, snapshot.bundleId, sizeof(snapshot.bundleId));
  snapshot.markerPath[sizeof(snapshot.markerPath) - 1] = '\0';
  snapshot.bundleId[sizeof(snapshot.bundleId) - 1] = '\0';
  snapshot.shouldRollback = shouldRollback;
  return snapshot.markerPath[0] != '\0';
}

// A snapshot to write the slot's marker from, or false when there is none.
// Before anything was published, only the first write is read, never the
// unwritten published buffer. After, only the published buffer, retried while
// it is rewritten.
bool HotUpdaterReadCrashSlot(const HotUpdaterCrashSlot &slot, HotUpdaterCrashSlotData &snapshot)
{
  for (int attempt = 0; attempt < 4; ++attempt) {
    const uint32_t state = slot.published.load(std::memory_order_acquire);
    const uint32_t published = state & kPublishedIndexMask;
    if ((state & kPublishedOnceFlag) == 0) {
      return HotUpdaterReadFirstCrashSlotWrite(slot.buffers[published ^ 1U], snapshot);
    }
    if (HotUpdaterReadCrashSlotBuffer(slot.buffers[published], snapshot)) {
      return true;
    }
  }
  return false;
}

void HotUpdaterWriteCrashMarker(const HotUpdaterCrashSlotData &slot)
{
  if (slot.markerPath[0] == '\0') {
    return;
  }

  int fd = open(slot.markerPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    return;
  }

  constexpr char prefix[] = "{\"bundleId\":\"";
  constexpr char middle[] = "\",\"shouldRollback\":";
  constexpr char trueLiteral[] = "true";
  constexpr char falseLiteral[] = "false";
  constexpr char suffix[] = "}\n";

  write(fd, prefix, sizeof(prefix) - 1);
  if (slot.bundleId[0] != '\0') {
    write(fd, slot.bundleId, HotUpdaterSafeStringLength(slot.bundleId, kHotUpdaterMaxBundleIdLength));
  }
  write(fd, middle, sizeof(middle) - 1);
  if (slot.shouldRollback != 0) {
    write(fd, trueLiteral, sizeof(trueLiteral) - 1);
  } else {
    write(fd, falseLiteral, sizeof(falseLiteral) - 1);
  }
  write(fd, suffix, sizeof(suffix) - 1);
  close(fd);
}

// Main's slot (0) writes once main launched, as it always has, with
// `shouldRollback: false` after its first content. A named slot writes only
// while its launch is unverified (started, first content not yet shown). While
// a JavaScript fatal of one instance takes the process down, only its slot
// writes.
void HotUpdaterWriteCrashMarkers()
{
  const int attributedSlot = gHotUpdaterAttributedSlot.load(std::memory_order_acquire);
  for (int index = 0; index < kHotUpdaterCrashSlotCount; ++index) {
    if (attributedSlot != kHotUpdaterUnattributedCrash && attributedSlot != index) {
      continue;
    }
    HotUpdaterCrashSlotData slot;
    if (!HotUpdaterReadCrashSlot(gHotUpdaterCrashSlots[index], slot) || slot.markerPath[0] == '\0') {
      continue;
    }
    if (index == 0 || slot.shouldRollback != 0) {
      HotUpdaterWriteCrashMarker(slot);
    }
  }
}

void HotUpdaterSignalHandler(int signum, siginfo_t *info, void *context);

void HotUpdaterForwardToPreviousHandler(int signum, siginfo_t *info, void *context)
{
  const struct sigaction &previousAction = gHotUpdaterPreviousActions[signum];

  if ((previousAction.sa_flags & SA_SIGINFO) != 0 && previousAction.sa_sigaction != nullptr &&
      previousAction.sa_sigaction != HotUpdaterSignalHandler) {
    previousAction.sa_sigaction(signum, info, context);
    return;
  }

  if (previousAction.sa_handler == SIG_IGN) {
    return;
  }

  if (previousAction.sa_handler != nullptr && previousAction.sa_handler != SIG_DFL &&
      previousAction.sa_handler != SIG_ERR) {
    previousAction.sa_handler(signum);
    return;
  }

  struct sigaction defaultAction {};
  defaultAction.sa_handler = SIG_DFL;
  sigemptyset(&defaultAction.sa_mask);
  sigaction(signum, &defaultAction, nullptr);
  raise(signum);
}

void HotUpdaterSignalHandler(int signum, siginfo_t *info, void *context)
{
  HotUpdaterWriteCrashMarkers();
  HotUpdaterForwardToPreviousHandler(signum, info, context);
}
} // namespace

// Once per process. Called on the main thread.
extern "C" void HotUpdaterInstallCrashSignalHandlers(void)
{
  // Once per process, whichever instance asks first: a second sigaction
  // would record this handler as its own previous action and recurse.
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{

    struct sigaction action {};
    action.sa_sigaction = HotUpdaterSignalHandler;
    action.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigemptyset(&action.sa_mask);

    for (int signum : kHotUpdaterSignals) {
      sigaction(signum, &action, &gHotUpdaterPreviousActions[signum]);
    }
  });
}

extern "C" void HotUpdaterUpdateCrashSlot(NSInteger index,
                                          NSString *crashMarkerPath,
                                          NSString * _Nullable bundleId,
                                          BOOL shouldRollback)
{
  if (index < 0 || index >= kHotUpdaterCrashSlotCount) {
    return;
  }
  HotUpdaterRewriteCrashSlot(gHotUpdaterCrashSlots[index],
                             crashMarkerPath.UTF8String ?: "",
                             bundleId.UTF8String ?: "",
                             shouldRollback ? 1 : 0);
}

// kHotUpdaterUnattributedCrash, a slot index, or any other negative value for
// an instance without a slot (then a native crash writes no marker).
extern "C" void HotUpdaterAttributeCrashToSlot(NSInteger index)
{
  gHotUpdaterAttributedSlot.store(static_cast<int>(index), std::memory_order_release);
}

// Legacy entry points of the single main slot.
extern "C" void HotUpdaterInstallSignalHandlers(NSString *crashMarkerPath)
{
  HotUpdaterRewriteCrashSlot(gHotUpdaterCrashSlots[0],
                             crashMarkerPath.UTF8String ?: "",
                             nullptr,
                             kHotUpdaterKeepShouldRollback);
  HotUpdaterInstallCrashSignalHandlers();
}

extern "C" void HotUpdaterUpdateSignalLaunchState(NSString * _Nullable bundleId, BOOL shouldRollback)
{
  HotUpdaterRewriteCrashSlot(gHotUpdaterCrashSlots[0], nullptr, bundleId.UTF8String ?: "", shouldRollback ? 1 : 0);
}

extern "C" BOOL HotUpdaterPerformRecoveryReload(void)
{
  __block BOOL didTriggerReload = NO;

  void (^reloadBlock)(void) = ^{
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl resetLaunchPreparation];

    NSURL *bundleURL = [impl bundleURLWithBundle:HotUpdaterSharedConfig().bundle];
    if (!bundleURL) {
      RCTLogWarn(@"[HotUpdater.mm] Failed to resolve bundle URL for recovery reload");
      return;
    }

    RCTReloadCommandSetBundleURL(bundleURL);
    RCTBridge *bridge = gHotUpdaterBridge;
    if (bridge) {
      [bridge setValue:bundleURL forKey:@"bundleURL"];
    }
    HotUpdaterTriggerReloadCommand(bridge, @"HotUpdater recovery reload");
    didTriggerReload = YES;
  };

  if ([NSThread isMainThread]) {
    reloadBlock();
  } else {
    dispatch_sync(dispatch_get_main_queue(), reloadBlock);
  }

  return didTriggerReload;
}

extern "C" NSString *HotUpdaterGetMinBundleId(void)
{
#if DEBUG
  return @"00000000-0000-0000-0000-000000000000";
#else
  return HotUpdaterBuildMinBundleId();
#endif
}

extern "C" void *HotUpdaterCopyMinBundleId(void)
{
  return (__bridge_retained void *)HotUpdaterGetMinBundleId();
}

// The fingerprint the build embedded, or NULL for an app without one.
extern "C" void *HotUpdaterCopyBuildFingerprintHash(void)
{
  NSString *fingerprintHash = HotUpdaterBuildFingerprintHash();
  return fingerprintHash.length > 0
      ? (__bridge_retained void *)fingerprintHash
      : NULL;
}


// Define Notification names used for observing Swift Core
NSNotificationName const HotUpdaterUpdateProgressDidChangeNotification = @"HotUpdaterUpdateProgressDidChange";

#pragma mark - Runtime Attribution

// Crash recovery (HotUpdaterRecoveryHub in Swift) asks which instance a view,
// a surface, or a failing JavaScript thread belongs to. Each React Native
// runtime has its own module, which knows its instance once its bundle URL is
// known, and its runtime's surface presenter.

// Posted once a runtime's module knows its instance, so surfaces that started
// before it existed can be attributed.
static NSString *const HotUpdaterRuntimeDidResolveNotification = @"HotUpdaterRuntimeDidResolve";
static NSString *const HotUpdaterRuntimeModuleKey = @"HotUpdater.runtimeModule";
// The bridgeless runtime's JavaScript thread, where RCTFatal reports its
// JavaScript fatal errors.
static NSString *const HotUpdaterRuntimeThreadName = @"com.facebook.react.runtime.JavaScript";

#ifndef RCT_NEW_ARCH_ENABLED
// Old architecture: the context of the ExceptionsManager's method queue, where
// RCTFatal reports that bridge's JavaScript fatals.
static char kHotUpdaterRuntimeQueueKey;

static void HotUpdaterReleaseRuntimeQueueReference(void *reference)
{
  CFRelease(reference);
}
#endif

// What a JavaScript thread's dictionary, or an old-architecture runtime's
// ExceptionsManager queue, holds: its runtime's module, weakly.
@interface HotUpdaterRuntimeModuleReference : NSObject
@property (nonatomic, weak) HotUpdater *module;
@end

@implementation HotUpdaterRuntimeModuleReference
@end

static id HotUpdaterRuntimeIdentityOfModule(HotUpdater *module);

// Every module that joined a runtime, weakly.
static NSHashTable<HotUpdater *> *HotUpdaterRuntimeModules(void)
{
  static NSHashTable<HotUpdater *> *modules;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    modules = [NSHashTable weakObjectsHashTable];
  });
  return modules;
}

@interface HotUpdaterRecoverySignalBridge : NSObject
@end

@implementation HotUpdaterRecoverySignalBridge

+ (void)installSignalHandlers:(NSString *)crashMarkerPath
{
    HotUpdaterInstallSignalHandlers(crashMarkerPath);
}

+ (void)updateLaunchState:(NSString * _Nullable)bundleId shouldRollback:(BOOL)shouldRollback
{
    HotUpdaterUpdateSignalLaunchState(bundleId, shouldRollback);
}

@end

@interface HotUpdater () <RCTInitializing>
- (HotUpdaterImpl *)resolvedInstanceImpl;
- (NSURL *)runtimeBundleURL;
- (BOOL)isRuntimeOfSurfacePresenter:(id)surfacePresenter rootTag:(NSNumber *)rootTag;
@end

@implementation HotUpdater {
    bool hasListeners;
    // The impl of this module's React Native runtime, once its bundle URL is known.
    HotUpdaterImpl *_instanceImpl;
    // Bridgeless: this runtime's surface presenter, which knows every surface
    // of this runtime by its root tag.
    __weak id _surfacePresenter;
}

@synthesize bridge = _bridge;
@synthesize moduleRegistry = _moduleRegistry;
@synthesize bundleManager = _bundleManager;

+ (BOOL)requiresMainQueueSetup {
    return YES;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleDownloadProgress:)
                                                     name:HotUpdaterUpdateProgressDidChangeNotification
                                                   object:nil];

        _lastUpdateTime = 0;
    }
    return self;
}

- (void)initialize
{
    [self configureExceptionsManagerWithModuleRegistry:self.moduleRegistry];
}

- (void)setBridge:(RCTBridge *)bridge
{
    [super setBridge:bridge];
    // Main's recovery reload reloads this bridge: only main's runtime sets
    // it, never a named runtime's that started after main's. With main
    // only, every bridge is main's, as before.
    if (!bridge || [HotUpdaterNativeUpdates() implForBundleURL:bridge.bundleURL] == [HotUpdater sharedImpl]) {
        gHotUpdaterBridge = bridge;
    }
    [self configureExceptionsManagerWithBridge:bridge];
}

// Clean up observers when module is invalidated or deallocated
- (void)invalidate {
    RCTLogInfo(@"[HotUpdater.mm] invalidate called, removing observers.");
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    if (gHotUpdaterBridge == self.bridge) {
        gHotUpdaterBridge = nil;
    }
    [super invalidate];
}

- (void)dealloc {
    RCTLogInfo(@"[HotUpdater.mm] dealloc called, removing observers.");
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    if (gHotUpdaterBridge == self.bridge) {
        gHotUpdaterBridge = nil;
    }
}

- (void)configureExceptionsManagerWithBridge:(RCTBridge *)bridge
{
    if (!bridge) {
        return;
    }

    id exceptionsManager = [bridge moduleForClass:[RCTExceptionsManager class]];
    [self applyExceptionsManagerReloadLimit:exceptionsManager];
#ifndef RCT_NEW_ARCH_ENABLED
    [self noteRuntimeQueuesOfBridge:bridge];
#endif
}

#ifndef RCT_NEW_ARCH_ENABLED
// Old architecture: RCTFatal reports a JavaScript fatal on the
// ExceptionsManager's method queue, and an error of the bridge itself on its
// JavaScript thread. Both belong to this module's bridge, so both remember
// this module, which tells crash recovery whose fatal it is.
- (void)noteRuntimeQueuesOfBridge:(RCTBridge *)bridge
{
    HotUpdaterRuntimeModuleReference *reference = [HotUpdaterRuntimeModuleReference new];
    reference.module = self;

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    // Modules get the batched bridge, which keeps the module data.
    RCTBridge *batchedBridge = [bridge respondsToSelector:@selector(moduleDataForName:)] ? bridge : bridge.batchedBridge;
    RCTModuleData *exceptionsManager = [batchedBridge respondsToSelector:@selector(moduleDataForName:)]
        ? [batchedBridge moduleDataForName:@"ExceptionsManager"]
        : nil;
    dispatch_queue_t queue = exceptionsManager.methodQueue;
#pragma clang diagnostic pop
    // Only a queue of this bridge alone.
    if (queue && queue != dispatch_get_main_queue() && queue != RCTJSThread) {
        dispatch_queue_set_specific(queue,
                                    &kHotUpdaterRuntimeQueueKey,
                                    (__bridge_retained void *)reference,
                                    HotUpdaterReleaseRuntimeQueueReference);
    }
    if ([batchedBridge respondsToSelector:@selector(dispatchBlock:queue:)]) {
        [batchedBridge dispatchBlock:^{
            [NSThread currentThread].threadDictionary[HotUpdaterRuntimeModuleKey] = reference;
        } queue:RCTJSThread];
    }
}
#endif

- (void)configureExceptionsManagerWithModuleRegistry:(id)moduleRegistry
{
    if (!moduleRegistry || ![moduleRegistry respondsToSelector:@selector(moduleForName:lazilyLoadIfNecessary:)]) {
        return;
    }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    SEL selector = @selector(moduleForName:lazilyLoadIfNecessary:);
    NSMethodSignature *signature = [moduleRegistry methodSignatureForSelector:selector];
    if (!signature) {
        return;
    }

    NSInvocation *invocation = [NSInvocation invocationWithMethodSignature:signature];
    invocation.target = moduleRegistry;
    invocation.selector = selector;

    const char *moduleName = "ExceptionsManager";
    BOOL lazilyLoad = YES;
    [invocation setArgument:&moduleName atIndex:2];
    [invocation setArgument:&lazilyLoad atIndex:3];
    [invocation invoke];

    __unsafe_unretained id exceptionsManager = nil;
    [invocation getReturnValue:&exceptionsManager];
#pragma clang diagnostic pop

    [self applyExceptionsManagerReloadLimit:exceptionsManager];
}

- (void)applyExceptionsManagerReloadLimit:(id)exceptionsManager
{
    if ([exceptionsManager isKindOfClass:[RCTExceptionsManager class]]) {
        ((RCTExceptionsManager *)exceptionsManager).maxReloadAttempts = 0;
    }
}


RCT_EXPORT_MODULE();

#pragma mark - Singleton Instance

// Static singleton HotUpdaterImpl getter
+ (HotUpdaterImpl *)sharedImpl {
    static HotUpdaterImpl *_sharedImpl = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _sharedImpl = HotUpdaterMakeImpl();
    });
    return _sharedImpl;
}

#pragma mark - Instance Routing

// The impl of the instance whose bundle this module's React Native runtime
// runs. Each runtime has its own module, and JavaScript never names its
// instance, so the runtime's bundle URL tells them apart. Resolved on first
// use: the URL isn't set yet in -init, and React Native also creates a module
// that never joins a runtime.
- (HotUpdaterImpl *)instanceImpl {
    @synchronized (self) {
        if (_instanceImpl) {
            return _instanceImpl;
        }
    }

#ifdef RCT_NEW_ARCH_ENABLED
    NSURL *bundleURL = self.bundleManager.bundleURL;
#else
    NSURL *bundleURL = self.bridge.bundleURL;
#endif
    if (!bundleURL) {
        // Not cached: the next call resolves again once the URL is set.
        return [HotUpdater sharedImpl];
    }

    HotUpdaterImpl *impl = [HotUpdaterNativeUpdates() implForBundleURL:bundleURL];
    BOOL resolvedNow = NO;
    @synchronized (self) {
        if (!_instanceImpl) {
            _instanceImpl = impl;
            resolvedNow = YES;
        }
        impl = _instanceImpl;
    }
    if (resolvedNow) {
        [[NSNotificationCenter defaultCenter] postNotificationName:HotUpdaterRuntimeDidResolveNotification
                                                            object:self
                                                          userInfo:@{
                                                              @"impl" : impl,
                                                              @"bundleURL" : bundleURL,
                                                              @"runtime" : HotUpdaterRuntimeIdentityOfModule(self) ?: self,
                                                          }];
    }
    return impl;
}

// The impl once this runtime's bundle URL is known, else nil: attribution
// must not take instanceImpl's fallback to main for a runtime it can't tell.
- (HotUpdaterImpl *)resolvedInstanceImpl {
    @synchronized (self) {
        if (_instanceImpl) {
            return _instanceImpl;
        }
    }
    return [self runtimeBundleURL] ? [self instanceImpl] : nil;
}

// The bundle this module's runtime runs, which tells an error of an earlier
// launch's runtime from one of the instance's current launch.
- (NSURL *)runtimeBundleURL {
#ifdef RCT_NEW_ARCH_ENABLED
    return self.bundleManager.bundleURL;
#else
    return self.bridge.bundleURL;
#endif
}

// RCTInstance hands each module it creates its runtime's surface presenter.
- (void)setSurfacePresenter:(id)surfacePresenter {
    @synchronized (self) {
        _surfacePresenter = surfacePresenter;
    }
    NSHashTable<HotUpdater *> *modules = HotUpdaterRuntimeModules();
    @synchronized (modules) {
        [modules addObject:self];
    }
}

// Whether `surfacePresenter` is this runtime's, or, without one, whether
// this runtime's presenter has the surface of `rootTag`. Root tags are unique
// in the process, so no other runtime's presenter has it.
- (BOOL)isRuntimeOfSurfacePresenter:(id)surfacePresenter rootTag:(NSNumber *)rootTag {
#ifdef RCT_NEW_ARCH_ENABLED
    RCTSurfacePresenter *presenter = nil;
    @synchronized (self) {
        presenter = _surfacePresenter;
    }
    if (!presenter) {
        return NO;
    }
    if (surfacePresenter) {
        return presenter == surfacePresenter;
    }
    return rootTag && [presenter surfaceForRootTag:rootTag.integerValue] != nil;
#else
    return NO;
#endif
}

// React Native asks for the module's JSI object on the runtime's JavaScript
// thread, which is where RCTFatal reports that runtime's JavaScript fatals.
- (void)noteRuntimeThread {
    NSThread *thread = [NSThread currentThread];
    if (![thread.name isEqualToString:HotUpdaterRuntimeThreadName]) {
        return;
    }
    HotUpdaterRuntimeModuleReference *reference = [HotUpdaterRuntimeModuleReference new];
    reference.module = self;
    thread.threadDictionary[HotUpdaterRuntimeModuleKey] = reference;
    // Resolves now, while the bundle URL is known, for the surfaces that
    // started before this module existed.
    [self resolvedInstanceImpl];
}

// Reloading reloads main's React host or the whole app, so a runtime of a
// named instance refuses it until each React host can reload its own.
- (BOOL)rejectReloadOfNamedInstance:(RCTPromiseRejectBlock)reject {
    if ([self instanceImpl] == [HotUpdater sharedImpl]) {
        return NO;
    }
    reject(@"RELOAD_UNSUPPORTED",
           @"HotUpdater.reload() and HotUpdater.reloadProcess() are not supported in a React Native runtime of a named "
           @"HotUpdaterInstance yet. Reload its React Native host from native code.",
           nil);
    return YES;
}

#pragma mark - React Native Constants (Keep getMinBundleId, delegate others)

// Returns the bundle ID of the bundle this build ships (MIN_BUNDLE_ID)
- (NSString *)getMinBundleId {
     return HotUpdaterGetMinBundleId();
}

- (NSDictionary *)_buildConstantsDictionary {
    return @{
        @"MIN_BUNDLE_ID": [self getMinBundleId] ?: [NSNull null],
        @"APP_VERSION": HotUpdaterAppVersion() ?: [NSNull null],
        @"CHANNEL": [[self instanceImpl] getChannel] ?: [NSNull null],
        @"DEFAULT_CHANNEL": [[self instanceImpl] getDefaultChannel] ?: [NSNull null],
        @"FINGERPRINT_HASH": [[self instanceImpl] getFingerprintHash] ?: [NSNull null]
    };
}


// Get bundleURL with default bundle using singleton
+ (NSURL *)bundleURL {
    return [self bundleURLWithBundle:[NSBundle mainBundle]];
}

// Get bundleURL with specific bundle using singleton
+ (NSURL *)bundleURLWithBundle:(NSBundle *)bundle {
    // Record the bundle before the first sharedImpl, whose storage isolation
    // key reads the bundle's HOT_UPDATER_* Info.plist keys.
    HotUpdaterSharedConfig().bundle = bundle;
    return [[HotUpdater sharedImpl] bundleURLWithBundle:bundle];
}

// Get bundleURL with default bundle using instance impl
- (NSURL *)bundleURL {
    return [HotUpdater bundleURLWithBundle:[NSBundle mainBundle]];
}

// Get bundleURL with specific bundle using instance impl
- (NSURL *)bundleURLWithBundle:(NSBundle *)bundle {
    return [HotUpdater bundleURLWithBundle:bundle];
}

+ (void)configureWithFingerprintHash:(NSString *)fingerprintHash
                           publicKey:(NSString *)publicKey
                             channel:(NSString *)channel
                        isolationKey:(NSString *)isolationKey {
    HotUpdaterConfig *config = HotUpdaterSharedConfig();
    [config configureWithFingerprintHash:fingerprintHash publicKey:publicKey channel:channel isolationKey:isolationKey];
}

#pragma mark - Progress Updates & Event Emitting (Keep in ObjC Wrapper)

- (void)handleDownloadProgress:(NSNotification *)notification {
     if (!hasListeners) return;
     // Every impl posts its progress here; this runtime's JavaScript gets
     // only its own instance's.
     if (notification.object != [self instanceImpl]) return;

     NSDictionary *userInfo = notification.userInfo;
     NSNumber *progressNum = userInfo[@"progress"];

     if (progressNum) {
         double progress = [progressNum doubleValue];
         NSTimeInterval currentTime = [[NSDate date] timeIntervalSince1970] * 1000;
         if ((currentTime - self.lastUpdateTime) >= 100 || progress >= 1.0) {
             self.lastUpdateTime = currentTime;
             [self sendEvent:@"onProgress" body:userInfo ?: @{}];
         }
     }
 }

#pragma mark - React Native Events (Keep as is)

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onProgress"];
}

- (void)startObserving {
    hasListeners = YES;
}

- (void)stopObserving {
    hasListeners = NO;
}

- (void)sendEvent:(NSString *)name body:(id)body {
    if (hasListeners) {
        [self sendEventWithName:name body:body];
    }
}


#pragma mark - React Native Exports

#ifdef RCT_NEW_ARCH_ENABLED

// New Architecture implementations

- (void)reload:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
    RCTLogInfo(@"[HotUpdater.mm] HotUpdater requested a reload");
    if ([self rejectReloadOfNamedInstance:reject]) {
        return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            HotUpdaterImpl *impl = [HotUpdater sharedImpl];
            [impl resetLaunchPreparation];
            NSURL *bundleURL = [impl bundleURLWithBundle:HotUpdaterSharedConfig().bundle];
            RCTLogInfo(@"[HotUpdater.mm] Reloading with bundle URL: %@", bundleURL);
            if (bundleURL) {
                RCTReloadCommandSetBundleURL(bundleURL);
            }
            if (bundleURL && super.bridge) {
                [super.bridge setValue:bundleURL forKey:@"bundleURL"];
            } else if (!super.bridge) {
                RCTLogWarn(@"[HotUpdater.mm] Bridge is nil, cannot set bundleURL for reload.");
            }
            HotUpdaterTriggerReloadCommand(super.bridge, @"HotUpdater requested a reload");
            resolve(nil);
        } @catch (NSError *error) {
            RCTLogError(@"[HotUpdater.mm] Failed to reload: %@", error);
            reject(@"RELOAD_ERROR", error.description, error);
        }
    });
}

- (void)reloadProcess:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
    [self reload:resolve reject:reject];
}

- (void)updateBundle:(JS::NativeHotUpdater::UpdateBundleParams &)params
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
    NSLog(@"[HotUpdater.mm] updateBundle called.");
    NSMutableDictionary *paramDict = [NSMutableDictionary dictionary];
    if (params.bundleId()) {
        paramDict[@"bundleId"] = params.bundleId();
    }
    if (params.manifestUrl()) {
        paramDict[@"manifestUrl"] = params.manifestUrl();
    }
    if (params.manifestFileHash()) {
        paramDict[@"manifestFileHash"] = params.manifestFileHash();
    }
    if (params.archiveUrl()) {
        paramDict[@"archiveUrl"] = params.archiveUrl();
    }
    if (params.assets()) {
        paramDict[@"assets"] = params.assets();
    }
    if (params.channel()) {
        paramDict[@"channel"] = params.channel();
    }
    if (params.selection()) {
        paramDict[@"selection"] = params.selection();
    }
    // Legacy: what JavaScript from the first artifact protocol v2 SDK sends.
    if (params.filesUrl()) {
        paramDict[@"filesUrl"] = params.filesUrl();
    }
    if (params.requestHeaders()) {
        paramDict[@"requestHeaders"] = params.requestHeaders();
    }
    if (params.requestTimeout().has_value()) {
        paramDict[@"requestTimeout"] = @(params.requestTimeout().value());
    }

    HotUpdaterImpl *impl = [self instanceImpl];
    [impl updateBundle:paramDict resolver:resolve rejecter:reject];
}

- (void)installArtifact:(JS::NativeHotUpdater::InstallArtifactParams &)params
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
    NSLog(@"[HotUpdater.mm] installArtifact called.");
    NSMutableDictionary *paramDict = [NSMutableDictionary dictionary];
    if (params.bundleId()) {
        paramDict[@"bundleId"] = params.bundleId();
    }
    if (params.manifestUrl()) {
        paramDict[@"manifestUrl"] = params.manifestUrl();
    }
    if (params.manifestFileHash()) {
        paramDict[@"manifestFileHash"] = params.manifestFileHash();
    }
    if (params.archiveUrl()) {
        paramDict[@"archiveUrl"] = params.archiveUrl();
    }
    if (params.patch()) {
        paramDict[@"patch"] = params.patch();
    }
    if (params.filesUrl()) {
        paramDict[@"filesUrl"] = params.filesUrl();
    }
    if (params.requestHeaders()) {
        paramDict[@"requestHeaders"] = params.requestHeaders();
    }
    if (params.requestTimeout().has_value()) {
        paramDict[@"requestTimeout"] = @(params.requestTimeout().value());
    }
    if (params.channel()) {
        paramDict[@"channel"] = params.channel();
    }
    if (params.selection()) {
        paramDict[@"selection"] = params.selection();
    }

    HotUpdaterImpl *impl = [self instanceImpl];
    [impl installArtifact:paramDict resolver:resolve rejecter:reject];
}

- (NSNumber *)acceptReleaseCatalog:(NSDictionary *)params {
    return @([[self instanceImpl] acceptReleaseCatalog:params]);
}

- (NSDictionary *)getActiveUpdateState {
    return [[self instanceImpl] getActiveUpdateState];
}

- (void)getReleaseCatalogCache:(NSString *)partition
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject {
    [[self instanceImpl] getReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

- (void)setReleaseCatalogCache:(NSString *)partition
                       payload:(NSString *)payload
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
    [[self instanceImpl] setReleaseCatalogCache:partition payload:payload resolver:resolve rejecter:reject];
}

- (void)removeReleaseCatalogCache:(NSString *)partition
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
    [[self instanceImpl] removeReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

- (NSNumber *)isReleaseSelectionCurrent:(NSDictionary *)params {
    return @([[self instanceImpl] isReleaseSelectionCurrent:params]);
}

- (void)commitReleaseSelection:(NSDictionary *)params
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
    [[self instanceImpl] commitReleaseSelection:params resolver:resolve rejecter:reject];
}

- (NSDictionary *)notifyAppReady {
    NSLog(@"[HotUpdater.mm] notifyAppReady called");
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl notifyAppReady];
}

- (NSArray<NSString *> *)getCrashHistory {
    NSLog(@"[HotUpdater.mm] getCrashHistory called");
    HotUpdaterImpl *impl = [self instanceImpl];
    NSArray<NSString *> *crashHistory = [impl getCrashHistory];
    return crashHistory ?: @[];
}

- (NSNumber *)clearCrashHistory {
    NSLog(@"[HotUpdater.mm] clearCrashHistory called");
    HotUpdaterImpl *impl = [self instanceImpl];
    BOOL result = [impl clearCrashHistory];
    return @(result);
}

- (NSString *)getInstallId {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getInstallId];
}

- (NSString * _Nullable)getStorageItem:(NSString *)key {
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl getStorageItem:key];
}

- (void)setStorageItem:(NSString *)key value:(NSString * _Nullable)value {
    HotUpdaterImpl *impl = [self instanceImpl];
    [impl setStorageItem:key value:value];
}

- (NSString * _Nullable)takeNativeUpdateEvents {
    return [HotUpdaterNativeUpdates() takeEventsWithImpl:[self instanceImpl]];
}

- (void)getUpdateStatus:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
    [[self instanceImpl] getUpdateStatus:resolve rejecter:reject];
}

- (void)getUpdateLogs:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
    [[self instanceImpl] getUpdateLogs:resolve rejecter:reject];
}

- (void)clearUpdateLogs:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
    [[self instanceImpl] clearUpdateLogs:resolve rejecter:reject];
}

- (void)appendUpdateLog:(NSString *)entry {
    [[self instanceImpl] appendUpdateLog:entry];
}

- (NSString * _Nullable)getBaseURL {
    NSLog(@"[HotUpdater.mm] getBaseURL called");
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl getBaseURL];
}

- (void)setCohort:(NSString *)customId {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setCohort:customId];
}

- (NSString *)getCohort {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getCohort];
}

- (NSString * _Nullable)getBundleId {
    NSLog(@"[HotUpdater.mm] getBundleId called");
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl getBundleId];
}

- (NSDictionary<NSString *, id> *)getManifest {
    NSLog(@"[HotUpdater.mm] getManifest called");
    HotUpdaterImpl *impl = [self instanceImpl];
    NSDictionary<NSString *, id> *manifest = [impl getManifest];
    return manifest ?: @{};
}

- (void)resetChannel:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
    [HotUpdaterNativeUpdates() resetChannelWithImpl:[self instanceImpl]
                                           resolver:resolve
                                           rejecter:reject];
}

- (void)resetChannelIfSelectionCurrent:(NSDictionary *)params
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject {
    [HotUpdaterNativeUpdates() resetChannelIfSelectionCurrentWithImpl:[self instanceImpl]
                                                               params:params
                                                             resolver:resolve
                                                             rejecter:reject];
}

- (facebook::react::ModuleConstants<JS::NativeHotUpdater::Constants::Builder>)constantsToExport {
    return [self getConstants];
}

- (facebook::react::ModuleConstants<JS::NativeHotUpdater::Constants::Builder>)getConstants {
    HotUpdaterImpl *impl = [self instanceImpl];
    return facebook::react::typedConstants<JS::NativeHotUpdater::Constants::Builder>({
        .MIN_BUNDLE_ID = [self getMinBundleId],
        .APP_VERSION = HotUpdaterAppVersion(),
        .CHANNEL = [impl getChannel],
        .DEFAULT_CHANNEL = [impl getDefaultChannel],
        .FINGERPRINT_HASH = [impl getFingerprintHash],
    });
}

#else

// Old Architecture implementations

RCT_EXPORT_METHOD(reload:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    RCTLogInfo(@"[HotUpdater.mm] HotUpdater requested a reload");
    if ([self rejectReloadOfNamedInstance:reject]) {
        return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            HotUpdaterImpl *impl = [HotUpdater sharedImpl];
            [impl resetLaunchPreparation];
            NSURL *bundleURL = [impl bundleURLWithBundle:HotUpdaterSharedConfig().bundle];
            RCTLogInfo(@"[HotUpdater.mm] Reloading with bundle URL: %@", bundleURL);
            if (bundleURL) {
                RCTReloadCommandSetBundleURL(bundleURL);
            }
            if (bundleURL && super.bridge) {
                [super.bridge setValue:bundleURL forKey:@"bundleURL"];
            } else if (!super.bridge) {
                RCTLogWarn(@"[HotUpdater.mm] Bridge is nil, cannot set bundleURL for reload.");
            }
            HotUpdaterTriggerReloadCommand(super.bridge, @"HotUpdater requested a reload");
            resolve(nil);
        } @catch (NSError *error) {
            RCTLogError(@"[HotUpdater.mm] Failed to reload: %@", error);
            reject(@"RELOAD_ERROR", error.description, error);
        }
    });
}

RCT_EXPORT_METHOD(reloadProcess:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [self reload:resolve reject:reject];
}

RCT_EXPORT_METHOD(updateBundle:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    NSLog(@"[HotUpdater.mm] updateBundle called. params: %@", params);
    HotUpdaterImpl *impl = [self instanceImpl];
    [impl updateBundle:params resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(installArtifact:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    NSLog(@"[HotUpdater.mm] installArtifact called.");
    HotUpdaterImpl *impl = [self instanceImpl];
    [impl installArtifact:params resolver:resolve rejecter:reject];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(acceptReleaseCatalog:(NSDictionary *)params) {
    return @([[self instanceImpl] acceptReleaseCatalog:params]);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getActiveUpdateState) {
    return [[self instanceImpl] getActiveUpdateState];
}

RCT_EXPORT_METHOD(getReleaseCatalogCache:(NSString *)partition
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[self instanceImpl] getReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(setReleaseCatalogCache:(NSString *)partition
                  payload:(NSString *)payload
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[self instanceImpl] setReleaseCatalogCache:partition payload:payload resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(removeReleaseCatalogCache:(NSString *)partition
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[self instanceImpl] removeReleaseCatalogCache:partition resolver:resolve rejecter:reject];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(isReleaseSelectionCurrent:(NSDictionary *)params) {
    return @([[self instanceImpl] isReleaseSelectionCurrent:params]);
}

RCT_EXPORT_METHOD(commitReleaseSelection:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[self instanceImpl] commitReleaseSelection:params resolver:resolve rejecter:reject];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(notifyAppReady) {
    NSLog(@"[HotUpdater.mm] notifyAppReady called");
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl notifyAppReady];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getCrashHistory) {
    NSLog(@"[HotUpdater.mm] getCrashHistory called");
    HotUpdaterImpl *impl = [self instanceImpl];
    NSArray<NSString *> *crashHistory = [impl getCrashHistory];
    return crashHistory ?: @[];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(clearCrashHistory) {
    NSLog(@"[HotUpdater.mm] clearCrashHistory called");
    HotUpdaterImpl *impl = [self instanceImpl];
    BOOL result = [impl clearCrashHistory];
    return @(result);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getInstallId) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getInstallId];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getStorageItem:(NSString *)key) {
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl getStorageItem:key];
}

RCT_EXPORT_METHOD(setStorageItem:(NSString *)key value:(NSString * _Nullable)value) {
    HotUpdaterImpl *impl = [self instanceImpl];
    [impl setStorageItem:key value:value];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(takeNativeUpdateEvents) {
    return [HotUpdaterNativeUpdates() takeEventsWithImpl:[self instanceImpl]];
}

RCT_EXPORT_METHOD(getUpdateStatus:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[self instanceImpl] getUpdateStatus:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(getUpdateLogs:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[self instanceImpl] getUpdateLogs:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(clearUpdateLogs:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [[self instanceImpl] clearUpdateLogs:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(appendUpdateLog:(NSString *)entry) {
    [[self instanceImpl] appendUpdateLog:entry];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getBaseURL) {
    NSLog(@"[HotUpdater.mm] getBaseURL called");
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl getBaseURL];
}

RCT_EXPORT_METHOD(setCohort:(NSString *)customId) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    [impl setCohort:customId];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getCohort) {
    HotUpdaterImpl *impl = [HotUpdater sharedImpl];
    return [impl getCohort];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getBundleId) {
    NSLog(@"[HotUpdater.mm] getBundleId called");
    HotUpdaterImpl *impl = [self instanceImpl];
    return [impl getBundleId];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getManifest) {
    NSLog(@"[HotUpdater.mm] getManifest called");
    HotUpdaterImpl *impl = [self instanceImpl];
    NSDictionary<NSString *, id> *manifest = [impl getManifest];
    return manifest ?: @{};
}

RCT_EXPORT_METHOD(resetChannel:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [HotUpdaterNativeUpdates() resetChannelWithImpl:[self instanceImpl]
                                           resolver:resolve
                                           rejecter:reject];
}

RCT_EXPORT_METHOD(resetChannelIfSelectionCurrent:(NSDictionary *)params
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    [HotUpdaterNativeUpdates() resetChannelIfSelectionCurrentWithImpl:[self instanceImpl]
                                                               params:params
                                                             resolver:resolve
                                                             rejecter:reject];
}

- (NSDictionary *)constantsToExport {
    return [self _buildConstantsDictionary];
}

- (NSDictionary *)getConstants {
    return [self constantsToExport];
}

#endif


#pragma mark - Turbo Module Support (Keep as is)


#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
    [self noteRuntimeThread];
    return std::make_shared<facebook::react::NativeHotUpdaterSpecJSI>(params);
}
#endif


@end

#pragma mark - Runtime Attribution (C)

#ifdef RCT_NEW_ARCH_ENABLED
// The bundle URL an RCTHost or RCTInstance runs, which neither exposes:
// read through KVC from what RN 0.85 keeps (RCTHost's `_bundleURL` and
// `_bundleManager`, RCTInstance's `_bridgeModuleDecorator.bundleManager`).
// Nil when another React Native version keeps it elsewhere.
static NSURL *HotUpdaterBundleURLOfRuntime(id object)
{
  for (NSString *keyPath in @[ @"bundleURL", @"bundleManager.bundleURL", @"bridgeModuleDecorator.bundleManager.bundleURL" ]) {
    @try {
      id value = [object valueForKeyPath:keyPath];
      if ([value isKindOfClass:[NSURL class]]) {
        return value;
      }
    } @catch (NSException *exception) {
      // Not a key of this object.
    }
  }
  return nil;
}
#endif

// The impl whose runtime `object` belongs to: a Fabric surface or root view,
// an RCTInstance or RCTHost (by its surface presenter), an old-architecture
// root view or bridge (by its bundle URL). Nil when no runtime claims it.
// `runtimeBundleURL`, when given, receives the bundle the runtime runs.
// The object that stands for one React Native runtime, which crash recovery
// keeps the launch it runs by: the module (bridgeless), or the bridge the app
// created (old architecture; a module, a root view and a load failure each
// reach it, and its batched bridge points back to it).
static id HotUpdaterRuntimeIdentityOfBridge(id bridge)
{
  if ([bridge respondsToSelector:NSSelectorFromString(@"parentBridge")]) {
    id parent = [bridge valueForKey:@"parentBridge"];
    if (parent) {
      return parent;
    }
  }
  return bridge;
}

static id HotUpdaterRuntimeIdentityOfModule(HotUpdater *module)
{
#ifdef RCT_NEW_ARCH_ENABLED
  return module;
#else
  return HotUpdaterRuntimeIdentityOfBridge(module.bridge);
#endif
}

// `runtimeIdentity`, when given, receives the runtime's identity (see
// HotUpdaterRuntimeIdentityOfBridge) when one told the runtime apart.
static HotUpdaterImpl *HotUpdaterImplForRootObject(id object, NSURL **runtimeBundleURL, id *runtimeIdentity = nullptr)
{
  if (!object) {
    return nil;
  }

#ifdef RCT_NEW_ARCH_ENABLED
  id surfacePresenter = nil;
  NSNumber *rootTag = nil;
  if ([object respondsToSelector:@selector(surfacePresenter)]) {
    surfacePresenter = [object valueForKey:@"surfacePresenter"];
  } else if ([object respondsToSelector:NSSelectorFromString(@"rootViewTag")]) {
    id tag = [object valueForKey:@"rootViewTag"];
    rootTag = [tag isKindOfClass:[NSNumber class]] ? tag : nil;
  } else if ([object isKindOfClass:[UIView class]] &&
             [object isKindOfClass:NSClassFromString(@"RCTRootComponentView")]) {
    rootTag = @(((UIView *)object).tag);
  }
  if (surfacePresenter || rootTag) {
    NSHashTable<HotUpdater *> *table = HotUpdaterRuntimeModules();
    NSArray<HotUpdater *> *modules;
    @synchronized (table) {
      modules = table.allObjects;
    }
    for (HotUpdater *module in modules) {
      if ([module isRuntimeOfSurfacePresenter:surfacePresenter rootTag:rootTag]) {
        HotUpdaterImpl *impl = [module resolvedInstanceImpl];
        if (impl) {
          if (runtimeBundleURL) {
            *runtimeBundleURL = [module runtimeBundleURL];
          }
          if (runtimeIdentity) {
            *runtimeIdentity = HotUpdaterRuntimeIdentityOfModule(module);
          }
          return impl;
        }
      }
    }
    if (!surfacePresenter) {
      return nil;
    }
    // An RCTInstance or RCTHost whose bundle failed to load before its
    // runtime created a module: its bundle URL tells whose it is.
    NSURL *bundleURL = HotUpdaterBundleURLOfRuntime(object);
    if (!bundleURL) {
      return nil;
    }
    if (runtimeBundleURL) {
      *runtimeBundleURL = bundleURL;
    }
    return [HotUpdaterNativeUpdates() implForBundleURL:bundleURL];
  }
#endif

  RCTBridge *bridge = nil;
  if ([object isKindOfClass:[RCTBridge class]]) {
    bridge = object;
  } else if ([object respondsToSelector:@selector(bridge)]) {
    id candidate = [object valueForKey:@"bridge"];
    bridge = [candidate isKindOfClass:[RCTBridge class]] ? candidate : nil;
  }
  NSURL *bundleURL = bridge.bundleURL;
  if (!bundleURL) {
    return nil;
  }
  if (runtimeBundleURL) {
    *runtimeBundleURL = bundleURL;
  }
  if (runtimeIdentity) {
    *runtimeIdentity = HotUpdaterRuntimeIdentityOfBridge(bridge);
  }
  return [HotUpdaterNativeUpdates() implForBundleURL:bundleURL];
}

extern "C" void *HotUpdaterCopyImplForRootObject(id object)
{
  HotUpdaterImpl *impl = HotUpdaterImplForRootObject(object, nullptr);
  return impl ? (__bridge_retained void *)impl : NULL;
}

// The bundle the runtime `object` belongs to runs, or NULL.
extern "C" void *HotUpdaterCopyBundleURLForRootObject(id object)
{
  NSURL *bundleURL = nil;
  HotUpdaterImplForRootObject(object, &bundleURL);
  return bundleURL ? (__bridge_retained void *)bundleURL : NULL;
}

// The identity of the runtime `object` belongs to, or NULL when none told it
// apart. Crash recovery keeps the launch each runtime runs by it.
extern "C" void *HotUpdaterCopyRuntimeIdentityForRootObject(id object)
{
  id identity = nil;
  HotUpdaterImplForRootObject(object, nullptr, &identity);
  return identity ? (__bridge_retained void *)identity : NULL;
}

// The impl of the runtime whose JavaScript thread, or old-architecture
// ExceptionsManager queue, calls this, or NULL.
extern "C" void *HotUpdaterCopyRuntimeImpl(void)
{
  HotUpdaterRuntimeModuleReference *reference =
      [NSThread currentThread].threadDictionary[HotUpdaterRuntimeModuleKey];
#ifndef RCT_NEW_ARCH_ENABLED
  if (!reference) {
    reference = (__bridge HotUpdaterRuntimeModuleReference *)dispatch_get_specific(&kHotUpdaterRuntimeQueueKey);
  }
#endif
  HotUpdaterImpl *impl = [reference.module resolvedInstanceImpl];
  return impl ? (__bridge_retained void *)impl : NULL;
}

// The identity of the runtime whose JavaScript thread, or old-architecture
// ExceptionsManager queue, calls this, or NULL.
extern "C" void *HotUpdaterCopyRuntimeIdentity(void)
{
  HotUpdaterRuntimeModuleReference *reference =
      [NSThread currentThread].threadDictionary[HotUpdaterRuntimeModuleKey];
#ifndef RCT_NEW_ARCH_ENABLED
  if (!reference) {
    reference = (__bridge HotUpdaterRuntimeModuleReference *)dispatch_get_specific(&kHotUpdaterRuntimeQueueKey);
  }
#endif
  HotUpdater *module = reference.module;
  id identity = module ? HotUpdaterRuntimeIdentityOfModule(module) : nil;
  return identity ? (__bridge_retained void *)identity : NULL;
}

// The bundle the runtime whose JavaScript thread, or old-architecture
// ExceptionsManager queue, calls this runs, or NULL.
extern "C" void *HotUpdaterCopyRuntimeBundleURL(void)
{
  HotUpdaterRuntimeModuleReference *reference =
      [NSThread currentThread].threadDictionary[HotUpdaterRuntimeModuleKey];
#ifndef RCT_NEW_ARCH_ENABLED
  if (!reference) {
    reference = (__bridge HotUpdaterRuntimeModuleReference *)dispatch_get_specific(&kHotUpdaterRuntimeQueueKey);
  }
#endif
  NSURL *bundleURL = [reference.module runtimeBundleURL];
  return bundleURL ? (__bridge_retained void *)bundleURL : NULL;
}

// Whether a started view is shown: an old-architecture root view in a window,
// or a running Fabric surface whose view is in a window. A surface's `view`
// getter would create its view, so this reads the one it already has.
extern "C" BOOL HotUpdaterIsViewShown(id object)
{
  if ([object isKindOfClass:[UIView class]]) {
    return ((UIView *)object).window != nil;
  }
#ifdef RCT_NEW_ARCH_ENABLED
  if ([object isKindOfClass:[RCTFabricSurface class]]) {
    RCTFabricSurface *surface = object;
    if (surface.stage != RCTSurfaceStageRunning) {
      return NO;
    }
    id view = nil;
    @try {
      view = [surface valueForKey:@"_view"];
    } @catch (NSException *exception) {
      return NO;
    }
    return [view isKindOfClass:[UIView class]] && ((UIView *)view).window != nil;
  }
#endif
  return NO;
}
