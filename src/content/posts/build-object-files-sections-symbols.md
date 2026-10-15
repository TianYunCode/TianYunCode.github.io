---
title: 目标文件、段与符号表
description: 实测：1 MiB 未初始化数组和 1 字节的 .o 一样大（都是 748 字节，.bss 不占文件一字节），而 1 MiB 已初始化数组的 .o 是 1049324 字节；MinGW 的 .exe 尾部留着整套 COFF 符号表，strip 前后 97456→52224、157541→54272；只有弱定义时链接直接报 undefined reference；`-fno-common` 下 `int shared;` 是强符号 `B`，`-fcommon` 下才是 `C`。
date: 2026-10-15
tags: [目标文件, COFF, 符号表, nm, objdump]
category: build
section: build-object
---

> 环境：Windows 11 x64，GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/gcc.exe`、`g++.exe`）+ binutils 2.39（同目录 `nm.exe`、`objdump.exe`、`ar.exe`、`strip.exe`、`strings.exe`、`addr2line.exe`）。命令一律用全路径，PATH 上的 gcc 是 Strawberry Perl 4.9.2 32 位，不可用。本文的字节数、段数、符号条数全部本机实测且与 CPU 负载无关；报错文本原样粘贴。**ELF 侧（`readelf`、Linux 段名与 symbol versioning）本机没有 ELF 目标环境，未实测，见第七节说明。**

## 一、先承认：本机读的是 PE/COFF，不是 ELF

`objdump -f` 一眼给出容器格式与标志位：

```text
obj.o:          file format pe-x86-64   flags 0x00000039: HAS_RELOC, HAS_DEBUG, HAS_SYMS, HAS_LOCALS
e_nosplit.exe:  file format pei-x86-64  flags 0x0000013b: HAS_RELOC, EXEC_P, HAS_DEBUG, HAS_SYMS, HAS_LOCALS, D_PAGED
                start address 0x00000001400013f0
```

三个可读信息：**`.o` 是 `pe-x86-64`、`.exe` 是 `pei-x86-64`**（OBJ 与 IMAGE 两种 COFF 变体）；`.o` 没有 `EXEC_P`/`D_PAGED`，且 `start address` 为 0——**重定位前的目标文件没有地址概念**；可执行文件的起始地址 `0x1400013f0` 里，`0x140000000` 是 MinGW 默认的 image base。

顺手把"用错工具"的现场留着：

```text
$ readelf -h obj.o
readelf: Error: Not an ELF file - it has the wrong magic bytes at the start
```

（本机 `readelf` 只存在于被禁用的 Strawberry Perl 里。）**Windows 上不要指望 `readelf`**，`objdump -h / -t / -x / -r / -s` 加 `nm` 覆盖了你需要的全部信息。COFF 头里的关键字段也可以直接读出来核对（下面就是这样拿到 `1211` 这个权威段数的）：

```python
import struct
d = open("lib_split.o", "rb").read()
struct.unpack_from("<H", d, 2)[0]    # NumberOfSections = 1211
```

## 二、C 构造 → 段：一张实测对照表

一份把各种构造逐个摊开的 `obj.c`（26 行、5 个函数），`gcc -std=c17 -O0 -fno-common -c`，得到 **1974 字节的 `.o`，7 个段，`nm` 27 行**：

```text
Idx Name          Size      File off  属性
  0 .text         000000e0  0000012c  CONTENTS, ALLOC, LOAD, RELOC, READONLY, CODE
  1 .data         00000050  0000020c  CONTENTS, ALLOC, LOAD, RELOC, DATA
  2 .bss          00000010  00000000  ALLOC
  3 .xdata        0000003c  0000025c  CONTENTS, ALLOC, LOAD, READONLY, DATA
  4 .pdata        00000048  00000298  CONTENTS, ALLOC, LOAD, RELOC, READONLY, DATA
  5 .rdata        00000040  000002e0  CONTENTS, ALLOC, LOAD, READONLY, DATA
  6 .rdata$zzz    00000050  00000320  CONTENTS, ALLOC, LOAD, READONLY, DATA
