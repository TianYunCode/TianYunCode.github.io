---
title: 链接与符号问题诊断：undefined reference 怎么读、缺 DLL 和缺入口点为什么是同一个退出码
description: >-
  实测：`extern "C"` 头配 C++ 实现时，报错是 `undefined reference to 'calc'`，而 `nm` 显示请求侧是
  `U calc`、供给侧是 `T _Z4calci`；反过来 C++ 调用 C 实现时 ld 默认把名字反修饰成
  `undefined reference to 'calc(int)'`——**好看的报错反而藏住了你要 grep 的符号名**，加
  `-Wl,--no-demangle` 才还原成 `_Z4calci`。`-Wl,-y,符号` 在本机**对 .o 和归档两种来源都没有输出**，
  能用的是 `-Wl,--trace`（它按顺序列出 crt2.o / crtbegin.o / … / libstdc++.dll.a / libmingw32.a /
  libgcc_s.a / libmsvcrt.a / libkernel32.a / crtend.o）。运行时"找不到 DLL"和"找不到导出函数"
  在 Git Bash 与 cmd 下都报 **127**，用看门狗 `GetExitCodeProcess` 才拿到真值：
  前者 `0xC0000135`(3221225781)，后者同样是非 0，而全局构造里空指针写是 `0xC0000005`(3221225477)。
date: 2026-10-16
tags: [编译构建, 链接错误, 符号表, MinGW, 退出码]
category: build
section: build-troubleshoot
---

> 环境：Windows 11 x64，**GCC/G++ 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin/` 下的 `gcc.exe`/`g++.exe`/`nm.exe`/`ar.exe`/`objdump.exe`/`c++filt.exe`）**，链接器 `x86_64-w64-mingw32/bin/ld.exe`。所有报错、符号行、退出码都是本机原文。取退出码有两种口径，本文**分开写**：shell 的 `$?`（Git Bash 与 cmd 都给 127/139 这类映射值）与看门狗进程的 `GetExitCodeProcess`（给真实 NTSTATUS）。前两节已经讲过的机制（归档扫描顺序、`multiple definition`、导入库、DLL 查找顺序）这里只引用不重复测。

## 一、`undefined reference` 是一条"两侧对不上"的线索，不是错误清单

同一个函数 `calc`，两种错配方向，报错长得完全不一样。

**方向 A：头文件按 C 声明（`extern "C"`），实现用 C++ 编译。**

```text
ld.exe: m.o:m.c:(.text+0x13): undefined reference to `calc'
collect2.exe: error: ld returned 1 exit status
```

**方向 B：C++ 调用方，实现按 C 编译（头里没有 `extern "C"`）。**

```text
ld.exe: m2.o:m2.cpp:(.text+0x13): undefined reference to `calc(int)'
```

两个方向的证据都能用两条 `nm` 命令钉死：

```text
$ nm -u m.o        （方向 A 的请求侧）
                 U __main
                 U calc
$ nm impl_cpp.o    （方向 A 的供给侧）
0000000000000000 T _Z4calci

$ nm -u m2.o       （方向 B 的请求侧）
                 U _Z4calci
$ nm impl_c.o      （方向 B 的供给侧）
0000000000000000 T calc
```

**名字对不上就是全部原因**，别的都无关。把供给侧换成对应语言编译（A 换成 `impl_c.o`、B 换成 `impl_cpp.o`）后链接立刻成功，退出码 0。

## 二、报错里的名字是"反修饰"过的，你要 grep 的是原始名

MinGW 的 ld 默认帮你把 C++ 名字还原成人类可读形式，这在方向 B 里帮了倒忙：

```text
默认：      undefined reference to `calc(int)'
--no-demangle： undefined reference to `_Z4calci'
```

`calc(int)` 是没法直接拿去 `nm | grep` 的，`_Z4calci` 才可以。两个方向的转换工具都在：

```text
$ c++filt _Z4calci
calc(int)
```

所以排查动作固定成三步：

1. `nm -u 请求方.o` → 拿到**未被满足的原始符号名**；
2. `nm 供给方.o/库` 里 grep 这个名字（或者反过来 `c++filt` 一下你 grep 到的名字）；
3. 对不上就改**声明**（补 `extern "C"` / 去掉多余的 `extern "C"`），不是改实现。

顺带第一条 `nm -u` 的输出里那个 `U __main` 是 MinGW 的 CRT 钩子，第五节要用它讲"崩溃在 main 之前"。

## 三、`-Wl,-y` 在本机没用，能用的是 `--trace`

网上流传的定位法"`ld -y symbol` 会告诉你这个符号从哪个文件来"，本机实测**两次都是空输出**：符号定义在普通 `.o` 里时没有输出，定义在归档 `libshared.a` 里时也没有输出（两次链接都成功、退出码 0）。

```text
$ g++ user.o libshared.a -o u.exe -Wl,-y,shared
（无输出，exit=0）
```

有效的是把链接器的输入清单整个打出来：

```text
$ g++ one.cpp -o one.exe -Wl,--trace
.../lib/gcc/x86_64-w64-mingw32/13.1.0/../../../../x86_64-w64-mingw32/lib/../lib/crt2.o
.../lib/gcc/x86_64-w64-mingw32/13.1.0/crtbegin.o
C:\Users\wangt\AppData\Local\Temp\ccjLVzul.o
.../lib/gcc/x86_64-w64-mingw32/13.1.0/libstdc++.dll.a
.../x86_64-w64-mingw32/lib/../lib/libmingw32.a
.../x86_64-w64-mingw32/lib/../lib/libgcc_s.a
（结尾还有）.../lib/../lib/libmsvcrt.a
             .../lib/../lib/libkernel32.a
             .../lib/gcc/x86_64-w64-mingw32/13.1.0/crtend.o
