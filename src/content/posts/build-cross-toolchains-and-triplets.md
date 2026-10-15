---
title: 交叉编译工具链：从编译器自己报出的那串名字读懂 triplet、sysroot 与前缀
description: >-
  实测：本机 `gcc -dumpmachine` 给出 `x86_64-w64-mingw32`，`--print-multi-lib` 只有一行 `.;`（没有第二套子库），
  而 `--print-sysroot` 把构建机路径原样吐出来：
  `C:/buildroot/x86_64-1310-posix-seh-msvcrt-rt_v11-rev1/mingw64`——**这一串就是 triplet 该读懂的全部字段**
  （架构/版本/线程模型 posix/异常模型 seh/CRT msvcrt/运行库版本/修订号）。把 `--sysroot` 指到一个不存在的目录，
  编译**照样 rc=0**；而 `-isystem` 指到不存在目录时立刻 `fatal error: nosuchhdr.h: No such file or directory`——
  说明这个 native 构建里 sysroot 基本不参与搜索，头路径靠的是 `-isystem`/`-I` 与内建前缀。
  用 `-m32` 做的受控"伪交叉"能编出 `pe-i386` 目标文件，链接则报
  `i386 architecture of input file … is incompatible with i386:x86-64 output`。
  本机没有 `arm-none-eabi-gcc`、没有 `aarch64-w64-mingw32-gcc`、没有 vcpkg/conan/ccache，真目标平台的编译一律未实测。
date: 2026-10-16
tags: [编译构建, 交叉编译, 工具链, triplet, sysroot]
category: build
section: build-cross
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/`）**。本机**只有这一套 native 工具链**：`which -a arm-none-eabi-gcc aarch64-w64-mingw32-gcc vcpkg conan ccache` 全部为空。所以这一节的写法是：**能在这台机器上真读出来的东西（编译器自报的名字、multilib、sysroot 行为、架构不匹配的链接错误）全部实测**；真正跨到别的架构/CPU 的部分**逐条标"未在本机实测"**，不给任何编造的数字。前两节（`build-options` 的 `-m32`、`build-troubleshoot` 的 `skipping incompatible`）已经出现的结论只引用不重测。

## 一、编译器自己就把 triplet 告诉你了

```text
$ gcc -dumpmachine
x86_64-w64-mingw32
$ gcc -dumpversion
13.1.0
$ gcc --print-sysroot
C:/buildroot/x86_64-1310-posix-seh-msvcrt-rt_v11-rev1/mingw64
```

**第二行比第一行信息量大得多**——它是构建这套工具链时用的目录名，字段和含义一一对上：

| 片段 | 含义 | 本机取值 |
| --- | --- | --- |
| `x86_64` | CPU | 目标架构 |
| `1310` | GCC 版本 13.1.0 | — |
| `posix` | **线程模型** | Win32 线程 + 原生 POSIX 同步原语（另一档是 `win32`） |
| `seh` | **异常模型** | x86-64 的结构化异常表（32 位常见 `dwarf`/`sjlj`） |
| `msvcrt` | **CRT** | 链接系统 `msvcrt.dll`（另一档是 `ucrt`） |
| `rt_v11` / `rev1` | Windows SDK 运行库版本 / 该发布版第 1 次修订 | — |

`-print-search-dirs` 里那些 `install:` / `programs:` / `libraries:` 路径也全都以 `x86_64-w64-mingw32/13.1.0/` 为目录名，例如：

```text
install: D:/Qt/Tools/mingw1310_64/bin/../lib/gcc/x86_64-w64-mingw32/13.1.0/
```

**这就是 "triplet 与前缀含义" 的全部内容**：`<CPU>-<厂商>-<OS>[-<ABI>]`。MinGW-w64 的厂商位写作 `w64`、OS 位写作 `mingw32`（**这里的 `mingw32` 不代表 32 位**，它是"Windows/Win32 API"这个目标 OS 的名字；64 位目标的目录同样叫 `mingw64`，但 triplet 仍是 `x86_64-w64-mingw32`）。看到 `aarch64-none-elf`、`arm-none-eabi`、`x86_64-linux-gnu` 时，按同样三段拆就对了。

## 二、multilib 决定"这台机器能不能换架构"

```text
$ gcc --print-multi-lib
.;
```

只有一行：**这套工具链只有一个编译变体，没有第二套子库目录。** 于是第七节那条 `-m32` 的现象就有完整解释了：

```text
$ gcc -m32 -c t.c -o t32.o        → rc=0，objdump -f 显示 file format pe-i386
$ gcc t32.o -o t32.exe            → rc=1
ld.exe: i386 architecture of input file `t32.o' is incompatible with i386:x86-64 output
```

