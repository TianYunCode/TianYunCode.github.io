---
title: 崩溃现场与 core dump：退出码、minidump 与符号缺失
description: >-
  实测（Windows 侧）：递归爆栈与 `alloca(512MB)` 两份 minidump 的字节数完全相同（12,354,409），但 `rbp−rsp`
  一个是 2,076,224、一个是 72 字节；在栈溢出的 handler 里写 dump，四条自救路线全留下 0 字节文件，而且进程终止码
  从 0xC00000FD 被改成 0xC0000005；minidump 体积差 1,159 倍（36,065 → 41,781,049 字节）写盘时间却只差 1.09 倍；
  运行期整数除零是 0xC0000094、能被编译期证明的除零被 GCC 折成 `ud2` 于是变成 0xC000001D；MinGW 的 dbghelp
  `Sym*` 对 `-g0`/`-g3`/stripped 三种产物一律 0 命中；Linux 的 core、`ulimit -c`、`core_pattern` 与嵌入式收集本机未实测。
date: 2026-10-16
tags: [调试, 崩溃, minidump, WER]
category: debug-perf
section: dbg-crash
---

> 环境：Windows 11 x64（`10.0.26200.9457`），**GCC 13.1.0（MinGW-w64，只用全路径 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`——PATH 上那个是 Strawberry 4.9.2）**，GDB 11.2 与 `gdbserver.exe` 同目录，系统侧用 `dbghelp.dll`/`imagehlp.dll`/`WerFault.exe`（660,944 字节）/WerSvc（Running）。被测是 9 个自写 C 探针（`-O2 -g`）：崩溃方式矩阵、异常通知链、栈细节、进程内 dump、进程外 dump 收集器、符号反查、栈溢出自救。异常码、退出码、dump 字节数、报错原文都是确定性的、逐次可复现的；毫秒级的写盘与会话耗时是单次读数，同期机器上还有其他任务，**比值比绝对值可靠**。**本机没有 Linux、没有 WSL、没有容器、也没有开发板**：Linux 的 `core` 文件、`ulimit -c`、`core_pattern`、`apport`/`systemd-coredump`、`gdb` 加载 core、`SIGSEGV` 的内核语义、嵌入式上的崩溃收集**一律未实测**，本文只给 Windows 侧的对应物和明确标了边界的推断。

## 一、程序挂掉之后，你手里最先出现的只是一个数字

同一份盘上留档的 `c1.exe`（`objdump -h` 里 `.debug_line` 还在，即带 `-g`；下表 17 种终止方式），PowerShell 看门狗逐个跑（`WaitForExit(ms)` + `Kill`，绝不傻等）。另有 3 个 `handler-*` mode 在这个 exe 的构建里没编进去，实测直接 `unknown mode` 返回 99——handler 那一组因此换成本轮新写的 `c9.exe`（第二节）：

| mode | 触发 | 退出码（十进制） | 十六进制 | 子进程还活着时打印的 |
| --- | --- | --- | --- | --- |
| `clean` | 正常 return 7 | 7 | 0x00000007 | `SURVIVED mode=clean sink=1` |
| `exit42` | `return 42` | 42 | 0x0000002A | — |
| `null` / `write` / `wild` / `illegal` | 读空 / 写空 / 读未映射高位 / 把数据当代码跳 | -1073741819 | 0xC0000005 | 无 |
| `stack` | 递归爆栈 | -1073741571 | 0xC00000FD | 无 |
| `bigframe` | `alloca(512MB)` | -1073741571 | 0xC00000FD | 无 |
| `div0` | `100/0`（编译期可知） | -1073741795 | 0xC000001D | 无 |
| `div0r` | `1000000/z`，z 运行期为 0 | -1073741676 | 0xC0000094 | 无 |
| `fastfail` | `__fastfail(7)` | -1073740791 | 0xC0000409 | 无 |
| `raise-segv` / `raise-abrt` / `abort` | `raise()`、`abort()` | 3 | 0x00000003 | 无 |
| `heap` / `uaf` / `heapstrict` | 堆越界、释放后读写 | **7** | 0x00000007 | `SURVIVED sink=96 / 88 / 178` |

三条读法：

1. **.NET/PowerShell 的 `ExitCode` 是有符号十进制**，`-1073741819` 与 `0xC0000005` 是同一个数（低 32 位）。日志里只留十进制，三年后没人认得；两个都记。Linux 侧 shell 的约定是 `128+信号号`（SIGSEGV→139），**本机无法验证，仅作对照列出**。
2. 码的语义就在本机头文件里，`winnt.h` 原文：`STATUS_ACCESS_VIOLATION 0xC0000005`、`STATUS_ILLEGAL_INSTRUCTION 0xC000001D`、`STATUS_INTEGER_DIVIDE_BY_ZERO 0xC0000094`、`STATUS_STACK_OVERFLOW 0xC00000FD`、`STATUS_STACK_BUFFER_OVERRUN 0xC0000409`，另有 `FAST_FAIL_FATAL_APP_EXIT 7`（同文件 8912 行）——这解释了 `__fastfail(7)` 为什么落在 `0xC0000409` 上。
3. **最后三行才是本文最想说的：堆越界、use-after-free、甚至开了 `HeapSetInformation(HeapEnableTerminationOnCorruption)`（stderr 原文 `HeapSetInformation ok`）之后越界写 4 KB，进程全都正常返回 7、照常打印 `SURVIVED`。** 现场被破坏了，但系统一个异常都不报，dump 自然永远不会出现。这类问题只能靠 sanitizer，而本机 MinGW 13.1 **三个 sanitizer 全都链不上**（第 1 节原文：`ld.exe: cannot find -lubsan/-ltsan/-lasan`），专门讲 sanitizer 的那一节本节后面还没展开。

**同一个码可能来自两条完全不同的路**，除零是最小样本：`div0`（编译期就看得见 0）被 GCC 折成一条 `ud2`，终止码 `0xC000001D`；`div0r 0`（运行期才算出 0）真的是 CPU 的 #DE，终止码 `0xC0000094`，三次重跑逐字节一致。而 `div0r` **不带第二个参数**时又是 `0xC000001D`——因为 `argc>2` 为假时除数可被证明是 0，再次折成 `ud2`。教科书那句"整数除零 = 0xC0000094"在这个工具链上只在**运行期**成立。

## 二、崩溃时谁先收到通知：VEH、CRT signal、UEH 的顺序与信息量

`c2.exe` 注册 3 个 VEH（`AddVectoredExceptionHandler(1/2/3, …)`）+ `SetUnhandledExceptionFilter`，可选再装 `signal(SIGSEGV,…)`。左列是默认，右列是装了 CRT handler 之后（同一进程、同一个异常）：

```text
SEQ1 main-start                     code=0x00000000 addr=0000000000000000
SEQ2 VEH#1(rank1)                   code=0xC0000005 addr=00007FF60DC08066
SEQ3 VEH#2(rank2)  SEQ4 VEH#3(rank3)         （同 code / 同 addr）
SEQ5 UEH(SetUnhandledExceptionFilter) code=0xC0000005 addr=00007FF60DC08066
--- 装上 signal(SIGSEGV) 之后，SEQ5 变成下面这条，VEH 链随后被再走一遍 ---
SEQ5 CRT signal(SIGSEGV) handler    code=0x0000000B addr=0000000000000000
SEQ6/7/8 VEH#1 #2 #3  →  SEQ9 UEH   code=0xC0000005 addr=00007FF60DC08066
```

四点全部是实测：**VEH 按 first 参数升序、且最先看到异常**；CRT signal handler 夹在中间，它拿到的 `code` 是 CRT 自己的编号 `11`（SIGSEGV），**`addr` 是 0——故障地址在这一层已经丢了**；它返回之后 VEH 链被**再走一遍**（SEQ6-8 与 SEQ2-4 一模一样），最后才到 UEH。想在崩溃点留下证据，只有 VEH/UEH 拿得到 `EXCEPTION_POINTERS`。

`c9.exe`（本轮新写）问的是另一个问题：**handler 能不能救命**。

| mode | 动作 | handler 跑了吗 | 最终退出码 |
| --- | --- | --- | --- |
| `h-null` | `signal(SIGSEGV,h)` + 读空指针 | 跑了（`HANDLER ran sig=11 hits=1`） | **0xC0000005**，`AFTER-NULL-READ reached` 永远没打印 |
| `h-stack` | `signal(SIGSEGV,h)` + 递归爆栈 | **一次都没跑**，输出只有一行 `START` | 0xC00000FD |
| `h-div0r` | `signal(SIGFPE,h)` + 运行期除零 | 跑了（`sig=8`） | 0xC0000094 |
| `h-raise` | 装 handler 后 `raise(SIGSEGV)` | 跑了，然后**继续往下执行** | 7（`AFTER-RAISE reached`+`SURVIVED`） |
| `raise-only` | 不装 handler，只 `raise(SIGSEGV)` | — | 3 |

`raise()` 是软件触发、可以干净返回；**硬件异常是"这条指令执行不了"，handler 返回不等于故障消除**，CRT 于是按原始 NT 状态码终止进程。而栈溢出连 CRT handler 都到不了——这一条直接决定了第五节四条自救路线的命运。

> 对照 Linux：`SIGSEGV/SIGBUS/SIGABRT`、`si_code`、`sa_sigaction` 拿到的 `ucontext`、以及 core 是否在 `ulimit -c` 非零时生成，**本机全部未实测**（无 Linux/WSL/容器）。上面这一节是 Windows SEH 链的实测，不要平移成信号语义去读。

## 三、栈溢出：现场长什么样，怎么一眼认出它

`c4.c` 用 `-DFRAME=` 编出四档帧大小（同一份代码，只有递归帧的 pad 不同）：

| FRAME（编译期 pad） | 爆栈深度 | 出错时 `VirtualQuery` 看到的已提交区域 | 栈区起始 |
| --- | --- | --- | --- |
| 64 B | 18,048 帧 | 2,031,616 B | 4,096 B（region=4 KB） |
| 256 B | 6,648 帧 | 2,031,616 B | 4,096 B |
| 4,096 B | 487 帧 | 2,027,520 B | 4,096 B |
| 16,384 B | 123 帧 | 2,027,520 B | 4,096 B |

深度是帧大小的函数，**而撞墙位置不是**：四档全部停在 2,027,520–2,031,616 字节处，也就是默认 2 MB 主线程栈的边上（`2,097,152 − 64 KB` 上下）；`START` 那行说明栈是按需增长的，`main` 时只有 4 KB 提交（`protect=0x4` 即 PAGE_READWRITE，`state=0x1000` 即 MEM_COMMIT）。另外两条现场细节：`handler used 8B of stack, val=7`——**栈溢出时 VEH 里 8 字节局部变量还能用**，够你写一行日志；`heap anchor byte='Z' (heap intact)`——**栈溢出通常不破坏堆**。

`SetThreadStackGuarantee` 是"传入新值、原地返回旧值"的一次调用两件事，很容易读错（原文三行）：`SetThreadStackGuarantee(in=0) -> out=0`、`SetThreadStackGuarantee(in=65536) -> ret=1 out=0 gle=0`、`SetThreadStackGuarantee(in=1) -> ret=1 out=65536 gle=0`——第二次返回的 `out=0` 是**旧值**，不是"没设上"。

**识别判据（全部本机原文）**：

1. **异常码 `0xC00000FD`**，不是 `0xC0000005`（第 1 节里 gdb 把两者都显示成 `SIGSEGV`，这里用退出码分得更干净）。
2. **`#0` 是 `___chkstk_ms`**，指令是探测本身：`=> 0x7ff7cfe82666 <___chkstk_ms+22>: orq $0x0,(%rcx)` / 下一条 `sub $0x1000,%rax`。
3. **`rbp − rsp` 区分两种爆栈**：递归爆栈两份 dump 都是 `2,076,224` 字节（栈真的被用完了），`alloca(512MB)` 那一份只有 **72** 字节（一帧就想吃 512 MB）。只看异常码和 `#0` 分不出这两件事。
4. 编译期警告排在一切工具前面：`c4.c:54:13: warning: infinite recursion detected [-Winfinite-recursion]`（`c2.c`、`c3b.c` 同样报）。

