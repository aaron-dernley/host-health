/**
 * Portable, zero-privilege Linux host telemetry: disk, thermal, load, and
 * memory state. Every method reads world-readable sources (`/proc`, `/sys`,
 * `df`, `cat`, `find`) so it can run unprivileged on a schedule without
 * touching sudoers. `/proc` reads, `/sys` directory enumeration, and reads
 * of symlinked `/sys` attribute files (every `thermal_zoneN` entry is a
 * symlink into `/sys/devices/...`) all go through a subprocess instead of
 * `Deno.*` fs calls, because Deno's sandbox demands the literal
 * `--allow-all` flag for each of those three operations — which swamp's
 * compiled binary does not grant — even though the files themselves are
 * plain world-readable text. See {@linkcode catFile} and
 * {@linkcode listThermalZoneDirs}. Contains no hardware-vendor specifics —
 * see `@aaronge/rpi-health` for Raspberry Pi hardware signals.
 *
 * @module
 */
import { z } from "npm:zod@4";

const THERMAL_BASE_PATH = "/sys/class/thermal";
const THERMAL_MIN_CELSIUS = -50;
const THERMAL_MAX_CELSIUS = 150;

/**
 * Read a text file via `cat` rather than `Deno.readTextFile`. Two cases need
 * this: `/proc` seq-files (loadavg, meminfo, mounts) report a `stat()` size
 * of 0, and symlinked `/sys` attribute files (e.g. every
 * `thermal_zoneN/temp`, which resolves to `/sys/devices/...`) point outside
 * whatever scoped read-allowlist swamp's compiled binary was granted. Both
 * trip Deno's permission checker into demanding the literal `--allow-all`
 * flag — no scoped `--allow-read`/`--allow-sys` combination satisfies
 * either case. The target file is just as world-readable either way; this
 * works around a Deno sandboxing quirk, not an OS permission requirement.
 */
