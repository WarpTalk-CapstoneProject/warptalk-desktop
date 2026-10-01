/**
 * The dot on the tray icon while an update waits to be installed.
 *
 * Drawn into the icon's own pixels rather than shipped as a second asset, so it can never drift
 * from the icon it sits on. Pure: takes and returns a BGRA bitmap (what nativeImage.toBitmap gives
 * on Windows, and what createFromBitmap takes back), so the tests need no Electron.
 */

/** #4cc38a, the green the rest of the app uses for "ready", in BGRA byte order. */
const DOT = [0x8a, 0xc3, 0x4c, 0xff] as const;
/** A dark ring keeps the dot readable on a light taskbar as well as a dark one. */
const RING = [0x14, 0x12, 0x11, 0xff] as const;

export function withUpdateDot(bitmap: Buffer, width: number, height: number): Buffer {
  if (bitmap.length !== width * height * 4) return bitmap;
  const out = Buffer.from(bitmap);
  const radius = Math.max(3, Math.round(Math.min(width, height) * 0.22));
  const cx = width - radius - 0.5;
  const cy = radius - 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance > radius) continue;
      const color = distance > radius - 1.5 ? RING : DOT;
      out.set(color, (y * width + x) * 4);
    }
  }
  return out;
}