顺带一句"破坏现场但不报案"的反例：`c1.exe heap` / `uaf` 都活到 `return 7`（第一节表末），而 `c2.exe stack` 早期一轮记录的是 `dec=1`（`d/e1.txt`，当时的构建），同一个 mode 在 `A_exitmap.txt` 和本轮都是 `0xC00000FD`——**跨构建比退出码是没有意义的，比之前先确认是同一个 exe。**

**卡住 ≠ 崩了。** 这些判定全部由看门狗给出（`CreateProcess`/`ProcessStartInfo` + `WaitForExit(ms)` + `Kill`，或 `c7.exe` 的 `WaitForDebugEvent`）。本轮 `c1.exe abort` 在 6 秒内返回 3，而上一棒同一命令在 `A_exitmap.txt` 里记的是 `abort => TIMEOUT dec=-1 hex=0xFFFFFFFF`；`c1.exe div0r 0` 四次里有 1 次超时（6 秒被杀），3 次正常返回 `0xC0000094`。**同一条失败路径的终止方式本身会变**，所以任何"跑一下看看"都必须带超时。**忙等还是阻塞**（两次 `GetProcessTimes` 差值、ETW）本机未做，属于未实测。

## 四、minidump 是怎么写出来的：mask 选型就是体积账

`MiniDumpWriteDump` 有两条取法：链接 `-ldbghelp`，或像 `c6.exe`/`c8.exe` 那样 `LoadLibraryA("dbghelp.dll")` + `GetProcAddress`（原文：`dbghelp.dll loaded at 00007ffa2cbe0000, MiniDumpWriteDump=00007ffa135ef950`）。后者不引入导入库依赖——这个选择本身要用 `c0` 矩阵支撑：同一个只打印 `SURVIVED argc=1` 然后 `return 7` 的 5 行程序，`c0_plain.exe` 与 `c0_dbghelp.exe`/`c0_psapi.exe`/`c0_imglp.exe`/`c0_all3.exe` 全是 `dec=7 hex=0x00000007 out=[SURVIVED argc=1|]`，而 `c0_lucrt.exe` 和 `c0_both.exe` 是 **`dec=-1073741819 hex=0xC0000005 out=[] err=[]`——在 `main` 之前就死掉，stdout 一个字节都没有**（本轮 `c1u.exe clean` 同样是 `0xC0000005`，而 `c1.exe clean` 是 7）。崩溃收集器如果链错了运行时，表现就是"什么也没发生"——它连崩溃机会都不给你。

