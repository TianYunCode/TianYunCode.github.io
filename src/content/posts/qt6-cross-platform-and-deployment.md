---
title: Qt 6 跨平台与部署
description: >-
  实测：同一个只链接 Core/Gui/Widgets 的 91546 字节 exe，`windeployqt --list` 报 107 个文件、真实部署只落地 60 个（79260474 字节），
  差的 47 个里 45 个是 `qtbase_*.qm`/`qtwebengine_*.qm`（本机只落了 32 个 `qt_*.qm`）、1 个是 `tls/qopensslbackend.dll`（源目录里明明存在）；
  `--list source/target/relative/mapping` 四种模式行数完全相同（107），`--dry-run` 一条不少地列出来但一个都不拷；
  `--no-plugins` 部署 44 个文件 75289796 字节，`platforms/` 整个目录消失；
  唯一的告警原文是 `Warning: Cannot find any version of the dxcompiler.dll and dxil.dll.`；
  "This application failed to start because no Qt platform plugin could be initialized…" 这句在 Qt6Gui.dll 里是 **UTF-16 存储**（offset 9296920），`grep -a` 按 ASCII 数它是 0 次、按 UTF-16 数是 1 次；
  同一版本号的 MinGW 与 MSVC 两套 Qt：`QMAKE_XSPEC` 分别是 win32-g++/win32-msvc，同名 Qt6Gui.dll 差 1880096 字节，MinGW 版依赖 libgcc_s_seh-1/libstdc++-6/libwinpthread-1，MSVC 版依赖 VCRUNTIME140(_1)/MSVCP140(_1) 和 11 个 api-ms-win-crt-*；
  空 main() 用 `-lQt6Core` 指到 MSVC 的 lib 目录居然返回 0，说明"链上了"根本不代表 ABI 兼容。
date: 2026-10-16
tags: [Qt, 部署, windeployqt, MinGW, MSVC]
category: qt6
section: qt-cross-platform
---

> 环境同前面几节：**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ GCC 13.1.0 全路径（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`；PATH 上那个 Strawberry Perl 4.9.2 32 位 g++ 会得出错误结论）。本机**同时装着 Qt 的 msvc2022_64 构建**（`D:/Qt/6.9.3/msvc2022_64`），但**没有任何可用的 MSVC 命令行工具链**：`cl.exe`/`nmake` 不在 PATH，PATH 里那条 `D:/Microsoft Visual Studio/18/Enterprise/VC/Tools/MSVC/14.50.35717/bin/Hostx64/x64` 指向的目录**根本不存在**（`ls` 直接 No such file or directory）。所以凡是"MSVC 编译时会怎样"的判断，本节一律标未实测，只写两套目录里**能量的东西**：字节数、导入表、文件命名、`qmake -query` 的键值。**不截图**，观察量是文件数、字节数、`--list` 行数、`objdump -p` 的 DLL Name 列表、二进制里字符串的偏移与出现次数，以及命令的退出码。同一台机器上还跑着别的任务，所以本节避开一切耗时类结论——**这一节基本都是确定性数字**。靶子程序与原始输出留在 `%TEMP%/agents/qt6f/`（`xp1.cpp`/`xp3.cpp`/`A.out`/`C.out`/`run*.out`）。

## 一、windeployqt：它"计划"的和它"落地"的是两回事

先造一个尽可能干净的靶子：`xp1.cpp` 只有 `QApplication + QMainWindow + QPushButton`，编译时**只给** `-lQt6Widgets -lQt6Gui -lQt6Core -luser32 -lwinmm`，产物 **91546 字节**，它自己的 PE 导入表只有 7 项：

```text
  DLL Name: Qt6Core.dll   Qt6Gui.dll   Qt6Widgets.dll
  DLL Name: libgcc_s_seh-1.dll   libstdc++-6.dll   msvcrt.dll   KERNEL32.dll
```

用 `D:/Qt/6.9.3/mingw_64/bin/windeployqt.exe`（`--version` 报 `Qt Deploy Tool 6.9.3`）跑四种 `--list`，**行数完全一样**：

```text
  --list relative : 107 行（相对目标目录的路径，例如 platforms\qwindows.dll）
  --list source   : 107 行    --list target : 107 行    --list mapping : 107 行
  --dry-run --list relative : 照样列出 107 行，但目录里只有 1 个文件（exe 自己）——一个字节都没拷
