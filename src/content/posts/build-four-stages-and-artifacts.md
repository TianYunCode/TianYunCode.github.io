---
title: 预处理、编译、汇编、链接
description: 实测：26 行源码预处理后变 2012 行/114685 字节（180 倍）；`-O2` 把 600 个函数从 62205 字节的 .o 压成 1480 字节（42 倍），可同一份小文件的 .o 反而比 -O0 大 29%——因为段从 7 个变成 10 个；`-ffinite-math-only` 把运行时的 `isnan()` 折成恒 0，而 `-Ofast` 走的是另一条路：它先把 `x/x` 简化成常量 1，NaN 根本不再产生。；`.txt` 后缀会被当成链接输入并以退出码 0 静默产出零个文件。
date: 2026-10-15
tags: [编译, 构建, GCC, MinGW]
category: build
section: build-four-stage
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，x86_64-posix-seh）**，一律全路径调用 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`、`g++.exe`、`nm.exe`、`objdump.exe`（PATH 上的 gcc 是 Strawberry Perl 的 4.9.2 32 位，不可用）；`bin/` 下另有 `mingw32-make.exe`、`gdb.exe`、`ar.exe`、`windres.exe`、`addr2line.exe`。**本机同期有其他任务在跑，绝对耗时偏大且区间很宽，因此本文优先给字节数、符号条数和比值；耗时项均为 5–7 次交替采样的中位数。**

## 一、四个阶段，四种产物

26 行 / 638 字节的 `probe.c`（含 `<stdio.h> <stdlib.h> <string.h>`），逐阶段拆开实测：

| 阶段 | 工具 | 输入 | 输出 | 本机大小 | 相对上一步 |
| --- | --- | --- | --- | --- | --- |
| 预处理 | `cc1` 内 cpplib | `probe.c` 638 B | `stage1.i` | **114685 B / 2012 行** | **180 倍** |
| 编译 | `cc1.exe` | `stage1.i` | `stage2.s` | 3877 B / 206 行 | 3.4% |
| 汇编 | `as.exe` | `stage2.s` | `stage3.o` | 1805 B | 47% |
| 链接 | `collect2`→`ld.exe` | `stage3.o` | `stage4.exe` | 77155 B | 43 倍 |

```bash
gcc -std=c17 -E probe.c -o stage1.i    # 只预处理
gcc -std=c17 -S stage1.i -o stage2.s   # 只编译（.i 输入＝不再预处理）
gcc -std=c17 -c stage2.s -o stage3.o   # 只汇编
gcc      stage3.o      -o stage4.exe   # 只链接
```

产物跑出来结果正确（`acc=4`），手工拆分没改变语义。**体积曲线的形状本身就是结论**：源码→`.i` 暴涨 180 倍（全是头文件），`.i`→`.s` 掉到 3.4%——你写的代码在输入侧占比极小，头文件才是主体。

`gcc -v` 打出驱动真正拉起的子进程，这是判断"谁在干活"的最短路径：

```text
 D:/Qt/Tools/mingw1310_64/bin/../libexec/gcc/x86_64-w64-mingw32/13.1.0/cc1.exe -quiet -v -iprefix ...
 D:/Qt/.../lib/gcc/x86_64-w64-mingw32/13.1.0/../../../../x86_64-w64-mingw32/bin/as.exe -v -o v_probe.o C:\Users\wangt\AppData\Lo...
