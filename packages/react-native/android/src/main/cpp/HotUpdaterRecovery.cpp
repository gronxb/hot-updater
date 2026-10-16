#include <jni.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <cstring>
#include <limits.h>
#include <atomic>

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
// did not end the process must not claim a later crash.
constexpr long kAttributionWindowSeconds = 5;

struct Slot {
  char crashMarkerPath[PATH_MAX];
  char bundleId[kMaxBundleIdLength];
  // Read by the handler, so the strings above are written while it is 0.
  volatile sig_atomic_t inUse;
  volatile sig_atomic_t shouldRollback;
  // Main records a verified launch too, as it always has.
  volatile sig_atomic_t writesWhenVerified;
};

Slot gSlots[kSlotCount] = {};
volatile sig_atomic_t gAttributedSlot = kNotAttributed;
volatile sig_atomic_t gAttributedAtSeconds = 0;
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

// clock_gettime is async-signal-safe.
long monotonicSeconds() {
  struct timespec now {};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return 0;
  }
  return static_cast<long>(now.tv_sec);
}

int attributedSlot() {
  const int slot = gAttributedSlot;
  if (slot == kNotAttributed) {
    return kNotAttributed;
  }
  if (monotonicSeconds() - gAttributedAtSeconds > kAttributionWindowSeconds) {
    return kNotAttributed;
  }
  return slot;
}

void writeCrashMarker(const Slot &slot) {
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
    const Slot &slot = gSlots[index];
    if (slot.inUse == 0) {
      continue;
    }
    std::atomic_signal_fence(std::memory_order_seq_cst);
    if (attributed != kNotAttributed && attributed != index) {
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

  Slot &slot = gSlots[index];
  slot.inUse = 0;
  // The fences keep the compiler from moving the plain copies across the
  // flag, so the signal handler never reads a slot that is half rewritten.
  std::atomic_signal_fence(std::memory_order_seq_cst);
  safeCopyJString(env, crashMarkerPath, slot.crashMarkerPath, sizeof(slot.crashMarkerPath));
  safeCopyJString(env, bundleId, slot.bundleId, sizeof(slot.bundleId));
  slot.shouldRollback = shouldRollback ? 1 : 0;
  slot.writesWhenVerified = writesWhenVerified ? 1 : 0;
  std::atomic_signal_fence(std::memory_order_seq_cst);
  slot.inUse = 1;
}

extern "C" JNIEXPORT void JNICALL
Java_com_hotupdater_HotUpdaterRecoveryNative_nativeAttributeCrash(
    JNIEnv * /* env */,
    jclass /* clazz */,
    jint index) {
  gAttributedAtSeconds = static_cast<sig_atomic_t>(monotonicSeconds());
  gAttributedSlot = (index >= 0 && index < kSlotCount) ? index : kAttributedWithoutSlot;
}
