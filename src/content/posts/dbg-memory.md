---
title: 内存泄漏与碎片——把"内存不降"拆成三件可以分别测量的事
description: >-
  实测（Windows 侧）：交错释放一半 10 万个 80 字节块之后，私有内存 **一个字节都没降**（10,153,984 → 10,153,984），
  而 `HeapWalk` 数出堆里空着 5,502,336 字节、分散在 50,098 个空闲块里、**最大的一块只有 208 字节**；同样这批块改成顺序释放，
  priv 立刻掉 12,152,832 字节；`malloc` 的尺寸阶梯在 **1,048,576 字节处翻转**——以下 free 后 100% 留在堆里，以上 free 后归还 0%；
  每泄漏一只 128 字节对象实测带走 152.9 字节（49 轮拟合，轮增量 275,251 字节/轮）；20 万次 96 字节的 `malloc`/`free`
  换成一次 `VirtualAlloc` 加切块，单只借还从 94.0ns 降到 14.7ns（6.4 倍）、整轮 18.644ms 降到 7.839ms（2.38 倍），
  代价是峰值从"用多少占多少"变成一次性全额提交 20,844,544 字节。Valgrind/massif/heaptrack/`/proc/smaps`/`perf`
  本机无 Linux 与容器，**全部未实测**，本文只给 Windows 侧的等价物和它的失效条件。
date: 2026-10-16
tags: [调试, 内存泄漏, 内存碎片, 分配器, 性能优化]
category: debug-perf
section: dbg-memory
---