```

链接期换成 `collect2.exe -plugin .../liblto_plugin.dll ...`，由它再拉 `ld.exe`。`libexec` 里是 `cc1.exe / cc1plus.exe / lto1.exe / lto-wrapper.exe / collect2.exe / f951.exe`——**`gcc`/`g++` 只是驱动，真正的编译器是 cc1/cc1plus**。

## 二、命令与后缀：哪条命令跑到哪一步为止

`-E` 停在预处理，`-S` 停在编译，`-c` 停在汇编，无 `-c` 走完全流程。**后缀名决定哪些阶段被跳过**：把展开好的 `stage1.i` 复制成 `copy.c` 和 `real.i`，各自 `-c`：

```text
.c 版（内容其实已展开）exit=0     .i 版 exit=0
.o sizes: copy.c->1972   real.i->1972
```

产物字节完全一致，但 `.c` 会被再预处理一遍（行号指令被重新解释），`.i` 直接进编译器。**`.i` 就是"别再预处理我"的声明**，`.ii` 是 C++ 版，`.s` 是"只汇编"，`.o` 是"只链接"。

未知后缀的后果很难看：

```text
$ gcc -c probe.txt -o t1.o
gcc.exe: warning: probe.txt: linker input file unused because linking not done
exit=0        ← 退出码 0，而且 t1.o 根本没生成
```

**未知后缀被当成链接输入**：一条 warning、退出码 0、零个产物。CI 里文件名拼错或后缀被脚本改掉，就会出现这种"绿了但什么都没构建"。显式指定语言才对：`gcc -x c -std=c17 -c probe.txt -o t2.o` → 1805 字节。

两个 Windows 专属坑。其一，Git Bash 把 `/dev/null` 译成 Windows 的 `nul`，`cc1` 写 `.s` 时没事，一到 `as` 就炸：

```text
$ gcc -std=c17 -O2 -c probe.c -o /dev/null
Assembler messages:
Fatal error: can't create nul: Invalid argument
```

想丢弃输出请用真实临时文件或 `-fsyntax-only`。其二，默认中间 `.s` 落在 `%TEMP%` 且**失败即删**，所以留产物要用 `-save-temps=cwd`（本机得到 `probe.i 115357 / probe.s 2915 / probe.o 1972`）——这也解释了第四节"汇编器在 `ccXXXX.s` 里报错"为什么难查。

## 三、`-ftime-report` 与 `-H`：钱花在哪个阶段

小文件 `probe.c`（26 行 + 3 个头）与 `heavy.c`（1806 行、600 个 `static` 函数 + 600 个宏、无额外头）并排：

```text
 probe.c                              heavy.c
 phase setup            : 0.01 (  9%)  1532k ( 38%)   phase setup            : 0.01 (  4%)  1532k ( 11%)
 phase parsing          : 0.08 ( 63%)  2044k ( 51%)   phase parsing          : 0.07 ( 37%)  4266k ( 30%)
 phase opt and generate : 0.03 ( 27%)   408k ( 10%)   phase opt and generate : 0.11 ( 59%)  8487k ( 59%)
 preprocessing          : 0.06 ( 52%)   496k ( 12%)   preprocessing          : 0.05 ( 26%)   784k (  5%)
 TOTAL                  : 0.12         3986k          TOTAL                  : 0.19           13M
```

读这张表必须先知道：**括号里的百分比不该相加**。`preprocessing` 是 `phase parsing` 的子项，63% + 52% = 115% 是正常输出，不是 bug。两表对比：小文件 parsing 63% / opt 27%，大文件 parsing 37% / opt 59%——**头文件多的 TU 钱花在解析，逻辑多的 TU 钱花在优化**。

`-H` 是配套工具，打印包含树（`.` 的个数＝嵌套深度），第一行就暴露打开的真实路径（`. stdio.h` / `.. corecrt_stdio_config.h` / `... corecrt.h` …）。`probe.c` 实际**打开 30 次、25 个不同头文件**，而源码只写了 3 行 `#include`。排查"改了头文件没生效"，这条命令比什么都快。

## 四、四个阶段的报错长得完全不一样

分阶段的价值在排错上最明显——**每条诊断的署名就告诉你该改哪里**。五个故意写坏的文件，原文照贴（全部 `exit=1`）。

预处理（找不到头）：

```text
e1_preproc.c:1:10: fatal error: no_such_header_xyz.h: No such file or directory
    1 | #include "no_such_header_xyz.h"
      |          ^~~~~~~~~~~~~~~~~~~~~~
compilation terminated.
```

`compilation terminated.` 是预处理失败的签名：编译器根本没看到任何代码，此时去改语法是白费力气。

编译·语法：

```text
e2_syntax.c: In function 'main':
e2_syntax.c:2:3: error: expected ',' or ';' before 'return'
    2 |   return a; }
      |   ^~~~~~
```

编译·语义（信息量最大的一条，注意最后两行）：

```text
e3_sema.c:2:40: warning: initialization of 'int' from 'char *' makes integer from pointer without a cast [-Wint-conversion]
e3_sema.c:2:57: error: too many arguments to function 'strlen'
    2 | int main(void){ char *p = "x"; int n = p; p = n; return strlen(p, n); }
      |                                                         ^~~~~~
In file included from e3_sema.c:1:
D:/Qt/Tools/mingw1310_64/x86_64-w64-mingw32/include/string.h:64:18: note: declared here
```

