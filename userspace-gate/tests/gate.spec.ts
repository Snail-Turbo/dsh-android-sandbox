import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { firstUncontainedTarget } from '../src/gate.ts'

/**
 * Gate behavior: containment under the workspace root and the platform temp
 * areas, `../` traversal, symlink escapes, the bash `/dev/null` sink grant,
 * and the mode scope (this gate owns only `workspace-write`).
 *
 * The workspace root is deliberately created under HOME, NOT under `tmpdir`:
 * `tmpdir()` is itself a writable root, so an escape fixture under it would
 * read as contained and prove nothing (mirrors the fs-sandbox suite).
 */

const bases: string[] = []

afterEach(async () => {
  for (const base of bases.splice(0)) {
    await import('node:fs/promises').then(fs => fs.rm(base, { recursive: true, force: true }))
  }
})

async function fixture(): Promise<{ workspace: string; outside: string }> {
  const base = await mkdtemp(join(homedir(), 'ws-guard-gate-'))
  bases.push(base)
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  return { workspace, outside }
}

function policy(workspace: string, mode: SandboxExecutionPolicy['mode'] = 'workspace-write'): SandboxExecutionPolicy {
  return { mode, workspaceRoot: resolve(workspace) }
}

describe('workspace-write containment', () => {
  it('allows targets inside the workspace', async () => {
    const { workspace } = await fixture()
    await expect(firstUncontainedTarget([join(workspace, 'a.txt')], policy(workspace))).resolves.toBeUndefined()
  })

  it('denies targets outside the workspace and temp roots', async () => {
    const { workspace, outside } = await fixture()
    await expect(firstUncontainedTarget(['/etc/passwd'], policy(workspace))).resolves.toBe('/etc/passwd')
    await expect(firstUncontainedTarget([join(outside, 'secret.txt')], policy(workspace))).resolves.toBe(join(outside, 'secret.txt'))
  })

  it('allows targets under the platform temp areas', async () => {
    const { workspace } = await fixture()
    await expect(firstUncontainedTarget([join(tmpdir(), 'any.tmp')], policy(workspace))).resolves.toBeUndefined()
    await expect(firstUncontainedTarget(['/tmp/any.tmp'], policy(workspace))).resolves.toBeUndefined()
  })

  it('denies parent traversal from a relative spelling', async () => {
    const { workspace, outside } = await fixture()
    await expect(firstUncontainedTarget(['../outside/secret.txt'], policy(workspace))).resolves.toBe('../outside/secret.txt')
    await expect(firstUncontainedTarget([join(workspace, '..', 'outside', 'secret.txt')], policy(workspace))).resolves.toBe(join(workspace, '..', 'outside', 'secret.txt'))
    void outside
  })

  it('denies a symlink escape whose canonical target lies outside', async () => {
    const { workspace, outside } = await fixture()
    const link = join(workspace, 'escape')
    await symlink(outside, link)
    await expect(firstUncontainedTarget([join(link, 'secret.txt')], policy(workspace))).resolves.toBe(join(link, 'secret.txt'))
  })

  it('grants the /dev/null sink only to shell tools (allowSinks)', async () => {
    const { workspace } = await fixture()
    await expect(firstUncontainedTarget(['/dev/null'], policy(workspace), true)).resolves.toBeUndefined()
    await expect(firstUncontainedTarget(['/dev/null'], policy(workspace))).resolves.toBe('/dev/null')
  })
})

describe('mode scope', () => {
  it('is a pass-through under danger-full-access', async () => {
    const { workspace } = await fixture()
    await expect(firstUncontainedTarget(['/etc/passwd'], policy(workspace, 'danger-full-access'))).resolves.toBeUndefined()
  })

  it('is a pass-through under read-only (the filesystem fence owns that mode)', async () => {
    const { workspace } = await fixture()
    await expect(firstUncontainedTarget(['/etc/passwd'], policy(workspace, 'read-only'))).resolves.toBeUndefined()
  })
})
