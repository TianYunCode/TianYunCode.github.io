---
title: MSVC 与 MinGW 工具链差异
description: 实测：64 位三种调用约定修饰无差别而 32 位是三态；-static 让 C++ exe 从 57KB 涨到 2.5MB 但 msvcrt.dll 仍动态；windres 加 code_page 资源小 8 字节。
date: 2026-10-16
tags: [Win32, MinGW, MSVC, 工具链, ABI, 调用约定]
category: win32
section: win-msvc-mingw
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin`）**，`-O2`。探针 `%TEMP%/win3m_*`（conv.cpp/conv32.o/t.o/t2.o）与 mingw_probe/。**本机没有安装 MSVC**——本文所有 MSVC 侧结论（cl.exe 行为、.lib 格式、CRT 版本）**均为文档级知识，未实测**；实测部分全部是 MinGW 侧，用 `nm`/`objdump`/`windres` 取证。

## 一、名字修饰：同一个函数，两套天书

先看实测。同一个源文件（`extern "C"` 三个调用约定 + 普通 C++ 函数 + 命名空间 + 类成员 + 模板），64 位和 32 位下的符号表：

**64 位（x86-64）**——`nm` 输出（-C 解修饰后对照）：

```
T cdecl_fn                ← extern "C" 三个约定同名，无任何修饰差别
T stdcall_fn
T fastcall_fn
T int tmpl<int>(int)      ← 原始符号是 Itanium ABI 的 __Z4tmplIiET_S0_
T ns::in_ns(int)          ← __ZN2ns5in_nsEi
```

**32 位（-m32）**——修饰三态全出来了：

```
T _cdecl_fn               ← 前导下划线
T _stdcall_fn@8           ← 下划线 + @字节数（两个 int 参数 8 字节）
T @fastcall_fn@8          ← @前缀 + @N 后缀
T __Z9cpp_plaini          ← C++ 同样是 Itanium ABI
```

三条结论，每条都能在符号表里直接验证：

1. **x86-64 统一了调用约定**：Windows x64 只有一套（微软定义的 x64 调用约定，前四个参数寄存器 `rcx/rdx/r8/r9`，栈上留 32 字节 shadow space——dbg-asm 那节从汇编侧量过）。`__cdecl`/`__stdcall`/`__fastcall` 关键字在 64 位上被编译器**忽略**，所以三种约定编译出来的符号一模一样。**64 位程序里声明不匹配调用约定不会炸**——这是 32 位移民过来的人最容易埋的雷：代码在 64 位下"碰巧能跑"，移植到 32 位目标立刻栈不平衡。
2. **32 位修饰是二进制接口的一部分**：`_stdcall_fn@8` 的 `@8` 是参数字节数。DLL 导出表里的名字带这个后缀，`GetProcAddress` 时必须用修饰后的全名（或 `.def` 文件导出别名）。**跨编译器调用 32 位 DLL 时，名字修饰不同 = 链接期找不到符号**——这是 MinGW 调 MSVC 编的 32 位 DLL 失败的第一原因。
3. **C++ 符号两套 ABI 互不相认**：MinGW 32/64 位都用 Itanium ABI（`__Z` 前缀）；MSVC 用自己的方案（`?name@@YAXXZ` 形式）。**同名同签名的 C++ 函数，两家编译出来符号不同**——所以跨工具链的 C++ 库接口几乎必须用 `extern "C"` 包一层，这也是所有跨平台 C API 存在的原因。

## 二、CRT：MinGW 的 `-static` 和 MSVC 的 `/MT` 不是一回事

实测一个用了 `<string>`/`<iostream>` 的 C++ 程序，默认链接 vs `-static`：

```
dyn    56,993 B: 4 个 DLL（KERNEL32 / msvcrt / libstdc++-6 / libgcc_s_seh-1）
static 2,519,475 B: 2 个 DLL（KERNEL32 / msvcrt）
```

- **体积涨 44 倍**（57 KB → 2.5 MB）：libstdc++ 和 libgcc 被静态链进来。换来的是目标机器不要求 `libstdc++-6.dll`/`libgcc_s_seh-1.dll` 在场——Qt for MinGW 的部署清单里这两个是常客（qt-cross-platform 那节量过 MinGW 版 Qt6Gui.dll 依赖它们）。
- **但 `msvcrt.dll` 依然是动态依赖**。这是 MinGW-w64 和 MSVC 最大的行为差异之一：MSVC 的 `/MT` 把 C 运行时也静态化（`LIBCMT.lib`），产物**不依赖任何 vcruntime/msvcrt**；**MinGW 的 `-static` 没有静态版 msvcrt 可用**（官方工具链不提供），C 运行时永远走系统的 `msvcrt.dll`。工程含义：MinGW 产物在**干净 Windows** 上能跑（msvcrt.dll 是系统组件），但拿不到 MSVC `/MT` 那种"完全自包含"——想自包含只能上静态构建加自己打包 CRT，或者接受这个依赖。
- **文档级提醒（未实测）**：MSVC 侧还有 `/MD` 与 `/MT` 之争、vcruntime140.dll 的 UCRT 拆分、以及**混用两种 CRT 的后果**（跨模块传 `FILE*`/`malloc` 的内存会踩各自的堆）。这些在 MSVC 项目里是真问题，MinGW 侧因为只有一个 msvcrt 反而天然没有。

## 三、导入库与链接：`.a` 与 `.lib` 的世界

实测 Qt 6.9.3 MinGW 的 lib 目录：**171 个 `.a`，其中 `libQt6Core.a` 直接就是导入库**——MinGC 生态不区分"静态库"和"DLL 导入库"的后缀，都是 `.a`（内部格式不同，链接器自己认）。对照文档级知识：MSVC 生态导入库是 `.lib`（和静态库同名后缀）、DLL 导出库由 `lib.exe` 生成。

实践含义：**给 MinGW 程序链第三方库时，找不到 `.lib` 不是没有库，是拿错了生态的产物**。要么找 MinGW 构建的 `.a`/`.dll.a`，要么从 DLL 自己生成导入库（`gendef` + `dlltool`，本文未实测流程）。

## 四、windres 与资源：UTF-8 源码的暗礁

同一个 UTF-8 编码的 `.rc` 文件，加不加 `#pragma code_page(65001)`：

