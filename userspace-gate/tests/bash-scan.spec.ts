import { describe, expect, it } from 'vitest'
import { scanBashTargets } from '../src/bash-scan.ts'

/** The emitted target paths for one command, in order. */
function paths(command: string): string[] {
  return scanBashTargets(command).map(target => target.path)
}

describe('redirection targets', () => {
  it('extracts a static stdout redirect', () => {
    expect(paths('echo hi > /etc/x')).toEqual(['/etc/x'])
  })

  it('extracts append redirects', () => {
    expect(paths('echo hi >> /var/log/x')).toEqual(['/var/log/x'])
  })

  it('extracts redirects without surrounding spaces', () => {
    expect(paths('ls -la >/tmp/l.txt')).toEqual(['/tmp/l.txt'])
  })

  it('extracts a fully quoted target including spaces', () => {
    expect(paths('echo a > "/etc/a b"')).toEqual(['/etc/a b'])
  })

  it('extracts the both-streams legacy redirect (>& file)', () => {
    expect(paths('echo a >& /etc/x')).toEqual(['/etc/x'])
  })

  it('treats fd duplication as a non-target', () => {
    expect(paths('echo x 2>&1')).toEqual([])
    expect(paths('echo x > /dev/null 2>&1')).toEqual(['/dev/null'])
  })

  it('extracts a redirect before a heredoc body', () => {
    expect(paths('cat <<EOF > /etc/x\nbody\nEOF')).toEqual(['/etc/x'])
  })

  it('does not treat heredoc delimiters as targets', () => {
    expect(paths('cat <<EOF')).toEqual([])
    expect(paths('read x <<< "str"')).toEqual([])
  })

  it('extracts a target after an inline comment', () => {
    expect(paths('echo x > /etc/x # comment')).toEqual(['/etc/x'])
  })

  it('extracts targets from multiple commands', () => {
    expect(paths('echo a > /etc/x && echo b > /tmp/y')).toEqual(['/etc/x', '/tmp/y'])
    expect(paths('echo a > /etc/x; rm -rf /var/tmp/z')).toEqual(['/etc/x', '/var/tmp/z'])
  })
})

describe('dynamic targets stay silent', () => {
  it('skips variable expansion', () => {
    expect(paths('echo a > /etc/$x')).toEqual([])
    expect(paths('echo a > "$HOME/x"')).toEqual([])
  })

  it('skips command substitution, tilde, and globs', () => {
    expect(paths('echo a > /etc/$(date)')).toEqual([])
    expect(paths('echo a > ~/x')).toEqual([])
    expect(paths('echo a > /etc/*.d')).toEqual([])
  })

  it('skips escaped characters', () => {
    expect(paths('echo a > /etc/a\\ b')).toEqual([])
  })
})

describe('mutation command operands', () => {
  it('treats every rm operand as a target', () => {
    expect(paths('rm -rf /etc')).toEqual(['/etc'])
    expect(paths('rm /workspace/x /etc/y')).toEqual(['/workspace/x', '/etc/y'])
  })

  it('treats touch, mkdir, and tee operands as targets', () => {
    expect(paths('touch /etc/marker')).toEqual(['/etc/marker'])
    expect(paths('mkdir -p /tmp/a/b')).toEqual(['/tmp/a/b'])
    expect(paths('echo a | tee /etc/x')).toEqual(['/etc/x'])
  })

  it('treats only the LAST mv/cp operand as the write target', () => {
    expect(paths('mv /etc/passwd /tmp/x')).toEqual(['/tmp/x'])
    expect(paths('cp /etc/passwd ./x')).toEqual(['./x'])
    expect(paths('cp -t /etc src dst')).toEqual(['/etc'])
  })

  it('scans chmod operands but tolerates the mode word', () => {
    expect(paths('chmod 777 /etc/x')).toEqual(['/etc/x'])
  })

  it('scans wrapper chains to the real command', () => {
    expect(paths('sudo tee /etc/x')).toEqual(['/etc/x'])
    expect(paths('sudo -u root touch /etc/marker')).toEqual(['/etc/marker'])
    expect(paths('env A=1 touch /etc/x')).toEqual(['/etc/x'])
  })

  it('scans option values for curl, tar, and unzip', () => {
    expect(paths('curl -o /etc/x http://h')).toEqual(['/etc/x'])
    expect(paths('curl --output=/etc/x http://h')).toEqual(['/etc/x'])
    expect(paths('tar -C /etc -f out.tar .')).toEqual(['/etc', 'out.tar'])
    expect(paths('unzip -d /etc f.zip')).toEqual(['/etc'])
  })
})

describe('cd tracking', () => {
  it('resolves relative operands after a static cd', () => {
    expect(paths('cd /etc && touch x')).toEqual(['/etc/x'])
    expect(paths('cd /tmp && touch x')).toEqual(['/tmp/x'])
    expect(paths('cd sub && touch x')).toEqual(['sub/x'])
  })

  it('keeps the initial relative spelling when no cd happened', () => {
    expect(paths('touch x')).toEqual(['x'])
    expect(paths('cp /etc/passwd ./x')).toEqual(['./x'])
  })

  it('stays silent on relative operands after a dynamic cd', () => {
    expect(paths('cd $D && touch x')).toEqual([])
  })
})

describe('nested shells', () => {
  it('recursively scans a bash -c value', () => {
    expect(paths("bash -c 'echo x > /etc/x'")).toEqual(['/etc/x'])
    expect(paths('sh -c "rm -rf /etc/x"')).toEqual(['/etc/x'])
  })
})

