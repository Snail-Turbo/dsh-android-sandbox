# 无内核沙箱主机的 dsh 用户空间沙箱插件

[English](README.md) | 中文

DeepSeek Harness（`dsh`）平时靠**内核级沙箱**把写入限制在工作区里——Landlock / bwrap、文件系统 fence、Seatbelt、Windows ACL runner。如果你的设备内核沙箱正常，**你不需要这个仓库**，官方沙箱已经够了。

这个仓库面向那些 runner **跑不起来或只能部分生效**的主机——最常见的是 bootloader 锁定（或不想解锁）的 Android GKI 手机，以及没有 user namespace 或 Landlock 的受限容器 / chroot 环境。这类主机上 **bash 内核 runner** 会 fail-closed：每个受约束的 bash 调用都被拒。（write/edit 的文件系统 fence 是进程内路径围栏，仍然工作；真正的缺口在 shell 执行。）这里的插件在工具调用层为两者补上*用户空间*的替代。

## Android 上拿真实沙箱的两个选项

如果你的 Android 设备没有可用的内核沙箱，有两个选项。

### 选项 A — 解锁 bootloader，编一个配置正确的 GKI 内核（推荐）

如果*能*解锁 bootloader，正路是在内核配置里打开 dsh runner 需要的特性（Landlock LSM、user namespace 等），**自己编一个启用了这些特性的谷歌 GKI 内核**。换上之后 `dsh-bash-sandbox` 和 `dsh-fs-sandbox` 正常约束，那才是真正想要的内核级边界。

**能解锁就走这条路。** 本仓库的插件是用户空间策略——兜底用的，不是安全边界。

### 选项 B — 不能或不想解锁：用这套用户空间插件

不能或不想解锁 bootloader，就把本仓库这两个插件加进你的组合。它们一起在工具调用层恢复官方沙箱的 workspace-write / read-only 约束，不需要任何内核特性。

| 包 | 职责 |
| --- | --- |
| `dsh-userspace-gate` | `tools/pre-execute` 门卫——`workspace-write` 沙箱的纯用户空间替代：拒绝 `write`/`edit` 调用，以及**静态可见**写目标落在会话工作区和平台临时目录之外的 bash 调用；顺带为 shell 工具实施 read-only。不需要任何内核特性。 |
| `dsh-userspace-bash` | 面向无可用内核 runner 主机的 `bash-local` 孪生：对外报一个沙箱模式（好让权限预设和 `sandbox_permissions` 升级面继续能用），但实际上不约束——文件写入的拦截交给 userspace-gate 门卫。 |

> **关于所报沙箱模式的说明。** `userspace-bash` 报出一个沙箱模式，但没有内核级约束。这是对官方能力事实语义的刻意偏离：在无内核主机上，官方两种形态都会崩——内核 runner 对每个受约束调用 fail-closed，而诚实无约束的执行器（`sandboxMode === undefined`）会让 `dsh-permission-presets` 加载即抛。报出模式让 `/permission`、预设选择器和 `sandbox_permissions` 升级面继续可用，实际约束由 `userspace-gate` 门卫在工具层执行（静态扫描，非内核）。

## 局限

- **只能拦住静态看得见的写目标，这不是安全边界。** 静态能确定的写目标会被拦（重定向目标、变更类命令的操作数、已知选项值、交给 shell 的 heredoc 正文）；动态目标——变量、命令替换、`xargs`、嵌套的非 shell 解释器、`eval`、`source` 的脚本文件内容、通配操作数（`rm -rf /etc/*`）、`\cp` 这类转义命令名——直接放行。
- **所报沙箱模式是偏离**——见上文说明；`permission-presets` 会把这个执行器当"会约束"的，而一次被批准的 `sandbox_permissions` 升级会让命令以 harness 全权限运行（执行器从不约束；门卫只做静态拦截）。
- 内核 runner 才是对不可信代码真正算数的边界。能拿到（选项 A）就用它。

## 平台支持

`userspace-bash` 的执行器行在 win32 自动禁用（bundle 补丁里的 `!!js process.platform === 'win32'`）：dsh-base 组合在 win32 挂 `pwsh-sandbox`，两个 `ctx.shell` 提供者会让启动因重复注册而失败。本仓库面向 POSIX 主机（Android、Linux、macOS）。

## 仓库结构

```
android-sand-box/
├── userspace-gate/               # tools/pre-execute 门卫 + bash 写意图扫描器
└── userspace-bash/               # 从不约束的 bash 执行器 + read-only 门卫 + 拒绝引导
```

两个包都是**组合包（bundle）**：各自在 `dsh.bundle` manifest 下自带 `cordis.patch.yml`，装一个就自动激活对应插件行——**无需手动改 `cordis.patch.yml`**。把两个都装进 profile：

```sh
dsh plugin --profile web add ./userspace-bash
dsh plugin --profile web add ./userspace-gate
```

`dsh-userspace-bash` 组合包会把内核版 `bash-sandbox` 换成用户空间执行器，并挂上 read-only 门卫和拒绝引导；`dsh-userspace-gate` 组合包挂上 workspace-write 门卫。卸载用 `dsh plugin --profile web remove <名字>`。两个包都把构建好的 `lib/` 提交在仓库内，git 安装无需构建步骤。

## 许可证

MIT
