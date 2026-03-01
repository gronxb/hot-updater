use bzip2::read::BzDecoder;
use bzip2::write::BzEncoder;
use bzip2::Compression;
use std::io::Cursor;
use std::io::Read;
use std::io::Write;

const MIN_HEADER_LEN: u32 = 128;
const EXEC_MAGIC_LO: u32 = 0x03BC_1FC6;
const EXEC_MAGIC_HI: u32 = 0x1F19_03C1;
const DELTA_MAGIC_LO: u32 = 0xFC43_E039;
const DELTA_MAGIC_HI: u32 = 0xE0E6_FC3E;

const OFFSET_VERSION: u32 = 8;
const OFFSET_FILE_LENGTH: u32 = 32;
const OFFSET_MAGIC_HI: u32 = 4;

const VALIDATE_OK: u32 = 0;
const VALIDATE_TOO_SMALL: u32 = 1;
const VALIDATE_INVALID_MAGIC: u32 = 2;
const VALIDATE_DELTA_MAGIC: u32 = 3;
const VALIDATE_INVALID_LENGTH: u32 = 4;

const STATUS_OK: u32 = 0;
const STATUS_INVALID_INPUT: u32 = 1;
const STATUS_PATCH_FAILED: u32 = 2;
const STATUS_INVALID_PATCH: u32 = 3;

static mut LAST_OUTPUT_PTR: *mut u8 = std::ptr::null_mut();
static mut LAST_OUTPUT_LEN: usize = 0;
static mut LAST_OUTPUT_CAP: usize = 0;

#[no_mangle]
pub unsafe extern "C" fn validate(ptr: u32, len: u32) -> u32 {
    if len < MIN_HEADER_LEN {
        return VALIDATE_TOO_SMALL;
    }

    let magic_lo = read_u32(ptr);
    let magic_hi = read_u32(ptr.wrapping_add(OFFSET_MAGIC_HI));

    if magic_lo == EXEC_MAGIC_LO {
        if magic_hi != EXEC_MAGIC_HI {
            return VALIDATE_INVALID_MAGIC;
        }
    } else {
        if magic_lo == DELTA_MAGIC_LO && magic_hi == DELTA_MAGIC_HI {
            return VALIDATE_DELTA_MAGIC;
        }
        return VALIDATE_INVALID_MAGIC;
    }

    let file_length = read_u32(ptr.wrapping_add(OFFSET_FILE_LENGTH));
    if file_length != len {
        return VALIDATE_INVALID_LENGTH;
    }

    VALIDATE_OK
}

#[no_mangle]
pub unsafe extern "C" fn version(ptr: u32) -> u32 {
    read_u32(ptr.wrapping_add(OFFSET_VERSION))
}

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> u32 {
    let mut bytes = Vec::<u8>::with_capacity(len as usize);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr as u32
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: u32, len: u32) {
    if ptr == 0 || len == 0 {
        return;
    }

    drop(Vec::from_raw_parts(
        ptr as *mut u8,
        len as usize,
        len as usize,
    ));
}

#[no_mangle]
pub unsafe extern "C" fn create_patch(
    base_ptr: u32,
    base_len: u32,
    next_ptr: u32,
    next_len: u32,
) -> u32 {
    let base = match copy_input(base_ptr, base_len) {
        Ok(base) => base,
        Err(_) => return STATUS_INVALID_INPUT,
    };
    let next = match copy_input(next_ptr, next_len) {
        Ok(next) => next,
        Err(_) => return STATUS_INVALID_INPUT,
    };

    match generate_bsdiff40_patch(&base, &next) {
        Ok(patch) => {
            store_output(patch);
            STATUS_OK
        }
        Err(_) => STATUS_PATCH_FAILED,
    }
}

#[no_mangle]
pub unsafe extern "C" fn apply_patch(
    base_ptr: u32,
    base_len: u32,
    patch_ptr: u32,
    patch_len: u32,
) -> u32 {
    let base = match copy_input(base_ptr, base_len) {
        Ok(base) => base,
        Err(_) => return STATUS_INVALID_INPUT,
    };
    let patch = match copy_input(patch_ptr, patch_len) {
        Ok(patch) => patch,
        Err(_) => return STATUS_INVALID_INPUT,
    };

    match apply_bsdiff40_patch(&base, &patch) {
        Ok(next) => {
            store_output(next);
            STATUS_OK
        }
        Err(_) => STATUS_INVALID_PATCH,
    }
}