```

这张清单一次解释了四件常见怪事：

1. **你的目标文件排在 `libstdc++.dll.a` 之前**——所以"你的代码要的符号"能被它满足，反过来"库内部要的符号"要往后找，这就是第四节那套顺序规则的物理来源。
2. **`libgcc_s.a` 与 `libmsvcrt.a` 是自动挂进来的**，你不需要（也不应该）手写 `-lmsvcrt`。
3. **`crt2.o` / `crtbegin.o` / `crtend.o` 是 CRT 骨架**，第五节的"main 之前"全在这里发生。
4. `--trace` 输出的**顺序就是搜索顺序**，怀疑"同一个符号有两个提供者"时，第一个出现的赢家是谁，一眼可查（第四节实测过：只用得到一个符号时，链接器**静默取第一个**且不警告）。

## 四、能链接 ≠ 没冲突：把前两节的结论串成判据

`undefined reference`（第四节讲过扫描规则）和 `multiple definition` 是同一枚硬币的两面，本节的补充是**它们分别在哪一步暴露**：

```text
ld.exe: twoq.a(v2.o):v2.c:(.text+0x0): multiple definition of `b_fn';
        twoq.a(v1.o):v1.c:(.text+0x0): first defined here
```

- 只有当**两个成员都被拉进链接**时才报这句。只用得到一个符号时不报——所以"能链接"不能证明"树里没有两套实现"。
- 报错原文里 `first defined here` 指向的是**先被处理的那一个**，也就是真正进入产物的是它；后面那个是"多余的那份"。要修的是**为什么会同时需要两份**（通常是两个第三方库各自静态链接了同一个底层库）。
- 临时压下去用 `-Wl,--allow-multiple-definition`（实测退出码变 0），但这只是**把不确定性从构建期推到运行期**，除非你确认两份实现逐字节等价，否则不要这么做。

## 五、运行时才炸的那一类：先看它是不是"根本没到 main"

**"程序双击没反应/命令行一秒退出"这类问题，八成不是你的代码逻辑，是加载阶段就失败了。**本机把三种情形分开测：

| 情形 | Git Bash `$?` | cmd `$?` | 看门狗 `GetExitCodeProcess` |
| --- | --- | --- | --- |
| 正常跑完（`return add3(1,2,3)`） | **6** | 6 | 6（`0x00000006`） |
| 同名 DLL 在，但里面**没有** `add3` 这个导出 | **127** | 127 | —— |
| DLL 整个找不到 | **127** | 127 | **3221225781 = `0xC0000135`**（STATUS_DLL_NOT_FOUND） |
| `main` 之前的全局对象构造里写空指针 | **139**（bash 另外自己打了一行 `Segmentation fault`） | 139 | **3221225477 = `0xC0000005`**，`WaitForSingleObject=0` |

三条结论，一条比一条重要：

1. **`127` 在 Windows 上不是"命令不存在"专属**。缺 DLL 和缺导出函数都落在 127，脚本里看到 127 千万别直接下结论。
2. **shell 看到的码是映射后的，真值要靠看门狗**。同一个"main 之前崩溃"，shell 报 139（128+SIGSEGV 的 POSIX 惯例），`GetExitCodeProcess` 报 `0xC0000005`。取真值的办法就是并发/调试两节一直在用的那套：`CreateProcessA` + `WaitForSingleObject` + `GetExitCodeProcess`，父进程只打印三个数（本文用的探针 30 行）。
3. **"main 之前"是真的能观察到的**：那个崩溃程序的 `nm -u` 里有 `U __main`，而正常程序的 `main` 反汇编第一句就是 `call <__main>`（第四节那台机器的 `app.exe` 里是 `140001458: call 140001540 <__main>`）。全局对象的构造函数由这个钩子在进入你的 `main` 之前跑，所以它会崩在"你的任何一行代码之前"。本机还观察到：构造里那句 `fprintf(stderr, "CTOR_RAN")` 在重定向文件里**一个字都没留下**（未区分是缓冲区随进程丢失还是根本没执行到，本节没有进一步归因）。

顺带一条 Windows 特有的"看起来像链接错误"：**`-1073741515`（`0xC0000135`）在 CI 日志里经常显示成 `Exit code 3221225781` 或者干脆没有输出**。判据：**没有任何 stdout 输出的非零退出码，先怀疑加载失败，不要先怀疑断言。**

