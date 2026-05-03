use bzip2::read::BzDecoder;
use bzip2::write::BzEncoder;
use bzip2::Compression;
use std::io::Cursor;
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

    match generate_endsley_bsdiff43_patch(&base, &next) {
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

    match apply_endsley_bsdiff43_patch(&base, &patch) {
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

fn generate_endsley_bsdiff43_patch(old: &[u8], new: &[u8]) -> Result<Vec<u8>, String> {
    let mut legacy_patch = Vec::new();
    bsdiff::diff(old, new, &mut legacy_patch).map_err(|error| format!("{error}"))?;

    let compressed_patch = bzip2_compress(&legacy_patch)?;

    let mut patch = Vec::with_capacity(24 + compressed_patch.len());
    patch.extend_from_slice(b"ENDSLEY/BSDIFF43");
    write_offt(new.len() as i64, &mut patch)?;
    patch.extend_from_slice(&compressed_patch);

    Ok(patch)
}

fn apply_endsley_bsdiff43_patch(old: &[u8], patch: &[u8]) -> Result<Vec<u8>, String> {
    if patch.len() < 24 || &patch[0..16] != b"ENDSLEY/BSDIFF43" {
        return Err("invalid ENDSLEY/BSDIFF43 header".to_string());
    }

    let new_size = read_offt(&patch[16..24])?;
    if new_size < 0 {
        return Err("negative ENDSLEY/BSDIFF43 target size".to_string());
    }

    let new_size = usize::try_from(new_size).map_err(|_| "new size overflow".to_string())?;
    let mut patch_reader = BzDecoder::new(Cursor::new(&patch[24..]));
    let mut output = Vec::with_capacity(new_size);

    bsdiff::patch(old, &mut patch_reader, &mut output).map_err(|error| format!("{error}"))?;

    if output.len() != new_size {
        return Err("patch output length mismatch".to_string());
    }

    Ok(output)
}

fn bzip2_compress(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = BzEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(input)
        .map_err(|error| format!("{error}"))?;
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
