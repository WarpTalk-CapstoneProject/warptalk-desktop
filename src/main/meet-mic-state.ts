/**
 * Which microphone the Google Meet browser is recording from, for the Text -> Voice notice.
 *
 * When the user switches a bridge meeting from text-only to voice, the dub only reaches the meeting
 * once Meet's microphone is VB-CABLE's "CABLE Output". WarpTalk does not change that for them (no
 * clicking in Meet, no default-device changes); it tells them, and clears the notice once Meet is
 * actually on the cable. This module is how it knows.
 *
 * SOURCE: Windows Core Audio sessions. Every capture endpoint keeps a list of audio sessions, one
 * per process recording from it, each Active / Inactive / Expired. Chrome records in its audio
 * service, a child of the browser process, so a session's PID is walked up the parent chain to the
 * browser. Only ACTIVE sessions count: Chrome keeps an Inactive session on a device it stopped
 * using until the process exits, and counting that would report the old mic forever.
 *
 * LIMITS, stated so nobody reads more into the answer than it holds:
 *   - per browser, not per tab. Any other tab of the same browser that records the mic is
 *     counted — WarpTalk web open in that browser would make the answer "ambiguous".
 *   - whether Meet keeps the session Active while muted is not measured yet. If it does not, a
 *     muted user reads as "unknown", never as a wrong device.
 *   - WarpTalk's own processes are excluded (it records the real mic too in text-only mode).
 *
 * SPEAKER, read the same way from RENDER endpoints: whether the Meet browser is playing into VB-CABLE's
 * "CABLE Input". In the field (2026-10-03) a user had Meet's speaker on CABLE Input: the far side
 * then plays into the cable, comes straight back out of "CABLE Output" - Meet's own microphone in a
 * voice bridge - and the user hears nothing of the call. Same limits as above (per browser, Active
 * sessions only, WarpTalk's own processes excluded - WarpTalk itself plays the dub into CABLE
 * Input, which is exactly right and must not count).
 *
 * The helper is one long-lived PowerShell process (same shape as meet-caption-sensor.ts) because
 * the C# below is compiled by Add-Type, which costs seconds: compiled once, then answered per line.
 * It is read-only: it enumerates endpoints and sessions and never sets anything.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { matchesDeviceName } from "./virtual-audio.ts";
import type { MeetMicState } from "../shared/types.ts";

export const CABLE_OUTPUT_NAME = "CABLE Output (VB-Audio Virtual Cable)";
/** VB-CABLE's render side: what is played here comes out of CABLE Output. */
export const CABLE_INPUT_NAME = "CABLE Input (VB-Audio Virtual Cable)";
/** The driver's interface name for VB-CABLE, which survives a user renaming the endpoint. */
const CABLE_INTERFACE_NAME = "VB-Audio Virtual Cable";
const BROWSER_IMAGES = new Set(["chrome", "msedge", "brave", "opera", "vivaldi", "firefox"]);
/** Every other VB-Audio device (Hi-Fi Cable, CABLE-A/B, Voicemeeter), also under a bare description. */
const OTHER_VIRTUAL = /vb-audio|voicemeeter|\bcable\b/i;

export interface MicProcessLink {
  pid: number;
  /** Image name as Windows reports it, e.g. "chrome.exe". */
  name: string;
}

export interface MicSessionRecord {
  pid: number;
  state: "active" | "inactive" | "expired";
  /** The session's process first, then its parent, grandparent... as far as the walk got. */
  chain: MicProcessLink[];
}

export interface MicEndpointRecord {
  id: string;
  /** PKEY_Device_FriendlyName, e.g. "CABLE Output (VB-Audio Virtual Cable)". */
  name: string;
  /** PKEY_DeviceInterface_FriendlyName, e.g. "VB-Audio Virtual Cable". */
  interfaceName?: string;
  isDefault?: boolean;
  sessions: MicSessionRecord[];
}

