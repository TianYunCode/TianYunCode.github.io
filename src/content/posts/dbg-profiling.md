---
title: 性能观测：采样、火焰图与系统层
description: 实测：自建 PC 采样器量出三热点 59.9%/33.8%/6.2%（理论 62.5/31.2/6.2）；GCC 把 noinline 纯函数调用提出循环造成假快 2000 倍；gprof 在 MinGW 输出空表。
date: 2026-10-16
tags: [调试, 性能, 采样, 火焰图, profiler]
category: debug-perf
section: dbg-profiling
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64）**，`-O2 -g`，探针 `%TEMP%/dbg3s_*` 与 `.tmp-scan/sampler.cpp`。**本机没有 Linux**：`perf`、`off-CPU` 分析、`/proc` 系工具**未实测**，第四至六节为文档级框架；第二、三节是本文自建采样器的实测。所有采样数字在同机可复现（±3 个百分点，见第二节）。

## 一、采样与插桩：profiler 的两种世界观

| | 采样（sampling） | 插桩（instrumentation） |
| --- | --- | --- |
| 做法 | 周期性中断/挂起，记录 PC | 每个函数入口出口插计数器 |
| 开销 | 低（1–5%），可上生产 | 高（2–10 倍），只配开发期 |
| 输出 | "时间花在哪"（统计） | "调了多少次、每次多久"（精确） |
| 盲区 | 采样间隙的短函数可能漏 | 被内联的函数看不见 |
| 代表 | perf、VTune、ETW 采样、本文探针 | gprof（函数级）、valgrind --tool=callgrind |

**选型规则**：先采样找热点（"哪个函数/哪条路径在烧"），再插桩问细节（"它被调了多少次、谁调的"）。反过来做——一上来就跑 callgrind——会被开销和噪音埋掉。**dbg-benchmark 那节的 QPC 手动计时是第三种（主动插桩）**：精度最高但只能测你预先想到的地方，适合验证假设，不适合发现热点。

## 二、本文的采样器：挂起线程，拿 RIP

perf 的原理是定时中断读 PC；Windows 上没有 perf，但可以用调试 API 做等价的事：**周期性 `SuspendThread` + `GetThreadContext` 拿 `Rip`，然后按函数归属统计**。探针骨架（sampler.cpp）：

```cpp
HANDLE th = CreateThread(nullptr, 0, load_thread, nullptr, 0, nullptr);
for (int i = 0; i < 2000; i++) {
    if (WaitForSingleObject(th, 0) == WAIT_OBJECT_0) break;  // 负载结束就停
    SuspendThread(th);
    CONTEXT ctx; ctx.ContextFlags = CONTEXT_CONTROL;
    if (GetThreadContext(th, &ctx)) hits[ctx.Rip]++;          // 记 PC
    ResumeThread(th);
    // QPC 忙等 200µs（Sleep 的粒度是 15.6ms，见 qt-event 那节）
}
```

负载是三个 `noinline` 函数，迭代次数比 10:5:1。**理论占比** heavy 62.5% / medium 31.2% / light 6.2%。实测（2000 次采样，400 ms，间隔 200 µs，覆盖率 100%）：

```
heavy   59.9%  (1197/2000)   理论 62.5%  差 -2.6
medium  33.8%  (676/2000)    理论 31.2%  差 +2.6
light    6.2%  (124/2000)    理论  6.2%  差  0.0
```

**±3 个百分点内的吻合**说明三件事：采样方法本身有效；200 µs 间隔对毫秒级函数够用；**"其他"只占 0.1%**（3/2000，落在运行时启动代码里）说明挂起/恢复没有把采样本身变成热点。

四个实现细节，每个都踩过：

1. **不能用 `Sleep` 控间隔**：Windows 定时器粒度 15.6 ms（qt-event 实测），200 µs 间隔必须 QPC 忙等。忙等要 `YieldProcessor()`，别让采样线程把负载线程饿死。
2. **符号解析在本机是残废的**：MinGW 产物带 DWARF，而 Windows 的 `dbghelp`（`SymFromAddr`）只认 PDB——系统 DLL 的符号全能解析（`RtlUserThreadStart`、`LdrUnloadDll` 都出来了），自己的函数全是 `??`。解法是探针里**记函数入口地址、按区间归属**（本文做法）；正解是发布产物归档 PDB。
3. **负载线程会先退出**：采样前查 `WaitForSingleObject(th, 0)`，线程没了就停，否则 `SuspendThread` 一个死线程拿到一堆无效样本。
4. **`-O2` 会背叛你**——见第三节，这是本文最贵的教训。

## 三、抓包现场：GCC 把"负载"提出了循环

采样器第一版跑出来一个诡异结果：三个函数总共只占 15%，负载线程 0.6 ms 就跑完了"2000 轮 × 32 万次迭代"。反汇编 `load_thread` 抓住了现行：

```
call <_Z5heavyi>      ← 循环外，只调一次
call <_Z6mediumi>     ← 循环外
call <_Z5lighti>      ← 循环外
loop:                 ← 循环里只有 g_sink += 上面存下来的三个值
```

