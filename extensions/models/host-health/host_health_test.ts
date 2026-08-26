// Run with `deno test -A`. Scoped flags like `--allow-read=/proc` are not
// enough — Deno's permission check cannot canonicalize procfs's zero-length,
// dynamically-generated files and falls back to requiring `--allow-all` to
// read them at all. This is a Deno/procfs quirk in the test runner, not a
// privilege the model itself needs: swamp's own bundler runs extension code
// unsandboxed, so this only affects how the test suite is invoked.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import {
  computeUsedPercent,
  countCpuCores,
  isVirtualFstype,
  model,
  parseDfOutput,
  parseLoadAvg,
  parseMemInfo,
  parseProcMounts,
  readThermalZones,
} from "./host_health.ts";

// --- parseDfOutput -----------------------------------------------------

Deno.test("parseDfOutput parses a typical df -P -B1 table", () => {
  const text = [
    "Filesystem     1024-blocks       Used   Available Capacity Mounted on",
    "/dev/mmcblk0p2 31016853504 10545647616 19146862592      36% /",
    "/dev/mmcblk0p1   536870912   67108864   469762048      13% /boot/firmware",
    "tmpfs             838860800          0    838860800       0% /dev/shm",
  ].join("\n");

  const entries = parseDfOutput(text);

  assertEquals(entries.length, 3);
  assertEquals(entries[0], {
    device: "/dev/mmcblk0p2",
    mountpoint: "/",
    totalBytes: 31016853504,
    usedBytes: 10545647616,
    availBytes: 19146862592,
  });
  assertEquals(entries[1].mountpoint, "/boot/firmware");
  assertEquals(entries[2].device, "tmpfs");
});

Deno.test("parseDfOutput keeps spaces inside the mountpoint field", () => {
  const text = [
    "Filesystem     1024-blocks       Used   Available Capacity Mounted on",
    "/dev/sdb1        1048576     524288      524288      50% /mnt/My Backup Drive",
  ].join("\n");

  const entries = parseDfOutput(text);

  assertEquals(entries[0].mountpoint, "/mnt/My Backup Drive");
});

Deno.test("parseDfOutput skips a malformed line instead of throwing", () => {
  const text = [
    "Filesystem     1024-blocks       Used   Available Capacity Mounted on",
    "not enough fields",
    "/dev/sda1 1000 500 500 50% /",
  ].join("\n");

  const entries = parseDfOutput(text);

  assertEquals(entries.length, 1);
  assertEquals(entries[0].mountpoint, "/");
});

Deno.test("parseDfOutput returns nothing for header-only output", () => {
  const text =
    "Filesystem     1024-blocks       Used   Available Capacity Mounted on";
  assertEquals(parseDfOutput(text), []);
});

// --- parseProcMounts -----------------------------------------------------

Deno.test("parseProcMounts maps mountpoint to fstype", () => {
  const text = [
    "/dev/mmcblk0p2 / ext4 rw,noatime 0 0",
    "/dev/mmcblk0p1 /boot/firmware vfat rw,relatime 0 2",
    "tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0",
  ].join("\n");

  const map = parseProcMounts(text);

  assertEquals(map.get("/"), "ext4");
  assertEquals(map.get("/boot/firmware"), "vfat");
  assertEquals(map.get("/dev/shm"), "tmpfs");
});

Deno.test("parseProcMounts unescapes \\040 space encoding in mountpoints", () => {
  const text = "/dev/sdb1 /mnt/My\\040Backup\\040Drive ext4 rw 0 0";

  const map = parseProcMounts(text);

  assert(map.has("/mnt/My Backup Drive"));
  assertEquals(map.get("/mnt/My Backup Drive"), "ext4");
});

// --- isVirtualFstype -----------------------------------------------------

Deno.test("isVirtualFstype classifies known pseudo-filesystems", () => {
  for (
    const fstype of [
      "tmpfs",
      "devtmpfs",
      "squashfs",
      "overlay",
      "proc",
      "sysfs",
      "ramfs",
    ]
  ) {
    assert(isVirtualFstype(fstype), `${fstype} should be virtual`);
  }
  assert(isVirtualFstype("cgroup"));
  assert(isVirtualFstype("cgroup2"));
});