## 六、按这个顺序查，能省掉大部分瞎猜

1. **构建期还是运行期？** 看有没有 `ld.exe:` / `collect2.exe:` 前缀。有 → 第 1–4 节；没有但退出码异常 → 第 5 节。
2. **`nm -u` 请求侧 + `nm` 供给侧**，比对原始名。对不上 → 声明层的 `extern "C"` 问题（第一节两个方向）。
3. 名字对得上还是报 undefined → **顺序问题**：`-Wl,--trace` 看输入顺序（第三节），把供给方挪到请求方之后，或者用 `-Wl,--start-group/--end-group`（第四节实测：单归档内部无所谓，跨归档必须回头才成）。
4. 链接过了但运行报"找不到模块/过程入口点" → `objdump -p app.exe | grep "DLL Name"` 把依赖一层层列出来，再对每一层 `objdump -p ... | grep -A3 "Name Pointer Table"` 看导出名在不在（第四节实测过：MinGW 默认**只导出显式 `dllexport`/`.def` 的**，`--version-script` 在 PE 上被完全忽略）。
5. 一秒退出、无任何输出 → 按第五节用看门狗取 NTSTATUS；`0xC0000135`=缺 DLL、`0xC0000139`=缺入口点、`0xC0000005`=访问违例、`0xC00000FD`=栈溢出。
6. 崩溃行号还原不出来 → 先确认产物是不是被 `strip` 过（工程实践专栏第九节实测过链路：84932 →`--strip-debug`→ 67451 →`--strip-all`→ 38912 字节，`.text` 恒为 `0x6c68`，线上那份 `addr2line` 只能给 `??:0`，归档副本能还原 `deep1 :13 / deep2 :9 / deep3 :4`）。

## 七、本节未在本机实测

- **`-Wl,-y` 的可用版本**：本机 `ld` 对两种符号来源都无输出，未确认是版本行为、参数顺序问题还是被 `--trace` 取代，**只测了"在本机拿不到输出"这一件事**。
- **`0xC0000139`（STATUS_ENTRYPOINT_NOT_FOUND）的原值**：第五节那一行"缺导出函数"只测到 shell 侧的 127，看门狗探针没有覆盖这一情形（当时目录里刚好没有把 DLL 换掉），所以那一格留空，**不要把 `0xC0000139` 当成本机实测值引用**。
- **MSVC 的 `link.exe` 报错体系**（`LNK2019`/`LNK1120`/`UNRESOLVED_SYMBOL` 那套编号）、`dumpbin /symbols`、`/VERBOSE` 与 `-Wl,--trace` 的对应关系：本机没有可用的 MSVC 命令行工具链（`nmake`、`link` 都不在 PATH）。
- **ELF 侧对照**：`LD_DEBUG=libs`、`ldd -r`、`-Wl,--no-undefined`、符号版本（GLIBC_2.x）相关的报错形态，本机没有 Linux/WSL，全部未验证。
- **`_imp__` 前缀报错的完整形态**（漏写 `dllimport` 时报 `undefined reference to '_imp__foo'`）：方向是对的，本节没专门复现这一条。
- **CTORS 顺序跨翻译单元**：全局对象在不同 `.o`/不同库之间的构造顺序规则（以及"初始化顺序灾难"）没有做多文件样本实测。

## 八、小结

- **`undefined reference` 永远读两侧**：`nm -u` 给请求名，`nm` 给供给名，对不上就是链接语言/声明层的问题。两个方向的实测分别是 `undefined reference to 'calc'`（请求 `U calc`，供给 `T _Z4calci`）和 `undefined reference to 'calc(int)'`（请求 `U _Z4calci`，供给 `T calc`）。
- **ld 默认反修饰报错名字，方便读但不方便查**：`-Wl,--no-demangle` 才给出可 grep 的 `_Z4calci`；`c++filt _Z4calci` → `calc(int)` 是反向核对工具。
- **`-Wl,-y` 在本机无输出（.o 与归档两种来源都试过）**，用 `-Wl,--trace` 代替：它按真实搜索顺序列出 `crt2.o → crtbegin.o → 你的 .o → libstdc++.dll.a → libmingw32.a → libgcc_s.a → libmsvcrt.a → libkernel32.a → crtend.o`，一次解释"谁先谁后、谁自动进来、谁赢了"。
- **能链接不等于没冲突**：`multiple definition ... first defined here` 只在两份都被拉进来时报；只用一个符号时**静默取第一个**（第四节实测），所以重名库要在构建期主动查。
- **运行期一秒退出的三种情形，在 shell 里只有两个数**：正常 6、缺 DLL 与缺导出都是 127、main 之前崩溃 139；真值要 `GetExitCodeProcess`：`0xC0000135`（缺 DLL，3221225781）、`0xC0000005`（访问违例，3221225477）。
- **"没有任何输出的非零退出码"先怀疑加载失败**，不要先怀疑断言；`main` 之前能崩是因为 CRT 的 `__main` 钩子在跑全局构造（反汇编里 `main` 第一句就是 `call <__main>`）。