export interface MicSessionSnapshot {
  /** Capture endpoints (microphones). */
  endpoints: MicEndpointRecord[];
  /**
   * Render endpoints (speakers), same shape. Null when the helper could not read them (the mic
   * answer still stands); absent from an older helper.
   */
  render?: MicEndpointRecord[] | null;
}

export interface MeetMicDecisionContext {
  /** The Meet browser's root process. Unknown: every browser process tree counts. */
  browserPid?: number | null;
  /** WarpTalk's own processes; a session inside their trees never counts. */
  excludePids: readonly number[];
  at: number;
}

export type MicEndpointKind = "cable" | "other-virtual" | "real";

/**
 * Exact for the cable: "Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)" contains "Cable Output" and was
 * once mistaken for VB-CABLE by a substring match, so the name must START with the stem
 * (matchesDeviceName) or the driver's interface name must be VB-CABLE's exactly.
 */
export function classifyMicEndpoint(endpoint: Pick<MicEndpointRecord, "name" | "interfaceName">): MicEndpointKind {
  if (matchesDeviceName(endpoint.name, CABLE_OUTPUT_NAME)) return "cable";
  if (endpoint.interfaceName?.trim().toLowerCase() === CABLE_INTERFACE_NAME.toLowerCase()) return "cable";
  if (OTHER_VIRTUAL.test(endpoint.name) || OTHER_VIRTUAL.test(endpoint.interfaceName ?? "")) return "other-virtual";
  return "real";
}

/**
 * The same rules for a speaker. Exact for VB-CABLE's "CABLE Input": "Hi-Fi Cable Input (VB-Audio
 * Hi-Fi Cable)" contains "Cable Input" and must never read as it. VB-CABLE's interface name is the
 * same on both of its endpoints, so on a RENDER endpoint it identifies CABLE Input.
 */
export function classifySpeakerEndpoint(
  endpoint: Pick<MicEndpointRecord, "name" | "interfaceName">,
): MicEndpointKind {
  if (matchesDeviceName(endpoint.name, CABLE_INPUT_NAME)) return "cable";
  if (endpoint.interfaceName?.trim().toLowerCase() === CABLE_INTERFACE_NAME.toLowerCase()) return "cable";
  if (OTHER_VIRTUAL.test(endpoint.name) || OTHER_VIRTUAL.test(endpoint.interfaceName ?? "")) return "other-virtual";
  return "real";
}

