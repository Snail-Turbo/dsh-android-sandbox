/**
 * OS-denial guidance: turns OS-level permission failures (EACCES / EPERM /
 * EROFS — NOT sandbox denials) into a clearly-marked, user-decision-driven
 * protocol. Two mechanisms:
 *
 *   1. A `tools/post-execute` listener detects shell/fs results whose text
 *      carries an OS-level denial signature WITHOUT a sandbox marker
 *      (`[sandbox:` / `[userspace-gate:`), and appends the stable
 *      `[os-denial: …]` marker so the model classifies the failure
 *      unambiguously.
 *   2. A system-prompt section instructs the model: when it sees the
 *      `[os-denial:` marker, it must lay out — what the command does, what it
 *      wants to achieve, why it is needed, its significance, consequences,
 *      rollback, and the exact commands (plain + sudo variants) — and then
 *      WAIT for the user to decide about sudo; the model never attempts sudo
 *      itself (this host's sudo requires an interactive password).
 *
 * @module dsh-userspace-bash/os-denial-guidance
 */

/** OS-level denial signatures (bash EACCES/EPERM/EROFS spellings). */
const DENIAL_SIGNATURES = [
  /permission denied/i,
  /operation not permitted/i,
  /read-only file system/i,
]

/** Sandbox markers that must NOT be reclassified as OS denials. */
const SANDBOX_MARKERS = /\[sandbox:|\[userspace-gate:/

/** The stable model-visible marker appended to a detected OS-level denial. */
export const OS_DENIAL_MARKER = '[os-denial: OS-level permission/filesystem denial (EACCES/EPERM/EROFS), not a sandbox block — follow the os-denial protocol before proposing sudo or any privilege change]'

/** Whether a flattened result text indicates an OS-level denial (not sandbox). */
export function isOsLevelDenial(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (SANDBOX_MARKERS.test(text)) return false
  return DENIAL_SIGNATURES.some(signature => signature.test(text))
}

/** Flatten a result's text blocks (guards non-text blocks). */
function resultText(result) {
  if (result === null || typeof result !== 'object') return ''
  const blocks = Array.isArray(result.content) ? result.content : []
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text + '\n'
    }
  }
  return out
}

export const name = 'os-denial-guidance'
export const inject = ['systemPrompt']

export function apply(ctx, config) {
  const shellTools = config && Array.isArray(config.shellTools) ? config.shellTools : ['bash']
  const fsTools = config && Array.isArray(config.fsTools) ? config.fsTools : ['write', 'edit']

  ctx.systemPrompt.section({
    name: 'tool:os-denial-guidance',
    order: 106,
    text: 'When a tool result carries the `[os-denial:` marker (an OS-level permission/filesystem denial — ' +
      'EACCES/EPERM/EROFS — NOT a sandbox block), before proposing any sudo or privilege change, present to the user: ' +
      '(1) what the attempted command was doing and what it was about to write/modify; ' +
      '(2) the goal the operation serves; ' +
      '(3) why that path or operation requires elevated rights; ' +
      '(4) the significance of the operation; ' +
      '(5) the consequences of running it (and of not running it); ' +
      '(6) how to undo/roll back the change; ' +
      '(7) the exact commands to run — the plain command and the sudo variant, as two separate copy-pasteable lines. ' +
      'Then ask the user to decide whether to run it with sudo. Do NOT attempt sudo yourself (this host requires an ' +
      'interactive password the model does not have); do not retry the command or find another privilege path until ' +
      'the user decides.',
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (shellTools.indexOf(exec.name) === -1 && fsTools.indexOf(exec.name) === -1) return next()
    // Only FAILED results can be OS denials: a successful `echo "permission
    // denied"` is benign output and must not be re-marked `[os-denial: …]`.
    if (result === null || typeof result !== 'object' || result.isError !== true) return next()
    const text = resultText(result)
    if (!isOsLevelDenial(text)) return next()
    const blocks = Array.isArray(result.content) ? result.content : []
    return {
      kind: 'accept',
      content: [...blocks, { type: 'text', text: '\n' + OS_DENIAL_MARKER }],
    }
  })
}
