#!/usr/bin/env bash
# 在 macOS 上交叉编译 FeatherMark 的 Windows x86-64 便携版。
# 前置（只需一次）：
#   rustup target add x86_64-pc-windows-msvc
#   rustup component add llvm-tools-preview
#   cargo install cargo-xwin --locked
#   ln -s "$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | awk '/host:/{print $2}')/bin/llvm-ar" /usr/local/bin/llvm-lib
# 说明：macOS 缺少 llvm-rc，用 scripts/fake-windres.py 代替（生成的 exe 无图标，功能完整）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHIM="$(mktemp -d)"
ln -s "$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | awk '/host:/{print $2}')/bin/llvm-ar" "$SHIM/llvm-lib"
cp "$ROOT/scripts/fake-windres.py" "$SHIM/windres"
chmod +x "$SHIM/windres"

echo "==> 构建前端资源"
cd "$ROOT" && npm run assets

echo "==> 交叉编译 Windows exe（首次会下载 Windows SDK）"
cd "$ROOT/src-tauri"
PATH="$SHIM:$PATH" RC="$SHIM/windres" cargo xwin build --release --target x86_64-pc-windows-msvc

EXE="$ROOT/src-tauri/target/x86_64-pc-windows-msvc/release/feathermark.exe"
[ -f "$EXE" ] || { echo "exe 未生成" >&2; exit 1; }

VERSION="$(grep -m1 '"version"' "$ROOT/package.json" | sed -E 's/.*"version": "([^"]+)".*/\1/')"
TAG="$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || echo "$VERSION")"
OUT="$ROOT/FeatherMark-${TAG}-windows-x64"
DIST="$(mktemp -d)/FeatherMark"
mkdir -p "$DIST"
cp "$EXE" "$DIST/"
cat > "$DIST/README.txt" <<TXT
FeatherMark 便携版 (Windows x86-64, $TAG)

运行：双击 feathermark.exe，无需安装。
系统要求：Windows 10/11 64 位 + Edge WebView2（Win11 及多数 Win10 已预装）。
说明：绿色便携版，配置存于用户目录；交叉编译未嵌入应用图标，功能不受影响。
TXT
cd "$(dirname "$DIST")" && zip -qr "$OUT.zip" FeatherMark
rm -rf "$SHIM"
echo "==> 完成：$OUT.zip"
ls -lh "$OUT.zip"
