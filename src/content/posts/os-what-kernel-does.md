---
title: 操作系统在做什么
description: 实测：一次系统调用在机器上就是 24 个字节；读 gs:[0x40] 拿 PID 只要 1.5 纳秒，最便宜的陷入是 82.4 纳秒；Sleep(1) 实测 15.18 毫秒的来源。
date: 2026-10-15
tags: [操作系统, 系统调用, 内核态, KUSER_SHARED_DATA, Win32]
category: os
section: os-intro
---

> 环境：**Windows 11 x64**（探针用 `RtlGetVersion` 读到 build=26200）、**GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，`-std=gnu11 -O2 -static`。CPU 6 物理核 / 12 逻辑处理器，`QueryPerformanceCounter` 频率 10 MHz（1 tick = 100 ns）。所有数字都是本机探针重跑出来的原始输出；**同期机器上还有其他编译任务，绝对时间普遍偏大、波动明显，所以本节优先看比值和结构**。本机没有 Linux/WSL，`/proc`、`perf`、`cgroup`、`epoll` 一律无法实测，涉及处会明写"未在本机实测"。

## 一、一次系统调用在机器上就是 24 个字节

把 `ntdll.dll` 导出的 `Nt*` 函数头 24 个字节直接读出来（探针 `GetProcAddress` 取地址后逐字节打印）：

```text
  NtDelayExecution         00007ffa32761430: 4c 8b d1 b8 34 00 00 00 f6 04 25 08 03 fe 7f 01 75 03 0f 05 c3 cd 2e c3   服务号=0x34   syscall@+18   int 0x2e@+21
  NtQueryVirtualMemory     00007ffa32761210: 4c 8b d1 b8 23 00 00 00 f6 04 25 08 03 fe 7f 01 75 03 0f 05 c3 cd 2e c3   服务号=0x23   syscall@+18   int 0x2e@+21
  NtProtectVirtualMemory   00007ffa327617b0: 4c 8b d1 b8 50 00 00 00 f6 04 25 08 03 fe 7f 01 75 03 0f 05 c3 cd 2e c3   服务号=0x50   syscall@+18   int 0x2e@+21
  NtYieldExecution         00007ffa32761670: 4c 8b d1 b8 46 00 00 00 f6 04 25 08 03 fe 7f 01 75 03 0f 05 c3 cd 2e c3   服务号=0x46   syscall@+18   int 0x2e@+21
```

四个函数除了 `mov eax` 里的立即数不同，**机器码一模一样**。逐条翻译：

```text
4c 8b d1                     mov   r10, rcx      ; 参数 0 抄到 r10（syscall 会覆盖 rcx）
b8 34 00 00 00               mov   eax, 0x34     ; 服务号
f6 04 25 08 03 fe 7f 01      test  byte ptr [0x7ffe0308], 1   ; 读共享页的一个标志位
75 03                        jne   +3            ; 置位就走 int 0x2e
0f 05                        syscall             ; ← 真正的边界在这里，偏移 +18
c3                           ret
cd 2e                        int   0x2e          ; 老通路（模拟 / 不支持 syscall 的环境）
c3                           ret
```

所以"用户态 → 内核态"这道概念上的墙，落到实物上是：**两条寄存器约定（`r10` 存第一个参数、`eax` 存服务号）+ 一条 `syscall` 指令 + 共享页里的一个开关字节**。本机那个开关读到 `0x00`（`共享页 0x7ffe0308 这个字节 = 0x00`），也就是走 `syscall`；`int 0x2e` 那条老通路（16 字节处跳过去）在本机一次都没执行。

服务号不是连续的命名空间，实测到的这几种：

| ntdll 导出 | 服务号 | win32u 导出 | 服务号 |
| --- | --- | --- | --- |
| `NtWaitForSingleObject` | 0x04 | `NtUserGetMessage` | **0x1004** |
| `NtClose` | 0x0f | `NtUserPostMessage` | **0x100d** |
| `NtAllocateVirtualMemory` | 0x18 | | |
| `NtQueryVirtualMemory` | 0x23 | | |
| `NtQueryPerformanceCounter` | 0x31 | | |
| `NtDelayExecution`（`Sleep` 落到这里） | 0x34 | | |
| `NtYieldExecution`（`SwitchToThread`） | 0x46 | | |
| `NtProtectVirtualMemory` | 0x50 | | |

