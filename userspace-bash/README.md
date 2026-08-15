# dsh-userspace-bash

English | [中文](README.zh.md)

User-space bash executor for hosts with **no usable kernel runner**. A `bash-local` twin that **advertises a sandbox mode but never confines**: `run`/`start` are inherited verbatim from `LocalBashExecutor`, so commands always run with the harness process's authority. File-effect enforcement is delegated to the userspace-gate gates at `tools/pre-execute`.

## Why it advertises a sandbox mode (documented deviation)

Officially, `executor.sandboxMode` is a capability fact — "the default mode a SANDBOXING executor confines under", with `undefined` meaning "this executor does not sandbox". A never-confining executor that reports a mode is not an official shape: upstream only has honestly-unconfined (`undefined`) and genuinely-confining (kernel runner) executors.

This package deliberately reports the policy default anyway, because on a host without a usable kernel runner both official shapes break:

- A kernel runner (`dsh-bash-sandbox`) fails closed on every confined call — nothing runs.
- An honestly-unconfined executor (`sandboxMode === undefined`) makes `dsh-permission-presets` fail loud at load ("the mounted bash executor does not confine"), taking down `/permission`, the settings preset selector, and the escalation prompts.

Reporting a mode keeps those surfaces working while the real containment moves to the tool layer: the `userspace-gate` gates deny static write intents outside the writable roots (`workspace-write`) and any write intent (`read-only`) at `tools/pre-execute`. Escalation (`sandbox_permissions`) is honored by the guard's pass-through — the approval flow stays in the tool layer.

This is a **documented, deliberate deviation from the official capability-fact semantics**, not a silent shortcut. The `sandbox:policy` context contribution still tells the model the truthful per-session mode.

## Plugin

A class executor (extends `LocalBashExecutor`) plus two function plugins, shipped as a profile bundle (install via the root README).

| Entry | Plugin | Role |
| --- | --- | --- |
| `dsh-userspace-bash` | `UserSpaceBashExecutor` (class, provides `ctx.shell`) | The never-confining executor reporting the sandbox-policy default as `sandboxMode` |
| `dsh-userspace-bash/readonly-gate` | `readonly-gate` | `tools/pre-execute` deny of any static bash write intent under `read-only` (only the shell stream sinks are granted: `/dev/null`, `/dev/stdout|stderr|stdin`, `/dev/fd/0|1|2`) |
| `dsh-userspace-bash/os-denial-guidance` | `os-denial-guidance` | `tools/post-execute` marker + system-prompt protocol for OS-level permission failures (not sandbox denials) |

### Executor config

Same schema as `LocalBashExecutor` (`cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`), defaults applied by Schemastery.

## Model Experience

### What the model sees

This package adds no prompt and no schema of its own. Denials come from the `userspace-gate` gates with the `[userspace-gate: …]` marker; OS-level permission failures are re-marked `[os-denial: …]` with the sudo-decision protocol — only FAILED results are re-marked, so a successful `echo "permission denied"` is left untouched. Unconfined calls pass through unchanged.

### Token effect

Zero tokens on contained or out-of-scope calls. A denied call adds one small error result and prevents the tool body from running.

### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Best-effort, not a security boundary** — the guard gates cover only statically determinable write targets; dynamic targets (variables, command substitution, `xargs`, nested non-shell interpreters, `eval`, `source`d script bodies, globbed operands, escaped command names) pass through ungoverned. A kernel runner remains the authoritative boundary; on hosts where one is available, prefer it (root README, Option A).
- **Advertised mode is a deviation** — `permission-presets` treats this executor as confining and derives presets from the reported mode, while actual enforcement is tool-layer advisory. Users of this package must understand the escalation surface is backed by the userspace-gate gates, not the kernel.
- **`sandbox_permissions` escalation grants pass-through** — the guard honors the tool-layer escalation argument; the approval flow belongs to the tool layer exactly as with the shipped fence.
- **No kernel confinement of command execution** — the executor never confines; anything that bypasses `bash` through direct `ctx.subprocess` or other shells is outside this package's scope.
