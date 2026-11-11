#!/bin/bash
# Rebuild our GPL FFmpeg helpers from the exact accompanying source archives.
# Requires existing Apple Command Line Tools, make, git, curl and pkg-config.
set -euo pipefail
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_SHA256=4f1c35d11c7b09ca1a88affb914e1fc3daee888732786a66e51af4f786962c44
ROOT=${1:?Usage: build-ffmpeg-source-mac.sh BUILD_DIRECTORY [JOBS]}
JOBS=${2:-8}
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Apple Silicon macOS required' >&2; exit 1; }
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo 'JOBS must be a positive integer' >&2; exit 1; }
PKG_CONFIG_TOOL=$(command -v pkg-config) || { echo 'An existing pkg-config is required' >&2; exit 1; }
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
ARCHIVES="$ROOT/archives"
PREFIX="$ROOT/prefix"
mkdir -p "$ARCHIVES" "$ROOT/sources" "$ROOT/build-x264" "$ROOT/build-ffmpeg" "$ROOT/logs" "$ROOT/artifacts/bin" "$ROOT/artifacts/licenses"
# Use only system compiler tools. pkg-config is a discovery tool, not a linked library.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export MACOSX_DEPLOYMENT_TARGET=13.0
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH DYLD_LIBRARY_PATH LDFLAGS CFLAGS CPPFLAGS || true
FFMPEG_ARCHIVE="$ARCHIVES/ffmpeg-$FFMPEG_VERSION.tar.xz"
X264_ARCHIVE="$ARCHIVES/x264-$X264_COMMIT.tar.gz"
if [[ ! -f "$FFMPEG_ARCHIVE" ]]; then
  curl -fL --retry 2 --silent --show-error "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$FFMPEG_ARCHIVE"
fi
if [[ ! -f "$X264_ARCHIVE" ]]; then
  FETCH_DIR=$(mktemp -d "$ROOT/x264-fetch.XXXXXX")
  git -C "$FETCH_DIR" init --quiet
  git -C "$FETCH_DIR" fetch --quiet --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
  git -C "$FETCH_DIR" archive --format=tar --prefix="x264-$X264_COMMIT/" FETCH_HEAD | gzip -n > "$X264_ARCHIVE"
fi
printf '%s  %s\n%s  %s\n' "$FFMPEG_SHA256" "$FFMPEG_ARCHIVE" "$X264_SHA256" "$X264_ARCHIVE" | shasum -a 256 -c -
[[ -d "$ROOT/sources/ffmpeg-$FFMPEG_VERSION" ]] || tar -xf "$FFMPEG_ARCHIVE" -C "$ROOT/sources"
[[ -d "$ROOT/sources/x264-$X264_COMMIT" ]] || tar -xf "$X264_ARCHIVE" -C "$ROOT/sources"
cd "$ROOT/build-x264"
CC=/usr/bin/clang "../sources/x264-$X264_COMMIT/configure" \
  --prefix=../prefix --host=aarch64-apple-darwin --enable-static --enable-pic \
  --disable-cli --disable-opencl --disable-avs --disable-swscale --disable-lavf \
  --disable-ffms --disable-gpac --disable-lsmash --disable-bashcompletion \
  --extra-cflags='-mmacosx-version-min=13.0' --extra-ldflags='-mmacosx-version-min=13.0' \
  > "$ROOT/logs/x264-configure.log" 2>&1
make -j "$JOBS" > "$ROOT/logs/x264-build.log" 2>&1
make install-lib-static > "$ROOT/logs/x264-install.log" 2>&1
cd "$ROOT/build-ffmpeg"
"../sources/ffmpeg-$FFMPEG_VERSION/configure" \
  --prefix=../prefix --arch=aarch64 --target-os=darwin --cc=/usr/bin/clang \
  --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug \
  --disable-ffplay --disable-network --disable-indevs --disable-outdevs --enable-indev=lavfi \
  --enable-gpl --enable-version3 --enable-libx264 --enable-videotoolbox --enable-audiotoolbox \
  --enable-pthreads --enable-zlib --enable-bzlib --enable-iconv \
  --pkg-config="$PKG_CONFIG_TOOL" --pkg-config-flags=--static \
  --extra-cflags='-mmacosx-version-min=13.0 -I../prefix/include' \
  --extra-ldflags='-mmacosx-version-min=13.0 -L../prefix/lib' --extra-libs=-liconv \
  > "$ROOT/logs/ffmpeg-configure.log" 2>&1
make -j "$JOBS" ffmpeg ffprobe > "$ROOT/logs/ffmpeg-build.log" 2>&1
install -m 755 ffmpeg ffprobe "$ROOT/artifacts/bin/"
cp "$ROOT/sources/ffmpeg-$FFMPEG_VERSION/"COPYING* "$ROOT/artifacts/licenses/"
cp "$ROOT/sources/ffmpeg-$FFMPEG_VERSION/LICENSE.md" "$ROOT/artifacts/licenses/FFmpeg-LICENSE.md"
cp "$ROOT/sources/x264-$X264_COMMIT/COPYING" "$ROOT/artifacts/licenses/x264-COPYING"
# Verify architecture and reject any non-system dynamic dependency.
for tool in "$ROOT/artifacts/bin/ffmpeg" "$ROOT/artifacts/bin/ffprobe"; do
  lipo "$tool" -verify_arch arm64
  otool -L "$tool" | tail -n +2 | awk '{print $1}' | while IFS= read -r dep; do
    case "$dep" in /usr/lib/*|/System/Library/*) ;; *) echo "Unexpected dependency: $dep" >&2; exit 1;; esac
  done
done
(cd "$ROOT/artifacts/bin" && shasum -a 256 ffmpeg ffprobe) > "$ROOT/artifacts/SHA256SUMS"
echo "Built and dependency-checked helpers: $ROOT/artifacts/bin"
