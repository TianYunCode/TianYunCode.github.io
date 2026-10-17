---
title: 线程与同步
description: 实测：无竞争临界区 13.9 纳秒、互斥体 301.5 纳秒（21 倍）；UI 线程等事件时跨线程 SendMessage 被挂 2805 毫秒；MinGW 的 __declspec(thread) 被静默忽略。
date: 2026-10-15
tags: [Win32, 线程, 临界区, SRWLOCK, WaitForMultipleObjects, TLS]
category: win32
section: win-thread-sync
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，命令行 `gcc -std=gnu11 -O2 -Wall t2.c -o t2.exe -lpsapi`（`-lpsapi` 只为 `GetProcessHandleCount` / `K32GetProcessMemoryInfo`；kernel32/user32/gdi32 由 MinGW 默认链上）。所有绝对耗时取 4–7 轮中位并给区间，同期同机还有其它 agent 在跑，**比值比绝对值可靠**。窗口用 `HWND_MESSAGE` 父建的"消息-only 窗口"，屏幕上看不见；不安装任何东西、不碰服务/注册表。字节数、句柄数、纳秒、返回值与错误码是这节的主角。

## 一、一个线程要花掉什么

```text
基线：内核句柄=91  Private=648KB
CreateThread×1000（4 轮）：19.7 / 20.1 / 22.1 / 24.0 µs/个 → 中位 22.1 µs
  建完句柄 91→1091（每个线程 +1.00 个句柄，没有第二个对象）
  全部 WaitForSingleObject+CloseHandle 之后句柄回到 91
建+等+关 一整个周期：中位 69.8 µs（67.4–80.0）
父时间戳→子线程第一条 QPC：中位 83.4 µs（39.3–113.0）
1000 个 CREATE_SUSPENDED 线程（不 resume）：句柄同样 +1.00/个
```

线程对象**只占 1 个内核句柄**（对照上一节：一支画笔占 0 个句柄、一个 GDI 对象占 1 个槽位），但 22µs 的创建成本 + 69.8µs 的完整周期意味着：**几千个"短任务线程"是真钱**。用 8 个工人的池 + 队列，比每任务一个线程便宜两个数量级。

栈这笔账最容易想歪。本 exe 的 PE 头是 `SizeOfStackReserve=2097152 SizeOfStackCommit=4096`，但那是**主线程**的；子线程栈用 `VirtualQuery` 从 `NtCurrentTeb()->StackBase` 往下走到 `AllocationBase` 逐段累加：

| `dwStackSize` | 栈区域跨度 | 建完即提交 | 子线程写满 700KB/1000KB 后 | CreateThread 单价 |
| --- | --- | --- | --- | --- |
| 0（默认） | 2.00 MB | **1040.0 KB** | +0.0 KB | 29.5–58.6 µs |
| 64 KB | 2.00 MB | 1040.0 KB | +0.0 KB | 32.9–35.8 µs |
| 1 MB | 2.00 MB | 1040.0 KB | +0.0 KB | 25.6–37.8 µs |
| 4 MB | 4.00 MB | 4096.0 KB | — | 43.3 µs |
| 8 MB | 8.00 MB | **8192.0 KB** | — | 30.2–57.6 µs |
| 16 MB | 16.00 MB | **16384.0 KB** | — | 72.4 µs |

三条结论：**小请求不会把栈缩小**（64KB 请求照样给 2MB 区域、1040KB 提交，系统有自己的下限）；**大请求是一次性全部提交**（不是"预留 8MB 按需分页"，8MB/16MB 建完就是 8192KB/16384KB 提交，`剩余预留=0.00MB`）；**碰栈不再增加提交**，因为早就提交完了。整周期成本也跟着涨：默认 73.0µs → 8MB 时 103.6µs。所以"给每个工作线程 8MB 栈"是每线程白占 8MB 私有内存，不是免费的。

这张表我改了两次才对：**第一版**用 `memset(buf,1,sizeof buf)` 写栈，提交量前后一模一样（24.0KB），看起来像"栈根本不计入提交"——`buf` 之后再没被读，`-O2` 把整个 `memset` 当死.store 删了；换成 `volatile char *q` 逐 64 字节写、并把读回的字节累加到 `volatile` 全局，写才真的发生。**第二版**在同一进程里连测 4 种尺寸，四个结果全一样——后建的线程复用了前一个线程刚释放的栈区域（提交量还挂着）；改成"每种尺寸起一个新进程"才是干净的第一次。**测量教训：怀疑"没有变化"之前，先证明变化能被发现。**

