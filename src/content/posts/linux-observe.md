---
title: 性能观测与调优
description: 未实测（本机无 Linux）：/proc 与 /sys 的关键指标口径、top/vmstat/iostat/sar 的组合读法、perf record/report 与火焰图、以及 USE 方法（利用率-饱和度-错误）的判断框架。
date: 2026-10-16
tags: [Linux, 性能, perf, 火焰图, USE 方法]
category: linux
section: linux-observe
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级框架。站内对照实测：dbg-profiling（采样器原理与 GCC 假负载的教训）、dbg-bottleneck（优化次序的判断，本站有实测）、os-io-stack（Windows IO 栈）。所有命令以你系统的手册为准。

## 一、USE 方法：先分类，再深挖

 Brendan Gregg 的 USE 方法给每个资源问三个问题：

| 维度 | 问题 | 工具示例 |
| --- | --- | --- |
| **U**tilization 利用率 | 资源忙的比例 | `top` 的 %CPU、`iostat` 的 %util |
| **S**aturation 饱和度 | 有多少活儿在排队 | `vmstat` 的 r 列、`iostat` 的 aqu-sz |
| **E**rrors 错误 | 有没有报错 | `dmesg`、`nicestat`、`sar -n EDEV` |

**任何一个资源 = 高利用率 + 高饱和度 + 零错误 = 瓶颈**。USE 的价值是**逼你先定位资源类别**（CPU/内存/磁盘/网络），避免在错误的层雕花——本站 dbg-bottleneck 实测过"同一个优化动作可以是反向的"（加索引让查询慢 6 倍），根因就是没先分类。

## 二、/proc 与 /sys：内核的自查接口

`/proc/<pid>/` 下排障最常用的：

```
status     状态摘要：VmRSS（实际内存）、Threads（线程数）、voluntary_ctxt_switches（主动切换=等 IO）
stack      内核栈（需权限）——看线程卡在内核哪
fd/        打开的 fd（linux-fd 的泄漏排查入口）
io         读写字节数、等待时间
limits     资源限制（nofile 的实测值）

/proc/meminfo    MemAvailable（可分配内存，比 MemFree 有意义）、Dirty/Cached、SwapTotal
/proc/loadavg    1/5/15 分钟负载 = 可运行队列 + 不可中断等待（D 状态）的平均
/proc/interrupts 每 CPU 中断计数（os-interrupt 概念层）
```

`/sys` 是设备与内核参数的结构化视图：块设备队列深度（`/sys/block/sda/queue/nr_requests`）、CPU 调频状态（`cpufreq/`）、网络缓冲（`net.core.rmem_max`）。**排障的口径：先读 /proc 看现象，再决定改 /sys 还是改应用**——调内核参数是最后手段。

## 三、top / vmstat / iostat / sar 的组合读法

**`top`**：`1` 展开每核 CPU（看单核打满还是整体）、`H` 看线程、`i` 开关闲置进程。关注：`us/sy/wa/st`（用户/内核/等 IO/被偷）；`loadavg` 与核数的关系（8 核 load 8 = 满载不是过载）；D 状态的进程（不可中断 IO，**D 状态杀不掉的进程在等磁盘**）。

**`vmstat 1`**：`r`（运行队列，> CPU 核数 = 饱和）、`b`（阻塞）、`si/so`（换入换出，**非 0 就是在换页 = 内存不够）、`cs`（上下文切换速率，`in` 中断速率配合看）、`wa`（IO 等待占比）。

**`iostat -xz 1`**：`%util`（设备忙占比，**但 SSD/RAID 上 %util 会骗人**——并行 IO 下设备忙但队列浅）、`await`（单次 IO 平均等待，**这个才是体感延迟**）、`r/s+w/s`（IOPS）、`aqu-sz`（平均队列长度 = 饱和度）。读法：`await` 高而 IOPS 低 = 随机小 IO；IOPS 高而 util 满 = 顺序吞吐型。

**`sar -A`**（sysstat，历史数据）：`sar -u` CPU、`sar -b` IO、`sar -n DEV` 网卡、`sar -q` 负载。**sar 的价值是回看**——"昨晚 3 点卡的，那时候 CPU 什么样"，当前工具答不了过去。

## 四、perf 与火焰图

**perf 是 Linux 的采样 profiler**（原理见本站 dbg-profiling 的自制采样器——挂起取 PC 的内核版）：

```bash
perf record -g -F 99 ./program      # 99Hz 采样，-g 记调用栈
perf report                          # 交互式报告
perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg   # 火焰图
perf top                             # 实时热点
perf stat -e context-switches,cache-misses ./program            # 计数器
```

火焰图的读法（dbg-profiling 有完整版）：**平顶 = 热点、塔柱 = 调用次数问题、前后对比 = 优化收益**。perf 的三个高级模式对应三类病：`perf sched`（调度延迟）、`perf c2c`（缓存一致性争用，伪共享）、`off-CPU`（等待型瓶颈——**on-CPU 火焰图看不见等待**）。

**权限提示**：容器/云主机上 `perf` 常被 `perf_event_paranoid` 限制，需要特权或 `CAP_PERFMON`；采集不到先查这个，别怀疑工具。

## 五、调优的次序（把 USE 和实测串起来）

1. **先量后用**：没有"之前/之后"的对比，任何调优都是玄学（dbg-benchmark 量过微基准的污染口径）。
2. **分类 → 定位 → 单变量**：USE 定资源类别 → profiler/计数器定热点 → 一次只改一个参数，改完重测。
3. **应用层优先于系统层**：算法、数据结构、查询、锁粒度（dbg-bottleneck 实测：改依赖图比 `-j8` 并行便宜 14 倍 vs 2.6 倍）。
4. **内核参数是最后手段**：改 `vm.swappiness`、`net.core.somaxconn` 一类之前，先确认应用侧没做对——多数"内核问题"是应用把内核逼急了。
5. **记录基线**：每次调优写进变更记录（数值前后对比），否则三个月后没人知道为什么是这个值。

## 六、未实测清单

- 本文所有命令、输出、指标——无 Linux 环境，未测。
- perf 的采集与火焰图生成——未部署。
- sar 的历史回看——未部署 sysstat。
- 换页/内存压缩（zram/zswap）的实测——未测。
- 网络栈调优（BBR、缓冲区）——本站 net-tcp-flow 有 Windows 侧实测，Linux 侧未对比。