**编译器能把代码生成成 32 位（`pe-i386`），但 CRT、导入库、启动文件全是 64 位的**，链接器直接拒绝——报错原文点名的就是"输入文件的架构 ≠ 输出的架构"，比第四节那种 `skipping incompatible …libmingw32.a`（搜索时被跳过）更直白。

判据可以背下来：

- **`--print-multi-lib` 只有 `.;` 的工具链，不要指望它换 CPU 位宽**，更别指望它换厂商架构。
- 真要交叉，需要的是**另一整套前缀命名的工具链**（`arm-none-eabi-gcc` 那种），而不是给 native 编译器加个 `-m` 开关。

## 三、sysroot 与 `-isystem`：本机测下来，起作用的是后者

把 `--sysroot` 指到一个**根本不存在**的目录：

```text
$ gcc --sysroot=C:/nonexistent_sysroot -c t.c -o t1.o
rc=0，无任何诊断
```

再把头搜索目录指到同一个不存在的目录：

```text
$ gcc -isystem C:/nonexistent_sysroot/include -c h.c -o h.o
h.c:1:10: fatal error: nosuchhdr.h: No such file or directory
```

两条一起读，结论很具体：**在这个 native MinGW 构建里，`--sysroot` 基本不改变行为**（因为目标 OS 就是宿主 OS，头与库的位置由工具链内建前缀决定，见第一节 `--print-sysroot` 那个烧进去的构建机路径），而 `-isystem`/`-I` 是**真的**在被搜索。

这解释了两个常见的错觉：

1. **`--sysroot` 在 native 编译里"加了没反应"是正常的**，不是它坏了；它的作用面是交叉场景（把 `<sysroot>/usr/include`、`<sysroot>/usr/lib` 作为搜索根，避免把宿主机的 `/usr/include` 泄漏进目标构建）。本机没有交叉工具链，**这条正面作用未实测**。
2. **CMake 里 `CMAKE_FIND_ROOT_PATH` 和编译器的 `--sysroot` 不是一回事**：前者管 `find_package`/`find_file`/`find_library` 去哪里找包，后者管编译器自己的头/库搜索。只配其中一个，就会出现"找到了库但编译时找不到头"或反之。

## 四、CMake 的工具链文件：本机只能测到"失败形状"

工具链文件的骨架（`arm-none-eabi.cmake` 这类，交叉时 `-DCMAKE_TOOLCHAIN_FILE=` 传入）：

```cmake
set(CMAKE_SYSTEM_NAME Generic)          # 目标没有完整 OS（MCU）
set(CMAKE_SYSTEM_PROCESSOR armv7-m)
set(CMAKE_C_COMPILER arm-none-eabi-gcc)
set(CMAKE_SYSROOT ${CMAKE_CURRENT_LIST_DIR}/sysroot)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
```

本机没有 `arm-none-eabi-gcc`，但**能实测到"编译器找不到"时 CMake 的报错形状**（用 `-DCMAKE_C_COMPILER=` 指定一个不存在的程序）：

```text
CMake Error: CMAKE_CXX_COMPILER not set, after EnableLanguage
-- Configuring incomplete, errors occurred!
```

这与第五节 Ninja 那条**是同一句报错**——**"编译器/构建工具没找到"在 CMake 里几乎都不报"没找到"，而是报"编译器未设置"**。看到这句先去查 PATH 与工具链文件里的路径拼写，而不是查 `CMakeLists.txt`。

`CMAKE_FIND_ROOT_PATH_MODE_*` 三个开关的**正面效果未在本机实测**（需要真的 sysroot 与包）。

## 五、"主机工具混用"这一类坑，本机有一个可复现的例子

交叉构建里最常见的一类事故是：**用宿主机的编译器去构建目标侧代码**（比如 codegen、`genops`、`moc` 这类必须在本机跑的生成器）。本机可以复现它的判据：

```text
$ gcc -dumpmachine
x86_64-w64-mingw32
```

规矩：**任何要跑在这台机器上的工具，都必须由 native 编译器产出**；而由交叉编译器产出的同名程序在这台机器上根本跑不起来（架构不符，第四节那个退出码就是它的表现）。所以真实项目的写法是两套前缀分开：

```cmake
# 目标侧
add_executable(app main.cpp)
target_compile_options(app PRIVATE ${TARGET_FLAGS})
# 主机侧生成器：用 native 工具链单独构建，产物用可执行文件路径引用，绝不参与目标链接
```