线程 ID 不能当钥匙：

```text
串行 2000 个线程：首个=117732 末个=141244 相邻递增 987 次、递减 1012 次，重复 ID=0
  相邻差最小 156、最大 139012 → ID 完全不连续，也不单调
64 个线程挂起在世时再建 40 个：与在世 ID 相同=0 个，40/40 比上一个 ID 小
```

**在世的线程 ID 互不相同（所以能做 key），但退出的线程 ID 会被重新发放，而且新 ID 可能比老 ID 小**（不是递增计数器）——把 `GetCurrentThreadId()` 存进 map 当长期键，迟早撞上"新线程继承了死线程的 ID"。

退出码与强杀：

```text
运行中 GetExitCodeThread → r=1 code=259（STILL_ACTIVE=259）
线程 return 42 → r=1 code=42
CloseHandle 之后 → r=0 code 仍是 42 lasterr=6  ← 值是真的，句柄是假的，别看 code
TerminateThread：返回=1；紧接着 GetExitCodeThread 读到 259（它还没真死）
    → 该线程已 Enter 的 CRITICAL_SECTION 永远没人 Leave：旁观者 TryEnter=0，两次都是 0
    → 进程 Private 一点没少（0.6MB→0.6MB）：栈内存随线程释放，锁的所有权不释放
```

`TerminateThread` 不会跑 DLL 通知、不会释放临界区、不会执行任何清理，它只保证"这个线程不再执行"。要杀掉"卡在锁里的人"，只能靠互斥体的废弃码（第四节）。上面那两行"锁真的没人解"是**第二次跑**才得到的：第一版我忘了 `ResetEvent(g_ready)`，那个手动重置事件在上一段实验后还挂着置位，于是 `WaitForSingleObject(g_ready)` 立刻返回、`TerminateThread` 杀的是一个还没进临界区的线程，旁观者 `TryEnter` 返回 1——结论直接反了。**用事件同步的两个实验之间，一定要 Reset。**

## 二、TLS：这个工具链上 `__declspec(thread)` 是假的

`gcc -std=gnu11 -O2 -Wall t1e.c` 的**编译告警原文**：

```text
t1e.c:8:1: warning: 'thread' attribute directive ignored [-Wattributes]
    8 | static __declspec(thread) int g_a;      // MS 拼法
```

运行时（主线程先写 1/2/3/4，子线程写 100/200/300/400，主线程再读回）：

```text
变量               主线程地址        子线程地址        主线程读回  判定
__declspec(thread) 00007ff70147d07c 00007ff70147d07c  a=100  同一块内存 → TLS 没生效
__thread           000002501f922578 000002501f9226d8  b=2    每线程一份
_Thread_local      000002501f922598 000002501f9226f8  c=3    每线程一份
普通 static        00007ff70147d078 00007ff70147d078  d=400  同一块内存（本来就该这样）
```

**`__declspec(thread)` 被 GCC 忽略后不报错、不减速，只是变成普通 `static`**：地址落在镜像 `.data` 里（`00007ff7...`，两个线程完全相同），子线程写的 100 主线程直接读到。而 `__thread` / `_Thread_local` 的地址在 `0000025...`（每线程 TLS 块，相差 352 字节 = 两块独立 TLS），值互不干扰。这是那种"从 MSVC 移植过来的代码只在这个工具链上静默出错"的坑——**必须开 `-Wall`，而且不能放过 `[-Wattributes]` 这类警告**。

动态 TLS（`TlsAlloc`）的账：

```text
TlsAlloc 连续成功 1086 个，第 1087 次返回 TLS_OUT_OF_INDEXES(4294967295) lasterr=8
TlsSetValue=3.9 ns   TlsGetValue=2.1 ns
释放 idx[0] 之后再 TlsAlloc → 得到 1（不是 0，复用策略不保证最小空位）
未分配的索引 TlsGetValue(9999)=NULL lasterr=87
子线程读主线程 Set 过的槽 → 0（每个线程一份，初值 NULL）
```

1086 个槽是**进程级共享**的预算，不是每线程 1086 个；`TlsGetValue` 只要 2.1ns，比进一次临界区（15.5ns）还便宜，而且没有生命周期问题——但它不帮你初始化/释放指向的内存。三种选择：`__thread`/`_Thread_local`（编译期、零成本）＞ `TlsAlloc`（要手动 Free，槽位有限）＞ 用线程 ID 做 key 的哈希表（最贵，还要处理 ID 复用，见第一节）。

