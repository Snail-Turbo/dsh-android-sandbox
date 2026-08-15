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
export type BashTargetKind = 'redirect' | 'operand' | 'option-value'

/** One statically determined file the command writes, mutates, or deletes. */
export interface BashWriteTarget {
  /** The literal path exactly as written (relative or absolute). */
  path: string
  /** How the target was spelled. */
  kind: BashTargetKind
}

/** Words that never name the command: leading wrappers with their flags. */
const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  sudo: ['-u', '-g', '--user', '--group'],
  doas: ['-u'],
  env: [],
  command: [],
  nohup: [],
  nice: ['-n'],
  // `time -p` takes a BOOLEAN `-p` (POSIX mode), not a value; treating it as a
  // value-taking flag skipped the real command entirely (`time -p rm -rf /etc/x`
  // produced no targets).
  time: [],
  taskset: ['-c', '-p'],
  ionice: ['-c', '-n', '-p'],
  stdbuf: ['-i', '-o', '-e'],
  // `exec sh -c '...'` replaces the shell with `sh`, so the trailing command
  // is the very command that runs; `exec` itself takes no command-name flag.
  exec: [],
}

/** Operand policy for one mutation command. */
type OperandPolicy = 'all' | 'all-skip-first' | 'last-is-dest' | 'none'

/** One command with file-write intent. */
interface MutationCommand {
  /**
   * What to do with positional operands: `all` treats every non-option
   * operand as a target (`rm`, `touch`, …); `all-skip-first` skips the first
   * positional (chmod's mode word, chown's owner spec); `last-is-dest` treats
   * only the final operand — or the `-t`/`--target-directory` value — as the
   * write target because the earlier operands are read sources (`cp`, `mv`,
   * …); `none` scans only option values (`curl -o`, `tar -C`, …).
   */
  operands: OperandPolicy
  /** Value-taking flags whose NEXT word (or `=` value) is a write target. */
  options: readonly string[]
  /**
   * Value-taking flags whose NEXT word (or `=` value) is NOT a write target
   * (a read reference or metadata): `touch -r/--reference/-t/-d`,
   * `chmod/chown --reference`. Their values are skipped, never emitted.
   */
  skipValues?: readonly string[]
}

/**
 * Commands with file-write intent. Read-only reference operands (chmod's
 * `--reference`, touch's `-r`, …) are deliberately absent from `options`: the
 * scanner emits only MUTATION targets, never read sources.
 */
const MUTATION_COMMANDS: Readonly<Record<string, MutationCommand>> = {
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
  // `dd` is special-cased: only `of=` names the write target; `if=`, `bs=`,
  // `count=`, … are reads or metadata and must never be emitted (a pure-read
  // `dd if=… of=/dev/null` is not a file write).
  dd: { operands: 'all', options: [] },
  curl: { operands: 'none', options: ['-o', '--output'] },
  wget: { operands: 'none', options: ['-O', '--output-document'] },
  tar: { operands: 'none', options: ['-C', '--directory', '-f', '--file'] },
  unzip: { operands: 'none', options: ['-d'] },
}

/** Shells whose `-c` VALUE (and heredoc body) is a nested command scanned recursively. */
const NESTED_SHELLS: Readonly<Record<string, readonly string[]>> = {
  bash: ['-c'],
  sh: ['-c'],
  dash: ['-c'],
  ksh: ['-c'],
  zsh: ['-c'],
  fish: ['-c'],
}