#[no_mangle]
pub extern "C" fn output_ptr() -> u32 {
    unsafe { LAST_OUTPUT_PTR as u32 }
}

#[no_mangle]
pub extern "C" fn output_len() -> u32 {
    unsafe { LAST_OUTPUT_LEN as u32 }
}

#[no_mangle]
pub extern "C" fn free_output() {
    unsafe {
        free_output_buffer();
    }
}

#[inline]
unsafe fn read_u32(ptr: u32) -> u32 {
    std::ptr::read_unaligned(ptr as *const u32)
}

unsafe fn copy_input(ptr: u32, len: u32) -> Result<Vec<u8>, ()> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if ptr == 0 {
        return Err(());
    }

    let bytes = std::slice::from_raw_parts(ptr as *const u8, len as usize);
    Ok(bytes.to_vec())
}

fn store_output(bytes: Vec<u8>) {
    unsafe {
        free_output_buffer();

        let mut output = bytes;
        LAST_OUTPUT_PTR = output.as_mut_ptr();
        LAST_OUTPUT_LEN = output.len();
        LAST_OUTPUT_CAP = output.capacity();
        std::mem::forget(output);
    }
}

unsafe fn free_output_buffer() {
    if LAST_OUTPUT_PTR.is_null() {
        LAST_OUTPUT_LEN = 0;
        LAST_OUTPUT_CAP = 0;
        return;
    }

    drop(Vec::from_raw_parts(
        LAST_OUTPUT_PTR,
        LAST_OUTPUT_LEN,
        LAST_OUTPUT_CAP,
    ));
    LAST_OUTPUT_PTR = std::ptr::null_mut();
    LAST_OUTPUT_LEN = 0;
    LAST_OUTPUT_CAP = 0;
}

fn generate_bsdiff40_patch(old: &[u8], new: &[u8]) -> Result<Vec<u8>, String> {
    let mut legacy_patch = Vec::new();
    bsdiff::diff(old, new, &mut legacy_patch).map_err(|error| format!("{error}"))?;

    let (ctrl_block, diff_block, extra_block) = split_legacy_patch(&legacy_patch)?;

    let ctrl_bz = bzip2_compress(&ctrl_block)?;
    let diff_bz = bzip2_compress(&diff_block)?;
    let extra_bz = bzip2_compress(&extra_block)?;

    let mut patch = Vec::with_capacity(32 + ctrl_bz.len() + diff_bz.len() + extra_bz.len());
    patch.extend_from_slice(b"BSDIFF40");
    write_offt(ctrl_bz.len() as i64, &mut patch)?;
    write_offt(diff_bz.len() as i64, &mut patch)?;
    write_offt(new.len() as i64, &mut patch)?;
    patch.extend_from_slice(&ctrl_bz);
    patch.extend_from_slice(&diff_bz);
    patch.extend_from_slice(&extra_bz);

    Ok(patch)
}

fn split_legacy_patch(legacy_patch: &[u8]) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    let mut controls = Vec::new();
    let mut diff_data = Vec::new();
    let mut extra_data = Vec::new();

    let mut cursor = 0usize;
    while cursor < legacy_patch.len() {
        if legacy_patch.len() - cursor < 24 {
            return Err("invalid legacy patch control length".to_string());
        }

        let ctrl_bytes = &legacy_patch[cursor..cursor + 24];
        let add_len = read_offt(&ctrl_bytes[0..8])?;
        let copy_len = read_offt(&ctrl_bytes[8..16])?;
        let _seek = read_offt(&ctrl_bytes[16..24])?;

        if add_len < 0 || copy_len < 0 {
            return Err("invalid legacy patch control values".to_string());
        }

        let add_len = usize::try_from(add_len).map_err(|_| "add length overflow".to_string())?;
        let copy_len =
            usize::try_from(copy_len).map_err(|_| "copy length overflow".to_string())?;
        cursor += 24;

        if legacy_patch.len() - cursor < add_len {
            return Err("legacy patch truncated in diff section".to_string());
        }
        diff_data.extend_from_slice(&legacy_patch[cursor..cursor + add_len]);
        cursor += add_len;

        if legacy_patch.len() - cursor < copy_len {
            return Err("legacy patch truncated in extra section".to_string());
        }
        extra_data.extend_from_slice(&legacy_patch[cursor..cursor + copy_len]);
        cursor += copy_len;

        controls.extend_from_slice(ctrl_bytes);
    }

    Ok((controls, diff_data, extra_data))
}

