---
title: GDB 实战：断点、栈帧与崩溃现场
description: 实测：同一个 -O2 二进制，-g1 只比 -g0 大 1820 字节（+2.4%）却足够 addr2line 反查到 crash.c:13；10000 次命中的软件断点摊到 106µs/次，条件从不成立反而 151µs，软件观察点 6.0ms/次（比硬件观察点贵 46 倍）；MinGW GDB 11.2 的 record 报"架构不支持"、scheduler-locking 不支持，run 之前设的 watchpoint 跑满 10000 次写而一次都不触发。
date: 2026-10-15
tags: [调试, GDB, 调试信息, 崩溃取证]
category: debug-perf
section: dbg-gdb
---

> 环境：Windows 11 x64，**GDB 11.2（`D:/Qt/Tools/mingw1310_64/bin/gdb.exe`）** + GCC 13.1.0，`objdump/nm/addr2line/strip` 同目录；被测的是自己写的 5 个小 C/C++ 程序（`-O0/-O2` 各一份）。体积、字节数、符号条数、错误原文都是确定性的、可复现的；耗时列是 3–4 次重复的**中位数（区间）**，同期机器上还有其他任务，**比值比绝对值可靠**。

## 一、先确认你在用哪个 gdb

```text
$ where gdb
C:\Strawberry\c\bin\gdb.exe
D:\Qt\Tools\mingw1310_64\bin\gdb.exe
```

第一个是 **GDB 7.8.1（2014）**，它对 GCC 13 产物的第一句判决是 `"...\t1.exe": not in executable format: File format not recognized`——**连 exe 都打不开**，后面所有命令全废。所以下面每一步都写全路径。另外两条 Windows/MSYS 特有的坑：

```text
$ gdb.exe -q -ex "set pagination off" -ex "show version"
Excess command line arguments ignored. (version ...)
pagination: No such file or directory.
```

`-ex` 的参数在这套 shell 里被拆坏了，只能把命令写进文件用 `-x`。而 `-batch -x` 有个副作用——**第一条错误就中止整个脚本**（`s1b.gdb:8: Error in sourced command file: No symbol "i" in current context.`）。取证阶段反而应该用交互式喂 stdin：`gdb -q ./t.exe < s.gdb`，每条独立报错、继续执行。

## 二、调试信息开哪一档：-g1 就够反查行号

`big.cpp`（vector/string/map/模板/lambda），`-O0` 单 TU 编译成 `.o`：

| 选项 | .o 字节 | DWARF 字节 | `.text` | .debug_info | 另一头 |
| --- | --- | --- | --- | --- | --- |
| `-g0` | 324,938 | 0 | 6,832 | — | — |
| `-g1` | 540,064 | 110,919 | 6,832 | 59,700 | .debug_line 17,076 |
| `-g2`（=`-g`） | 718,464 | 268,400 | 6,832 | 210,080 | .debug_line 17,199 |
| `-g3` | 797,512 | 346,276 | 6,832 | 210,084 | **.debug_macro 75,678** |

`.text` 四档一字不差——**调试信息绝不动代码，只动体积**。`-g1→-g2` 涨的 15 万字节全在 `.debug_info`（59,700→210,080，类型与变量位置），而 `.debug_line` 只差 123 字节；`-g3` 比 `-g2` 多的 77,876 字节里 75,678 是宏表。

链接成 exe（`crash.c`，`-O2`）之后，关键是最后一列——对一个已知地址做反查：

| 选项 | exe 字节 | 相对 `-g0` | nm 符号行 | `addr2line -e X -f -i -C 0x140007c40` |
| --- | --- | --- | --- | --- |
| `-g0` | 77,253 | — | 952 | `??` / `fake:?` |
| `-g1` | 79,073 | **+1,820（+2.4%）** | 959 | `read_null`/`crash.c:13`；`main`/`crash.c:24` |
| `-g2` | 82,213 | +4,960（+6.4%） | 960 | 同上 |
| `-g3` | 116,579 | +39,326（+50.9%） | 961 | 同上 |
| `-g` 再 `strip -g` | 67,287 | −14,966 | 940 | `??` / `??:?` |
| `-g` 再 `strip -s` | 38,912 | −43,301 | `no symbols` | `??` / `??:0` |

