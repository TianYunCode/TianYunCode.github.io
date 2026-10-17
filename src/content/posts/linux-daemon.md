---
title: 守护进程与服务化
description: 未实测（本机无 Linux）：双 fork + setsid 脱终端的每一步理由、pid 文件与幂等启动、systemd unit 的 Type 选型与日志接入 journald、优雅退出与 SIGHUP 热加载的标准实现。
date: 2026-10-16
tags: [Linux, 守护进程, systemd, 服务化, SIGHUP]
category: linux
section: linux-daemon
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级框架。相关引用：linux-process（进程组/会话/控制终端）、linux-signal（信号语义与 self-pipe）、engineering-version-release-and-rollback（发布的灰度与回滚）。

## 一、经典双 fork：把自己变成守护进程

```c
pid_t pid = fork(); if (pid > 0) _exit(0);   // 父进程退出 → 子进程被 init 收养
setsid();                                    // 新会话：脱离控制终端，防 SIGHUP
signal(SIGHUP, SIG_IGN);                     // 忽略挂断（now session leader 收不到终端信号）
pid = fork(); if (pid > 0) _exit(0);         // 二次 fork → 不再是会话首领，永不再 acquiring 终端
chdir("/");                                  // 不占住挂载点
umask(0);                                    // 文件权限全权自己控制（或设 022）
close(0); close(1); close(2);                // 关掉继承的标准流
// 重开 /dev/null 或日志到 0/1/2（否则库函数写 stderr 会到已关的 fd）
```

每一步的理由（顺序错了会漏）：**第一次 fork + 父退出**保证子进程不是进程组首领（setsid 的前提）；**setsid** 脱离控制终端——不断终端断开时的 SIGHUP；**第二次 fork** 让自己永远不可能再 acquiring 一个控制终端（会话首领才能 acquiring，故意不当）。现代实践：**直接让 systemd 干这些**（`Type=notify` + `systemd` 管理会话），手写双 fork 只在没有 init 系统的嵌入场景用。

## 二、pid 文件与幂等启动

pid 文件的老问题（竞态、崩溃残留假 pid、被别的进程占用）现代都用 systemd 解决了，但自己写启动脚本时仍要会：

```bash
PIDFILE=/run/myservice/myservice.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
    echo "已在运行 (pid $(cat $PIDFILE))"; exit 0     # 幂等：重复启动不炸
fi
echo $$ > "$PIDFILE"                                  # $$ = 本脚本进程
trap 'rm -f "$PIDFILE"' EXIT                          # 退出时清理
```

**幂等启动的三条**：启动前查活（`kill -0` 比读文件可靠——文件可能残留）；pid 文件放 `/run`（tmpfs，重启自动清）不放 `/var/run` 的老软链坑；退出必须清理（`trap` 覆盖 EXIT/TERM/INT）。**残留 pid 文件的正确删除时机是"确认该 pid 不是自己人之后"**——无脑 rm 会让两个实例都跑起来（第二个以为没人在跑）。

## 三、systemd unit：Type 的选型

```ini
[Unit]
Description=My Service
After=network.target

[Service]
Type=notify                    # 见下表
ExecStart=/usr/local/bin/myservice
Restart=on-failure             # 退出码非 0 才重启
RestartSec=5                   # 重启间隔（防崩溃风暴）
User=myservice                 # 降权运行
NoNewPrivileges=yes            # 禁 setuid 提权
ProtectSystem=strict           # 只读文件系统 + 白名单可写

[Install]
WantedBy=multi-user.target
```

**Type 五选一**：

| Type | systemd 认为"启动完成"的时机 | 适用 |
| --- | --- | --- |
| `simple`（默认） | ExecStart 的进程 fork 出来就算 | 简单的前台程序 |
| `exec` | exec 成功（比 simple 多查一个错误） | 多数现代程序 |
| `forking` | 父进程退出（经典双 fork 守护进程） | 老式守护进程 |
| `notify` | 程序调 `sd_notify(READY=1)` | **推荐**——精确知道服务真的就绪了 |
| `oneshot` | 进程退出 | 一次性任务（RemainAfterExit=yes 让 systemctl status 显示 active） |

选错 Type 的症状：`forking` 配一个不前台的进程，systemd 永远认为没起来；`simple` 配启动慢的程序，依赖它的服务在它还没监听时就启动——连接被拒。**`notify` 依赖库的一行 `sd_notify`，收益是启动顺序全对**。

## 四、日志接入 journald

进程写 stdout/stderr，systemd 自动收进 journal——**比 syslog 简单且带结构化元数据**：

```bash
journalctl -u myservice -f              # 跟服务
journalctl -u myservice --since today -p err
journalctl _PID=1234 --since "10 min ago"
```

三条实践：日志走 stderr 别自己写文件（systemd 管轮转和集中）；需要文件输出的用 `StandardOutput=file:/var/log/...`；**日志级别用 `LogLevel=` 或在程序里分级打**——`journalctl -p err` 只捞错误的体验远超 grep 全文。

## 五、优雅退出与 SIGHUP 热加载

**优雅退出**的标准三件套（linux-signal 的展开）：SIGTERM handler 置标志 → 主循环在安全点退出 → 收尾（flush 日志、关监听、等 in-flight 请求）。systemd 的 `TimeoutStopSec`（默认 90s）给收尾时间，超了才 SIGKILL——**收尾慢于 90s 要么加快要么调大，别让它被 KILL**。

**SIGHUP 热加载**的经典语义："重新读配置，不退出"：

1. SIGHUP → 置 `reload_requested` 标志（handler 里只做这个，self-pipe/signalfd 转事件）。
2. 主循环在迭代边界检查标志：读新配置 → 校验 → **只替换能安全替换的部分**（打开新监听 fd、换后端连接池）→ 旧的用完再关。
3. **校验失败必须继续用旧配置并告警**——"热加载把服务搞挂"比"不热加载"严重得多。

systemd 侧 `ExecReload=/bin/kill -HUP $MAINPID`，然后 `systemctl reload`。配置校验逻辑（新配置解析成功才替换）是热加载的灵魂，和 engineering-refactor 的"行为保持的验证方法"同一思想。

## 六、排障索引

| 症状 | 入口 |
| --- | --- |
| 服务反复重启 | `journalctl -u` 看退出码；`RestartSec` 太小会崩溃风暴 |
| 手动能跑 systemd 跑不了 | 环境差异：`systemctl show -p Environment`；`ProtectSystem` 挡住了写路径 |
| 升级后旧进程还在 | `Type` 选错；或 PID file 残留让新实例误以为有人在 |
| 停止慢/被 KILL | 收尾超过 `TimeoutStopSec`；查 handler 是否真的在跑 |
| 日志丢失 | 程序写自己的文件而 systemd 只收 stdio；或 journald 的 `RateLimitBurst` 限流了 |
| 依赖服务启动顺序错 | `After=` 只管顺序不管就绪；要就绪语义用 `Type=notify` |

## 七、未实测清单

- 本文所有 systemd 行为与 unit 语义——本机无 systemd，未测。
- 双 fork 的实际效果——无 Linux，未测。
- socket activation（`LISTEN_FDS` 传 fd，linux-ipc 提过 SCM_RIGHTS 的同族机制）——未测。
- systemd 的 cgroup 资源限制（CPU/MemoryMax）——linux-ns 概念层，未测。
