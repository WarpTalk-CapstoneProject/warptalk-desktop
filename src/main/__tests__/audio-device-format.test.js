import test from "node:test";
import assert from "node:assert/strict";

import {
  HIFI_MIX_WAVEFORMAT,
  HIFI_TARGET_WAVEFORMAT,
  alignHiFiCableFormat,
  buildAlignScript,
  describeHiFiEndpoints,
  endpointIdFromRegistryKey,
  isHiFiFormatMismatch,
  isHiFiTargetFormat,
  parseDeviceFormatBlob,
  invalidateHiFiCableFormatsCache,
  parseWaveFormat,
  readHiFiCableFormatsCached,
} from "../audio-device-format.ts";
import { withHiFiCableFormat } from "../virtual-audio.ts";

// Both read from a real machine's registry, where this pair left the inbound leg silent.
const INPUT_48K_24 =
  "41 00 00 00 01 00 00 00 FE FF 02 00 80 BB 00 00 00 65 04 00 06 00 18 00 16 00 18 00 03 00 00 00 01 00 00 00 00 00 10 00 80 00 00 AA 00 38 9B 71";
const OUTPUT_44K_24 =
  "41 00 00 00 01 00 00 00 FE FF 02 00 44 AC 00 00 98 09 04 00 06 00 18 00 16 00 18 00 03 00 00 00 01 00 00 00 00 00 10 00 80 00 00 AA 00 38 9B 71";

function hexBytes(hex) {
  return hex.split(" ").map((byte) => Number.parseInt(byte, 16));
}

test("a stored device format blob is read after its 8-byte property header", () => {
  assert.deepEqual(parseDeviceFormatBlob(INPUT_48K_24), { sampleRate: 48000, bitsPerSample: 24, channels: 2 });
  assert.deepEqual(parseDeviceFormatBlob(OUTPUT_44K_24), { sampleRate: 44100, bitsPerSample: 24, channels: 2 });
  // Byte arrays and unspaced hex read the same as the spaced form.
  assert.deepEqual(parseDeviceFormatBlob(hexBytes(INPUT_48K_24)), parseDeviceFormatBlob(INPUT_48K_24));
  assert.deepEqual(parseDeviceFormatBlob(INPUT_48K_24.replace(/ /g, "")), parseDeviceFormatBlob(INPUT_48K_24));
});

test("a header-less blob is refused rather than read at the wrong offset", () => {
  // Exactly what #37's installer wrote: a bare WAVEFORMATEXTENSIBLE, which AudioSrv ignores.
  const headerless = INPUT_48K_24.split(" ").slice(8).join(" ");
  assert.equal(parseDeviceFormatBlob(headerless), null);
  // The bare struct is still readable where a bare struct is what arrives (IPolicyConfig).
  assert.deepEqual(parseWaveFormat(headerless), { sampleRate: 48000, bitsPerSample: 24, channels: 2 });
  assert.equal(parseDeviceFormatBlob(""), null);
  assert.equal(parseDeviceFormatBlob("41 00 00 00 01 00 00 00 FE FF"), null);
  assert.equal(parseDeviceFormatBlob("zz"), null);
});

test("a mismatch is a difference in sample rate or bit depth between two known sides", () => {
  const f48 = { sampleRate: 48000, bitsPerSample: 24, channels: 2 };
  assert.equal(isHiFiFormatMismatch({ input: f48, output: { ...f48, sampleRate: 44100 } }), true);
  assert.equal(isHiFiFormatMismatch({ input: f48, output: { ...f48, bitsPerSample: 16 } }), true);
  assert.equal(isHiFiFormatMismatch({ input: f48, output: { ...f48 } }), false);
  // Agreeing sides pass sound even off-target, so they are not a mismatch.
  const f441 = { sampleRate: 44100, bitsPerSample: 16, channels: 2 };
  assert.equal(isHiFiFormatMismatch({ input: f441, output: { ...f441 } }), false);
  // Unknown is not a mismatch.
  assert.equal(isHiFiFormatMismatch({ input: f48, output: null }), false);
  assert.equal(isHiFiFormatMismatch({ input: null, output: null }), false);
});

test("the target format is the stored 48 kHz/24-bit blob without its header", () => {
  assert.equal(HIFI_TARGET_WAVEFORMAT.length, 40);
  assert.deepEqual([...HIFI_TARGET_WAVEFORMAT], hexBytes(INPUT_48K_24).slice(8));
  // nAvgBytesPerSec is 48000 * 6 = 288000 — #37 wrote 290240.
  const view = new DataView(Uint8Array.from(HIFI_TARGET_WAVEFORMAT).buffer);
  assert.equal(view.getUint32(8, true), 288000);
  assert.equal(view.getUint16(12, true), 6);
  assert.ok(isHiFiTargetFormat(parseWaveFormat(HIFI_TARGET_WAVEFORMAT)));
});