**发布版留 `-g1`：多付 2.4%，换来崩溃地址能反查到源码行（`-i` 还把内联帧展开成两行）。** `strip -g`（删调试段、留符号表）就已经查不到行号了——符号表救不了行号，只有 `.debug_line` 能。`big.cpp` 那侧的对照：`-g2` exe 585,108 字节，`strip -g` 后 266,925，`strip -s` 后 79,872——留档产物是发布产物的 7.3 倍。

但 gdb 侧的能力是分层的，同一份脚本实测：

| 构建 | `bt` | `info args` / `info locals` |
| --- | --- | --- |
| `-g0` | 断点根本设不上：`No source file named crash.c.` | `No symbol table info available.` |
| `-g1` | **有函数名和行号** | `No arguments.` / `No locals.` |
| `-g2` | 完整 | 完整（`-O2` 下另有 `<optimized out>`） |

冷启动代价本机**量不出来**：同时段 `-g0/-g2/-g3` 三个 exe 的 `gdb -batch` 空跑分别是 400–713 / 410–429 / 355–488 ms，区间互相覆盖，全被 0.3–0.7 秒的进程启动吃掉。**别为"符号太多拖慢 gdb"做决策，为体积和留档做决策。**

## 三、命中一次断点值多少钱

被测：`step()` 被调 10,000 次，每次写一次全局 `g_sum`；无断点基线中位 **394.6 ms（369.8–518.3）**，其中程序自身几乎不计时。

| 挂法 | 总时长中位（区间）ms | 净开销 ms | 每次命中 µs |
| --- | --- | --- | --- |
| `break t3.c:9` + `commands/silent/continue` | 1457.5（1410.3–1814.8） | 1063 | **106** |
| 同位置条件断点，条件**从不成立** | 1900.0（1899.5–1977.4） | 1505 | **151** |
| `commands` 里 `printf`（会话输出 40,010 行） | 2772.9（2674.1–3200.0） | 2378 | 238 |
| `dprintf` 同位置同参数（输出 10,009 行） | 2015.3（2014.1–2142.4） | 1621 | 162 |
| Python `Breakpoint.stop()` 返回 False | 1444.7（1431.5–1537.2） | 1050 | **105** |
| 硬件观察点 ×10000 + `silent/continue` | 1159.0（1087.7–1466.5） | 764 | **76** |
| 硬件观察点 ×2000（同批对照） | 653.6（558.8–848.4） | 259 | 130 |
| 软件观察点 ×2000（`set can-use-hw-watchpoints 0`） | 12461.2（11204.5–13083.8） | 12067 | **6033** |

1. **条件断点不会因为"不停"而便宜**：条件从不成立比无条件命中还贵 42%（151 vs 106µs）——`int3` 陷阱照旧发生，gdb 还要多算一次表达式。热点行上没有免费午餐。
2. **同批 2000 次对照：软件观察点是硬件观察点的 46 倍**（6033 vs 130µs）。软件观察点靠逐指令单步来判断"这块内存变了吗"，只能当硬件槽位不够时的兜底，**绝不要放进循环**。
3. **打印比命中贵一倍以上**（238 vs 106µs）：`silent` 不是装饰。要日志式跟踪就用 `dprintf`（比 `commands+printf` 省 32%）或 Python。
4. Python 断点在"命中"这件事上与 C 命令表等价（105 vs 106µs），但能在 `stop()` 里读变量、写文件、决定不停。

## 四、观察点：三个实测坑

**坑一：`run` 之前设的 watchpoint 一次都不触发。**

```text
(gdb) p &g_sum
$1 = (long long int *) 0x14000c030 <g_sum>
(gdb) watch g_sum
Hardware watchpoint 1: g_sum
(gdb) run 10000
n=10000 acc=150055000 g_sum=150055000          ← g_sum 被写了 10000 次
[Inferior 1 (process 51812) exited normally]   ← 一次都没停
(gdb) p &g_sum
$2 = (long long int *) 0x7ff711edc030 <g_sum>  ← 运行期真正的地址
```

`info breakpoints` 里连 `breakpoint already hit` 那行都不出现，即 0 次命中：监视器装在了**未重定位的地址**上。正确姿势是先 `break` 进函数让进程活起来、`delete` 掉引导断点、再 `watch`——只改顺序，同一脚本立刻 `breakpoint already hit 10000 times`。断点有 ASLR 重定位机制，观察点没有。

