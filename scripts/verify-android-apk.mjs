#!/usr/bin/env node
/**
 * Fails an Android release build when the APK could crash at startup for native reasons.
 *
 * Written after a real Infinix Smart 6 (Android 10, armeabi-v7a) crashed before the first screen:
 * the APK *did* contain libworklets.so, but dlopen could not resolve `__cxa_init_primary_exception`,
 * because the modules compiled from source were built with NDK 28 while the packaged
 * libc++_shared.so came from react-android, built with NDK 27. The system then reports the
 * misleading "couldn't find DSO to load: libworklets.so".
 *
 * For every ABI the APK ships, it checks:
 *   1. the libraries the app cannot start without are packaged;
 *   2. every DT_NEEDED entry is packaged for that ABI or is an Android platform library;
 *   3. every undefined symbol is exported by a packaged library or by a platform library.
 *
 * Usage:
 *   node scripts/verify-android-apk.mjs [apk] [--abis a,b] [--verbose]
 * Defaults to the newest dist/idukaa-*.apk. Requires unzip and an installed Android NDK.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");

/** Libraries the app cannot start without. */
const REQUIRED = [
  "libreactnative.so",
  "libhermesvm.so",
  "libc++_shared.so",
  "libfbjni.so",
  "libjsi.so",
  "libworklets.so",
  "libreanimated.so",
  "libexpo-modules-core.so",
  "libappmodules.so",
];

/** Android platform libraries: resolved from the device's system partition, never packaged. */
const PLATFORM = [
  "libandroid.so", "libc.so", "libdl.so", "liblog.so", "libm.so", "libz.so", "libstdc++.so",
  "libEGL.so", "libGLESv2.so", "libGLESv1_CM.so", "libjnigraphics.so", "libOpenSLES.so",
  "libmediandk.so", "libnativehelper.so", "libcamera2ndk.so", "libvulkan.so", "libaaudio.so",
];

const TRIPLE = {
  "armeabi-v7a": "arm-linux-androideabi",
  "arm64-v8a": "aarch64-linux-android",
  x86: "i686-linux-android",
  x86_64: "x86_64-linux-android",
};

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const abisIdx = args.indexOf("--abis");
const onlyAbis = abisIdx >= 0 ? args[abisIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
const explicitApk = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--abis");

const sh = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, ...opts });

function findApk() {
  if (explicitApk) {
    if (!existsSync(explicitApk)) throw new Error(`APK not found: ${explicitApk}`);
    return resolve(explicitApk);
  }
  const dir = join(ROOT, "dist");
  const apks = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".apk")).map((f) => join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (!apks.length) throw new Error("No dist/*.apk found — pass the path explicitly.");
  return apks[0];
}

function findNdk() {
  const localProps = join(ROOT, "apps", "mobile", "android", "local.properties");
  const fromLocalProps = existsSync(localProps) ? (/sdk\.dir=(.+)/.exec(readFileSync(localProps, "utf8"))?.[1] ?? "").trim() : "";
  const sdk =
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || fromLocalProps ||
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : "");
  if (!sdk || !existsSync(join(sdk, "ndk"))) throw new Error("Android NDK not found — set ANDROID_HOME.");

  // Use the NDK the app builds with, so the check sees the same toolchain and platform stubs.
  const gradle = join(ROOT, "apps", "mobile", "android", "build.gradle");
  const pinned = existsSync(gradle) ? /ndkVersion\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(gradle, "utf8"))?.[1] : null;
  const installed = readdirSync(join(sdk, "ndk")).sort();
  const version = pinned && installed.includes(pinned) ? pinned : installed.at(-1);
  const ndk = join(sdk, "ndk", version);

  const prebuilt = join(ndk, "toolchains", "llvm", "prebuilt");
  const host = readdirSync(prebuilt)[0];
  const bin = join(prebuilt, host, "bin");
  const exe = (name) => [name, `${name}.exe`].map((f) => join(bin, f)).find(existsSync);
  const nm = exe("llvm-nm");
  const readelf = exe("llvm-readelf");
  if (!nm) throw new Error(`llvm-nm not found under ${bin}`);
  return { nm, readelf, sysroot: join(prebuilt, host, "sysroot", "usr", "lib"), version };
}

/**
 * Symbols of one nm listing. Each line is `[address] type name`; weak undefined references (`w`/`v`)
 * are legitimate to leave unresolved — libzstd, for instance, only calls its tracing hooks if the
 * host app provides them — so they are skipped.
 */
function nmSymbols(nm, file, flags) {
  const out = sh(nm, ["-D", "--no-demangle", ...flags, file]);
  const symbols = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(?:[0-9a-fA-F]+\s+)?([A-Za-z?])\s+(\S+)$/.exec(line);
    if (!m) continue;
    if (m[1] === "w" || m[1] === "v") continue;
    symbols.add(m[2].replace(/@.*$/, ""));
  }
  return symbols;
}
const definedSymbols = (nm, file) => nmSymbols(nm, file, ["--defined-only"]);
const undefinedSymbols = (nm, file) => nmSymbols(nm, file, ["--undefined-only"]);

