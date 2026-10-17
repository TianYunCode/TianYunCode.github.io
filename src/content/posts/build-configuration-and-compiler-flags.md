---
title: 构建配置与编译选项：警告集、优化档、标准版本，以及那些在本机是空操作的开关
description: 实测：同一份源码默认零警告、-Wall 报 1 条、-Wall -Wextra 2 条；警告开关最后一个赢；-std 档位读回与 -fshort-wchar 在本机是空操作。
date: 2026-10-16
tags: [编译构建, 编译选项, GCC, 优化级别, ABI]
category: build
section: build-options
---

> 环境：Windows 11 x64，**GCC/G++ 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/`）**，`objdump`/`nm` 同目录。这一节所有数字都是**确定性**的：警告条数、退出码、`__STDC_VERSION__`/`__cplusplus` 宏值、`.text` 与 `.debug*` 段字节数、目标文件格式串。唯一的例外是第一节的 `-Werror` 计时（不涉及）。前两节讲过的机制（优化级别让 `.o` 大小非单调、`strip` 的量级、链接扫描顺序）只引用不重测。

## 一、警告集是"层层加严"的，而 `-Werror` 的开关顺序有讲究

一份故意留了三类问题的源码：函数里一个没用的局部变量、一个遮蔽外层变量的内层声明、一个没用的 `argc`。

| 选项 | 警告条数 | 退出码 |
| --- | --- | --- |
| （不加任何 `-W`） | **0** | 0 |
| `-Wall` | 1 | 0 |
| `-Wall -Wextra` | 2 | 0 |
| `-Wall -Wextra -Wshadow` | **3** | 0 |
| `-Wall -Werror` | —— | **1**，原文 `w.c:6:9: error: unused variable 'hidden' [-Werror=unused-variable]` |
| `-Wall -Werror -Wno-unused-variable` | —— | **0** |

三条规矩：

1. **默认什么都不报**，`-Wall` 不是"所有警告"而是"一大组常用警告"，`-Wextra` 再补一组，`-Wshadow` 这类连 `-Wextra` 都不含（本机实测：加它才出第三条）。
2. **`-Werror` 的报错原文保留 `[...]` 尾巴**，里面就是"要关掉它该写哪个 `-Wno-` 开关"——`[-Werror=unused-variable]` 对应 `-Wno-unused-variable`。这是唯一可靠的读法，不要去猜。
3. **同类开关"最后一个赢"**：`-Werror` 之后再写 `-Wno-unused-variable`，那一类就不再生死（实测退出码 1→0）。所以 `CMAKE_C_FLAGS` 后面追加的 `-Wno-...` 能推翻前面 `-Werror` 的效果，反过来把 `-Werror` 放最后则又赢回来。**门禁脚本里"标志顺序"就是策略本身。**

顺带一条 Windows 特有误判：想丢掉编译输出去写 `-o /dev/null` 或 `-o nul`，两者**都失败**：

```text
Assembler messages:
Fatal error: can't create nul: Invalid argument
```

汇编器把"nul"当普通文件名处理，而它是保留设备名。**要丢弃输出就写真实的临时文件**，或者用 `-fsyntax-only`（只做语法检查，不产出文件）。

## 二、语言标准档：宏值读回来，比记文档靠谱

C 侧（`gcc -std=…`，全部 rc=0）：

| `-std` | `__STDC_VERSION__` 读回 |
| --- | --- |
| `c89` | **这个宏根本不存在**（C89 时代还没有它） |
| `c99` | `199901L` |
| `c11` | `201112L` |
| `c17` | `201710L` |
| `c2x` | `202000L` |

C++ 侧（`g++ -std=…`）：

| `-std` | `__cplusplus` 读回 |
| --- | --- |
| `c++11` | `201103L` |
| `c++14` | `201402L` |
| `c++17` | `201703L` |
| `c++20` | `202002L` |
| `c++23` | **`202100L`** |
| `c++2c` | rc=1，原文 `g++.exe: error: unrecognized command-line option '-std=c++2c'` |

两条实用结论：

- **`-std=c89` 下没有 `__STDC_VERSION__`**，所以"用这个宏判 C 版本"的代码在 c89 上会走空分支。要判 c89 只能用"宏不存在"这件事本身（`#ifdef __STDC_VERSION__` 为假）。
- **GCC 13 的 `-std=c++23` 把 `__cplusplus` 定在 `202100L`**，而不是社区里常见的 `202300L` 之类；而 `-std=c++2c`（预览档）在这个构建里**不被识别**。写"按 `__cplusplus` 数值分段启用特性"的头文件时，**必须按编译器实际给的值分档**，不是按标准年份猜。

## 三、几个"看起来影响 ABI"的开关，在本机的真实行为

**字符与 wchar_t：**

```text
STDC=1
sizeof(wchar_t)=2            （加 -fshort-wchar 之后仍然是 2）
(char)-1 > 0 ? 0             （char 是有符号的）
```

