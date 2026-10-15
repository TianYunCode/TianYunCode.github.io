---
title: Makefile 基础：规则、自动变量与增量构建，以及 Windows 上 make 自己会怎么崩
description: >-
  实测：这台机器上有三个 make 但没有一个叫 `make`（`mingw32-make.exe` 是 GNU Make 4.2.1 x86_64，
  `C:\Strawberry\c\bin\gmake.exe` 是 4.1 **32 位**）；同一行 `OBJS = $(wildcard *.c:.c=.o)`
  让前者**零输出退出 127**、让后者抛出 `Interrupt/Exception caught (code = 0xc0000005)` 退出 255；
  没设 `SHELL` 且 PATH 只剩 System32 时，`rm -rf` 变成
  `process_begin: CreateProcess(NULL, rm -rf build, ...) failed. make (e=2)`；改一个被 3 个 .c
  包含的头文件，手写依赖的 Makefile 重建 **0 个** .o，加 `-MMD -MP` 后重建 3 个；同一份 Makefile，
  `-j1` 三次全绿、`-j8` 五次全红；201 个文件全量 34.1 s、`-j8` 13.0 s、只改一个文件 2.4 s、
  什么都不改 1.7 s。
date: 2026-10-16
tags: [编译构建, Makefile, GNU Make, MinGW, 增量构建]
category: build
section: build-make
---

> 环境：Windows 11 x64，**GNU Make 4.2.1（`D:/Qt/Tools/mingw1310_64/bin/mingw32-make.exe`，Built for x86_64-w64-mingw32）**，编译器 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`（GCC 13.1.0），shell 由环境变量决定（下面第二节会看到它怎么被决定）。所有报错原文都是本机终端实际打出来的，`make` 的退出码用不带管道的 `$?` 取（管道会把 `$?` 变成 `head` 的退出码，我第一次就采错过）。
>
> 计时：`date +%s%N` 包住整条 `make`，每项 2–3 次样本给**中位数（区间）**；同期机器上还有 4–5 个任务在跑，所以**绝对值偏大**，文中一律同时给"什么都不做"的地板值和 201 个目标的空跑值，让读者能自己减。**字节数、重编文件数、退出码、报错原文与负载无关。**

## 一、先搞清楚"make"在这台机器上叫什么

```text
$ which -a make mingw32-make
which: no make in (/c/Users/wangt/...:/d/Qt/Tools/mingw1310_64/bin:...)
/d/Qt/Tools/mingw1310_64/bin/mingw32-make
/d/Qt/Tools/mingw1310_64/bin/mingw32-make.exe

$ mingw32-make --version
GNU Make 4.2.1
Built for x86_64-w64-mingw32
```

`which -a nmake jom` 也是空的——MSVC 的 `nmake` 装在 VS 目录里，不进"开发者命令提示符"就找不到。于是 Windows 上写构建脚本的第一课是：**`make` 这个名字不存在**。CMake 的两个 generator 会替你做选择，而且选出来的不是同一个东西：

```text
cmake -G "MinGW Makefiles"  → CMAKE_MAKE_PROGRAM:FILEPATH=D:/Qt/Tools/mingw1310_64/bin/mingw32-make.exe
cmake -G "Unix Makefiles"   → CMAKE_MAKE_PROGRAM:FILEPATH=C:/Strawberry/c/bin/gmake.exe
```

`gmake.exe` 来自 Strawberry Perl：

```text
$ /c/Strawberry/c/bin/gmake.exe --version
GNU Make 4.1
Built for i686-w64-mingw32
```

**4.1、而且是 32 位**——和同一目录里那个把 `gcc 4.9.2` 带上 PATH 的编译器是配套的。后面第四节会看到这两个 make 对同一份 Makefile 给出**两种完全不同的死法**。

## 二、recipe 到底由谁来跑：`SHELL` 是被继承的，不是被设定的

一个只打印变量的 Makefile：

```make
CC := cc
SHELL ?= none
all: show
show:
	echo CC=$(CC)
	echo SHELL=$(SHELL)
	echo MAKE=$(MAKE)