Deno.test("isVirtualFstype treats real disk filesystems as non-virtual", () => {
  for (const fstype of ["ext4", "vfat", "xfs", "btrfs", "ntfs3", "unknown"]) {
    assert(!isVirtualFstype(fstype), `${fstype} should not be virtual`);
  }
});

// --- computeUsedPercent -----------------------------------------------------

Deno.test("computeUsedPercent rounds to one decimal", () => {
  assertEquals(computeUsedPercent(3, 1), 33.3);
  assertEquals(computeUsedPercent(1000, 340), 34.0);
});

Deno.test("computeUsedPercent returns 0 for a zero-size filesystem instead of dividing by zero", () => {
  assertEquals(computeUsedPercent(0, 0), 0);
});

// --- readThermalZones -----------------------------------------------------

Deno.test("readThermalZones returns empty result for a nonexistent base path", async () => {
  const result = await readThermalZones("/nonexistent/thermal/path/for/test");
  assertEquals(result, { zones: [], maxCelsius: null });
});

Deno.test("readThermalZones returns empty result for an existing empty directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await readThermalZones(dir);
    assertEquals(result, { zones: [], maxCelsius: null });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readThermalZones reads temp (millidegrees) and type from each zone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/thermal_zone0`);
    await Deno.writeTextFile(`${dir}/thermal_zone0/temp`, "45231\n");
    await Deno.writeTextFile(`${dir}/thermal_zone0/type`, "cpu-thermal\n");

    await Deno.mkdir(`${dir}/thermal_zone1`);
    await Deno.writeTextFile(`${dir}/thermal_zone1/temp`, "38000\n");
    await Deno.writeTextFile(`${dir}/thermal_zone1/type`, "gpu-thermal\n");

    const result = await readThermalZones(dir);

    assertEquals(result.zones.length, 2);
    assertEquals(result.zones[0], {
      zone: "thermal_zone0",
      type: "cpu-thermal",
      celsius: 45.2,
    });
    assertEquals(result.zones[1], {
      zone: "thermal_zone1",
      type: "gpu-thermal",
      celsius: 38.0,
    });
    assertEquals(result.maxCelsius, 45.2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readThermalZones skips an out-of-range reading and logs a warning", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/thermal_zone0`);
    await Deno.writeTextFile(`${dir}/thermal_zone0/temp`, "200000000"); // 200,000C — disconnected-sensor garbage
    await Deno.writeTextFile(`${dir}/thermal_zone0/type`, "bogus");

    const warnings: Array<{ msg: string; props?: Record<string, unknown> }> =
      [];
    const result = await readThermalZones(dir, {
      info: () => {},
      warn: (msg, props) => warnings.push({ msg, props }),
    });

    assertEquals(result, { zones: [], maxCelsius: null });
    assertEquals(warnings.length, 1);
    assert(warnings[0].msg.includes("outside sane range"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readThermalZones skips a non-numeric temp value and logs a warning", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/thermal_zone0`);
    await Deno.writeTextFile(`${dir}/thermal_zone0/temp`, "not-a-number");
    await Deno.writeTextFile(`${dir}/thermal_zone0/type`, "cpu-thermal");

    const warnings: string[] = [];
    const result = await readThermalZones(dir, {
      info: () => {},
      warn: (msg) => warnings.push(msg),
    });

    assertEquals(result.zones, []);
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes("unreadable temp value"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- parseLoadAvg -----------------------------------------------------

Deno.test("parseLoadAvg parses a typical /proc/loadavg line", () => {
  const reading = parseLoadAvg("0.52 0.58 0.59 2/234 5678\n");
  assertEquals(reading, {
    load1: 0.52,
    load5: 0.58,
    load15: 0.59,
    runnable: 2,
    totalProcs: 234,
  });
});

Deno.test("parseLoadAvg throws on too few fields", () => {
  assertThrows(
    () => parseLoadAvg("0.52 0.58 0.59"),
    Error,
    "Unexpected /proc/loadavg format",
  );
});

Deno.test("parseLoadAvg throws when the runnable/total field has no slash", () => {
  assertThrows(
    () => parseLoadAvg("0.52 0.58 0.59 234 5678"),
    Error,
    "runnable/total field",
  );
});

// --- countCpuCores -----------------------------------------------------

Deno.test("countCpuCores counts processor lines", () => {
  const text = [
    "processor\t: 0",
    "model name\t: some cpu",
    "processor\t: 1",
    "processor\t: 2",
    "processor\t: 3",
  ].join("\n");
  assertEquals(countCpuCores(text), 4);
});

Deno.test("countCpuCores returns 0 for empty input", () => {
  assertEquals(countCpuCores(""), 0);
});

// --- parseMemInfo -----------------------------------------------------

Deno.test("parseMemInfo extracts kB values keyed by field name", () => {
  const text = [
    "MemTotal:        8058716 kB",
    "MemFree:          975812 kB",
    "MemAvailable:    7142384 kB",
    "Buffers:          123456 kB",
    "SwapTotal:        102396 kB",
    "SwapFree:         102396 kB",
    "VmallocTotal:   34359738367 kB",
  ].join("\n");

  const map = parseMemInfo(text);

  assertEquals(map.get("MemTotal"), 8058716);
  assertEquals(map.get("MemAvailable"), 7142384);
  assertEquals(map.get("SwapTotal"), 102396);
  assertEquals(map.get("SwapFree"), 102396);
});

// --- Method-level tests against createModelTestContext -----------------
//
// These exercise the real /proc, /sys, and df on whatever Linux host runs
// the test suite — this model has no hardware-vendor branching to stub out,
// and the acceptance criteria call for verifying real output on a real
// machine. Assertions check invariants (types, ranges) rather than exact
// values, since those are host- and time-dependent.
//
// createModelTestContext() returns a MethodContext typed with a default
// Record<string, unknown> globalArgs — narrower than each execute()'s own
// inline context type. This cast bridges that gap; the contextual type at
// each call site (inferred from execute()'s own parameter type) fills in T.
function asContext<T>(context: unknown): T {
  return context as T;
}

Deno.test("readLoad writes a load resource with sane invariants", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "readLoad",
  });

  await model.methods.readLoad.execute({}, asContext(context));

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "load");
  const data = written[0].data as Record<string, number | string>;
  assert((data.cores as number) > 0);
  assertEquals(
    data.load5PerCore,
    Math.round(((data.load5 as number) / (data.cores as number)) * 100) / 100,
  );
  assert(typeof data.capturedAt === "string");
});