体积表（`c6.exe clean`，进程内、预分配 2,000×8 KB，同一份代码只改 mask）：

| mask | 名称（本机 `_dbg_common.h` 原文） | dump 字节 | 写盘 ms |
| --- | --- | --- | --- |
| 0x0 | MiniDumpNormal | 36,065 | 181.08 |
| 0x1 | WithDataSegs | 449,057 | 218.37 |
| 0x2 | WithFullMemory | 41,781,049 | 197.82 |
| 0x40 | WithIndirectlyReferencedMemory | 70,309 | 124.96 |
| 0x200 | WithPrivateReadWriteMemory | 17,635,532 | 167.20 |
| 0x1000 | WithThreadInfo | 34,701 | 199.23 |
| 0x4000 | WithoutAuxiliaryState | 34,225 | 175.94 |
| 0x8000 | WithFullAuxiliaryState | 35,137 | 165.50 |
| 0x100000 | FilterTriage | 28,280 | 163.90 |
| 0x2000000 | WithAvxXStateContext | 35,937 | 126.64 |

十次调用**每一次都是 `ok=1 gle=6`**（`ERROR_INVALID_HANDLE`，winerror.h 第 51 行）。两件事值得记：**判成败只能看返回值和文件字节数，`GetLastError` 在成功时也脏**；**体积差 1,159 倍（36,065 → 41,781,049），写盘时间只差 1.09 倍（181.08 → 197.82 ms）**——写 dump 的成本是固定开销（枚举模块、线程、句柄）主导，所以 mask 该按**存储与上传预算**选，不用按 CPU 选。顺带一条没解释清楚的：`WithFullMemory` 的 41.78 MB 比同一次运行的 WorkingSet（22,388,736）和 PrivateUsage（18,411,520）都大得多，原因本机未实测。

