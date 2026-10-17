---
title: CMake 现代用法：生成器决定一切形状，可见性关键字决定谁能编译过
description: 实测：生成器列表里没有 VS 18、MinGW Makefiles 下 CMAKE_BUILD_TYPE 是空串；PRIVATE 头目录不传播；find_package 不加 REQUIRED 静默成功。
date: 2026-10-16
tags: [编译构建, CMake, 生成器, 目标属性]
category: build
section: build-cmake
---

> 环境：**CMake 3.30.5（`D:/Qt/Tools/CMake_64/bin/cmake.exe`）**，Windows 11 x64，编译器 `D:/Qt/Tools/mingw1310_64/bin/{gcc,g++}.exe`（GCC 13.1.0）。所有报错、缓存串、`flags.make` 内容、文件是否存在都是本机原文。本节刻意把结论压在**与机器负载无关**的量上：生成器名、缓存变量值、退出码、报错原文、展开后的 flag 串。两处耗时（配置阶段 10.4s vs 4.9s）只跑了一次样本，只当量级看。

## 一、先认清"你这台机器能选哪些生成器"

```text
$ cmake --help
  The following generators are available on this platform (* marks default):
* Visual Studio 17 2022        = Generates Visual Studio 2022 project files.
  Visual Studio 16 2019        = ...
  Visual Studio 15 2017 [arch] / 14 2015 [arch] / 12 2013 [arch]（已 Deprecated）
  Borland Makefiles
  NMake Makefiles
  NMake Makefiles JOM
  MSYS Makefiles
  MinGW Makefiles              = Generates a make file for use with mingw32-make.
  Green Hills MULTI
  Unix Makefiles
  Ninja
  Ninja Multi-Config
```

两条本机特有的坑：

1. **PATH 里有 `D:/Microsoft Visual Studio/18/Enterprise/...`，但这份 CMake 的列表最高只到 "Visual Studio 17 2022"**。老版本 CMake 不认识新 VS 大版本，`-G "Visual Studio 18 2026"` 会直接报未知生成器。**CI 里升级 VS 不等于升级编译器，得先升 CMake。**
2. **默认生成器是 VS，不是 make**（列表里的 `*` 就落在 VS 17 2022）。所以在 Windows 上"我就随手 `cmake -S . -B build`"的人，拿到的是**多配置**的 `.vcxproj`，而不是 Makefile：

```text
bdef/ALL_BUILD.vcxproj
bdef/ZERO_CHECK.vcxproj
...
```

（第四节讲过 make 的名字问题：`-G "MinGW Makefiles"` 挑的是 `mingw32-make.exe`，`-G "Unix Makefiles"` 会挑到 `C:/Strawberry/c/bin/gmake.exe`——4.1、32 位。**同一句 `cmake --build` 在两个生成器下驱动的是不同的 make。**）

## 二、单配置 vs 多配置：这是 CMake 里最容易搞错的一刀

同一个 `CMakeLists.txt`，两种生成器，配置阶段读回的关键变量：

```text
（默认，未写 -G）  -- gen=Visual Studio 17 2022  cfgs=Debug;Release;MinSizeRel;RelWithDebInfo  bt=
（-G "MinGW Makefiles"）-- gen=MinGW Makefiles   cfgs=                                        bt=
```

- **多配置生成器有 `CMAKE_CONFIGURATION_TYPES`，`CMAKE_BUILD_TYPE` 永远是空**——它不存在"这一个 build type"。
- 单配置生成器两个都空，除非你显式 `-DCMAKE_BUILD_TYPE=...`。

行为差别实测：

| 操作 | 结果 |
| --- | --- |
| `cmake --build bdef`（不带 `--config`） | 产物落在 **`bdef/Debug/app.exe`** |
| 再 `cmake --build bdef --config Release` | **`bdef/Debug/app.exe` 和 `bdef/Release/app.exe` 同时存在** |
| `cmake --build bmg --config Release`（MinGW 单配置） | **退出码 0，`--config` 被静默忽略** |
| `cmake -S . -B bt -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release` | `flags.make` 里 `CXX_FLAGS = -O3 -DNDEBUG` |
| 同上 `-DCMAKE_BUILD_TYPE=Debug` | `CXX_FLAGS = -g` |