fn apply_bsdiff40_patch(old: &[u8], patch: &[u8]) -> Result<Vec<u8>, String> {
    if patch.len() < 32 || &patch[0..8] != b"BSDIFF40" {
        return Err("invalid BSDIFF40 header".to_string());
    }

    let ctrl_len = read_offt(&patch[8..16])?;
    let diff_len = read_offt(&patch[16..24])?;
    let new_size = read_offt(&patch[24..32])?;
    if ctrl_len < 0 || diff_len < 0 || new_size < 0 {
        return Err("negative BSDIFF40 header values".to_string());
    }

    let ctrl_len = usize::try_from(ctrl_len).map_err(|_| "control length overflow".to_string())?;
    let diff_len = usize::try_from(diff_len).map_err(|_| "diff length overflow".to_string())?;
    let new_size = usize::try_from(new_size).map_err(|_| "new size overflow".to_string())?;

    let ctrl_start = 32usize;
    let ctrl_end = ctrl_start
        .checked_add(ctrl_len)
        .ok_or_else(|| "control block overflow".to_string())?;
    let diff_end = ctrl_end
        .checked_add(diff_len)
        .ok_or_else(|| "diff block overflow".to_string())?;
    if diff_end > patch.len() {
        return Err("BSDIFF40 block bounds are invalid".to_string());
    }

    let mut ctrl_reader = BzDecoder::new(Cursor::new(&patch[ctrl_start..ctrl_end]));
    let mut diff_reader = BzDecoder::new(Cursor::new(&patch[ctrl_end..diff_end]));
    let mut extra_reader = BzDecoder::new(Cursor::new(&patch[diff_end..]));

    let mut out = Vec::with_capacity(new_size);
    let mut old_pos: i64 = 0;

    while out.len() < new_size {
        let mut ctrl_buf = [0u8; 24];
        ctrl_reader
            .read_exact(&mut ctrl_buf)
            .map_err(|error| format!("failed to read control block: {error}"))?;

        let add_len = read_offt(&ctrl_buf[0..8])?;
        let copy_len = read_offt(&ctrl_buf[8..16])?;
        let seek_len = read_offt(&ctrl_buf[16..24])?;
        if add_len < 0 || copy_len < 0 {
            return Err("negative add/copy length in control block".to_string());
        }

        let add_len = usize::try_from(add_len).map_err(|_| "add length overflow".to_string())?;
        let copy_len =
            usize::try_from(copy_len).map_err(|_| "copy length overflow".to_string())?;

        let mut diff_bytes = vec![0u8; add_len];
        diff_reader
            .read_exact(&mut diff_bytes)
            .map_err(|error| format!("failed to read diff block: {error}"))?;
        for delta_byte in diff_bytes {
            if old_pos < 0 || old_pos as usize >= old.len() {
                return Err("old file offset out of bounds".to_string());
            }
            let old_byte = old[old_pos as usize];
            out.push(delta_byte.wrapping_add(old_byte));
            old_pos += 1;
        }

        let mut extra_bytes = vec![0u8; copy_len];
        extra_reader
            .read_exact(&mut extra_bytes)
            .map_err(|error| format!("failed to read extra block: {error}"))?;
        out.extend_from_slice(&extra_bytes);

        old_pos = old_pos
            .checked_add(seek_len)
            .ok_or_else(|| "old file seek overflow".to_string())?;

        if out.len() > new_size {
            return Err("patch output exceeds target size".to_string());
        }
    }

    if out.len() != new_size {
        return Err("patch output length mismatch".to_string());
    }

    Ok(out)
}

fn bzip2_compress(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = BzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(input).map_err(|error| format!("{error}"))?;
    encoder.finish().map_err(|error| format!("{error}"))
}

fn read_offt(bytes: &[u8]) -> Result<i64, String> {
    if bytes.len() < 8 {
        return Err("offset bytes too short".to_string());
    }

    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[0..8]);
    let value = i64::from_le_bytes(raw);
    if value & (1_i64 << 63) == 0 {
        Ok(value)
    } else {
        Ok(-(value & !(1_i64 << 63)))
    }
}

fn write_offt(value: i64, out: &mut Vec<u8>) -> Result<(), String> {
    if value < 0 {
        return Err("negative header value".to_string());
    }

    let encoded = u64::try_from(value).map_err(|_| "header value overflow".to_string())?;
    out.extend_from_slice(&encoded.to_le_bytes());
    Ok(())
}