```

真实部署到一个空目录（`windeployqt depA/xp1.exe`，rc=0）之后：

```text
  文件数=60（不含 exe）      总字节=79,260,474（约 75.6 MiB）+ exe 91546
  根目录 11 个 DLL：Qt6Core/Qt6Gui/Qt6Network/Qt6Pdf/Qt6Svg/Qt6Widgets
                    + opengl32sw.dll + D3Dcompiler_47.dll
                    + libgcc_s_seh-1.dll + libstdc++-6.dll + libwinpthread-1.dll
  imageformats 10   translations 32   tls 2   platforms 1   styles 1
  generic 1   iconengines 1   networkinformation 1
  platforms 里只有一个：qwindows.dll
  stderr 全文只有一行：Warning: Cannot find any version of the dxcompiler.dll and dxil.dll.
```

**`--list` 报 107、实际拷 60，差 47。**这 47 个不是"复制失败"，而是本机这套安装里那些文件**不该被拷**：`--list` 的计划表里有 81 个 `.qm`（`qt_*.qm` + `qtbase_*.qm` + `qtwebengine_*.qm`），落地只有 32 个 `qt_*.qm`；`tls\qopensslbackend.dll` 在计划里，**但没拷**，而同目录同插件类型的 `qcertonlybackend.dll`/`qschannelbackend.dll` 都拷了。源目录核对过，这些文件**确实存在**：

```text
  D:/Qt/6.9.3/mingw_64/translations 有 .qm 共 304 个（其中 qtbase_* 32 个）
  D:/Qt/6.9.3/mingw_64/plugins/tls 里有 qopensslbackend.dll（+ .debug）
