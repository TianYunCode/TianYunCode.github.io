---
title: Qt 6 框架总览与工程搭建
description: 实测：Q_OBJECT 让 108 行头文件膨胀成 1109 行 C++、单 TU 编译 +26%，但对象体积一字节不加；忘跑 moc 的签名是 `undefined reference to 'vtable for Widget'`；CMAKE_PREFIX_PATH 不写，CMake 会静默挑中另一套 Qt 再在链接期炸出 3 条 __imp_ 未定义引用；w.show() 返回 0.0ms 且一次 Paint 都没派发。
date: 2026-10-15
tags: [Qt, CMake, moc]
category: qt6
section: qt-overview
---

> 环境：Windows 11 x64（10.0.26200），**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`），GCC 13.1.0（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`；PATH 上默认的 g++ 是 Strawberry Perl 的 4.9.2 32 位，不能用），CMake 3.30.5 + Ninja 1.12.1，`-DCMAKE_BUILD_TYPE=Release`。GUI 实验用 `QT_QPA_PLATFORM=offscreen` 无头跑，绝对时间每项跑 5–7 次取中位数并给区间。

## 一、版本策略：三段式，语义是硬的

```text
QT_VERSION_STR          = 6.9.3
qVersion()              = 6.9.3
QT_VERSION              = 0x060903 -> 6.9.3
sizeof(qsizetype)       = 8   sizeof(void*) = 8
QT_VERSION_CHECK(6,9,3)  <= QT_VERSION ? yes
QT_VERSION_CHECK(6,9,4)  <= QT_VERSION ? no
QT_VERSION_CHECK(6,10,0) <= QT_VERSION ? no
QT_VERSION_CHECK(5,15,0) <= QT_VERSION ? yes
```

版本号语义在 Qt 6 里是硬的：**主版本 = ABI 断代**（Qt5/Qt6 的导入库、`qt_metacall` 编号方式全不兼容）；**次版本 = 新 API + 可能的行为变化**（6.8 → 6.9 就能让老代码冒出 deprecation 警告）；**补丁版本只修 bug**，可以滚动升级。兼容分支只有一种正确写法 `#if QT_VERSION >= QT_VERSION_CHECK(6,5,0)`，不要比较字符串。

`qsizetype` 已全面替代 `int` 做容器长度，本机 `sizeof(qsizetype) == sizeof(void*) == 8`。把 `list.size()` 交给 `int` 在 Qt 6 是**窄化**，`-Wall -Wextra` 会报 conversion warning——Qt5 老工程迁移时这类告警通常成百上千条，而且它们是真的会溢出。

查"这套 Qt 到底是什么"的最短路径是 `QLibraryInfo`：

```text
QLibraryInfo::build()        = Qt 6.9.3 (x86_64-little_endian-llp64 shared (dynamic) release build; by GCC 13.1.0)
QLibraryInfo::isDebugBuild() = 0
QLibraryInfo::isSharedBuild()= 1
QLibraryInfo::version()      = 6.9.3
  PrefixPath    D:/Qt/6.9.3/mingw_64      Plugins    D:/Qt/6.9.3/mingw_64/plugins
  Libraries     D:/Qt/6.9.3/mingw_64/lib  Binaries   D:/Qt/6.9.3/mingw_64/bin
```

`build()` 那行里的 `x86_64-little_endian-llp64` 是 ABI 标识——**MSVC 那套输出同一个字符串**，因为 ABI 确实相同。但"相同 ABI ≠ 相同链接格式"，这正是第三节那个坑的根源。另外 Qt 6.9 已把 `QLibraryInfo::location()` 和 `qSharedBuild()` 放进 `QT_DEPRECATED_SINCE(6, 9)` 墓碑区，枚举类型名也从 `Location` 改成 `LibraryPath`。

## 二、模块划分：分层不能跳

本机 Qt 6.9.3 MinGW 装了 **352 个 CMake 包目录（`lib/cmake` 下一级）、142 个 `Qt6*.dll`、70 个插件 DLL 分布在 26 个插件类别目录**。实测各模块体积：