- **MinGW 上 `wchar_t` 恒为 2 字节**，这是 Windows ABI 定的，`-fshort-wchar` 加不加都不变（Linux 上它是 4，这个开关才有意义）。跨平台代码里 `sizeof(wchar_t)` 是 2 还是 4，取决于**目标平台**而不是这个 flag。
- `char` 在 x86-64 上默认**有符号**，`(char)-1 > 0` 得 0。同样一段代码换到 ARM 目标上默认是 unsigned，比较结果反过来——**这是"字符当数组下标时越界崩溃"的经典来源**（嵌入式/交叉场景要显式写 `signed char`/`unsigned char`）。

**PIC 系列全是空操作：**

| 选项 | `.text` 大小 | 重定位条数 |
| --- | --- | --- |
| 默认 | `0x130` | 19 |
| `-fPIC` | `0x130` | 19 |
| `-fPIE` | `0x130` | 19 |
| `-fno-pic` | `0x130` | 19 |
| `-fpic -shared` | `0x130` | 19 |

连 `-shared` 出来的 DLL 也是**一模一样 68828 字节**（加不加 `-fPIC`）。原因：**x86-64 Windows 的 PE/COFF 本来就是位置无关的**，MinGW 接受这些开关但不做事。所以"CMake 里给 Windows 目标也打开 POSITION_INDEPENDENT_CODE 会影响产物"这句话在本机**看不到任何差别**——它只是让三个平台的行为描述一致而已。

**`-m32` 能编译，不能链接：**

```text
$ gcc -m32 -c tiny.c -o m32.o     → rc=0，objdump -f 显示 file format pe-i386，538 字节
$ gcc -m64 -c tiny.c -o m64.o     → rc=0，file format pe-x86-64，768 字节

$ gcc -m32 tiny.c -o t32.exe      → rc=1
ld.exe: skipping incompatible .../x86_64-w64-mingw32/lib/libmingw32.a when searching for -lmingw32
```

**编译器带 32 位多语言库（能出 `pe-i386` 目标文件），但导入库和 CRT 全是 64 位**，所以链接一路 `skipping incompatible`。这条报错文案很少被人认出来——它的含义就是"体系结构不匹配"，不是"库损坏"。（交叉编译的正确路子见本专栏第六节 `build-cross`，需要另装目标平台工具链。）

## 四、Debug / Release / RelWithDebInfo：本机量出来的取舍

同一个小函数（`assert` + 20 次浮点累加）编成 exe，字节数与段大小：

| 选项 | exe 字节 | `.debug*` 段 | 调试信息字节 | `.text` |
| --- | --- | --- | --- | --- |
| `-O0` | 77138 | 7 段 | 5227 | `0x6c78` |
| `-O0 -g3` | **111720** | 8 段 | **39220** | `0x6c78` |
| `-O1` | 77138 | 7 段 | 5227 | `0x6c18` |
| `-O2` | 77265 | 7 段 | 5227 | `0x6c38` |
| `-O2 -g` | **81201** | 9 段 | **7788** | `0x6c38` |
| `-O2 -DNDEBUG` | 77089 | 7 段 | 5227 | `0x6c18` |
| `-Os` | 77265 | 7 段 | 5227 | `0x6c18` |
| `-Og` | 77138 | 7 段 | 5227 | `0x6c18` |
| `-O3 -march=native` | 77265 | 7 段 | 5227 | `0x6c48` |

读法：

1. **`-g` 的代价取决于 `-O`**。`-O0 -g3` 让文件涨 **34582 字节（44.8%）**；`-O2 -g` 只涨 **3936 字节（5.1%）**。这就是 RelWithDebInfo（`-O2 -g`）在实际项目里成立的理由：**保留栈帧和行号的能力几乎是全的，体积只多 5%**；而 `-g3` 多带的是宏与内联参数信息（本机调试信息量 39220 vs 7788，5 倍），日常排障用不上。
2. **`.text` 非单调**：`-O1` 的 `0x6c18` 比 `-O2` 的 `0x6c38` **更小**，`-O3 -march=native` 又变 `0x6c48`。这和第一节《四个阶段》里"`.o` 大小不是单调的"是同一件事的 exe 版本——**别用体积判断优化强度**。
3. **`-DNDEBUG` 真的把 `assert` 删掉了**：`.text` 从 `0x6c38` 回到 `0x6c18`，exe 少 176 字节。**所以 assert 里的表达式在 Release 里不会执行**，任何有副作用的语句写进 `assert(...)` 都会静默消失（这是本专栏见过最多的一类"Release 才复现"的 bug 源头）。
4. 注意 `-Os`/`-Og` 在这个小样本上和 `-O1` 撞在同一个 `0x6c18`——**样本太小不足以区分档位**，要看差别得换真实规模的文件，本节不下这个结论。

## 五、想让产物可复现：本机这三条都动了，但结果不如预期

工程实践专栏第十节已经实测过：`SOURCE_DATE_EPOCH` 被 MinGW 忽略、`-Wl,--no-insert-timestamp` 有效但随后 `strip` 又把时间戳盖回当前时间。本节补上"源码路径"这一维：

```text
$ gcc -c -g -fmacro-prefix-map=<绝对工作目录>=/src opt.c -o mp.o
$ strings mp.o | grep -c "Users/wangt"
1
```

