/**
 * User-space bash executor: a `bash-local` twin that ADVERTISES a sandbox mode
 * but never confines. On hosts with no usable kernel runner (bwrap userns
 * blocked, no Landlock — e.g. Android GKI), the kernel-backed
 * `dsh-bash-sandbox` fails closed on every confined call. This executor keeps
 * bash usable under every mode while the file-effect boundary moves to the
 * tool layer:
 *   - workspace-write: the `userspace-gate` pre-execute gate (static write
 *     intents outside the writable roots);
 *   - read-only: the `userspace-gate` read-only gate (any static write
 *     intent; only /dev/null is granted);
 *   - danger-full-access: pass-through.
 *
 * The advertised `sandboxMode` is what `permission-presets` requires to load
 * (it fails loud over an executor without one) and what `tool-bash` uses to
 * advertise the `sandbox_permissions` escalation surface — so the original
 * /permission command, the settings preset selector, and escalation prompts
 * all keep working on top of a never-confining executor.
 *
 * Enforcement is therefore ADVISORY (static scan only), never kernel-level;
 * dynamic write targets are ungoverned.
 *
 * @module dsh-userspace-bash
 */

import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'

/**
 * The plain local executor that reports a sandbox mode. `run`/`start` are
 * inherited verbatim from `LocalBashExecutor` — they never confine.
 */
export class UserSpaceBashExecutor extends LocalBashExecutor {
  static inject = ['subprocess', 'sandboxPolicy']

  constructor(ctx, config) {
    super(ctx, config)
    /** The deployment default mode — the capability fact permission-presets and tool-bash read. */
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** The advertised mode: the sandbox-policy default (env DSH_PERMISSION_MODE). */
  get sandboxMode() {
    return this.mode
  }
}

export default UserSpaceBashExecutor