dump 里装了什么（本轮自己解析 MDMP 目录，头 16 字节 `4d 44 4d 50 | 93 a7 f4 a0 | 0d 00 00 00 | 20 00 00 00` = 签名 `MDMP`、版本 `0xA0F4A793`、13 项目录、目录 RVA 32）：

```text
out_null_C0000005_0.dmp   streams=13 :: 3(100);4(544);13(776);9(992);6(168);7(56);15(1364);21(524);22(152);0(0)x4
m_clean_0.dmp（不崩只 dump） streams=12 :: 3(148);4(1840);13(2844);5(340);7(56);15(1364);21(524);22(152);0(0)x4
out_div0r_C000001D_0.dmp  streams=13 :: 3(100);4(544);13(776);5(148);6(168);7(56);15(1364);21(524);22(152);0(0)x4
```

多出来的那一条就是 **type 6 `ExceptionStream`（168 字节）**——**"这份 dump 到底是不是崩溃产生的"最省事的判据**，不用工具、不用联网。另外 `mask=0` 用 type 5 `MemoryListStream`（148–372 字节的描述表），`mask=2` 换成 type 9 `Memory64ListStream`（960–992 字节）；12,354,409 字节的爆栈 dump，目录里 9 条实流一共才 4 KB 出头，**其余全是那条描述表指向的数据块**。`ModuleListStream` 4 进程内 1,840 字节、进程外抓子进程 544 字节——差的正是收集器自己 `LoadLibrary` 进来的那几个 DLL。

## 五、栈溢出时 dump 写不出来：四条自救路线全败

`c8.exe` 在 VEH 里看到 `0xC00000FD` 之后试四条路（`fix_none_none_0.dmp` 等文件名即路线名）：

| 路线 | 现场打印 | dump 字节 | 进程终止码 |
| --- | --- | --- | --- |
| 直接 dump | `VEH code=0xC00000FD` | **0** | **0xC0000005** |
| 先 `_resetstkoflw()` | `_resetstkoflw -> 0 gle=0`（**返回 0 = 失败**） | 0 | 0xC0000005 |
| 切到 2 MB 备用栈 | `switch rsp 000000083fa04a10 -> 000001ec9a8df000` | 0 | 0xC0000005 |
| 备用栈 + mask=2 | 同上，`mask=0x2` | 0 | 0xC0000005 |

**四条路线一个共同点：`take_dump()` 里那行 `linef(" DUMP …")` 从来没打印出来**——它在 `MiniDumpWriteDump` 返回之后才执行。**进程是死在 dump 调用里面的**，`CreateFileA` 已经建好了文件，于是留下 0 字节。进程内的对照同样干净：`c6.exe stack` 三种 mask 全部只打印到 `VEH code=0xC00000FD addr=… param[0]=1 read=870089505288` 就没了，`m_stack_0.dmp`/`m_stack_2.dmp`/`m_stack_200.dmp` **全是 0 字节**。