async function catFile(path: string): Promise<string> {
  const cmd = new Deno.Command("cat", {
    args: [path],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    throw new Error(
      `cat ${path} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

/** Pseudo-filesystem types that never represent real disk-backed storage. */
const VIRTUAL_FSTYPES = new Set([
  "tmpfs",
  "devtmpfs",
  "squashfs",
  "overlay",
  "proc",
  "sysfs",
  "ramfs",
]);

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  /** Log a user-visible progress or state-transition message. */
  info(msg: string, props?: Record<string, unknown>): void;
  /** Log a recoverable issue or degraded-behavior message. */
  warn(msg: string, props?: Record<string, unknown>): void;
}

const GlobalArgsSchema = z.object({
  diskWarnPercent: z.number().min(0).max(100).default(85).describe(
    "Root filesystem usedPercent threshold that trips an assert step. Not consumed by any method directly — read by the host-health workflow's assert job.",
  ),
  tempWarnCelsius: z.number().default(80).describe(
    "Thermal zone maxCelsius threshold that trips an assert step. Matches the Pi 5 soft limit; sensible on most hosts. Not consumed by any method directly.",
  ),
  loadWarnPerCore: z.number().min(0).default(1.5).describe(
    "5-minute load average divided by core count that trips an assert step. Not consumed by any method directly.",
  ),
  memWarnPercent: z.number().min(0).max(100).default(90).describe(
    "Memory usedPercent (based on MemAvailable, not MemFree) that trips an assert step. Not consumed by any method directly.",
  ),
  includeVirtualFs: z.boolean().default(false).describe(
    "Whether readFilesystems includes tmpfs/devtmpfs/other virtual mounts in the filesystems.mounts array.",
  ),
});

/** Validated global arguments for a `@aaronge/host-health` model instance. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const FilesystemMountSchema = z.object({
  device: z.string().describe(
    "Filesystem source device or identifier, e.g. /dev/mmcblk0p2 or /dev/nvme0n1p2. Never hardcode a device path when consuming this field.",
  ),
  mountpoint: z.string().describe("Mount path, e.g. / or /boot/firmware."),
  fstype: z.string().describe(
    "Filesystem type joined from /proc/mounts by mountpoint, e.g. ext4, vfat, tmpfs.",
  ),
  totalBytes: z.number().describe(
    "Total filesystem size in bytes, from df -P -B1.",
  ),
  usedBytes: z.number().describe("Used space in bytes, from df -P -B1."),
  availBytes: z.number().describe("Available space in bytes, from df -P -B1."),
  usedPercent: z.number().describe(
    "Used space as a percent of total, 0-100, one decimal. Computed from bytes here, not parsed from df's own percent column (which rounds and can be reserved-blocks-adjusted).",
  ),
  isVirtual: z.boolean().describe(
    "True for pseudo/virtual filesystems: tmpfs, devtmpfs, squashfs, overlay, proc, sysfs, cgroup*, ramfs.",
  ),
});

const FilesystemsSchema = z.object({
  mounts: z.array(FilesystemMountSchema).describe(
    "One entry per mounted filesystem reported by df -P -B1. Virtual mounts are excluded unless includeVirtualFs is true. Bind mounts and btrfs subvolumes are never deduplicated.",
  ),
  rootUsedPercent: z.number().describe(
    "usedPercent of the mount whose mountpoint is exactly '/', hoisted for readable CEL assert expressions.",
  ),
  worstUsedPercent: z.number().describe(
    "Highest usedPercent across all non-virtual mounts, regardless of includeVirtualFs. 0 when there are no non-virtual mounts.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

const ThermalZoneSchema = z.object({
  zone: z.string().describe(
    "Zone directory name under /sys/class/thermal, e.g. thermal_zone0.",
  ),
  type: z.string().describe(
    "Contents of the zone's type file, naming the sensor.",
  ),
  celsius: z.number().describe(
    "Zone temperature in degrees Celsius, one decimal.",
  ),
});

const ThermalSchema = z.object({
  zones: z.array(ThermalZoneSchema).describe(
    "Every readable, in-range (-50C to 150C) thermal zone found under /sys/class/thermal. Empty when the host exposes no thermal zones (some VMs/containers) — this is a valid, non-error result.",
  ),
  maxCelsius: z.number().nullable().describe(
    "Highest celsius reading across zones, or null when zones is empty.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

const LoadSchema = z.object({
  load1: z.number().describe("1-minute load average from /proc/loadavg."),
  load5: z.number().describe("5-minute load average from /proc/loadavg."),
  load15: z.number().describe("15-minute load average from /proc/loadavg."),
  cores: z.number().describe(
    "Logical CPU core count, counted from /proc/cpuinfo.",
  ),
  load5PerCore: z.number().describe("load5 divided by cores, two decimals."),
  runnable: z.number().describe(
    "Currently runnable process/thread count — the numerator of /proc/loadavg's runnable/total field.",
  ),
  totalProcs: z.number().describe(
    "Total process/thread count — the denominator of /proc/loadavg's runnable/total field.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

const MemorySchema = z.object({
  totalBytes: z.number().describe(
    "MemTotal from /proc/meminfo, converted from kB to bytes.",
  ),
  availableBytes: z.number().describe(
    "MemAvailable from /proc/meminfo, converted from kB to bytes. Reflects reclaimable page cache, unlike MemFree — a healthy host with a full page cache has a low MemFree but a high MemAvailable.",
  ),
  usedPercent: z.number().describe(
    "(totalBytes - availableBytes) / totalBytes * 100, one decimal.",
  ),
  swapTotalBytes: z.number().describe(
    "SwapTotal from /proc/meminfo, converted from kB to bytes.",
  ),
  swapUsedBytes: z.number().describe(
    "(SwapTotal - SwapFree) from /proc/meminfo, converted from kB to bytes.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

/** One filesystem entry parsed from `df -P -B1`, before fstype/virtual classification. */
export interface DfEntry {
  /** Filesystem source device or identifier, e.g. /dev/mmcblk0p2. */
  device: string;
  /** Mount path; the last df field, may contain spaces. */
  mountpoint: string;
  /** Total filesystem size in bytes. */
  totalBytes: number;
  /** Used space in bytes. */
  usedBytes: number;
  /** Available space in bytes. */
  availBytes: number;
}

/**
 * Parse `df -P -B1` output into raw entries. Skips the header line. The
 * mountpoint is the last field and may contain spaces, so each line is split
 * into at most 6 whitespace-delimited fields with the remainder treated as
 * the mountpoint. Malformed lines are skipped, not thrown on.
 */
export function parseDfOutput(text: string): DfEntry[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const dataLines = lines.slice(1); // skip header
  const lineRe = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;
  const entries: DfEntry[] = [];
  for (const line of dataLines) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const [, device, totalStr, usedStr, availStr, , mountpointRaw] = match;
    entries.push({
      device,
      totalBytes: Number(totalStr),
      usedBytes: Number(usedStr),
      availBytes: Number(availStr),
      mountpoint: mountpointRaw.trimEnd(),
    });
  }
  return entries;
}

/**
 * Parse `/proc/mounts` into a mountpoint -> fstype map. `df -P` does not
 * report fstype, so this is the join key for classifying each df entry.
 * The kernel escapes spaces in mountpoints as `\040`; that escape is
 * reversed so lookups match df's unescaped mountpoint text.
 */
export function parseProcMounts(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const mountpoint = parts[1].replace(/\\040/g, " ");
    const fstype = parts[2];
    map.set(mountpoint, fstype);
  }
  return map;
}

/** True for pseudo/virtual filesystems: tmpfs, devtmpfs, squashfs, overlay, proc, sysfs, cgroup*, ramfs. */
export function isVirtualFstype(fstype: string): boolean {
  return VIRTUAL_FSTYPES.has(fstype) || fstype.startsWith("cgroup");
}

/** usedBytes/totalBytes as a percent, one decimal. Returns 0 when totalBytes is 0 (no division by zero). */
export function computeUsedPercent(
  totalBytes: number,
  usedBytes: number,
): number {
  if (totalBytes <= 0) return 0;
  return Math.round((usedBytes / totalBytes) * 1000) / 10;
}

/** One thermal zone reading, unit-normalized to Celsius. */
export interface ThermalZoneReading {
  /** Zone directory name under /sys/class/thermal, e.g. thermal_zone0. */
  zone: string;
  /** Contents of the zone's type file, naming the sensor. */
  type: string;
  /** Zone temperature in degrees Celsius, one decimal. */
  celsius: number;
}

/**
 * List `thermal_zone*` entries directly under `basePath` via `find` rather
 * than `Deno.readDir` — directory enumeration under `/sys` hits the same
 * Deno sandbox limitation as {@linkcode catFile} (`NotCapable` without the
 * literal `--allow-all` flag). No `-type` filter is applied — each
 * `thermal_zoneN` entry is a symlink (`-> ../../devices/.../thermal_zoneN`),
 * not a plain directory, so `find -type d` without `-L` would silently miss
 * every zone; the `thermal_zone\d+` name check below is precise enough on
 * its own. Returns `[]` when `basePath` doesn't exist or `find` otherwise
 * fails, rather than throwing.
 */
async function listThermalZoneDirs(basePath: string): Promise<string[]> {
  const cmd = new Deno.Command("find", {
    args: [
      basePath,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-name",
      "thermal_zone*",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    return [];
  }
  return new TextDecoder().decode(output.stdout)
    .split("\n")
    .map((line) => line.trim().split("/").pop() ?? "")
    .filter((name) => /^thermal_zone\d+$/.test(name))
    .sort();
}

/**
 * Enumerate `thermal_zone*` directories under `basePath` and read each
 * zone's `temp` (millidegrees Celsius) and `type` file. Zero zones is a
 * valid result (some VMs/containers expose none) — returns `{ zones: [],
 * maxCelsius: null }` rather than throwing, including when `basePath`
 * itself does not exist (e.g. a test fixture pointed at an empty temp dir).
 * A zone whose temp is unreadable, non-numeric, or outside -50..150C is
 * skipped with a warning rather than failing the whole read — disconnected
 * sensors emit garbage that would otherwise propagate into an assert.
 */
export async function readThermalZones(
  basePath: string,
  logger?: MinimalLogger,
): Promise<{ zones: ThermalZoneReading[]; maxCelsius: number | null }> {
  const zoneNames = await listThermalZoneDirs(basePath);

  const zones: ThermalZoneReading[] = [];
  for (const zoneName of zoneNames) {
    try {
      const [tempRaw, typeRaw] = await Promise.all([
        catFile(`${basePath}/${zoneName}/temp`),
        catFile(`${basePath}/${zoneName}/type`),
      ]);
      const milliCelsius = Number(tempRaw.trim());
      if (!Number.isFinite(milliCelsius)) {
        logger?.warn(
          "Skipping thermal zone {zone}: unreadable temp value {raw}",
          {
            zone: zoneName,
            raw: tempRaw.trim(),
          },
        );
        continue;
      }
      const celsius = Math.round(milliCelsius / 100) / 10;
      if (celsius < THERMAL_MIN_CELSIUS || celsius > THERMAL_MAX_CELSIUS) {
        logger?.warn(
          "Skipping thermal zone {zone}: {celsius}C outside sane range",
          {
            zone: zoneName,
            celsius,
          },
        );
        continue;
      }
      zones.push({ zone: zoneName, type: typeRaw.trim(), celsius });
    } catch (error) {
      logger?.warn("Skipping thermal zone {zone}: {error}", {
        zone: zoneName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const maxCelsius = zones.length > 0
    ? Math.max(...zones.map((z) => z.celsius))
    : null;
  return { zones, maxCelsius };
}

/** Parsed `/proc/loadavg` fields, excluding the trailing last-created-PID field (not part of this model's schema). */
export interface LoadAvgReading {
  /** 1-minute load average. */
  load1: number;
  /** 5-minute load average. */
  load5: number;
  /** 15-minute load average. */
  load15: number;
  /** Currently runnable process/thread count. */
  runnable: number;
  /** Total process/thread count. */
  totalProcs: number;
}

/** Parse a single-line `/proc/loadavg` string: "load1 load5 load15 runnable/total lastPid". */
export function parseLoadAvg(text: string): LoadAvgReading {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) {
    throw new Error(`Unexpected /proc/loadavg format: "${text.trim()}"`);
  }
  const [load1Str, load5Str, load15Str, procsField] = parts;
  const [runnableStr, totalStr] = procsField.split("/");
  if (runnableStr === undefined || totalStr === undefined) {
    throw new Error(
      `Unexpected /proc/loadavg runnable/total field: "${procsField}"`,
    );
  }
  return {
    load1: Number(load1Str),
    load5: Number(load5Str),
    load15: Number(load15Str),
    runnable: Number(runnableStr),
    totalProcs: Number(totalStr),
  };
}

/**
 * Count logical CPU cores from `/proc/cpuinfo` by counting `processor :`
 * lines. Preferred over Node's `os.cpus()` here to stay in this model's
 * "read /proc and /sys directly" style and avoid a Node-compat dependency
 * for a single integer.
 */
export function countCpuCores(cpuinfoText: string): number {
  const matches = cpuinfoText.match(/^processor\s*:/gm);
  return matches ? matches.length : 0;
}

/** Parse `/proc/meminfo` `Key: value kB` lines into a key -> kibibyte map. */
export function parseMemInfo(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const rawLine of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB\s*$/.exec(rawLine.trim());
    if (match) {
      map.set(match[1], Number(match[2]));
    }
  }
  return map;
}

/** Model definition for `@aaronge/host-health` — disk, thermal, load, and memory telemetry for any Linux host. */
export const model = {
  type: "@aaronge/host-health",
  version: "2026.08.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    filesystems: {
      description:
        "Per-mount disk usage, with root and worst-case usedPercent hoisted for CEL asserts.",
      schema: FilesystemsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    thermal: {
      description: "Per-zone temperature readings from /sys/class/thermal.",
      schema: ThermalSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    load: {
      description:
        "System load averages and process counts from /proc/loadavg.",
      schema: LoadSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    memory: {
      description:
        "Memory and swap usage from /proc/meminfo, based on MemAvailable.",
      schema: MemorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    readFilesystems: {
      description:
        "Run `df -P -B1`, classify each mount as virtual or real via /proc/mounts fstype, and write the filesystems resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const capturedAt = new Date().toISOString();

        context.logger.info("Reading filesystem usage via df -P -B1");
        const dfCmd = new Deno.Command("df", {
          args: ["-P", "-B1"],
          stdout: "piped",
          stderr: "piped",
        });
        const dfOutput = await dfCmd.output();
        if (!dfOutput.success) {
          throw new Error(
            `df -P -B1 failed: ${
              new TextDecoder().decode(dfOutput.stderr).trim()
            }`,
          );
        }
        const dfEntries = parseDfOutput(
          new TextDecoder().decode(dfOutput.stdout),
        );
        const fstypeByMountpoint = parseProcMounts(
          await catFile("/proc/mounts"),
        );

        const allMounts = dfEntries.map((entry) => {
          const fstype = fstypeByMountpoint.get(entry.mountpoint);
          if (fstype === undefined) {
            context.logger.warn(
              "No /proc/mounts entry for mountpoint {mountpoint}; fstype set to 'unknown'",
              { mountpoint: entry.mountpoint },
            );
          }
          return {
            device: entry.device,
            mountpoint: entry.mountpoint,
            fstype: fstype ?? "unknown",
            totalBytes: entry.totalBytes,
            usedBytes: entry.usedBytes,
            availBytes: entry.availBytes,
            usedPercent: computeUsedPercent(entry.totalBytes, entry.usedBytes),
            isVirtual: isVirtualFstype(fstype ?? "unknown"),
          };
        });

        const nonVirtualMounts = allMounts.filter((m) => !m.isVirtual);
        const worstUsedPercent = nonVirtualMounts.length > 0
          ? Math.max(...nonVirtualMounts.map((m) => m.usedPercent))
          : 0;

        const rootMount = allMounts.find((m) => m.mountpoint === "/");
        if (!rootMount) {
          throw new Error("df -P -B1 output has no mount at '/'");
        }

        const mounts = context.globalArgs.includeVirtualFs
          ? allMounts
          : nonVirtualMounts;

        context.logger.info(
          "Captured {count} filesystem mounts; root {rootPercent}% used, worst {worstPercent}% used",
          {
            count: mounts.length,
            rootPercent: rootMount.usedPercent,
            worstPercent: worstUsedPercent,
          },
        );

        const handle = await context.writeResource(
          "filesystems",
          "filesystems",
          {
            mounts,
            rootUsedPercent: rootMount.usedPercent,
            worstUsedPercent,
            capturedAt,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    readThermal: {
      description:
        "Read every thermal zone under /sys/class/thermal, sanity-checked to -50..150C, and write the thermal resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const capturedAt = new Date().toISOString();
        context.logger.info("Reading thermal zones from {basePath}", {
          basePath: THERMAL_BASE_PATH,
        });
        const { zones, maxCelsius } = await readThermalZones(
          THERMAL_BASE_PATH,
          context.logger,
        );
        context.logger.info("Captured {count} thermal zones, max {max}C", {
          count: zones.length,
          max: maxCelsius,
        });
        const handle = await context.writeResource("thermal", "thermal", {
          zones,
          maxCelsius,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readLoad: {
      description:
        "Read /proc/loadavg and core count from /proc/cpuinfo, and write the load resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const capturedAt = new Date().toISOString();
        const [loadavgText, cpuinfoText] = await Promise.all([
          catFile("/proc/loadavg"),
          catFile("/proc/cpuinfo"),
        ]);
        const { load1, load5, load15, runnable, totalProcs } = parseLoadAvg(
          loadavgText,
        );
        const cores = countCpuCores(cpuinfoText);
        if (cores <= 0) {
          throw new Error(
            "Could not determine CPU core count from /proc/cpuinfo",
          );
        }
        const load5PerCore = Math.round((load5 / cores) * 100) / 100;

        context.logger.info(
          "Captured load: 1m={load1} 5m={load5} 15m={load15} cores={cores} perCore={load5PerCore}",
          { load1, load5, load15, cores, load5PerCore },
        );

        const handle = await context.writeResource("load", "load", {
          load1,
          load5,
          load15,
          cores,
          load5PerCore,
          runnable,
          totalProcs,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readMemory: {
      description:
        "Read /proc/meminfo, using MemAvailable (not MemFree) for usedPercent, and write the memory resource.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          logger: MinimalLogger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const capturedAt = new Date().toISOString();
        const meminfo = parseMemInfo(await catFile("/proc/meminfo"));

        const memTotalKb = meminfo.get("MemTotal");
        const memAvailableKb = meminfo.get("MemAvailable");
        const swapTotalKb = meminfo.get("SwapTotal");
        const swapFreeKb = meminfo.get("SwapFree");

        if (memTotalKb === undefined) {
          throw new Error("MemTotal missing from /proc/meminfo");
        }
        if (memAvailableKb === undefined) {
          throw new Error(
            "MemAvailable missing from /proc/meminfo (present on every kernel since 3.14) — refusing to fall back to MemFree, which would misreport reclaimable page cache as used memory",
          );
        }
        if (swapTotalKb === undefined) {
          throw new Error("SwapTotal missing from /proc/meminfo");
        }
        if (swapFreeKb === undefined) {
          throw new Error("SwapFree missing from /proc/meminfo");
        }

        const totalBytes = memTotalKb * 1024;
        const availableBytes = memAvailableKb * 1024;
        const swapTotalBytes = swapTotalKb * 1024;
        const swapUsedBytes = (swapTotalKb - swapFreeKb) * 1024;
        const usedPercent = computeUsedPercent(
          totalBytes,
          totalBytes - availableBytes,
        );

        context.logger.info(
          "Captured memory: {usedPercent}% used, {availableBytes} bytes available",
          {
            usedPercent,
            availableBytes,
          },
        );

        const handle = await context.writeResource("memory", "memory", {
          totalBytes,
          availableBytes,
          usedPercent,
          swapTotalBytes,
          swapUsedBytes,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
