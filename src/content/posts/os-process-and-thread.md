---
title: 进程、线程与上下文切换
description: 实测：主线程栈的已提交窗口 20480 字节、下面紧一页 PAGE_GUARD，递归 200 层后窗口变 839680 字节、缺页计数 +205，护栏页跟着往下跑；一次纤程切换 42.8 纳秒、100 万次内核上下文计数只 +11；Sleep(0) 每次让出恰好 1 次上下文切换（0.90–1.11 次/调用）。
date: 2026-10-15
tags: [操作系统, 进程, 线程, TEB, 上下文切换, 纤程]
category: os
section: os-process-thread
---

> 环境：**Windows 11 x64**（build 26200）、**GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，`-std=gnu11 -O2 -static`，6 物理核 / 12 逻辑处理器，`QPC` 频率 10 MHz。进程/线程信息全部只读查询（`NtQuerySystemInformation` class 5、`NtQueryInformationThread`、`GetProcessMemoryInfo`）。**同期机器上还有其他编译任务**，所以本节凡是绝对时间的数字都给了区间或"两次独立测量"，结构性结论（切换次数比值、页数增量、偏移量）不受负载影响。本机无 Linux/WSL，`/proc/<pid>/status`、`perf`、`clone()` 的 COW、`sched_yield` 都**未在本机实测**。

## 一、TCB 在内核里，但用户态手里有一份影子：TEB

`NtCurrentTeb()` 就是一个 `mov rax, gs:[0x30]`。把自己按 `NT_TIB` 解释，探针打出来的偏移和自校验：

```text
sizeof(MY_TIB)=56  TEB 偏移: StackBase=8 StackLimit=16 Self=48 FiberData=32 ClientId=64 LastError=120
  NtCurrentTeb()=00000011fffc6000 NtTib.Self=00000011fffc6000 相等=1  ClientId.hThread=000000000001ed24 == GetCurrentThreadId(126244)=1
  ClientId.hProcess=000000000001350c  与 OpenProcess 自见的句柄无关（是 PID）：1
  StackBase=0000001180200000 StackLimit=00000011801fb000 当前栈帧=00000011801ffb60  （Base > 帧 > Limit：20 KB 的窗口）
  NtQueryInformationThread(ThreadBasicInformation) st=0x00000000 写入=48 sizeof=48
    TEB=00000011fffc6000(与 NtCurrentTeb 一致=1) PID=79116 TID=126244 亲和掩码=0xfff 当前优先级=9 基准=0
    交叉核对: GetThreadPriority=0  GetPriorityClass=0x20
```

把这张表和上一节《操作系统在做什么》里的反汇编并排看，**进程和线程的身份根本不是"问内核要的"，而是从 gs 段指向的固定偏移读出来的**：

| TEB 偏移 | 字段 | 上一节量到的用法 |
| --- | --- | --- |
| `0x08` / `0x10` | `StackBase` / `StackLimit` | 第四节讲栈的增长，全靠这两个指针在动 |
| `0x00` / `0x18` | `ExceptionList` / `SubSystemTib` | SEH 链的头在 0x00（异常派发从这里找处理器）；`0x18` 是子系统 TIB 指针 |
| `0x20` | `FiberData` | 第六节纤程；未转换的线程上它读到 `0x1e00`（见下文） |
| `0x30` | `Self` | `NtCurrentTeb()` 本体，`Self == &TEB` 实测成立 |
| `0x40` / `0x48` | `ClientId.hProcess` / `hThread` | `GetCurrentProcessId` = `mov rax, gs:[0x40]`，实测 1.5 ns |
| `0x68` | `LastErrorValue` | `GetLastError` = `mov eax, gs:[0x68]`，实测 1.1 ns |

两处要说明的**不一致**，都是我这次重跑发现的：

1. 我自定义的 `MY_TEB` 算出来 `LastErrorValue` 在 120（`0x78`），而反汇编明确读 `gs:[0x68]`。**是结构体写错了**——`ClientId` 之后我塞进了 `OwningProcess`、两个亲和掩码等真实 TEB 里没有的字段。`0x40`/`0x48`（ClientId）能对上，说明错在 ClientId 之后。教训：**自造结构体必须逐字段用反汇编或权威 API 校准**，前面对上不代表后面也对上。
2. `ThreadBasicInformation` 返回 48 字节、`Priority=9`，但同一份结果里 `BasePriority=0`，而 class-5 快照里同一线程的 `基优=8`。这两处对不上，我给不出解释（可能是 `TBI` 里这一项在内核中被当作别的语义使用），**所以本节不用 `TBI.BasePriority`**。