三条要记住的：

1. **`--config` 在单配置生成器上不是错误，是空操作**。CI 矩阵里"Windows 用 VS、Linux 用 Ninja 单配置"时，同一个 `--config Release` 参数在两边语义完全不同，而**失败表现是零**（rc=0）。
2. **多配置目录会把每档都留一份**，别以为 `--config` 会覆盖上一次；判新产物要看对应子目录。
3. **`Release` 展开成 `-O3 -DNDEBUG`，不是 `-O2`**（第七节《构建配置》量过这两个 flag 各自的体积差别）。这解释了为什么"从 CMake Release 切到手写 `-O2`"会看到行为差异——`assert` 两边都被 `NDEBUG` 关掉，但优化档不同。

顺带一条与第四节可复现性呼应的观察：`Release` 的 `CXX_DEFINES` 是**空串**，`-DNDEBUG` 是走 `CXX_FLAGS` 的——想在自己的 flag 后面追加 `-UNDEBUG` 时，顺序问题会直接决定 assert 活不活。

## 三、可见性关键字：`PRIVATE` 不传播，报错直接落在消费者头上

一个最小三角：`core.cpp` 需要 `inc/core.h`，三个可执行文件用同一份 `main.cpp`（`#include "core.h"`），区别只在链接时的可见性：

```cmake
add_library(pubsrc core.cpp)
target_include_directories(pubsrc PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/inc)
add_library(priv  core.cpp)
target_include_directories(priv  PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/inc)
add_library(intf_only INTERFACE)
target_include_directories(intf_only INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/inc2)
target_compile_definitions(intf_only INTERFACE INTF_MARK=11)

add_executable(uses_pub  main.cpp); target_link_libraries(uses_pub  PRIVATE pubsrc)
add_executable(uses_priv main.cpp); target_link_libraries(uses_priv PRIVATE priv)
add_executable(uses_intf main.cpp); target_link_libraries(uses_intf PRIVATE intf_only)
```

`cmake --build --target` 逐个构建的结果：

| 目标 | 退出码 | 现象 |
| --- | --- | --- |
| `uses_pub` | **0** | `Built target uses_pub` |
| `uses_priv` | **2** | `main.cpp:1:10: fatal error: core.h: No such file or directory` |
| `uses_intf` | **2** | 同上（`INTERFACE` 给的是 `inc2`，`core.h` 在 `inc`） |

**这就是 `PUBLIC/PRIVATE/INTERFACE` 唯一需要在意的判据：它决定"消费者的编译命令行里有没有那个 `-I`"。** 报错出现的位置永远是**调用方**的文件，而不是库自己——很多人第一反应去查库的目标属性，其实该查的是"我用的是 PRIVATE 吗"。

再用 `compile_commands.json` 复核（`-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`）：文件里有 **5 条**记录（3 个 exe + 2 个库的 `core.cpp`），其中**恰好一条带 `-DINTF_MARK=11`**——`INTERFACE` 库的宏确实传播到了它的消费者。**这是排查可见性问题最省事的手段：直接看编译数据库里的 `-I`/`-D`，不要靠记忆推断传播规则。**

（附带一条平台差异：`CMAKE_EXPORT_COMPILE_COMMANDS` 对 Makefile/Ninja 类生成器有效，**VS 生成器不产出这个文件**，所以"用 clang-tidy 跑一遍"的脚本在 Windows 的 VS 配置下会静默找不到数据库。）

## 四、`find_package`：失败长什么样，取决于你写没写 REQUIRED

