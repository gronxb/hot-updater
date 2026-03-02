#include "hotupdater_bspatch.h"

#include <bzlib.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

typedef struct {
  FILE *file;
  BZFILE *bz;
} bz_stream_t;

static void set_error(
    char *error_message,
    size_t error_message_len,
    const char *fmt,
    ...) {
  if (!error_message || error_message_len == 0) {
    return;
  }

  va_list args;
  va_start(args, fmt);
  vsnprintf(error_message, error_message_len, fmt, args);
  va_end(args);
}

static int64_t decode_signed_int64(const uint8_t buf[8]) {
  int64_t y;

  y = (int64_t)buf[7] & 0x7f;
  y = y * 256 + (int64_t)buf[6];
  y = y * 256 + (int64_t)buf[5];
  y = y * 256 + (int64_t)buf[4];
  y = y * 256 + (int64_t)buf[3];
  y = y * 256 + (int64_t)buf[2];
  y = y * 256 + (int64_t)buf[1];
  y = y * 256 + (int64_t)buf[0];

  if (buf[7] & 0x80) {
    y = -y;
  }

  return y;
}

static int close_bz_stream(bz_stream_t *stream) {
  if (!stream) {
    return 0;
  }

  if (stream->bz) {
    int bzerr = BZ_OK;
    BZ2_bzReadClose(&bzerr, stream->bz);
    stream->bz = NULL;
  }

  if (stream->file) {
    fclose(stream->file);
    stream->file = NULL;
  }

  return 0;
}

static int open_bz_stream(
    const char *patch_path,
    int64_t offset,
    bz_stream_t *stream,
    char *error_message,
    size_t error_message_len) {
  int bzerr = BZ_OK;
  FILE *file = NULL;
  BZFILE *bz = NULL;

  if (!patch_path || !stream || offset < 0) {
    set_error(error_message, error_message_len, "Invalid bz stream arguments");
    return -1;
  }

  file = fopen(patch_path, "rb");
  if (!file) {
    set_error(
        error_message,
        error_message_len,
        "Failed to open patch file '%s': %s",
        patch_path,
        strerror(errno));
    return -1;
  }

  if (fseeko(file, (off_t)offset, SEEK_SET) != 0) {
    set_error(
        error_message,
        error_message_len,
        "Failed to seek patch file to %lld: %s",
        (long long)offset,
        strerror(errno));
    fclose(file);
    return -1;
  }

  bz = BZ2_bzReadOpen(&bzerr, file, 0, 0, NULL, 0);
  if (bzerr != BZ_OK || !bz) {
    set_error(
        error_message,
        error_message_len,
        "Failed to open bzip2 stream at offset %lld (code=%d)",
        (long long)offset,
        bzerr);
    fclose(file);
    return -1;
  }

  stream->file = file;
  stream->bz = bz;
  return 0;
}

static int bz_read_exact(
    bz_stream_t *stream,
    uint8_t *out,
    int64_t len,
    char *error_message,
    size_t error_message_len) {
  int64_t read_total = 0;

  if (!stream || !stream->bz || !out || len < 0) {
    set_error(error_message, error_message_len, "Invalid bz read arguments");
    return -1;
  }

  while (read_total < len) {
    int to_read = len - read_total > INT_MAX ? INT_MAX : (int)(len - read_total);
    int bzerr = BZ_OK;
    int n = BZ2_bzRead(&bzerr, stream->bz, out + read_total, to_read);

    if (bzerr != BZ_OK && bzerr != BZ_STREAM_END) {
      set_error(
          error_message,
          error_message_len,
          "bzip2 read failed (code=%d)",
          bzerr);
      return -1;
    }

    if (n <= 0) {
      set_error(error_message, error_message_len, "Unexpected end of bzip2 stream");
      return -1;
    }

    read_total += n;

    if (bzerr == BZ_STREAM_END && read_total < len) {
      set_error(
          error_message,
          error_message_len,
          "bzip2 stream ended early (%lld/%lld bytes)",
          (long long)read_total,
          (long long)len);
      return -1;
    }
  }

  return 0;
}