**坑二：停下时显示的行不是改动它的那行。** 赋值 `g_flag = 1` 写在 `t1.c:13`，命中时 gdb 报：

```text
Thread 1 hit Hardware watchpoint 3: g_flag
Old value = 0
New value = 1
accumulate (...) at t1.c:10
10	    for (int i = 0; i < n; i++) {
```

只有 `Old value/New value` 是真凭据，行号是写入之后的下一个序列点；要定位写入者，接着 `x/i $pc` 或 `bt`。

**坑三：硬件槽位有限，但本机没测到上限。** 同一会话连设 4 个（`g_sum`、`g_hit`、`*(int*)&g_sum`、`*(long long*)&g_hit`）都成功，第 5 个的表达式 `acc` 不在当前帧作用域，先报 `No symbol "acc" in current context`。**"x86 只有 4 个 DR 槽、第 5 个会静默降级成 46 倍慢的软件观察点"这条在本机未实测**，只当设计约束记住。

## 五、栈帧、变量与打印格式

**`-O2` 会让你瞎。** 同一份脚本（`info locals` + 5 个 `p` + `bt` + `info args`）跑两个构建，输出里 `<optimized out>` 的行数：**`-O0` 0 行，`-O2` 9 行**。

```text
# -O0
Thread 1 hit Breakpoint 1, accumulate (a=0x166120d4570, n=300, cap=500) at t1.c:11
i = 0      sum = 0      $3 = (int *) 0x166120d4570      $4 = 300
# -O2
Thread 1 hit Breakpoint 1, accumulate (a=<optimized out>, n=<optimized out>, cap=500) at t1.c:11
i = <optimized out>   sum = 0   $3 = <optimized out>   $4 = <optimized out>
```

注意 `sum = 0` 仍然可读而 `i` 不可见——**可见性是逐变量决定的，不是整体开关**。别把整块代码退回 `-O0`，先看这个变量在 `-O1` 下是否可恢复。

**内联把一个断点变成三个。** `-O2` 下对 `static inline` 函数体 `break t4.c:7`：

```text
Breakpoint 1 at 0x140001453: t4.c:7. (3 locations)
1       breakpoint     keep y   <MULTIPLE>
1.1                         y   0x0000000140001453 in scale at t4.c:7
1.2                         y   0x0000000140001463 in scale at t4.c:7
1.3                         y   0x0000000140001479 in scale at t4.c:7
```

三个调用点各插一份，命中次数是 3 倍；`bt` 里 `#0 scale` 和 `#1 use_a` 会作为独立帧出现（内联帧可见，代价是帧号整体偏移）。

**`p/x` 对浮点是废的。** 结构体里 `float ratio = 0.1f`：

```text
(gdb) p/x g_item.ratio           $4 = 0x0             ← 截断成整数再按十六进制显示
(gdb) p/d g_item.big             $6 = 0               ← double 同理
(gdb) x/4xb &g_item.ratio        0x...44 <g_item+4>:  0xcd  0xcc  0xcc  0x3d
(gdb) x/1fw &g_item.ratio        0x...44 <g_item+4>:  0.100000001
(gdb) p/x *(int*)&g_item.ratio   $1 = 0x3dcccccd      ← 正是 0.1f 的 IEEE-754
(gdb) x/fx &g_item.ratio         0x...44 <g_item+4>:  0xcd   ← 只给了一个字节
```

最后一条是 `x/` 的语法坑：`x/<n><格式><宽度>`，第三位是**显示宽度**（`x`=1 字节、`h`=2、`w`=4、`g`=8），不是"十六进制"。要看位模式写 `x/1fw` 或 `p/x *(int*)&f`。

**其余实测原文**（`print pretty` 之前 `p` 一个大结构体是没法读的；数组截断阈值在 `print elements`）：

