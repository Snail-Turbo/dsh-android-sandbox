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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { scanBashTargets, type BashWriteTarget } from './bash-scan.ts'
import { firstUncontainedTarget } from './gate.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'userspace-gate'

/** The sandbox-policy service this guard resolves every call against; without it the guard cannot decide and must not load silently. */
export const inject = ['sandboxPolicy']

/** The stable model-facing denial marker; the tool layer's fs marker is `[sandbox: …]`, this guard's is scoped to its own name. */
export const DENY_MARKER = '[userspace-gate: file access denied under workspace-write mode]'

/** The read-only denial marker, mirroring the readonly-gate's wording for fs tools. */
export const READONLY_DENY_MARKER = '[userspace-gate: file access denied under read-only mode]'

/**
 * Plugin config. The defaults are the shipped tool families; a deployment
 * with renamed or additional fs/shell tools extends the lists.
 */
export interface Config {
  /** Tool names whose `file_path` argument is fenced (default `['write', 'edit']`). */
  fsTools?: string[]
  /** Tool names whose `command` argument is scanned for write intents (default `['bash']`). */
  shellTools?: string[]
}

export const Config: z<Config> = z.object({
  fsTools: z.array(z.string()).default(['write', 'edit']),
  shellTools: z.array(z.string()).default(['bash']),
})

/** Whether the call carries the tool layer's escalation argument (approval flow stays in the tool layer). */
function carriesEscalation(exec: ToolExecution): boolean {
  if (exec.arguments === null || typeof exec.arguments !== 'object') return false
  return typeof (exec.arguments as Record<string, unknown>).sandbox_permissions === 'string'
}

/** The static write targets a gated tool call would touch. */
function extractTargets(exec: ToolExecution, config: Config, policy: SandboxExecutionPolicy): BashWriteTarget[] {
  const args = exec.arguments as Record<string, unknown> | null | undefined
  if (args === null || typeof args !== 'object') return []
  if (config.fsTools?.includes(exec.name)) {
    const filePath = args.file_path
    return typeof filePath === 'string' && filePath.length > 0 ? [{ path: filePath, kind: 'operand' as const }] : []
  }
  if (config.shellTools?.includes(exec.name)) {
    const command = args.command
    if (typeof command !== 'string' || command.length === 0) return []
    // The bash tool's `workdir` argument moves the command's starting
    // directory: relative targets must resolve against it, not the workspace
    // root, or `workdir: /etc` + `touch x` would read as contained.
    const workdir = args.workdir
    const initialCwd = typeof workdir === 'string' && workdir.length > 0
      ? (isAbsolute(workdir) ? workdir : resolvePath(policy.workspaceRoot, workdir))
      : ''
    return scanBashTargets(command, initialCwd)
  }
  return []
}

/** The model-facing denial reason: stable marker, the violating target, and the escalation path. */
function denyReason(target: string): string {
  return `${DENY_MARKER} target "${target}" lies outside the session workspace and platform temporary directories. `
    + 'Retry with the `sandbox_permissions` argument and a justification only when the write is genuinely required; '
    + 'the retry asks for approval.'
}

/** The read-only denial reason for fs tools in fence-less compositions. */
function readonlyDenyReason(target: string): string {
  return `${READONLY_DENY_MARKER} target "${target}" lies outside the writable set: read-only mode permits no file writes. `
    + 'Retry with the `sandbox_permissions` argument and a justification only when the write is genuinely required; '
    + 'the retry asks for approval.'
}

/**
 * Register the pre-execute gate.
 * @param ctx - Cordis context carrying `ctx.sandboxPolicy` (declared by `inject`).
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('userspace-gate')
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
    if (carriesEscalation(exec)) return next()
    if (policy.mode === 'read-only') {
      // The filesystem fence owns read-only where it is mounted; in
      // fence-less compositions this guard restores the read-only rule for
      // the fs tools too (shell tools are covered by the readonly-gate).
      const args = exec.arguments as Record<string, unknown> | null | undefined
      const filePath = args !== null && typeof args === 'object' ? args.file_path : undefined
      if (config.fsTools?.includes(exec.name) && typeof filePath === 'string' && filePath.length > 0) {
        logger.warn(`denied ${exec.name} call targeting "${filePath}" (session sandbox mode: read-only)`)
        return { kind: 'deny', reason: readonlyDenyReason(filePath) }
      }
      return next()
    }
    if (policy.mode !== 'workspace-write') return next()
    const targets = extractTargets(exec, config, policy)
    if (targets.length === 0) return next()
    const violation = await firstUncontainedTarget(
      targets.map(target => target.path),
      policy,
      config.shellTools?.includes(exec.name) ?? false,
    )
    if (violation === undefined) return next()
    logger.warn(`denied ${exec.name} call targeting "${violation}" (session sandbox mode: workspace-write)`)
    return { kind: 'deny', reason: denyReason(violation) }
  })
}