test("the mix format is 32-bit float at the same rate and channels", () => {
  assert.equal(HIFI_MIX_WAVEFORMAT.length, 40);
  const view = new DataView(Uint8Array.from(HIFI_MIX_WAVEFORMAT).buffer);
  assert.equal(view.getUint16(0, true), 0xfffe);
  assert.equal(view.getUint16(2, true), 2);
  assert.equal(view.getUint32(4, true), 48000);
  assert.equal(view.getUint32(8, true), 384000);
  assert.equal(view.getUint16(12, true), 8);
  assert.equal(view.getUint16(14, true), 32);
  assert.equal(view.getUint16(16, true), 22);
  assert.equal(view.getUint16(18, true), 32);
  assert.equal(view.getUint32(20, true), 3);
  // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, not the PCM subtype the endpoint format carries.
  assert.deepEqual(
    [...HIFI_MIX_WAVEFORMAT.slice(24)],
    hexBytes("03 00 00 00 00 00 10 00 80 00 00 AA 00 38 9B 71"),
  );
});

test("endpoint ids are built from the registry key GUID, and anything else is refused", () => {
  assert.equal(
    endpointIdFromRegistryKey("render", "{9C81E614-7F23-4A6A-9990-627318F2EE6E}"),
    "{0.0.0.00000000}.{9c81e614-7f23-4a6a-9990-627318f2ee6e}",
  );
  assert.equal(
    endpointIdFromRegistryKey("capture", "{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a}"),
    "{0.0.1.00000000}.{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a}",
  );
  // The id is pasted into a script, so a quote in it must never get that far.
  assert.equal(endpointIdFromRegistryKey("render", "{x}'; Remove-Item C:\\ #"), null);
});

test("Input is the render endpoint and Output the capture one", () => {
  const endpoints = describeHiFiEndpoints([
    { flow: "capture", key: "{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a}", name: "Hi-Fi Cable Output", blob: OUTPUT_44K_24.replace(/ /g, "") },
    { flow: "render", key: "{9c81e614-7f23-4a6a-9990-627318f2ee6e}", name: "Hi-Fi Cable Input", blob: INPUT_48K_24.replace(/ /g, "") },
  ]);
  assert.equal(endpoints.input?.id, "{0.0.0.00000000}.{9c81e614-7f23-4a6a-9990-627318f2ee6e}");
  assert.equal(endpoints.input?.format?.sampleRate, 48000);
  assert.equal(endpoints.output?.id, "{0.0.1.00000000}.{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a}");
  assert.equal(endpoints.output?.format?.sampleRate, 44100);
  assert.deepEqual(describeHiFiEndpoints([]), { input: null, output: null });
});

test("a renamed endpoint is still found by its driver's interface name", () => {
  const vbInput = { flow: "render", key: "{3b00282a-82d2-4a85-8c3a-fc7a04a3a46f}", name: "CABLE Input", interfaceName: "VB-Audio Virtual Cable", blob: "" };
  const endpoints = describeHiFiEndpoints([
    vbInput,
    { flow: "render", key: "{9c81e614-7f23-4a6a-9990-627318f2ee6e}", name: "Meet speaker", interfaceName: "VB-Audio Hi-Fi Cable", blob: INPUT_48K_24.replace(/ /g, "") },
    { flow: "capture", key: "{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a}", name: "WarpTalk in", interfaceName: "VB-Audio Hi-Fi Cable", blob: OUTPUT_44K_24.replace(/ /g, "") },
  ]);
  assert.equal(endpoints.input?.id, "{0.0.0.00000000}.{9c81e614-7f23-4a6a-9990-627318f2ee6e}");
  assert.equal(endpoints.output?.id, "{0.0.1.00000000}.{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a}");
  // The interface name wins over a description match on the same flow.
  const preferred = describeHiFiEndpoints([
    { flow: "render", key: "{00000000-0000-0000-0000-000000000001}", name: "Hi-Fi Cable Input", interfaceName: "Something else", blob: "" },
    { flow: "render", key: "{00000000-0000-0000-0000-000000000002}", name: "Renamed", interfaceName: "VB-Audio Hi-Fi Cable", blob: "" },
  ]);
  assert.equal(preferred.input?.id, "{0.0.0.00000000}.{00000000-0000-0000-0000-000000000002}");
  // Another VB-Audio cable is never taken for Hi-Fi Cable.
  assert.equal(describeHiFiEndpoints([vbInput]).input, null);
});