static int read_file_fully(
    const char *path,
    uint8_t *buffer,
    int64_t size,
    char *error_message,
    size_t error_message_len) {
  FILE *file = NULL;
  size_t total = 0;

  if (!path || !buffer || size < 0) {
    set_error(error_message, error_message_len, "Invalid read file arguments");
    return -1;
  }

  file = fopen(path, "rb");
  if (!file) {
    set_error(
        error_message,
        error_message_len,
        "Failed to open file '%s': %s",
        path,
        strerror(errno));
    return -1;
  }

  while ((int64_t)total < size) {
    size_t chunk = (size_t)((int64_t)SIZE_MAX < (size - (int64_t)total)
                                ? SIZE_MAX
                                : (size - (int64_t)total));
    size_t n = fread(buffer + total, 1, chunk, file);
    if (n == 0) {
      if (ferror(file)) {
        set_error(
            error_message,
            error_message_len,
            "Failed to read file '%s'",
            path);
      } else {
        set_error(
            error_message,
            error_message_len,
            "Unexpected EOF while reading '%s'",
            path);
      }
      fclose(file);
      return -1;
    }
    total += n;
  }

  fclose(file);
  return 0;
}

int hotupdater_bspatch_file(
    const char *old_path,
    const char *patch_path,
    const char *new_path,
    char *error_message,
    size_t error_message_len) {
  int result = -1;
  uint8_t header[32];
  int64_t ctrl_len;
  int64_t diff_len;
  int64_t new_size;
  int64_t old_size;
  int64_t old_pos = 0;
  int64_t new_pos = 0;
  uint8_t *old_buf = NULL;
  uint8_t *new_buf = NULL;
  bz_stream_t ctrl_stream = {0};
  bz_stream_t diff_stream = {0};
  bz_stream_t extra_stream = {0};
  FILE *patch_file = NULL;
  FILE *new_file = NULL;
  struct stat old_stat;

  if (error_message && error_message_len > 0) {
    error_message[0] = '\0';
  }

  if (!old_path || !patch_path || !new_path) {
    set_error(error_message, error_message_len, "Invalid patch arguments");
    goto cleanup;
  }

  patch_file = fopen(patch_path, "rb");
  if (!patch_file) {
    set_error(
        error_message,
        error_message_len,
        "Failed to open patch file '%s': %s",
        patch_path,
        strerror(errno));
    goto cleanup;
  }

  if (fread(header, 1, sizeof(header), patch_file) != sizeof(header)) {
    set_error(error_message, error_message_len, "Failed to read patch header");
    goto cleanup;
  }

  fclose(patch_file);
  patch_file = NULL;

  if (memcmp(header, "BSDIFF40", 8) != 0) {
    set_error(error_message, error_message_len, "Invalid patch magic (expected BSDIFF40)");
    goto cleanup;
  }

  ctrl_len = decode_signed_int64(header + 8);
  diff_len = decode_signed_int64(header + 16);
  new_size = decode_signed_int64(header + 24);

  if (ctrl_len < 0 || diff_len < 0 || new_size < 0) {
    set_error(error_message, error_message_len, "Invalid patch block lengths");
    goto cleanup;
  }

  if (open_bz_stream(
          patch_path,
          32,
          &ctrl_stream,
          error_message,
          error_message_len) != 0) {
    goto cleanup;
  }

  if (open_bz_stream(
          patch_path,
          32 + ctrl_len,
          &diff_stream,
          error_message,
          error_message_len) != 0) {
    goto cleanup;
  }

  if (open_bz_stream(
          patch_path,
          32 + ctrl_len + diff_len,
          &extra_stream,
          error_message,
          error_message_len) != 0) {
    goto cleanup;
  }

  if (stat(old_path, &old_stat) != 0) {
    set_error(
        error_message,
        error_message_len,
        "Failed to stat old file '%s': %s",
        old_path,
        strerror(errno));
    goto cleanup;
  }

  old_size = (int64_t)old_stat.st_size;
  if (old_size < 0) {
    set_error(error_message, error_message_len, "Invalid old file size");
    goto cleanup;
  }

  if ((old_size > 0 && (uint64_t)old_size > (uint64_t)SIZE_MAX) ||
      (new_size > 0 && (uint64_t)new_size > (uint64_t)SIZE_MAX)) {
    set_error(error_message, error_message_len, "Patch size is too large");
    goto cleanup;
  }

  old_buf = (uint8_t *)malloc(old_size > 0 ? (size_t)old_size : 1);
  new_buf = (uint8_t *)malloc(new_size > 0 ? (size_t)new_size : 1);

  if (!old_buf || !new_buf) {
    set_error(error_message, error_message_len, "Failed to allocate patch buffers");
    goto cleanup;
  }

  if (old_size > 0 &&
      read_file_fully(
          old_path,
          old_buf,
          old_size,
          error_message,
          error_message_len) != 0) {
    goto cleanup;
  }

  while (new_pos < new_size) {
    int64_t ctrl[3];
    uint8_t ctrl_buf[8];
    int i;
    int64_t j;

    for (i = 0; i < 3; i++) {
      if (bz_read_exact(
              &ctrl_stream,
              ctrl_buf,
              8,
              error_message,
              error_message_len) != 0) {
        goto cleanup;
      }
      ctrl[i] = decode_signed_int64(ctrl_buf);
    }

    if (ctrl[0] < 0 || ctrl[1] < 0) {
      set_error(error_message, error_message_len, "Invalid control tuple values");
      goto cleanup;
    }

    if (new_pos + ctrl[0] > new_size) {
      set_error(error_message, error_message_len, "Corrupt patch (diff block exceeds new size)");
      goto cleanup;
    }

    if (ctrl[0] > 0 &&
        bz_read_exact(
            &diff_stream,
            new_buf + new_pos,
            ctrl[0],
            error_message,
            error_message_len) != 0) {
      goto cleanup;
    }

    for (j = 0; j < ctrl[0]; j++) {
      if ((old_pos + j >= 0) && (old_pos + j < old_size)) {
        new_buf[new_pos + j] += old_buf[old_pos + j];
      }
    }

    new_pos += ctrl[0];
    old_pos += ctrl[0];

    if (new_pos + ctrl[1] > new_size) {
      set_error(error_message, error_message_len, "Corrupt patch (extra block exceeds new size)");
      goto cleanup;
    }

    if (ctrl[1] > 0 &&
        bz_read_exact(
            &extra_stream,
            new_buf + new_pos,
            ctrl[1],
            error_message,
            error_message_len) != 0) {
      goto cleanup;
    }

    new_pos += ctrl[1];
    old_pos += ctrl[2];
  }

  new_file = fopen(new_path, "wb");
  if (!new_file) {
    set_error(
        error_message,
        error_message_len,
        "Failed to open output file '%s': %s",
        new_path,
        strerror(errno));
    goto cleanup;
  }

  if (new_size > 0 &&
      fwrite(new_buf, 1, (size_t)new_size, new_file) != (size_t)new_size) {
    set_error(error_message, error_message_len, "Failed to write patched output");
    goto cleanup;
  }

  if (fclose(new_file) != 0) {
    new_file = NULL;
    set_error(error_message, error_message_len, "Failed to finalize patched output file");
    goto cleanup;
  }
  new_file = NULL;

  result = 0;

cleanup:
  if (new_file) {
    fclose(new_file);
  }
  if (patch_file) {
    fclose(patch_file);
  }
  close_bz_stream(&ctrl_stream);
  close_bz_stream(&diff_stream);
  close_bz_stream(&extra_stream);
  free(old_buf);
  free(new_buf);

  return result;
}