> 环境：Windows 11 x64（build 26200），**GCC 13.1.0（MinGW-w64，只用全路径 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`——PATH 上那个是 Strawberry 4.9.2 32 位，用它编出来的结论整节都作废）**，命令行 `gcc -std=gnu11 -O2 -Wall -Wextra m1.c -o m1.exe -lpsapi`。计时用 `QueryPerformanceCounter`（本机频率 10,000,000 Hz ⇒ 分辨率 100ns，两次连续调用之差是 0 个 tick，这一条第 9 节已经实测过，所以本文所有 ns/次都是 20 万次累计摊出来的）。**字节数、块数、区域数、退出码在同一 exe、同一 mode 下可复现**——注意它们读的是**进程当时的状态**而不是常数：`sweep` 连跑两次 `HeapSummary` 的 `cbAllocated` 是 60,152 与 41,995，差别来自两次运行前已经分配了多少，不是抖动；纳秒级耗时是 5 次进程运行的**中位数（区间）**，同期机器上有另外 3 个 agent 在跑，**比值比绝对值可靠**。**本机没有 Linux、没有 WSL、没有容器**：`valgrind --tool=memcheck`、`massif`、`heaptrack`、`/proc/<pid>/smaps`、`perf`、gperftools 的堆采样**一律未实测**，第七节给清单。探针源码与原始输出在 `%TEMP%/agents/dbg2/`（`m1.c`–`m3.c` 与同名 `.out`）。

## 一、先承认工具缺席：本机有什么、缺什么、MinGW 的头还挖了什么坑

Linux 侧的标准答案是三件套：**memcheck** 判"越界/用了没初始化/释放后再用"，**massif** 给堆占用时间曲线和峰值处的分配栈树，**heaptrack** 用低开销采样给"哪个调用点分配了多少"。这三样在本机一个都跑不起来（不是没装，是没有能跑它们的内核），所以本文的主体换成 Windows 侧的四个读数点：

| 想回答的问题 | Linux 侧工具 | 本机实测用的等价物 | 读回来的字节 |
| --- | --- | --- | --- |
| 进程现在占多少 | `smaps` 的 `Pss/Private` | `K32GetProcessMemoryInfo` → `PrivateUsage`/`WorkingSetSize` | 10,153,984 等 |
| 分配器内部账本 | massif 快照 | `HeapSummary()` → `cbAllocated`/`cbCommitted`/`cbReserved` | allo=41,989 comm=81,920 res=1,449,984 |
| 空闲碎片形态 | 无（只能靠 `malloc_stats`） | `HeapWalk()` 逐区域累加 | free=5,502,336/50,098 块，**最大 208 B** |
| 有没有漏 | valgrind 的 "still reachable/definitely lost" | 自己插句柄表，断言"申请数==释放数" | req=100,000 rel=90,000 |

四个读数点都是"读回真实字节"的硬证据，但它们各自的坑要先说清——**这一节里最贵的是头文件**：

1. **`HEAP_INFORMATION_CLASS` 在 MinGW 里只有两个成员**（`winnt.h` 第 9218–9221 行原文：`HeapCompatibilityInformation, HeapEnableTerminationOnCorruption`）。想按文档用 `HeapQueryInformation(h, HeapSummaryQueryInformation, …)`、`HeapPeakSizeQueryInformation`、`HeapTotalFreeSizeQueryInformation`，**枚举名根本不存在**，只能自己按 SDK 位布局声明枚举再强转。
2. 声明了也没用——我把 class 2…20 逐个扫了一遍，缓冲区长度分别试 4/8/40/64 字节，**全部返回 `FALSE` + `GetLastError()=87`（`ERROR_INVALID_PARAMETER`）**，只有 class 0/1 成功（`rl=4`，class 0 读出 `val=2`）。也就是说"用 `HeapQueryInformation` 拿 HeapSize/HeapCommittedSize/HeapTotalFreeSize"这条常见建议在**本机这套 kernel32 导入表上走不通**，能用的统计口是遗留的 `HeapSummary()` 函数和 `HeapWalk()`。
3. **`PROCESS_HEAP_ENTRY` 的字段名是老的**：MinGW `minwinbase.h` 第 183 行起写的是 `lpData` / `Region.dwCommittedSize`，而 MSDN 现在写 `lpBaseAddress` / `dwCommittedBytes`。偏移一样、名字不一样，照文档抄代码直接编译失败。
4. **`HeapQueryInformation` 的 `ReturnLength` 是 `PSIZE_T`（8 字节）**，习惯性地用 `DWORD` 去接会被写超 4 字节——`-Wall` 报 `passing argument 5 … from incompatible pointer type`，这个警告不是洁癖，是真越界。
5. **`GetProcessMemoryInfo` 在 `psapi.h` 里是 `#define` 到 `K32GetProcessMemoryInfo`**（第 45 行），所以加了 `-lpsapi` 也不会走 psapi.dll 那份实现；想比对只能 `LoadLibrary("psapi.dll")` + `GetProcAddress`（第六节末做了，两者是不同地址、同一语义）。
6. **`_msize` 是 `malloc.h` 里的 `_CRTIMP`，`malloc_usable_size` 在本机 MinGW 头里完全没有声明**（grep 全 `include` 目录 0 命中）——这意味着"问分配器这块实际多大"这件事在 MinGW 上只能靠 `_msize` 或 `HeapSize`，而后者有第三节的坑。

## 二、第一本账：同一批 malloc，三个 API 给的字节互相矛盾

`GetProcessHeaps(0, NULL)` 报本机这个进程有 **3 个堆**（`0x…912e0000` / `0x…91190000` / `0x…91720000`），而 `GetProcessHeap()` 返回第 0 个。**关键事实：`malloc` 的块不在进程堆里**——`VirtualQuery(malloc(64))` 得到 `base=0x…91720000`，正好等于 `ProcessHeaps[2]`，而 `malloc(200000)` 的 `base=0x…915a0000` 和 `malloc(2MB)` 的 `base=0x…91730000` 都不是任何堆句柄（堆自己后面的段本身就是独立的 `VirtualAlloc` 区域，`type=00020000` 即 `MEM_PRIVATE`）。

于是最经典的误读出现了。对同一个 `malloc(64)` 的指针调 `HeapSize`：

```text
HeapSize(heap0, p)=590832 gle=0   HeapValidate(heap0)=1
HeapSize(heap1, p)=775872 gle=0   HeapValidate(heap1)=1
HeapSize(heap2, p)=     64 gle=0  HeapValidate(heap2)=1   ← 只有这个是对的
```