`win32u.dll` 的垫片长得和 ntdll 的一字不差（`4c 8b d1 b8 04 10 00 00 …`），但服务号是 `0x1004`/`0x100d`——**第 12 位置了**，这是"服务表选择子"：内核里有第二张分发表，`NtUser*` 走的是它（win32k）。这是"窗口消息、GDI 调用也陷入内核"的直接物证，也是第六节讨论内核形态时手上唯一的硬证据。

## 二、有一堆 API 根本不陷入内核，只是读了 gs 段寄存器指向的内存

同一份探针把 kernel32 的入口字节也打了出来：

```text
  GetCurrentProcessId      kernel32.dll  00007ffa31401ef0 65 48 8b 04 25 40 00 00 00 c3 | 无 syscall
  GetCurrentThreadId       kernel32.dll  00007ffa313f8620 65 48 8b 04 25 48 00 00 00 c3 | 无 syscall
  GetLastError             kernel32.dll  00007ffa313f8640 65 8b 04 25 68 00 00 00 c3    | 无 syscall
  GetTickCount             kernel32.dll  00007ffa313f8600 b9 20 03 fe 7f 48 8b 09 8b 04 25 04 00 fe 7f …
  QueryPerformanceCounter  kernel32.dll  00007ffa314027c0 48 ff 25 29 94 06 00          | 无 syscall
  Sleep                    kernel32.dll  00007ffa3140fe40 48 ff 25 b1 a9 05 00          | 无 syscall
```

- `65 48 8b 04 25 40 00 00 00` = `mov rax, gs:[0x40]`。**gs 段基址指向 TEB**，`0x40` 是 `ClientId.UniqueProcess`，于是"取 PID"退化成一次普通内存读；`0x48` 是 `UniqueThread`，`GetLastError` 读 `gs:[0x68]`。
- `GetTickCount` 里 `b9 20 03 fe 7f` = `mov ecx, 0x7ffe0320`、`8b 04 25 04 00 fe 7f` = `mov eax, [0x7ffe0304]`：**直接解引用 0x7FFE0000 那页**（第三节专门讲它），一个字节都没问内核。
- `48 ff 25 …` 是 `jmp qword ptr [rip+disp32]`，`Sleep`/`QueryPerformanceCounter`/`VirtualQuery` 都只是跳板。手工解出跳转目标（另一个探针的输出）：

```text
  Sleep                      00007ffa3140fe40  48 ff 25 b1 a9 05 00 | jmp [rip+371121] -> 00007ffa2f8c19a0
  QueryPerformanceCounter    00007ffa314027c0  48 ff 25 29 94 06 00 | jmp [rip+431145] -> 00007ffa3266ba90
```

这两个目标落在哪？地址空间扫描的输出里有映像清单：`7ffa2f801000 1.66 MB COMMIT IMAGE RX KernelBase.dll`、`7ffa32601000 1.45 MB COMMIT IMAGE RX ntdll.dll`。`0x7ffa2f8c19a0` 在 **KernelBase.dll** 那 1.66MB 里；`0x7ffa3266ba90` 在 **ntdll** 的 RX 段里，但**不是**那个 syscall 垫片（垫片实测在 `0x7ffa327613d0`）。所以真实的调用链是 `kernel32!Sleep → kernelbase 的桩 → ntdll!NtDelayExecution → syscall`，三层，前两层各值几纳秒。

把单价排出来（7 轮 × 若干次的中位数，括号里是区间，单位 ns/次）：