```text
(gdb) p g_item
$1 = {id = 1234, ratio = 0.100000001, big = 0.33333333333333331, tag = "ab\000\001\002\377z", in = {kind = -5, flags = 4095}, series = {0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121}, name = 0x7ff79a7e9000 "hello"}
(gdb) set print pretty on
$2 = {
  id = 1234,
  ratio = 0.100000001,
  ...
(gdb) x/8xb g_item.tag
0x...50 <g_item+16>:	0x61	0x62	0x00	0x01	0x02	0xff	0x7a	0x00
(gdb) set print elements 4
$12 = {0, 1, 4, 9...}
(gdb) set print repeats on
No symbol "on" in current context.        ← 它要的是阈值数字，不是开关
(gdb) p/r 'A' * 12
$14 = 780                                 ← C 里 'A' 是 int，65*12
(gdb) p sizeof g_item
$10 = 88
(gdb) p sizeof g_item.in
$11 = 8                                   ← short + 12 位位域也占 8
```

`tag` 用 `p` 显示成 `"ab\000\001\002\377z"`（gdb 转义了内嵌 NUL），但**只有 `x/8xb` 告诉你那 8 个字节到底是什么**；`p g_item.tag` 遇到真字符串结尾会给你不同长度。

**`up` / `finish` / `until` 的实测行为：**

```text
(gdb) up
#1  0x00007ff764ff1621 in main (...) at t1.c:35
(gdb) p sum
No symbol "sum" in current context.                      ← 切帧只能看该帧的变量
(gdb) p/a $pc
$6 = 0x7ff764ff1621 <main+233>                           ← 调用帧的 $pc 是返回地址
(gdb) x/6i $pc
=> 0x7ff764ff1621 <main+233>:	add    %eax,-0x8(%rbp)   ← call 之后那条，不是 call
```

`finish` 会被同一函数内的断点立刻抢回去：设了 `break t1.c:11` 再对 `accumulate` 执行 `finish`，输出 `Run till exit from #0 accumulate…` 之后紧跟 `Thread 1 hit Breakpoint 1 … t1.c:11`（下一轮循环）。要先 `disable` 函数内的断点。
`until 16` 在 `main` 帧里执行时，16 行不属于当前函数，gdb 退化成"单步直到离开当前函数"——实测一路走到 `__tmainCRTStartup`（提示 `which has no line number information`）并让程序跑完退出。**`until` 的行号只在当前帧的函数内有效。**

## 六、多线程：这台上没有你熟悉的那套

4 个 `pthread_create`，`info threads` 给出 7 行（主线程 + 4 worker + 2 个 ntdll 的 WorkerFactory 线程），另一次同样程序跑出 6 行——**数量取决于运行期，不能拿它做断言**；线程号形如 `Thread 45104.0x1fc94`（pid.tid）。

```text
(gdb) set scheduler-locking on
Target 'native' cannot support this command.
(gdb) show scheduler-locking
Mode for locking scheduler during execution is "off".
(gdb) set non-stop on
Cannot change this setting while the inferior is running.
```

**scheduler-locking 在这套工具链上完全不可用**，`step` 期间其他线程照常跑。实测证据：在 5 号线程连按两次 `step`，第二次之后 `info threads` 里冒出新 `[New Thread 45104.0x14920]`，当前线程标记 `*` 也不再是你站着的那个——**多线程 + Windows native target 下不存在单步确定性**。唯一的办法是把线程编进断点：`break accumulate if i == 100 && thread == 5`，或先 `info threads` 再 `break foo thread 5`。

`thread apply all bt` 输出 7 段，其中 5 段是系统帧：

```text
Thread 2 (Thread 45104.0x11914):
#0  0x00007ffa32764a74 in ntdll!ZwWaitForWorkViaWorkerFactory () from C:\WINDOWS\SYSTEM32\ntdll.dll
#1  0x00007ffa3261a65e in ntdll!TpCallbackMayRunLong () from C:\WINDOWS\SYSTEM32\ntdll.dll
#4  0x0000000000000000 in ?? ()
Backtrace stopped: previous frame inner to this frame (corrupt stack?)
```

`TpCallbackMayRunLong` 这类符号是 ntdll 导出表按地址猜的，**别当真实调用链读**。切到 `thread 3` 后 `p w->id` 报 `No symbol "w" in current context`——那是系统线程，没有你的栈帧。判据只有 `info threads` 的 `Frame` 列里显示了你自己的函数名的那些行。

## 七、反向调试：不可用；脚本化：可用

