#include <jni.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <cstring>
#include <limits.h>
#include <atomic>
#include <cstdint>
#include <mutex>

namespace {
constexpr size_t kMaxBundleIdLength = 128;
constexpr int kSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};

// One slot per instance that monitors a launch (HotUpdaterRecoverySlots.kt,
// SLOT_COUNT); main is slot 0. The handler can't allocate, so an instance that
// finds every slot taken gets no marker from a native crash.
constexpr int kSlotCount = 8;
constexpr int kNotAttributed = -1;
// A crash claimed by an instance that has no slot: no slot writes a marker.
constexpr int kAttributedWithoutSlot = -2;
// HotUpdaterRecoverySlots.ATTRIBUTION_WINDOW_MS. A fatal JavaScript error that
// did not end the process must not claim a later crash; Kotlin also clears the
// claim when it ends.
constexpr uint32_t kAttributionWindowMilliseconds = 5000;

struct SlotData {
  // Empty while the slot is free.
  char crashMarkerPath[PATH_MAX];
  char bundleId[kMaxBundleIdLength];
  int shouldRollback;
  // Main records a verified launch too, as it always has.
  int writesWhenVerified;
};

// The published copy of SlotData. Every field is atomic, copied with relaxed
// loads and stores, so a reader racing a writer reads defined (if mixed)
// values, which the sequence then rejects.
struct AtomicSlotData {
  std::atomic<char> crashMarkerPath[PATH_MAX];
  std::atomic<char> bundleId[kMaxBundleIdLength];
  std::atomic<int> shouldRollback;
  std::atomic<int> writesWhenVerified;
};

// A sequence lock: a crash on any thread may read a slot while another thread
// rewrites it. The writer makes the sequence odd while it copies, and a
// reader keeps a copy only when the sequence was even and unchanged across it.
struct Slot {
  std::atomic<uint32_t> sequence;
  AtomicSlotData data;
};
// C++11, as old React Native builds compile it: the handler needs a
// lock-free sequence.
static_assert(ATOMIC_INT_LOCK_FREE == 2 && sizeof(uint32_t) == sizeof(int), "the crash handler needs a lock-free sequence");
static_assert(ATOMIC_CHAR_LOCK_FREE == 2, "the crash handler needs lock-free slot bytes");

// Zero-initialized: static storage. Every slot starts free.
Slot gSlots[kSlotCount];
// The sequence lock takes one writer at a time; launch preparation and the
// main thread can update one slot at once. Never taken by the handler.
std::mutex gSlotWriters[kSlotCount];
// The claimed slot and when it was claimed, in one word, so a crash during
// a new claim reads either the old claim or the new one, never a mix:
// bits 4..31 hold the claim's monotonic milliseconds (modulo 2^28, about 74
// hours, compared with wraparound), bits 0..3 the slot offset by
// kClaimSlotOffset. Zero is no claim.
constexpr uint32_t kClaimSlotBits = 4;
constexpr uint32_t kClaimSlotMask = (1u << kClaimSlotBits) - 1;
constexpr uint32_t kClaimTimeMask = 0xFFFFFFFFu >> kClaimSlotBits;
static_assert(kAttributionWindowMilliseconds < kClaimTimeMask / 2, "a claim's window fits its time bits");
constexpr int kClaimSlotOffset = 3;
static_assert(kSlotCount + kClaimSlotOffset <= static_cast<int>(kClaimSlotMask), "a claimed slot fits its bits");
static_assert(kAttributedWithoutSlot + kClaimSlotOffset > 0, "a claim is never zero");
std::atomic<uint32_t> gClaim(0);
struct sigaction gPreviousActions[NSIG];

void signalHandler(int signum, siginfo_t *info, void *context);

size_t safeStringLength(const char *value, size_t maxLength) {
  size_t length = 0;
  while (length < maxLength && value[length] != '\0') {
    ++length;
  }
  return length;
}

