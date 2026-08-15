import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SandboxPolicyService, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import * as WorkspaceGuard from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Real-composition suite: the guard mounted in a booted agent loop, driven by
 * a scripted mock LLM, so the denials are asserted on the MODEL-VISIBLE tool
 * results (the same surface a user's session sees), not on listener internals.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })).catch(() => {})
  }
})

/** Boot the agent-loop spine, the sandbox-policy service, and the guard. */
async function harness(): Promise<{ ctx: Context; root: string }> {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'ws-guard-loop-'))
  roots.push(root)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(WorkspaceGuard)
  for (const tool of ['write', 'edit', 'bash'] as const) {
    ctx.tools.register(defineContentToolFixture({
      name: tool,
      description: tool,
      parameters: tool === 'bash' ? { command: { type: 'string' } } : { file_path: { type: 'string' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
  }
  return { ctx, root }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: current, status }) => {
      if (current === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Every logged tool result's model-facing text, in order. */
function toolResultTexts(agent: Agent): string[] {
  return agent.session.events
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => event.data.message.content
      .flatMap(block => block.type === 'tool-result' ? block.content : [])
      .map(block => block.type === 'text' ? block.text : '')
      .join(''))
}

/** One scripted MockAdapter entry (its constructor parameter type spelled out for the host typecheck). */
type MockScriptEntry = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]) | 'hang' | 'hang-slow'

/** Drive one scripted turn and wait for the agent to go idle. */
async function run(ctx: Context, agent: Agent, script: MockScriptEntry[]): Promise<void> {
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
}

describe('userspace-gate in a real agent loop', () => {
  it('denies a write outside the workspace with the guard marker', async () => {
    const { ctx } = await harness()
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent, [
      toolCallResponse('c1', 'write', { file_path: '/etc/evil' }),
      textResponse('done'),
    ])
    const texts = toolResultTexts(agent)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Error: [userspace-gate: file access denied under workspace-write mode]')
    expect(texts[0]).toContain('/etc/evil')
  })

  it('denies an edit outside the workspace', async () => {
    const { ctx } = await harness()
    const agent = ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent, [
      toolCallResponse('c1', 'edit', { file_path: '/etc/evil' }),
      textResponse('done'),
    ])
    expect(toolResultTexts(agent)[0]).toContain('[userspace-gate: file access denied under workspace-write mode]')
  })

  it('allows a write inside the workspace', async () => {
    const { ctx, root } = await harness()
    const agent = ctx.agentLoop.create(SessionId('a3'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent, [
      toolCallResponse('c1', 'write', { file_path: join(root, 'ok.txt') }),
      textResponse('done'),
    ])
    expect(toolResultTexts(agent)).toEqual(['ok'])
  })

  it('denies a bash write redirection outside the workspace', async () => {
    const { ctx } = await harness()
    const agent = ctx.agentLoop.create(SessionId('a4'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent, [
      toolCallResponse('c1', 'bash', { command: 'echo pwn > /etc/cron.d/x' }),
      textResponse('done'),
    ])
    const texts = toolResultTexts(agent)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('[userspace-gate: file access denied under workspace-write mode]')
    expect(texts[0]).toContain('/etc/cron.d/x')
  })

  it('allows a bash redirect to the /dev/null sink and inside the workspace', async () => {
    const { ctx } = await harness()
    const agent = ctx.agentLoop.create(SessionId('a5'), { provider: 'mock', model: 'mock' })
    await run(ctx, agent, [
      toolCallResponse('c1', 'bash', { command: 'echo x > /dev/null 2>&1' }),
      toolCallResponse('c2', 'bash', { command: 'echo y > out.txt' }),
      textResponse('done'),
    ])
    expect(toolResultTexts(agent)).toEqual(['ok', 'ok'])
  })

  it('follows the session mode: danger-full-access passes the same call through', async () => {
    const { ctx } = await harness()
    const agent = ctx.agentLoop.create(SessionId('a6'), { provider: 'mock', model: 'mock' })
    setSandboxMode(agent.session, 'danger-full-access')
    await run(ctx, agent, [
      toolCallResponse('c1', 'write', { file_path: '/etc/evil' }),
      toolCallResponse('c2', 'bash', { command: 'echo pwn > /etc/cron.d/x' }),
      textResponse('done'),
    ])
    expect(toolResultTexts(agent)).toEqual(['ok', 'ok'])
  })
})