**GCC 把三个 `noinline` 函数识别为纯函数（无副作用、只依赖参数），把调用整个提升出了循环**——2000 次相同参数的调用变成 1 次。`__attribute__((noinline))` 只阻止"把函数体搬进调用者"，**阻止不了"把调用搬出循环"**（loop-invariant code motion + const 函数属性）。这和 dbg-benchmark 那节的"结果丢弃的循环被优化成一条 `ret`"是同一族问题：**微基准里"被测代码还在吗"永远是第一个要证明的事**。

修法：**让参数每轮变化**（`heavy(200000 + i)`），调用结果不再循环不变，提升被阻止。修改后的采样分布立刻和理论吻合（第二节数字）。

顺带一个相关实测：探针最早用 `for (i…) s += i % 7` 做负载，**GCC -O2 把 6.4 亿次取模求和闭式化了**——单独计时 0.7 ms 跑完。所以性能探针的负载要么用数据依赖链（xorshift，每步依赖上一步），要么读内存数组，**别用可求和公式的循环**。

## 四、火焰图怎么读（文档级）

采样数据的标准可视化是**火焰图**（Brendan Gregg）：x 轴是采样占比（按字母排序，**不表示时间**），y 轴是调用栈深度，每个矩形是一个栈帧，**宽 = 该帧出现的采样比例**。

读法四步：

1. **看平顶（plateau）**：顶部的宽帧就是热点函数——它自己（不含子调用）烧掉了那么多 CPU。
2. **看塔柱**：从底到顶一条细线插到很深，是"调用链长但每层不热"——瓶颈在调用次数，不在单次成本，治法是减少调用（合并、缓存）。
3. **对比两幅图**：优化前后各采一幅，变窄的帧就是收益。**没有前后对比的火焰图只是壁纸**。
4. **反向火焰图（icicle）从根开始长**：看"谁调用了热点"更直观；正向（火焰）看"热点在等什么"。

生成链路：`perf record -g` → `perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg`（Linux）。Windows 等价物是 WPA 的 Flame by CPU 图（第二节的采样数据同样可以导出成这个格式，只是要自己写折叠脚本）。

## 五、off-CPU：火焰图看不见的另一半

on-CPU 火焰图回答"CPU 花在哪"，但**卡顿 often 是 CPU 空闲**——在等锁、等 IO、等定时器。**off-CPU 分析**记录线程"不在 CPU 上"时的栈：

- 采集：`perf record -e sched:sched_switch --call-graph` 或 bpftrace 的 `offcputime`。
- 读法：off-CPU 火焰图的宽顶 = 等待点。等锁的宽帧指向某把锁；等 IO 的指向 `read`/`epoll_wait`。
- **和 on-CPU 图对照**：on-CPU 平顶是"算得久"，off-CPU 平顶是"等得久"。数据库慢查询、锁竞争、同步磁盘写的病只在 off-CPU 图上显形。

本文未实测 off-CPU（无 Linux）。Windows 侧的对应思路：ETW 的线程状态事件 + WPA 的 "CPU Usage (Precise)" 视图能看到线程在 Wait/Ready/Deferred 各态的分布（文档级，未测）。

## 六、系统级观测：四类资源的信号（文档级 + 本站实测引用）

单进程 profiler 看不到全貌，系统层四类资源各有信号：

| 资源 | Linux 信号 | Windows 对应 | 本站实测引用 |
| --- | --- | --- | --- |
| CPU | `top`/`vmstat` 的 us/sy/wa | 任务管理器/typeperf `% Processor Time`/`% Privileged Time` | os-scheduling（优先级实测）、dbg-bottleneck（编译并行度） |
| IO | `iostat` 的 await/svctm、`bio` 延迟 | 资源监视器/`typeperf PhysicalDisk` | os-io-stack（直读 vs 缓冲 10.5 倍）、dbg-bottleneck |
| 网络 | `ss -i` 看重传/RTT、`sar -n DEV` | `netstat -s`、性能计数器 TCPv4 | net-tcp-flow（调谐窗口实测） |
| 锁/调度 | `/proc/locks`、`/proc/pid/stack`、runqueue 延迟 | ETW 上下文切换事件 | conc-mutex（锁单价）、win-thread-sync（临界区 vs 互斥体） |

判断次序沿用 dbg-bottleneck 的实测结论：**先判类别（IO/CPU/锁/数据布局），再动具体对象**。类别判错的代价那节量过——"同一个优化动作可以是反向的"（加两个索引让查询慢 6 倍）。

## 七、未实测清单

- `perf` 全家（record/report/flamegraph）、off-CPU 采集——无 Linux 环境。
- WPR/WPA/ETW 会话——本机未采集（win-debug-perf 那节同款声明）。
- gprof：本机 MinGW **编译运行正常（`gmon.out` 14976 字节）但 flat profile 输出空表**——Windows 上 gprof 的 PC 采样通道不工作，别在它身上花时间；本文第二节的自建采样器是替代路线。
- Intel VTune、VerySleepy 等 GUI profiler——未安装。
- 采样开销本身（挂起/恢复对被测线程的影响）——未单独量化；从"其他 0.1%"看在本负载下可忽略。
