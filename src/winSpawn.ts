/**
 * Windows-only alternative to a plain `child_process.spawn(..., {detached:
 * true})` for launching Codex. `detached: true` on Windows maps to
 * `DETACHED_PROCESS`, which gives Codex no console at all — every
 * console-mode command it then runs (a shell per command) has nothing to
 * attach to, so Windows allocates a fresh, briefly-visible console window
 * for each one. This module instead spawns a small wrapper process
 * (`winWrapperEntry.js`) with `CREATE_NEW_CONSOLE`, which Node's own spawn
 * cannot request. The wrapper hides that console immediately, then launches
 * Codex as its own child; Codex and everything it runs reuse the hidden
 * console instead of creating new ones. Verified empirically (conhost.exe
 * process count before/after) — see CLAUDE.md for the trade-offs already
 * ruled out (`conhost --headless`, `CREATE_NO_WINDOW`, hiding from outside
 * via `AttachConsole`) before this design was settled on.
 *
 * `CREATE_NEW_CONSOLE` also gives the wrapper (and so Codex) a process
 * lifetime independent of this server, the same property `detached` was
 * relied on for — confirmed by killing the launching process immediately
 * after spawn and observing the job still complete.
 *
 * Node has no API for raw Win32 creation flags, so this goes through koffi
 * (a prebuilt-binary FFI bridge — no native compilation needed) to call
 * `CreateProcessW` directly. koffi is an optional dependency in spirit even
 * though it is listed as a regular one: every entry point here is wrapped so
 * a missing or failed-to-load koffi returns `undefined` rather than
 * throwing, and the caller (`jobs.ts`) falls back to the old
 * `detached: true` spawn. Job survival must never depend on koffi being
 * present; only the console-hiding is best-effort.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const CREATE_NEW_CONSOLE = 0x00000010;
const STILL_ACTIVE = 259;

interface Bindings {
  CreateProcessW: (...args: unknown[]) => boolean;
  CloseHandle: (h: unknown) => boolean;
  GetExitCodeProcess: (h: unknown, out: number[]) => boolean;
  sizeofStartupInfo: number;
}

// `undefined` = not attempted yet; `null` = attempted and unavailable.
let bindings: Bindings | null | undefined;

function loadBindings(): Bindings | null {
  if (bindings !== undefined) return bindings;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi");
    const STARTUPINFOW = koffi.struct("STARTUPINFOW", {
      cb: "uint32",
      lpReserved: "void *",
      lpDesktop: "void *",
      lpTitle: "void *",
      dwX: "uint32",
      dwY: "uint32",
      dwXSize: "uint32",
      dwYSize: "uint32",
      dwXCountChars: "uint32",
      dwYCountChars: "uint32",
      dwFillAttribute: "uint32",
      dwFlags: "uint32",
      wShowWindow: "uint16",
      cbReserved2: "uint16",
      lpReserved2: "void *",
      hStdInput: "void *",
      hStdOutput: "void *",
      hStdError: "void *",
    });
    const PROCESS_INFORMATION = koffi.struct("PROCESS_INFORMATION", {
      hProcess: "void *",
      hThread: "void *",
      dwProcessId: "uint32",
      dwThreadId: "uint32",
    });
    const kernel32 = koffi.load("kernel32.dll");
    const CreateProcessW = kernel32.func("__stdcall", "CreateProcessW", "bool", [
      "void *", // lpApplicationName
      "str16", // lpCommandLine
      "void *", // lpProcessAttributes
      "void *", // lpThreadAttributes
      "bool", // bInheritHandles
      "uint32", // dwCreationFlags
      "void *", // lpEnvironment
      "str16", // lpCurrentDirectory
      koffi.pointer(STARTUPINFOW),
      koffi.out(koffi.pointer(PROCESS_INFORMATION)),
    ]);
    const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "bool", ["void *"]);
    const GetExitCodeProcess = kernel32.func("__stdcall", "GetExitCodeProcess", "bool", [
      "void *",
      koffi.out(koffi.pointer("uint32")),
    ]);
    bindings = {
      CreateProcessW,
      CloseHandle,
      GetExitCodeProcess,
      sizeofStartupInfo: koffi.sizeof(STARTUPINFOW),
    };
    return bindings;
  } catch {
    bindings = null;
    return null;
  }
}

/**
 * Windows argv quoting (CommandLineToArgvW rules): a run of backslashes
 * immediately before the closing quote must be doubled, or it escapes the
 * quote instead of terminating the argument. None of our three arguments
 * (node's own exe path, this module's compiled wrapper path, a job's config
 * path) can contain a literal `"` — that character is illegal in Windows
 * paths — so only the trailing-backslash case needs handling.
 */
function quoteArg(arg: string): string {
  const trailingBackslashes = /\\*$/.exec(arg)?.[0].length ?? 0;
  return `"${arg}${"\\".repeat(trailingBackslashes)}"`;
}

const wrapperEntryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "winWrapperEntry.js",
);

export interface WrapperSpawnConfig {
  command: string;
  args: string[];
  cwd: string;
  stdinFile: string;
  stdoutFile: string;
  stderrFile: string;
  useShell: boolean;
}

export interface WinLaunchResult {
  pid: number;
  /**
   * Polls for the real exit code and calls back exactly once. The interval
   * is unref'd so it never keeps this server process alive on its own.
   */
  onExit: (cb: (code: number | null) => void) => void;
}

/** Returns undefined on any failure — the caller must fall back to a plain detached spawn. */
export function tryWinLaunchHidden(
  configPath: string,
  cfg: WrapperSpawnConfig,
): WinLaunchResult | undefined {
  const b = loadBindings();
  if (!b) return undefined;

  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg));

    const cmdLine = [process.execPath, wrapperEntryPath, configPath].map(quoteArg).join(" ");

    const si = {
      cb: b.sizeofStartupInfo,
      lpReserved: null,
      lpDesktop: null,
      lpTitle: null,
      dwX: 0,
      dwY: 0,
      dwXSize: 0,
      dwYSize: 0,
      dwXCountChars: 0,
      dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: 0,
      wShowWindow: 0,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: null,
      hStdOutput: null,
      hStdError: null,
    };
    const pi: { hProcess?: unknown; hThread?: unknown; dwProcessId?: number } = {};

    const ok = b.CreateProcessW(
      null,
      cmdLine,
      null,
      null,
      false,
      CREATE_NEW_CONSOLE,
      null,
      cfg.cwd,
      si,
      pi,
    );
    if (!ok || pi.dwProcessId === undefined) return undefined;
    b.CloseHandle(pi.hThread);

    const hProcess = pi.hProcess;
    let closed = false;
    return {
      pid: pi.dwProcessId,
      onExit(cb) {
        const timer = setInterval(() => {
          const codeArr = [0];
          const okGet = b.GetExitCodeProcess(hProcess, codeArr);
          if (!okGet || codeArr[0] === STILL_ACTIVE) return;
          clearInterval(timer);
          if (!closed) {
            closed = true;
            b.CloseHandle(hProcess);
          }
          cb(codeArr[0]);
        }, 1000);
        timer.unref();
      },
    };
  } catch {
    return undefined;
  }
}