| 模块 | release MB | .debug MB | 模块 | release MB | .debug MB |
| --- | --- | --- | --- | --- | --- |
| Core | 10.36 | 184.92 | Qml | 5.84 | 440.95 |
| Gui | 10.85 | 454.93 | Quick | 6.94 | 496.15 |
| Widgets | 6.79 | 252.17 | Network | 1.94 | 107.33 |
| Sql | 0.32 | 11.74 | Concurrent | 0.04 | 0.91 |
| Svg | 0.57 | 22.85 | PrintSupport | 0.40 | 26.40 |
| Test | 0.43 | 21.30 | Xml | 0.15 | 3.11 |

三条从数字里读出来的结论：

1. **大头是 Core + Gui（各 10MB 量级），Widgets 只有 6.79MB**。别以为 Widgets 是巨无霸；任何 Qt 程序都跑不掉下面两层，"用 QML 就不用 Gui"是自欺——Quick 6.94MB 照样压在 Gui 10.85MB 上。
2. **`.debug` 是 release 的 18～76 倍**（Gui 455MB、Quick 496MB、Qml 441MB）。`bin` 目录的体积几乎全由调试符号贡献，CI 拷贝产物时排除 `*.debug` 能砍掉 95% 以上。
3. `Concurrent` 0.04MB、`Xml` 0.15MB——链它们的价格可忽略，代价在"部署时多一个 DLL 项"。

依赖必须一级一级来：`Qt6::Widgets` 自动带上 `Qt6::Gui` 和 `Qt6::Core`，但**只链 `Qt6::Gui` 拿不到任何按钮**，只链 `Qt6::Core` 连 `QGuiApplication` 都构造不出来。

| 层 | 模块 | 依赖 | 干什么 |
| --- | --- | --- | --- |
| 底座 | QtCore | — | 字符串/容器/元对象/事件循环/QThread/QSettings |
| 图形 | QtGui | Core | 光栅绘制、字体、窗口抽象、输入事件类（**无控件**） |
| 控件 | QtWidgets | Core+Gui | 按钮、布局、对话框 |
| 声明式 | QtQml / QtQuick | Core+Gui(+Widgets) | QML 引擎与场景图 |
| 服务 | Network / Sql / Concurrent / Test / Svg / PrintSupport | Core | 彼此独立，按需链 |

## 三、CMake 集成：`CMAKE_PREFIX_PATH` 不是可选的

```cmake
cmake_minimum_required(VERSION 3.21)
project(qt6s1 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
qt_standard_project_setup(REQUIRES 6.8)   # Qt 提供的公共设置：策略 + 目录布局 + AUTOMOC
add_executable(app main.cpp)
target_link_libraries(app PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets)
```

```text
cmake -S . -B build -G Ninja ^
  -DCMAKE_CXX_COMPILER=D:/Qt/Tools/mingw1310_64/bin/g++.exe ^
  -DCMAKE_PREFIX_PATH=D:/Qt/6.9.3/mingw_64
```

本机同时装了 `msvc2022_64` 和 `mingw_64`，而且 `D:/Qt/6.9.3/msvc2022_64/bin` **在 PATH 上**。不写 `CMAKE_PREFIX_PATH` 时 CMake 选了谁：

```text
-- CMAKE_PREFIX_PATH=[]
-- Qt6_DIR=D:/Qt/6.9.3/msvc2022_64/lib/cmake/Qt6
-- Qt6_VERSION=6.9.3
-- Configuring done (5.3s)
```

configure **全绿**（`--debug-find` 显示它是从 PATH 里那个 `…/msvc2022_64/bin` 反推出前缀的）。真正的爆炸在链接：

