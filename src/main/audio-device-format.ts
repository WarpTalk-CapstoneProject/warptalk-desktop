/**
 * Reading and aligning the shared-mode format of the two Hi-Fi Cable endpoints.
 *
 * Hi-Fi Cable is bit-perfect and carries no resampler: Meet plays into "Hi-Fi Cable Input" (a
 * render endpoint), WarpTalk records "Hi-Fi Cable Output" (a capture endpoint), and when the two
 * sides' shared-mode formats disagree on sample rate OR bit depth the cable passes nothing at all.
 * Windows gives them different defaults — measured on a real machine: Input 48000 Hz/24-bit,
 * Output 44100 Hz/24-bit — so the inbound bridge leg went silent with no error anywhere.
 *
 * The installer used to fix this by writing the format blob straight into the registry
 * (install-cables.ps1, #37). That could not work: the blob it wrote lacked the 8-byte property
 * header every stored value carries, its nAvgBytesPerSec was wrong, and auto-updates (`/S`) never
 * ran it. Writing the registry behind AudioSrv's back is not how the format changes anyway —
 * mmsys.cpl goes through the undocumented IPolicyConfig COM interface, which asks AudioSrv to
 * change it, needs no administrator, and takes effect without restarting the service. This module
 * does the same, at runtime, so it covers manual installs and updated machines as well.
 *
 * Reading stays on the registry, which any user can read and which needs no COM at all.
 */

import { execFile } from "child_process";

export interface EndpointFormat {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
}

export interface HiFiCableFormats {
  /** "Hi-Fi Cable Input" — the render endpoint Meet plays into. */
  input: EndpointFormat | null;
  /** "Hi-Fi Cable Output" — the capture endpoint WarpTalk records. */
  output: EndpointFormat | null;
}

export interface HiFiFormatAlignResult {
  /** True only when the read-back after the change shows both endpoints at 48000 Hz/24-bit. */
  ok: boolean;
  before: HiFiCableFormats;
  after: HiFiCableFormats;
  error?: string;
}

/** PKEY_AudioEngine_DeviceFormat — the shared-mode format of an endpoint. */
const DEVICE_FORMAT_PKEY = "{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0";
/** PKEY_Device_DeviceDesc — "Hi-Fi Cable Input", without the "(VB-Audio …)" suffix. */
const DEVICE_DESC_PKEY = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";

/** VT_BLOB, the VARTYPE every stored PKEY_AudioEngine_DeviceFormat value begins with. */
const VT_BLOB = 0x41;
/** VARTYPE dword + a second dword; the WAVEFORMATEX starts after these. */
const PROPERTY_HEADER_BYTES = 8;
/** sizeof(WAVEFORMATEX) without any extension. */
const WAVEFORMATEX_BYTES = 18;

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export const HIFI_TARGET_FORMAT: EndpointFormat = { sampleRate: 48000, bitsPerSample: 24, channels: 2 };

/**
 * The format both endpoints are set to: 2-channel 24-bit PCM at 48 kHz, as WAVEFORMATEXTENSIBLE.
 *
 * 48 kHz because the WarpTalk pipeline already runs at that rate, 24-bit because both endpoints
 * offer it and it is what the Input side ships with. No property header here: this is the struct
 * IPolicyConfig::SetDeviceFormat takes, not the stored registry value.
 */