function imageStem(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/**
 * The browser root a session belongs to, or null if it is not a browser's (or is ours).
 *
 * With a known `browserPid` the chain must contain it. Without one, the topmost browser-named
 * process in the chain is the root, so every browser instance is considered.
 */
function sessionBrowserRoot(session: MicSessionRecord, context: MeetMicDecisionContext): number | null {
  const chain = session.chain.length > 0 ? session.chain : [{ pid: session.pid, name: "" }];
  if (chain.some((link) => context.excludePids.includes(link.pid))) return null;
  if (context.browserPid && context.browserPid > 0) {
    return chain.some((link) => link.pid === context.browserPid) ? context.browserPid : null;
  }
  let root: number | null = null;
  for (const link of chain) {
    if (BROWSER_IMAGES.has(imageStem(link.name))) root = link.pid;
  }
  return root;
}

/** Endpoints with an active session of the browser, by kind, and the browser roots seen. */
function browserHits(
  endpoints: readonly MicEndpointRecord[],
  classify: (endpoint: MicEndpointRecord) => MicEndpointKind,
  context: MeetMicDecisionContext,
  roots: Set<number>,
): Map<MicEndpointKind, string[]> {
  const hits = new Map<MicEndpointKind, string[]>();
  for (const endpoint of endpoints) {
    const kind = classify(endpoint);
    for (const session of endpoint.sessions) {
      if (session.state !== "active" || session.pid <= 0) continue;
      const root = sessionBrowserRoot(session, context);
      if (root === null) continue;
      roots.add(root);
      const names = hits.get(kind) ?? [];
      if (!names.includes(endpoint.name)) names.push(endpoint.name);
      hits.set(kind, names);
    }
  }
  return hits;
}

/**
 * Where the browser plays to. "cable" as soon as ANY active browser session renders into CABLE
 * Input, even alongside a real speaker: whatever goes in there comes back out of Meet's microphone,
 * and the banner is about exactly that. "real" when only physical (or unrecognised non-VB) devices
 * are played to. "unknown" otherwise: nothing playing (Chrome may close its output stream in a
 * silent call), only another virtual device (Hi-Fi Cable Input is the inbound leg on some
 * setups), or the render side could not be read.
 */
function decideSpeaker(
  render: readonly MicEndpointRecord[] | null | undefined,
  context: MeetMicDecisionContext,
): Pick<MeetMicState, "speaker" | "speakerEndpoints"> {
  if (!Array.isArray(render)) return { speaker: "unknown" };
  const hits = browserHits(render, classifySpeakerEndpoint, context, new Set<number>());
  const cable = hits.get("cable") ?? [];
  const real = hits.get("real") ?? [];
  const other = hits.get("other-virtual") ?? [];
  const speakerEndpoints = [...cable, ...real, ...other];
  const listed = speakerEndpoints.length > 0 ? { speakerEndpoints } : {};
  if (cable.length > 0) return { speaker: "cable", ...listed };
  if (real.length > 0) return { speaker: "real", ...listed };
  return { speaker: "unknown", ...listed };
}

/** The pure decision. See MeetMicState in shared/types.ts for what each state means. */
export function decideMeetMicState(
  snapshot: MicSessionSnapshot,
  context: MeetMicDecisionContext,
): MeetMicState {
  const roots = new Set<number>();
  const hits = browserHits(snapshot.endpoints, classifyMicEndpoint, context, roots);
  const speaker = snapshot.render === undefined ? {} : decideSpeaker(snapshot.render, context);

  const browserPid =
    context.browserPid && context.browserPid > 0 ? context.browserPid : roots.size === 1 ? [...roots][0] : undefined;
  const base = { at: context.at, ...(browserPid ? { browserPid } : {}), ...speaker };
  const cable = hits.get("cable") ?? [];
  const real = hits.get("real") ?? [];
  const other = hits.get("other-virtual") ?? [];
  const endpoints = [...cable, ...real, ...other];

  if (cable.length > 0 && real.length + other.length > 0) return { ...base, state: "ambiguous", endpoints };
  if (cable.length > 0) return { ...base, state: "cable", endpoint: cable[0], endpoints };
  if (real.length > 0) return { ...base, state: "real", endpoint: real[0], endpoints };
  if (other.length > 0) return { ...base, state: "unknown", reason: "other-virtual-device", endpoints };
  return { ...base, state: "unknown", reason: "no-active-session" };
}

/** Same answer, ignoring when it was read: the stream only emits on a change. */
export function sameMeetMicState(a: MeetMicState | null, b: MeetMicState): boolean {
  if (!a) return false;
  return (
    a.state === b.state &&
    a.browserPid === b.browserPid &&
    a.endpoint === b.endpoint &&
    a.reason === b.reason &&
    (a.endpoints ?? []).join("\u0000") === (b.endpoints ?? []).join("\u0000") &&
    a.speaker === b.speaker &&
    (a.speakerEndpoints ?? []).join("\u0000") === (b.speakerEndpoints ?? []).join("\u0000")
  );
}

/**
 * Reads every ACTIVE capture endpoint's sessions with their process chains.
 *
 * Pure ASCII (PowerShell 5.1 reads a BOM-less script as ANSI); device names are written as UTF-8.
 * COM vtables: every method up to the last one called is declared, in order, with [PreserveSig]
 * and IntPtr for anything unused, so the slots line up without marshalling surprises.
 * Process chains come from a Toolhelp32 snapshot (the same ParentProcessId Win32_Process reports,
 * without a WMI query per poll).
 */
export const MIC_SESSION_SENSOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct WtPropKey { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Sequential)]
public struct WtPropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtPropertyStore {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetAt(int index, out WtPropKey key);
  [PreserveSig] int GetValue(ref WtPropKey key, out WtPropVariant value);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IWtPropertyStore store);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtMMDeviceCollection {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int Item(int index, out IWtMMDevice device);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IWtMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IWtMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class WtMMDeviceEnumeratorComObject {}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out IWtAudioSessionEnumerator sessions);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}