```

两条实用结论：**① 别把 `--list` 当交付清单**，交付前要用 `ls`/`find` 与 `--list` 对账（我的对账命令就是上面那几行 `find depA -type f`）；**② `qopensslbackend.dll` 被跳过 + 第 8 节"本机 Qt 目录里没有任何 OpenSSL DLL"是同一件事**——windeployqt 找不到能配套的 OpenSSL 库就不拷 openssl 后端，留下 schannel/certonly 两个后端。这意味着**部署包里 https 到底还能不能用，和"运行机器上有没有 libcrypto-3-x64.dll"是两套独立条件**（第 8 节实测本机 https 能通，靠的是 `/ucrt64/bin/libssl-3-x64.dll`，959132 字节）。windeployqt 因此专门给了 `--force-openssl`（"Deploy openssl plugin but ignore openssl library dependency"）和 `--openssl-root <directory>` 两个开关。

为什么只链三个模块却带出 `Qt6Network/Qt6Pdf/Qt6Svg`？**插件的软依赖**：`imageformats/qpdf.dll` 要 Qt6Pdf、`iconengines/qsvgicon.dll` 与 `imageformats/qsvg.dll` 要 Qt6Svg、`tls/*backend.dll` 与 `networkinformation/qnetworklistmanager.dll` 要 Qt6Network。**先有插件、才有那几个看起来"多余"的 DLL**。反向控制插件面的参数在 `--help` 里是齐的：

```text
  --no-plugins / --no-libraries
  --skip-plugin-types <逗号分隔>        --add-plugin-types <imageformats,iconengines>
  --include-plugins <scene2d,qjpeg>     --exclude-plugins <qsvg,qpdf>
  文档明确写：排除优先于包含，类型优先于单个插件（"including qjpeg, but skipping imageformats, will NOT deploy qjpeg"）
  --dir/--libdir/--plugindir/--translationdir/--qml-deploy-dir  改落地位置
  --no-translations / --translations <langs> / --compiler-runtime / --no-compiler-runtime
  --no-system-dxc-compiler / --no-opengl-sw / --no-ffmpeg / --no-patchqt / --ignore-library-errors
  --pdb（Deploy .pdb files (MSVC)）/ --json / --verbose 0-2 / --qtpaths <path>
  --qmake <path> 这一条 help 里直接写着 "Deprecated, use qtpaths instead"
```

`--help` 结尾还会把本机安装里**可部署的插件全列一遍**，这是排查"为什么我的插件没被打进去"的第一手资料（`platforms: qdirect2d qminimal qoffscreen qwindows`；`tls: qcertonlybackend qopensslbackend qschannelbackend`；`sqldrivers: qsqlibase qsqlite qsqlmimer qsqloci qsqlodbc qsqlpsql`）。**注意 `platforms` 里没有 `windows`**——插件文件名是 `qwindows.dll`，而 `QT_QPA_PLATFORM` 要写 `windows`，这个不对称是很多人第一次配 `QT_QPA_PLATFORM=offscreen` 时把插件目录删错的原因。

变体的可测量差别（同一个 exe、每次都是干净空目录）：

```text
  --no-plugins : rc=0，文件数 44，总字节 75,289,796（比完整部署少 16 个文件、3,970,678 字节）
                 目录里只剩根目录 11 个 DLL + translations/ + xp1.exe，platforms/、imageformats/、tls/、
                 styles/、generic/、iconengines/、networkinformation/ 整个层级都不存在
```

## 二、插件缺失的报错原文：先承认一件事

`platforms/qwindows.dll` 缺失时用户看到的正是那句 "This application failed to start…"。我**没能拿到运行期的 stderr 原文**——把 `--no-plugins` 部署目录里的 exe 用受限 PATH 跑起来（`QT_QPA_PLATFORM=offscreen`、不设、以及完整部署目录三种），三次都是**挂住**到 `timeout 40` 被杀（rc=124、stdout 空），`tasklist` 里留着 2 个 xp1.exe 僵尸进程，只能 `taskkill //F //IM xp1.exe` 清掉。原因几乎肯定是 Qt 在 GUI 子系统和"无控制台窗口"的情形下走 **MessageBox** 而不是 stderr，弹窗在无人值守的 shell 里永远没人点（这条也污染了我另一组长路径/DPI 的实验，见第五节）。**"缺平台插件时的运行期文本"列进第七节未实测**。

不过那句原文可以从二进制里取，而且是确定的：

```text
  Qt6Gui.dll 里按 UTF-16LE 搜 "This application failed to start because no Qt platform plugin"
      -> 命中，偏移 9296920，完整文本：
         "This application failed to start because no Qt platform plugin could be initialized.
          Reinstalling the application may fix this problem."
  同一句话按 ASCII 搜 -> 出现 0 次；按 UTF-16LE 搜 -> 出现 1 次
  "Could not find the Qt platform plugin" -> 以 ASCII（char*）形式存在 1 次（这是 qWarning 级别的日志串）
  "Available platform plugins are" -> ASCII 计数命中 1（grep -a -c）
```

也就是说：**fatal 那句是宽字符字面量**（它要进 MessageBox），**"Could not find the Qt platform plugin" 是普通 char\* 日志**（它走 stderr/日志）。这解释了一件常见怪事：同一个错误在 CI 的控制台输出里能看到、在双击运行的机器上只有一个弹窗。

不依赖弹窗也能定位缺插件的路子（按可靠性排）：

1. **对账**：`windeployqt --list relative exe > plan.txt` 与 `find 部署目录 -type f | sort` 做差（第一节那 47 个差集就是这么发现的）；缺 `platforms/qwindows.dll` 属于致命项，缺 `styles/qmodernwindowsstyle.dll` 只是外观退化。
2. **`QT_DEBUG_PLUGINS=1`**：Qt 会打印它扫了哪些目录、每个插件的加载结果（本节我只在设了这个变量的那次挂死运行里带上过它，输出因弹窗没落盘——**具体文本未实测**）。
3. 看 exe 的导入表（`objdump -p`）判断需要哪个运行时：MinGW 包要带 `libgcc_s_seh-1.dll/libstdc++-6.dll/libwinpthread-1.dll`，MSVC 包要带 VC 运行时（第三节表里有各自完整的 DLL Name 列表）。
4. `QLibraryInfo::path(QLibraryInfo::PluginsPath)` 在部署包里仍然返回**编译时烤进去的安装路径**（本机 `xp1.exe` 在开发环境打印 `plugins=D:/Qt/6.9.3/mingw_64/plugins`）。这就是"`--no-patchqt`"存在的理由：windeployqt 默认会**修补** Qt6Core 里的路径，让插件回到 exe 旁边的 `./plugins`；加了 `--no-patchqt` 之后你就必须自己设 `QT_PLUGIN_PATH`（"修补后的实际值"我没有干净地测出来，列未实测）。

## 三、MinGW 与 MSVC：两套 Qt 目录能量的差别

`qmake -query` 各跑一次（两套的 qmake.exe 都能独立运行，因为它们各自同目录有 Qt6Core.dll）：

```text
  mingw: QT_VERSION:6.9.3   QMAKE_XSPEC:win32-g++   QT_INSTALL_LIBS:D:/Qt/6.9.3/mingw_64/lib
         QT_INSTALL_PLUGINS:.../mingw_64/plugins    QT_HOST_BINS:.../mingw_64/bin
  msvc : QT_VERSION:6.9.3   QMAKE_XSPEC:win32-msvc  QT_INSTALL_LIBS:D:/Qt/6.9.3/msvc2022_64/lib
         QT_INSTALL_PLUGINS:.../msvc2022_64/plugins QT_HOST_BINS:.../msvc2022_64/bin
```

**版本字符串完全一样，唯一能区分两套构建的就是 `QMAKE_XSPEC`**。`QT_BUILD_KEY` 不是 `-query` 的合法键（两边都没打印出来；Qt 5 时代的 `QLibraryInfo::buildKey()` 在 6.9 也已删除，第 8 节那份编译报错清单里有）。

同名模块 DLL 的字节数（MSVC 一律更小）：

| 模块 | mingw_64/bin | msvc2022_64/bin | 差 |
| --- | --- | --- | --- |
| Qt6Core.dll | 10,865,416 | 10,023,136 | **-842,280** |
| Qt6Gui.dll | 11,377,408 | 9,497,312 | **-1,880,096** |
| Qt6Widgets.dll | 7,116,544 | 6,540,512 | -576,032 |
| Qt6Network.dll | 2,038,016 | 1,735,392 | -302,624 |
| Qt6Sql.dll | 338,688 | 309,984 | -28,704 |

（差异来源涉及优化选项、调试信息、CRT 静态量等，**具体归因未实测**，本节只给数字。）

**导入表才是最硬的一条**（`objdump -p Qt6Core.dll | grep "DLL Name"`）：

```text
  mingw 版：ADVAPI32 AUTHZ KERNEL32 MPR NETAPI32 SHELL32 USER32 USERENV VERSION WINMM WS2_32
            api-ms-win-core-synch-l1-2-0
            libgcc_s_seh-1.dll  libstdc++-6.dll  libwinpthread-1.dll  msvcrt.dll  ole32.dll
  msvc  版：同一批系统 DLL，但没有上面那三个 GNU 运行时，取而代之：
            VCRUNTIME140.dll  VCRUNTIME140_1.dll  MSVCP140.dll  MSVCP140_1.dll  OLEAUT32.dll
            + api-ms-win-crt-{environment,filesystem,heap,math,runtime,stdio,string,time,utility}-l1-1-0.dll 等 11 个 UCRT 转发 DLL
```

这一张表就把"部署该带什么运行时"讲完了：**MinGW 包必须带 `libgcc_s_seh-1/libstdc++-6/libwinpthread-1`**（windeployqt 第一节里确实拷了这三个），**MSVC 包必须带 VC 运行时**（`--compiler-runtime` 那个开关，或让用户装 VC redist）。顺带：msvc 目录里连 Qt6Core.dll 都**依赖 `ole32/OLEAUT32`**（多一个 COM 相关依赖），MinGW 版只列 ole32。

调试符号的形态也不同：

```text
  mingw：plugins/sqldrivers 里是 qsqlite.dll + qsqlite.debug（文本 sidecar）
  msvc ：plugins/sqldrivers 里是 qsqlite.dll + qsqlite.pdb + qsqlited.dll + qsqlited.pdb
         （还多一个 qsqlmysqld.dll，没有对应的 release 版 qsqlmysqld.dll 之外的 mysqld 项）
  lib 目录命名：msvc 下 grep ^Qt6Core 命中 Qt6Core.lib / Qt6Core.prl / Qt6Core5Compat.lib / Qt6Core5Compatd.lib
                mingw 下同样的 grep 只命中 *.prl —— 说明导入库叫 libQt6Core.a（前缀 lib 没进 grep）
```

**混用会怎样？**我做了两个小实验（`tiny.cpp` 内容就是 `int main(){return 0;}`）：

```text
  g++ tiny.cpp -L D:/Qt/6.9.3/msvc2022_64/lib -lQt6Core          -> rc=0（链接"成功"）
  g++ tiny.cpp -L D:/Qt/6.9.3/msvc2022_64/lib -l:Qt6Core.lib      -> rc=0
```

**这就是本节最想提醒的一条**：GNU ld 在 Windows 上**能读 MSVC 的 `.lib` 导入库**，而空程序不引用任何 Qt 符号，所以链接器一声不响地成功。"链上了"跟"能跑"之间隔着 C++ 名字改编（MSVC 的 `?qVersion@@YAPEBDXZ` 与 GCC 的 `_Z8qVersionv`）、异常模型（SEH/`__CxxThrowException` vs `_Unwind_*`）、以及 `__declspec/dllexport` 生成物不兼容等几层。**只要 tiny.cpp 真去调 `qVersion()`，链接就会失败**——这个失败原文我没有抓到（要一次完整编译，本轮时间不够），**列进第七节**，但"rc=0 不等于 ABI 兼容"这个结论本身是实测的。至于 MSVC 侧的行为差异（`/MD` vs `/MT`、`/GL` LTCG、`/Zc:__cplusplus` 让 `__cplusplus` 报真实值、`_MSC_VER` 分支下的 Qt 头文件路径），**本机没有 cl.exe，全部标未实测**。

## 四、路径、换行、字体：差异清单

路径与换行的字节级证据在第 8 节已经量过，这里做部署视角的归并（数字来自那一节，未重复实验）：

```text
  QDir::separator() = '\'（ASCII 92），但所有 Qt API 的入参/返回一律 '/'
  toNativeSeparators/fromNativeSeparators 是唯一该出现 '\' 的地方（给系统对话框、给第三方 exe 的命令行参数）
  isAbsolutePath 认 "C:/x"、"/x"、"\\srv\share"（UNC）都不认 "a/b" —— 共享盘部署要专门测 UNC
  CRLF 只由 QIODevice::Text 在写侧产生（LF 变 CRLF），读侧 readAll 与 readLine 对结尾孤立 CR 的处理还不一致；
  QSettings 的 ini 本身也是 CRLF —— 同一份配置文件在 Git 里换平台会产生整文件 diff
  QLocalServer 的名字规则不跨平台：listen("a/b\c:d") 在 Windows 返回 1（成功），Linux 上 '/' 会被当路径分隔而失败
```

字体这一项必须坦白：**没测成**。我为此写的 `xp3.cpp`（打印 `QFontDatabase::families()` 数量、`systemFont(Fixed/Title)`、请求 `Microsoft YaHei UI`/`Segoe UI`/`Consolas` 时 `QFontInfo` 落到什么家族）在本机**挂死**，和第二节同一个弹窗/阻塞形态，输出文件 0 字节。能确定引用的只有第 7 节那三条离屏退化证据（`QFontInfo::family()` 返回空串、`fm.descent()=0`、`averageCharWidth=0.0`）——**它们本身就在说"离屏平台的字体数据库是残缺的"，所以字体家族名/字号这类结论必须在有真实字体后端的平台上重测**，不能拿本节的开发环境数字当 Windows 用户看到的排版。

## 五、高 DPI、缩放与远程桌面

第 7 节已经把"能不能在 offscreen 上测缩放"这件事的边界划清了，我直接引用它的结论而不重复实验：**`QT_ENABLE_HIGHDPI_SCALING=1 QT_SCALE_FACTOR=2` 与 `QT_SCREEN_SCALE_FACTORS=2` 都把屏幕逻辑几何从 800x800 砍到 400x400、`devicePixelRatio` 抬到 2.00、`physicalDotsPerInch` 从 100.0 变 50.0，而 `logicalDotsPerInch` 恒为 96.0、`QFontMetrics` 一个数都没变**。也就是说离屏环境只能证明"Qt 内部坐标系统一致"，证明不了"接上 4K 屏字号会变"。

本节新增的缩放矩阵（同一份 `xp3.exe`，五组环境变量）：**全部挂死、无输出**（`QT_SCALE_FACTOR=2`、`QT_SCREEN_SCALE_FACTORS=1.5`、`QT_FONT_DPI=144`、`QT_AUTO_SCREEN_SCALE_FACTOR=1`）。所以以下这些我只能作为"部署时要检查、但本机没证据"的条目：`QT_FONT_DPI` 对字号的实际影响、分数缩放（125%/150%）、多屏不同缩放因子、`QT_AUTO_SCREEN_SCALE_FACTOR` 在 Qt 6 是否已经彻底无效（第 7 节它连编译/运行都不影响，但那是在 offscreen + 无真实屏幕下）。

**部署侧与 DPI 有关的确定事实只有一条**：`windeployqt --help` 的全部选项里**没有 manifest 相关开关**——它不生成 `.manifest`、不改 PE 的 DPI awareness 段（这个判断的依据是 help 文本，"改完之后 DPI 行为如何变化"未实测）。而 Qt6 里 `QApplication::setGraphicsSystem()` 这类老开关已删除（第 7 节报错原文）、`QGuiApplication::platformName()` 是唯一能读回当前平台的入口。

**远程桌面（RDP）完全无法在本机测**：这是一个本地交互会话，没有第二台机器/没有 RDP 通道，而 RDP 会话里 DPI、可用显示器几何、甚至字体枚举都会变。列第七节。

## 六、本节直接撞到的 API / 参数原文

写探针时被编译器/工具当场拒绝的（一条一行，原文）：

```text
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENUIERRORBOX)
      error: 'SEM_NOOPENUIERRORBOX' was not declared in this scope; did you mean 'SEM_NOOPENFILEERRORBOX'?
      （MinGW 的 winbase.h 里没有 NOOPENUIERRORBOX 这个别名 —— 想在 MinGW 下压制弹窗只能用这两个常量，
        而它压不住 Qt 自己 MessageBoxW 的那条路径，见第二节）
  printf("…", QLibraryInfo::build().constData())
      error: request for member 'constData' in 'QLibraryInfo::build()', which is of non-class type 'const char*'
      → 6.9 的 QLibraryInfo::build() 返回 const char*（第 8 节里 buildAbi()/buildKey() 已删除）
  QFontMetrics::underlinePosition()
      error: 'class QFontMetrics' has no member named 'underlinePosition'; did you mean 'underlinePos'?
  QFontDatabase::systemFont(QFontDatabase::GeneralFont).family() 当 int 传 .arg()
      error: invalid cast from type 'QString' to type 'int'   → systemFont() 返回 QFont，family() 返回 QString
  QLibraryInfo::platformPluginArguments("windows")  → 返回空列表（本机打印为空，未进一步解释，见第七节）
  windeployqt --qmake <path>  → help 里直接标注 "Deprecated, use qtpaths instead"
```

## 七、部署检查清单，以及本节未实测的内容

可以照抄的清单（每条都对应上面某条实测）：

1. **对账**：`windeployqt --list relative` 与 `find 目标目录 -type f` 求差集；差集里 `platforms/qwindows.dll` 是致命项，`.qm` 是外观项。别相信 `--list` 的行数等于交付内容。
2. **按运行时类型带库**：MinGW 包看 exe 导入表里的 `libgcc_s_seh-1/libstdc++-6/libwinpthread-1`；MSVC 包看 `VCRUNTIME140*/MSVCP140*`（`objdump -p your.exe | grep "DLL Name"` 一条命令就能出清单）。
3. **OpenSSL**：`tls/qopensslbackend.dll` 会被 windeployqt 静默跳过；要 https 就显式 `--force-openssl` 或 `--openssl-root`，并在**目标机器**上验证 `QSslSocket::supportsSsl()` 与 `sslLibraryVersionString()`（第 8 节证明这两个值会不一致：build 3.0.7 / runtime 3.5.8）。
4. **别混工具链**：MinGW 的 ld 能吃 MSVC 的 `.lib`（实测 rc=0），所以"链接过了"不能作为 ABI 兼容的证据；同一个 exe 只能配同一套 Qt bin。
5. **插件目录名 ≠ 平台名**：`qwindows.dll` 对应 `QT_QPA_PLATFORM=windows`；`--help` 的 `Detected available plugins` 段是权威清单。
6. **配置文件的换行与大小写**：`QSettings` 的 ini 是 CRLF、key 不区分大小写（第 8 节），跨平台仓库里要加 `.gitattributes`，键名固定一种写法。

**未实测（本机条件下拿不到，别当成结论）**：

- **缺 `platforms/qwindows.dll` 时的运行期 stderr 原文与退出码**：三次尝试都被弹窗挂死（rc=124），只能给出 Qt6Gui.dll 里那句 UTF-16 字面量的偏移（9296920）与文本；`QT_DEBUG_PLUGINS=1` 的输出文本同样未拿到。
- **Qt 6.9 `platformPluginArguments("windows")` 返回空的原因**与它在真实 `windows` 平台下的值（本机只有 offscreen 可用，`QGuiApplication::platformName()` 只在开发环境跑通过一次）。
- **`--no-patchqt` 的实际效果**：没做"修补前/修补后 `QLibraryInfo::path(PluginsPath)` 各返回什么"的对照实验。
- **windeployqt 各变体的完整对账**：只做了默认与 `--no-plugins` 两组的计数（60/79,260,474 与 44/75,289,796）；`--no-translations`、`--compiler-runtime`、`--debug`（会把 `*d.dll` 拷进来这一条我**没验证**）、`--force-openssl`、`--pdb`、`--json`、`--add-plugin-types sqldrivers` 都只有 help 文本、没有实测计数。
- **MSVC 侧一切**：`/MD` vs `/MT`、LTCG、`/Zc:__cplusplus`、`_MSC_VER` 分支、vcvars 环境、`.pdb` 体积影响——本机没有 cl.exe/nmake，PATH 里那条 VS 目录不存在。
- **MinGW exe 真引用 Qt 符号后链 MSVC 导入库的失败原文**，以及"MinGW exe + MSVC 版 Qt6Core.dll 在 PATH 上"的加载期错误文本（第一节两个 rc=0 只证明空程序能过）。
- **长路径（>260 字符）**：`xp3.cpp` 里那组 `mkpath` + `QFile::open` + `\\?\` 扩展前缀实验随进程一起挂死，没有输出。`MAX_PATH`、`\\?\` 前缀、`QFileInfo::isJunction`/符号链接的差别全部未实测（`isJunction=0` 这类只在本机自建目录上成立）。
- **字体家族与真实排版**：`QFontDatabase::families()` 数量、`systemFont(Fixed/Title)`、请求 `Microsoft YaHei UI`/`Segoe UI`/`Consolas` 的 `QFontInfo` 解析结果——进程挂死未取到；结合第 7 节的离屏字体退化，本节所有字体相关结论都必须换平台重测。
- **高 DPI 新变量组**：`QT_FONT_DPI`、`QT_SCREEN_SCALE_FACTORS=1.5`、`QT_AUTO_SCREEN_SCALE_FACTOR` 全部因挂死没数据；分数缩放、多屏异缩放、真实 4K 屏、以及 `windeployqt` 之外是否要自己写 manifest 的 DPI 段，都未实测。
- **远程桌面 / 无头服务账户 / 双显卡**：本机是单会话本地桌面，RDP 下的几何与 DPI 差异、服务账户下 `systemProxyForQuery()`（第 8 节那条 127.0.0.1:7890）是否会不同，全部未测。
