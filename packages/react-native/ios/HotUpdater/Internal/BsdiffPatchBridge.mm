#import "BsdiffPatchBridge.h"

#include <algorithm>
#include <bzlib.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {
constexpr NSUInteger kBzipChunkSize = 64 * 1024;

NSError *MakePatchError(NSString *message) {
  return [NSError errorWithDomain:@"HotUpdater.Bsdiff"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

NSError *MakeSystemError(NSString *message) {
  return MakePatchError(
      [NSString stringWithFormat:@"%@: %s", message, strerror(errno)]);
}

int64_t ReadOfft(const uint8_t *bytes) {
  uint64_t value = 0;
  for (NSUInteger index = 0; index < 8; index += 1) {
    value |= (static_cast<uint64_t>(bytes[index]) << (index * 8));
  }

  if ((value & (1ULL << 63)) == 0) {
    return static_cast<int64_t>(value);
  }

  return -static_cast<int64_t>(value & ~(1ULL << 63));
}

bool CheckedAddInt64(int64_t left, int64_t right, int64_t *result) {
  if ((right > 0 && left > INT64_MAX - right) ||
      (right < 0 && left < INT64_MIN - right)) {
    return false;
  }
  *result = left + right;
  return true;
}

bool ReadBzipExactly(BZFILE *bz2,
                     void *buffer,
                     size_t length,
                     NSError **error) {
  auto *bytes = reinterpret_cast<uint8_t *>(buffer);
  size_t offset = 0;

  while (offset < length) {
    int bz2err = BZ_OK;
    int request = static_cast<int>(
        std::min<size_t>(length - offset, static_cast<size_t>(INT_MAX)));
    int read = BZ2_bzRead(&bz2err, bz2, bytes + offset, request);
    if (bz2err != BZ_OK && bz2err != BZ_STREAM_END) {
      if (error) {
        *error = MakePatchError(@"Failed to read bzip stream");
      }
      return false;
    }

    if (read <= 0) {
      if (error) {
        *error = MakePatchError(@"Unexpected end of ENDSLEY/BSDIFF43 stream");
      }
      return false;
    }

    offset += static_cast<size_t>(read);
    if (bz2err == BZ_STREAM_END && offset < length) {
      if (error) {
        *error = MakePatchError(@"Unexpected end of ENDSLEY/BSDIFF43 stream");
      }
      return false;
    }
  }

  return true;
}

bool WriteAll(FILE *file, const uint8_t *buffer, size_t length, NSError **error) {
  size_t written = 0;
  while (written < length) {
    size_t result = fwrite(buffer + written, 1, length - written, file);
    if (result == 0) {
      if (error) {
        *error = MakeSystemError(@"Failed to write patch output");
      }
      return false;
    }
    written += result;
  }
  return true;
}

bool ReadBaseAt(int baseFd,
                off_t baseSize,
                int64_t offset,
                uint8_t *target,
                size_t count,
                NSError **error) {
  memset(target, 0, count);
  if (count == 0 || offset >= baseSize ||
      offset > INT64_MAX - static_cast<int64_t>(count) ||
      offset + static_cast<int64_t>(count) <= 0) {
    return true;
  }

  int64_t validStart = std::max<int64_t>(offset, 0);
  int64_t validEnd = std::min<int64_t>(
      offset + static_cast<int64_t>(count),
      static_cast<int64_t>(baseSize));
  if (validStart >= validEnd) {
    return true;
  }

  size_t targetOffset = static_cast<size_t>(validStart - offset);
  size_t validLength = static_cast<size_t>(validEnd - validStart);
  size_t totalRead = 0;
  while (totalRead < validLength) {
    ssize_t read = pread(
        baseFd,
        target + targetOffset + totalRead,
        validLength - totalRead,
        static_cast<off_t>(validStart + static_cast<int64_t>(totalRead)));
    if (read <= 0) {
      if (error) {
        *error = MakeSystemError(@"Failed to read base file");
      }
      return false;
    }
    totalRead += static_cast<size_t>(read);
  }
  return true;
}
}  // namespace

extern "C" BOOL HotUpdaterApplyBsdiffPatch(NSString *patchPath,
                                            NSString *basePath,
                                            NSString *outputPath) {
  NSError *patchError = nil;
  BOOL applied = [BsdiffPatchBridge applyPatchAtPath:patchPath
                                         toBaseAtPath:basePath
                                        outputAtPath:outputPath
                                               error:&patchError];
  if (!applied && patchError != nil) {
    NSLog(@"[BundleStorage] Failed to apply bsdiff patch: %@",
          patchError.localizedDescription);
  }
  return applied;
}

@implementation BsdiffPatchBridge

+ (BOOL)applyPatchAtPath:(NSString *)patchPath
             toBaseAtPath:(NSString *)basePath
            outputAtPath:(NSString *)outputPath
                   error:(NSError * _Nullable __autoreleasing *)error {
  FILE *patchFile = nullptr;
  FILE *outputFile = nullptr;
  BZFILE *bz2 = nullptr;
  int baseFd = -1;
  BOOL success = NO;
  NSString *tempOutputPath = [outputPath stringByAppendingString:@".tmp"];

  auto cleanup = [&]() {
    if (bz2 != nullptr) {
      int bz2err = BZ_OK;
      BZ2_bzReadClose(&bz2err, bz2);
      bz2 = nullptr;
    }
    if (patchFile != nullptr) {
      fclose(patchFile);
      patchFile = nullptr;
    }
    if (baseFd >= 0) {
      close(baseFd);
      baseFd = -1;
    }
    if (outputFile != nullptr) {
      fclose(outputFile);
      outputFile = nullptr;
    }
    if (!success) {
      unlink(tempOutputPath.fileSystemRepresentation);
    }
  };

  auto fail = [&](NSError *patchError) {
    if (error) {
      *error = patchError;
    }
    cleanup();
    return NO;
  };

  auto failMessage = [&](NSString *message) {
    return fail(MakePatchError(message));
  };

  patchFile = fopen(patchPath.fileSystemRepresentation, "rb");
  if (patchFile == nullptr) {
    return fail(MakeSystemError(@"Failed to open patch file"));
  }

  uint8_t header[24];
  if (fread(header, 1, sizeof(header), patchFile) != sizeof(header)) {
    return failMessage(@"Invalid ENDSLEY/BSDIFF43 header");
  }

  if (memcmp(header, "ENDSLEY/BSDIFF43", 16) != 0) {
    return failMessage(@"Invalid ENDSLEY/BSDIFF43 header");
  }

  int64_t newSize = ReadOfft(header + 16);

  if (newSize < 0) {
    return failMessage(@"Negative ENDSLEY/BSDIFF43 target size");
  }

  if (static_cast<uint64_t>(newSize) > NSUIntegerMax) {
    return failMessage(@"Target file is too large");
  }

  baseFd = open(basePath.fileSystemRepresentation, O_RDONLY);
  if (baseFd < 0) {
    return fail(MakeSystemError(@"Failed to open base file"));
  }

  struct stat baseStat {};
  if (fstat(baseFd, &baseStat) != 0) {
    return fail(MakeSystemError(@"Failed to stat base file"));
  }

  unlink(tempOutputPath.fileSystemRepresentation);
  outputFile = fopen(tempOutputPath.fileSystemRepresentation, "wb");
  if (outputFile == nullptr) {
    return fail(MakeSystemError(@"Failed to open patch output file"));
  }

  int bz2err = BZ_OK;
  bz2 = BZ2_bzReadOpen(&bz2err, patchFile, 0, 0, nullptr, 0);
  if (bz2 == nullptr || bz2err != BZ_OK) {
    return failMessage(@"Failed to initialize bzip stream");
  }

  std::vector<uint8_t> diffBuffer(kBzipChunkSize);
  std::vector<uint8_t> baseBuffer(kBzipChunkSize);
  std::vector<uint8_t> outputBuffer(kBzipChunkSize);
  int64_t outputPos = 0;
  int64_t oldPos = 0;

  while (outputPos < newSize) {
    uint8_t controlBytes[24];
    if (!ReadBzipExactly(bz2, controlBytes, sizeof(controlBytes), error)) {
      cleanup();
      return NO;
    }

    int64_t addLen = ReadOfft(controlBytes);
    int64_t copyLen = ReadOfft(controlBytes + 8);
    int64_t seekLen = ReadOfft(controlBytes + 16);

    if (addLen < 0 || copyLen < 0) {
      return failMessage(@"Negative add/copy length in control block");
    }

    int64_t remainingOutput = newSize - outputPos;

    if (addLen > remainingOutput || copyLen > remainingOutput - addLen) {
      return failMessage(@"ENDSLEY/BSDIFF43 stream is truncated");
    }

    size_t remainingAdd = static_cast<size_t>(addLen);
    while (remainingAdd > 0) {
      size_t chunkSize = std::min<size_t>(remainingAdd, kBzipChunkSize);
      if (!ReadBzipExactly(bz2, diffBuffer.data(), chunkSize, error) ||
          !ReadBaseAt(baseFd, baseStat.st_size, oldPos, baseBuffer.data(), chunkSize, error)) {
        cleanup();
        return NO;
      }

      for (size_t index = 0; index < chunkSize; index += 1) {
        outputBuffer[index] = static_cast<uint8_t>(
            (diffBuffer[index] + baseBuffer[index]) & 0xFF);
      }

      if (!WriteAll(outputFile, outputBuffer.data(), chunkSize, error)) {
        cleanup();
        return NO;
      }

      int64_t nextOldPos = 0;
      if (!CheckedAddInt64(oldPos, static_cast<int64_t>(chunkSize), &nextOldPos)) {
        return failMessage(@"Old file seek overflow");
      }
      oldPos = nextOldPos;
      outputPos += static_cast<int64_t>(chunkSize);
      remainingAdd -= chunkSize;
    }

    size_t remainingCopy = static_cast<size_t>(copyLen);
    while (remainingCopy > 0) {
      size_t chunkSize = std::min<size_t>(remainingCopy, kBzipChunkSize);
      if (!ReadBzipExactly(bz2, diffBuffer.data(), chunkSize, error) ||
          !WriteAll(outputFile, diffBuffer.data(), chunkSize, error)) {
        cleanup();
        return NO;
      }
      outputPos += static_cast<int64_t>(chunkSize);
      remainingCopy -= chunkSize;
    }

    int64_t nextOldPos = 0;
    if (!CheckedAddInt64(oldPos, seekLen, &nextOldPos)) {
      return failMessage(@"Old file seek overflow");
    }
    oldPos = nextOldPos;
  }

  if (fclose(outputFile) != 0) {
    outputFile = nullptr;
    return fail(MakeSystemError(@"Failed to close patch output file"));
  }
  outputFile = nullptr;

  if (rename(tempOutputPath.fileSystemRepresentation,
             outputPath.fileSystemRepresentation) != 0) {
    return fail(MakeSystemError(@"Failed to move patch output file"));
  }

  success = YES;
  cleanup();
  return YES;
}

@end