```

段名到语义的映射，用 `nm obj.o` 验证（**大写=外部可见，小写=文件内 static**）：

| 源码构造 | `nm` 行 | 落到的段 |
| --- | --- | --- |
| `int g_init = 42;` | `0000...0000 D g_init` | `.data`（首字节实测 `2a`） |
| `int g_arr[4] = {1,2,3,4};` | `0000...0010 D g_arr` | `.data`（`01 00 00 00 02 ... 04`） |
| `char g_msg[] = "hello-char-array";` | `0000...0030 D g_msg` | **`.data`**（非 const，可写） |
| `int g_uninit;` | `0000...0000 B g_uninit` | `.bss` |
| `static int s_file_init = 9;` | `0000...0020 d s_file_init` | `.data`，小写 d |
| `static int s_file_uninit;` | `0000...0004 b s_file_uninit` | `.bss`，小写 b |
| `const int g_const = 7;` | `0000...0000 R g_const` | **`.rdata`** |
| `static const char s_str[] = "hello-static-array";` | `0000...0010 r s_str` | `.rdata` |
| `printf("%d\n", ...)` 的格式串 | 无符号 | `.rdata` 偏移 `0x31`：`2564 0a` = `"%d\n"` |
| `void func_plain(void) {}` | `0000...0054 T func_plain` | `.text` |
| `static void func_static(void) {}` | `0000...005b t func_static` | `.text`，小写 t |
| `static int s_local_init = 5;`（函数内） | `0000...0044 d s_local_init.0` | `.data`，**符号名带 `.0` 后缀** |

三条容易记错的：

1. **`const` 决定段，不是"全局/局部"决定段**：`const int g_const` 进 `.rdata`（`R`），而 `char g_msg[] = "..."` 因为类型不是 const 指针也不是 const 数组，整个进 `.data`（`D`）——想让它只读要写 `static const char g_msg[]`。
2. **函数内 `static` 变量和普通文件作用域变量同段**，只是符号名被加了 `.0`/`.1` 序号避免撞名（`s_local_init.0`、`s_local_uninit.1`），所以 `nm | grep` 时不要按精确名匹配。
3. **`.rdata$zzz` 是编译器身份串**，内容是 `GCC: (x86_64-posix-seh-rev1, Built by MinGW-Builds project) 13.1.0`。它让 `.o` 每次换编译器就变，也白占 80 字节 + 一个段：

```text
带 ident  : .o=1974  段数=7   .rdata$zzz 有 "GCC"
-fno-ident: .o=1796  段数=6   .rdata$zzz 不存在
```

**`-fno-ident` 省 178 字节和 1 个段**——单看不值，但它是可复现构建的第一颗钉子（`__DATE__`/`__TIME__` 是另外两颗）。

## 三、`.bss` 真的不占文件字节

`.bss` 那行的 `File off` 是 `00000000`，属性里**只有 `ALLOC`，没有 `CONTENTS`、没有 `LOAD`**。这就是"运行时清零、文件里不存在"的机器可读证据。定量验证：

| 源文件 | `.o` 字节 | `.bss` 段大小 | 文件偏移 |
| --- | --- | --- | --- |
| `char big[1];` | **748** | `00000010`（16） | `00000000` |
| `char big[1048576];` | **748** | `00100000`（1 MiB） | `00000000` |
| `char big[1048576] = {1};` | **1049324** | — | 有 CONTENTS |

**未初始化数组从 1 字节涨到 1 MiB，`.o` 一个字节都不变（748 = 748）**；同一数组加个 `= {1}`，`.o` 变成 1049324 字节。这是本节最该记住的一组数字：它解释了为什么"忘写初值"不会让产物变大，但会让**加载后的内存**变大；也解释了为什么把大缓冲区塞进 `.data`（哪怕全零）是纯粹浪费。

## 四、`.pdata` / `.xdata`：Windows 独有的两个段

Linux 侧没有这两个段，它们是 PE 的 **SEH 展开表**（`pdata` = unwind info directory，`xdata` = 每个函数的展开记录），C 也要生成：`obj.c` 只有 5 个函数（26 行源码），`.pdata` 就占 0x48=72 字节、`.xdata` 0x3c=60 字节。它们还是重定位的主要消费者——`objdump -r obj.o` 的 27 条重定位里，**`.pdata` 占 18 条，`.text` 8 条、`.data` 1 条**，三分之二的重定位在为展开表服务。

实际后果：**"每个函数一段"这类拆分在 Windows 上代价更高**。`-ffunction-sections` 让每个函数拖出 `.text$`/`.xdata$`/`.pdata$` 三段（前 6 个就是 `.text$printf / .xdata$printf / .pdata$printf / .text$dead_0 …`）。200 used + 200 dead + `main` 的 402 个 `.text$` 段符号，实测：

| | 不加 `-ffunction-sections` | 加 | 倍数 |
| --- | --- | --- | --- |
| `.o` 字节 | 34349 | 166311 | **4.84×** |
| COFF 头里的 `NumberOfSections` | 7 | **1211** | 173× |
| `nm` 行数 | 412 | 1616 | 3.92× |

1211 这个数字要用 COFF 头（或 `objdump -h | grep -c`）核对，**不要凭肉眼数 `-h` 的输出**——`-h` 在这里确实列全了 1211 行，但每段占两行（第二行是属性），我用 `'^ +[0-9]+ '` 去数只得到 100，差点把结论写成"`objdump` 会截断段表"。工具输出条数和对不上的量，先去文件头里找权威值。

## 五、符号表读法：`nm` 的字母 + COFF 的存储类

`nm` 常用四连：

```text
$ nm -u obj.o                       ← 只看未定义，链接排错第一动作
                 U __imp___acrt_iob_func
                 U __main
                 U __mingw_vfprintf