export const HIFI_TARGET_WAVEFORMAT: readonly number[] = [
  0xfe, 0xff, // wFormatTag          WAVE_FORMAT_EXTENSIBLE
  0x02, 0x00, // nChannels           2
  0x80, 0xbb, 0x00, 0x00, // nSamplesPerSec      48000
  0x00, 0x65, 0x04, 0x00, // nAvgBytesPerSec     288000 (48000 * 6)
  0x06, 0x00, // nBlockAlign         6 (3 bytes * 2 channels)
  0x18, 0x00, // wBitsPerSample      24
  0x16, 0x00, // cbSize              22
  0x18, 0x00, // wValidBitsPerSample 24
  0x03, 0x00, 0x00, 0x00, // dwChannelMask       FL | FR
  // SubFormat KSDATAFORMAT_SUBTYPE_PCM {00000001-0000-0010-8000-00aa00389b71}
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
  0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

const ALIGN_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 10_000;

function toBytes(blob: string | ArrayLike<number>): Uint8Array | null {
  if (typeof blob !== "string") return Uint8Array.from(blob as ArrayLike<number>);
  const hex = blob.replace(/[\s,-]/g, "");
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** A bare WAVEFORMATEX / WAVEFORMATEXTENSIBLE, as IPolicyConfig hands it over. */
export function parseWaveFormat(blob: string | ArrayLike<number>): EndpointFormat | null {
  const bytes = toBytes(blob);
  if (!bytes || bytes.length < WAVEFORMATEX_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint16(0, true);
  if (tag !== WAVE_FORMAT_PCM && tag !== WAVE_FORMAT_IEEE_FLOAT && tag !== WAVE_FORMAT_EXTENSIBLE) {
    return null;
  }
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const bitsPerSample = view.getUint16(14, true);
  if (!channels || !sampleRate || !bitsPerSample) return null;
  return { sampleRate, bitsPerSample, channels };
}

/**
 * The stored PKEY_AudioEngine_DeviceFormat value, header and all.
 *
 * Every stored value starts `41 00 00 00 01 00 00 00` (VT_BLOB, then a dword) before the
 * WAVEFORMATEX. A blob without that header is refused rather than read at offset 0: it is exactly
 * the malformed value #37 wrote, and reading it as valid would report a format AudioSrv ignores.
 */
export function parseDeviceFormatBlob(blob: string | ArrayLike<number>): EndpointFormat | null {
  const bytes = toBytes(blob);
  if (!bytes || bytes.length < PROPERTY_HEADER_BYTES + WAVEFORMATEX_BYTES) return null;
  const vartype = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (vartype !== VT_BLOB) return null;
  return parseWaveFormat(bytes.subarray(PROPERTY_HEADER_BYTES));
}

/**
 * Whether the cable is silent because its two sides disagree.
 *
 * Channel count is left out on purpose: the cable is stereo on both sides, and it is rate and depth
 * that the missing resampler cannot bridge. An unreadable side is not a mismatch — it is unknown.
 */
export function isHiFiFormatMismatch(formats: HiFiCableFormats): boolean {
  const { input, output } = formats;
  if (!input || !output) return false;
  return input.sampleRate !== output.sampleRate || input.bitsPerSample !== output.bitsPerSample;
}

export function isHiFiTargetFormat(format: EndpointFormat | null): boolean {
  return (
    format !== null &&
    format.sampleRate === HIFI_TARGET_FORMAT.sampleRate &&
    format.bitsPerSample === HIFI_TARGET_FORMAT.bitsPerSample
  );
}

/**
 * The MMDevice endpoint id IPolicyConfig expects, from the registry key's GUID.
 *
 * `{0.0.0.00000000}` prefixes render endpoints and `{0.0.1.00000000}` capture ones — the same
 * string IMMDevice::GetId returns. Validated strictly, because it is pasted into a script.
 */
export function endpointIdFromRegistryKey(flow: "render" | "capture", keyGuid: string): string | null {
  if (!/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(keyGuid)) return null;
  return `${flow === "render" ? "{0.0.0.00000000}" : "{0.0.1.00000000}"}.${keyGuid.toLowerCase()}`;
}

interface HiFiEndpointRecord {
  flow: "render" | "capture";
  key: string;
  name: string;
  blob: string;
}

interface HiFiEndpoints {
  input: { id: string | null; format: EndpointFormat | null } | null;
  output: { id: string | null; format: EndpointFormat | null } | null;
}

/** Picks the Input/Output endpoints out of the probe's rows. Pure, for tests. */
export function describeHiFiEndpoints(records: readonly HiFiEndpointRecord[]): HiFiEndpoints {
  const pick = (flow: "render" | "capture", stem: string) => {
    const record = records.find(
      (row) => row.flow === flow && row.name.toLowerCase().startsWith(stem),
    );
    if (!record) return null;
    return { id: endpointIdFromRegistryKey(flow, record.key), format: parseDeviceFormatBlob(record.blob) };
  };
  return {
    input: pick("render", "hi-fi cable input"),
    output: pick("capture", "hi-fi cable output"),
  };
}

export function runPowerShell(script: string, timeout: number): Promise<string> {
  // -EncodedCommand, not -Command: the align script carries C# full of double quotes, and Windows
  // command-line quoting of those through Node's argument escaping is not something to rely on.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || "").trim() || error.message;
          reject(new Error(error.killed ? `powershell timed out after ${timeout} ms` : detail));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Only active endpoints (DeviceState 1): an unplugged or disabled leftover from an older driver
 * install keeps its registry key, and reading that one would describe a device nobody plays into.
 */
const READ_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$rows = @()
foreach ($flow in @("Render", "Capture")) {
  $root = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\$flow"
  foreach ($key in Get-ChildItem -LiteralPath $root) {
    $state = (Get-ItemProperty -LiteralPath $key.PSPath -Name DeviceState -ErrorAction SilentlyContinue).DeviceState
    if ($state -ne 1) { continue }
    $props = Get-ItemProperty -LiteralPath (Join-Path $key.PSPath "Properties") -ErrorAction SilentlyContinue
    if ($null -eq $props) { continue }
    $name = $props.'${DEVICE_DESC_PKEY}'
    if (-not ($name -is [string]) -or $name -notmatch "Hi-Fi Cable (Input|Output)") { continue }
    $blob = $props.'${DEVICE_FORMAT_PKEY}'
    $hex = if ($blob -is [byte[]]) { ($blob | ForEach-Object { $_.ToString("X2") }) -join "" } else { "" }
    $rows += [pscustomobject]@{ flow = $flow.ToLower(); key = $key.PSChildName; name = $name; blob = $hex }
  }
}
ConvertTo-Json -Compress -InputObject @($rows)
`;

async function readHiFiEndpoints(): Promise<HiFiEndpoints> {
  const stdout = await runPowerShell(READ_SCRIPT, READ_TIMEOUT_MS);
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (row): row is HiFiEndpointRecord =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as HiFiEndpointRecord).name === "string" &&
      typeof (row as HiFiEndpointRecord).key === "string",
  );
  return describeHiFiEndpoints(rows);
}

function formatsOf(endpoints: HiFiEndpoints): HiFiCableFormats {
  return { input: endpoints.input?.format ?? null, output: endpoints.output?.format ?? null };
}

/** Both endpoints' shared-mode formats; null for a side that is absent or unreadable. Windows only. */
export async function readHiFiCableFormats(): Promise<HiFiCableFormats> {
  if (process.platform !== "win32") return { input: null, output: null };
  return formatsOf(await readHiFiEndpoints());
}

/**
 * The IPolicyConfig call, as the Windows 7+ interface mmsys.cpl itself uses.
 *
 * Undocumented, so the vtable order below is the contract: every method up to SetDeviceFormat has
 * to be declared, in order, for the call to land on the right slot. BOOL parameters are `int`
 * because COM interop would otherwise marshal `bool` as a 2-byte VARIANT_BOOL. Each HRESULT is
 * printed rather than thrown so the caller can say which endpoint refused.
 */
export function buildAlignScript(endpointIds: readonly string[]): string {
  const bytes = HIFI_TARGET_WAVEFORMAT.map((value) => `0x${value.toString(16).padStart(2, "0")}`).join(",");
  const ids = endpointIds.map((id) => `'${id}'`).join(",");
  return String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
  [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr format);
  [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, out IntPtr format);
  [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
  [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpointFormat, IntPtr mixFormat);
  [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
  [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr period);
  [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
  [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
  [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, int fxStore, IntPtr key, IntPtr value);
  [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, int fxStore, IntPtr key, IntPtr value);
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
}

[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
class PolicyConfigClient {}

public static class WarpTalkHiFiFormat {
  public static int Set(string id, byte[] format) {
    IPolicyConfig policy = (IPolicyConfig)new PolicyConfigClient();
    IntPtr buffer = Marshal.AllocHGlobal(format.Length);
    try {
      Marshal.Copy(format, 0, buffer, format.Length);
      return policy.SetDeviceFormat(id, buffer, buffer);
    } finally {
      Marshal.FreeHGlobal(buffer);
      Marshal.ReleaseComObject(policy);
    }
  }
}
"@
$format = [byte[]]@(${bytes})
$results = @()
foreach ($id in @(${ids})) {
  $hr = [WarpTalkHiFiFormat]::Set($id, $format)
  $results += [pscustomobject]@{ id = $id; hr = ('0x{0:X8}' -f $hr) }
}
ConvertTo-Json -Compress -InputObject @($results)
`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sets whichever Hi-Fi Cable endpoint is not at 48000 Hz/24-bit to it, then reads both back.
 *
 * `ok` comes from the read-back, never from the HRESULTs: a call AudioSrv accepted but did not
 * apply would otherwise report a fixed cable that is still silent. AudioSrv persists the property
 * asynchronously, so the read-back is retried briefly before it counts as a failure.
 */
export async function alignHiFiCableFormat(): Promise<HiFiFormatAlignResult> {
  const empty: HiFiCableFormats = { input: null, output: null };
  if (process.platform !== "win32") {
    return { ok: false, before: empty, after: empty, error: "unsupported-platform" };
  }

  let endpoints: HiFiEndpoints;
  try {
    endpoints = await readHiFiEndpoints();
  } catch (error) {
    return { ok: false, before: empty, after: empty, error: `read-failed: ${errorText(error)}` };
  }
  const before = formatsOf(endpoints);
  if (!endpoints.input || !endpoints.output) {
    return { ok: false, before, after: before, error: "hifi-cable-not-found" };
  }

  const pending = [endpoints.input, endpoints.output].filter((side) => !isHiFiTargetFormat(side.format));
  if (pending.length === 0) return { ok: true, before, after: before };
  const ids = pending.map((side) => side.id);
  if (ids.some((id) => id === null)) {
    return { ok: false, before, after: before, error: "endpoint-id-unresolved" };
  }

  let failure: string | undefined;
  try {
    const stdout = await runPowerShell(buildAlignScript(ids as string[]), ALIGN_TIMEOUT_MS);
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ id?: string; hr?: string }>;
    const refused = rows.filter((row) => row.hr !== "0x00000000");
    if (refused.length > 0 || rows.length !== ids.length) {
      failure = `set-device-format-failed: ${JSON.stringify(rows)}`;
    }
  } catch (error) {
    failure = `set-device-format-failed: ${errorText(error)}`;
  }

  let after: HiFiCableFormats = before;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500);
    try {
      after = await readHiFiCableFormats();
    } catch (error) {
      return { ok: false, before, after, error: failure ?? `read-back-failed: ${errorText(error)}` };
    }
    if (isHiFiTargetFormat(after.input) && isHiFiTargetFormat(after.output)) break;
  }

  const ok = isHiFiTargetFormat(after.input) && isHiFiTargetFormat(after.output);
  if (ok) return failure ? { ok, before, after, error: failure } : { ok, before, after };
  return { ok, before, after, error: failure ?? "format-unchanged-after-set" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