**问错堆不报错，`GetLastError()` 还是 0，返回的数看着也挺像回事（590,832）。** 三个堆上 `HeapValidate` 一律返回 1，所以"校验通过"也不能用来定位堆归属。这类静默错值比崩溃危险得多——它会一路进报表。判据只有两条：先 `VirtualQuery` 定归属，或者干脆只用 `GetProcessHeaps` 拿到的**每一个**堆分别读一遍、自己挑自洽的那个。

进程内存侧的三个字段也容易被混用（`sizeof(PROCESS_MEMORY_COUNTERS_EX)=80`，`sizeof(PROCESS_MEMORY_COUNTERS)=72`）：

```text
K32 ok=1 gle=0 ws=3776512 priv=598016 pf=598016 pfault=965
cb=12/len=40 ok=0 gle=122        ← ERROR_INSUFFICIENT_BUFFER
cb=80/len=40 ok=0 gle=122        ← cb 字段和最后一个参数都得给对
```

`WorkingSetSize` 是"现在占着的物理页"，`PrivateUsage` 是"私有提交"（≈ `PagefileUsage`），后者才是泄漏判断的口径。**`EmptyWorkingSet()` 是一个专门制造假象的开关**——实测把 21,635,072 字节的工作集压到 **192,512**（掉 99%），而 `PrivateUsage` **一动不动**（19,513,344 → 19,513,344）：

```text
PMC again_alloc   ws=21635072 priv=19513344
EmptyWorkingSet ok=1 gle=87
PMC after_emptyWS ws=  192512 priv=19513344   ← 数字漂亮了，内存一点没少
```

顺便两条本机确认的细节：`EmptyWorkingSet` 返回 TRUE 之后 `GetLastError()` 仍是 87（**成功不重置 last-error**，这是第 3 节里同样的坑，判成败只看返回值）；峰值类字段只增不减——`PeakWorkingSetSize` 到 21,643,264 之后整个过程再没降过，`PeakPagefileUsage` 同理。**用峰值判断"这一轮有没有变差"是可以的，用它判断"现在还占多少"是错的。**

## 三、`free` 之后内存不降？本机三种情形给三种答案

folklore 说"`free` 之后 RSS 不会降"。在本机，这句话对一半，而**错的那一半正好是三类问题里最容易被误诊的**。三组数字：

**情形一：整批分配、整批释放 → 真的会降。** 20 万次 `malloc(64)` 全部触碰再全部 `free`：

```text
PMC base         ws= 3780608 priv= 2195456
PMC after_alloc  ws=21598208 priv=19234816   （12,800,000 字节用户数据 → priv +17,039,360 = 1.33 倍）
PMC after_free   ws= 5971968 priv= 3080192   ← 降回来了，但仍比基线高 884,736
```

40 万次 `malloc(128)` 更极端：priv 冲到 **63,524,864**，`free` 全部之后剩 **1,011,712**（把 62,939,136 的增量还掉了 62,513,152，**99.3%**），再 `Sleep(200)` 之后还是 1,011,712——**归还动作发生在 `free` 里，不是等后台慢慢还。**

**情形二：交错释放 → 一个字节都不降。** 同一个进程里 10 万个 80 字节块，把奇数号的放掉：

```text
after100k80  priv=10153984  heap2 comm=9506816 busy=8014592/100154 free=  37824/26 maxFree=1240
afterHalfFree priv=10153984 heap2 comm=9506816 busy=4007296/ 50077 free=5502336/50098 maxFree= 208
```

`PrivateUsage` 前后**完全相同**（10,153,984 = 10,153,984，差 0 字节），堆的 `comm` 也没变。变的只有内部记账：在用块从 100,154 掉到 50,077，空闲从 37,824 涨到 **5,502,336 字节 / 50,098 块**，而**最大的一块只有 208 字节**。这就是碎片的定义本身——**空着的字节很多，可用的块没有**。

**情形三：释放顺序决定还不还。** 20 万个 100 字节块，同样释放一半，两种释放法：

| 释放法 | 释放后 priv | 再要 31,458,000 字节后 priv | 在册字节 |
| --- | --- | --- | --- |
| 交错（留奇数号） | 26,398,720 → **26,398,720**（Δ=0） | 58,912,768 | 10,000,000 |
| 顺序（留后半） | 27,521,024 → **15,368,192**（Δ=−12,152,832） | 49,233,920 | 10,000,000 |

