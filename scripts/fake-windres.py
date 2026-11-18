#!/usr/bin/env python3
"""Minimal windres stand-in for cross-compiling Tauri on macOS without llvm-rc.

- On probe (`-V /?`) prints a line containing "GNU windres" so embed-resource
  selects the windres code path.
- On compile (`windres --input ... --output <out> ...`) writes a valid empty
  COFF object (no resources). The linker accepts it; the .exe runs fine but
  has no embedded icon/version info (acceptable for a portable build).
"""
import sys
import struct

args = sys.argv[1:]
if '-V' in args or '/?' in args:
    print('GNU windres (fake stand-in for cross-build, no resources) 1.0')
    sys.exit(0)

out = None
for i, a in enumerate(args):
    if a == '--output' and i + 1 < len(args):
        out = args[i + 1]
    elif a.startswith('--output='):
        out = a.split('=', 1)[1]
if not out:
    sys.stderr.write('fake-windres: no --output given\n')
    sys.exit(1)

# IMAGE_FILE_HEADER: Machine=AMD64, 0 sections, no symbols
coff = struct.pack('<HHIIIHH', 0x8664, 0, 0, 0, 0, 0, 0)
with open(out, 'wb') as f:
    f.write(coff)
sys.exit(0)
