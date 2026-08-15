/**
 * Pure user-space scanner for STATIC file-write intents inside a shell command
 * string. It is the `userspace-gate` plugin's approximation of the bash
 * runner's kernel confinement: it extracts the literal (fully static) paths a
 * command writes, mutates, or deletes — redirection targets, mutation-command
 * operands, and known option values — so a containment gate can deny targets
 * outside the writable roots without any kernel feature.
 *
 * The scanner is deliberately CONSERVATIVE about what it calls static: any
 * word containing an expansion (`$`, backticks, `~`, globs, braces, command
 * substitution, escapes) is not a candidate, and relative targets are only
 * emitted when the command's working directory is statically known (a
 * preceding `cd`). Dynamic targets are the kernel runner's job; this scanner
 * never guesses. The documented gap is exactly "a write whose target cannot
 * be statically determined", which the kernel-level `ctx.sandbox` backend
 * still governs when the session runs under `workspace-write`.
 *
 * @module dsh-userspace-gate/bash-scan
 */
/** How a candidate target was spelled in the command. */
export type BashTargetKind = 'redirect' | 'operand' | 'option-value';
/** One statically determined file the command writes, mutates, or deletes. */
export interface BashWriteTarget {
    /** The literal path exactly as written (relative or absolute). */
    path: string;
    /** How the target was spelled. */
    kind: BashTargetKind;
}
/**
 * Scan one shell command for static write targets.
 * @param command - the shell command text (the `bash` tool's `command` argument).
 * @param initialCwd - the statically known starting working directory
 *   (absolute when the tool call carries a `workdir` argument, `''` when the
 *   command starts in the session workspace, `undefined` when unknown); the
 *   gate resolves relative spellings against the same base.
 * @returns the deduplicated static targets, in first-appearance order.
 */
export declare function scanBashTargets(command: string, initialCwd?: string): BashWriteTarget[];