$ nm --defined-only --extern-only obj.o   ← 只看"我能对外提供的"
0000000000000071 T func_locals   ...   00000000000000b7 T main
$ nm -C mm.o                        ← C++ 修饰名还原
0000000000000000 T n::A::m(int, double)     （原始名 `_ZN1n1A1mEid`，12 字符）
```

`nm` 字母表（本机全部取到实例）：`T` 外部代码 / `t` 内部代码 / `D` 外部已初始化数据 / `d` 内部 / `B` 外部 `.bss` / `b` 内部 / `R r` 只读数据 / **`C` common（见第六节）** / `U` 未定义 / `w W` 弱。

Windows 特色是 `U __imp___acrt_iob_func`：**`__imp_` 前缀是导入 thunk**，你在 `.o` 里引用的是它而不是 `printf` 本身。更反直觉的是 `0000000000000000 t printf` 这一行——每个调用 `printf` 的 `.o` 里都有一个 **`t`（内部）的 `printf` 位于 `.text` 偏移 0**，那是 MinGW 生成的导入跳板桩，不是 libc 的实现。看到 `nm` 里的 `t printf` 别以为自己的 `.o` 定义了 `printf`。

COFF 的存储类在 `objdump -t` 里（`scl 2` = `C_EXT` 外部，`scl 3` = `C_STAT` 静态），和 `nm` 的大小写正好对应：

```text
[  7](sec  1)(ty 20)(scl 2) 0x...0054 func_plain     ← 外部函数，段号 1 = .text
[  8](sec  1)(ty 20)(scl 3) 0x...005b func_static    ← 静态函数
[ 14](sec  1)(scl 3)(nx 1) 0x...0000 .text  AUX scnlen 0xe0 nreloc 8   ← 段长度/重定位条数在这
```

`AUX` 行还给出每段的 `scnlen` 与 `nreloc`——想知道段为什么是 40 字节一份的开销，就在这里数。

## 六、强符号与弱符号：MinGW 的实现和 ELF 不一样

**同一名字的两个强定义**是硬错误：

```text
ld.exe: w3.o:w3.c:(.text+0x0): multiple definition of `pick'; w2.o:w2.c:(.text+0x0): first defined here
collect2.exe: error: ld returned 1 exit status
```

COFF 本身没有原生 weak 符号，GCC 用别名模拟。`nm`/`objdump -t` 看得很清楚：

```text
0000000000000000 T strong_fn
000000000000000b T .weak.weak_fn.strong_fn        ← 别名：弱定义，后备是 strong_fn
                 w weak_fn
[ 18](sec 0)(scl 105) 0x0000000000000000 weak_fn  ← scl 105 = C_WEAKEXT，sec 0 = 无段
```

于是有三种真实行为，全部实测（`pick` 的定义分别是弱、强、弱+强）：

| 参与链接的目标 | 结果 |
| --- | --- |
| 只有弱定义 `w1.o` | **失败**：`ld.exe: wm.o:wmain.c:(.text+0x62): undefined reference to 'pick'` |
| 弱 + 强，弱在前（`w1.o w2.o`） | 通过，运行输出 `pick=200` |
| 弱 + 强，强在前（`w2.o w1.o`） | 通过，运行输出 `pick=200` |
| 两个强定义（`w2.o w3.o`） | 失败，`multiple definition`（上面原文） |

关键差异：**MinGW 上"只给弱定义"不能满足一个强引用**，链接直接失败；ELF 上弱定义是可以顶上的。而"强存在时强胜出、与顺序无关"这条两边一致。所以想把某个函数做成"可被覆盖的默认实现"，在 Windows/MinGW 上必须同时提供一个强备选（就是那个 `.weak.<弱>.<强>` 别名的用途），否则链接期就断。

**试探性定义（tentative definition）是 ODR 类错误的常见来源**：两个 `.c` 各写一行 `int shared;`（没初值）。

```text
[默认 = -fno-common]  td1.o: 0000000000000000 B shared      ← 强符号
                       ld.exe: td2.o:td2.c:(.bss+0x0): multiple definition of `shared';
                               td1.o:td1.c:(.bss+0x0): first defined here