| 调用 | 中位单价 | 区间 | 说明了什么 |
| --- | --- | --- | --- |
| 空循环体（只留编译器屏障） | 0.3 | 0.3–0.3 | 计时本身的地板 |
| `GetLastError`（读 `gs:[0x68]`） | **1.1** | 1.1–1.2 | 纯内存读 |
| `GetTickCount` / `GetTickCount64`（读共享页） | 1.1 | 1.1–1.3 | 纯内存读 |
| `GetCurrentProcessId`（读 `gs:[0x40]`） | 1.5 | 1.3–3.3 | 纯内存读 |
| `GetSystemTimeAsFileTime` | 1.5 | 1.5–1.6 | 共享页换算 |
| `QueryPerformanceCounter` | **13.9** | 13.8–15.3 | 用户态算出来的（见下） |
| `GetLocalTime` | 47.9 | 46.8–51.4 | 多了时区/夏令时判定 |
| `GetProcessHandleCount`（自见） | 145.8 | 133.4–172.3 | 一次真陷入 |
| `VirtualQuery`（单个区域） | 354.8 | 319.6–388.1 | 陷入 + 内核遍历页表 |
| `GlobalMemoryStatusEx` | 541.9 | 508.9–605.6 | 陷入 + 汇总全机状态 |

**跨过边界的固定成本**用两个特殊样本卡出来：`NtYieldExecution`（内核里几乎不干活）实测 **82.4 ns**（75.6–85.3），`NtQueryPerformanceCounter`（同样几乎不干活）108.4 ns（88.8–115.7）。也就是说：**在这台机器上，光是"进去再出来"就要 80–110 ns，等于 55–100 次 `GetCurrentProcessId`**。

同一份 `QueryPerformanceCounter` 走两条路差 8 倍（13.9 vs 108.4 ns）——13.9 ns 比最便宜的陷入还低一个数量级，说明 kernel32 那个跳板的目标是用户态快路径（拿时间戳计数器乘共享页里的换算系数），不陷入。这一条是**由单价推断的**，我没有反汇编那条快路径本身。

## 三、0x7FFE0000：内核映射给每个进程的 4KB 只读页

`VirtualQuery` 问它自己：

```text
  VirtualQuery(0x7FFE0000): Base=000000007ffe0000 RegionSize=4KB State=0x1000 Protect=0x2 Type=0x20000
     AllocBase=000000007ffe0000 AllocProtect=0x2  映像名=[(空：不是任何模块的映像)]
  VirtualQuery(0x7FFD0000): Base=000000007ffd0000 RegionSize=64KB State=0x10000 Protect=0x1 Type=0x0
```

`State=0x1000`=MEM_COMMIT、`Protect=0x2`=PAGE_READONLY、`Type=0x20000`=MEM_PRIVATE：**4KB、只读、私有、没有文件后备、不属于任何模块**。它就是内核凭空放进每个进程地址空间的一页，下面紧贴着 64KB 的 FREE + PAGE_NOACCESS 空洞（防止越界访问撞到别的东西）。

这一页解释了第二节那些"不陷入的 API"。做法很朴素：**内核把会变的全局状态写在这页上，用户态直接读**。谁在写、写多快，用"同一个偏移前后各读一次"的办法测出来（一次 1 秒的采样）：

```text
   +0x008: 21092069877250 -> 21092079930404  增量=10053154  每增量 0.000100 ms   ← 100 ns 一个单位
   +0x014: 134365390230688821 -> 134365390240741975  增量=10053154  每增量 0.000100 ms   ← 同一个单位，另一个起点
   +0x320: 134989247 -> 134989311  增量=64   每增量 15.70 ms
   +0x340: 4685143590 -> 4685146490  增量=2900  每增量 0.3465 ms
   +0x2e4: 差=1015 → 单位≈0.9974 ms（这行来自同一次运行的全页扫描，窗口 1012.31 ms）
   GetTickCount()/GetTickCount64(): 增量=1000 → 每增量 1.0048 ms（墙钟 1004.824 ms）
   QPC: 增量=10048242 → 每增量 0.000100 ms（频率 10 MHz）
```

三个字段身份当场鉴定出来了：`+0x008` 和 `+0x014` 都以 **100 纳秒**为单位递增（前者从开机算、后者是 1601 起的文件时间，值 1.34e17 正好是 2026 年的 FILETIME；同一轮 `GetSystemTimePreciseAsFileTime` 的差是 1004.821 ms，对墙钟 1004.824 ms），两者 1 秒内各推进 10053154 个单位，与 QPC 的 10048242 个 100ns 单位只差 0.49 ms（读数之间的调度间隙）；`+0x320` 每 **15.57–15.70 ms** 进 1——这就是系统的定时节拍。`+0x004` 读到 `262144000 (0xfa00000)`，是把节拍数换算成毫秒的乘数；`+0x030` 起是一段 UTF-16：