```

在 Git Bash 里跑：

```text
CC=cc
SHELL=D:/Git/usr/bin/sh.exe
MAKE=D:/Qt/Tools/mingw1310_64/bin/mingw32-make
```

三件事同时成立：

1. `SHELL ?= none` **没有生效**。`?=` 只在变量未定义时赋值，而 `SHELL` 已经从环境里继承来了。想强制覆盖只能 `SHELL = ...`（`:=` 同理）。
2. `$(SHELL)` 是 `D:/Git/usr/bin/sh.exe`——**你的 recipe 正在用 Git 的 sh 跑**，所以 `rm -rf`、`for i in $(seq 1 3)`、`&&` 这些"看起来是 shell 的东西"在 CI 之外的这台机器上恰好能跑，纯属 PATH 里正好有 Git。
3. recipe 里的 `$SHELL`（双 `$`，交给 shell 展开）打出来是 `/bin/bash.exe`，和 make 用的 `sh.exe` 又是两码事。

**把 PATH 抽干试试**（`env -u SHELL PATH="C:\Windows\System32"`，同一个 Makefile）：

```text
echo SHELL=[$SHELL]
SHELL=[$SHELL]
echo makeSHELL=sh.exe
makeSHELL=sh.exe
echo COMSPEC=[$COMSPEC]
COMSPEC=[$COMSPEC]
```

`$(SHELL)` 变成 make 内置默认的 `sh.exe`，但 `$SHELL`、`$COMSPEC` 都被**原样打印**——这是 cmd 的语义，说明真正跑 recipe 的已经是 `cmd.exe`。后果立刻可见（`clean: rm -rf build`）：

```text
cleaning
rm -rf build
process_begin: CreateProcess(NULL, rm -rf build, ...) failed.
make (e=2): ϵͳ\Ҳ\ָ\\ȡ\
mingw32-make: *** [Makefile:6: clean] Error 2
exit=2
```

`make (e=2)` 是 Win32 错误码 2 = `ERROR_FILE_NOT_FOUND`；后面那行乱码是 GBK 的"系统找不到指定的文件。"被当 UTF-8 读。**这条 `process_begin: CreateProcess(...) failed` 是 Windows 上 make 最有名的报错**，根因九成不是 make 坏了，而是第七节说的"recipe 交给谁跑"变了。（最后一行的 `ϵͳ\Ҳ\...` 就是 GBK→UTF-8 的现场，别去修它。）

## 三、四类写错的样子：报错原文各不相同

| 写法 | 原文 | 退出码 |
| --- | --- | --- |
| recipe 用空格开头而不是 Tab | `Makefile:2: *** missing separator.  Stop.` | 2 |
| `a.c` 不存在，`all` 依赖 `a.o` | `mingw32-make: *** No rule to make target 'a.o', needed by 'all'.  Stop.` | 2 |
| `A = $(A) tail` 自引用 | `Makefile:1: *** Recursive variable 'A' references itself (eventually).  Stop.` | 2 |
| `include nofile.mk` | `Makefile:1: nofile.mk: No such file or directory` + `*** No rule to make target 'nofile.mk'.  Stop.` | 2 |
| `-include nofile.mk` | 无输出，正常执行 `all` | 0 |

最后一行是 `-include` 的全部价值：**依赖文件（`.d`）第一次构建前不存在**，用 `include` 会让整个构建死在第一步，用 `-include` 才写得下去。

`No rule to make target 'a.o', needed by 'all'` 这句要读准：它报的是 **`a.o`**，不是 `a.c`。make 从没打算"生成 a.c"，它只是发现 `a.o` 这条规则的模式 `%.o: %.c` 需要 `a.c`，而 `a.c` 既不存在又没有规则。**看到某个 `.o` 报错，先查的是它的前置文件在不在**，不是链接器。

## 四、一条能让 make 当场死掉的写法

这份三个字的 Makefile：

```make
OBJS = $(wildcard *.c:.c=.o)
all: $(OBJS)
	@echo done
```

目录里只有一个 `m1.c`。两个 make 的表现：

```text
$ mingw32-make -n            # GNU Make 4.2.1 x86_64
                               # 一行输出都没有
exit=127

$ /c/Strawberry/c/bin/gmake.exe -n      # GNU Make 4.1 i686
C:\Strawberry\c\bin\gmake.exe: Interrupt/Exception caught (code = 0xc0000005, addr = 0x0041FB50)
exit=255
```

**连 `-n` 都会死**，所以它不是"执行 recipe 失败"，是**解析/展开阶段就崩了**：`$(...)` 里的替换引用 `var:old=new` 只能用在**变量名**上，`$(wildcard *.c:.c=.o)` 被当成"对一个叫 `wildcard *.c` 的东西做替换"，于是踩了未初始化内存（4.1 直接访问违例，4.2.1 静默 127）。我把 `$(info ...)` 放在文件顶层让它更早展开，结果一样是 127——**崩在展开点，不是崩在目标上**。

两种正确写法，实测都正常：

```text
OBJS = $(patsubst %.c,%.o,$(wildcard *.c))     → 正常，-n 打出 201 条编译命令
SRC = $(wildcard *.c)
OBJS = $(SRC:.c=.o)                             → 正常（替换引用作用在变量 SRC 上）
```

工程上真正难受的是 **127 这个退出码什么都不说明**。CI 里你会看到"make 失败了但没有错误行"，日志里只有 `Error 127` 或者干脆空的。排查办法是把可疑的 `$(...)` 单独拿出来 `$(info ...)`，或者把它换成 `patsubst` 看是否复活。

## 五、自动变量的真展开，以及模式规则给了你什么

```make
all: a.o b.o
	@echo linked $^
