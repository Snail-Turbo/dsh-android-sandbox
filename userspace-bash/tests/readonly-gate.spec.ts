import { describe, expect, it } from 'vitest'
import { scanBashTargets as gateScan } from '../../userspace-gate/src/bash-scan.ts'
import { scanBashTargets, isShellSink } from '../lib/readonly-gate.js'

/**
 * Pins the readonly-gate's INLINED scanner copy to the canonical
 * implementation (`dsh-userspace-gate`'s `bash-scan.ts`): every divergence
 * between the two copies fails here. Run inside the dsh monorepo workspace
 * (see the root README's test note); the copy's deny layer is exercised
 * through the gate specs.
 *
 * @module dsh-userspace-bash/tests/readonly-gate
 */

/** The scanner's emitted paths (the readonly copy returns bare path strings). */
function paths(command: string, initialCwd?: string): string[] {
  return scanBashTargets(command, initialCwd)
}

describe('readonly-gate scanner is pinned to bash-scan.ts', () => {
  const cases: [string, string][] = [
    // redirection + boundaries
    ['redirect', 'echo hi > /etc/x'],
    ['multi-command', 'echo a > /etc/x && echo b > /tmp/y'],
    ['heredoc to shell', 'bash <<EOF\nrm -rf /etc/x\nEOF'],
    // env prefixes
    ['env prefix', 'FOO=1 rm -rf /etc/x'],
    // option clusters / attached values
    ['tar cluster', 'tar -czf /etc/x.tar dir'],
    ['attached -o', 'curl -o/etc/x http://h'],
    ['attached -d', 'unzip -d/etc f.zip'],
    ['target-directory=', 'cp --target-directory=/etc src dst'],
    // dd
    ['dd of=', 'dd if=/dev/zero of=/etc/x bs=1M count=1'],
    ['dd read-only', 'dd if=/dev/zero of=/dev/null bs=4k'],
    // cd tracking
    ['cd static', 'cd /etc && touch x'],
    ['cd bare', 'cd && touch x'],
    ['cd dash', 'cd - && touch x'],
    // nested shells
    ['nested -c', "sh -c 'touch /etc/x'"],
    ['nested cwd', 'cd /etc && sh -c "touch x"'],
    ['exec wrapper', 'exec sh -c "rm -rf /etc/x"'],
    // mutation operand policies
    ['chmod mode', 'chmod 777 /etc/x'],
    ['chmod reference', 'chmod --reference=/etc/x /etc/y'],
    ['cp dest', 'cp /etc/passwd ./x'],
    ['mv dest', 'mv /etc/passwd /tmp/x'],
    ['touch -r', 'touch -r /etc/x /tmp/y'],
    // dynamic silence
    ['dynamic dest', 'cp -a /etc/passwd /tmp/x-$TS'],
    ['glob', 'rm -rf /etc/*'],
    ['variable', 'echo a > /etc/$x'],
    // misc
    ['time -p', 'time -p rm -rf /etc/x'],
    ['comment', 'echo x > /etc/x # > /etc/y'],
    ['fd move', 'echo x 2>&1-'],
  ]

  for (const [label, command] of cases) {
    it(`matches bash-scan.ts: ${label}`, () => {
      const canonical = gateScan(command).map(target => target.path)
      const copy = paths(command)
      expect(copy).toEqual(canonical)
    })
  }

  it('matches with an initial cwd', () => {
    const command = 'touch x'
    const canonical = gateScan(command, '/etc').map(target => target.path)
    expect(paths(command, '/etc')).toEqual(canonical)
  })
})

describe('readonly-gate sink filtering', () => {
  it('grants the shell stream sinks', () => {
    for (const sink of ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/fd/0', '/dev/fd/1', '/dev/fd/2']) {
      expect(isShellSink(sink)).toBe(true)
    }
  })

  it('recognizes double-slash alias spellings', () => {
    expect(isShellSink('/dev//null')).toBe(true)
    expect(isShellSink('/dev///stdout')).toBe(true)
  })

  it('denies real files', () => {
    expect(isShellSink('/dev/fd/3')).toBe(false)
    expect(isShellSink('/etc/x')).toBe(false)
  })

  it('filters sinks out of the deny set', () => {
    expect(paths('echo x > /dev/null 2>&1')).toEqual([])
    expect(paths('echo err > /dev/stderr')).toEqual(['/dev/stderr'])
  })
})
