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

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { isPathUnder } from './containment.ts'

/** Shell stream sinks the bash runners always grant; the guard mirrors that grant for shell tools. */
const SHELL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin'])

/** The standard fd-number sinks (`/dev/fd/0|1|2`); higher fds may alias real files. */
const DEV_FD_SINKS = /^\/dev\/fd\/[0-2]$/

/**
 * Whether an absolute target is a granted shell sink. Matches the raw spelling
 * AND the canonical one, so alias spellings (`/dev//null`, a symlinked
 * `/dev/stdout`) cannot be mistaken for file writes.
 */
function isShellSink(absolute: string, canonical: string): boolean {
  if (SHELL_SINKS.has(absolute)) return true
  if (DEV_FD_SINKS.test(absolute)) return true
  return SHELL_SINKS.has(canonical)
}

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
export async function firstUncontainedTarget(
  targets: readonly string[],
  policy: SandboxExecutionPolicy,
  allowSinks = false,
): Promise<string | undefined> {
  if (policy.mode !== 'workspace-write') return undefined
  const roots = writableRoots(policy)
  for (const target of targets) {
    const absolute = isAbsolute(target) ? target : resolvePath(policy.workspaceRoot, target)
    const canonical = canonicalPath(absolute)
    if (allowSinks && isShellSink(absolute, canonical)) continue
    let contained = false
    for (const root of roots) {
      if (await isPathUnder(canonical, root)) {
        contained = true
        break
      }
    }
    if (!contained) return target
  }
  return undefined
}
