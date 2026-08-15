# dsh-userspace-bash

[English](README.md) | 中文

面向**没有可用内核 runner** 主机的用户空间 bash 执行器。一个 `bash-local` 孪生——**对外报一个沙箱模式，但实际上从不约束**：`run`/`start` 原样继承自 `LocalBashExecutor`，命令始终以 harness 进程的权限运行。文件写入的拦截交给 userspace-gate 门卫在 `tools/pre-execute` 承担。

## 为什么对外报沙箱模式（有记录的刻意偏离）

官方语义里，`executor.sandboxMode` 是能力事实——"一个**真正会约束**的执行器所采用的默认模式"，`undefined` 表示"此执行器不沙箱"。从不约束却报模式的执行器不是官方形态：官方只有"诚实无约束"（`undefined`）和"真实约束"（内核 runner）两种。

本包仍刻意报出策略默认值，因为在没有可用内核 runner 的主机上，两种官方形态都会崩：

- 内核 runner（`dsh-bash-sandbox`）对每个受约束调用 fail-closed——什么都跑不了。
- 诚实的无约束执行器（`sandboxMode === undefined`）会让 `dsh-permission-presets` 加载即抛（"the mounted bash executor does not confine"），连累 `/permission`、设置预设选择器和升级提示全部失效。

报出模式能让这些面继续工作，真正的约束移到工具层：`userspace-gate` 门卫在 `tools/pre-execute` 拒绝可写根之外的静态写目标（`workspace-write`）和任何写目标（`read-only`）。升级（`sandbox_permissions`）由门卫放行——审批流程仍在工具层。

这是**有文档说明的、对官方能力事实语义的刻意偏离**，不是静默偷工。`sandbox:policy` 上下文贡献仍会向模型陈述真实的按会话模式。

## 插件

一个类执行器（继承 `LocalBashExecutor`）加两个函数插件，作为组合包分发（安装见根 README）。

| 入口 | 插件 | 职责 |
| --- | --- | --- |
| `dsh-userspace-bash` | `UserSpaceBashExecutor`（类，提供 `ctx.shell`） | 从不约束的执行器，把 sandbox-policy 默认值报为 `sandboxMode` |
| `dsh-userspace-bash/readonly-gate` | `readonly-gate` | `tools/pre-execute` 在 `read-only` 下拒绝任何静态 bash 写目标（只放行 shell 流接收器：`/dev/null`、`/dev/stdout|stderr|stdin`、`/dev/fd/0|1|2`） |
| `dsh-userspace-bash/os-denial-guidance` | `os-denial-guidance` | `tools/post-execute` 标记 + 针对 OS 级权限失败（非沙箱拒绝）的系统提示协议 |

### 执行器配置

与 `LocalBashExecutor` 相同 schema（`cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs`），默认值由 Schemastery 补齐。

## Model Experience

### 模型看到什么

本包不添加提示语，也没有自己的 schema。拒绝来自 `userspace-gate` 门卫，带 `[userspace-gate: …]` 标记；OS 级权限失败会被重标记为 `[os-denial: …]` 并附带 sudo 决策协议——**只有失败结果**会被重标记，成功的 `echo "permission denied"` 原样保留。未受约束的调用原样通过。

### Token 影响

受约束或范围外的调用零 token。一次拒绝增加一个小的错误结果，并阻止工具体运行。

### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不使现有 KV-cache 条目失效。

## 已知局限与待办

- **尽力而为，不是安全边界**——门卫只覆盖静态可确定的写目标；动态目标（变量、命令替换、`xargs`、嵌套的非 shell 解释器、`eval`、`source` 的脚本正文、通配操作数、转义命令名）不受管控。内核 runner 仍是权威边界；能拿到就用它（根 README 选项 A）。
- **报出的模式是偏离**——`permission-presets` 会把这个执行器当"会约束"的，按报出的模式推导预设，而实际约束只是工具层的建议性拦截。使用者必须清楚升级面由 userspace-gate 门卫支撑，而非内核。
- **`sandbox_permissions` 升级放行**——门卫放行携带工具层升级参数的调用；审批流程与官方 fence 一样属于工具层。
- **对命令执行无内核约束**——执行器从不约束；绕过 `bash` 走直接 `ctx.subprocess` 或其它 shell 的行为不在本包范围。