**同一份活跃数据（都是 10,000,000 字节在册），最终私有内存差 9,678,848 字节。** 顺序释放能把整段清空、让分配器把段交回去；交错释放则每段都被"钉子户"钉住。这条比任何"内存不降"的口号都可操作：**释放顺序是可调的，分配器的性格不是。**

**情形四（阈值的存在）：单块多大才算"大块"。** 尺寸阶梯 free 之后 `PrivateUsage` 的变化，在 1 MiB 处翻转（`bis` 模式 32KB 一步）：

```text
524288   +532480 afterFree +532480 retained 100.0%
1015808  +1024000 afterFree +1024000 retained 100.0%
1048576  +1056768 afterFree       +0 retained   0.0%   ← 翻转点
1081344  +1089536 afterFree       +0 retained   0.0%
```

1,048,576 字节及以下：`free` 把字节留在堆里；再大：`free` 全额交还（`malloc(2MB)` 的 `VirtualQuery` 显示它独占一个 `regionSize=2101248` 的私有区域）。机制上对应"大分配绕过堆直接 `VirtualAlloc`"，但**本机没有源码或符号级证据，只有上面这组字节行为**，所以这句只能当解释、不能当结论用。表里还有一行锯齿（589824 那行 `afterFree −561152`，retained −93.8%）——那是这次 `free` 顺带把**上一轮**留下的段一起交回去了，`retained%` 为负就是这种跨轮回收，不是测量坏了。

## 四、泄漏、碎片、"内存不降"是三个不同的病：各看一张化验单

把上一节摊开成判据，这张表是本文最想留下的东西：

| 症状 | 看哪个数字 | 本机实测的样子 | 会误诊成什么 |
| --- | --- | --- | --- |
| **泄漏** | `PrivateUsage` 随轮次单调上升，斜率≈每轮请求量 | 50 轮 × 2000 只 128B、每轮漏 1800 只：974,848 → 14,188,544，**轮增量稳定 275,251 字节**（每 5 轮窗口都一样） | "工作集下降了所以没漏"（被 trim 骗） |
| **碎片** | `HeapWalk` 的空闲字节 vs **最大空闲块** | free=5,502,336 字节 / 50,098 块，maxFree=**208 B** | "堆里有 5.5MB 空闲，内存够用" |
| **"内存不降"** | 同一 size 在阈值哪一侧 + 释放顺序 | Δ=0（交错）vs −12,152,832（顺序）vs +0（≥1MiB 单块） | 前面两个病都被这句盖住 |

泄漏的斜率还能反过来用：275,251 ÷ 1,800 只 = **每只实测 152.9 字节**，而请求是 128 字节 → **每只块的分摊开销 24.9 字节（19.4%）**。同一段代码的"纯用户数据"预测是 1800×128 = 230,400 字节/轮，实测 275,251 → **1.19 倍**。这个 1.19 出现在三个独立测量里（`walk` 的 1.19、`frag` 的 1.19、`stages` 的 1.33 是因为 64B 太小、块头占比更高），**它就是"我在任务管理器里看到的数字 ÷ 我以为我在用的字节数"的换算系数**。反过来用：看到 priv 涨 100MB，第一反应应该是"约 84MB 的用户数据 + 16MB 的分配器税"，而不是先怀疑有人漏了 100MB。

有一条常见做法本机**不能**用来量内部碎片：`_msize`。`req=1/8/15/16/17/24/31/32/33/64/100/128/255/256` 全部返回 `msize == req`、`delta=0`（`calloc(1000,1)` 与 `malloc(1000)` 也都是 1000）。**本机的 `_msize` 给的是"请求值"而不是"可用值"**，所以它量不出对齐浪费；要量浪费只能靠上面那种"总字节 ÷ 用户字节"的比例。

`malloc(0)` 与 `realloc` 缩小也归到这张化验单旁边，因为它们是"看起来省了其实没省"的小号样本：