[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr name);
  [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
  [PreserveSig] int GetIconPath(out IntPtr path);
  [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
  [PreserveSig] int GetGroupingParam(out Guid grouping);
  [PreserveSig] int SetGroupingParam(IntPtr grouping, IntPtr context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int GetSessionIdentifier(out IntPtr id);
  [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
  [PreserveSig] int GetProcessId(out int pid);
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct WtProcessEntry {
  public int dwSize; public int cntUsage; public int th32ProcessID; public IntPtr th32DefaultHeapID;
  public int th32ModuleID; public int cntThreads; public int th32ParentProcessID; public int pcPriClassBase;
  public int dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
}

public static class WarpTalkMicSessions {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(int flags, int pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref WtProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref WtProcessEntry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref WtPropVariant value);

  static readonly Guid DeviceFmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
  static readonly Guid InterfaceFmtid = new Guid("026e516e-b814-414b-83cd-856d6fef4822");

  static string Esc(string s) {
    if (s == null) return "";
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < ' ') { b.Append("\\u"); b.Append(((int)c).ToString("x4")); }
      else b.Append(c);
    }
    return b.ToString();
  }

  static string ReadString(IWtPropertyStore store, Guid fmtid, int pid) {
    var key = new WtPropKey { fmtid = fmtid, pid = pid };
    WtPropVariant value;
    if (store.GetValue(ref key, out value) != 0) return null;
    try { return value.vt == 31 ? Marshal.PtrToStringUni(value.p) : null; }
    finally { PropVariantClear(ref value); }
  }

  static Dictionary<int, KeyValuePair<int, string>> Processes() {
    var map = new Dictionary<int, KeyValuePair<int, string>>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
    try {
      var e = new WtProcessEntry();
      e.dwSize = Marshal.SizeOf(typeof(WtProcessEntry));
      if (!Process32FirstW(snap, ref e)) return map;
      do { map[e.th32ProcessID] = new KeyValuePair<int, string>(e.th32ParentProcessID, e.szExeFile); }
      while (Process32NextW(snap, ref e));
    } finally { CloseHandle(snap); }
    return map;
  }

  static string Chain(int pid, Dictionary<int, KeyValuePair<int, string>> procs) {
    var b = new StringBuilder("[");
    var seen = new HashSet<int>();
    int cur = pid;
    for (int hop = 0; hop < 16 && cur > 0 && seen.Add(cur); hop++) {
      KeyValuePair<int, string> info;
      if (!procs.TryGetValue(cur, out info)) break;
      if (hop > 0) b.Append(',');
      b.Append("{\"pid\":").Append(cur).Append(",\"name\":\"").Append(Esc(info.Value)).Append("\"}");
      cur = info.Key;
    }
    return b.Append(']').ToString();
  }

  // flow: 1 = capture (eCapture), 0 = render (eRender). Only ACTIVE endpoints (state mask 1).
  public static string Poll(int flow) {
    var enumerator = (IWtMMDeviceEnumerator)new WtMMDeviceEnumeratorComObject();
    var procs = Processes();
    string defaultId = null;
    IWtMMDevice def;
    if (enumerator.GetDefaultAudioEndpoint(flow, 0, out def) == 0 && def != null) { def.GetId(out defaultId); }
    IWtMMDeviceCollection devices;
    int hr = enumerator.EnumAudioEndpoints(flow, 1, out devices);
    if (hr != 0) throw new Exception("EnumAudioEndpoints 0x" + hr.ToString("X8"));
    int count; devices.GetCount(out count);
    var b = new StringBuilder("[");
    var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    for (int i = 0; i < count; i++) {
      IWtMMDevice device; if (devices.Item(i, out device) != 0) continue;
      string id; device.GetId(out id);
      string name = null, iface = null;
      IWtPropertyStore store;
      if (device.OpenPropertyStore(0, out store) == 0) {
        name = ReadString(store, DeviceFmtid, 14);
        iface = ReadString(store, InterfaceFmtid, 2);
      }
      if (b.Length > 1) b.Append(',');
      b.Append("{\"id\":\"").Append(Esc(id)).Append("\",\"name\":\"").Append(Esc(name)).Append("\",\"interfaceName\":\"").Append(Esc(iface));
      b.Append("\",\"isDefault\":").Append(id == defaultId ? "true" : "false").Append(",\"sessions\":[");
      object raw;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out raw) == 0 && raw != null) {
        var manager = (IWtAudioSessionManager2)raw;
        IWtAudioSessionEnumerator sessions;
        if (manager.GetSessionEnumerator(out sessions) == 0 && sessions != null) {
          int n; sessions.GetCount(out n);
          bool first = true;
          for (int k = 0; k < n; k++) {
            object so; if (sessions.GetSession(k, out so) != 0 || so == null) continue;
            var control = so as IWtAudioSessionControl2;
            if (control == null) continue;
            int state = 0, pid = 0;
            control.GetState(out state);
            control.GetProcessId(out pid);
            if (!first) b.Append(',');
            first = false;
            b.Append("{\"pid\":").Append(pid).Append(",\"state\":\"").Append(state == 1 ? "active" : state == 2 ? "expired" : "inactive");
            b.Append("\",\"chain\":").Append(Chain(pid, procs)).Append('}');
          }
        }
      }
      b.Append("]}");
    }
    return b.Append(']').ToString();
  }
}
'@

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ')
  $id = $parts[1]
  if ($id -notmatch '^[0-9]+$') { continue }
  try {
    if ($parts[0] -eq 'poll') {
      $capture = [WarpTalkMicSessions]::Poll(1)
      # The speaker read must never cost the mic answer: on any failure it is reported as null.
      $render = 'null'
      try { $render = [WarpTalkMicSessions]::Poll(0) } catch { $render = 'null' }
      $json = '{"id":"' + $id + '","ok":true,"endpoints":' + $capture + ',"render":' + $render + '}'
    }
    else { $json = '{"id":"' + $id + '","ok":false,"error":"bad-command"}' }
  } catch {
    $msg = ($_.Exception.Message -replace '[\\"]', "'") -replace '[\r\n]', ' '
    $json = '{"id":"' + $id + '","ok":false,"error":"' + $msg + '"}'
  }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