最阴的一条是**终止码被改写**：本轮同一会话里，`c1.exe stack` 和 `c2.exe stack` 都是 `0xC00000FD`，而装了 dump 尝试的 `c8.exe` 四种路线全部变成 `0xC0000005`。**运维收到的码是"访问违例"，你会顺着这条码去查一个根本不存在的空指针**——收集器不但没留下现场，还把现场的死因改了。

同一个 mode，换进程外收集就成功。`c7.exe`（Crashpad/Breakpad 的最小模型：`CreateProcess` + `DebugActiveProcess` + `WaitForDebugEvent` + `MiniDumpWriteDump(子进程句柄)`）原文：

```text
child pid=122276 started cmd=[c1.exe stack]
EXCEPTION first=1 code=0xC00000FD addr=00007ff7cfe82666 child_base=00007ff7cfe80000 rva=0x2666 thread=95732 nparams=2
  GetThreadContext ok=1 gle=183 rip=00007ff7cfe82666 rsp=000000b500e04e50 rbp=000000b500fffc90
  DUMP out_stack_C00000FD_0.dmp ok=1 gle=6 bytes=12354409 write_ms=168.57
parent total_ms=20.3 final exitcode=0xC00000FD
```

| 子进程 mode | mask | dump 字节 | 写盘 ms |
| --- | --- | --- | --- |
| `null` | 0 | 19,013 | 98.59 |
| `null` | 2 | 10,306,441 | 131.75 |
| `stack` | 0 | 2,095,029 | 88.77 |
| `stack` | 2 | 12,354,409 | 168.57 |
| `bigframe` | 2 | 12,354,409 | 124.47 |
| `div0r` | 0 | 17,189 | 85.66 |

差别一句话：**父进程的栈是好的**，它只需要 `ReadProcessMemory` 去读那条废掉的子线程栈；而且它拿得到干净的 `EXCEPTION_POINTERS` + `GetThreadContext`（`gle=183` 是成功调用之后的残留值，别当错误）。注意 `stack` 即使 `mask=0` 也有 **2,095,029 字节**——**栈溢出的 normal minidump 天生就 2 MB**，因为整条线程栈本身就在 dump 里；这是上传带宽的真实下限，不是"mini"的错觉。`bigframe` 与 `stack` 的 mask=2 两份文件**字节数完全相同**（12,354,409），MD5 不同（`61598e88…` / `1aaf467b…`）——**别拿文件大小当崩溃签名**。

**上一棒留下的事故比实验更有说服力**：`c7.exe` 的早期版本把 `ContinueDebugEvent` 的标志传错（应当传 `DBG_EXCEPTION_NOT_HANDLED`，源码注释原话："关键：交回给系统（NOT_HANDLED），否则同一条指令重来 -> 无限事件循环"），于是同一个异常无限重现：

```text
EXCEPTION code=0xC0000005 addr=00007ff608fe7d9d rva=0x0 thread=94904
  GetThreadContext ok=1 gle=0 rip=00007ff608fe7d9d rsp=000000e3bafff9b0
  DUMP out_null_C0000005_7.dmp ok=0 gle=2147942699 bytes=0 write_ms=0.43
```

盘上现在躺着 **`out_null_C0000005_*.dmp` 26,935 个、`out_stack_*.dmp` 26,530 个、`out_bigframe_*.dmp` 351 个 0 字节文件**（目录总计 53,934 项），每次调用 `ok=0`、`gle=2147942699`（= `0x8007012B`，低 16 位 299 = `ERROR_PARTIAL_COPY`），耗时 0.4–0.6 ms，父进程两次被 40 秒看门狗判 `TIMEOUT`，日志文件 21,676,917 字节。**崩溃收集器最常见的故障不是崩，而是把磁盘和日志刷爆**——所以它必须自带：每进程只取一份 dump（`c8`/`c6` 里的 `InterlockedCompareExchange(&g_done,1,0)`）、轮转上限（`DumpCount`）、以及"同一异常码重复出现即停"的熔断。

工程结论（四条路线全败换来的）：**进程内 handler 里只允许写一行日志和一个标志位；写 dump 必须交给独立进程**（或系统的 WER）。而"崩之前日志还剩多少"这条规律是第 2 节实测的：`落盘字节 = ⌊已写字节 ÷ 缓冲区大小⌋ × 缓冲区大小`——handler 只救自杀不救他杀，两节说的是同一件事的两半。

## 六、符号表缺失怎么办：本机走得通的三条反查路

dump 里的 `rva=0x2666` / `rva=0x7D9F` 是**减过模块基址的偏移**（`addr=00007ff7cfe87d9f − child_base=00007ff7cfe80000`）。第一条路是把它喂给 `addr2line`，但**必须补上链接期基址**，PE 的 DWARF 记的是链接期绝对地址：

