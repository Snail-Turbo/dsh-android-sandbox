/**
 * The workspace guard's containment gate: given the static targets a tool call
 * would write, decide whether the call may proceed under the session's
 * resolved sandbox policy. Mirrors the `workspace-write` semantics of the
 * filesystem fence (`@deepseek-ai/dsh-fs-sandbox`) and the bash runner's
 * Seatbelt profile: a target is writable only when it canonicalizes under the
 * policy's workspace root or a platform temp area — the SAME writable-root
 * set, derived from the one `writableRoots` function so the guard cannot
 * drift from the other enforcement dialects.
 * @module dsh-userspace-gate/gate
 */
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
/**
 * The first target that canonicalizes OUTSIDE every writable root, or
 * `undefined` when every target is contained. Non-`workspace-write` policies
 * are never this gate's business and return `undefined` immediately — the
 * filesystem fence owns `read-only`, and `danger-full-access` passes through.
 * @param targets - the static write targets extracted from the tool call.
 * @param policy - the session's resolved sandbox policy.
 * @param allowSinks - whether the shell stream sinks (`/dev/null`,
 *   `/dev/stdout|stderr|stdin`, `/dev/fd/0|1|2`) are granted (the bash runners
 *   grant them; the filesystem fence does not).
 * @returns the first violating target, or `undefined` when all are contained.
 */
export declare function firstUncontainedTarget(targets: readonly string[], policy: SandboxExecutionPolicy, allowSinks?: boolean): Promise<string | undefined>;
//# sourceMappingURL=gate.d.ts.map