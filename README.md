# dsh user-space sandbox plugins for kernel-less hosts

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) normally keeps writes inside the workspace with **kernel-backed sandboxes** — Landlock / bwrap, the filesystem fence, Seatbelt, Windows ACL runners. If your device has a working kernel sandbox, **you don't need this repo**; the shipped sandbox already covers you.

This repo is for hosts where those runners **can't run or only partially enforce** — most commonly Android GKI phones with a locked bootloader (or one you don't want to unlock), and restricted containers / chroot environments without user namespaces or Landlock. On those hosts the **bash** kernel runner fails closed: every confined bash call is denied. (The write/edit filesystem fence is an in-process path boundary and keeps working; the real gap is shell execution.) These plugins put a *user-space* equivalent back at the tool-call layer for both.

## Two options for a real sandbox on Android

If you're on an Android device with no usable kernel sandbox, you have two options.

### Option A — unlock the bootloader and build a GKI kernel with the right config (recommended)

If you *can* unlock the bootloader, the real fix is to enable the features the dsh runners need in the kernel config (Landlock LSM, user namespaces, …) and **compile your own Google GKI kernel** with them on. With that kernel, `dsh-bash-sandbox` and `dsh-fs-sandbox` confine normally — that's the kernel-level boundary, the one you actually want.

**Use this path whenever you can.** The plugins in this repo are user-space policy — a fallback, not a security boundary.

### Option B — can't or won't unlock: use these user-space plugins

If you can't or won't unlock the bootloader, load the two plugins in this repo. Together they restore the workspace-write / read-only containment of the shipped sandbox at the tool-call layer, with zero kernel requirements.

| Package | Role |
| --- | --- |
| `dsh-userspace-gate` | A `tools/pre-execute` gate — the pure user-space equivalent of the `workspace-write` sandbox: denies `write`/`edit` calls and bash calls whose **statically visible** write targets fall outside the session workspace and platform temp roots; also enforces read-only for shell tools. No kernel feature needed. |
| `dsh-userspace-bash` | A `bash-local` twin for hosts without a usable kernel runner: reports a sandbox mode (so permission presets and the `sandbox_permissions` escalation surface keep working) but never actually confines — file-write enforcement is delegated to the userspace-gate gates. |

> **On the advertised sandbox mode.** `userspace-bash` reports a sandbox mode without kernel confinement. This is a deliberate deviation from the official capability-fact semantics: on a kernel-less host the official alternatives both break — a kernel runner fails closed on every confined call, and an honestly-unconfined executor (`sandboxMode === undefined`) makes `dsh-permission-presets` fail loud at load. Reporting a mode keeps `/permission`, the preset selector, and the `sandbox_permissions` escalation surface working, while the actual containment is enforced by the `userspace-gate` gate at the tool layer (static scan, not kernel).

## Limitations

- **It only blocks what it can see statically — this is not a security boundary.** Write targets that are statically determinable get gated (redirection targets, mutation-command operands, known option values, heredoc bodies handed to a shell); dynamic targets — variables, command substitution, `xargs`, nested non-shell interpreters, `eval`, `source`d script files, globbed operands (`rm -rf /etc/*`), `\cp`-style escaped command names — pass through.
- **The advertised sandbox mode is a deviation** — see the note above; `permission-presets` treats the executor as confining, and an approved `sandbox_permissions` escalation runs the command with the harness's full authority (the executor never confines; the gates only statically gate).
- The kernel runner remains the boundary that actually counts for untrusted code. If you can get one (Option A), use it.

## Platform support

The `userspace-bash` executor row is auto-disabled on win32 (`!!js process.platform === 'win32'` in its bundle patch): the dsh-base composition mounts `pwsh-sandbox` there, and two providers of `ctx.shell` would fail boot with a duplicate registration. This repo targets POSIX hosts (Android, Linux, macOS).

## Repository layout

```
android-sand-box/
├── userspace-gate/               # the tools/pre-execute gate + bash write-intent scanner
└── userspace-bash/               # the never-confining bash executor + readonly gate + denial guidance
```

Both packages are **profile bundles**: each ships its own `cordis.patch.yml` under the `dsh.bundle` manifest, so installing one activates its plugin rows automatically — no manual `cordis.patch.yml` editing. Install both into a profile:

```sh
dsh plugin --profile web add ./userspace-bash
dsh plugin --profile web add ./userspace-gate
```

The `dsh-userspace-bash` bundle swaps the kernel-backed `bash-sandbox` for the user-space executor and mounts the read-only gate plus the denial guidance; the `dsh-userspace-gate` bundle mounts the workspace-write gate. Remove either with `dsh plugin --profile web remove <name>`. Both packages ship their built `lib/` in-tree, so a git install works without a build step.

## License

MIT
