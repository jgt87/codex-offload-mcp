import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The npm package ships the real Rust binary inside a per-platform sub-package.
 * Resolving it lets us spawn with an argv array instead of going through the
 * `codex.cmd` shim, which on Windows would force `shell: true` and drag in
 * shell quoting rules.
 */
const TRIPLES: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

export interface CodexBin {
  /** Executable path, or bare "codex" when we had to fall back to PATH. */
  command: string;
  /** True when `command` is a shim that needs a shell to launch. */
  useShell: boolean;
}

let cached: CodexBin | undefined;

function vendoredPath(npmRoot: string): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  const triple = TRIPLES[key];
  if (!triple) return undefined;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const candidate = path.join(
    npmRoot,
    "@openai/codex/node_modules",
    `@openai/codex-${key}`,
    "vendor",
    triple,
    "bin",
    exe,
  );
  return fs.existsSync(candidate) ? candidate : undefined;
}

function globalRootCandidates(): string[] {
  const home = os.homedir();
  const nodeDir = path.dirname(process.execPath);
  return process.platform === "win32"
    ? [
        path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "npm/node_modules"),
        path.join(nodeDir, "node_modules"),
      ]
    : [
        "/usr/local/lib/node_modules",
        "/usr/lib/node_modules",
        path.join(home, ".npm-global/lib/node_modules"),
        path.join(nodeDir, "../lib/node_modules"),
      ];
}

export function resolveCodexBin(): CodexBin {
  if (cached) return cached;

  const override = process.env.CODEX_BIN;
  if (override && fs.existsSync(override)) {
    cached = { command: override, useShell: false };
    return cached;
  }

  // Check the usual global-install roots before paying for an `npm` subprocess,
  // which is slow and would delay every server start.
  for (const root of globalRootCandidates()) {
    const found = vendoredPath(root);
    if (found) {
      cached = { command: found, useShell: false };
      return cached;
    }
  }

  try {
    const npmRoot = execSync("npm root -g", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const found = npmRoot && vendoredPath(npmRoot);
    if (found) {
      cached = { command: found, useShell: false };
      return cached;
    }
  } catch {
    // fall through to PATH
  }

  // Last resort: the shim on PATH. Every argument we pass is either a flag or a
  // path we control, and the prompt travels over stdin, so this stays safe.
  cached = { command: "codex", useShell: process.platform === "win32" };
  return cached;
}