void safeCopy(char *destination, size_t destinationSize, const char *source) {
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

void safeCopyJString(JNIEnv *env, jstring source, char *destination, size_t destinationSize) {
  if (source == nullptr) {
    destination[0] = '\0';
    return;
  }

  const char *utfChars = env->GetStringUTFChars(source, nullptr);
  if (utfChars == nullptr) {
    destination[0] = '\0';
    return;
  }

  safeCopy(destination, destinationSize, utfChars);
  env->ReleaseStringUTFChars(source, utfChars);
}

// clock_gettime is async-signal-safe. Milliseconds of the monotonic clock,
// modulo the claim's time bits.
uint32_t claimTime() {
  struct timespec now {};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return 0;
  }
  const uint64_t milliseconds =
      static_cast<uint64_t>(now.tv_sec) * 1000u + static_cast<uint64_t>(now.tv_nsec) / 1000000u;
  return static_cast<uint32_t>(milliseconds) & kClaimTimeMask;
}

int attributedSlot() {
  const uint32_t claim = gClaim.load(std::memory_order_acquire);
  const uint32_t slotCode = claim & kClaimSlotMask;
  if (slotCode == 0) {
    return kNotAttributed;
  }
  const uint32_t claimedAt = claim >> kClaimSlotBits;
  const uint32_t elapsed = (claimTime() - claimedAt) & kClaimTimeMask;
  if (elapsed > kAttributionWindowMilliseconds) {
    return kNotAttributed;
  }
  return static_cast<int>(slotCode) - kClaimSlotOffset;
}

// Copies a consistent snapshot of the slot, or returns false while it is
// being rewritten.
void storeBytes(std::atomic<char> *destination, const char *source, size_t size) {
  for (size_t index = 0; index < size; ++index) {
    destination[index].store(source[index], std::memory_order_relaxed);
  }
}

void loadBytes(const std::atomic<char> *source, char *destination, size_t size) {
  for (size_t index = 0; index < size; ++index) {
    destination[index] = source[index].load(std::memory_order_relaxed);
  }
}

void storeSlotData(AtomicSlotData &destination, const SlotData &source) {
  storeBytes(destination.crashMarkerPath, source.crashMarkerPath, sizeof(source.crashMarkerPath));
  storeBytes(destination.bundleId, source.bundleId, sizeof(source.bundleId));
  destination.shouldRollback.store(source.shouldRollback, std::memory_order_relaxed);
  destination.writesWhenVerified.store(source.writesWhenVerified, std::memory_order_relaxed);
}

void loadSlotData(const AtomicSlotData &source, SlotData &destination) {
  loadBytes(source.crashMarkerPath, destination.crashMarkerPath, sizeof(destination.crashMarkerPath));
  loadBytes(source.bundleId, destination.bundleId, sizeof(destination.bundleId));
  destination.shouldRollback = source.shouldRollback.load(std::memory_order_relaxed);
  destination.writesWhenVerified = source.writesWhenVerified.load(std::memory_order_relaxed);
  // A copy taken mid-rewrite is rejected by the sequence, but the strings must
  // still end inside their buffers.
  destination.crashMarkerPath[sizeof(destination.crashMarkerPath) - 1] = '\0';
  destination.bundleId[sizeof(destination.bundleId) - 1] = '\0';
}

bool readSlot(const Slot &slot, SlotData &snapshot) {
  for (int attempt = 0; attempt < 4; ++attempt) {
    const uint32_t before = slot.sequence.load(std::memory_order_acquire);
    if ((before & 1U) != 0) {
      continue;
    }
    loadSlotData(slot.data, snapshot);
    std::atomic_thread_fence(std::memory_order_acquire);
    if (slot.sequence.load(std::memory_order_relaxed) == before) {
      return true;
    }
  }
  return false;
}

