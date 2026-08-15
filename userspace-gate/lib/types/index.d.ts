/**
 * Workspace-write guard: a pure-user-space equivalent of the
 * `workspace-write` sandbox at the tool-call layer. A `tools/pre-execute`
 * listener resolves the calling session's sandbox policy and, when the
 * resolved mode is `workspace-write`, denies `write`/`edit` calls and bash
 * calls whose STATIC write targets canonicalize outside the session workspace
 * and platform temp roots.
 *
 * Relationship to the shipped sandbox: the filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) and the bash runners (`@deepseek-ai/dsh-bash-sandbox`)
 * already confine `workspace-write` executions where they are mounted and
 * usable. This guard is the defense-in-depth and fallback layer: it needs no
 * kernel feature, works in compositions that mount the plain local filesystem,
 * and covers bash write intents the scanner can determine statically. It
 * follows the session mode — under `read-only` the fence owns denial, under
 * `danger-full-access` the guard passes through — and it never blocks a call
 * carrying an escalation (`sandbox_permissions`), whose approval flow belongs
 * to the tool layer. Denials carry the stable `[userspace-gate: …]` marker.
 *
 * The bash scanner is best-effort by design: targets it cannot statically
 * resolve are left to the kernel runner, which is the authoritative boundary
 * for untrusted code. See the package README for the exact scope.
 *
 * @module dsh-userspace-gate
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "userspace-gate";
/** The sandbox-policy service this guard resolves every call against; without it the guard cannot decide and must not load silently. */
export declare const inject: string[];
/** The stable model-facing denial marker; the tool layer's fs marker is `[sandbox: …]`, this guard's is scoped to its own name. */
export declare const DENY_MARKER = "[userspace-gate: file access denied under workspace-write mode]";
/** The read-only denial marker, mirroring the readonly-gate's wording for fs tools. */
export declare const READONLY_DENY_MARKER = "[userspace-gate: file access denied under read-only mode]";
/**
 * Plugin config. The defaults are the shipped tool families; a deployment
 * with renamed or additional fs/shell tools extends the lists.
 */
export interface Config {
    /** Tool names whose `file_path` argument is fenced (default `['write', 'edit']`). */
    fsTools?: string[];
    /** Tool names whose `command` argument is scanned for write intents (default `['bash']`). */
    shellTools?: string[];
}
export declare const Config: z<Config>;
/**
 * Register the pre-execute gate.
 * @param ctx - Cordis context carrying `ctx.sandboxPolicy` (declared by `inject`).
 * @param config - validated plugin config.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map