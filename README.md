# @aaronge/host-health

Zero-privilege Linux host telemetry — disk, thermal, load, and memory state
as a typed, versioned Swamp model. Every method reads world-readable sources
(`df`, `/proc`, `/sys`) and needs no root or sudoers entry, so it's safe to
run on a schedule. It's built for assertions inside workflows and for
joining host state into other Swamp models via CEL — not a replacement for
Prometheus + node_exporter if what you actually want is graphs and
alerting at scale.

Contains no hardware-vendor specifics. Raspberry Pi hardware signals (e.g.
`vcgencmd`) live in the separate `@aaronge/rpi-health` extension.

## Installation

```sh
swamp extension pull @aaronge/host-health
```

## Usage

```sh
swamp model create @aaronge/host-health host-local \
  --global-arg 'diskWarnPercent=85' \
  --global-arg 'tempWarnCelsius=80' \
  --global-arg 'loadWarnPerCore=1.5' \
  --global-arg 'memWarnPercent=90'

swamp model method run host-local readFilesystems
swamp model method run host-local readThermal
swamp model method run host-local readLoad
swamp model method run host-local readMemory
```

Each method writes one resource: `filesystems`, `thermal`, `load`, `memory`.
Every field is unit-suffixed (`Bytes`, `Percent`, `celsius`) and described —
run `swamp model type describe @aaronge/host-health` to see the full schema.

Reference the latest snapshot from a workflow assert step or another model:

```yaml
expr: >-
  data.latest("host-local", "filesystems").attributes.rootUsedPercent < 85
```

## Global arguments

| Arg                | Default | Notes                                             |
| ------------------- | ------- | -------------------------------------------------- |
| `diskWarnPercent`   | `85`    | Root filesystem usedPercent warn threshold.        |
| `tempWarnCelsius`   | `80`    | Thermal zone maxCelsius warn threshold.            |
| `loadWarnPerCore`   | `1.5`   | 5-minute load average divided by core count.       |
| `memWarnPercent`    | `90`    | Memory usedPercent, based on `MemAvailable`.       |
| `includeVirtualFs`  | `false` | Include tmpfs/devtmpfs/etc. in `filesystems.mounts`.|

These thresholds aren't consumed by the methods themselves — they document
the intended limits for a given host. A workflow that asserts against them
declares matching `inputs` with the same defaults (see the bundled
`host-health` workflow) since a workflow's CEL expressions can't reach into
a model definition's global arguments directly.

## How it works

- **`filesystems`** — parses `df -P -B1`, joins `fstype` from `/proc/mounts`
  by mountpoint, and computes `usedPercent` from raw bytes rather than
  trusting `df`'s own (rounded, reserved-blocks-adjusted) percent column.
  `rootUsedPercent` and `worstUsedPercent` are hoisted onto the resource so
  assert expressions don't need to filter the `mounts` array.
- **`thermal`** — enumerates `thermal_zone*` under `/sys/class/thermal` and
  sanity-checks each reading to -50..150°C; a disconnected sensor gets
  skipped with a warning instead of propagating a bogus value into an
  assert. Zero zones (some VMs/containers) is a valid, non-error result.
- **`load`** — `/proc/loadavg` plus a core count from `/proc/cpuinfo`.
- **`memory`** — `/proc/meminfo`, using `MemAvailable` rather than
  `MemFree` so a healthy host with a full page cache doesn't read as
  low-memory.

A Deno sandboxing quirk — not an OS permission issue — means procfs reads,
`/sys` directory enumeration, and reads of symlinked `/sys` attribute files
all go through `cat`/`find` subprocesses instead of `Deno.readTextFile`;
`df` and already-known `/sys` file paths are the only direct reads. See the
comments on `catFile`/`listThermalZoneDirs` in the source for the full
explanation.

## Workflow

The workflow is listed under `workflows:` in `manifest.yaml`, so
`swamp extension pull @aaronge/host-health` installs it alongside the model.
It expects a model instance named `host-local`.

The extension ships an `@aaronge/host-health` workflow: a `collect` job runs all four
methods in parallel, an `assert` job checks each resource against a
threshold (`allowFailure: false` — a failed run is the signal), and a
`report` job prints a one-screen summary regardless of whether the assert
job passed. It's scheduled every 5 minutes via `trigger.schedule`.

## License

MIT — see LICENSE for details.