```text
malloc(0)=00000274b2e02470 nonnull=1 msize=1
calloc(0,8)=00000274b2e02490        ← 也是非 NULL
realloc 4096->128 ptrChanged=0 msizeAfter=128   ← 原地缩小
realloc(bigptr,0)=0000000000000000 (NULL=freed)  ← 返回 NULL，但原块已经没了
```

最后一行是纯陷阱：`q = realloc(p, 0)` **返回 NULL 并且释放了 p**。按"realloc 返回 NULL 就是内存不足，原块还在"的常识写错误处理，会得到一个悬垂指针加一次"看起来合理"的双释放。`-Wall` 对往 `malloc(0)` 返回的指针里写一个字节给的警告是 `array subscript 0 is outside array bounds of 'void[0]'`（`m1.c:248`）——**标准层面这块是 0 字节，写它就是 UB**，哪怕本机真的能写进去。

## 五、对象池：省的是"每只 94ns 和 24.9 字节"，赔的是"全额提交"

四种做法，同一份负载（20 万只 96 字节对象，每只都要触碰），每种跑 5 次进程取中位数：

| 方案 | 借一只 | 还一只 | 整轮总耗时 | 私有内存 |
| --- | --- | --- | --- | --- |
| A `malloc`/`free` 逐个 | 51.7–56.5，中位 **55.9** | 36.6–40.5，中位 **38.1** | 18.112–19.165，中位 **18.644 ms** | 全 free 后仍 **+1,150,976** |
| C 一次 `VirtualAlloc` + bump 切块 | 16.2–18.6，中位 **16.8**（含触碰） | **0.2**（只是清指针） | 3.287–3.826，中位 **3.410 ms** | 提交期 **+20,844,544**，`VirtualFree` 后 **+1,605,632** |
| D 同一 slab 上挂空闲链表 | 9.2–11.0，中位 **9.5** | 4.6–6.1，中位 **5.2** | 7.422–9.340，中位 **7.699 ms** | **+20,844,544** |
| F 只活跃 20%、反复借还（`malloc`） | 借还合计中位 **14.2 ns/op** | — | — | 分配期 **+5,804,032**，churn 后 **+311,296** |

三组比值：**C 的总耗时是 A 的 1/5.5（3.410 vs 18.644）**；**D 是 A 的 1/2.42（7.699 vs 18.644）**；**D 的单只借还 14.7ns 对 A 的 94.0ns = 6.4 倍**。C 的 `VirtualAlloc` 建表 0.003ms、D 的空闲链预穿 4.665–5.924ms（这部分是池的固定成本，摊到 20 万只是 23.8ns/只）。

再看池没告诉你的那半边：**C 和 D 的 priv 都是 +20,844,544，正好是 20 万×96 向上取整到 64KB 分配粒度后的全额提交**，而 A 只按实际用到多少提交。`VirtualFree(MEM_RELEASE)` 之后 C 剩 +1,605,632（那是那次实验自己的 20 万个指针、1,600,000 字节的 `malloc` 数组），**池自己的 19.2MB 是一次性全额归还的**——这一条和第三节的阈值行为是一致的（大块还给 OS，小块留在堆里）。

所以判据不是"池更快"，而是：**池把成本从"每次分配的时间"换成"峰值空间"。** 值得上池的信号有两个：单只借还时间 ≥ 池固定成本的 3–4 倍（A vs D 是 94 vs 14.7，明显划算）；活跃集大小可预先界定（20 万只就是一次交 20MB，不会更多）。反过来，**活跃集不可界定、或者对象尺寸跨度大（同一池里既有 24 字节又有 8KB）就不要上池**——那正是 F 那种场景：只活跃 20% 却按 100% 提交的话，白扔 80% 的地址空间；F 里"先全量分配再释放 80%"之后 priv 只涨 **+311,296**，说明这批块被分配器留作复用了（第五节的复用与第三节的情形二在这里合上了）。

## 六、生命周期审计：把"申请数 == 释放数"写成能进 CI 的断言