```text
[2/2] Linking CXX executable h.exe
FAILED: h.exe
  g++.exe CMakeFiles/h.dir/h.cpp.obj -o h.exe ... D:/Qt/6.9.3/msvc2022_64/lib/Qt6Core.lib ...
ld.exe: h.cpp.obj:h.cpp:(.text+0x86): undefined reference to `__imp__ZN16QCoreApplicationC1ERiPPci'
ld.exe: h.cpp.obj:h.cpp:(.text+0xb6): undefined reference to `__imp__ZN16QCoreApplicationD1Ev'
ld.exe: h.cpp.obj:h.cpp:(.text+0xcd): undefined reference to `__imp__ZN16QCoreApplicationD1Ev'
collect2.exe: error: ld returned 1 exit status
```

MSVC 那套发的是 COFF 格式的 `Qt6Core.lib`，GNU ld 认不得，于是每个 Qt 符号都变成 `__imp_` 未定义。把 `msvc2022_64/bin` 从 PATH 摘掉，报错才变成教科书式的引导：

```text
CMake Error at CMakeLists.txt:3 (find_package):
  Could not find a package configuration file provided by "Qt6" with any of
  the following names:
    Qt6Config.cmake
    qt6-config.cmake
  Add the installation prefix of "Qt6" to CMAKE_PREFIX_PATH or set "Qt6_DIR"
  to a directory containing one of the above files.
```

组件名写错时**错误信息不指出是哪个组件**，只打印它实际找到的那份 config：

```text
-- Could NOT find Qt6NoSuchModule (missing: Qt6NoSuchModule_DIR)
CMake Error at CMakeLists.txt:3 (find_package):
  Found package configuration file:
    D:/Qt/6.9.3/msvc2022_64/lib/cmake/Qt6/Qt6Config.cmake
  but it set Qt6_FOUND to FALSE so package "Qt6" is considered to be NOT FOUND.
```

所以第一条规矩：**显式写 `CMAKE_PREFIX_PATH`，并在 CMakeLists 里 `message(STATUS "Qt6_DIR=${Qt6_DIR}")` 把它打出来**。Qt Creator 侧的等价物是 Kit——编译器和 Qt 版本必须同族（MSVC 配 msvc2022_64，MinGW 配 mingw_64），混了就是一样的 `__imp_`。

构建耗时（2 目标小工程，Release，5 次）：

| 阶段 | 中位数 | 区间 |
| --- | --- | --- |
| configure + generate | 5.2 s（CMake 自报） | 8.3 – 10.0 s（含进程启动） |
| 干净全量（configure+编译+链接 2 个 exe） | 13.4 s | 13.1 – 14.5 s |
| 只改 5 行 .cpp 后增量 | 5.7 s | 5.1 – 6.7 s |

增量那 5.7 秒里几乎没有编译工作，大头是 **AUTOMOC 的 re-check + 两个 exe 重新过一遍 10MB 级的导入表**。这就是 Qt 项目"改一行也要等一下"的来源。

另一条 Windows 专属细节：`add_executable(... WIN32 ...)` 的差别只在 PE 子系统。

```text
c_app.exe 69939 字节  Subsystem 00000002 (Windows GUI)
w_app.exe 52587 字节  Subsystem 00000003 (Windows CUI)
```

同一份 `main.cpp`，GUI 子系统版本**看不见任何 stdout 输出**。调试期用 CUI，发布再切 WIN32。

## 四、moc 在构建里做什么

`Q_OBJECT` 不是 C++ 语法，是一段**必须由外部工具翻译成 C++ 的声明**。一个 2 信号 + 2 槽的类，moc 生成 **143 行 / 4619 字节**，产出四样东西：字符串池（类名/方法名/参数名）、整型元数据表（类型与访问级别 + `QMetaType` 索引）、`qt_static_metacall` 的 switch（把整数 id 折回真实 C++ 调用），以及第四样最关键的——**信号本体**：

```cpp
// SIGNAL 0                                    （moc 生成，不是你写的）
void Counter::changed(int _t1) { QMetaObject::activate<void>(this, &staticMetaObject, 0, nullptr, _t1); }
```

**`emit` 只是调用 `QMetaObject::activate`，信号根本不是"你写的那个方法"。**

漏了 moc 的三种失败面孔全在**链接期**，编译器一声不响：

```text
// 只 Q_OBJECT，不 emit 不 connect
ld.exe: undefined reference to `vtable for Widget'

// Q_OBJECT + emit 信号
ld.exe: undefined reference to `Widget::pressed()'
ld.exe: undefined reference to `vtable for Widget'

// Q_OBJECT + 取 staticMetaObject（例如新式 QObject::connect）
ld.exe: undefined reference to `Widget::staticMetaObject'
ld.exe: undefined reference to `Widget::pressed()'
ld.exe: undefined reference to `vtable for Widget'
```

**`undefined reference to 'vtable for X'` 就是"X 有 Q_OBJECT 但没被 moc 处理"的标准签名。** AUTOMOC 会拦掉一部分，而且说得很直白（`Q_OBJECT` 写在 `.cpp` 里却没有 `#include "xxx.moc"`）：