```text
(gdb) record full
Process record: the current architecture doesn't support record function.
(gdb) info record
No recording is currently active.
(gdb) reverse-continue
Target native does not support this command.
(gdb) reverse-step
Target native does not support this command.
```

单线程程序同样失败，所以不是"没装插件"，是这个 target 不支持。**替代方案是把回放搬到日志里**：Python 断点命中时读变量、写文件、返回 `False` 不打断执行，跑完离线看轨迹。实测它对 10,000 次调用只打印 3 行（`hit#1 x=0` / `hit#2 x=1` / `hit#10000 x=9999`），耗时与 `silent/continue` 等价：

```python
import gdb
class Trace(gdb.Breakpoint):
    hits = 0
    def stop(self):
        Trace.hits += 1
        if Trace.hits <= 2 or Trace.hits == 10000:
            fr = gdb.selected_frame()
            print("hit#%d func=%s x=%s" % (Trace.hits, fr.function().name, fr.read_var("x")))
        return False          # False = 不停下，直接继续
Trace("t3.c:9")
```

自定义命令（`gdb.Command` + `fr.find_sal().line`）同样可用，但**程序退出后取帧会报 `Error occurred in Python: No frame is currently selected.`**——所有读帧的操作必须排在 `run` 之前或命中点上。

## 八、崩溃现场取证：有符号与无符号两条路

不经 gdb，PowerShell 取 `$LASTEXITCODE`：`arg=s exitdec=-1073741571 exithex=0xC00000FD`（递归爆栈）、`arg=n exitdec=-1073741819 exithex=0xC0000005`（读空指针）。在 gdb 里两者**都显示 `Thread 1 received signal SIGSEGV`**，信号名分不出这两类故障；要原始 NT 状态码就让 gdb 放行：

```text
(gdb) handle SIGSEGV nostop noprint pass
SIGSEGV       No	No	Yes		Segmentation fault
(gdb) run n
[Thread 109316.0x1d6f8 exited with code 3221225477]   ← 0xC0000005
```

爆栈现场（`-O2 -g`）：`bt` 打了 **506 帧**，栈没坏，但顶端不是你：

```text
Thread 1 received signal SIGSEGV, Segmentation fault.
___chkstk_ms () at C:/buildroot/src/gcc-13.1.0/libgcc/config/i386\cygwin.S:126
#0  ___chkstk_ms ()
#1  0x00007ff6653c14ad in deep (n=504) at crash.c:5
#2  0x00007ff6653c150c in deep (n=<optimized out>) at crash.c:8
#506 0x00007ff6653c7ca0 in main (...) at crash.c:19
(gdb) x/2i $pc
=> 0x7ff6653c25f6 <___chkstk_ms+22>:	orq    $0x0,(%rcx)
   0x7ff6653c25fa <___chkstk_ms+26>:	sub    $0x1000,%rax
```

三条判据：**`#0` 是 `___chkstk_ms` 就是栈探测撞到守护页**（GCC 为大栈帧每 4KB 探一次，`orq $0x0,(%rcx)` 是探测本身）；`#1` 的 `n=504` 是整条链上唯一还带值的帧，往上全是 `<optimized out>`，**递归深度只能靠 `bt` 的行数（506）反推**，`set backtrace limit 5` 会把这个信息直接砍掉；而 `-Wall -Wextra` 早在编译期就报了 `warning: infinite recursion detected [-Winfinite-recursion]`——**免费的检查要排在 gdb 前面**。

空指针现场被 `-O2` 挪了位置：

```text
main (argc=<optimized out>, argv=<optimized out>) at crash.c:24
(gdb) p/a $pc
$1 = 0x7ff6653c7c40 <main.cold>
(gdb) x/2i $pc
=> 0x7ff6653c7c40 <main.cold>:	mov    0x0,%eax
   0x7ff6653c7c47 <main-9>:	ud2
(gdb) p $_exitcode
$2 = void                    ← 进程还没退，取不到退出码
```

`read_null()` 已内联进 `main`，错误路径被热冷分块丢进 `.cold` 段，于是符号显示成 `main.cold`、下一条指令显示成 `main-9` 这种负偏移。

**没有符号时**（`strip -s` 过的同一个 exe）：