void writeCrashMarker(const SlotData &slot) {
  if (slot.crashMarkerPath[0] == '\0') {
    return;
  }

  const int fd = open(slot.crashMarkerPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
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
    write(fd, slot.bundleId, safeStringLength(slot.bundleId, kMaxBundleIdLength));
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

// HotUpdaterRecoverySlots.markerTargets: a claimed crash writes only its
// instance's marker; otherwise every launch still waiting for its first
// content writes one, and main records its launch either way.
void writeCrashMarkers() {
  const int attributed = attributedSlot();
  for (int index = 0; index < kSlotCount; ++index) {
    if (attributed != kNotAttributed && attributed != index) {
      continue;
    }
    SlotData slot;
    if (!readSlot(gSlots[index], slot) || slot.crashMarkerPath[0] == '\0') {
      continue;
    }
    if (slot.shouldRollback == 0 && slot.writesWhenVerified == 0) {
      continue;
    }
    writeCrashMarker(slot);
  }
}

void forwardToPreviousHandler(int signum, siginfo_t *info, void *context) {
  const struct sigaction &previousAction = gPreviousActions[signum];

  if ((previousAction.sa_flags & SA_SIGINFO) != 0 && previousAction.sa_sigaction != nullptr &&
      previousAction.sa_sigaction != signalHandler) {
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

void signalHandler(int signum, siginfo_t *info, void *context) {
  writeCrashMarkers();
  forwardToPreviousHandler(signum, info, context);
}
} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterRecoveryNative_nativeInstallSignalHandler(
    JNIEnv * /* env */,
    jclass /* clazz */) {
  struct sigaction action {};
  action.sa_sigaction = signalHandler;
  action.sa_flags = SA_SIGINFO | SA_ONSTACK;
  sigemptyset(&action.sa_mask);

  for (const int signum : kSignals) {
    // Installed once per process: recording this handler as the previous one
    // would make forwarding call itself.
    struct sigaction current {};
    if (sigaction(signum, nullptr, &current) == 0 && (current.sa_flags & SA_SIGINFO) != 0 &&
        current.sa_sigaction == signalHandler) {
      continue;
    }
    sigaction(signum, &action, &gPreviousActions[signum]);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterRecoveryNative_nativeUpdateSlot(
    JNIEnv *env,
    jclass /* clazz */,
    jint index,
    jstring crashMarkerPath,
    jstring bundleId,
    jboolean shouldRollback,
    jboolean writesWhenVerified) {
  if (index < 0 || index >= kSlotCount) {
    return;
  }

  // Copied before the sequence turns odd, so the window a crash skips stays
  // one copy long.
  SlotData next {};
  safeCopyJString(env, crashMarkerPath, next.crashMarkerPath, sizeof(next.crashMarkerPath));
  safeCopyJString(env, bundleId, next.bundleId, sizeof(next.bundleId));
  next.shouldRollback = shouldRollback ? 1 : 0;
  next.writesWhenVerified = writesWhenVerified ? 1 : 0;

  std::lock_guard<std::mutex> writer(gSlotWriters[index]);
  Slot &slot = gSlots[index];
  const uint32_t sequence = slot.sequence.load(std::memory_order_relaxed);
  slot.sequence.store(sequence + 1, std::memory_order_relaxed);
  std::atomic_thread_fence(std::memory_order_release);
  storeSlotData(slot.data, next);
  slot.sequence.store(sequence + 2, std::memory_order_release);
}

extern "C" JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterRecoveryNative_nativeAttributeCrash(
    JNIEnv * /* env */,
    jclass /* clazz */,
    jint index) {
  const int slot = (index >= 0 && index < kSlotCount) ? index : kAttributedWithoutSlot;
  const uint32_t slotCode = static_cast<uint32_t>(slot + kClaimSlotOffset);
  gClaim.store((claimTime() << kClaimSlotBits) | slotCode, std::memory_order_release);
}

extern "C" JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterRecoveryNative_nativeClearCrashAttribution(
    JNIEnv * /* env */,
    jclass /* clazz */) {
  gClaim.store(0, std::memory_order_release);
}