```text
AutoMoc error
-------------
"SRC:/lab1_moc.cpp"
contains a "Q_OBJECT" macro, but does not include "lab1_moc.moc"!
Consider to
  - add #include "lab1_moc.moc"
  - enable SKIP_AUTOMOC for this file
```

moc 的成本实测（5 次中位数，N = 信号数和槽数各 N）：

| 类规模 | 输入行数 | moc 输出 | 字节 | moc 耗时中位（区间） |
| --- | --- | --- | --- | --- |
| — （`moc -v` 立刻退出，基线） | — | — | — | 187 ms (160–301) |
| N = 0（空 Q_OBJECT） | 2 | 90 行 | 2.7 KB | — |
| N = 10 | 28 | 309 行 | 14.4 KB | 184 ms (167–200) |
| N = 50 | 108 | 1109 行 | 59.7 KB | 212 ms (185–219) |
| N = 200 | 408 | 4109 行 | 231.2 KB | 174 ms (158–427) |

**moc 的耗时和成员数量无关，187ms 的基线里几乎全是进程启动**——解析 408 行头文件并没有比解析 28 行更贵。所以"工程里有多少个 QObject 类"的真实成本是 `类数量 × 一次进程创建`，Ninja 会并行它，但 Windows 起进程本身就贵。膨胀倒是实打实的：**约 10 倍**，外加每类 90 行的固定底噪。

真正花钱的是编译期。同一个 50 信号 + 50 槽的类，两种 TU 各编译 7 次：

```text
不含 Q_OBJECT（对照）      中位数 1925 ms  区间 1783 – 2109 ms
含 Q_OBJECT + moc 产物     中位数 2429 ms  区间 2194 – 2553 ms
```

**+504ms，约 +26%，全部落在编译期。** 运行时反倒一字节都不多：

```text
sizeof(QObject)                = 16      sizeof(WithInt)   无 Q_OBJECT + int = 24
sizeof(Bare)    无 Q_OBJECT 零成员 = 16   sizeof(WithIntMO) 有 Q_OBJECT + int = 24
sizeof(Plain)   有 Q_OBJECT 零成员 = 16   sizeof(TenSig)  10 个信号           = 16
```

**`Q_OBJECT` 加 0 字节，信号加到 10 个还是 16 字节**：字符串池和整型表都是 `static`、每类一份；`metaObject()` 重写的是 QObject 已有的虚槽位，vptr 本来就在。所以"要不要加 Q_OBJECT"不该拿内存说事，要权衡的是那 26% 的编译时间——顺手还得到"moc 产物独立成 TU、头文件不动就不重编"的好处。

元对象表跑出来的实际内容：

```text
className()             = Counter      superClass()->className = QObject
QObject 自带 methodCount = 4
  [ 4] Signal  changed(int)  params=(int)  return=void
  [ 5] Signal  overflow()    params=()     return=void
  [ 6] Slot    add(int)      params=(int)  return=void
  [ 7] Slot    reset()       params=()     return=void
合计 methodCount=8 signals=5 slotCount=3 plain=0 propertyCount=1
```

`signals=5` 里 3 个是白送的（`destroyed(QObject*)`、`destroyed()`、`objectNameChanged(QString)`），`slotCount=3` 里 1 个是 `deleteLater()`，`propertyCount=1` 是继承来的 `objectName`。**每写一个 QObject 子类，元对象表自动带 4 个方法。** 反射完全靠这张表：