```text
(No debugging symbols found in ./crash_stripped.exe)
(gdb) bt
#0  0x00007ff76b9c7c40 in ?? ()
#1  0x00007ff76b9c12ef in ?? ()
#2  0x00007ff76b9c1406 in ?? ()
(gdb) info line *$pc
No line number information available for address 0x7ff76b9c7c40
(gdb) x/2i $pc
=> 0x7ff76b9c7c40:	mov    0x0,%eax          ← 反汇编仍然可读
(gdb) info files
	0x00007ff76b9c1000 - 0x00007ff76b9c7ce8 is .text
```

栈帧结构还在（PE 的 `.pdata/.xdata` 没被 strip 掉），所以 `bt` 的地址列表可用。四步反查，本机全程跑通：

```text
1) objdump -h crash_g.exe  →  .text  00006ce8  0000000140001000   ← 链接期基址
2) gdb 里 info files       →  0x00007ff76b9c1000 … is .text        ← 运行期基址
3) 0x7ff76b9c7c40 - 0x7ff76b9c1000 + 0x140001000 = 0x140007c40
4) addr2line -e crash_g.exe -f -i -C 0x140007c40
   read_null / C:\...\crash.c:13 ；main / C:\...\crash.c:24
```

**前提是留档的带符号二进制与发布产物是同一次构建**——地址差只在同一次链接里成立。这台机器上没有 `.pdb`/符号服务器那套，能用的就是"留档 exe + addr2line"。顺带把兜底工具的现实贴出来：MinGW 的 GCC 13.1 三个 sanitizer **全都链不上**，所以越界/UB/竞争只能靠 gdb 观察点和编译器警告兜：

```text
ld.exe: cannot find -lubsan: No such file or directory
ld.exe: cannot find -ltsan: No such file or directory
ld.exe: cannot find -lasan: No such file or directory
```

## 九、小结

- **工具选择先于技巧**：PATH 上的 gdb 7.8.1 连 GCC 13 的 exe 都打不开；`-ex` 会被 shell 拆坏；`-batch -x` 一条错误中止整个脚本——全路径 + `-x 脚本` 或 stdin 喂命令。
- **调试信息按用途分档**：`.text` 在 `-g0/-g3` 之间一字不变（6,832 字节）；`.o` 体积 324,938→540,064→718,464→797,512；exe 上 `-g1` 只比 `-g0` 大 2.4% 就够 `addr2line` 反查行号，`-g3` 多付 50.9% 买的是 75,678 字节的宏表。`strip -g` 之后行号即失效。**发布 `-g1`/`-g2` + `strip -g`，带符号产物留档。**
- **热点上没有免费断点**：命中 106µs、条件从不成立 151µs（更贵）、带打印 238µs、`dprintf` 162µs、Python 105µs、硬件观察点 76µs、软件观察点 6,033µs（46 倍）。循环里挂 10,000 次命中的打印断点 = 多 2.4 秒停顿，程序里的超时和心跳会一起变形。
- **观察点必须在 `run` 之后设**（否则按未重定位地址监视，10000 次写 0 次触发）；命中时显示的行不是赋值行，`Old value/New value` 才是凭据。
- **`-O2` 下 `<optimized out>` 9 处 vs `-O0` 0 处**，且逐变量决定；`static inline` 让一个断点变 3 个位置。浮点位模式要 `x/1fw` 或 `p/x *(int*)&f`：`p/x <float>` 给 0x0，`x/fx` 只打印一个字节。
- **多线程调试在这台机器上是残缺的**：`scheduler-locking` 不被 native target 支持、`non-stop` 运行期改不了，单步期间别的线程照跑；只剩"断点条件里带 `thread ==`"一条路。
- **反向调试本机不可用**（`record full` 报"架构不支持"），用 Python tracepoint 把轨迹落文件、离线重放是等效替代。
- **崩溃取证主线是退出码 + 地址换算**：`0xC00000FD`（爆栈）/`0xC0000005`（访问违例）；gdb 里 `handle SIGSEGV nostop noprint pass` 才拿得到原始状态码；无符号时用 `运行期 $pc − 运行期 .text 基址 + 链接期 .text 基址 → addr2line -f -i -C`。栈溢出场景认 `#0 ___chkstk_ms` + `bt` 行数，别用 `set backtrace limit` 把深度信息砍掉。