`In file included from ... string.h:64:18: note: declared here`——GCC 连声明出处都指出来了。**看到"参数个数/类型不对"就顺着 `note:` 去读那份系统头里的原型**，比自己猜快一个数量级；方括号里的 `[-Wint-conversion]` 是可直接 grep 手册的选项名。

汇编（只有内联汇编能触发，签名突变）：

```text
C:\Users\wangt\AppData\Local\Temp\ccXZ40Ij.s: Assembler messages:
C:\Users\wangt\AppData\Local\Temp\ccXZ40Ij.s:18: Error: bad register name `%nosuchreg'
```

三点：`Error:` 首字母大写（GNU as 风格，`cc1` 全用小写 `error:`）；文件名是 `ccXXXX.s` 临时文件；**行号是 `.s` 的行号，不是你 `.c` 的行号**。唯一可行路径是 `-save-temps` 留下 `.s` 再看第 18 行。

链接（前三个阶段全部静默通过）：

```text
ld.exe: C:\Users\wangt\AppData\Local\Temp\ccGSk507.o:e5_link.c:(.text+0xe): undefined reference to `never_defined_anywhere'
collect2.exe: error: ld returned 1 exit status
```

`(.text+0xe)` 是"未定义引用落在该 `.o` 的 .text 偏移 0xe"，第二行是驱动在转述链接器退出码。**这条错误里没有一行你的源码**，因为它不是源码层问题——那是下一节（目标文件、段与符号表）的主题。

## 五、优化级别：`.o` 大小不是单调的

同一份 12 行的 `opt.c`（求平方和循环 + `main`）：

| 级别 | `.o` 字节 | 指令条数 | 代码字节 | 段数 | `nm` 符号行 | `xmm` 引用 |
| --- | --- | --- | --- | --- | --- | --- |
| `-O0` | 1381 | 80 | 304 | 7 | 13 | 0 |
| `-O1` | **1257** | 51 | 192 | 7 | 13 | 0 |
| `-O2` | **1788** | 70 | 320 | 10 | 16 | 22 |
| `-O3` | 1768 | 82 | 352 | 10 | 16 | 17 |
| `-Os` | 1618 | 42 | 192 | 10 | 16 | 0 |
| `-Ofast` | 1768 | 82 | 352 | 10 | 16 | 17 |

（指令条数是启发式计数：`.s` 里以助记符开头且非 `.` 开头的行；代码字节 = `.text` + `.text.startup`。）

**`-O2` 的 `.o` 比 `-O0` 大 29%，指令反而更少（70 vs 80）**。`objdump -h` 把账摊开：段从 7 个变成 10 个。

```text
--- O0 (.o=1381) ---                    --- O2 (.o=1788) ---
  .text                 304               .text                 128
  .xdata                 36               .rdata                 48
  .pdata                 36               .xdata                 12
  .rdata                 16               .pdata                 24
  .rdata$zzz             80               .text.startup         192
  TOTAL                 472               .xdata.startup          8
                                          .pdata.startup         12
                                          .rdata$zzz             80
                                          TOTAL                 504
```

`-O2` 打开了 `-freorder-blocks-and-partition`，把 `main` 拆进独立的 `.text.startup`（冷热分区），异常展开表跟着分裂成 `.xdata.startup`/`.pdata.startup`。于是段内容只涨 32 字节（472→504），`.o` 却涨 **407 字节**：扣掉段内容，**结构开销从 909 涨到 1284**，多出的 3 个段每个约值 122 字节（40 字节 COFF 段头 + 各自一套重定位 + 段名符号）。`-O1` 与 `-Os` 代码字节都是 192、段内容 348 vs 344 几乎相同，`.o` 却差 361 字节——差的完全是段数（7 vs 10）。

**所以 `.o` 体积同时含"代码成本"和"结构成本"，不能当优化收益的代理指标。**

优化真正的暴力程度要用 `heavy.c` 才看得见（600 个静态函数，`main` 里全是 `f<i>(3)`）：`-O0` → `-O2` 的 `.o` 从 **62205 B 降到 1480 B（42.0 倍）**，`nm` 行数 612 → 15，`nm` 里的 `static` 函数 **600 → 0**（全部被折叠成一个常数），指令 6772 → 24 条。这既说明优化很凶，也说明**符号表是最诚实的观测面**。