（`build-troubleshoot` 第六节提到的 `crt2.o → crtbegin.o → … → crtend.o` 输入清单在交叉时同样是目标侧的；宿主工具不该出现在这张表里。）

## 六、把 triplet 读对，能省掉三类典型事故

1. **`mingw32` ≠ 32 位**。`x86_64-w64-mingw32` 里 `mingw32` 是目标 OS 层（Windows API）的名字。按字面以为它是 32 位，就会在选压缩包时选错（本机的 `posix-seh` vs `win32-sjlj` 也是同理：**`seh` 档只有 64 位构建才有**）。
2. **线程模型 + 异常模型 + CRT 三项是 ABI 边界**。`posix`/`win32` 决定 `std::thread`、`pthread` 能否工作；`seh`/`dwarf`/`sjlj` 决定异常展开表长什么样（第四节讲过 `.pdata`/`.xdata` 是 Windows 独有段）；`msvcrt`/`ucrt` 决定链接哪个 CRT——**这三项不同的两套工具链产出的目标文件不能混链**，混了就得到第二、四节那种架构/兼容性拒绝。
3. **`--print-sysroot` 会漏出构建机路径**，这本身就是"编译器被绝对路径固定住了"的证据：**工具链不可重定位**。把 `D:/Qt/Tools/mingw1310_64` 拷到别的机器/别的盘符，`-print-search-dirs` 里的内建前缀不会自动改，只能靠 `-B`/`-isysroot` 覆盖。任何"把工具链打包进仓库"的做法都要连路径策略一起打包。

## 七、本节未在本机实测（以及要补什么才能测）

- **`arm-none-eabi-gcc` 的全部行为**：向量表、`-mcpu=cortex-m4 -mthumb -mfloat-abi=hard`、链接脚本回答、`.isr_vector` 段位置、`--specs=nano.specs` 的体积差——**本机没有该工具链**。装上 `arm-none-eabi-gcc`（或由嵌入式专栏那侧提供板子）即可全部实测。
- **`aarch64-w64-mingw32-gcc`（Windows ARM64）**：同样缺失；Windows-on-ARM 的交叉产物在真机运行未测。
- **Linux 目标（`x86_64-linux-gnu`）与 Android NDK**：本机没有 Linux/WSL/NDK。
- **`--sysroot` 的正面作用、`CMAKE_FIND_ROOT_PATH_MODE_*` 的实际效果**：见第三节，只测到"native 下不生效"。
- **multilib 齐全的工具链**（同一前缀下能 `-m32/-m64` 双档）：本机 `--print-multi-lib` 只有一行，无法给出"多档时输出目录怎么变"的实测样本。
- **ccache/sccache 对交叉构建的命中率**：本机未安装，属于第九节 `build-ci` 的范围。

## 八、小结

- **triplet 不用背，让编译器自己说**：`gcc -dumpmachine` = `x86_64-w64-mingw32`，`--print-sysroot` 更直白地给出 `x86_64-1310-posix-seh-msvcrt-rt_v11-rev1`——架构、GCC 版本、线程模型、异常模型、CRT、SDK 运行库、修订号全在里面。
- **`mingw32` 不是 32 位**（它是"Windows API"这个目标 OS 的写法），**`posix/win32`、`seh/dwarf/sjlj`、`msvcrt/ucrt` 三组是 ABI 边界**，不同取值的工具链产物不可混链。
- **`--print-multi-lib` 只有一行 `.;` 就意味着这套工具链不能换位宽**：实测 `-m32` 能编出 `pe-i386` 目标文件，链接则被 `ld.exe: i386 architecture of input file … is incompatible with i386:x86-64 output` 拒绝。
- **`--sysroot` 在 native MinGW 构建里几乎无效**（指到不存在的目录仍 rc=0），真正参与头搜索的是 `-isystem`/`-I`（同样指到不存在目录立刻 `fatal error: nosuchhdr.h`）；交叉场景下 sysroot 的正面作用本机未实测。
- **CMake 里"找不到交叉编译器"报的是 `CMAKE_CXX_COMPILER not set, after EnableLanguage`**，与第五节 Ninja 那条同形；`CMAKE_FIND_ROOT_PATH` 与编译器 `--sysroot` 是两回事，只配一个就会一半找得到一半找不到。
- **工具链不可重定位**：`--print-search-dirs` 把构建机路径烧在内建前缀里，拷贝目录不会自动改，必须用 `-B`/`-isysroot` 覆盖。