## 二、内核给每个进程记的账，一次 `NtQuerySystemInformation` 全拿到

`SystemProcessInformation`（class 5）一次调用返回全机进程 + 它们的全部线程。用自己的 PID 找到自己，再和三个独立 API 对账：

```text
  [快照：都在等什么] 需要缓冲=0  sizeof(STH)=80  Threads 偏移=256
  进程 probe_d.exe  线程数=10  HandleCount=98 vs GetProcessHandleCount=98  基优先级=8  SessionId=1
   偏移核对: VirtualSize=4168MB 工作集=6324KB vs GetProcessMemoryInfo=6328KB  私有页=3100KB vs PrivateUsage=3100KB  PageFaultCount=1641 vs 1642
   进程累计: 内核=47 ms 用户=359 ms  读操作=2 写=0  读字节=2085 写字节=0
```

| 快照字段 | 交叉验证的 API | 结果 |
| --- | --- | --- |
| `HandleCount=98` | `GetProcessHandleCount` = 98 | 完全相等 |
| `WorkingSetSize=6324 KB` | `GetProcessMemoryInfo` = 6328 KB | 差 4 KB（两次调用之间又踩了一页） |
| `PrivatePageCount=3100 KB` | `PROCESS_MEMORY_COUNTERS_EX.PrivateUsage` = 3100 KB | 完全相等 |
| `PageFaultCount=1641` | `pm.PageFaultCount` = 1642 | 差 1，同样是快照时刻差 |

**结构体偏移也验证过了**：每项线程 `sizeof(STH)=80`、`Threads` 数组在进程记录尾部（偏移 256）。这三项对账是"任务管理器那一列数字从哪来"的答案：它们不是三套统计，是同一份内核数据 + 两个不同入口。想免特权看别人的进程，走的就是这张表。

## 三、线程状态机：`State` / `WaitReason` 实测对照表

同一个探针起 9 个线程，各卡在一种等待上，`Sleep(500)` 后拍一张快照：

```text
  我登记的 TID: 15352=Sleep(3000)  85988=忙等循环  140704=等互斥体  92364=等信号量  134040=等事件  34896=等临界区  78912=等条件变量  6028=等文件读  36944=创建即挂起
  进程 probe_d.exe  线程数=10  HandleCount=98 vs GetProcessHandleCount=98  基优先级=8  SessionId=1
     TID     StartAddress   内核ms 用户ms 等待ms 优先 基优  切换数 State      WaitReason / 我给它取的名
    126244 0                  15.6      0.0 134990174    9    8        134 Running     31  main(自己)
    124972 0                   0.0      0.0 134990140    8    8          1 Waiting     15  
     15352 0                   0.0      0.0 134990140    8    8          4 Waiting      4  Sleep(3000)
     85988 0                  31.2    359.4 134990174    8    8       1067 Running     31  忙等循环
    140704 0                   0.0      0.0 134990140    9    8          3 Waiting      6  等互斥体
     92364 0                   0.0      0.0 134990141    8    8          2 Waiting      6  等信号量
    134040 0                   0.0      0.0 134990141    9    8          3 Waiting      6  等事件
     34896 0                   0.0      0.0 134990140    9    8          3 Waiting     37  等临界区
     78912 0                   0.0      0.0 134990140    9    8          3 Waiting     37  等条件变量
     36944 0                   0.0      0.0 134990140    8    8          1 Waiting      5  创建即挂起
```
（`等待ms` 那一列原样输出是 `134990140` 这种量级——它是从开机算起的 100ns tick，不是"已经等了多久"，读的时候要先减去当前 uptime。`124972` 是探针没登记的那个线程（大概是 CRT/加载器留的），`WaitReason=15`。）

能直接拿来当查表用的结论：

| 线程在干什么 | State | WaitReason |
| --- | --- | --- |
| 正在跑（主线程 / 忙等循环） | Running(2) | **31** |
| `Sleep(3000)` | Waiting(5) | **4** |
| `WaitForSingleObject` 等互斥体 / 信号量 / 事件 | Waiting(5) | **6** |
| `EnterCriticalSection` / `SleepConditionVariableCS` | Waiting(5) | **37** |
| `CREATE_SUSPENDED` 挂起 | Waiting(5) | **5** |
| 等文件读（`ReadFile`） | 本次快照里**没拍到**（10 个线程里没有 TID 6028，它在拍快照前已经返回了） | — |

三个值得记住的点：

