---
title: 静态库、动态库与链接顺序：归档怎么扫、导入库是什么、缺 DLL 时谁先被找到
description: >-
  实测：两个 .o 共 1488 字节，打进 `libab.a` 是 1698 字节（容器+索引 210 字节）；`main.o liba.a libb.a`
  链接成功，把两个库顺序调换成 `main.o libb.a liba.a` 就报
  `liba.a(a.o):a.c:(.text+0x9): undefined reference to 'b_fn'`，同一个归档里则两种顺序都成功；
  `--start-group` 能救回来。两个成员都定义 `b_fn` 时，只用得到一个符号的场景**静默取第一个**（退出码证明），
  强制两个都进来才报 `multiple definition`。一个只导出一个函数的 DLL 是 36293 字节，配套导入库 `libfoo.dll.a`
  只有 1496 字节；`--version-script` 在 PE 上被**完全忽略**（`local: add3` 之后导出表还是 1 条，退出码 0）；
  exe 同目录的 DLL 赢过 PATH 里的同名 DLL，两份都没有时 Git Bash 报 127。
date: 2026-10-16
tags: ["编译构建", 静态库, 动态库, 链接顺序, MinGW]
category: build
section: build-library
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**、`ar`/`nm`/`objdump` 同目录，链接器是 `x86_64-w64-mingw32/bin/ld.exe`。所有报错原文、退出码、字节数、导出表条目数都是本机跑出来的；退出码一律用不带管道的 `$?` 取（管道会把 `$?` 变成 `head` 的返回码，我第一次就采错过）。本机没有 MSVC 的 `lib.exe`/`dumpbin`，PE 侧一律用 GNU 工具读。

## 一、归档只是容器，外加一张符号索引

```text
a.o   720 字节
b.o   768 字节          合计 1488
libab.a  1698 字节       ← 容器 + 成员名表 + 符号索引 = +210 字节
```

```text
$ ar -t libab.a
a.o
b.o

$ nm -s libab.a
Archive index:
a_fn in a.o
b_fn in b.o
```

索引就是全部魔法的来源：**链接器靠它知道"哪个符号在哪个成员里"，从而只把需要的成员拽出来**。这也解释了两件事：

- 成员顺序对索引没有意义（索引是符号→成员的映射），但**对下面第二节的扫描规则有意义**。
- 用 `ar r` 替换成员、用 `ranlib`（MinGW 上 `ar s`）重建索引，索引过期就会链接不上——`libfoo.a: no archive symbol table (run ranlib)` 那类报错的根因。

`ar rcs dup.a a.o a.o`（同名成员塞两次）实测得到 1746 字节，**两份都留在里面**（720×2+306），`ar` 不会拒绝也不会去重。

## 二、链接器扫归档是单向的：三条命令三种结果

`a_fn` 调 `b_fn`，`main` 调 `a_fn`，把 `a.o` 和 `b.o` 分别装进 `liba.a`(910 字节) 和 `libb.a`(862 字节)：

| 命令 | 结果（原文） | 退出码 |
| --- | --- | --- |
| `gcc main.o liba.a libb.a` | 成功 | 0 |
| `gcc main.o libb.a liba.a` | `ld.exe: liba.a(a.o):a.c:(.text+0.9): undefined reference to 'b_fn'` | 1 |
| `gcc main.o libab.a`（一个归档，a.o 在前） | 成功 | 0 |
| `gcc main.o libba.a`（同一批成员，b.o 在前） | 成功 | 0 |
| `gcc main.o -Wl,--start-group libb.a liba.a -Wl,--end-group` | 成功 | 0 |

机制只有一句话：**ld 从左到右走一遍，只在"当前有未决符号"时才打开后面的归档；一旦越过某个归档就不会回头。**

- 第二行为什么报的是 `liba.a(a.o)`：`main.o` 要 `a_fn` → `libb.a` 里没有 → 一个成员都不拽；`liba.a` 里有 → 拉入 `a.o` → 此刻才产生新的未决符号 `b_fn`，而 `libb.a` 已经被走过了。
- **同一个归档内部两种成员顺序都成功**（第 3、4 行）：ld 对单个归档会反复扫描直到收敛，跨归档才不回头。这条区别极其重要，它意味着"把两个库合成一个大归档"本身就能消掉一类顺序问题。
- `--start-group/--end-group` 就是"在这段里反复扫到不动点为止"，代价是链接变慢（组里的归档会被重复打开）。

`-l` 的找文件规则也顺手测了一下：

```text
$ gcc main.o -L. -lnosuch -o t6.exe
ld.exe: cannot find -lnosuch: No such file or directory
collect2.exe: error: ld returned 1 exit status
```

## 三、同名符号：多数时候**不报错**，这是最危险的一条

`v1.o` 与 `v2.o` 都定义 `int b_fn(void){return VER;}`（分别返回 1 和 2），两个成员一起放进 `twoq.a`：

```text
$ nm twoq.a | grep " T b_fn"
0000000000000000 T b_fn
0000000000000000 T b_fn
```