```
无 code_page:  t.o  228 字节
有 code_page:  t2.o 220 字节
```

差 8 字节——字符串资源里的中文被按不同代码页编码：不加 pragma 时 windres 按本地代码页解释源文件，UTF-8 字节被逐个当成扩展 ASCII 字符，存进资源的是**乱码码点串**；加了 `65001`（UTF-8）后正确解码，UTF-16 存储更紧凑。win-resource 那节有 LoadString 读回级的完整实测（9 个乱码码点 → 6 个正确码点）。**这条对用 MinGW 构建带中文资源的项目是必配项**——源码文件是 UTF-8（现代编辑器的默认），不加 pragma 就是乱码。

其余工具链差异（文档级，未实测）：MSVC 的资源编译器是 `rc.exe`（行为与 windres 大体一致但选项不同）；清单（manifest）两边都支持但 windres 也能编译 `.manifest` 进资源；子系统标志 MinGW 用 `-mwindows`/`-mconsole`，MSVC 用 `/SUBSYSTEM:WINDOWS`——作用相同。

## 五、头文件与声明的常见缺口（MinGW 侧经验）

MinGW 的头来自 MinGW-w64 项目自研的 Windows 头，**不是微软 SDK**。缺声明时的三板斧：

1. **先搜头确认真的没有**：`grep -r "符号名" $MINGW/include`。很多"缺失"是拼写或大小写（`Sleep` 在 `windows.h`，`QueryPerformanceCounter` 在 `winbase.h` 被 `windows.h` 包）。
2. **自己补声明**：缺的函数按文档原型声明、按 DLL 名动态拿（`LoadLibrary` + `GetProcAddress`）或声明 extern 后链到对应的 `-lxxx`。缺的 GUID 用 `DEFINE_GUID` 宏自己定义（win-com-shell 那节的探针就这么干的——MinGW 头里没有 `CLSID_ShellLink` 的定义，`DEFINE_GUID` 配 `initguid.h` 解决）。
3. **缺 enum/struct 成员**：按 SDK 位布局自己声明再强转（dbg-memory 那节量过 `HEAP_INFORMATION_CLASS` 在 MinGW 头里只有两个成员的坑）。

**文档级提醒（未实测）**：MSVC 用真正的 Windows SDK，头文件新、成员全；MinGW 的头覆盖度依赖 MinGW-w64 的跟进速度，新 API（特别是较新的 shell/COM 接口）可能缺。这也是"同一份代码 MSVC 编过 MinGW 缺声明"的最常见原因。

## 六、未实测清单

- MSVC 的 `cl.exe` 全部行为：`/MT`/`/MD` 的实际产物差异、`.lib` 生成、`/Zc` 系列一致性开关——本机无 MSVC。
- MinGW 调用 MSVC 编的 DLL 的完整链路（拿 `.lib` 转 `.a` 或 `dlltool` 生成）——未测。
- LLVM/Clang-cl 与两套工具链的兼容性——未涉及。
- 32 位构建的完整部署（本机 multilib 可用性仅验证了编译目标文件，未做完整 32 位 exe 运行测试——`-m32` 链接需要 32 位运行时库齐全）。