```text
invokeMethod("add", Q_ARG(int,40)) ok=1 -> value=40 信号 seen=40
invokeMethod("reset")              ok=1 -> value=0  信号 seen=0
invokeMethod("noSuchSlot")         ok=0
```

签名匹配是**规范化后的字符串比较**，两个方向都会翻车：

```text
indexOfMethod("add(int)")    = 6
indexOfMethod("add")          = -1
indexOfSignal("changed(int)") = 4
indexOfSignal("changed(int newValue)") = -1   <- 带上参数名反而不匹配
```

参数类型列表必须写全，**参数名必须去掉**——moc 存表时把 `changed(int newValue)` 规范成了 `changed(int)`，而 `indexOfSignal()` 对入参只做很浅的规范化。

## 五、第一个窗口：从 main 到事件循环

`show()` 不是画图，是**排事件**。给 `QWidget` 挂上事件过滤器：

```text
构造 QWidget 后事件计数       0
w.show() 返回                0.0 ms  show 时事件计数=9
show() 之后不转循环 -> Paint 次数 = 0
app.exec() 返回 0，阻塞 49.0 ms，Timer 触发 5 次，循环内新增事件 14 个
```

- **`w.show()` 只花 0.0 ms**，一个像素都没画；
- **`show()` 返回时窗口"已可见"，但一次 `Paint` 都没派发**——第一帧必然来自 `app.exec()` 之后事件循环送进来的事件；
- 启动成本在 QPA 后端，不在控件。三种 Application 各跑 5 次（构造 → `show()` → 退出）：

| 构造 | offscreen | 真实 windows 平台 | 进程模块数（offscreen / windows） |
| --- | --- | --- | --- |
| `QCoreApplication` | 2 – 3 ms | 2 – 3 ms | 42 / 42 |
| `QGuiApplication` | 51 – 81 ms（中位 60） | 83 – 205 ms（中位 144） | 47 / 62 |
| `QApplication` + `show()` | 55 – 84 ms（中位 69） | **339 – 393 ms（中位 369）** | 47 / **78** |

**Core → Gui 就是 +58ms**（平台插件、字体数据库、GUI 事件派发器），Gui → Widgets 只再加 9ms（offscreen）。但换成真实的 `qwindows.dll`，`QApplication + show()` 直接跳到 **369ms、78 个模块**，多出来的是 `qmodernwindowsstyle.dll` 和一批系统 DLL。

`show()` + 首轮事件循环实际派发的事件构成（type 号来自 `QEvent::Type`，各 1 次除注明外）：

| 事件 | type | 事件 | type | 事件 | type |
| --- | --- | --- | --- | --- | --- |
| Enter | 10 | WindowActivate / Deactivate | 24 / 25 | PolishRequest / Polish | 74 / 75 |
| **Paint** | **12** | ShowToParent / HideToParent | 26 / 27 | UpdateRequest / UpdateLater | 77 / 78 |
| Move / Resize | 13 / 14 | WindowIconChange | 34 | CursorChange / WinIdChange | 183 / 203 |
| Show / Hide / Close | 17 / 18 / 19 | Window | 99（×2） | GraphicsSetup | 217（×2） |

`PolishRequest/Polish`（样式与调色板就绪）、`WinIdChange`（拿到原生窗口 id 才能画）、`GraphicsSetup`（QPA 后端准备好合成面）都排在这一轮里。**"窗口显示出来"在 Qt 里是二十几个事件的有序队列，不是一个函数调用。**

事件循环没转之前投递的事件不会丢：

```text
exec() 之前 postEvent(QEvent::User)，此时已派发 0 次
processEvents() 之后已派发 1 次
```

`postEvent()` 只入队（Qt 6 里它返回 `void`，不告诉你成功与否）。于是 main 的形状是固定的：