%.o: %.c
	@echo "target=[$@] first=[$<] all=[$^] newer=[$?]"
```

```text
target=[a.o] first=[a.c] all=[a.c] newer=[a.c]
target=[b.o] first=[b.c] all=[b.c] newer=[b.c]
linked a.o b.o
```

- `$@` 目标，`$<` **第一个**前置，`$^` 全部前置（去重），`$?` 只列出比目标新的前置。
- 上面这例里 `$?` 和 `$^` 一样，是因为每个 `.o` 只有一个前置。**`$?` 真正的用武之地是归档规则**：`libfoo.a: $(OBJS)` 时 `$^` 是全部 200 个 `.o`，`$?` 只有刚改过的那 3 个，`ar r` 用 `$?` 就能只更新成员。
- `$(OBJS:.o=.d)` 这种写法是"替换引用"，和第四节那个崩溃只差在**冒号左边是个变量名**。

## 六、头文件不在依赖里，make 永远不会提醒你

四个 `.c`、一个 `common.h` 都被它包含。Makefile 里只写 `%.o: %.c`（**这是绝大多数手写 Makefile 的样子**）：

```text
### 首次
gcc -O2 -c a.c -o a.o
gcc -O2 -c b.c -o b.o
gcc -O2 -c c.c -o c.o
gcc -O2 -c main.c -o main.o
gcc -o app.exe a.o b.o c.o main.o
### 再 make 一次
mingw32-make: Nothing to be done for 'all'.
### 改 common.h（等 1.1 秒确保时间戳前进），再 make
mingw32-make: Nothing to be done for 'all'.      ← 重建的 .o 数量：0
```

**make 打印"无事可做"，退出码 0，构建"成功"**，而磁盘上留着四个用旧 `struct P` 编出来的 `.o`。这类 bug 的表现形式是运行期莫名其妙的字段错读或崩溃，而不是编译错误。

改成 `CFLAGS = -O2 -MMD -MP` + `-include $(OBJS:.o=.d)`，同一步操作：

```text
### 改 common.h 后 make
gcc -O2 -MMD -MP -c a.c -o a.o
gcc -O2 -MMD -MP -c b.c -o b.o
gcc -O2 -MMD -MP -c c.c -o c.o
gcc -o app.exe a.o b.o c.o main.o      ← 3 个 .o 重建（main.c 不含头，所以不重编）
```

生成的 `a.d` 原文只有两行：

```text
a.o: a.c common.h
common.h:
```

第二行是 `-MP` 加的**空目标**。它防的是这个场景：你把 `common.h` 删了或改名，`a.d` 里还写着它，那么 `make` 会去找 `common.h` 的规则并报错 `No rule to make target 'common.h'`；有了 `common.h:` 这条空规则，make 认为它"已存在且无法更新"，只会因为时间戳不满足而重建 `a.o`——** `-MMD` 负责正确性，`-MP` 负责删头文件时不炸**。

`-MMD` 而不是 `-MD`：后者会连带生成系统头的依赖（`windows.h` 那一堆），`.d` 会胖到没法看。

## 七、`-j8` 把"依赖写漏"从隐形变成必红

`main.c` 里 `#include "gen.h"`，而 `gen.h` 由一条规则生成（ recipe 里先 `sleep 0.3` 再 `cp`，模拟代码生成器）。唯一区别是依赖挂在哪：

```make
# 写漏的版本：main.o 不知道 gen.h 的存在
app.exe: gen.h main.o
main.o : main.c
```

| 命令 | 三次/五次结果 |
| --- | --- |
| `make -j1` | 3/3 成功（`gen.h` 写在 `main.o` 前面，串行刚好碰对） |
| `make -j8` | **5/5 失败**：`main.c:1:10: fatal error: gen.h: No such file or directory` |
| 补上 `main.o: main.c gen.h` | `-j8` 5/5 成功 |

这就是"**本地永远绿、CI 一开并行就红**"的机理。补依赖之前，`-j1` 的成功纯属 prerequisite **书写顺序**带来的巧合；把同一份 Makefile 的 `app.exe: main.o gen.h` 顺序调过来（`main.o` 在前），`-j1` 也会 3/3 失败——**make 完全不做包含关系分析，它只看你写了什么**。