前几节都只能读总量，而总量最缺的是"归因"。本机唯一能自己造的归因工具是**在分配器外面再套一层记账**，因为它不需要任何调试支持。四个计数器：`req`（申请次数）、`rel`（释放次数）、`live`（当前在册）、`peak`（在册峰值），外加一个 `badRelease`（释放不在册的槽位）。同一份请求负载（100 批 × 1000 只 96 字节对象）跑三种注入：

```text
priv base=3805184 after=3846144
AUDIT clean-path  req=100000 rel=100000 live=     0 peak= 1000 badRelease=0 -> req==rel? YES
ASSERT PASS

priv base=3792896 after=5226496
AUDIT leaky-path  req=100000 rel= 90000 live= 10000 peak=10900 badRelease=0 -> req==rel? NO  leaked=10000 bytes~=960000
ASSERT DETECTED

AUDIT double-rel  req=100000 rel= 90001 live=  9999 peak=10900 badRelease=1
```

`clean-path` 是 CI 里该绿的断言：`req == rel`、`live == 0`、`badRelease == 0`、`peak <= 预算`。`leaky-path` 故意每批漏 100 只（`k % 10 == 0` 那条路径忘了 release），审计**必须**变红——这一步叫反向验证，和"注入一次竞态看 `-j8` 会不会红"是同一套纪律。`bytes~=960000` 是预测的用户字节，priv 实测 **+1,433,600**，比值 1.49，比第四节的 1.19 更大，因为这里只有 1 万只小块、段提交粒度（64KB）还没被摊薄——**同一个"分配器税"在不同规模下是 1.19 到 1.49 之间浮的**，所以拿字节数反推泄漏量时必须写清是哪一段区间的系数。

`peak` 是这套断言里最容易被忽略但最值钱的一条：**它直接给出内存预算上界**（`peak × (size + 24.9B)` 就是这套句柄最多占多少）。`req==rel` 判"漏没漏"，`peak` 判"会不会撑爆"，两者互不替代——一个每轮都全量释放、但一轮要 100 万只的循环，`req==rel` 永远是绿的，`peak` 才是那个会打爆线上的数字。

顺手把 Windows 侧现成的"归因"工具试了一遍，结果值得记录：MinGW 有 `crtdbg.h`，`_CrtSetDbgFlag(_CRTDBG_LEAK_CHECK_DF)` + `_CrtDumpMemoryLeaks()` 编译链接全过（`-O2` 和 `-g -O0` 两版），程序里明写一只 1,024 字节不释放——**标准输出和标准错误都是空的，退出码 0**。这和第 3 节里"堆越界不报异常"、第 1 节里"`-fsanitize` 链不上"是同一件事的三个面：**"没有输出"在这台工具链上永远不能读成"没有问题"**。想在本机拿到"哪个调用点分配了多少"，目前只有两条路：自己插句柄表（本节），或者外部抓取（ETW/xperf，本机没有可用抓取链，未实测，且它与 profiler 采样的偏差属于第 6 节还没展开的范围）。

## 七、本节未在本机实测