## 三、同步原语：一本句柄账 + 两本时间表

对象成本（同进程 1000 个）：

```text
1000 个匿名事件（CreateEventW）  ：句柄 89→1089，每个 +1.00，全 CloseHandle 后回 89
1000 个 CS + 1000 个 SRWLOCK      ：句柄 89→89，增量 0
其中 500 个 CS 各 Enter 一次      ：句柄仍 89（没竞争就不建内核事件）
Delete 全部 CS 之后               ：句柄 89
```

**CS 和 SRWLOCK 一个内核句柄都不占**（纯用户态对象 + 一个按需创建的事件），这是它们比内核对象便宜得多的根本原因（本大类第一节量过：每个内核句柄本身就有成本）。

无竞争单价（同线程加解锁，20 万次 × 5 轮取中位）与两线程交接单价（各 2000 次 × 4 轮）：

| 原语 | 同线程 add+release | 两线程交接 | 相对 CS |
| --- | --- | --- | --- |
| `InterlockedIncrement+Dec` | **9.9 ns** | — | 0.6 倍 |
| 自旋锁 `InterlockedExchange` | 9.8 ns | 0.10 µs | 0.6 倍 |
| `Acquire+Release SRWLOCK`（独占） | 13.5 ns | **0.06 µs** | 0.87 倍 |
| `Enter+Leave CRITICAL_SECTION` | **15.5 ns** | 0.08 µs | 1.00 倍 |
| `Enter+Leave` CS（SpinCount=4000） | 15.2 ns | 0.06 µs | 0.98 倍 |
| `TryEnter+Leave` CS | 15.2 ns | — | 0.98 倍 |
| `WaitFor(m,0)+ReleaseMutex` | **301.0 ns** | **4.74 µs** | 19 倍 / 59 倍 |
| `Wait(sem,0)+Release` 信号量 | 283.7 ns | 5.17 µs | 18 倍 / 65 倍 |
| `Set+Wait(0)+Reset` 事件 | 405.6 ns | — | 26 倍 |

```text
唤醒延迟（子线程已阻塞在 WaitForSingleObject，父线程 SetEvent 后子线程记录时刻）7 轮：
  10.0 / 10.6 / 11.5 / 14.0 / 29.3 / 53.2 / 71.8 µs
另一次同机运行（未修竞态前）：CS 无竞争 13.9ns、交接 0.12µs；唤醒 4.9–69.8µs
修之前还测出过 -114.4µs 的"负唤醒延迟"：父子共用了同一个时间戳变量，父线程在 SetEvent 之后又写了一次
```

读法：**用户态锁的竞争是几十到几百纳秒，内核对象的竞争是 5 微秒**（差 19–65 倍，因为每次都要 `syscall` 进内核并做一次调度决策）；唤醒一个已阻塞的线程要 **10–70 微秒**，比拿一次锁贵三个数量级。同一台机器两次运行的 CS 数字就有 13.9/15.5ns、0.08/0.12µs 的差，所以**只比量级和比值，不比末位**。`SpinCount=4000` 在这台多核机上没有可见收益（15.2 vs 15.5ns），别指望它省钱。反过来，CS 只能同进程用，跨进程只有内核对象。

## 四、语义差别才是选型的地方

| 问题 | 实测答案 |
| --- | --- |
| CS 可重入吗 | 可以：同线程 `Enter` 3 次后旁观者 `TryEnter=0`；`Leave` 2 次后仍是 0；第 3 次 `Leave` 后旁观者才 `TryEnter=1` → **递归计数=3，必须配平 3 次** |
| SRWLOCK 可重入吗 | **不**：同线程连做 3 次 `TryAcquireSRWLockExclusive` → `1/0/0`，第二次就抢不到（真用 `Acquire` 就是自锁死） |
| 互斥体可重入吗 | 可以：同线程两次 `WaitForSingleObject` 都返回 0（按 owner 计数）；只 `ReleaseMutex` 一次后再等仍是 0（还剩一层） |
| 不是持有者能释放互斥体吗 | 不能：`ReleaseMutex=0 lasterr=288`（旁观线程持有时的主线程） |
| 持有者线程没了呢 | `ExitThread` 后被等待方拿到 **128=WAIT_ABANDONED**；再等一次是 0（废弃只报一次，之后归当前持有者）；`TerminateThread` 杀掉持有者同样得到 128 |
| 自动事件 vs 手动事件 | 自动：`SetEvent` 后连查两次 → `0 / 258`（只放行一次）；手动：`0 / 0`，`ResetEvent` 后 `258` |
| 信号量超上限 | 计数 1/1 时 `ReleaseSemaphore` 返回 **0 lasterr=298**（`prev=-1` 说明没改），一次 `Release 3` 同样失败；取走 1 次后 `Release 1` 成功且 `prev=0` |

