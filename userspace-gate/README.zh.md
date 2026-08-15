# dsh-userspace-gate

[English](README.md) | 中文

工作区写守卫：**`workspace-write` 沙箱在工具调用层的纯用户态等价实现**。一个 `tools/pre-execute` 监听器解析调用会话的沙箱策略，当解析出的模式为 `workspace-write` 时，拒绝 `write`/`edit` 调用与 shell 调用中**静态**写目标落在会话工作区与平台临时根目录之外的情况。

它不依赖任何内核特性：不需要 bwrap、Landlock、Seatbelt 或 Windows ACL runner。它在任何组合中都能工作，包括只挂载普通本地文件系统的组合，以及内核 runner 不可用或只能部分强制的设备上。它是 guard 家族对"沙箱保护不了这台设备"的答案。

## 完全独立——启用即生效

这是**完全独立的插件**：它不改动产品 bundle、无需重建、也不接入任何内置组合。把它加进某个组合的插件列表就是全部安装步骤：

```yaml
- id: userspace-gate
  name: 'dsh-userspace-gate'
```

插件**加载即生效**——下一个工具调用（所在会话解析出的沙箱模式为 `workspace-write`）即被门禁。要求：部署已挂载 `@deepseek-ai/dsh-sandbox-policy`（所有内置组合都挂载；guard 在 `inject` 中声明它，缺失时加载会大声失败，而不是静默无保护）。验证是否生效：尝试一次工作区外的写入，拒绝会携带下面的 `[userspace-gate: …]` 标记，且每次判定都会通过 `ctx.logger('userspace-gate')` 记录。

## 插件（命名空间：`userspace-gate`）

函数/命名空间插件（`name` / `inject` / `Config` / `apply`），无默认导出，无服务。它不注册任何工具；它消费 `ctx.sandboxPolicy` 服务（声明在 `inject`）与 `dsh-tools` 注册表的 `tools/pre-execute` 瀑布。

```yaml
- id: userspace-gate
  name: 'dsh-userspace-gate'
```

### 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `fsTools` | `['write', 'edit']` | `file_path` 参数会被围栏的工具名 |
| `shellTools` | `['bash']` | `command` 参数会被扫描写意图的工具名 |

### 行为

对每次工具调用，监听器：

1. 用 `ctx.sandboxPolicy.resolve({ session: exec.agent.session })` 解析本次调用的策略。
2. **跟随会话模式。** `workspace-write` 是本门禁的主要管辖范围。`read-only` 下，已挂载围栏时由文件系统围栏负责——但在**无围栏组合**中，本门禁也会为 fs 工具（`write`/`edit`；shell 工具由 `dsh-userspace-bash` 的 readonly-gate 负责）恢复 read-only 规则。`danger-full-access` 直接放行。携带工具层升级参数（`sandbox_permissions`）的调用也放行——更宽重试的审批流程属于工具层，与内置围栏完全一致。
3. 提取调用的写目标：fs 工具的 `file_path` 参数，以及 shell 命令的**静态**写意图（重定向目标、变更命令的操作数、已知选项值）。bash 工具的 `workdir` 参数参与扫描：相对目标按 workdir（相对工作区绝对化后）解析，因此 `workdir: /etc` + `touch x` 会被拒绝，而不是判为工作区内。
4. 任一目标规范化后落在可写根之外即拒绝——可写根与文件系统围栏、Seatbelt profile 使用同一集合，由同一个 `writableRoots` 函数派生，各方言不会漂移。shell 调用额外授予 bash runner 一贯授予的流接收器（原始拼写或规范化别名均可）：`/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/stdin`、`/dev/fd/0|1|2`；文件系统围栏不授予。

拒绝是 `tools/pre-execute` 的 `deny`，其模型可见原因带有稳定标记：

```text
[userspace-gate: file access denied under workspace-write mode] target "<path>" lies outside the session workspace and platform temporary directories. Retry with the `sandbox_permissions` argument and a justification only when the write is genuinely required; the retry asks for approval.
```

该标记刻意限定在本包（`[userspace-gate: …]`），而不是官方 `[sandbox: …]` 词汇（`sandboxDenialMarker`）：本门禁在**工具层**拒绝，而非内核层，独立标记避免这里的策略拒绝与 `dsh-bash-sandbox`/`dsh-fs-sandbox` 的内核沙箱拒绝混淆。

bash 扫描刻意保守：任何含展开（`$`、反引号、`~`、通配符、花括号、命令替换、转义）的词都不是候选；只有工作目录可静态确定（前面的 `cd`）时才发出相对目标；只读引用（chmod 的 `--reference`、`cp` 的源文件）从不发出。拒绝与放行都通过 `ctx.logger('userspace-gate')` 记录。

### 与内置沙箱的关系

文件系统围栏（`@deepseek-ai/dsh-fs-sandbox`）与 bash runner（`@deepseek-ai/dsh-bash-sandbox`）在已挂载且可用的组合中已经约束 `workspace-write` 执行——本守卫不取代它们，内核 runner 仍是不可信代码的**权威**边界。本守卫是纵深防御与回退层：在 runner 不可用之处它仍然工作，并为覆盖到的每个工具族提供统一的、模型可见的拒绝。在围栏已会拒绝时挂载它不会改变任何行为；在无围栏的组合中挂载它则恢复包含约束。

## 模型体验

### 条件式工具结果

#### 模型看到什么

本插件不增加提示词，也不增加 schema。被拒绝的调用，模型收到文本以 `[userspace-gate: …]` 标记开头的错误结果；其余调用原样通过。

#### Token 影响

被包含或超范围的调用零 token。一次拒绝增加一条小的错误结果，并阻止工具体运行（不会有大输出进入上下文）。

#### KV 缓存影响

只追加；新可见内容跟随可复用请求前缀，不使既有 KV 缓存条目失效。

## 已知限制与待办

- **bash 扫描是尽力而为，不是安全边界**——无法静态确定的目标（变量、命令替换、`xargs`、嵌套的非 shell 解释器、`eval`、`source` 的脚本正文、通配操作数、`\cp` 这类转义命令名）放行给内核 runner；在没有 runner 的地方它们不受约束。内核级 `ctx.sandbox` 后端才是不可信代码的权威边界。
- **命令覆盖是固定白名单**——只有 `MUTATION_COMMANDS` 中的命令（touch、mkdir、rm、mv、cp、ln、install、tee、truncate、chmod、chown、dd、curl、wget、tar、unzip 等）贡献操作数；未覆盖的写意图命令（rsync、scp、git 等）对扫描不可见。
- **工作区外的 `mv` 源文件不受门禁**——把工作区外的文件移入工作区会在外部 unlink 它；只检查目标（有内核 runner 时由其拒绝该 unlink）。
- **动态目标不受门禁**——`cp a b $dyn` 的真实目标是未知的，扫描器保持沉默（绝不把最后一个静态源误当目标）；此类调用放行。
- **门禁是用户态策略，不是内核强制**——它在可信 harness 进程内对模型控制的参数执行；被攻破的 harness 进程不在范围内，与文件系统围栏相同。