- **Valgrind 全族**：`memcheck`（含 `--leak-check=full`、`--show-leak-kinds` 的 "definitely/indirectly/possibly lost" 分类）、`massif`（快照序列、`--time_unit`、峰值处的分配栈树）、`heaptrack`、`gperftools` 的堆采样。原因是本机没有 Linux/WSL/容器，**不是"没试"**。本文所有"泄漏/碎片"结论都来自 Windows 侧的总量与堆内记账，**没有"按调用点归因"的能力**——这是与 massif 之间真实的差距，不是措辞差异。
- **`/proc/<pid>/smaps` 的 `Rss/Pss/Private_Dirty`**：无对应物；`Pss`（按共享数摊分）在 Windows 侧最接近的是 `QueryWorkingSetEx` 的 `ShareCount`，**那个已经在 OS 专栏《虚拟内存、分页与 TLB》里实测过**（私有页 `ShareCount=0`、两个只读视图指向的页 `=7`（3 位封顶）、未触碰页 `Flags=0`），本文不重复取数，但也没有用它做摊分计算。
- **`HeapQueryInformation` 的统计类**：第一节那张扫描表说明 class 2–20 在本机全部 `87`。**"是不是我猜的类号都不对"这个可能性没有被排除**——类号来自记忆而非本机头文件，所以本节只能表述为"这条 API 在本机不可用"，不能表述为"这个 API 不存在这些查询"。
- **LFH（low fragmentation heap）的显式对照**：`HeapSetInformation(LocalHeap, HeapCompatibilityInformation, &enableLfh)` 与默认堆的碎片差异，本机未测。第四节 `maxFree=208` 那组数字**是默认堆（LFH 未显式开启）下的观测**，换到 LFH 上大概率形态不同。
- **`massif` 意义上的"峰值处调用栈"**：本机能测到峰值字节（`PeakPagefileUsage`、`_msize` 无关，见第四节），**测不到峰值由谁构成**。
- **系统内存压力下的 trim 行为**：没有把机器压到开始换页（同期还有 3 个 agent 在跑，不该这么做），所以"分配器在压力下会不会主动交还页"未实测；第五节 C 的 `VirtualFree` 全额归还是显式释放，不是压力回收。
- **多线程下的堆统计**：`HeapWalk` 需要 `HeapLock`，本节所有数字都是单线程读的。**并发分配时的 `PrivateUsage` 抖动、每线程堆的收益**属于还没展开的部分（第 6 节之后），本文不给数字。

## 八、小结

- **工具缺席就把等价物写全**：本机 `GetProcessHeaps` 有 3 个堆、`malloc` 走的是第 3 个（`VirtualQuery` 的 `AllocationBase` 与 `ProcessHeaps[2]` 相等）；统计口是 `K32GetProcessMemoryInfo`（80 字节的 `_EX` 结构，`cb=12` → `gle=122`）、`HeapSummary()`（allo=41,989 / comm=81,920 / res=1,449,984）、`HeapWalk()`（busy/free 字节 + 最大空闲块）。**`HeapQueryInformation` 的 class 2–20 在本机一律 `ERROR_INVALID_PARAMETER(87)`**。
- **`HeapSize` 问错堆不报错**：同一个 `malloc(64)` 指针，heap0 答 590,832、heap1 答 775,872、heap2 答 64，三者 `GetLastError()` 全是 0，`HeapValidate` 全是 1。**先定归属再读数**。
- **`EmptyWorkingSet` 能把工作集从 21,635,072 压到 192,512，而 `PrivateUsage` 一字不动**；峰值字段只增不减。判断泄漏看 `PrivateUsage` 的**斜率**，不看工作集，也不看峰值。
- **三种"free 后不降"是三件事**：整批释放真的会降（63,524,864 → 1,011,712，归还 98.4%）；交错释放一字不降（10,153,984 → 10,153,984）而堆里空着 **5,502,336 字节 / 最大块 208 字节**；把释放改成顺序，同一批对象立刻交回 **12,152,832 字节**。**释放顺序比"要不要 free"更能决定内存还不还。**
- **单块阈值在 1,048,576 字节翻转**：以下 free 后 100% 留在堆里，以上 0% 保留。
- **每只块实测税 24.9 字节（128→152.9，49 轮线性拟合）**，总比例在 **1.19–1.49 倍**之间随规模浮动 → 看到 priv 涨 100MB 先折算约 84MB 用户数据。`_msize` 在本机返回**请求值**（1/15/17/255 全部 `delta=0`），量不出内部碎片。
- **对象池换的是时间对空间**：20 万只 96 字节对象，逐个 `malloc/free` 94.0ns/只轮（18.644ms）→ slab 空闲链 14.7ns/只轮（7.699ms，**2.42 倍**，纯借还 **6.4 倍**），代价是私有内存一次性全额提交 **20,844,544 字节**。**活跃集不可界定就不要上池。**
- **生命周期审计是唯一能进 CI 的形态**：`req==rel`、`live==0`、`badRelease==0`、`peak<=预算` 四个断言，外加"注入 10,000 只已知泄漏必须变红"的反向验证（实测 req=100,000 / rel=90,000 / live=10,000 / priv +1,433,600）。**`_CrtDumpMemoryLeaks()` 对一个已知泄漏输出为空**——本机所有"没报"都要读成"没测到"。
