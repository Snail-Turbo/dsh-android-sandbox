/**
 * Read-only gate: the user-space read-only counterpart of the workspace guard.
 * Under a session resolved to `read-only`, this `tools/pre-execute` listener
 * denies every bash call whose STATIC write-intent set is non-empty (any
 * target — nothing is writable under read-only except the shell stream sinks
 * the kernel runners also grant: `/dev/null`, `/dev/stdout|stderr|stdin`,
 * `/dev/fd/0|1|2`). The filesystem fence already denies write/edit under
 * read-only, so this gate covers only shell tools; dynamic write targets the
 * scanner cannot resolve pass through ungoverned (best-effort, exactly like
 * the workspace-write guard).
 *
 * The scanner is the JS mirror of `dsh-userspace-gate`'s `bash-scan.ts` and
 * MUST be kept in lockstep with it (the userspace-gate package owns the
 * canonical implementation; this copy is pinned by `readonly-gate.spec.ts`).
 *
 * @module dsh-userspace-bash/readonly-gate
 */

const DENY_MARKER = '[userspace-gate: file access denied under read-only mode]'

/** Shell stream sinks the kernel runners always grant under read-only. */
const SHELL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin'])
const DEV_FD_SINKS = /^\/dev\/fd\/[0-2]$/

/** Lexically collapse `//` runs (`/dev//null` → `/dev/null`); no symlink resolution here. */
function normalizeSink(path) {
  return path.replace(/\/{2,}/g, '/')
}

function isShellSink(path) {
  const normalized = normalizeSink(path)
  return SHELL_SINKS.has(normalized) || DEV_FD_SINKS.test(normalized)
}

// Exported for the pinning spec (`tests/readonly-gate.spec.ts`) that keeps this
// copy in lockstep with `dsh-userspace-gate`'s `bash-scan.ts`.
export { scanBashTargets, isShellSink }

// ── conservative static write-intent scanner (mirrors userspace-gate) ──────

const DYNAMIC = /[\$`~*?\[\]{}()\\]/
const REDIRECT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&', '<&', '<', '<<', '<<-', '<<<'])
const HEREDOC_OPS = new Set(['<<', '<<-'])
const WRAPPERS = {
  sudo: ['-u', '-g', '--user', '--group'],
  doas: ['-u'],
  env: [],
  command: [],
  nohup: [],
  nice: ['-n'],
  // `time -p` takes a BOOLEAN `-p`, not a value.
  time: [],
  taskset: ['-c', '-p'],
  ionice: ['-c', '-n', '-p'],
  stdbuf: ['-i', '-o', '-e'],
  // `exec sh -c '...'` runs the trailing command in place of the shell.
  exec: [],
}
const MUTATION_COMMANDS = {
  touch: { operands: 'all', options: [], skipValues: ['-t', '-d', '-r', '--reference', '--time'] },
  mkdir: { operands: 'all', options: [] },
  rmdir: { operands: 'all', options: [] },
  rm: { operands: 'all', options: [] },
  unlink: { operands: 'all', options: [] },
  truncate: { operands: 'all', options: [], skipValues: ['-s', '--size', '-r', '--reference'] },
  chmod: { operands: 'all-skip-first', options: [], skipValues: ['--reference'] },
  chown: { operands: 'all-skip-first', options: [], skipValues: ['--reference'] },
  tee: { operands: 'all', options: [] },
  mv: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
  cp: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
  ln: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
  install: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
  // `dd`: only `of=` names the write target; `if=`/`bs=`/… are reads/metadata.
  dd: { operands: 'all', options: [] },
  curl: { operands: 'none', options: ['-o', '--output'] },
  wget: { operands: 'none', options: ['-O', '--output-document'] },
  tar: { operands: 'none', options: ['-C', '--directory', '-f', '--file'] },
  unzip: { operands: 'none', options: ['-d'] },
}
const NESTED_SHELLS = {
  bash: ['-c'],
  sh: ['-c'],
  dash: ['-c'],
  ksh: ['-c'],
  zsh: ['-c'],
  fish: ['-c'],
}

function isAbsoluteSpelling(path) {
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

function tokenize(command) {
  const tokens = []
  let word = ''
  let quoted = false
  let quote
  const flushWord = () => {
    if (word.length > 0 || quoted) {
      tokens.push({ text: word, op: false, quoted })
      word = ''
      quoted = false
    }
  }
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (char === undefined) break
    // An unquoted `#` at a word boundary starts a comment.
    if (char === '#' && quote === undefined && word.length === 0) break
    if (char === '\\' && quote !== "'") { word += char; continue }
    if (quote === "'" || quote === '"') {
      if (char === quote) { quote = undefined; quoted = true } else { word += char }
      continue
    }
    if (char === "'" || char === '"') { quote = char; quoted = true; continue }
    if (/\s/.test(char)) { flushWord(); continue }
    const rest = command.slice(i)
    const two = rest.slice(0, 2)
    const three = rest.slice(0, 3)
    let op
    if (three === '<<<' || three === '<<-' || three === '&>>') op = three
    else if (two === '<<' || two === '>>' || two === '>&' || two === '<&' || two === '<>' || two === '>|' || two === '&>' || two === '||' || two === '&&' || two === ';;') op = two
    else if (char === '>' || char === '<' || char === '|' || char === '&' || char === ';' || char === '(' || char === ')') op = char
    if (op !== undefined) {
      flushWord()
      tokens.push({ text: op, op: true, quoted: false })
      i += op.length - 1
      continue
    }
    word += char
  }
  if (quote !== undefined) word += '"'
  flushWord()
  return tokens
}