```text
     +0x030 43 00 3a 00 5c 00 57 00 49 00 4e 00 44 00 4f 00  C.:.\.W.I.N.D.O.
  共享页里的可见字符串：+0x0030: "C:\WINDOWS"
```

节拍的证据还能反过来用：`Sleep(1)` 连续 40 次的真实间隔（单位 ms，未调 `timeBeginPeriod`）：

```text
  15.57 15.54 15.28 15.85 15.38 15.75 14.60 15.03 15.96 13.93 14.71 15.09 15.01 14.29 15.25 16.24
  16.79 13.01 15.75 14.03 14.47 15.17 14.42 15.17 15.65 15.14 15.69 14.27 14.63 14.86 15.43 16.07
  14.79 15.19 15.27 15.25 14.90 15.18 14.71 15.28
```

n=40：**最小 13.01、中位 15.175、最大 16.79 ms**。和 `+0x320` 每 15.57ms 进 1 完全对得上。**`Sleep(1)` 睡的是 15ms 不是 1ms**，根源不在 `Sleep` 的实现里，而在这页的节拍字段上——你要的是 1ms 分辨率，就得改系统定时器分辨率（`timeBeginPeriod(1)`，全系统生效，用完必须还原）。

一句话总结这一页的意义：**现代内核把"读"尽量做成内存访问，把"改"才做成系统调用**。第二节那张 1.1 ns vs 82.4 ns 的表，就是这个设计的收益率。

## 四、隔离是特权问题，不是地址问题

同一页地址在每个进程里都存在，但**别人的地址空间不是这样**：

```text
  OpenProcess(pid=4, PROCESS_VM_READ) = 0000000000000000  lasterr=5
  ReadProcessMemory(自己, 0x7FFE0000, 16) ok=1 got=16  前 8 字节=00 00 00 00 00 00 a0 0f  与直接解引用一致=1
```

PID 4 是 System 进程，普通令牌打不开（`lasterr=5` = 拒绝访问），**跟它有没有可读内存无关**。而 `ReadProcessMemory` 读自己时返回的字节和直接解引用 `0x7FFE0000` 一模一样——同一条页表路径，两种访问方式（`/proc/<pid>/mem`、`process_vm_readv` 这类 POSIX 通路本节未在本机实测）。

顺带一个能自证的小观察：`0x7FFE0000` 前 8 字节 `00 00 00 00 00 00 a0 0f`，小端拼起来正是 `+0x004` 那个乘数 `0x0fa00000`，`+0x000` 是 0。

## 五、跨边界的第二种方式：异常。手写一次"按需提交"

系统调用是**主动**越界，异常是**被动**越界。探针注册了一个 VEH（向量化异常处理器），把 64KB 提交成 `PAGE_NOACCESS`，然后逐页首次写入：

```text
  裸 VirtualProtect(4096, PAGE_READWRITE) = 582 ns/次  区间 489-777
  VirtualAlloc 64KB -> MEM_COMMIT + PAGE_NOACCESS @ 0000024c7b760000
  pass0: 触发缺页 16 次  冷写 2838 ns/页  热写 0.0 ns/页  (该轮累计缺页 32)
        → 一次「陷入内核 + 派发到我 + 我改保护位 + 重执行」= 2838 ns；其中裸 VirtualProtect 582 ns，异常派发部分约 2255 ns
  pass1: 触发缺页 16 次  冷写 2638 ns/页  热写 0.0 ns/页  (该轮累计缺页 48)
  pass2: 触发缺页 16 次  冷写 2712 ns/页  热写 0.0 ns/页  (该轮累计缺页 64)
```

拆开看：**同一次违例的"内核侧成本"约 2255 ns，是纯系统调用（80–110 ns）的 20–30 倍**。因为路径长得多：`syscall` 陷入 → 内核确认这是访问违例 → 构造异常记录 → 派发 VEH 链（回到用户态！）→ 我的处理器再调一次 `VirtualProtect`（第二次陷入）→ 返回 `EXCEPTION_CONTINUE_EXECUTION` → 内核重执行那条指令 → 才落到用户态继续。三次 pass 的 2638/2712/2838 差别不大，说明这个单价稳定。