/** Characters that make a word dynamic (expansions, globs, escapes, nesting). */
const DYNAMIC = /[\$`~*?\[\]{}()\\]/

/** Operators that end one command and start the next (or a subshell). */
const COMMAND_BOUNDARIES = new Set([';', '&', '|', '(', ')', '&&', '||', '|&', ';;'])

/** Operators that redirect a stream; their following word is a target, not a command. */
const REDIRECT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&', '<&', '<', '<<', '<<-', '<<<'])

/** Heredoc operators whose BODY is command text when the command is a shell. */
const HEREDOC_OPS = new Set(['<<', '<<-'])

interface Token {
  /** Operator symbol for operator tokens, or the word text for words. */
  text: string
  /** Whether the token is a shell operator. */
  op: boolean
  /** Whether the word was quoted (quoted words are still static after unquoting). */
  quoted: boolean
}

/**
 * Tokenize a shell command into words and operators, tracking quotes. This is
 * a pragmatic scanner, not a full shell grammar: it understands quoting and
 * the operators relevant to redirection and command boundaries, and treats
 * everything else as word text.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let quoted = false
  let quote: "'" | '"' | undefined

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
    // An unquoted `#` at a word boundary starts a comment: everything after
    // it is not executed by the shell and must not contribute targets.
    if (char === '#' && quote === undefined && word.length === 0) break
    if (char === '\\' && quote !== "'") {
      // A backslash makes the word dynamic for this scanner: we cannot cheaply
      // decide whether the escaped character was significant.
      word += char
      continue
    }
    if (quote === "'" || quote === '"') {
      if (char === quote) {
        quote = undefined
        quoted = true
      } else {
        word += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoted = true
      continue
    }
    if (/\s/.test(char)) {
      flushWord()
      continue
    }
    const rest = command.slice(i)
    const two = rest.slice(0, 2)
    const three = rest.slice(0, 3)
    let op: string | undefined
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
  if (quote !== undefined) {
    // Unterminated quote: flush the tail as a word so it is scanned (and, being
    // quoted, counts as a static literal only if fully quoted — it is not).
    word += '"'
  }
  flushWord()
  return tokens
}

/** Whether a word is a static literal path (no expansions, escapes, or globs). */
function staticPath(word: string): string | undefined {
  if (word.length === 0) return undefined
  if (DYNAMIC.test(word)) return undefined
  return word
}

/** A fd-number word (`2`, `1`), an fd move (`2>&1-` closes via `1-`), or `-` used after `>&` / `<&`. */
function isFdReference(word: string): boolean {
  return word === '-' || /^[0-9]+-?$/.test(word)
}

/** Strip one layer of surrounding quotes from a raw word for nested scanning. */
function unquoteForNested(raw: string): string {
  if (raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    return raw.slice(1, -1)
  }
  return raw
}

/** Absolute-path prefix on POSIX and Windows. */
function isAbsoluteSpelling(path: string): boolean {
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

/** Whether `word` looks like chmod's mode word or chown's owner spec (not a path). */
function isModeOrOwnerWord(word: string, command: string): boolean {
  if (command === 'chmod') {
    return /^[0-7]{1,4}$/.test(word) || /^[ugoa]*[+-=][rwxXstugo]*$/.test(word)
  }
  // chown: `[user][:group]` — never a path (no `/`).
  return /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/.test(word) && !word.includes('/')
}

/**
 * Parse a short-option cluster or an attached short-option value
 * (`-czf out.tar`, `-o/etc/x`, `-o=/etc/x`, `-t/etc`). Scans the characters
 * after the leading `-`; the first character whose flag is a value-taking
 * option consumes the rest of the word as its value (or records the flag to
 * take the next word). Returns whether the word was recognized as an option
 * cluster at all.
 */
function parseShortCluster(
  word: string,
  mutation: MutationCommand,
  state: { optionValues: string[]; optionValue: string | undefined; targetDir: string | undefined },
): boolean {
  const chars = word.slice(1)
  for (let ci = 0; ci < chars.length; ci += 1) {
    const flag = '-' + chars[ci]
    const takesValue = mutation.options.includes(flag)
    const skipsValue = mutation.skipValues?.includes(flag) ?? false
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

/**
 * Scan one shell command for static write targets.
 * @param command - the shell command text (the `bash` tool's `command` argument).
 * @param initialCwd - the statically known starting working directory
 *   (absolute when the tool call carries a `workdir` argument, `''` when the
 *   command starts in the session workspace, `undefined` when unknown); the
 *   gate resolves relative spellings against the same base.
 * @returns the deduplicated static targets, in first-appearance order.
 */
export function scanBashTargets(command: string, initialCwd = ''): BashWriteTarget[] {
  const found: BashWriteTarget[] = []
  const seen = new Set<string>()

  const add = (path: string, kind: BashTargetKind) => {
    if (path.length === 0) return
    if (seen.has(path)) return
    seen.add(path)
    found.push({ path, kind })
  }

  const tokens = tokenize(command)
  let i = 0
  // Static working directory tracked across `cd` commands; `undefined` once a
  // dynamic `cd` (or bare `cd` / `cd -`) makes relative targets unknowable.
  let cwd: string | undefined = initialCwd
  // Set when the next word is the target of a write redirection.
  let pendingWriteRedirect = false
  // Set when the next word is the fd-dup or redirect target of `>&` / `<&`.
  let pendingFdDup = false

  while (i < tokens.length) {
    const token = tokens[i]
    if (token === undefined) break
    if (!token.op) {
      if (pendingWriteRedirect) {
        const target = staticPath(token.text)
        if (target !== undefined) add(target, 'redirect')
        pendingWriteRedirect = false
      } else if (pendingFdDup) {
        // `2>&1` / `>&-` dup an existing descriptor (no file target);
        // `>& file` is the legacy both-streams redirect — a write target.
        if (!isFdReference(token.text)) {
          const target = staticPath(token.text)
          if (target !== undefined) add(target, 'redirect')
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
      // Input redirects and heredocs do not write files; `<<`'s delimiter word
      // is consumed but never a target. A `> file` before `<<EOF` was already
      // handled as its own redirect.
      pendingWriteRedirect = false
      pendingFdDup = false
      i += 1
      continue
    }
    if (COMMAND_BOUNDARIES.has(op)) {
      pendingWriteRedirect = false
      pendingFdDup = false
      i += 1
      continue
    }
    // Any other operator (||, &&, ;;, |&…): not a redirect; keep scanning.
    pendingWriteRedirect = false
    pendingFdDup = false
    i += 1
  }

  // Second pass: command boundaries and operands. The redirect pass above is
  // independent, so the two passes compose without sharing state.
  let cursor = 0
  let commandStart = true
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token === undefined) break
    if (token.op) {
      if (REDIRECT_OPS.has(token.text)) {
        // A redirect's following word is its target (already extracted by the
        // redirect pass) or an fd reference — never a new command.
        const next = tokens[cursor + 1]
        if (next !== undefined && !next.op) cursor += 1
        commandStart = false
      } else {
        commandStart = true
      }
      cursor += 1
      continue
    }
    if (!commandStart) {
      cursor += 1
      continue
    }
    const word = staticPath(token.text)
    if (word === undefined) {
      commandStart = false
      cursor += 1
      continue
    }
    // Environment-assignment prefixes (`FOO=1 rm …`, `A=1 B=2 touch …`) are
    // not commands; skip the whole run of them before resolving the command
    // word. Without this, `FOO=1 rm -rf /etc/x` lost `rm` entirely.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      cursor += 1
      continue
    }

    // Resolve wrapper chains (sudo/env/…/exec) to the real command.
    let commandWord = word
    let j = cursor + 1
    for (;;) {
      const wrapper = WRAPPERS[commandWord]
      if (wrapper === undefined) break
      // Skip the wrapper's flags (with their values) and env assignments.
      while (j < tokens.length) {
        const t = tokens[j]
        if (t === undefined || t.op) break
        const w = staticPath(t.text)
        if (w === undefined) break
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
          j += 1
          continue
        }
        const takesValue = wrapper.some(flag => w === flag)
        if (takesValue) {
          j += 2
          continue
        }
        if (w.startsWith('-')) {
          j += 1
          continue
        }
        break
      }
      const next = tokens[j]
      if (next === undefined || next.op) {
        commandWord = ''
        break
      }
      commandWord = next.text
      j += 1
    }
    if (commandWord === '') {
      commandStart = false
      cursor += 1
      continue
    }

    // `cd` changes the tracked cwd for subsequent relative operands. The
    // initial cwd is the tool `workdir` (absolute) or `''` (the session
    // workspace, spelled relatively); a relative `cd` keeps the spelling
    // relative so the gate resolves it against the workspace root, while an
    // absolute `cd` leaves the workspace. A bare `cd` (to `$HOME`), `cd -`
    // (to `$OLDPWD`), or a dynamic target makes the cwd unknowable.
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
      cwd = isAbsoluteSpelling(path) ? path : cwd === '' ? path : `${cwd}/${path}`
      cursor = j + 1
      commandStart = false
      continue
    }

    // Nested shell: recursively scan every `-c` value AND the body of a
    // heredoc handed to the shell (`bash <<EOF … EOF` — the body is a script
    // that runs with the harness authority). The nested scan inherits the
    // tracked cwd.
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
              for (const nested of scanBashTargets(unquoteForNested(next.text), cwd)) {
                add(nested.path, nested.kind)
              }
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
            const body: string[] = []
            let m = k + 2
            let closed = false
            while (m < tokens.length) {
              const mt = tokens[m]
              if (mt === undefined) break
              if (!mt.op && unquoteForNested(mt.text) === delim) {
                closed = true
                break
              }
              body.push(mt.text)
              m += 1
            }
            const text = body.join(' ')
            if (text.trim().length > 0) {
              for (const nested of scanBashTargets(text, cwd)) {
                add(nested.path, nested.kind)
              }
            }
            k = closed ? m + 1 : m
            continue
          }
          break
        }
        // Any other operator ends this shell invocation's argument list.
        break
      }
      cursor = j
      commandStart = false
      continue
    }

    const mutation = MUTATION_COMMANDS[commandWord]
    if (mutation === undefined) {
      cursor = j
      commandStart = false
      continue
    }

    // `dd` special case: only `of=` is a write target; `if=`/`bs=`/`count=`/
    // … are reads or metadata and never emitted.
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
            if (isAbsoluteSpelling(value)) add(value, 'operand')
            else if (cwd !== undefined) add(cwd === '' ? value : `${cwd}/${value}`, 'operand')
          }
        }
        kk += 1
      }
      cursor = kk
      commandStart = false
      continue
    }

    // Scan this mutation command's operands.
    const positionals: string[] = []
    const optionValues: string[] = []
    let targetDir: string | undefined
    let optionValue: string | undefined
    let k = j
    let positionalOnly = false
    // Set when the scan stops at a DYNAMIC word: any later positional — the
    // real destination of a last-is-dest command, for example — is invisible,
    // so the last static positional must never be mistaken for it.
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
        if (w === '--') {
          positionalOnly = true
          k += 1
          continue
        }
        const eq = w.indexOf('=')
        if (eq === -1) {
          // Short-option cluster or attached value (`-czf out.tar`,
          // `-o/etc/x`, `-o=/etc/x`, `-t/etc`), or a plain boolean option.
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
          const skipsValue = mutation.skipValues?.includes(flag) ?? false
          if (takesValue || skipsValue) optionValue = flag
          k += 1
          continue
        }
        const flag = w.slice(0, eq)
        const value = w.slice(eq + 1)
        const takesValue = mutation.options.includes(flag)
        const skipsValue = mutation.skipValues?.includes(flag) ?? false
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
        else if (mutation.skipValues?.includes(optionValue) ?? false) { /* read reference / metadata: never a target */ }
        else optionValues.push(w)
        optionValue = undefined
        k += 1
        continue
      }
      positionals.push(w)
      k += 1
    }

    // Select the write targets per the command's operand policy.
    let targets: string[]
    if (mutation.operands === 'none') {
      targets = optionValues
    } else if (mutation.operands === 'last-is-dest') {
      // `cp a b $dyn` / `cp a $dyn b`: when the operand scan stopped at a
      // dynamic word, the real destination is unknown (it may be that very
      // word's expansion or a later one) — never mistake the last STATIC
      // positional (a source) for the destination. An explicit `-t` /
      // `--target-directory` destination is still known.
      const dest = targetDir ?? (positionals.length > 0 && !sawDynamic ? positionals[positionals.length - 1] : undefined)
      targets = dest === undefined ? [] : [dest]
    } else if (mutation.operands === 'all-skip-first') {
      // chmod's mode word / chown's owner spec is the first positional — but
      // only when it actually looks like one (`chmod --reference=/etc/x
      // /etc/y` has no mode word and `/etc/y` IS the target).
      const skip = positionals.length > 0 && isModeOrOwnerWord(positionals[0], commandWord)
      targets = [...positionals.slice(skip ? 1 : 0), ...optionValues]
    } else {
      targets = [...positionals, ...optionValues]
    }
    for (const target of targets) {
      if (isAbsoluteSpelling(target)) {
        add(target, 'operand')
      } else if (cwd !== undefined) {
        // `''` means "relative to the session workspace"; the gate resolves it
        // against the workspace root.
        add(cwd === '' ? target : `${cwd}/${target}`, 'operand')
      }
      // cwd unknown: a relative target could land anywhere; only the kernel
      // runner can decide it, so the scanner stays silent.
    }
    cursor = k
    commandStart = false
  }

  return found
}