describe('environment-assignment prefixes', () => {
  it('skips env prefixes before the command word', () => {
    expect(paths('FOO=1 rm -rf /etc/x')).toEqual(['/etc/x'])
    expect(paths('A=1 B=2 touch /etc/marker')).toEqual(['/etc/marker'])
    expect(paths('FOO=bar cp /etc/passwd /tmp/y')).toEqual(['/tmp/y'])
  })

  it('still scans redirects on a bare env-prefixed line', () => {
    expect(paths('FOO=1 > /etc/x')).toEqual(['/etc/x'])
  })
})

describe('heredoc bodies handed to a shell', () => {
  it('recursively scans the heredoc body of a shell command', () => {
    expect(paths('bash <<EOF\nrm -rf /etc/x\nEOF')).toEqual(['/etc/x'])
    expect(paths('sh <<EOF\ntouch /etc/x\nEOF')).toEqual(['/etc/x'])
    expect(paths("bash <<'EOF'\nrm -rf /etc/x\nEOF")).toEqual(['/etc/x'])
  })

  it('does not invent targets from a heredoc without a shell', () => {
    expect(paths('cat <<EOF\nrm -rf /etc/x\nEOF')).toEqual([])
  })
})

describe('short-option clusters and attached values', () => {
  it('parses tar -czf (cluster) and its archive value', () => {
    expect(paths('tar -czf /etc/x.tar dir')).toEqual(['/etc/x.tar'])
  })

  it('parses attached short-option values', () => {
    expect(paths('curl -o/etc/x http://h')).toEqual(['/etc/x'])
    expect(paths('curl -o=/etc/x http://h')).toEqual(['/etc/x'])
    expect(paths('wget -O/etc/x http://h')).toEqual(['/etc/x'])
    expect(paths('unzip -d/etc f.zip')).toEqual(['/etc'])
    expect(paths('cp -t/etc src dst')).toEqual(['/etc'])
  })
})

describe('--target-directory with = value', () => {
  it('treats the = value as the destination', () => {
    expect(paths('cp --target-directory=/etc src dst')).toEqual(['/etc'])
    expect(paths('cp -t=/etc src dst')).toEqual(['/etc'])
  })
})

describe('dd of=', () => {
  it('emits only the of= target', () => {
    expect(paths('dd if=/dev/zero of=/etc/x bs=1M count=1')).toEqual(['/etc/x'])
    expect(paths('dd if=/dev/zero of=/dev/null bs=4k')).toEqual(['/dev/null'])
  })

  it('stays silent on a pure-read dd', () => {
    expect(paths('dd if=/dev/zero bs=4k')).toEqual([])
  })
})

describe('workdir initial cwd', () => {
  it('resolves relative targets against the initial cwd', () => {
    expect(scanBashTargets('touch x', '/etc')).toEqual([{ path: '/etc/x', kind: 'operand' }])
    expect(scanBashTargets('cd sub && touch x', '/ws')).toEqual([{ path: '/ws/sub/x', kind: 'operand' }])
    expect(scanBashTargets('rm -f x', '/etc')).toEqual([{ path: '/etc/x', kind: 'operand' }])
  })
})

describe('nested shells inherit the tracked cwd', () => {
  it('scans -c values against the outer cwd', () => {
    expect(paths('cd /etc && sh -c "touch x"')).toEqual(['/etc/x'])
    expect(paths('cd /tmp && bash -c "touch x"')).toEqual(['/tmp/x'])
  })

  it('scans every -c value, not just the first', () => {
    expect(paths('sh -c "echo a" -c "rm -rf /etc/x"')).toEqual(['/etc/x'])
  })

  it('scans through an exec wrapper', () => {
    expect(paths('exec sh -c "rm -rf /etc/x"')).toEqual(['/etc/x'])
  })
})

describe('bare cd and cd -', () => {
  it('marks the cwd unknown after a bare cd or cd -', () => {
    expect(paths('cd && touch x')).toEqual([])
    expect(paths('cd - && touch x')).toEqual([])
    expect(paths('cd && rm -rf /etc/x')).toEqual(['/etc/x'])
  })
})

describe('read-reference option values are never targets', () => {
  it('chmod --reference', () => {
    expect(paths('chmod --reference=/etc/x /etc/y')).toEqual(['/etc/y'])
    expect(paths('chmod --reference /etc/x /etc/y')).toEqual(['/etc/y'])
  })

  it('chown owner spec vs path operand', () => {
    expect(paths('chown root:root /etc/x')).toEqual(['/etc/x'])
    expect(paths('chown --reference=/a /etc/x')).toEqual(['/etc/x'])
  })

  it('touch -r / -t / -d values', () => {
    expect(paths('touch -r /etc/x /tmp/y')).toEqual(['/tmp/y'])
    expect(paths('touch -t 202401010000 /etc/x')).toEqual(['/etc/x'])
    expect(paths('touch -r/etc/x /tmp/y')).toEqual(['/tmp/y'])
  })
})

describe('misc regressions', () => {
  it('time -p does not swallow the command', () => {
    expect(paths('time -p rm -rf /etc/x')).toEqual(['/etc/x'])
  })

  it('comments do not contribute targets', () => {
    expect(paths('echo x > /etc/x # > /etc/y')).toEqual(['/etc/x'])
    expect(paths('echo hi # rm -rf /etc/y')).toEqual([])
  })

  it('fd moves are not targets', () => {
    expect(paths('echo x 2>&1-')).toEqual([])
  })

  it('never mistakes a source for a dynamic destination', () => {
    expect(paths('cp -a /etc/passwd /tmp/x-$TS')).toEqual([])
    expect(paths('mv /etc/passwd /tmp/$x')).toEqual([])
  })
})
