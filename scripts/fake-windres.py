#!/usr/bin/env python3
"""Minimal windres stand-in for cross-compiling Tauri on macOS without llvm-rc.

- On probe (`-V /?`) prints "GNU windres" so embed-resource selects the windres path.
- On compile writes a minimal empty COFF object. The linker produces a valid exe.
  The Common Controls v6 manifest is injected afterwards by inject-manifest.py
  (lld-link crashes on hand-built .rsrc COFF objects, so we do it as a PE post-step).
"""
import sys
import struct

args = sys.argv[1:]
if '-V' in args or '/?' in args:
    print('GNU windres (fake stand-in for cross-build) 1.0')
    sys.exit(0)

out = None
for i, a in enumerate(args):
    if a == '--output' and i + 1 < len(args):
        out = args[i + 1]
    elif a.startswith('--output='):
        out = a.split('=', 1)[1]
if not out:
    sys.stderr.write('fake-windres: need --output\n')
    sys.exit(1)

# Minimal COFF object: AMD64, 0 sections. Linker accepts it, no resources embedded.
with open(out, 'wb') as f:
    f.write(struct.pack('<HHIIIHH', 0x8664, 0, 0, 0, 0, 0, 0))
sys.exit(0)