[-fcommon]            tdc1.o: 0000000000000004 C shared     ← common 符号，可合并
```

**`nm` 里 `B` 与 `C` 的一字之差就是"能不能重复定义"**。GCC 10 起默认 `-fno-common`，所以老工程升编译器会突然冒出成片的 `multiple definition of ...`——那是真 bug（两个 TU 各自以为拥有一个变量），正确修法是 `.c` 里定义一次、`.h` 里 `extern` 声明。附带成本：同一份 `td1.c` 的 `.o` 在 `-fcommon` 下是 859 字节、`-fno-common` 下 759 字节。

## 七、链接产物里还留着符号表：`strip` 的量级

Windows 上 `nm` 能直接读 `.exe`，因为 `ld` 把整套 COFF 符号表留在文件尾部：

```text
$ nm e_nosplit.exe | wc -l      1344
$ nm e_gc.exe      | wc -l      2436
```

对应的体积代价（`strip` 前后）：

| 链接方式 | `.exe` 原始 | `strip` 后 | 符号表占 |
| --- | --- | --- | --- |
| 普通 `-O0` | 97456 | 52224 | **45232 B（46%）** |
| `-ffunction-sections --gc-sections` | 157541 | 54272 | **103269 B（66%）** |

`strip` 后两个都还能正常跑（都输出 `19900`），`nm` 变成 `no symbols`。**"我的 exe 为什么比代码大 100 倍"在 MinGW 上的第一答案就是这段尾巴，`strip` 直接砍掉 46–66%。**

顺带回填上一节留的坑：`-ffunction-sections -Wl,--gc-sections` 在 `-O0` 下不但没瘦身，`.exe` 反而从 97456 涨到 157541——因为**多出来的全是符号表**（`.text$dead_0` 这类段符号每个都要在符号表里登记），`--gc-sections` 删掉的代码只有 3523 字节（161064→157541）。**Windows 上想让 `--gc-sections` 真见效，必须配合 `-O1` 以上的静态化（`static`）或 LTO；单靠它在 `-O0` 是负收益。**

**本节未在本机实测的部分**：ELF 侧的 `readelf -S/-s`、`.symtab` 与 `.dynsym` 的分离、`objdump -T` 动态符号表、symbol versioning（`.symver`/版本脚本）、`--build-id`、`nm -D`，以及 MSVC 的 COFF 变体（`dumpbin /symbols`、`/FUNCTION:SECTIONS`、debug directory）。本机没有 ELF 目标环境（无 WSL、无交叉工具链），也没有 MSVC 和 `clang`；PE 侧的结论不能直接搬到 Linux 上，尤其第六节的弱符号语义**在 ELF 上行为不同**。

## 小结

- **先认清容器**：`.o` = `pe-x86-64`，`.exe` = `pei-x86-64`；`readelf` 在 Windows 上是错的工具（原文报错 `it has the wrong magic bytes at the start`）。
- **`.bss` 零文件成本**：未初始化数组 1 B 和 1 MiB 的 `.o` 都是 **748 字节**，`.bss` 只有 `ALLOC` 没有 `CONTENTS`；加个 `= {1}` 立刻变 **1049324 字节**。
- **`const` 决定进 `.rdata` 还是 `.data`**，不是"是不是全局"决定；`char g_msg[] = "…"` 落在 `.data`。
- **段有固定开销**：`.rdata$zzz`（编译器身份串）值 80 字节 + 1 段，`-fno-ident` 省 178 字节；`-ffunction-sections` 让 402 个函数把段数推到 **1211**、`.o` 涨 **4.84 倍**。
- **`nm` 字母就是段归属**（`T/t/D/d/B/b/R/r/U/C/w`），`nm -u` 是链接排错第一动作；`t printf` 是导入桩不是实现，`__imp_` 前缀才是 Windows 导入 thunk。
- **强弱符号**：两个强定义 = `multiple definition of 'x'; ... first defined here`；MinGW 上**只有弱定义会直接 `undefined reference`**，弱+强则强胜出且与顺序无关。
- **`int shared;` 在 `-fno-common`（GCC 10+ 默认）下是 `B`（强）**，`-fcommon` 下才是 `C`；老工程升级编译器批量报错是真实 bug，修法是一处定义 + 头文件 `extern`。
- **`.exe` 尾部藏着符号表，占 46%–66%**；`strip` 后仍可运行。

下一节进入 Makefile：规则与依赖图、自动变量与模式规则、伪目标与增量构建，以及"改一个头文件为什么全量重编"的机器可解版本（`-MMD -MP`）。