`-Ofast` 与 `-O3` 在这份代码上字节数相同（1768），差别只在浮点语义。三个编译开关、同一份源码、同一输入 `x = 0`（`x` 从 `argv[1]` 取）：

```text
=== [-O2] x=0 ===                    === [-O2 -ffinite-math-only] ===   === [-Ofast] ===
A: isnan(x/x)          = 1            A: isnan(x/x)          = 0         A: isnan(x/x)          = 0
B: (x*1e20)*1e20       = 0            B: (x*1e20)*1e20       = 0         B: (x*1e20)*1e20       = nan
C: x*(1e20*1e20)       = nan          C: x*(1e20*1e20)       = 0         C: x*(1e20*1e20)       = nan
```

但 `A` 那一行**不能读成"`isnan()` 被删了"**。我另写一份程序，用两种编译器证明不了的来源造真 NaN（`sqrt(-1.0)` 与 `0.0/0.0`，经 `volatile` 中转），结果是：

```text
=== 独立复核：NaN 来源不是 x/x，而是 sqrt(-1.0) / 0.0/0.0 ===
-O2                        编译期常量 NaN：isnan=-1  v!=v=1    运行期 NaN：isnan=-1  v!=v=1
-Ofast                     编译期常量 NaN：isnan=-1  v!=v=0    运行期 NaN：isnan=-1  v!=v=0
-O2 -ffinite-math-only     编译期常量 NaN：isnan= 0  v!=v=0    运行期 NaN：isnan= 0  v!=v=0
```

机制要分开讲，三条检测各有失效条件：

1. **`isnan(x/x)` 在 `-Ofast` 下变 0，不是 `isnan` 被删，而是 `x/x` 被 -funsafe-math 简化成了常量 `1`**——被改掉的是表达式，不是检测。同一个 `-Ofast` 下，`sqrt(-1.0)` 这种编译器无从简化的真 NaN，`isnan()` 仍然返回 true。
2. **单独加 `-ffinite-math-only` 才是真的把 `isnan()` 折成 `0`**：上表最后一行，编译期和运行期取到的 NaN 全都报"不是 NaN"。`-Ofast` 包含这个选项，却因为它对表达式的先行简化，让 `isnan(x/x)` 与 `isnan(v)` 表现出不同结果——**同一个"删除"，路径不一样**。
3. **`v != v` 这个手写 NaN 检测在两个开关下都恒为 false**（`-Ofast` 那一行就是它）。所以"我不写 isnan，我写 `x != x`"并不是逃生路，它失效得更早。

结论比"isnan 被删"更不友好：**浮点语义开关影响的不是某个函数，而是整个"NaN 可被检测"这一前提**。项目里请只写 `-O2`/`-O3`，浮点开关单独评审；真要用 `-Ofast`，就得同时接受"错误传播路径被重写"，并把 NaN 检测改成哨兵值/返回码这类整型手段。

## 六、调试信息：`-g` 的档位差是 21 倍

`probe.c` 固定 `-O2`，只变 `-g`：

| 选项 | `.o` 字节 | 相对 `-g0` | 给什么 |
| --- | --- | --- | --- |
| `-g0` | 1972 | 1.00× | 无 |
| `-g1` | 4269 | 2.16× | 行号＋外部符号（够 `addr2line`） |
| `-g2`（即 `-g`） | 7252 | 3.68× | ＋类型、变量位置 |
| `-g3` | **41988** | **21.3×** | ＋宏定义 |

**Release 构建留 `-g`（= -g2）通常是净收益**：只涨 `.o`，不影响可执行文件加载性能，而线上崩溃缺符号的代价大得多。`-g3` 只在"要 gdb `print` 一个宏"时才值那 21 倍。本机 GCC 13.1 在 PE/COFF 上也接受 DWARF 分包：`-g -gsplit-dwarf` 把 `.o` 从 7252 降到 5317，另产 3316 字节的 `.dwo`。**但本节只验证了它能产出两个文件，没验证 GDB 能否完整读回**（MinGW 上这条路支持不完整，未实测）。

## 七、预处理占多少：一个被进程启动掩盖的事实