```text
$ cmake -S . -B b -G "MinGW Makefiles"          # CMakeLists 里有 find_package(Boost REQUIRED)
CMake Error at D:/Qt/Tools/CMake_64/share/cmake-3.30/Modules/FindPackageHandleStandardArgs.cmake:233 (message):
  Could NOT find Boost (missing: Boost_INCLUDE_DIR)
Call Stack (most recent file first):
  .../FindPackageHandleStandardArgs.cmake:603 (_FPHSA_FAILURE_MESSAGE)
  .../FindBoost.cmake:2409 (find_package_handle_standard_args)
-- Configuring incomplete, errors occurred!
exit=1
```

去掉 `REQUIRED` 之后：**退出码 0**，配置继续，只是 `Boost_FOUND` 为空。**同一个缺失依赖，一个能让构建死，一个能让构建"成功但不带那个功能"**——这就是为什么模块化项目必须显式写清楚"必需还是可选"，否则 CI 绿了但产物少了东西。

报错原文里那串 `missing: Boost_INCLUDE_DIR` 才是有用信息：**它告诉你模块在找什么变量**。同一模块加 `-DBoost_DEBUG=ON` 会把搜索路径逐条打出来（这是老式 `FindBoost.cmake` 的调试开关，Config 模式的包没有）。

顺手记一条更常见的"找不到"：**Ninja 生成器在本机不可用**（没装 ninja），报错不是"ninja not found"而是往下游崩：

```text
CMake Error: CMAKE_CXX_COMPILER not set, after EnableLanguage
-- Configuring incomplete, errors occurred!
exit=1
```

**看到这句别去查编译器，先查生成器/构建工具在不在 PATH。**（第四节讲过 MinGW 那套 make 名字问题，同一个道理：驱动工具找不到时，CMake 报的是后果不是原因。）

## 五、构建目录是可缓存的，但它记住的东西比你以为的多

`CMakeCache.txt` 里与生成方式直接相关的三项：

```text
CMAKE_GENERATOR:INTERNAL=MinGW Makefiles
CMAKE_BUILD_TYPE:STRING=
CMAKE_HOME_DIRECTORY:INTERNAL=C:/Users/wangt/AppData/Local/Temp/agents/cmb
```

于是这两个动作的后果（本机原文）：

```text
$ cmake -S prop -B bmg        # 把另一个源码目录指到已用过的 build 目录
CMake Error: The source "C:/.../cmb/prop/CMakeLists.txt" does not match the source
"C:/.../cmb/CMakeLists.txt" used to generate cache.  Re-run cmake with a different
source directory.
exit=1
```

- **换生成器不能复用同一个 `-B`**：`CMAKE_GENERATOR` 一旦写进缓存，再 `-G` 换就报"generator 不一致"，必须删掉整个 build 目录。**CI 的 cache 策略如果按 tarball 大小来缓存，缓存了 build 目录就等于缓存了这个死结。**
- **换源码目录同样不行**（上面这句就是）。想同时保留两个配置，用 `build-debug/`、`build-release/` 两个目录，而不是同一个目录反复 `-D`。
- 本机配置阶段耗时：VS 生成器 **10.4 s**，MinGW Makefiles **4.9 s**（各一次样本，量级参考）。**多配置生成器的配置成本明显更高**，这是"本地开发用 Ninja/Makefiles、只在需要 IDE 时用 VS"的现实理由。

## 六、target 模型的最小可用规矩

把上面几节的实测结果压成四条：

1. **一切围绕 target**：`add_library`/`add_executable` 之后用 `target_*` 系列（`target_include_directories`、`target_compile_definitions`、`target_link_libraries`）配置，别用目录级 `include_directories`/`link_libraries`——第三节证明了可见性只影响"消费者的命令行"，而目录级命令把这件事变成了"当前目录及之后的所有人"，等于放弃控制。
2. **可见性三态的记忆法**：`PRIVATE`=只有我自己编得过；`PUBLIC`=我和用我的人都要带；`INTERFACE`=我自己没东西可编，用我的人带。判据永远是**编译数据库里那一行有没有对应 `-I`/`-D`**。
3. **`BUILD_INTERFACE` / `INSTALL_INTERFACE` 生成表达式**是用来区分"源码树里用哪个 include 目录"和"安装后用户用哪个"的——它们的求值时机在 **generate 阶段**而不是 configure 阶段（`configure_file` 会把 `$<...>` 原样写进去，因为它发生在 configure）。本节未做安装样本实测，规矩先记住：**生成表达式只能出现在 target 属性里，不能出现在 `if()` 条件里**。
4. **依赖发现优先 Config 模式**（包自己带的 `xxxConfig.cmake`），`Find<Name>.cmake` 是兜底。第四节那句 `missing: Boost_INCLUDE_DIR` 就是旧式模块的行为；现代包（如 Qt6）走 Config，报错形态完全不同（"Could not find a package configuration file provided by ..."）。