```text
$ addr2line -e c1.exe -f -i -C 0x7D9F          → ??  /  ??:0            ← 直接喂 RVA 是废的
$ addr2line -e c1.exe -f -i -C 0x140007D9F     → main / …\c1.c:62
$ addr2line -e c1.exe -f -i -C 0x140002666     → ??   / C:/buildroot/src/gcc-13.1.0/libgcc/config/i386/cygwin.S:126
$ addr2line -e c6.exe -f -i -C 0x140002A46     → ??   / …cygwin.S:126   ← 进程内 VEH 报的 rva，同一结论
```

链接期基址从 `objdump -h c1.exe` 拿（`.text 000071d8 0000000140001000`），运行期基址从 `child_base`/`info files` 拿——这套四步换算在第 1 节已经跑通过，本文只是把入口从"$pc"换成"dump 里的 RVA"。注意第二行的输出：**栈溢出的故障地址反查出来永远不是你的代码**，而是 libgcc 的探测函数；能区分递归和 `alloca` 的只有第三节的 `rbp−rsp`。

反查也会**给你一个错行号**：`c1.exe div0r` 的 dump 故障地址是 `rva=0x7F62`，`addr2line` 回 `main / c1.c:88`——而 88 行是 `div0` 分支的 `100/z`，本次跑的明明是 90–92 行的 `div0r`。原因在指令里：`objdump` 显示 `0x140007f62: 0f 0b  ud2`，`0x140007f27: f7 f9  idiv %ecx`（后者 `addr2line` 给 `c1.c:91`）——**两个分支共用了同一个 cold 陷阱块，块上的行号属于先编译的那一个**。所以行号只当线索，判据是 `x/2i $pc` 的指令 + `nparams`（`0xC0000005` 是 `nparams=2`、`0xC000001D` 是 `nparams=0`，两份 dump 原文都是如此）。

第二条路：**别指望 Windows 的符号 API**。`c5.exe` 用 `dbghelp`/`imagehlp` 探三个产物（本轮重跑，逐字一致）：

```text
=== crash_g0.exe / === crash_g3.exe / === crash_stripped.exe   （三档输出完全相同）
    SymSetOptions prev=0x16 -> now=0x16
    SymLoadModule64 base=0x140000000 gle=2
    SymGetLineFromAddr64 hits=0 / probes=1984
    SymFromAddr(0x1480) ok=0 name=- disp=0
    SymEnumSymbols ret=1 count=0 gle=0
```

`-g3` 的 exe 也一样 0 命中：**dbghelp 只认 PDB/COFF，不认 GCC 的 DWARF**。想写跨平台的符号解析，在这条工具链上就是死路（连编译都过不去：`err5.txt` 原文 `error: unknown type name 'PIMAGE_DEBUG_INFORMATION'`，`c5.c` 注释指出 `psdk_inc/_dbg_common.h` 用 `#ifndef _WIN64` 把这类声明整个留给 32 位；`struct _SYMBOL_INFO has no member named Type`）。

第三条路：**gdb 与 minidump 互不相认**（本机原文）——

```text
(gdb) core out_null_C0000005_0.dmp
"C:\Users\wangt\AppData\Local\Temp\agents\dbgcrash/out_null_C0000005_0.dmp" is not a core dump: file format not recognized
```

`target` 的子命令清单里只有 `core/exec/native/remote/extended-remote/tfile/record-*`，**没有 minidump**。所以"用 gdb 打开 .dmp"这件事在本机不存在；Linux 的 ELF core 与 Windows 的 minidump 是两套档案，**留档必须连格式一起决定**。而产物留档的成本第 1 节已经量过：`-g1` 只比 `-g0` 大 2.4% 就够 `addr2line` 反查行号，`strip -g` 之后行号立刻失效，`strip -s` 之后 PE 的 `.pdata/.xdata` 还在、`bt` 仍可用。**发布版带 `-g1`、带符号产物留档，仍是这一节的最优解。**

## 七、远程与嵌入式：本机只能做回环对照

把被测程序放到 `gdbserver.exe --once 127.0.0.1:2361` 后面，用 gdb 连过去（命令走 stdin，因为 `-ex` 会被这台机器的 argv 通道拆坏，第 1 节原文重现过一次，本轮又中一次）：

```text
Remote debugging using 127.0.0.1:2361
Reading C:\WINDOWS\SYSTEM32\ntdll.dll from remote target...
warning: File transfers from remote targets can be slow. Use "set sysroot" to access files locally instead.
Reading …kernel32.dll / KernelBase.dll / msvcrt.dll from remote target...      ← 一共 4 个
Thread 1 received signal SIGSEGV, Segmentation fault.
main (argc=2, argv=0x1b5bceb2630) at c1.c:62
62	        v = *p; g_sink = v;
#0  main (argc=2, argv=0x1b5bceb2630) at c1.c:62     rip 0x7ff7cfe87d9f <main+175>
=> 0x7ff7cfe87d9f <main+175>:	mov    0x0,%eax
```