绝对值不可信，所以三种 TU **交替**采样 7 轮，让它们面对同一负载：

```text
任务                     中位数ms        区间ms      相对 empty
empty.c(0 头文件)          153.7   152.9-  207.5      1.00x
mini1.c(stdio 1个)         199.1   175.2-  244.6      1.30x
probe.c(3 头文件)          205.9   196.5-  368.5      1.34x
```

对应预处理产物：97 B → 61031 B → 114685 B。**输入涨了 1180 倍，编译时间只涨 1.34 倍**——因为 153.7ms 里大部分是驱动 + `cc1` + `as` 三次进程启动的固定开销（`gcc -dumpversion` 单独计时中位数 55.4ms，就是驱动启动的下限）。

拆阶段（5 次中位数，`probe.c`）：`-E` 156.7ms (138.1–239.1)、`-S`（输入 `.i`）122.8ms (121.2–145.6)、`-c`（输入 `.i`）183.4ms (163.4–198.6)、`-c` 一步 233.2ms (202.4–272.9)、链接 296.5ms (274.1–329.1)。一步 233.2 − 从 `.i` 编译 122.8 ≈ 110ms 花在预处理，**约占一步的 47%**；按 `-E` 减掉 55ms 启动下限算是 67%。两个口径都在 50% 上下，**"头文件是编译时间主因"在大工程成立，在单文件小实验里会被进程启动开销掩盖**。

于是试了 GCC 原生 PCH。`gcc -c pch.h -o pch.h.gch` 产出 3728997 字节（0.35s），实测：**打开头文件次数 用 PCH 0 次 vs 无 PCH 30 次**（`-H` 里 `stdio.h` 出现次数归零），中位耗时 209.9ms (201.9–479.3) vs 218.4ms (213.2–288.9)，**产物字节 with=1805 / without=1805**。

**30 次打开归零是真实生效的**，但单 TU 的时间差完全落在噪声里（区间大幅重叠），`.o` 一字节不差。PCH 的收益要在"同一大头集合重复编译 N 次"时才显现，本机这个规模测不出来——**这里能被验证的是"文件打开次数归零"和".o 字节不变"，而不是"快了 x%"**。（本机无 `ccache`、无 clang、无 LLD/mold、无分布式编译环境，也非 Linux，这些手段的比较本节未实测。）

## 小结

- **四阶段体积是"暴涨—暴跌"曲线**：638 B → 114685 B（180 倍）→ 3877 B → 1805 B → 77155 B。输入侧成本全在头文件，输出侧 43 倍于 `.o` 的是运行时与库。
- **后缀决定跳过哪些阶段**：`.i`＝别预处理，`.s`＝只汇编，`.o`＝只链接；未知后缀被当链接输入，**warning 一条、退出码 0、零产物**，用 `-x c` 兜住。
- **诊断的署名定位阶段**：`compilation terminated.`＝预处理；小写 `error:`＋源码回显＝编译；大写 `Error:`＋`ccXXXX.s`＝汇编；`undefined reference`＋`collect2.exe: error: ld returned 1`＝链接。`note: declared here` 会把你送到系统头的具体行。
- **`-ftime-report` 的百分比不能相加**（子阶段有包含关系）；小文件 parsing 63%、大文件 opt 59%。
- **`.o` 体积含结构成本**：`-O2` 比 `-O0` 大 29% 却少 10 条指令，段数 7→10，每段约 122 字节开销；`-O1`/`-Os` 代码相同而 `.o` 差 361 字节。反面是 600 个静态函数被 `-O2` 压掉 **42 倍**、静态符号 600→0。
- **NaN 检测会被浮点开关逐条拆掉**：`-ffinite-math-only` 把 `isnan()` 折成恒 0；`-Ofast` 走的是另一条路——它先把 `x/x` 简化成常量 `1`（NaN 根本不再产生），而 `v != v` 这种手写检测在两者下都恒为 false。只用 `-O2`/`-O3`，浮点开关单独评审。
- **`-g1/-g2/-g3` 相对 `-g0` 是 2.16/3.68/21.3 倍**，Release 留 `-g2` 通常净赚。

下一节进入目标文件本身：COFF/PE 的段表、`.text/.data/.bss/.rdata` 各装什么、强符号与弱符号如何决定链接结果，以及 `nm`/`objdump` 的实战读法。