情形 A：`main` 只用 `b_fn`。

```text
$ gcc m.o twoq.a -o mA.exe && ./mA.exe ; echo $?
1                                     ← 用了 v1.o，一句警告都没有
```

情形 B：`main` 另外引用 `only_v2()`，逼 ld 把 `v2.o` 也拽进来。

```text
ld.exe: twoq.a(v2.o):v2.c:(.text+0x0): multiple definition of `b_fn';
        twoq.a(v1.o):v1.c:(.text+0x0): first defined here
collect2.exe: error: ld returned 1 exit status
```

加上 `-Wl,--allow-multiple-definition` 后**退出码 0，静默选一个**。

结论要背下来：**同名符号只有在"两个都被拉进来"时才会炸**。所以"我们的程序能链接"完全不能证明"没有两套实现同时在树里"——它在另一种调用形状下才暴露。真实场景就是"两个第三方库各自静态链接了同一个 zlib/openssl"：平时没事，某天某条路径同时用到两边就变成 `multiple definition`，或者更糟——**变成情形 A 那种静默取第一个**，而两个 `b_fn` 行为不一样。

## 四、Windows 的动态库是"两个文件"：DLL 与导入库

一个只导出一个函数的库：

```c
__declspec(dllexport) int add3(int a,int b,int c){return a+b+c;}
int hidden_fn(void){return 42;}
```

```text
$ gcc -shared -o libfoo.dll foo.c -Wl,--out-implib,libfoo.dll.a
libfoo.dll      36293 字节
libfoo.dll.a     1496 字节        ← 导入库
```

**导入库不是"库的静态版"**，它里面只有符号的**名字与 RVA 索引**，没有函数体——1496 字节 vs 36293 字节就是这个差。链接时用 `-L. -lfoo`，ld 找的是 `libfoo.dll.a`（这也是第三节那个"no archive symbol table"报错会出现在导入库上的原因）。

链接产物里带着它要谁：

```text
$ objdump -p app.exe | grep "DLL Name"
	DLL Name: libfoo.dll
	DLL Name: KERNEL32.dll
	DLL Name: msvcrt.dll
```

第三条值得注意：**MinGW 的 CRT 是 `msvcrt.dll`**，不是 UCRT/`vcruntime`。这就是"用 MinGW 编的 exe 拷到干净的机器上一般能跑，但装了别的 Python/GTK 的机器上偶尔加载到错版 msvcrt"这一类灵异的土壤。

## 五、谁能被外面看到：四种写法，两种在本机无效

导出表条目数（`objdump -p` 的 `Export Address Table` 计数）：

| 构造方式 | 导出条目 | DLL 字节数 |
| --- | --- | --- |
| 只有 `__declspec(dllexport)` | **1** | 36293 |
| `-Wl,--export-all-symbols` | **2**（`hidden_fn` 也出来了） | 36293 |
| `.def` 里写 `EXPORTS add3 / hidden_fn` | **2** | 36293 |
| `-Wl,--version-script=map.txt`，map 写 `{ local: add3; }` | **还是 1**，退出码 0 | 36293 |

四条结论：

1. **MinGW 默认不是"什么都导出"**——只有显式 `dllexport`（或 `.def`/`--export-all-symbols`）的才出去。网上"GCC 建 DLL 默认导出全部符号"这句话在 Windows 上不成立。
2. 导出表从 1 条变 2 条，**文件字节数一点没变（36293）**——导出目录落在已有段的对齐空间里。想用"导出多少个"来估体积变化是估不出来的。
3. `--version-script` 在 PE 上**被完整忽略**：ld 接受参数（退出码 0，无警告），`local: add3` 却没能把 `add3` 藏掉。**ELF 的符号版本控制（`FOO_1.0 { global: ...; local: *; };`）在 Windows 上没有对应物**，跨平台项目想用一个大导出表 + 版本脚本来收口，到 Windows 这边必须换成 `.def` 或 `dllexport` 宏。
4. `-static-libgcc` 在这个最小 DLL 上**看不出体积差别**（`sdll_dyn.dll` 与 `sdll_sta.dll` 都是 37789 字节）——`sqrt` 这类被 gcc 转成 `msvcrt` 调用，没有 libgcc 实体可以静态化。"每个 DLL 都塞一份 libgcc 所以体积翻倍"这条在本例不成立，别当普适结论引用。

## 六、调用侧：`dllimport` 少一跳，objdump 看得清清楚楚

`app.exe` 里 `main` 调 `add3` 的指令：

```text
140001450 <main>:
   ...
   14000146d:  call   140001480 <add3>
   140001480 <add3>:
      jmp     *0x6cfa(%rip)   # 140008180 <__IAT_start__>
