#!/usr/bin/env python3
"""Inject a Common Controls v6 manifest (RT_MANIFEST) into a Windows PE .exe.

Used after cross-compiling on macOS: lld-link cannot be fed a hand-built .rsrc
COFF object without crashing, so we patch the final PE directly.

Usage: inject-manifest.py <exe> <manifest.xml>
"""
import sys
import struct

def align(n, a):
    return (n + a - 1) & ~(a - 1)

def build_rsrc(manifest_bytes):
    """Build a PE resource directory tree: type 24 (RT_MANIFEST) → id 1 → lang 0x409."""
    # Layout offsets relative to resource section start
    TYPE_DIR, NAME_DIR, LANG_DIR, DATA_ENTRY, DATA = 0, 24, 48, 72, 88
    r = bytearray()
    r += struct.pack('<IIHHHH', 0, 0, 0, 0, 0, 1)
    r += struct.pack('<II', 0x80000000 | 24, NAME_DIR)      # RT_MANIFEST
    r += struct.pack('<IIHHHH', 0, 0, 0, 0, 0, 1)
    r += struct.pack('<II', 0x80000000 | 1, LANG_DIR)       # CREATEPROCESS_MANIFEST_RESOURCE_ID
    r += struct.pack('<IIHHHH', 0, 0, 0, 0, 0, 1)
    r += struct.pack('<II', 0x80000000 | 0x409, DATA_ENTRY) # lang 1033
    r += struct.pack('<IIII', DATA, len(manifest_bytes), 0, 0)
    r += manifest_bytes
    return bytes(r)

def inject(exe_path, manifest_path):
    data = bytearray(open(exe_path, 'rb').read())
    manifest = open(manifest_path, 'rb').read()

    pe = struct.unpack_from('<I', data, 0x3c)[0]
    assert data[pe:pe+4] == b'PE\x00\x00', 'not a PE file'
    coff = pe + 4
    nsec = struct.unpack_from('<H', data, coff + 2)[0]
    opt_size = struct.unpack_from('<H', data, coff + 16)[0]
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    is64 = magic == 0x20b
    file_align = struct.unpack_from('<I', data, opt + 36)[0]
    size_headers = struct.unpack_from('<I', data, opt + 60)[0]
    sec_tab = opt + opt_size

    # Refuse if .rsrc already present
    for i in range(nsec):
        nm = bytes(data[sec_tab + i*40: sec_tab + i*40 + 8]).rstrip(b'\x00')
        if nm == b'.rsrc':
            print('manifest: .rsrc already present, skipping')
            return

    rsrc = build_rsrc(manifest)

    # Append new .rsrc section at end of file, aligned to file alignment
    raw_off = align(len(data), file_align)
    # VirtualAddress: after last section's virtual end, aligned to 0x1000
    va = 0x1000
    for i in range(nsec):
        s = sec_tab + i*40
        sec_va = struct.unpack_from('<I', data, s + 12)[0]
        sec_vsize = struct.unpack_from('<I', data, s + 8)[0]
        sec_raww = struct.unpack_from('<I', data, s + 16)[0]
        va = max(va, align(sec_va + max(sec_vsize, sec_raww), 0x1000))

    data += b'\x00' * (raw_off - len(data))
    data += rsrc

    # New section header
    sh = bytearray(40)
    sh[0:8] = b'.rsrc\x00\x00\x00'
    struct.pack_into('<I', sh, 8, len(rsrc))       # VirtualSize
    struct.pack_into('<I', sh, 12, va)             # VirtualAddress
    struct.pack_into('<I', sh, 16, align(len(rsrc), file_align))  # SizeOfRawData
    struct.pack_into('<I', sh, 20, raw_off)        # PointerToRawData
    struct.pack_into('<I', sh, 36, 0x40000040)     # INITIALIZED_DATA | READ
    # Write section header into (previously unused) header slot
    data[sec_tab + nsec*40: sec_tab + nsec*40 + 40] = sh
    struct.pack_into('<H', data, coff + 2, nsec + 1)  # NumberOfSections++

    # Update SizeOfImage in optional header (offset 56 for both PE32 and PE32+)
    size_image = struct.unpack_from('<I', data, opt + 56)[0]
    struct.pack_into('<I', data, opt + 56, align(size_image + len(rsrc), 0x1000))

    open(exe_path, 'wb').write(data)
    print('manifest: injected RT_MANIFEST (%d bytes) at 0x%x' % (len(rsrc), raw_off))

if __name__ == '__main__':
    inject(sys.argv[1], sys.argv[2])