**远程崩溃一样能符号化到源码行**，前提是 `file` 必须排在 `target remote` **之前**：先 `file` 再连，gdb 读本机 exe 的 DWARF；顺序错了或者路径被 `-replace` 吃掉反斜杠，就是全 `??` + `Backtrace stopped: previous frame identical to this frame (corrupt stack?)`——**这句话是"你没给它符号"，不是"栈真的坏了"**，本轮实测两种顺序的差别就在这。

链路的代价能量出来：同一个 null 崩溃，gdb 会话墙钟 **446.2 ms / 446.7 ms**（两个 mode，都要通过链路读 4 个系统 DLL），加 `set sysroot C:/Windows/System32` 之后 **314.3 ms**（**−29.6%**）。但 sysroot 不是免费的：

```text
warning: Could not load shared library symbols for 4 libraries, e.g. C:\WINDOWS\SYSTEM32\ntdll.dll.
  2    Thread 123860     0x00007ffa32764a74 in ?? ()      ← 未设 sysroot 时这里是 ntdll!ZwWaitForWorkViaWorkerFactory
```

自己的崩溃帧完全不受影响，**丢的是系统库的帧**。远程/嵌入式调试的第一课在这里是可测的：**符号放在宿主机、sysroot 提前设好，链路只用来传寄存器和少量内存。**

远程能拿到栈的"残骸"，而拿不到"完整 core"：

```text
#0  ___chkstk_ms () at C:/buildroot/src/gcc-13.1.0/libgcc/config/i386\cygwin.S:126
#1  … in recursive (n=501, n@entry=<error reading variable: DWARF-2 expression error: Loop detected (257).>) at c1.c:41
#2  … in recursive (n=<error reading variable: DWARF-2 expression error: Loop detected (257).>) at c1.c:47
(More stack frames follow...)
(gdb) generate-core-file C:/…/core6_2361
warning: cannot close "C:/…/core6_2361": invalid operation
Can't create a corefile
```

`generate-core-file` 在三个 case 上都失败，留下 **3 个 0 字节文件**——**Windows 版 gdbserver 不能 gcore**，想在线程栈已经废掉的地方拿 core，只能靠目标端自己产生（Linux 的 `core_pattern`/`ulimit -c`/`apport`/`systemd-coredump`，**本机未实测**）。栈溢出时远程 `bt` 里 `#2`–`#5` 的返回地址全是同一个 `0x00007ff7cfe815d8`、变量读出来是 `DWARF-2 expression error: Loop detected (257)`，**唯一还可用的是 `#1` 的 `n=501`**（递归深度）和第 1 节那条"深度靠 `bt` 行数反推"。远程看到的信号也仍是 `SIGSEGV`，两种故障在 gdb 里同签名——判据永远回到 `#0` 与 `x/2i $pc`。

系统级收集（WER `LocalDumps`）本机做了一遍，结论是**负面的、而且没查清**：

```text
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\c1.exe
    DumpFolder    REG_EXPAND_SZ    C:\Users\wangt\AppData\Local\Temp\agents\dbgcrash\d\werdumps
    DumpType    REG_DWORD    0x2
    DumpCount    REG_DWORD    0xa
child exit=-1073741819 hex=0xC0000005      ### c1.exe null
NO DUMP appeared in …\d\werdumps after 20s
```

注册表写入三次 `操作成功完成。`、读回逐字一致、子进程退出码正确、`werdumps` 目录**空**（`wer_files.txt` 0 字节）。两种脚本（bat 等 12 秒、PowerShell 轮询 20 秒）、两个 mode（`null`/`stack`）都是零产物；`HKLM` 侧只查到 `reg : 错误: 系统找不到指定的注册表项或值。`（`Disabled`/`DontShowUI` 不存在），`WerSvc` 是 `Running`。可疑点也在同一份导出里：`HKCU\…\Windows Error Reporting\RuntimeExceptionHelperModules` 挂着 6 条第三方 WER 插件（`d:\cherrygo\crashpad_wer.dll 0x1`、`D:\Thunder\Program\bugly_extra_handler.dll 0x1`、`discord_wer.dll` 等），外加 `LastRateLimitedDumpGenerationTime REG_QWORD 0x1dd5cc924c7dd3a` 这个限流时间戳。**第三方接管或限流是嫌疑，本机未定位，不敢当结论**；能带走的只有一条流程纪律：**用 LocalDumps 上线之前，先在一台"装了同类安全/管家软件"的机器上验证目录里真的有文件**，别假设注册表写完就有 dump。

**嵌入式上的崩溃收集本机完全没有条件实测**（没有板子、没有交叉链路）。能迁移的只有三条由本机数字支撑的设计约束，其余都算未验证：**(a)** 收集器必须是**独立进程**（第五节四条路线全败 vs 进程外 12 MB 成功）；**(b)** 上传预算按 dump 体积算而不是按 CPU 算——`MiniDumpNormal` 抓子进程只要 **17–20 KB / 86–99 ms**，而栈溢出场景一份就是 **2 MB**（第五节表）；**(c)** 目标端要留一条**不受被测进程控制的**落盘通道（独立分区或复位后回读），因为第 2 节已经证明缓冲里的日志在硬终止下一行都救不回来，`c8` 的 0 字节 `.dmp` 则是同一件事在 dump 上的版本。