```cpp
int main(int argc, char **argv) {
    QApplication app(argc, argv);      // 必须在任何 QWidget 之前
    QWidget w; w.resize(320, 200);
    w.show();                          // 入队，不画图
    return app.exec();                 // 从这里起才有画面；quit() 后返回退出码
}
```

`app.exec()` 返回 0 是因为定时器里调了 `app.quit()`；什么都不做它就**永远阻塞**。`quitOnLastWindowClosed` 默认是 1——"关掉最后一个窗口程序就退出"不是魔法，是 `Close` 事件走完后 QPA 替你调了一次 `quit()`。

## 六、Qt 6 里已经不成立的旧写法（逐条编译验证）

| 旧写法 | Qt 6.9.3 + GCC 13.1 的真实结果 |
| --- | --- |
| `qAsConst(x)` | **能编译**，警告 `'qAsConst' is deprecated: Use std::as_const() instead. [-Wdeprecated-declarations]` |
| `QRegExp re("a+");` | `error: 'QRegExp' was not declared in this scope`——需装 Core5Compat 组件并链 `Qt6::Core5Compat` |
| `Qt::Flags f = ...` | `error: 'Flags' is not a member of 'Qt'`——改 `Qt::Alignment` / `QFlags<Qt::WindowType>` |
| `QString::SkipEmptyParts` | `error: 'SkipEmptyParts' is not a member of 'QString'`——改 `Qt::SkipEmptyParts` |
| `foreach (int x, {1,2,3})` | `error: macro "Q_FOREACH" passed 4 arguments, but takes just 2`——花括号里的逗号被宏切碎，换 `for (int x : {1,2,3})` |
| `Qt::mightBeRichText(s)` | `error: 'mightBeRichText' is not a member of 'Qt'`——它是 QtGui 的自由函数，`#include <QTextDocument>` |

`qAsConst` 那条值得强调：**"Qt 6 已删除"的说法是错的，它现在只是 deprecation 警告**。要区分"已删"（编译错误）和"将删"（警告），只能靠 `-Wall -Wextra` 全量扫一遍，不能照旧文章改代码。

## 七、小结

- 版本比较只用 `QT_VERSION_CHECK`；`QLibraryInfo::build()` 打印 ABI/release/编译器，是"两套 Qt 混了"的第一现场。`qsizetype` 已是 8 字节，`size()` → `int` 是真窄化。
- 体积账：Core 10.36 / Gui 10.85 / Widgets 6.79 MB；`.debug` 是 release 的 17–70 倍，部署时排除 `*.debug` 砍掉 95%。
- **`CMAKE_PREFIX_PATH` 必须显式写**：本机不写就静默选中 `msvc2022_64`，configure 全绿，链接期 3 条 `undefined reference to '__imp__ZN16QCoreApplication...'`。耗时参考：干净全量 13.4s、改 5 行增量 5.7s（贵在 AUTOMOC re-check 和重链）。
- moc 生成字符串池 + 整型元数据表 + `qt_static_metacall` 的 switch + **信号本体**。漏 moc 的签名是 `vtable for X` 未定义；`.cpp` 里的 Q_OBJECT 会被 AUTOMOC 提前拦下并给出可执行的修复建议。
- 成本量化：元数据膨胀约 **10 倍**（108 → 1109 行，空类也有 90 行底噪）、单 TU 编译 **+26%**（1925 → 2429ms）；moc 自身 187ms 全是进程启动、与成员数无关；**`Q_OBJECT` 对象体积 +0 字节**。
- 第一个窗口：`show()` 0.0ms 返回且**零 Paint**，第一轮循环补齐 20+ 个事件；`QApplication + show()` 在真实 windows 平台 **369ms / 78 模块**，offscreen 只要 69ms / 47。
- 旧写法要编译验证不要凭记忆：`qAsConst` 只是警告，`QRegExp` / `Qt::Flags` / `QString::SkipEmptyParts` 是真错误。

下一节进入信号槽的五种连接写法：函数指针版与字符串版在编译期检查、拼写容错、断开能力上的实测差异，以及一次 `connect` 到底花多少钱。