function staticPath(word) {
  if (word.length === 0) return undefined
  if (DYNAMIC.test(word)) return undefined
  return word
}

/** A fd-number word (`2`, `1`), an fd move (`2>&1-`), or `-` used after `>&` / `<&`. */
function isFdReference(word) {
  return word === '-' || /^[0-9]+-?$/.test(word)
}

function unquoteForNested(raw) {
  if (raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    return raw.slice(1, -1)
  }
  return raw
}

/** Whether `word` looks like chmod's mode word or chown's owner spec (not a path). */
function isModeOrOwnerWord(word, command) {
  if (command === 'chmod') {
    return /^[0-7]{1,4}$/.test(word) || /^[ugoa]*[+-=][rwxXstugo]*$/.test(word)
  }
  return /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/.test(word) && !word.includes('/')
}

/** Parse a short-option cluster or an attached short-option value. */
function parseShortCluster(word, mutation, state) {
  const chars = word.slice(1)
  for (let ci = 0; ci < chars.length; ci += 1) {
    const flag = '-' + chars[ci]
    const takesValue = mutation.options.includes(flag)
    const skipsValue = mutation.skipValues !== undefined && mutation.skipValues.includes(flag)
    if (!takesValue && !skipsValue) continue
    let value = chars.slice(ci + 1)
    if (value.startsWith('=')) value = value.slice(1)
    if (value.length > 0) {
      if (flag === '-t' || flag === '--target-directory') state.targetDir = value
      else if (skipsValue) { /* read reference / metadata: never a target */ }
      else state.optionValues.push(value)
    } else {
      state.optionValue = flag
    }
    return true
  }
  return false
}

