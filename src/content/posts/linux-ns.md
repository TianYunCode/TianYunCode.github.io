---
title: namespace、cgroup 与容器
description: 未实测（本机无 Linux）：六种 namespace 各自隔离什么、cgroup v2 的资源限制树、镜像与 rootfs 的拼装、以及容器里 PID 1 的信号与僵尸问题——"容器跑得对"的底层逻辑。
date: 2026-10-16
tags: [Linux, namespace, cgroup, 容器, Docker]
category: linux
section: linux-ns
---

> **本文性质声明**：本机无 Linux 环境（WSL 被策略拦截），**全部内容未实测**，为手册级框架。站内对照：os-virtualization（特权指令与陷入模拟的概念）、linux-process（进程组与会话）、linux-permission（capability 与容器降权）。

## 一、六种 namespace：容器隔离的积木

容器不是虚拟机——**没有 hypervisor、没有客户内核**，它是同一个内核上的几个"看出去不一样"的进程。这个"看出去不一样"由六种 namespace 拼成：

| namespace | 隔离什么 | 容器里的效果 |
| --- | --- | --- |
| PID | 进程号空间 | 容器内 PID 1 是你的入口进程；`ps` 看不到宿主其他进程 |
| NET | 网络协议栈 | 独立网卡、路由表、iptables、端口（`--network host` 则不隔离） |
| MNT | 挂载点 | 独立文件系统视图 = rootfs |
| UTS | 主机名/域名 | 独立 hostname（`uname -n` 是容器名不是宿主机） |
| IPC | System V IPC、POSIX 消息队列 | 容器间看不到彼此的共享内存/信号量 |
| USER | UID/GID 映射 | **容器内 root（uid 0）可映射成宿主的高 UID**——"容器里是 root 但在宿主上没特权" |

**`unshare`/`nsenter` 是手工玩 namespace 的工具**：`unshare --pid --fork --mount-proc bash` 得到一个"新 PID 空间里的 shell"——**这就是容器的最小原型**（docker run 的本质就是配好六件套再 exec 你）。

排障入口：`ls -l /proc/<pid>/ns/` 看进程各在哪个 namespace；两个进程的 `ns inode` 相同 = 共享该 namespace——**"为什么容器里能看到那个文件/那个进程"先对 inode**。

## 二、cgroup v2：资源限制的树

namespace 管"能看见什么"，**cgroup 管"能用多少"**。v2 是统一层级（v1 的多个子系统挂多棵树的设计被废弃）：

```
/sys/fs/cgroup/
├── system.slice/            # 系统服务（每个 unit 一个子组）
├── user.slice/
└── mycontainer/             # 容器或自建组
    ├── cpu.max              # 配额：周期+额度（如 "100000 100000" = 1 核）
    ├── cpu.weight           # 相对权重（竞争时按比例分）
    ├── memory.max           # 硬上限，超了 OOM killer 找组内进程
    ├── memory.high          # 软限制：超了先回收再限流
    ├── io.max               # 块设备 IO 上限
    └── pids.max             # 进程/线程数上限（防 fork 炸弹）
```

四个实践点：

1. **`memory.max` 触发的是组内 OOM**：内核杀组内占内存最多的进程，**不是整个容器**——"容器自己杀了自己的主进程"的机制在这。
2. **CPU 配额和权重是两种模型**：`cpu.max` 是硬配额（适合限流），`cpu.weight` 是竞争分配（适合公平共享）——**两个都配时配额先生效**。
3. **systemd 自动给每个 service 建组**：`systemctl set-property myservice MemoryMax=512M` 即改即生效，不用写单元文件。
4. **容器运行时的 cgroup 驱动**：dockerd 的 `--exec-opt native.cgroupdriver=systemd` 要和宿主 init 一致，否则出现"两个 cgroup 树互相打架"的灵异现象。

## 三、镜像与 rootfs：分层的拼装

一个容器镜像**不是磁盘快照，是一堆只读层 + 一个可写层**：

```
[可写层]      ← 容器运行时的改动全在这（删文件 = 白障遮盖，层数不减少）
[镜像层 N]    ← COPY/RUN 各产生一层
...
[镜像层 1]    ← 基础发行版
```

联合文件系统（overlayfs 等）把这些层拼成容器看到的单一目录树。四个推论：

1. **层数多 = 打开文件稍慢 + 镜像大**：`RUN` 每条命令一层，能合并的合并（`&&` 串起来），`RUN apt install && rm -rf /var/lib/apt/lists/*` 一层搞定安装和清理。
2. **可写层不随容器删除而评估**：容器删了可写层就没了——**数据要进 volume 或绑定挂载**，写进容器文件系统的都是临时工。
3. **`docker diff <container>`** 看可写层改了哪些文件——"这个容器到底动过什么"的唯一权威答案。
4. **镜像里没有 init 系统**：PID 1 就是你的 `ENTRYPOINT` 进程（或 init 包装如 tini）——第四节的全部问题源于此。

## 四、容器的信号与 PID 1：最经典的坑

PID 1 在 Linux 内核里是**特例**：

1. **默认信号处置对 PID 1 失效**：内核**屏蔽**发给 PID 1 的未注册信号（SIGTERM/SIGKILL 除外）——**你的入口进程不收 SIGTERM，`docker stop` 等 10 秒后 SIGKILL**，优雅退出从来没发生。解法：入口进程**显式注册 SIGTERM handler**，或用 tini/dumb-init 当 1 号把信号转发给子进程。
2. **PID 1 不收尸 = 僵尸蔓延**：普通进程死掉的子进程被 init 收养并 `wait`；**PID 1 的孙子们被你的入口进程收养，而入口进程不 wait 就成了僵尸**——长时间运行的容器里 `ps` 一片 `<defunct>`。解法同上（init 包装），或入口进程自己处理 SIGCHLD。
3. **前台运行是硬要求**：`CMD ["server"]` 而不是 `CMD server &`——**后台化会让 PID 1 立刻退出，容器跟着退出**（"我的容器启动就结束"的第一嫌疑）。
4. **健康检查的语义**：`HEALTHCHECK` 是给编排器（k8s/swarm）看的，和进程活着是两回事——进程活着但不服务的黄灯/红灯状态靠它。

## 五、排障索引

| 症状 | 入口 |
| --- | --- |
| `docker stop` 总要等 10 秒 | PID 1 没注册 SIGTERM（第四节） |
| 容器里一堆僵尸 | PID 1 不收尸；换 init 包装 |
| 容器内存悄悄被 kill | `memory.max` 的组内 OOM；`dmesg` 看 oom-kill 记录 |
| 看不到别的容器/宿主进程 | namespace 隔离正常；要通就得共享 network/pid |
| 容器里 root 还是没权限 | USER namespace 映射 + capability 裁剪（linux-permission） |
| 磁盘只涨不删 | 可写层堆积；进 volume，并 `docker system prune` |

## 七、未实测清单

- 本文所有 namespace/cgroup/容器行为——本机无 Linux 环境，未测。
- overlayfs 的分层行为——未测。
- Docker/containerd 的具体配置项——文档级引用。
- 安全运行时（gVisor/Kata）的隔离级别对比——os-virtualization 概念层提及，未测。
- rootless 容器的 user namespace 细节——未测。
