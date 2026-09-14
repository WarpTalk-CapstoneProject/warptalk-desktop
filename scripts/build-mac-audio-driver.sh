#!/usr/bin/env bash
# Builds WarpTalk Microphone and WarpTalk Speaker: the two virtual audio devices the Google Meet
# bridge rides on, compiled from BlackHole's source under WarpTalk's own names.
#
# WHY NOT SHIP BLACKHOLE ITSELF
#   The name Google Meet shows in its device picker is compiled into the driver, so a device called
#   "WarpTalk Microphone" has to be a WarpTalk build. BlackHole's source is GPL-3.0, which allows
#   that, but its licence reserves the BlackHole name, logo and branding for official builds — so
#   this build must carry none of them. The GPL does require the source to stay available: it is
#   upstream BlackHole at $BLACKHOLE_REF plus this script, and NOTICE.txt inside each bundle says so.
#
# WHAT LETS TWO BUILDS COEXIST WITH EACH OTHER AND WITH BLACKHOLE
#   Each variant gets its own bundle id, its own driver name (the device UIDs are derived from it)
#   and its own CFPlugIn factory UUID. BlackHole's installer generates a random UUID per build;
#   these are fixed instead, so reinstalling replaces the device rather than registering a copy.
#
# WHY THE NAMES ARE PATCHED INTO THE SOURCE
#   BlackHole documents overriding its constants through GCC_PREPROCESSOR_DEFINITIONS, but that
#   setting is a whitespace-separated list, and "WarpTalk Microphone" has a space in it. The defines
#   are prepended to BlackHole.c instead, where BlackHole's own #ifndef guards pick them up.
#
# SIGNING
#   Ad-hoc by default. Set MAC_DRIVER_SIGN_IDENTITY to a "Developer ID Application: ..." identity in
#   the keychain to sign for distribution — required before the bundles can be notarized (WT-674).
#
# Usage: bash scripts/build-mac-audio-driver.sh     (macOS, Xcode command line tools)
# Output: resources/audio-drivers/WarpTalkMicrophone.driver and WarpTalkSpeaker.driver

set -euo pipefail

BLACKHOLE_REPO="https://github.com/ExistentialAudio/BlackHole.git"
BLACKHOLE_REF="v0.7.1"
UPSTREAM_FACTORY_UUID="e395c745-4eea-4d94-bb92-46224221047c"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/resources/audio-drivers"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-mac-audio-driver: macOS only." >&2
  exit 1
fi
if ! command -v xcodebuild >/dev/null; then
  echo "build-mac-audio-driver: xcodebuild not found; install the Xcode command line tools." >&2
  exit 1
fi

git clone --quiet --depth 1 --branch "$BLACKHOLE_REF" "$BLACKHOLE_REPO" "$WORK/BlackHole"
UPSTREAM_COMMIT="$(git -C "$WORK/BlackHole" rev-parse HEAD)"
SOURCE="$WORK/BlackHole/BlackHole/BlackHole.c"
echo "BlackHole $BLACKHOLE_REF ($UPSTREAM_COMMIT)"

ICON="$WORK/WarpTalk.icns"
# `sips -s format icns` exits 13 ("Unable to write image") on current macOS;
# iconutil from a full iconset is the supported path.
ICONSET="$WORK/WarpTalk.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/resources/warptalk-logo-primary.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$ROOT/resources/warptalk-logo-primary.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ICON"

mkdir -p "$OUT"

# bundle name | bundle id | device name shown in Meet | CFPlugIn factory UUID (fixed, see above)
VARIANTS=(
  "WarpTalkMicrophone|com.warptalk.audio.microphone|WarpTalk Microphone|6f1e2c4a-9b3d-4e7a-8c21-5d0f3a7b9e14"
  "WarpTalkSpeaker|com.warptalk.audio.speaker|WarpTalk Speaker|b2d84e61-3a7c-4f09-9e55-17c6a0d2f83b"
)

for variant in "${VARIANTS[@]}"; do
  IFS='|' read -r name bundle_id device_name uuid <<<"$variant"
  build_dir="$WORK/build-$name"

  git -C "$WORK/BlackHole" checkout --quiet -- BlackHole/BlackHole.c
  {
    printf '#define kDriver_Name "%s"\n' "$name"
    printf '#define kDevice_Name "%s"\n' "$device_name"
    printf '#define kHas_Driver_Name_Format 0\n'
    printf '#define kPlugIn_BundleID "%s"\n' "$bundle_id"
    printf '#define kPlugIn_Icon "WarpTalk.icns"\n'
    printf '#define kManufacturer_Name "WarpTalk"\n'
    printf '#define kNumber_Of_Channels 2\n'
    cat "$SOURCE"
  } >"$WORK/BlackHole.c.patched"
  mv "$WORK/BlackHole.c.patched" "$SOURCE"

  if ! xcodebuild \
      -project "$WORK/BlackHole/BlackHole.xcodeproj" \
      -configuration Release \
      -target BlackHole \
      CONFIGURATION_BUILD_DIR="$build_dir" \
      ARCHS="arm64 x86_64" \
      ONLY_ACTIVE_ARCH=NO \
      MACOSX_DEPLOYMENT_TARGET=12.0 \
      CODE_SIGNING_ALLOWED=NO \
      PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
      >"$WORK/$name.log" 2>&1; then
    tail -40 "$WORK/$name.log" >&2
    exit 1
  fi

  bundle="$build_dir/BlackHole.driver"
  if [ ! -d "$bundle" ]; then
    echo "build-mac-audio-driver: xcodebuild produced no BlackHole.driver for $name." >&2
    exit 1
  fi

  plist="$bundle/Contents/Info.plist"
  sed -i '' "s/$UPSTREAM_FACTORY_UUID/$uuid/g" "$plist"
  if grep -qi "$UPSTREAM_FACTORY_UUID" "$plist"; then
    echo "build-mac-audio-driver: upstream factory UUID still present in $name; it would collide with BlackHole." >&2
    exit 1
  fi
  plutil -replace CFBundleName -string "$name" "$plist"

  rm -f "$bundle/Contents/Resources/BlackHole.icns"
  cp "$ICON" "$bundle/Contents/Resources/WarpTalk.icns"
  cat >"$bundle/Contents/Resources/NOTICE.txt" <<EOF
$device_name is a modified build of BlackHole, (c) Existential Audio Inc., licensed under the GNU
General Public License v3.0. It is not an official BlackHole build and is not endorsed by
Existential Audio Inc.

Source: $BLACKHOLE_REPO at $BLACKHOLE_REF ($UPSTREAM_COMMIT), built by
scripts/build-mac-audio-driver.sh in https://github.com/WarpTalk-CapstoneProject/warptalk-desktop.
Changes: device name, driver name, bundle identifier, plug-in factory UUID, manufacturer name, icon.
EOF

  target="$OUT/$name.driver"
  rm -rf "$target"
  mv "$bundle" "$target"

  if [ -n "${MAC_DRIVER_SIGN_IDENTITY:-}" ]; then
    codesign --force --options runtime --timestamp --sign "$MAC_DRIVER_SIGN_IDENTITY" "$target"
  else
    codesign --force --sign - "$target"
  fi
  codesign --verify --strict "$target"
  echo "Built $target ($device_name)"
done