**`-fmacro-prefix-map` 没能把绝对路径清干净**（还剩 1 处含 `Users/wangt` 的串）。所以在这条链上，"两次构建产物字节级一致"的门禁要按工程实践第十节的结论来：**先接受 `TimeDateStamp` 这一处必然差异**（他们测到 84932 字节的 exe 只差 2 字节，就在偏移 137 的 PE 时间戳），再谈路径规范化。

## 六、选项管理的三条落地规矩（每条都有上面的实测背书）

1. **警告集分三层，只有最外层能一票否决**：`-Wall` → `-Wextra` → 显式补 `-Wshadow` 这类。把"哪一类降级/升级"写成显式列表放在 `-Werror` **之后**（顺序即策略，见第一节）。
2. **不要用宏名猜标准**：`-std=c++23` 在本机给的是 `__cplusplus=202100L`；C89 下 `__STDC_VERSION__` 压根不存在。分段逻辑一律按**读回来的值**写，并在 CI 里把这两个宏打印出来当哨兵。
3. **"加了没差别"的开关要标注**：`-fPIC`/`-fPIE`/`-fno-pic` 在 x86-64 Windows 上是空操作（`.text` 与重定位数完全相同），`-fshort-wchar` 对本机的 `wchar_t` 也无影响。**保留它们只有一致性文档价值；一旦你以为它在起作用，跨平台排查就会跑偏**（比如以为加了 `-fPIC` 就避免了重定位问题，实际 PE amd64 从来不是靠它）。

## 七、本节未在本机实测

- **MSVC 的等价开关**（`/W3 /WX`、`/O2 /Od`、`/Zi /ZI /GL`、`/arch:AVX2`）：本机 `cl.exe`/`link.exe` 不在 PATH（要 vcvars 环境），只能全部留空。**不要把 GCC 的档位映射表当作 MSVC 结论。**
- **`-flto`**：链接期一次通过、`.text` 变化与构建时间代价本节都没测（LTO 与 `--allow-multiple-definition`、静态库扫描顺序的相互作用值得单独一节）。
- **`-fsanitize=*` 全家族**：本机 MinGW 13.1.0 没有 `libubsan`/`libtsan`，`-fsanitize=undefined|thread` 直接链接失败（本专栏已两处记录）；`-fsanitize=address` 未在本节重测。
- **Profile-Guided Optimization**（`-fprofile-generate`/`-fprofile-use`）与 `-fbounds-safety`、`-fstack-protector-strong` 的实际防护效果。
- **`-O` 档位的性能差**：本节只量体积与指令段大小，**没有做运行耗时对照**（耗时属于基准测试方法论那一节的口径，需要中位数+区间）。
- **CMake 的 `CMAKE_BUILD_TYPE` 映射表**：Debug/Release/RelWithDebInfo/MinSizeRel 各自展开成哪几个 flag，本节是直接用 gcc 选项测的，没有过 CMake（那是第五节 `build-cmake` 的范围）。

## 八、小结

- **警告默认全关**：本机同一份问题源码，无 flag 报 0 条、`-Wall` 1 条、`-Wall -Wextra` 2 条、`-Wall -Wextra -Wshadow` 3 条；`-Werror` 让退出码变 1 且原文留 `[-Werror=unused-variable]`，其后追加 `-Wno-unused-variable` 又回到 0——**顺序就是策略**。
- **别把 `-o` 指向空设备**：`/dev/null` 和 `nul` 都会让汇编器报 `Fatal error: can't create nul: Invalid argument`，要丢弃输出用真实临时文件或 `-fsyntax-only`。
- **标准档读宏值**：C 侧 c89 无 `__STDC_VERSION__`、c99/c11/c17/c2x = 199901/201112/201710/202000；C++ 侧 c++11…c++23 = 201103/201402/201703/202002/**202100**，`-std=c++2c` 在本机是 `unrecognized command-line option`。
- **ABI 相关**：MinGW 的 `wchar_t` 是 2 字节且 `-fshort-wchar` 不改它（Windows ABI 决定）；`char` 在 x86-64 上有符号；`-fPIC/-fPIE/-fno-pic` 三个开关产出的 `.text` 与 19 条重定位完全相同、`-shared` 产物同为 68828 字节，**是空操作**；`-m32` 能编出 `pe-i386` 但链接一路 `skipping incompatible …libmingw32.a`。
- **调试信息按 `-O` 分价**：`-O0 -g3` 让 exe 从 77138 涨到 111720（`.debug*` 39220 字节，44.8%），`-O2 -g` 只到 81201（7788 字节，5.1%）——**RelWithDebInfo 成立的理由**；`.text` 非单调（`-O1` 的 `0x6c18` 小于 `-O2` 的 `0x6c38`）；`-DNDEBUG` 会真的删掉 `assert`，写在 assert 里的副作用会消失。
- **可复现性在本机链上还不成立**：`SOURCE_DATE_EPOCH` 被忽略、`strip` 会重写时间戳（工程实践第十节）、`-fmacro-prefix-map` 后仍残留 1 处绝对路径。