test("the align script sets the target bytes on exactly the endpoints it is given", () => {
  const script = buildAlignScript(["{0.0.1.00000000}.{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a}"]);
  assert.match(script, /870af99c-171d-4f9e-af0d-e63df40c2bc9/);
  assert.match(script, /f8679f50-850a-41cf-9c72-430f290290c8/);
  assert.match(script, /0xfe,0xff,0x02,0x00,0x80,0xbb,0x00,0x00,0x00,0x65,0x04,0x00/);
  // The float mix format goes in as the second buffer, not the PCM endpoint format twice.
  assert.match(script, /\$mix = \[byte\[\]\]@\(0xfe,0xff,0x02,0x00,0x80,0xbb,0x00,0x00,0x00,0xdc,0x05,0x00,0x08,0x00,0x20,0x00/);
  assert.match(script, /SetDeviceFormat\(id, endpointBuffer, mixBuffer\)/);
  assert.match(script, /Set\(\$id, \$format, \$mix\)/);
  assert.match(script, /'\{0\.0\.1\.00000000\}\.\{7ece1a5d-4da7-4fdb-bb6a-b9a415b54c0a\}'/);
  assert.doesNotMatch(script, /0\.0\.0\.00000000/);
});

test("aligning off Windows refuses without spawning anything", { skip: process.platform === "win32" }, async () => {
  const result = await alignHiFiCableFormat();
  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported-platform");
});

test("the status carries the formats only on Windows, and a failed read leaves it untouched", async () => {
  const hifi = { leg: "inbound", driverBundle: "Hi-Fi Cable", deviceName: "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)", installed: true, providerId: "hifi-cable-free" };
  const base = { platform: "win32", supported: true, devices: [hifi], ready: true, foreignDrivers: [] };
  const f48 = { sampleRate: 48000, bitsPerSample: 24, channels: 2 };
  const f441 = { sampleRate: 44100, bitsPerSample: 24, channels: 2 };

  const mismatched = await withHiFiCableFormat(base, async () => ({ input: f48, output: f441 }));
  assert.deepEqual(mismatched.hifiFormat, { input: f48, output: f441 });
  assert.equal(mismatched.hifiFormatMismatch, true);

  const absent = await withHiFiCableFormat(base, async () => ({ input: null, output: null }));
  assert.equal("hifiFormat" in absent, false);

  const failed = await withHiFiCableFormat(base, async () => {
    throw new Error("powershell timed out");
  });
  assert.deepEqual(failed, base);

  const mac = await withHiFiCableFormat({ ...base, platform: "darwin" }, async () => {
    throw new Error("must not be called");
  });
  assert.equal("hifiFormat" in mac, false);
});

test("without Hi-Fi Cable on the inbound leg the formats are never read", async () => {
  const status = { platform: "win32", supported: true, devices: [], ready: false, foreignDrivers: [] };
  let reads = 0;
  const result = await withHiFiCableFormat(status, async () => {
    reads++;
    return { input: null, output: null };
  });
  assert.equal(reads, 0);
  assert.deepEqual(result, status);
});

test("the formats read is cached, shared while in flight, and dropped on invalidation", async () => {
  invalidateHiFiCableFormatsCache();
  const f48 = { sampleRate: 48000, bitsPerSample: 24, channels: 2 };
  let reads = 0;
  let clock = 1_000;
  const now = () => clock;
  const read = async () => {
    reads++;
    return { input: f48, output: f48 };
  };

  const [a, b] = await Promise.all([readHiFiCableFormatsCached(read, now), readHiFiCableFormatsCached(read, now)]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);

  clock += 29_000;
  await readHiFiCableFormatsCached(read, now);
  assert.equal(reads, 1);

  clock += 2_000;
  await readHiFiCableFormatsCached(read, now);
  assert.equal(reads, 2);

  invalidateHiFiCableFormatsCache();
  await readHiFiCableFormatsCached(read, now);
  assert.equal(reads, 3);

  // A read that began before an invalidation does not repopulate the cache.
  invalidateHiFiCableFormatsCache();
  let release;
  const slow = readHiFiCableFormatsCached(() => new Promise((resolve) => (release = resolve)), now);
  invalidateHiFiCableFormatsCache();
  release({ input: null, output: null });
  await slow;
  await readHiFiCableFormatsCached(read, now);
  assert.equal(reads, 4);

  // A failure is not cached.
  invalidateHiFiCableFormatsCache();
  await assert.rejects(readHiFiCableFormatsCached(async () => { throw new Error("boom"); }, now));
  await readHiFiCableFormatsCached(read, now);
  assert.equal(reads, 5);
  invalidateHiFiCableFormatsCache();
});