`;

const POLL_TIMEOUT_MS = 5000;
/** Added to the first poll of a fresh helper: PowerShell start plus the Add-Type compile. */
const STARTUP_ALLOWANCE_MS = 15000;

type Reply =
  | { id: string; ok: true; endpoints: MicEndpointRecord[]; render?: MicEndpointRecord[] | null }
  | { id: string; ok: false; error: string };

export interface MicSessionSensorLike {
  poll(): Promise<MicSessionSnapshot>;
  stop(): void;
}

/** The long-lived helper. One request at a time; a dead helper is respawned on the next poll. */
export class MicSessionSensor implements MicSessionSensorLike {
  private child: ChildProcessWithoutNullStreams | null = null;
  private scriptPath: string | null = null;
  private buffer = "";
  private nextId = 1;
  private waiting = new Map<string, (reply: Reply | null) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private cold = true;

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    if (!this.scriptPath) {
      const dir = mkdtempSync(path.join(tmpdir(), "warptalk-micsess-"));
      this.scriptPath = path.join(dir, "meet-mic-sessions.ps1");
      writeFileSync(this.scriptPath, MIC_SESSION_SENSOR_SCRIPT, "utf8");
    }
    this.cold = true;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
      { windowsHide: true },
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) {
          this.cold = false;
          this.answer(line);
        }
        index = this.buffer.indexOf("\n");
      }
    });
    child.stderr.resume();
    const fail = () => {
      if (this.child === child) this.child = null;
      this.buffer = "";
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
    };
    child.on("exit", fail);
    child.on("error", fail);
    this.child = child;
    return child;
  }

  private answer(line: string): void {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      return;
    }
    const resolve = this.waiting.get(String(reply.id));
    if (!resolve) return;
    this.waiting.delete(String(reply.id));
    resolve(reply);
  }

  poll(): Promise<MicSessionSnapshot> {
    const run = () =>
      new Promise<MicSessionSnapshot>((resolve, reject) => {
        const child = this.ensureStarted();
        const id = String(this.nextId++);
        const timer = setTimeout(() => {
          if (this.waiting.delete(id)) reject(new Error("The mic session sensor did not answer."));
        }, POLL_TIMEOUT_MS + (this.cold ? STARTUP_ALLOWANCE_MS : 0));
        this.waiting.set(id, (reply) => {
          clearTimeout(timer);
          if (reply === null) reject(new Error("The mic session sensor exited."));
          else if (!reply.ok) reject(new Error(reply.error));
          else
            resolve({
              endpoints: Array.isArray(reply.endpoints) ? reply.endpoints : [],
              render: Array.isArray(reply.render) ? reply.render : null,
            });
        });
        child.stdin.write(`poll ${id}\n`);
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
    this.buffer = "";
    this.child?.kill();
    this.child = null;
  }
}

export interface MeetMicStateStreamOptions {
  sensor: MicSessionSensorLike;
  emit: (state: MeetMicState) => void;
  /** Read at every poll, so a loopback capture that starts later is picked up. */
  browserPid: () => number | null;
  excludePids: () => readonly number[];
  now?: () => number;
  intervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Polls while running and emits only when the answer changes. A failed poll emits "unknown" with
 * reason "probe-failed" once and backs off (2 s, 4 s ... 30 s) so a broken PowerShell is not
 * respawned every two seconds.
 */
export class MeetMicStateStream {
  private timer: unknown = null;
  private running = false;
  private last: MeetMicState | null = null;
  private failures = 0;
  private generation = 0;
  private readonly options: Required<Pick<MeetMicStateStreamOptions, "now" | "intervalMs" | "setTimer" | "clearTimer">> &
    MeetMicStateStreamOptions;

  constructor(options: MeetMicStateStreamOptions) {
    this.options = {
      now: Date.now,
      intervalMs: 2000,
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      ...options,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The last answer, so a late subscriber can be told immediately. */
  get current(): MeetMicState | null {
    return this.last;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = null;
    this.failures = 0;
    const generation = ++this.generation;
    void this.tick(generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timer = null;
    this.last = null;
    this.options.sensor.stop();
  }

  /** Exposed for tests; the timer calls it. */
  async tick(generation = this.generation): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    let next: MeetMicState;
    try {
      const snapshot = await this.options.sensor.poll();
      next = decideMeetMicState(snapshot, {
        browserPid: this.options.browserPid(),
        excludePids: this.options.excludePids(),
        at: this.options.now(),
      });
      this.failures = 0;
    } catch {
      this.failures++;
      const browserPid = this.options.browserPid();
      next = {
        state: "unknown",
        reason: "probe-failed",
        at: this.options.now(),
        ...(browserPid ? { browserPid } : {}),
      };
    }
    if (!this.running || generation !== this.generation) return;
    if (!sameMeetMicState(this.last, next)) {
      this.last = next;
      this.options.emit(next);
    }
    const delay =
      this.failures === 0 ? this.options.intervalMs : Math.min(this.options.intervalMs * 2 ** this.failures, 30000);
    this.timer = this.options.setTimer(() => void this.tick(generation), delay);
  }
}