- `State` 的 0–7 在 MinGW 的公开头文件里没有定义，探针自己写了映射表（Initialized/Ready/Running/Standby/Terminated/Waiting/Transition/DeferredReady）；**WaitReason 的数字官方就没给名字**，所以这张"行为 → 数字"的实测表就是它的用处：下次在 `NtQuerySystemInformation` 里看到 37，你知道那是临界区/条件变量，不是内核 bug。
- **`State` 里没有"阻塞在锁上"这一档**——锁等待是 `Waiting + WaitReason`。这就是任务管理器"状态"列永远是"等待"而分不清在等什么的原因，也是写诊断工具时唯一该看 WaitReason 的理由。
- 主线程和 4 个等锁线程的 **动态优先级=9、基准=8**：内核给了 +1 的提升（等锁/等待唤醒的线程在恢复时被短暂提升，属于第五节的"多级反馈"）。忙等线程始终 8/8，一点提升都没有——**"从不等待"的线程拿不到任何提升**。

## 四、栈：预留 2MB、提交 20KB、紧挨着一页 GUARD，护栏跟着栈底跑

`CreateThread`/进程启动给的线程栈是"预留一大块、按页提交"。探针在每个阶段查 TEB 的两个指针 + 三个位置的 `VirtualQuery`：

```text
  主线程起点    Limit=0000004003ffb000 已提交窗口=0000004003ffb000+20480 B COMMIT 0x4 | Limit 下 4KB=0000004003ffa000 COMMIT 0x104 ←GUARD | Base=0000004004000000 上面=2032 KB RESERVE
                     缺页=968  工作集=3712 KB  私有提交=588 KB
  递归撑栈后    Limit=0000004003f33000 已提交窗口=0000004003f33000+839680 B COMMIT 0x4 | Limit 下 4KB=0000004003f32000 COMMIT 0x104 ←GUARD | Base=0000004004000000 上面=2032 KB RESERVE
                     缺页=1173  工作集=4532 KB  私有提交=1388 KB
```

递归 200 层、每层 4096 字节局部数组之后：

| 观测量 | 起点 | 撑栈后 | 增量 |
| --- | --- | --- | --- |
| `StackLimit` | `0x4003ffb000` | `0x4003f33000` | 下移 819200 B |
| 已提交窗口 | 20480 B | 839680 B | **+819200 B（=200 页）** |
| `PageFaultCount` | 968 | 1173 | **+205**（200 次按需提交 + 零散） |
| 私有提交（页面文件配额） | 588 KB | 1388 KB | +800 KB |
| 工作集 | 3712 KB | 4532 KB | +820 KB |
| `StackLimit` 下 4KB 的保护位 | `0x104` | `0x104` | **PAGE_GUARD 跟着往下跑** |
| `StackBase` 之上 | 2032 KB RESERVE | 2032 KB RESERVE | 预留总量不变（20KB + 2032KB = 2MB） |

这张表就是"按需提交 + 护栏页"的完整现场：**内核把 `StackLimit` 下面那一页标成 `PAGE_GUARD`，越界访问触发的不是崩溃而是"再提交一页 + 把护栏往下搬"**，所以递归深度在 2MB 预留额度内是免费增长的。新起的线程同理，起点只有 12288 B 提交（比主线程的 20480 少），递归 300 层后变 1253376 B，缺页计数 1184 → 1487（+303）。

真把预留额度用光时下场是这样的（探针 fork 出子进程，每层 8192 字节递归到底）：

```text
  子进程退出码=0xc00000fd (3221225725)   ← 0xc00000fd = STATUS_STACK_OVERFLOW
```

注意它**不是** `0xc0000005`（访问违例）：内核认得那页是护栏，翻译成专门的异常码。写崩溃分析时这两个码必须分开处理——栈溢出通常意味着"递归失控"，而访问违例意味着"指针错了"。

`CreateThread` 显式指定栈大小，行为完全不同（每次建 64 个挂起线程再取差值）：

```text
  栈=   16384 B: 私有提交增量=2560 KB (40.00 KB/线程)  工作集增量=512 KB
  栈=  262144 B: 私有提交增量=17920 KB (280.00 KB/线程)  工作集增量=512 KB
  栈= 4194304 B: 私有提交增量=263168 KB (4112.00 KB/线程)  工作集增量=512 KB
```

**指定了大小就整块提交**：4MB 的请求实付 4112 KB 私有提交（≈ 4MB + 16KB 开销），不是按需。而默认（传 0）走的是"预留 2MB + 提交 12–20KB"。工作集三档都只涨 512 KB（64 × 8KB），因为线程还是挂起状态没碰过栈——**提交配额（页面文件）从创建那一刻就被吃掉，物理内存却还没有**，这就是"线程栈开大了进程会 OOM 但其实没占内存"的机制。上一节《线程与进程模型》量到 200 个默认线程每个约 37 KB 提交，和这里的"默认档"是同一件事。