顺带一条真实观察：我第一次跑这组实验时**忘了加 `sleep 0.3`**，`-j8` 连续 5 次全绿——因为 `cp` 比 `gcc` 启动快，竞态窗口没打开。**竞态不是"有没有"，是"窗口多大"**，所以复现不出不等于没有；给代码生成器加一点真实耗时（本项目里 `moc`/`qmake` 的生成步骤就远超 0.3 秒）才是常态。

## 八、make 的判据只有"严格更新"，而且失败会留下成品

把 `a.o` 的时间戳设成和 `a.c` **完全相同**（`touch -r a.c a.o`）：

```text
mingw32-make: Nothing to be done for 'all'.        ← 不重建
```

把 `a.c` 改成比 `a.o` 早 1 秒（`touch -d '1 second ago' a.c`）：

```text
gcc -O2 -MMD -MP -c a.c -o a.o                     ← 重建
```

判据是 **`mtime(前置) > mtime(目标)`**，相等不算更新。这条和"复制/解包/`git checkout` 会重置 mtime"、"跨文件系统同步会丢亚秒精度"合在一起，就是那些"明明改了却没重编"的根源。**同一秒内改文件在 NTFS 上通常仍然会重编**（实测改完立刻 `make` 会重建 `a.o`），亚秒粒度本机是好的；出问题的是"时间戳相等"和"时间戳倒退"。

第二个坑更贵。一个中途失败的 recipe（写两行然后 `false`）：

```text
echo first > bad.txt
echo second >> bad.txt
false
mingw32-make: *** [Makefile:7: bad.txt] Error 1
exit=2
```

再跑一次 `make`：

```text
all 完成                                              ← recipe 一行都没重跑
exit=0
-rw-r--r-- 1 ... 13 Oct 16 01:00 bad.txt              ← 13 字节的半截文件
```

**make 把 13 字节的残缺产物当成成品，退出码 0。** 加上 `.DELETE_ON_ERROR:` 之后：

```text
mingw32-make: *** [Makefile:8: bad.txt] Error 1
mingw32-make: *** Deleting file 'bad.txt'
exit=2
```

文件被删掉，下一次 `make` 会**重新执行整条 recipe**（实测第二次同样失败并同样删除）。这就是为什么"生成一个大文件"的规则必须配 `.DELETE_ON_ERROR`，否则中断一次就永远留下坏产物，而 CI 是绿的。

另外两条 recipe 语义，实测：

```text
# 每个命令行都以 "cd sub" 开头，但 cd 不跨行
cd sub ; echo "同一行里 cd 之后 pwd:"; pwd
C:/Users/wangt/AppData/Local/Temp/agents/build-make/v8/sub     ← 同一行有效
cd sub
echo "新的一行里 pwd:"
pwd
/tmp/agents/build-make/v8                                       ← 新行回到起点，且同一个目录换了拼写
```

**每一行 recipe 都是一个独立的 shell 进程**，跨行的 `cd`、`export`、`VAR=1` 全部作废（要连起来就写 `cd sub && cmd1 && cmd2`，但这样会丢掉中间步骤的报错定位）。顺带看到 Git Bash 的 `/tmp` 就是 `%TEMP%`，同一个目录两种拼法。

还有那个 `.PHONY`：Makefile 里有 `clean: rm -rf build`，目录里**存在一个名叫 `clean` 的文件**时：

```text
mingw32-make: 'clean' is up to date.
exit=0
```

`clean` 被当成一个"已经存在的目标文件"，recipe 一行都没跑，退出码还是 0。加 `.PHONY: clean` 才永远执行。

顺便一条编码现象：recipe 里 `echo "同一行里 cd 之后 pwd:"` 打出来是 `鍚屼竴琛岄噷 cd 涔嬪悗 pwd:`——**UTF-8 的中文字节被 GBK 控制台读了一遍**。这就是为什么本专栏所有探针都把输出重定向进文件再读。

## 九、增量到底省多少：201 个文件的三笔账

一个真实形状的工程：201 个 `.c`（每个 26 字节，`int fN(void){return N;}`）+ `-MMD -MP`，本机同期有 4–5 个任务抢核，每项取中位数：

| 场景 | ms（区间） | 重建的 `.o` 数 |
| --- | --- | --- |
| 全量 `-j1` | **34112**（32916–35315，3 次） | 201 |
| 全量 `-j8` | **12953**（12655–13586，3 次） | 201 |
| 只改 `f77.c` 后 `-j1` | **2413**（2126–2695，3 次） | 1（+ 重新链接） |
| 什么都不改 `-j1`（空跑） | **1749**（1453–1919，3 次） | 0 |
| 只有一个 `@echo` 的 Makefile 空跑（地板） | **239**（222–298，3 次） | —— |