## 八、小结

- **先认码，再谈现场**：`0xC0000005`（AV，读写空指针/野指针/把数据当代码，四个不同 mode 同一个码）、`0xC00000FD`（爆栈，递归与 `alloca` 同一个码）、`0xC000001D` vs `0xC0000094`（**同一个除零，编译期可证 → `ud2` → ILLEGAL_INSTRUCTION；运行期 → 真 #DE → INTEGER_DIVIDE_BY_ZERO**）、`0xC0000409`（`__fastfail(7)` = `FAST_FAIL_FATAL_APP_EXIT`）、`3`（`raise()`/`abort()` 走 CRT 正常终止，不是异常）。十进制与十六进制都要落进日志。
- **谁先看到崩溃**：VEH（按 first 参数升序）→ CRT `signal` handler（**故障地址已经是 0**）→ VEH 再走一遍 → UEH。`signal()` 拦不住硬件异常：`h-null` 的 handler 跑了、进程仍按 `0xC0000005` 终止；**`h-stack` 的 handler 一次都没跑到**。`raise()` 才是可恢复的软件触发（`h-raise` 一路跑到 `SURVIVED`、退出码 7）。
- **栈溢出的识别**：码 `0xC00000FD` + `#0 ___chkstk_ms`（`orq $0x0,(%rcx)`）+ **`rbp−rsp`**（递归 2,076,224 vs `alloca` 72）；四档帧大小（64/256/4096/16384）爆栈深度 18,048/6,648/487/123，撞墙位置全都固定在 2,027,520–2,031,616 字节；栈里还剩 8 字节可用、堆完好；`SetThreadStackGuarantee` 是"传新值返旧值"。
- **崩了但没报案**：`heap`/`uaf`/`heapstrict`（已开 `HeapEnableTerminationOnCorruption`）全部 `SURVIVED`+退出码 7。本机 MinGW 13.1 的 ASAN/UBSAN/TSAN **一个都链不上**（第 1 节原文），专讲 sanitizer 的那一节还在本节后面。
- **dump 的体积账**：mask `0x0→0x2` 体积 ×1,159、写盘时间只 ×1.09，成本是固定开销；每次成功都伴随脏的 `gle=6`（判成败看返回值 + 字节数）；崩与不崩的档案差一条 `ExceptionStream(6,168 字节)`；`mask=0` 用 `MemoryListStream(5)`、`mask=2` 用 `Memory64ListStream(9)`。
- **栈溢出时进程内写 dump 全军覆没**：0 字节 ×4 条自救路线（`_resetstkoflw()` 返回 0，备用栈切了 `rsp` 也没用），而且**终止码被从 `0xC00000FD` 改写成 `0xC0000005`**；换进程外（`DebugActiveProcess`+`GetThreadContext`）同一份崩溃就是 12,354,409 字节。收集器必须独立进程 + 每进程一份 + 轮转 + 熔断——上一棒那个 `ContinueDebugEvent` 标志传错，产出的是 **53,934 个 0 字节 `.dmp`**（`gle=0x8007012B` → `ERROR_PARTIAL_COPY`）而不是崩溃。
- **符号缺失的三条反查路**：dump 的 `rva + 链接期基址 → addr2line -f -i -C`（`0x7D9F→??`，`0x140007D9F→c1.c:62`）；行号会骗人（div0r 反查成 div0 的行，靠 `x/2i $pc` 与 `nparams` 纠正）；`dbghelp Sym*` 对 `-g0/-g3/stripped` **一律 0 命中**（`hits=0/1984`），gdb 明确拒绝 `.dmp`（`is not a core dump`），**minidump ≠ ELF core**；发布带 `-g1`、带符号 exe 留档。
- **远程**：`file` 必须在 `target remote` 之前，否则 `??` + 那句假 "corrupt stack?"；链路读系统 DLL 让会话从 314.3 ms 涨到 446.2 ms（**+42%**），`set sysroot` 省 29.6% 但丢系统库符号；`generate-core-file` 在 Windows gdbserver 上是 `Can't create a corefile` + 0 字节文件。
- **本节未实测**：Linux 的 `core`/`ulimit -c`/`core_pattern`/`apport`/`systemd-coredump`/`gdb 加载 core`/`SIGSEGV` 内核语义、WSL 与容器内的 core、嵌入式板子上的崩溃收集与回读、`WER LocalDumps` 不落 dump 的确切原因、`MiniDumpWithFullMemory` 为何比 WorkingSet 更大、忙等与阻塞的 CPU 时间差值判据（无 ETW/xperf，`GetProcessTimes` 采样未做）、MSVC 工具链与 `.pdb`/符号服务器那套。