## 七、本节未在本机实测

- **MSVC 侧的一切**：本机 `cl.exe`/`link.exe` 不在 PATH（要 vcvars 环境），所以"VS 生成器实际调用哪个编译器、`-A x64/Win32` 的行为、`CMAKE_VS_PLATFORM_TOOLSET`"都没有实测值。本节里 VS 生成器只被用来**证明它是多配置、默认生成器、不产出 compile_commands.json**。
- **Ninja / Ninja Multi-Config**：本机没有 `ninja.exe`，第四节那条编译器报错就是它的替代证据；Ninja 与 Makefiles 的构建耗时对比未测。
- **`install()` 与 `EXPORT`/`install(TARGETS ...)` 生成的目标文件**、`DESTDIR` 暂存、`CMAKE_INSTALL_PREFIX` 的实际落点：未做多目录安装样本。
- **`FetchContent` / `ExternalProject`**：需要联网拉取，本机不做外部下载。
- **Qt6 的 Config 包发现**（`find_package(Qt6 REQUIRED COMPONENTS Widgets Sql)`）：Qt 侧专栏已有工程搭建一节，本节没有重复。
- **toolchain 文件与交叉编译**（`CMAKE_SYSTEM_NAME`、`CMAKE_FIND_ROOT_PATH`）：属于第六节 `build-cross`，本机没有目标平台工具链。

## 八、小结

- **默认生成器是 "Visual Studio 17 2022"**（`cmake --help` 里的 `*`），而本机装的 VS 18 在这份 CMake 3.30.5 的列表里**根本不存在**；不写 `-G` 就得到 `.vcxproj`，写了 `-G "MinGW Makefiles"` 才得到 make 工程，而 `-G "Unix Makefiles"` 会挑到 Strawberry 的 32 位 `gmake.exe`。
- **多配置与单配置是两套模型**：VS 侧 `CMAKE_CONFIGURATION_TYPES=Debug;Release;MinSizeRel;RelWithDebInfo` 且 `CMAKE_BUILD_TYPE` 恒空；不带 `--config` 的构建落在 **Debug**，加了 `--config Release` 后两份 exe **并存**；单配置生成器加 `--config` 是 **rc=0 的静默忽略**。`CMAKE_BUILD_TYPE=Release` 展开成 `-O3 -DNDEBUG`，Debug 只有 `-g`。
- **可见性只有一件事可测：消费者的命令行里有没有那个 `-I`/`-D`**。`PUBLIC` 让消费者编得过（rc=0），`PRIVATE` 让消费者 `fatal error: core.h: No such file or directory`（rc=2），`INTERFACE` 库的 `-DINTF_MARK=11` 出现在 `compile_commands.json` 的 5 条记录里的 1 条。
- **`find_package` 的 REQUIRED 决定生死**：写就 rc=1 并打印 `Could NOT find Boost (missing: Boost_INCLUDE_DIR)` + 模块调用栈；不写就 rc=0 而 `Boost_FOUND` 为空。**生成器/构建工具缺失时，CMake 报的是 `CMAKE_CXX_COMPILER not set, after EnableLanguage`，不是"工具没找到"。**
- **build 目录记住生成器与源码目录**，两者都不允许中途更换（`The source … does not match the source … used to generate cache`）；配置阶段耗时本机是 VS 10.4 s vs MinGW Makefiles 4.9 s（单次样本，量级参考）。