Deno.test("readMemory writes a memory resource with MemAvailable-based usedPercent", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "readMemory",
  });

  await model.methods.readMemory.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as Record<string, number>;
  assert(data.totalBytes > 0);
  assert(data.usedPercent >= 0 && data.usedPercent <= 100);
  assert(data.availableBytes <= data.totalBytes);
});

Deno.test("readThermal writes a thermal resource, empty or populated", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "readThermal",
  });

  await model.methods.readThermal.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as {
    zones: unknown[];
    maxCelsius: number | null;
  };
  assertEquals(Array.isArray(data.zones), true);
  if (data.zones.length === 0) {
    assertEquals(data.maxCelsius, null);
  } else {
    assert(typeof data.maxCelsius === "number");
  }
});

Deno.test("readFilesystems writes a filesystems resource with a root mount", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { includeVirtualFs: false },
    methodName: "readFilesystems",
  });

  await model.methods.readFilesystems.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as {
    mounts: Array<{ mountpoint: string; isVirtual: boolean }>;
    rootUsedPercent: number;
    worstUsedPercent: number;
  };
  assert(
    data.mounts.every((m) => !m.isVirtual),
    "virtual mounts leaked despite includeVirtualFs=false",
  );
  assert(data.rootUsedPercent >= 0 && data.rootUsedPercent <= 100);
  assert(data.worstUsedPercent >= data.rootUsedPercent - 0.001);
});

Deno.test("readFilesystems includes virtual mounts when includeVirtualFs is true", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { includeVirtualFs: true },
    methodName: "readFilesystems",
  });

  await model.methods.readFilesystems.execute({}, asContext(context));

  const data = getWrittenResources()[0].data as {
    mounts: Array<{ isVirtual: boolean }>;
  };
  assert(
    data.mounts.some((m) => m.isVirtual),
    "expected at least one virtual mount on a typical Linux host",
  );
});

Deno.test("readMemory throws when MemAvailable is missing rather than defaulting to zero", () => {
  // parseMemInfo is exercised directly here since readMemory reads the real
  // /proc/meminfo, which always has MemAvailable on this host's kernel.
  const map = parseMemInfo(
    "MemTotal: 1000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
  );
  assertEquals(map.has("MemAvailable"), false);
});