```

而符号表里同时存在两个东西：

```text
[872](sec 1) 0x0000000000000480 add3          ← exe 里的跳板（thunk）
[922](sec 7) 0x0000000000000180 __imp_add3    ← IAT 槽位本体
```

**没有 `__declspec(dllimport)` 时，每次调用都要 `call` 到 exe 自带的 thunk，再由 thunk `jmp` 进 IAT**；加了 `dllimport`，编译器直接生成"从 `__imp_add3` 取地址再调用"，省掉这一跳。这不是理论：MinGW 在函数**指针**用法上会因为你漏写 `dllimport` 而报 `undefined reference to '_imp__add3'`——那串带 `_imp__` 前缀的错名就是这个间接层的痕迹。

## 七、运行时查找：exe 同目录先赢，找不到时 Git Bash 给你 127

做两份同名不同行为的 `libfoo.dll`（A 返回 1，放在 exe 同目录；B 返回 2，放在一个临时目录并加进 PATH），用进程退出码当观察量：

```text
### A) exe 同目录(返回1) 与 PATH(返回2) 同时存在
  -> 1                          ← 应用目录先赢
### B) 移走 exe 同目录那份，只剩 PATH 里那份
  -> 2                          ← 其次才是 PATH
### C) 两份都不在
C:/.../app.exe: error while loading shared libraries:
    libfoo.dll: cannot open shared objects file: No such file or directory
  -> bash 看到退出码 127
```

C 这一条是 Windows 上部署最常见的坑的**真实报错形状**：Git Bash/MSYS 会把它伪装成"动态链接库找不到"的 dl 风格消息并返回 **127**（和"命令不存在"同一个码）。我用 `cmd //c "app.exe & call echo EC=%errorlevel%"` 再取一次，拿到的是 **EC=0**——**别用 errorlevel 判这种加载失败**，它报的是前一条命令的状态。用 PowerShell `Start-Process -PassThru` 取 `ExitCode` 的探针在本机同期负载下超时未返回，所以那个真正的 NTSTATUS 值本节**未实测**，只知道"从 MSYS 走是 127，从 cmd 走是 0"。

工程上这一节只留一条规矩：**发布包里的 DLL 必须和 exe 同目录**（第七节的 A 就是这个顺序的第一名），不要指望 PATH，也不要指望"装到系统目录里就行"。

## 八、本机未实测

- **ELF 侧的一切对照**：符号版本脚本的真实效果、`-Wl,--as-needed`、`DT_NEEDED`、`LD_PRELOAD`——本机没有 Linux/WSL，第四节到第五节只给了 PE 侧结论。
- **`mt.exe` 与 manifest、`sideload` 目录**：Windows 应用清单会影响 DLL 查找路径，本节没有构造带 manifest 的样本。
- **KnownDLLs / SafeDllSearchMode 的完整顺序表**：只实测了"应用目录 > PATH"这一档，`%WINDIR%\System32`、`AppPath` 注册表键的相对位置未取证。
- **导出过多导致的 ordinal/name 表开销曲线**：需要几十上百个导出函数才能看出趋势，本节的 1→2 条差异被段对齐吃掉了。
- **MSVC `lib.exe`/`dumpbin` 与 MinGW 导入库的互操作**（`.lib` 与 `.dll.a` 不能互换、`__imp_` 名字修饰差异）：本机没有可用的 MSVC 命令行工具链。

## 九、小结

- **归档 = 成员 + 符号索引**：1488 字节的两个 `.o` 进 `libab.a` 变 1698 字节（+210）；`ar rcs dup.a a.o a.o` 会把同名成员塞两份（1746 字节）且不去重。
- **ld 从左到右、只向前扫**：`main.o liba.a libb.a` 成功，`main.o libb.a liba.a` 报 `liba.a(a.o):a.c:(.text+0x9): undefined reference to 'b_fn'`；**同一个归档内成员顺序无所谓**（ld 会在归档内反复扫描），跨归档必须靠顺序或 `--start-group/--end-group`。
- **重名符号大多数时候静默通过**：`twoq.a` 里两个 `b_fn`，只用一个符号时链接器**取第一个且不警告**（实测运行返回 1）；只有两个成员都被拉进来才报 `multiple definition of 'b_fn' ... first defined here`。`--allow-multiple-definition` 会让它再次静默。
- **Windows 动态库是两个文件**：`libfoo.dll` 36293 字节带实现，`libfoo.dll.a` 1496 字节只带名字/RVA；`objdump -p` 读到的依赖里除 `libfoo.dll` 还有 `KERNEL32.dll` 与 **`msvcrt.dll`**（MinGW 的 CRT 选择）。
- **导出控制只有 `dllexport`/`.def`/`--export-all-symbols` 三种真的有效**：默认只导出显式声明的 1 个；`--export-all-symbols` 与 `.def` 都变 2 个；**`--version-script` 在 PE 上被完全忽略且退出码 0**，别把 ELF 的收口办法当成跨平台方案。
- **`dllimport` 省一跳**：没有它时 exe 里会长出一个 `add3: jmp *__imp_add3(%rip)` 的 thunk，符号表里同时有 `add3` 和 `__imp_add3`。
- **运行时查找：exe 同目录 > PATH**（实测返回 1 与 2 的差别）；两份都缺时 Git Bash 给 127、cmd 的 errorlevel 给 0，**别用退出码区分"没跑起来"和"跑成功"**。