`WAIT_ABANDONED` 是**唯一能发现"锁的原主人死了"的信号**，但它只报一次，而且很多代码把 `WaitForSingleObject` 的返回值当成"非 0 就是超时"直接忽略掉——那锁就永远处于"没人负责"的状态。CS 没有这个机制（第一节的 `TerminateThread` 实验就是它：锁被永久占住，任何等待者再也不会醒）。所以：**可能被打断/被强杀的工作单元，宁可跨进程用互斥体，也别用 CS**。

## 五、等待与消息：UI 线程不能只等一个东西

`WaitForMultipleObjects` 的边界与语义：

```text
WMO(64 个句柄, 0ms) = 258(WAIT_TIMEOUT) lasterr=0        ← 64 正好合法
WMO(65 个句柄)      = WAIT_FAILED(4294967295) lasterr=87 "参数错误。"
WMO(0 个句柄)       = WAIT_FAILED lasterr=87              ← 空数组不是"立刻满足"，是失败
置位 #3 与 #5 → WMO(8,FALSE,0) = 3；再等一次 = 3          ← 返回最小下标，一次只放行一个
WMO(8,TRUE) 未齐 = 258；8 个全置位后 WMO(8,TRUE) = 0      ← bWaitAll 成功时恒返回 WAIT_OBJECT_0，不带下标
```

`PostThreadMessage` 有个反直觉的前置条件：对一个**刚 `CreateThread` 出来、还没调用任何消息 API** 的线程 Post，返回 0、`lasterr=1444 "无效的线程标识符符。"`（文案里的"标识符符"是微软原文）；等 10ms 再 Post 仍然 1444，向已退出的线程 Post 也是 1444。**线程的消息队列是"用到才建"的**（`GetMessage`/`PeekMessage`/`CreateWindow` 任一个都会建），只跑纯计算的 worker 根本没有队列。想给 worker 送事件，要么先让它 `PeekMessage` 建队列，要么干脆用内核对象。

UI 线程与工作线程（消息-only 窗口，UI=90340，worker=89100）：`PostMessage` 1.14 µs/次（发 2000 条还没取）、`PeekMessage` 取出 0.919 µs/个、**同线程 `SendMessage` 0.07 µs/次**（不经队列，直接调 WndProc，比 Post 还便宜 16 倍）；跨线程 `SendMessage` 的 WndProc 实际执行线程=90340（UI）而发送方=89100（worker）。

真正值钱的是这个对照。同一个场景（worker 在 200ms 时发一条 `SendMessage`），只改 UI 线程的等待方式：

```text
A) UI：WaitForSingleObject(事件, 3000)      Wait 返回=258 用时 3005.0 ms；worker 的 SendMessage 阻塞 2805.3 ms
B) UI：MsgWaitForMultipleObjects(1,&事件,FALSE,3000,QS_ALLINPUT)
                                           Wait 返回=0 用时 212.1 ms，我的循环里 DispatchMessage 0 条；worker 只阻塞 0.4 ms
```

A 就是用户看到的"程序未响应"：**发送方在等 WndProc，UI 在等事件，而事件要 worker 拿到回复才置**——经典互等，直到超时。B 里 `MsgWaitForMultipleObjects` **自己把发来的消息处理掉了**（所以我的 `PeekMessage` 一条都没取到）。规矩：**UI 线程里"既要等东西、又可能有消息"的场合，只能选 `MsgWaitForMultipleObjects(Ex)` 或 `SleepEx`/`WaitForSingleObjectEx` 这类可警示版本，并在循环里把消息抽干**。抽干本身也有坑：队列里躺着 1 条从不取走的消息时，`MsgWaitForMultipleObjects(0,NULL,FALSE,100,QS_ALLINPUT)` 在 10ms 内返回了 **17231 次**（约 0.32µs/次）；把那条消息 `PeekMessage` 干净后，同样 10ms 只转 1 圈就返回 `WAIT_TIMEOUT`。**`MsgWait` 看的是"有没有"而不是"新到"**，忘了抽干就是一个 100% CPU、不阻塞也不报错的空转循环。