- 并行比 **2.63×**，在一台 6 核、还被别人抢着用的机器上——**这就是"8 线程只有 2.6 倍"的真实样子**，编译是进程启动 + IO + CPU 混合，不是纯 CPU。
- 增量比 **14.1×**，省的是 200 次 `gcc` 启动。
- 最容易被忽略的是第四行：**即使无事可做也要 1.75 秒**，减去地板 0.24 秒，**make 光读 201 个 `.d`、stat 四百多个文件、把依赖图搭起来就花掉约 1.5 秒**。工程规模再大一个数量级，这部分会先于编译器变成瓶颈（`-j` 救不了它，它是单线程的）。

## 十、本节未在本机实测

- **Linux/macOS 的 GNU make**：本机只有 4.2.1(x64) 与 4.1(i686) 两个 Windows 构建，第四节的 127/崩溃是否与版本相关只能推断，未在其它 make 上复核。
- **`make -j` 的负载相关竞态**：我只证明了"依赖缺失时 `-j8` 必红"，未测"依赖存在但 recipe 有共享写入"那类竞态（需要真实工程）。
- **并行 make 的输出交错**：Windows 上 make 的 `-O`（输出排序）在本机 4.2.1 上行为如何未测。
- **递归 make 的性能与 `-l` 负载限制**、**`MAKECMDGOALS`/`.DEFAULT_GOAL` 的边角**、**`distclean` 之类的约定**：属于写法而非机制，本节没有取证。
- **FAT32/exFAT 上的 2 秒时间戳粒度**：本机是 NTFS，未插 U 盘验证；"相等不重建"这条与它同源，已经实测。

## 十一、小结

- **Windows 上 `make` 这个名字不存在**：MinGW 给 `mingw32-make.exe`（4.2.1 x64），Strawberry 给 `gmake.exe`（**4.1 且 32 位**），CMake 的 `-G "Unix Makefiles"` 会静默挑到后者。脚本里写死工具全路径，或用 `$(MAKE)`。
- **recipe 由谁跑是继承来的**：Git Bash 下 `$(SHELL)=D:/Git/usr/bin/sh.exe`，所以 POSIX 写法能跑；`SHELL ?=` 覆盖不了它，要 `SHELL =`。PATH 里没有 sh 时 make 回落到 cmd，`rm -rf` 立刻变成 `process_begin: CreateProcess(NULL, ...) failed. make (e=2)` + 退出码 2。
- **`$(wildcard *.c:.c=.o)` 会让 make 在展开阶段死掉**：4.2.1 **零输出退出 127**，4.1 抛 `0xc0000005` 退出 255，`-n` 也躲不过。替换引用的冒号左边必须是变量名；一律写 `$(patsubst %.c,%.o,$(wildcard *.c))` 或分两步。
- **头文件必须进依赖**：`%.o: %.c` 之外什么都不写时，改 `common.h` 后 `make` 说 "Nothing to be done" 且退出 0，**0 个 `.o` 被重建**。`-MMD -MP` + `-include $(OBJS:.o=.d)` 之后重建 3 个；`.d` 里第二行 `common.h:` 是 `-MP` 的空目标，专门防"删掉头文件后 make 报错"。
- **`-j` 会把写漏的依赖变成必现失败**：同一份 Makefile，`gen.h` 生成慢 0.3 秒时 `-j1` 3/3 绿、`-j8` 5/5 红（`fatal error: gen.h: No such file or directory`），把 `main.o: main.c gen.h` 补上就 5/5 绿。**串行通过只说明书写顺序碰巧对。**
- **判据是"严格更新"**：`touch -r a.c a.o`（时间戳相等）→ 不重建；早 1 秒 → 重建。失败会留下半截产物并被当成成品（13 字节的 `bad.txt`，下次 `make` 退出 0），`.DELETE_ON_ERROR:` 才会 `Deleting file` 并重跑。
- **recipe 每行一个 shell**：`cd` 不跨行；**存在名为 `clean` 的文件时 `make clean` 打印 "'clean' is up to date." 并退出 0**，所以伪目标必须 `.PHONY`。
- **三笔账**：201 个文件全量 34.1 s（`-j8` 13.0 s，2.63×）、改一个文件 2.4 s（14.1×）、**什么都不改也要 1.75 s**——make 自己的依赖图构建是单线程的，规模上去后它会先成为瓶颈。