/** The static write targets of one shell command, in first-appearance order. */
function scanBashTargets(command, initialCwd) {
  if (initialCwd === undefined) initialCwd = ''
  const found = []
  const seen = new Set()
  const add = (path) => {
    if (path.length === 0 || seen.has(path)) return
    seen.add(path)
    found.push(path)
  }

  const tokens = tokenize(command)
  let i = 0
  let cwd = initialCwd
  let pendingWriteRedirect = false
  let pendingFdDup = false

  while (i < tokens.length) {
    const token = tokens[i]
    if (token === undefined) break
    if (!token.op) {
      if (pendingWriteRedirect) {
        const target = staticPath(token.text)
        if (target !== undefined) add(target)
        pendingWriteRedirect = false
      } else if (pendingFdDup) {
        if (!isFdReference(token.text)) {
          const target = staticPath(token.text)
          if (target !== undefined) add(target)
        }
        pendingFdDup = false
      }
      i += 1
      continue
    }
    const op = token.text
    if (op === '>' || op === '>>' || op === '>|' || op === '&>' || op === '&>>' || op === '<>') {
      pendingWriteRedirect = true
      pendingFdDup = false
      i += 1
      continue
    }
    if (op === '>&' || op === '<&') {
      pendingWriteRedirect = false
      pendingFdDup = true
      i += 1
      continue
    }
    if (op === '<' || op === '<<' || op === '<<-' || op === '<<<') {
      pendingWriteRedirect = false
      pendingFdDup = false
      i += 1
      continue
    }
    if (REDIRECT_OPS.has(op)) {
      pendingWriteRedirect = false
      pendingFdDup = false
      i += 1
      continue
    }
    pendingWriteRedirect = false
    pendingFdDup = false
    i += 1
  }

  let cursor = 0
  let commandStart = true
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token === undefined) break
    if (token.op) {
      if (REDIRECT_OPS.has(token.text)) {
        const next = tokens[cursor + 1]
        if (next !== undefined && !next.op) cursor += 1
        commandStart = false
      } else {
        commandStart = true
      }
      cursor += 1
      continue
    }
    if (!commandStart) { cursor += 1; continue }
    const word = staticPath(token.text)
    if (word === undefined) { commandStart = false; cursor += 1; continue }
    // Environment-assignment prefixes are not commands.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { cursor += 1; continue }

    let commandWord = word
    let j = cursor + 1
    for (;;) {
      const wrapper = WRAPPERS[commandWord]
      if (wrapper === undefined) break
      while (j < tokens.length) {
        const t = tokens[j]
        if (t === undefined || t.op) break
        const w = staticPath(t.text)
        if (w === undefined) break
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { j += 1; continue }
        const takesValue = wrapper.some(flag => w === flag)
        if (takesValue) { j += 2; continue }
        if (w.startsWith('-')) { j += 1; continue }
        break
      }
      const next = tokens[j]
      if (next === undefined || next.op) { commandWord = ''; break }
      commandWord = next.text
      j += 1
    }
    if (commandWord === '') { commandStart = false; cursor += 1; continue }

    if (commandWord === 'cd') {
      const target = tokens[j]
      if (target === undefined || target.op) {
        cwd = undefined
        cursor = j
        commandStart = true
        continue
      }
      const path = staticPath(target.text)
      if (path === undefined || path === '-') {
        cwd = undefined
        cursor = j + 1
        commandStart = true
        continue
      }
      cwd = isAbsoluteSpelling(path) ? path : cwd === '' ? path : cwd + '/' + path
      cursor = j + 1
      commandStart = false
      continue
    }

    const shellOptions = NESTED_SHELLS[commandWord]
    if (shellOptions !== undefined) {
      let k = j
      while (k < tokens.length) {
        const t = tokens[k]
        if (t === undefined) break
        if (!t.op) {
          const w = staticPath(t.text)
          if (w === undefined) break
          if (shellOptions.includes(w)) {
            const next = tokens[k + 1]
            if (next !== undefined && !next.op) {
              for (const nested of scanBashTargets(unquoteForNested(next.text), cwd)) add(nested)
            }
            k += 2
            continue
          }
          k += 1
          continue
        }
        if (HEREDOC_OPS.has(t.text)) {
          const delimTok = tokens[k + 1]
          if (delimTok !== undefined && !delimTok.op) {
            const delim = unquoteForNested(delimTok.text)
            const body = []
            let m = k + 2
            let closed = false
            while (m < tokens.length) {
              const mt = tokens[m]
              if (mt === undefined) break
              if (!mt.op && unquoteForNested(mt.text) === delim) { closed = true; break }
              body.push(mt.text)
              m += 1
            }
            const text = body.join(' ')
            if (text.trim().length > 0) {
              for (const nested of scanBashTargets(text, cwd)) add(nested)
            }
            k = closed ? m + 1 : m
            continue
          }
          break
        }
        break
      }
      cursor = j
      commandStart = false
      continue
    }

    const mutation = MUTATION_COMMANDS[commandWord]
    if (mutation === undefined) { cursor = j; commandStart = false; continue }

    if (commandWord === 'dd') {
      let kk = j
      while (kk < tokens.length) {
        const t = tokens[kk]
        if (t === undefined || t.op) break
        const w = staticPath(t.text)
        if (w === undefined) break
        if (w.startsWith('of=')) {
          const value = w.slice(3)
          if (value.length > 0) {
            if (isAbsoluteSpelling(value)) add(value)
            else if (cwd !== undefined) add(cwd === '' ? value : cwd + '/' + value)
          }
        }
        kk += 1
      }
      cursor = kk
      commandStart = false
      continue
    }

    const positionals = []
    const optionValues = []
    let targetDir
    let optionValue
    let k = j
    let positionalOnly = false
    let sawDynamic = false
    while (k < tokens.length) {
      const t = tokens[k]
      if (t === undefined || t.op) break
      const w = staticPath(t.text)
      if (w === undefined) {
        sawDynamic = true
        break
      }
      if (!positionalOnly && w.startsWith('-') && w !== '-') {
        if (w === '--') { positionalOnly = true; k += 1; continue }
        const eq = w.indexOf('=')
        if (eq === -1) {
          if (w.length > 2 && w[1] !== '-') {
            const clusterState = { optionValues, optionValue, targetDir }
            parseShortCluster(w, mutation, clusterState)
            optionValue = clusterState.optionValue
            targetDir = clusterState.targetDir
            k += 1
            continue
          }
          const flag = w
          const takesValue = mutation.options.includes(flag)
          const skipsValue = mutation.skipValues !== undefined && mutation.skipValues.includes(flag)
          if (takesValue || skipsValue) optionValue = flag
          k += 1
          continue
        }
        const flag = w.slice(0, eq)
        const value = w.slice(eq + 1)
        const takesValue = mutation.options.includes(flag)
        const skipsValue = mutation.skipValues !== undefined && mutation.skipValues.includes(flag)
        if (takesValue || skipsValue) {
          if (value.length > 0) {
            if (flag === '-t' || flag === '--target-directory') targetDir = value
            else if (skipsValue) { /* read reference / metadata: never a target */ }
            else optionValues.push(value)
          } else {
            optionValue = flag
          }
        }
        k += 1
        continue
      }
      if (optionValue !== undefined) {
        if (optionValue === '-t' || optionValue === '--target-directory') targetDir = w
        else if (mutation.skipValues !== undefined && mutation.skipValues.includes(optionValue)) { /* read reference / metadata: never a target */ }
        else optionValues.push(w)
        optionValue = undefined
        k += 1
        continue
      }
      positionals.push(w)
      k += 1
    }

    let targets
    if (mutation.operands === 'none') {
      targets = optionValues
    } else if (mutation.operands === 'last-is-dest') {
      const dest = targetDir !== undefined ? targetDir : (positionals.length > 0 && !sawDynamic ? positionals[positionals.length - 1] : undefined)
      targets = dest === undefined ? [] : [dest]
    } else if (mutation.operands === 'all-skip-first') {
      const skip = positionals.length > 0 && isModeOrOwnerWord(positionals[0], commandWord)
      targets = positionals.slice(skip ? 1 : 0).concat(optionValues)
    } else {
      targets = positionals.concat(optionValues)
    }
    for (const target of targets) {
      if (isAbsoluteSpelling(target)) {
        add(target)
      } else if (cwd !== undefined) {
        add(cwd === '' ? target : cwd + '/' + target)
      }
    }
    cursor = k
    commandStart = false
  }

  return found
}

