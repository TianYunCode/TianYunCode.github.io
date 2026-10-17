---
title: Windows 侧调试与性能
description: 实测：泄漏 1000 个 Pen 后 GDI 计数精确到 1000、500 个 Event 后内核句柄 128→628，清理后归位；WinDbg 与 ETW 未实测。
date: 2026-10-16
tags: [Win32, 调试, 句柄泄漏, GDI, 性能观测]
category: win32
section: win-debug-perf
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64）**，`-O2`，链接 `-lpsapi -lgdi32 -luser32`，探针 `%TEMP%/win3d_*/h.cpp`。**本机没有 WinDbg、没有 WPA/xperf、没有 ETW 采集器**——第一、二节的 WinDbg/ETW 内容为文档级知识，**未实测**；第三、四节的句柄与 CPU 时间读数全部实测。所有计数类结论在同一系统可复现。

## 一、WinDbg 与符号（文档级，未实测）

现场分析的正规军是 WinDbg（或 WinDbg Preview）。文档级框架：

- **三条命令起步**：`.symfix`（设符号服务器）+ `.reload`（加载符号）→ `!analyze -v`（自动分析当前异常，给出调用栈和可疑帧）→ `k`/`kb`（看栈）。dump 文件用 `File → Open Crash Dump` 或 `windbg -z memory.dmp`。
- **符号是命根子**：`SymFromAddr` 解析不了地址时，栈上只剩 `modul+0x1234` 这种偏移。微软公开符号服务器（`.symfix` 自动配）+ 自己的 PDB 是底线；strip 过的发布产物要**单独归档 PDB**（eng-release 那节提过符号归档）。
- **常用扩展**：`!handle`（句柄表）、`!gflag`、`!peb`、`!teb`、`!locks`（锁链）、`!runaway`（哪个线程烧 CPU）。dbg-crash 那节从用户态侧量过 MinGW dbghelp 的 `Sym*` 对 `-g0` 产物 0 命中的现象——**调试信息编不进二进制，WinDbg 也变不出符号**。
- **实时调试 vs 事后 dump**：`procdump -ma -e process.exe`（Sysinternals）配 WER 本地 dump 是生产环境抓现场的标准姿势，比装 WinDbg 实时挂着轻。

**未实测声明**：以上命令行为、输出格式未在本机验证（无 WinDbg）。

## 二、ETW 与 xperf 看卡顿（文档级，未实测）

Windows 的性能采集主干是 **ETW（Event Tracing for Windows）**：内核和应用程序发事件，采集器（`xperf`/WPR/`tracelog`）记录，WPA 分析。文档级框架：

- **抓**：`wpr -start CPU -start DiskIO -start FileIO` 跑负载，`wpr -stop trace.etl`。
- **看**：WPA 里关注三类图——CPU 采样（哪个函数在烧，对应火焰图）、磁盘/文件 IO（等待构成）、**上下文切换**（哪个线程在等谁）。**卡顿的本质是"等待构成"**：CPU 不高但界面卡，九成是在等锁、等 IO、等 GPU。
- **轻量替代**：没有 WPA 时，`typeperf`（性能计数器命令行）、任务管理器、资源监视器能回答 80% 的"是不是 CPU/磁盘/网络哪一类满"的问题——**先分类再上重型工具**，和 dbg-bottleneck 那节的判断次序一致。

**未实测声明**：WPR/WPA/ETW 会话未在本机运行。

## 三、句柄与 GDI 泄漏：计数器的实测读法

这是本文唯一实测的部分，也是 Windows 排障里性价比最高的：**句柄泄漏不会让进程立刻死，但会在若干小时后莫名其妙地创建失败**。三个计数器，一个探针全测了：

```
基线:            GDI=0  USER=2  内核句柄=128
泄漏 1000 Pen:   GDI=1000（精确 +1000）
泄漏 500 Menu:   USER=502（精确 +500）
泄漏 500 Event:  内核句柄=628（精确 +500）
清理后:          GDI=0  USER=2  内核句柄=128（全部归位）
```

对应的 API 与读法：

| 计数器 | API | 泄漏什么时会涨 |
| --- | --- | --- |
| GDI 对象 | `GetGuiResources(p, GR_GDIOBJECTS)` | `CreatePen`/`CreateBrush`/`CreateCompatibleBitmap` 后没 `DeleteObject` |
| USER 对象 | `GetGuiResources(p, GR_USEROBJECTS)` | `CreateMenu`/`CreateWindow` 后没销毁 |
| 内核句柄 | `GetProcessHandleCount(p, &n)` | `CreateEvent`/`CreateFile`/`CreateThread` 后没 `CloseHandle` |

三个实践结论：

1. **泄漏是精确可数的**：1000 个没释放的 Pen 就是 GDI 计数 +1000，没有模糊地带。所以"疑似泄漏"的验证方法不是猜，是**挂机前后各读一次计数器，差值就是泄漏速率**——每小时 +50 个 GDI 对象，20 万配额（USER/GDI 每进程各 10000，win-handle-message 那节实测过配额耗尽时报什么错）也够你算出还能活几小时。
2. **控制台程序也有 USER/GDI 对象**：基线 USER=2 来自控制台本身。别以为"我没窗口就没这些计数器的事"。
3. **内核句柄数包含线程**：每个线程恰好占 1 个句柄（win-thread-sync 那节实测过），线程池不回收时这个计数器会持续涨——**看计数器先排除"线程在涨"，再查真泄漏**。

排障套路：任务管理器"详细信息"页加"句柄数/GDI 对象/用户对象"三列，挂机一夜看斜率；或者用本文探针的思路在自己的程序里加自监控（每分钟打一次三个计数，超过阈值告警）。

## 四、线程 CPU 时间与工作集：任务管理器列的正确读法

实测本线程与进程：

```
本线程 CPU 时间: 内核 171875 us + 用户 31250 us
工作集: 10,690,560 B（峰值 11,833,344 B），页错误数 53,750
```

四个列的正确读法（任务管理器显示的就是这些数）：

1. **CPU 时间是累计值不是实时值**。要看谁在烧 CPU，隔 5 秒读两次做差，或者用性能计数器（`% Processor Time` 是采样）。线程级要 `GetThreadTimes`（本文实测的）或 WPA。
2. **工作集（WorkingSet）≠ 进程占的内存量**。它是"当前驻留物理内存的页"，会被系统随时裁剪（trim）——**工作集变小不代表程序释放了内存**，可能只是页被换出了。真实占用看 `PrivateUsage`（`GetProcessMemoryInfo` 的 `PrivateBytes`），dbg-memory 那节量过"交错释放后 private 一个字节没降"的现象。
3. **页错误数（PageFaultCount）只涨不停要看结构**：启动期几千次正常（按需分页，os-virtual-memory 那节量过首触碰 466 ns/页）；运行期持续上涨说明在反复触碰不在工作集的页——**内存踩踏或工作集被裁**的信号。
4. **"内存不降"的三段论**：私有没降 + 堆里空块多 = 碎片（dbg-memory 实测过 550 万字节碎成 5 万块）；私有降了但工作集没降 = 页缓存还没裁；两个都没降 = 真有引用挂着（泄漏）。

## 五、未实测清单

- WinDbg 全链路（命令、扩展、dump 分析）——无 WinDbg，未测。
- WPR/WPA/ETW——未采集，未测。
- 应用程序向 ETW 发自定义事件（`TraceLogging`/`EventWrite`）——未测。
- GDI/USER 配额耗尽时的进程行为（只引用了 win-handle-message 的实测，本文未复现）。