APC（第三种"叫醒线程"的方式）：

```text
QueueUserAPC 返回=1 lasterr=0
子线程依次 SleepEx(200,TRUE)=192(WAIT_IO_COMPLETION)  SleepEx(200,FALSE)=0  SleepEx(200,TRUE)=0
回调写下的值=1234，只在第一次可警示等待里执行
```

**APC 只在可警示等待里投递**：`WaitForSingleObject` / `WaitForMultipleObjects`（非 Ex 版）期间回调一次都不会跑。加上回调必须在目标线程上下文里执行、不能久留、还要担心 `TerminateThread` 把带 APC 的线程杀掉——实际项目里我只用它"叫醒"，任务本身走队列 + 事件。

## 小结

- **建线程的三本账**：22.1µs 调用 + 69.8µs 整周期；每个线程恰好 **+1.00 内核句柄**；栈不是"预留 1MB 按需分页"而是**建完就提交 1040KB**（区域跨度 2MB），请求 8MB/16MB 时 8192KB/16384KB **一次性全提交**，小请求（64KB）也不会比系统下限更省。线程 ID 在世时互不重复但会重新发放、且不单调（2000 个里 1012 次比前一个小），别拿它当长期 key。
- **`TerminateThread` 只会杀人不会还锁**：它杀掉的线程已 `Enter` 的 CS 让旁观者 `TryEnter` 永远返回 0，进程私有内存一点没少（栈随线程释放、锁所有权不释放）。要能"发现主人死了"只有互斥体的 `WAIT_ABANDONED(128)`，且只报一次。
- **TLS**：本机 GCC 13.1.0 **忽略 `__declspec(thread)`**（`warning: 'thread' attribute directive ignored`）并退化成普通 `static`——两线程同一地址、互相覆盖；`__thread` 与 `_Thread_local` 才是每线程一份。`TlsAlloc` 全进程 1086 个槽（第 1087 个 `TLS_OUT_OF_INDEXES` + `lasterr=8`），`TlsGetValue` 2.1ns / `TlsSetValue` 3.9ns，比进临界区还便宜，但未分配索引返回 NULL 且 `lasterr=87`。
- **选锁**：CS/SRWLOCK **不占内核句柄**（1000 个 CS + 1000 个 SRWLOCK = 句柄增量 0，1000 个事件 = +1000），无竞争 13.5–15.5ns、两线程交接 0.06–0.12µs；Mutex/Semaphore 无竞争 284–301ns、交接 4.7–5.2µs（**贵 19–65 倍**，每次都要进内核）；事件 Set+Wait+Reset 406ns。叫醒一个已阻塞的线程 10–72µs。CS 可重入且需配平（递归 3 次要 `Leave` 3 次才放手），SRWLOCK **不可重入**（连做 `TryAcquire` 得 `1/0/0`），互斥体按 owner 计数、非持有者 `ReleaseMutex=0 lasterr=288`。自动事件只放行一次（`0/258`）、手动事件放行到 `Reset`（`0/0/258`）、信号量超上限 `Release` 直接失败 `lasterr=298`。
- **UI 与 worker**：`PostMessage` 1.14µs、取出 0.919µs、同线程 `SendMessage` 0.07µs、跨线程 `SendMessage` 在**窗口所属线程**执行。UI 线程用普通 `WaitForSingleObject` 等 worker，worker 的 `SendMessage` 被挂 **2805 毫秒**；换成 `MsgWaitForMultipleObjects` 只挂 **0.4 毫秒**（发送消息在等待函数内部就被处理，我的循环一条都没取到）。`MsgWait` 看的是"有没有"而非"新到"：一条不取走的消息能让它 10ms 空转 17231 次。APC 只在可警示等待里投递（`SleepEx(TRUE)` 返回 192，`SleepEx(FALSE)` 返回 0）。
- **本机未实测**：`lpStartAddress=NULL` 的 `CreateThread`（子线程执行地址 0 会让整个进程当场 AV，不适合放进探针）；`_beginthreadex` 与 `CreateThread` 的 CRT 差异、TLS 回调 `_tls_used` 在 DLL 里的行为（要造 DLL 并 `LoadLibrary`，怕撞上 loader lock，本轮没做）；线程优先级/亲和性/`Job Object`；纤程与 UAF；跨进程 CS（不存在）以外的同步（命名事件/Section）。