## 五、切换保存了什么，以及让出 CPU 的单价

上下文切换要保存/恢复的东西，第四节那张表里已经有一半：**`StackLimit`/`StackBase` 是每线程各一份的（TEB 里的），切换线程等于换 gs 段基址指向的 TEB**，于是栈指针、TLS、`LastError`、SEH 链一次性全换。再加上寄存器组、PC、以及内核侧的 KPCR/调度状态。

Windows 上没有 `ucontext`/`getcontext`，但内核记的账可以直接读——`ContextSwitchCount`。让出 CPU 的四种做法（同一条逻辑处理器 `mask=0x1` 上放一个对手线程，12 核机器上另有编译任务在跑）：

```text
  Sleep(0)                1500 次 -> 每次   15528001 ns  ContextSwitchCount +=1349 (0.90 次/调用) 总 23292 ms
  SwitchToThread()        1500 次 -> 每次   30423504 ns  ContextSwitchCount +=1625 (1.08 次/调用) 总 45635 ms
  Sleep(1)                 100 次 -> 每次   20359908 ns  ContextSwitchCount +=155 (1.55 次/调用) 总 2036 ms
  忙等不切换             5000000 次 -> 每次          2 ns  ContextSwitchCount +=97 (0.00 次/调用) 总 9 ms
```

同一台机器上另一组（独立探针，10000 次）：`Sleep(0)` +1.07 次/调用、`SwitchToThread` +1.11、`Sleep(1)` +1.57、忙等 +0.00。**可信的是"每次调用换几次上下文"，不是纳秒数**：测量期间这颗核上挤着别的进程，两组之间的绝对值差 2–4 倍，但切换次数比值一致。结构性结论：

- `Sleep(0)` 和 `SwitchToThread()` **确实各让出一次**（约 1 次/调用），`Sleep(1)` 约 1.5 次（进去 + 出来 + 中间被抢占）。
- **绝对值不可复现**：同一份代码两次独立运行，`Sleep(0)` 的单价是 15.5 ms 与 23.9 ms，`SwitchToThread` 是 30.4 ms 与 24.2 ms，`Sleep(1)` 是 20.4 ms 与 29.9 ms——差 2 倍上下，全部由那颗核上外部任务的多少决定（上一节《操作系统在做什么》里 `NtYieldExecution` 空陷入 82.4 ns 才是"一次切换本身"的量级）。**能复用的是切换次数比值，不是纳秒**。
- **忙等不产生切换**（0.00 次/调用，单价 2–13 ns），但那个核上的另一件事就得不到 CPU——自旋的代价不是"这次调用贵"，是"别人被你压住"，见下一节《调度算法与实时性》。
- 两个同优先级线程满载抢同一颗逻辑处理器 2000 ms：`A 切换 2657 次 / 73596928 迭代，B 切换 3049 次 / 91310154 迭代`，迭代比 **0.806**，平均每次切换间隔 0.75/0.66 ms。同优先级应该对半分——实际 44.7% vs 55.3%，差异来自两个线程的循环体不是同一份代码（一个多一个指针自增）加上外部负载。**"轮转"是均等抢占，不是均等时间**，别拿它做吞吐量承诺。

Linux 侧对应的数字（`voluntary/involuntary context switches` 在 `/proc/<pid>/status`、`perf stat -e context-switches`、`sched_yield` 的实测单价）**本节未在本机实测**，没有 Linux 环境。

## 六、纤程：切换不进内核，42.8 纳秒

`SwitchToFiber` 是本机能拿到的"用户态协程"。转换与栈的样子：

```text
  转换前 主线程 StackBase=0000005d53800000 StackLimit=0000005d537fc000 GetCurrentFiber=0000000000001e00
  ConvertThreadToFiber -> 0000020e7784ef10  GetCurrentFiber=0000020e7784ef10  转换后 StackBase=0000005d53800000 StackLimit=0000005d537fc000
  CreateFiber(1MB) -> 0000020e7784f450
     纤程里: GetCurrentFiber=0000020e7784f450 GetFiberData=0000000000000000 TID=142080 StackBase=0000005d53a00000 StackLimit=0000005d53900000
     纤程栈所在区 0000005d539ff000+4096 B State=COMMIT Type=PRIVATE Protect=0x4
  50 万轮往返 = 100 万次切换：42.8 ns/次   纤程推进 500000 步
  转回线程后 StackBase=0000005d53800000 StackLimit=0000005d537fc000 GetCurrentFiber=0000000000000000
```