这就是"按需提交"（demand zero page / guard page）的机制原型：Linux 的匿名页首次触碰、Windows 线程栈的自动增长都是同一类事，只不过处理器在内核里而不是在你的 VEH 里。后者的实测见《进程、线程与上下文切换》一节。

## 六、内核的几种形态：本机证据能撑到哪一步

| 形态 | 主张 | 本节的证据 / 缺口 |
| --- | --- | --- |
| 宏内核（monolithic） | 所有子系统在同一个地址空间、同一次陷入里 | **有直接证据**：`win32u.dll` 的 `NtUser*` 服务号带 0x1000 选择子，图形窗口的调用陷入的是内核的第二张分发表——窗口/消息机制不是用户态服务，是内核里的 win32k。GDI 对象配额（每进程 10000）也是同一层的产物 |
| 微内核（microkernel） | 内核只做调度/IPC/中断，驱动和文件系统跑在服务进程里 | Windows 不是这种（上面那条已经否掉）；QNX、seL4 是。判据是"一次跨子系统操作要几次消息传递"，本机无微内核可测 |
| 混合（XNU / NT 的"执行体+内核"分层） | 分层不等于微内核 | NT 把对象管理器/I/O 管理器放在执行体（用户态可见的 ntoskrnl 地址空间内），本节能看到的只是"ntdll 是用户态唯一的入口层"，分层内部未实测 |
| 实时内核 | 有界中断延迟、优先级严格抢占 | 本机只有 Windows 的优先级类，而实测 `SetPriorityClass(REALTIME)` 被静默降为 HIGH（见《调度算法与实时性》）；FreeRTOS/VxWorks/Linux PREEMPT_RT **未在本机实测** |
| 宏内核的性能补丁 | 用共享页、快路径减少陷入 | 第二、三节整节都是这条的证据 |

**Linux 侧的对应物本节全部未实测**：`vDSO`（Linux 版的共享数据页，`cat /proc/self/maps` 里的 `[vdso]`）、`int 0x80` 与 `syscall` 的差距、`/proc/<pid>/status`、`perf stat` 的 `context-switches` 计数、`cgroup` 的 CPU 配额。这些只能按接口语义叙述，没有本机数字。

## 小结

- 一次系统调用 = `mov r10,rcx` + `mov eax,服务号` + `test [0x7ffe0308],1` + `syscall`，共 24 字节，四个不同服务的机器码只差立即数；服务号带 `0x1000` 的走第二张表（win32k），说明窗口/GDI 调用同样陷入内核。
- 跨边界的底价：**82.4–108.4 ns**（`NtYieldExecution` / `NtQueryPerformanceCounter` 这两个"几乎不干活"的陷入）。而 `GetLastError`/`GetTickCount`/`GetCurrentProcessId` 是 1.1–1.5 ns 的纯内存读，**差 55–100 倍**。设计上的结论：能读就不要调。
- `0x7FFE0000` 那 4KB 是 PAGE_READONLY + MEM_PRIVATE + 无模块映像的一页，内核替所有进程维护它：`+0x008`/`+0x014` 以 100 ns 推进、`+0x320` 每 15.57 ms 进 1（=系统节拍，`Sleep(1)` 实测中位 15.175 ms、区间 13.01–16.79 的直接解释）、`+0x030` 是 UTF-16 的 `C:\WINDOWS`。
- kernel32 的导出多数只是 7 字节跳板：`Sleep → kernelbase → ntdll 垫片 → syscall`（跳板目标地址用两份独立探针的映像清单交叉定位到了 KernelBase.dll / ntdll 的 RX 段）。
- 越界还有第二条路：异常。本机手写的一次"缺页 → VEH 改保护位 → 重执行"**2638–2838 ns/页**，其中真正的异常派发约 2255 ns，是纯陷入的 20–30 倍。
- 隔离靠特权不靠地址：`OpenProcess(pid=4)` 直接 `lasterr=5`，而同一页 `0x7FFE0000` 每个进程都能读，且 `ReadProcessMemory` 读自己的结果与直接解引用逐字节一致。