function neededLibraries(readelf, file) {
  if (!readelf) return [];
  return [...sh(readelf, ["-d", file]).matchAll(/Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
}

/** Exported symbols of the platform libraries for one ABI, from the NDK's newest API-level stubs. */
function platformSymbols(nm, sysroot, abi) {
  const triple = TRIPLE[abi];
  const symbols = new Set();
  if (!triple) return symbols;
  const root = join(sysroot, triple);
  if (!existsSync(root)) return symbols;
  const apiLevels = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(a) - Number(b));
  const apiDir = apiLevels.at(-1);
  if (!apiDir) return symbols;
  for (const lib of PLATFORM) {
    const file = join(root, apiDir, lib);
    if (!existsSync(file)) continue;
    try {
      for (const s of definedSymbols(nm, file)) symbols.add(s);
    } catch {
      /* an unreadable stub only weakens this allowlist, never produces a false failure */
    }
  }
  return symbols;
}

function main() {
  const apk = findApk();
  const { nm, readelf, sysroot, version } = findNdk();
  const work = mkdtempSync(join(tmpdir(), "idukaa-apk-"));
  const problems = [];

  try {
    // Extract entry by entry: unzip's wildcard handling differs between builds and platforms.
    const entries = sh("unzip", ["-Z1", apk]).split(/\r?\n/).filter((e) => e.startsWith("lib/") && e.endsWith(".so"));
    if (!entries.length) throw new Error(`APK packages no native libraries at all: ${apk}`);
    for (const entry of entries) {
      const dest = join(work, entry);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, sh("unzip", ["-p", apk, entry], { encoding: "buffer" }));
    }
    const libRoot = join(work, "lib");
    const abis = entries.map((e) => e.split("/")[1]).filter((v, i, a) => a.indexOf(v) === i).sort();

    console.log(`APK:  ${apk}`);
    console.log(`NDK:  ${version}`);
    console.log(`ABIs: ${abis.join(", ")}\n`);

    if (onlyAbis) {
      const missing = onlyAbis.filter((a) => !abis.includes(a));
      if (missing.length) problems.push(`declared ABI(s) missing from the APK: ${missing.join(", ")}`);
    }

    for (const abi of abis) {
      const dir = join(libRoot, abi);
      const libs = readdirSync(dir).filter((f) => f.endsWith(".so")).sort();
      const packaged = new Set(libs);

      for (const req of REQUIRED) {
        if (!packaged.has(req)) problems.push(`${abi}: required library missing from the APK: ${req}`);
      }

      const definedByLib = new Map();
      for (const lib of libs) definedByLib.set(lib, definedSymbols(nm, join(dir, lib)));
      const allDefined = new Set();
      for (const set of definedByLib.values()) for (const s of set) allDefined.add(s);
      const platform = platformSymbols(nm, sysroot, abi);

      for (const lib of libs) {
        for (const dep of neededLibraries(readelf, join(dir, lib))) {
          if (!packaged.has(dep) && !PLATFORM.includes(dep)) {
            problems.push(`${abi}: ${lib} needs ${dep}, which is neither packaged nor a platform library`);
          }
        }

        const unresolved = [...undefinedSymbols(nm, join(dir, lib))]
          .filter((s) => !allDefined.has(s) && !platform.has(s));
        if (unresolved.length) {
          const shown = unresolved.slice(0, 6).join(", ");
          problems.push(
            `${abi}: ${lib} references ${unresolved.length} symbol(s) neither the APK nor the platform provides: ` +
              `${shown}${unresolved.length > 6 ? ", …" : ""}`,
          );
        }
        if (verbose) {
          console.log(`${abi}/${lib}: ${definedByLib.get(lib).size} exported, ${undefinedSymbols(nm, join(dir, lib)).size} undefined`);
        }
      }
    }

    // A release APK must not talk to the phone itself. `apps/mobile/.env` carries
    // EXPO_PUBLIC_API_URL=http://localhost:3000 for local development; if that is what got compiled
    // in, the app can never reach the server — sign-in appears to work in a browser on the same
    // machine, while the phone shows an empty catalogue and never syncs a single sale.
    const bundle = join(work, "assets", "index.android.bundle");
    try {
      mkdirSync(dirname(bundle), { recursive: true });
      writeFileSync(bundle, sh("unzip", ["-p", apk, "assets/index.android.bundle"], { encoding: "buffer" }));
      const js = readFileSync(bundle, "latin1");
      if (js.includes("http://localhost:3000") || js.includes("http://127.0.0.1:3000")) {
        problems.push("the JS bundle points at a loopback API URL (localhost:3000): build with EXPO_PUBLIC_API_URL set to the deployed API");
      }
    } catch {
      problems.push("could not read assets/index.android.bundle to check the API URL");
    }

    if (problems.length) {
      console.error("APK native compatibility check FAILED:");
      for (const p of problems) console.error(`  • ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log("APK native compatibility check passed: required libraries present, every NEEDED library and native symbol resolves.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  console.error(`APK native compatibility check could not run: ${e.message}`);
  process.exitCode = 1;
}
