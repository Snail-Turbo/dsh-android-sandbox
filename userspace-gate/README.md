# dsh-userspace-gate

English | [中文](README.zh.md)

Workspace-write guard: a **pure user-space equivalent of the `workspace-write` sandbox at the tool-call layer**. A `tools/pre-execute` listener resolves the calling session's sandbox policy and — when the resolved mode is `workspace-write` — denies `write`/`edit` calls and shell calls whose **static** write targets canonicalize outside the session workspace and the platform temporary roots.

It needs no kernel feature: no bwrap, Landlock, Seatbelt, or Windows ACL runner. It works in any composition, including ones that mount the plain local filesystem, and on hosts where the kernel runners are unavailable or only partially enforcing. It is the guard-family answer to "the sandbox does not protect this device".

## Standalone — enable and it works

This is a **completely independent plugin**: it changes nothing in the product bundles, needs no rebuild, and is not wired into any shipped composition. Adding it to a composition's plugin list is the whole install:

```yaml
- id: userspace-gate
  name: 'dsh-userspace-gate'
```

The plugin takes effect **immediately on load** — the next tool call in a session whose resolved sandbox mode is `workspace-write` is gated. Requirements: the deployment already mounts `@deepseek-ai/dsh-sandbox-policy` (every shipped composition does; the guard declares it in `inject` and fails loudly at load if it is missing rather than silently unguarding). Verify it is live by attempting a write outside the workspace: the denial carries the `[userspace-gate: …]` marker below, and every decision is logged through `ctx.logger('userspace-gate')`.

## Plugin (namespace: `userspace-gate`)

A function/namespace plugin (`name` / `inject` / `Config` / `apply`), no default export, no service. It registers no tool; it consumes the `ctx.sandboxPolicy` service (declared in `inject`) and the `tools/pre-execute` waterfall of the `dsh-tools` registry.

```yaml
- id: userspace-gate
  name: 'dsh-userspace-gate'
```

### Config

| Key | Default | Meaning |
| --- | --- | --- |
| `fsTools` | `['write', 'edit']` | Tool names whose `file_path` argument is fenced |
| `shellTools` | `['bash']` | Tool names whose `command` argument is scanned for write intents |

### Behavior

For every tool call the listener:

1. Resolves the per-call policy with `ctx.sandboxPolicy.resolve({ session: exec.agent.session })`.
2. **Follows the session mode.** `workspace-write` is this gate's main business. Under `read-only` the filesystem fence owns denial where it is mounted — but in **fence-less compositions** this guard restores the read-only rule for the fs tools (`write`/`edit`; shell tools are covered by `dsh-userspace-bash`'s readonly-gate). `danger-full-access` passes through. A call carrying the tool layer's escalation argument (`sandbox_permissions`) is also passed through — the approval flow for a wider retry belongs to the tool layer, exactly as with the shipped fence.
3. Extracts the call's write targets: the `file_path` argument of fs tools, and the **static** write intents of the shell command (redirection targets, mutation-command operands, known option values). The bash tool's `workdir` argument participates: relative targets resolve against the workdir (absolute-ized against the workspace root), so `workdir: /etc` + `touch x` is denied, not read as contained.
4. Denies when any target canonicalizes outside the writable roots — the same set the filesystem fence and the Seatbelt profile use, derived from the one `writableRoots` function so the dialects cannot drift. Shell calls additionally grant the stream sinks the bash runners always grant (raw spelling or canonical alias): `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/stdin`, `/dev/fd/0|1|2`; the filesystem fence does not.

A denial is a `tools/pre-execute` `deny` whose model-facing reason carries the stable marker:

```text
[userspace-gate: file access denied under workspace-write mode] target "<path>" lies outside the session workspace and platform temporary directories. Retry with the `sandbox_permissions` argument and a justification only when the write is genuinely required; the retry asks for approval.
```

The marker is deliberately scoped to this package (`[userspace-gate: …]`) instead of the official `[sandbox: …]` vocabulary (`sandboxDenialMarker`): this gate denies at the **tool layer**, not the kernel, and a distinct marker keeps a policy denial here from being mistaken for a kernel-sandbox denial from `dsh-bash-sandbox`/`dsh-fs-sandbox`.

The bash scan is deliberately conservative: a word containing any expansion (`$`, backticks, `~`, globs, braces, command substitution, escapes) is never a candidate, relative targets are only emitted while the working directory is statically known (a preceding `cd`), and read-only references (chmod's `--reference`, `cp`'s sources) are never emitted. Denials and pass-throughs are logged through `ctx.logger('userspace-gate')`.

### Relationship to the shipped sandbox

The filesystem fence (`@deepseek-ai/dsh-fs-sandbox`) and the bash runners (`@deepseek-ai/dsh-bash-sandbox`) already confine `workspace-write` executions where they are mounted and usable — this guard does not replace them, and the kernel runner remains the **authoritative** boundary for untrusted code. This guard is the defense-in-depth and fallback layer: it works where the runners cannot, and it surfaces a uniform, model-visible denial for every tool family it covers. Mounting it changes nothing when the fence already denies; mounting it in a fence-less composition restores the containment.

## Model Experience

### Conditional tool result

#### What the model sees

This plugin adds no prompt and no schema. On a denied call the model receives an error result whose text starts with the `[userspace-gate: …]` marker above; every other call passes through unchanged.

#### Token effect

Zero tokens on contained or out-of-scope calls. A denial adds one small error result and prevents the tool body from running at all (no large output can enter context).

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Bash scanning is best-effort, not a security boundary** — targets that cannot be statically determined (variables, command substitution, `xargs`, nested non-shell interpreters, `eval`, `source`d script bodies, globbed operands, `\cp`-style escaped command names) pass through to the kernel runner; where no runner exists they are ungoverned. The kernel-level `ctx.sandbox` backend is the authoritative boundary for untrusted code.
- **Command coverage is a fixed allow-list** — only the commands in `MUTATION_COMMANDS` (touch, mkdir, rm, mv, cp, ln, install, tee, truncate, chmod, chown, dd, curl, wget, tar, unzip, …) contribute operands; an uncovered write-intent command (rsync, scp, git, …) is invisible to the scan.
- **`mv` sources outside the workspace are not gated** — moving a file from outside into the workspace unlinks it outside; only the destination is checked (the kernel runner denies the unlink when present).
- **A dynamic destination is not gated** — `cp a b $dyn`'s real target is unknown and the scanner stays silent (it never mistakes the last static source for the destination); such calls pass through.
- **The gate is user-space policy, not kernel enforcement** — it runs in the trusted harness process over model-controlled arguments; a compromised harness process is out of scope, as with the filesystem fence.