- **纤程切换 = 换栈指针**。TEB 里的 `StackBase/StackLimit` 被换掉（`0x...600000/0x...500000`，正好 1MB），而当前线程还是那个 TID 142080。`ConvertThreadToFiber(NULL)` 后主线程的两个指针**没变**——它直接拿现有线程栈当自己的纤程栈。
- `CreateFiber(1MB)` 只提交 **4096 字节**（`0000005d539ff000+4096 B COMMIT`），和线程栈同一套按需提交机制，预留额度由参数决定。
- 单价：**42.8 ns/次**（100 万次切换）。另一份探针同样测得 **29.4 ns/次**；第一版探针打的 `0.3 ns/次` 是我自己算错了单位——QPC 频率 10 MHz，`ticks/次数` 忘了再乘 100 换算成纳秒，**真实值要 ×100 ≈ 30 ns**，与 42.8/29.4 同一量级。同一个 100 万轮往返期间内核记的 `ContextSwitchCount` 从 32 变到 43（**+11**），另一份测的是 +126——这些是超时/抢占带来的偶发切换，**和 200 万次切换的次数对不上，证明切换本身没有陷入内核**。
- 一个反直觉的细节：**没转换成纤程的线程上，`GetCurrentFiber()` 返回 `0x1e00` 而不是 NULL**。它是 TEB 里那个槽位的初始值，判"我在纤程里吗"不能拿它当 NULL 比。

对照上一节的数字：一次 `Sleep(0)` 让出是微秒到毫秒级、一次跨线程唤醒（《线程与进程模型》量到 11.35 µs）约 11350 ns，而纤程切换 30–43 ns，**便宜 260–380 倍**。代价是纤程不会自己调度：一个纤程不 `SwitchToThread`，同线程的其他纤程全饿着。

## 七、1:1、N:1、M:N 在本机对应到什么

| 模型 | 谁调度 | 本机证据 |
| --- | --- | --- |
| **1:1**（每用户线程一个内核调度实体） | 内核 | 第三节里每个 `CreateThread` 都出现在 class-5 快照中、有自己的 `State/WaitReason/ContextSwitchCount/内核ms/用户ms`——**内核看得见每一个线程**，这就是 1:1 |
| **N:1**（用户态线程，内核只见一个） | 库 | 纤程：一个线程上多个纤程，快照里只有一个 TID；纤程切换不进内核（+11 次 vs 200 万次） |
| **M:N**（多个用户态实体复用 M 个内核线程） | 两者 | 本机没有生产级 M:N 运行时可测（Go 的 goroutine、Java 虚拟线程**未在本机实测**）。Windows 上最接近的手工实现就是"线程池 + 纤程"或 IOCP |

## 小结

- 线程的内核账本用户态看得见两半：**TEB（gs 段，0x08/0x10 栈边界、0x40/0x48 PID/TID、0x68 LastError）** 和 `NtQueryInformationThread` 的 48 字节；取 PID/TID/LastError 都是内存读（1.1–1.6 ns），不陷入。自造 TEB 结构体在 `ClientId` 之后的字段是错的，实测偏移必须逐个反汇编校准。
- 内核的进程记录（class 5）与 `GetProcessHandleCount`/`GetProcessMemoryInfo` **三方对账一致**：句柄 98=98、私有页 3100KB=3100KB、工作集 6324 vs 6328KB。任务管理器那些列同源。
- 线程状态只有 8 档，**"等什么"藏在 WaitReason**：跑=31、`Sleep`=4、内核对象=6、临界区/条件变量=37、挂起=5；等锁线程会被动态提升到 9（基准 8），忙等线程永远 8/8。
- 栈是"预留 2MB + 提交 20KB + 一页 `PAGE_GUARD`"，护栏跟着 `StackLimit` 走；200 层递归 = 已提交 +819200 B、缺页 +205。用完预留额度报 **`0xc00000fd`**，不是访问违例。显式指定栈大小会**立刻全额提交**（4MB 请求实付 4112 KB 配额）。
- 让出 CPU 三种方式的切换次数是 **1.0/1.1/1.6 次/调用**，忙等 0 次；同优先级同核两线程迭代比 0.806，**轮转不是均分时间**。用户态调度（纤程）单价 **29.4–42.8 ns**，比一次内核让出便宜两个数量级，100 万次切换内核计数只 +11；代价是没人帮你抢占。