// ── gate + plugin ───────────────────────────────────────────────────────────

function carriesEscalation(exec) {
  if (exec.arguments === null || typeof exec.arguments !== 'object') return false
  return typeof exec.arguments['sandbox_permissions'] === 'string'
}

function denyReason(target) {
  return DENY_MARKER + ' target "' + target + '" lies outside the writable set: read-only mode permits no file writes. '
    + 'Retry with the `sandbox_permissions` argument and a justification only when the write is genuinely required; '
    + 'the retry asks for approval.'
}

export const name = 'readonly-gate'
export const inject = ['sandboxPolicy']

export function apply(ctx, config) {
  const shellTools = config && Array.isArray(config.shellTools) ? config.shellTools : ['bash']
  ctx.on('tools/pre-execute', async (exec, next) => {
    const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
    if (policy.mode !== 'read-only') return next()
    if (carriesEscalation(exec)) return next()
    if (shellTools.indexOf(exec.name) === -1) return next()
    const args = exec.arguments
    if (args === null || typeof args !== 'object') return next()
    const command = args['command']
    if (typeof command !== 'string' || command.length === 0) return next()
    const targets = scanBashTargets(command).filter(path => !isShellSink(path))
    if (targets.length === 0) return next()
    ctx.logger('userspace-gate').warn(`denied ${exec.name} call targeting "${targets[0]}" (session sandbox mode: read-only)`)
    return { kind: 'deny', reason: denyReason(targets[0]) }
  })
}
