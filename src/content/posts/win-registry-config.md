---
title: 注册表与配置存储
description: >-
  实测：HKLM\SOFTWARE 的 64 位视图 71 个子键、32 位视图 56 个，而 32 位视图与字面 Wow6432Node 路径的末次写入时间
  134344297879504256 一字不差（同一份数据的两个门）；HKCU\Software 三种视图都是 120 个子键，HKCU 不参与重定向；
  RegQueryValueExW 读 REG_SZ 报 14 字节而 RegGetValue 对同一个值报 146，RRF_RT_REG_EXPAND_SZ 不加 RRF_NOEXPAND 直接给 1630；
  键名 4095 字符、值名 16385 字符、单值 4 MB 在本机都没被拒，往 HKLM 写一律 rc=5；
  RegNotifyChangeKeyValue 0.05–0.08 ms 就回来；HKCU 的 Run 键写值不需要提权，写→读回→删三步闭环走完，写完 1 秒后并没有启动；
  .qzdemo 只登记在 HKCU\Software\Classes，HKCR 立刻能读到，AssocQueryStringW 三条查询全 S_OK，但没注册的扩展名也返回 S_OK。
date: 2026-10-16
tags: ["Windows", "注册表", "AppData", "已知文件夹", "文件关联"]
category: win32
section: win-registry-config
---

> 环境：Windows 11 x64（26200），**GCC 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，
> `gcc -std=gnu11 -O2 -w r1.c -o r1.exe -ladvapi32 -lshell32 -lshlwapi -luuid -lole32`（PATH 上那个 gcc 是 4.9.2 32 位，用了结论就错）。
> 两支探针在 `C:/Users/wangt/AppData/Local/Temp/agents/win32e/`：`r1.c`（视图、读写语义、错误码、通知、Run 键、文件关联、清理）
> 与 `r2.c`（长名/大值补测、配置目录 API、成本对照）。
> **注册表纪律**：只写自己的专属键 `HKCU\Software\QoderWin32eProbe`/`Probe2`/`Probe3`、`HKCU\Software\Classes\.qzdemo` 与
> `QoderWin32e.Demo`、以及 `HKCU\...\CurrentVersion\Run` 里一个临时值，全部在同一进程里 `RegDeleteTreeW`/`RegDeleteValueW`
> 删净并**回读验证**（第七节末）。**HKLM 全程只读**（枚举只到 `RegQueryInfoKeyW`），没有写入、没有提权、没碰任何系统已有扩展名的关联、
> 没有真的开机自启。无头验证：证据是返回码、`FormatMessage` 文本、`RegQueryInfoKeyW` 的计数与末次写入时间、`GetFileAttributesExW`
> 的字节数、路径字符串本身，没有截图。

## 一、HKCU / HKLM 与 32-64 视图：重定向是"同一份数据的两个门"

本进程 64 位（`IsWow64Process` 返回 1、标志 0）。同一个 `RegOpenKeyExW(HKEY_LOCAL_MACHINE,L"SOFTWARE",…)` 换三种开法，
`RegQueryInfoKeyW` 的读数：

```text
默认(64 位进程=64 视图)      子键=71 最长子键名=36 末次写入=134364300235228480
显式 KEY_WOW64_64KEY         子键=71 最长子键名=36 末次写入=134364300235228480
显式 KEY_WOW64_32KEY         子键=56 最长子键名=22 末次写入=134344297879504256
字面 SOFTWARE\Wow6432Node    子键=56 最长子键名=22 末次写入=134344297879504256
Wow6432Node + KEY_WOW64_32KEY 子键=56 最长子键名=22 末次写入=134344297879504256
HKCU Software 默认/32/64      子键=120 / 120 / 120 末次写入全=134365610474951344
Uninstall 64 视图 子键=123（最长名 78）／32 视图 子键=220（最长名 53）
```

- **重定向的全部证据就是最后三列相等**：`KEY_WOW64_32KEY` 开 `SOFTWARE`、字面开 `SOFTWARE\Wow6432Node`、两者叠加，
  子键数、最长名、**100ns 精度的末次写入时间**一字不差 → 同一个键；而 64 视图的 71 与 32 视图的 56 **不是包含关系**。
- **HKCU 不参与 WOW64 重定向**（三种视图完全相同）。所以 32/64 位程序写 `HKCU\Software\MyApp` 是同一份配置，
  互相覆盖就是这么来的；而写 `HKLM\Software\MyApp` 会各写各的（32 位实际落 `Wow6432Node`）——
  **"卸载表里少一项"、"32 位装的东西 64 位程序看不见"最常见的原因就是这条**，不是注册表坏了。
- `Uninstall` 的对比是可直接复用的教训：**只查一个视图会漏掉 97 项**（220 vs 123）。要全就两个视图各枚举一次再合并。

## 二、读写的返回值语义：四个把人坑掉的细节

专属键的建键读数（跨两轮运行）：

```text
第一次跑：rc=0 disposition=1(REG_CREATED_NEW_KEY) 句柄=00000000000001cc
第二次跑（上一轮崩了、键还在）：rc=0 disposition=2(REG_OPENED_EXISTING_KEY)
读回 "不存在" 探长度 rc=2 类型=0 需要=0 字节      FormatMessage(2)="系统找不到指定的文件。"
```

`RegCreateKeyExW` **成功时既不告诉你"新建"也不报错**，新建/已存在只能看 `disposition`；
`RegOpenKeyEx` 又拿不到这个字段。要"没有就建、有就报错"，必须自己先 `RegOpenKeyEx`（rc=2 才建）。

类型与缓冲区：

```text
sz 需要 14 字节（我写入 12）                 缓冲只给 8 字节：rc=234(ERROR_MORE_DATA) 返回 cb=14
第二次同样小缓冲：rc=234 cb=14              ← cb 被 API 覆写，重试前必须重新设成缓冲区大小
用 4 字节缓冲读 REG_SZ：rc=234 cb=14
```

**REG_SZ 读回的长度恒等于存储字节数 + 2**（12→14），按"写入多少就读多少"申请缓冲必然吃到 234。
（顺带：我写的时候 `cbData=12` 而字符串只有 4 个 WCHAR，多带的 4 字节是相邻内存，所以读回的"乱码"是我自己埋的——
但 234 与 `cb` 的行为与此无关，仍然成立。）

`RegGetValueW` 的 flag 语义是这一节最反直觉的部分：

```text
RRF_RT_REG_SZ 读一个 REG_DWORD          rc=1630（ERROR_INVALID_DATATYPE）
RRF_RT_REG_EXPAND_SZ（不带 RRF_NOEXPAND）rc=1630          ← 想要"自动展开"反而报错
RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND      rc=0 内容="%USERPROFILE%\x"
RRF_RT_ANY                               rc=0 内容="C:\Users\wangt\x"（只有这条路给我展开了）
读不存在的值 rc=2
```

即 **`RRF_RT_REG_EXPAND_SZ` 必须配 `RRF_NOEXPAND`**；"顺手展开环境变量"这个大家期待的默认行为在显式指定单类型时并不存在。
更阴的是尺寸口径不一致：同一个 `REG_EXPAND_SZ` 值，`RegQueryValueExW` 报需要 **144**，`RegGetValueW` 报需要 **146**。
**两个"读"函数之间复用"探长度"的结果不安全**，长度各自探。

MinGW 侧的连带坑（归第 8 节）：`RRF_NOEXPAND`/`RRF_ZEROONFAILURE` 与 `REG_NOTIFY_CHANGE_*` 在 `winreg.h` 里**没定义**
（我按文档值自己 `#define`）；`AssocQueryStringW` 的导入符号在 **`libshlwapi.a`**，少链 `-lshlwapi` 直接
`undefined reference to __imp_AssocQueryStringW`；`LB_ADDSTRINGW`/`LB_GETTEXTW` 根本不存在（第六节有它的后果）。

## 三、权限失败的形状，以及"上限"在本机拦不住

非提权进程下，动 HKLM 的尝试只有一种形状：

```text
RegOpenKeyExW(HKLM\SOFTWARE, KEY_SET_VALUE)        rc=5
RegCreateKeyExW(HKLM\SOFTWARE\QoderWin32eProbeNope, KEY_ALL_ACCESS) rc=5
HKCU\Software\Classes\VirtualStore\Machine\SOFTWARE 打开 rc=2（本机没有这个落点）
REG_OPTION_BACKUP_RESTORE 建键 rc=5（缺 SE_BACKUP_NAME，选项级就失败）
REG_OPTION_VOLATILE 建键 rc=0 disposition=1，值可写 rc=0；RegEnableReflectionKey rc=0
RegSaveKeyW / RegLoadKeyW / RegRestoreKeyW 全 rc=87（ERROR_BAD_PARAMETER，"参数错误。"）
```

三点：① 取证"预期失败"要用**最小动作**——只开到 `KEY_SET_VALUE`、只建一个不存在的子键名，两者都 rc=5 且**没有产生任何 HKLM 改动**；
探针里 `rc=0` 的分支写得极短（立刻 `RegDeleteKey` 并打印"！竟然建成功了"），本机没走到。
② **注册表虚拟化不是退路**：`VirtualStore\Machine\SOFTWARE` 在本机不存在（rc=2），"写 HKLM 失败会自动落到 VirtualStore"的旧印象
对带 manifest 的现代进程不成立，该报错就报错。③ `RegSaveKey`/`RegLoadKey` 拿到 **87 而不是 1309/1312**，是我自己的缺陷：
`_snwprintf(f,…,L"%s\\x.reg", getenv("TEMP"))` 把 `char*` 塞进了宽格式 `%s`，路径是垃圾——**"备份/还原需要 SE_BACKUP_NAME/SE_RESTORE_NAME"
这条本机没测到**（第七节）。能确定的只有：这两个 API 先做参数校验再看特权，别指望用它们"顺手读别人的配置单元"。

文档里的长度/大小上限，本机基本不构成校验：

```text
键名 1/63/64/127/128/254/255/256/257/511/512/1023/1024/2047/4095 → RegCreateKeyEx 全 rc=0
键名 255/1024/4095 → 建 rc=0、再开 rc=0（值名 16383/16384/16385 → 写 rc=0、再读 rc=0 cb=4）
单值 1024 B / 64 KB / 1 MB / 2 MB / 4 MB → 全 rc=0，读回需求字节数与写入完全相等（0.46/0.48/7.03/3.42/5.72 ms）
RegQueryInfoKey：500 个 S000 形子键 → 最长子键名=4、最长值名=4（不含终止符）
```

- **4095 字符的键名建得出也开得到**，16385 字符的值名写得进也读得出 → 文档的 255 / 16383 不是硬校验。
  `r2` 那轮"写 rc=5"是我把句柄用 `KEY_READ` 重开了一次才去写值——**注册表句柄的权限在打开时定死，换用途必须重开**，这条比上限更有用。
- **4 MB 一个值能写进去**，但配置单元是整体加载的：`%USERPROFILE%\NTUSER.DAT` 本机 **21 MB**，
  `CreateFile(GENERIC_READ)` 被系统挡回 **lasterr=32（共享违反）**，而**清理掉所有测试键之后仍然是 21 MB**——
  配置单元只涨不缩。所以"大对象进文件、路径与小标量进注册表"这条经验规则的根据就在这里。
- `RegQueryInfoKeyW` 回报的最长名**不含终止字符**（4 而不是 5），按它开缓冲要自己 +1。

## 四、变更通知与"配置放哪里"的成本

```text
注册异步通知 rc=0；写一个值之后 WaitForSingleObject=WAIT_OBJECT_0 用时 0.08 ms
WATCH_TREE（REG_NOTIFY_CHANGE_NAME + bWatchSubtree=TRUE）建子键后 收到 用时 0.05 ms
建 500 子键 = 18.33 ms（36.7 us/个）      往同一键写 500 值 = 45.75 ms（91.5 us/个）
注册表 写 500 值 + RegFlushKey = 35.46 ms（70.9 us/项）    读 500 值（持句柄）= 2.15 ms（4.29 us/项）
RegFlushKey = 1.271 ms      RegEnumKeyEx 500 个 = 1.09 ms（2175 ns/个）   RegEnumValue 506 个 = 1.25 ms（2476 ns/个）
INI 写 500 项 = 0.75 ms（1.51 us/项）      INI 读 500 项 = 1.20 ms（2.41 us/项）
GetPrivateProfileStringW ×1000（文件不存在）= 45.75 ms（45750 ns/次）；（文件存在）= 45.34 ms（45336 ns/次）
注册表读一个 DWORD（RegGetValue + RegQueryValueEx 各一次）×1000 = 17.82 ms（17822 ns/对）
```

- **通知是电平不是内容**：事件只说"这里改过"，改了什么要自己重新枚举；我用的是自动重置事件（每次变更只置位一次），
  要可靠跟住变化就得每次收到后重新注册，或改手动重置 + `ResetEvent`。0.05–0.08 ms 的延迟做"设置页即时刷新"绰绰有余。
- **注册表读便宜（4.3 µs）、写贵（70–92 µs）**，贵的来源是配置单元落盘；所以"每个 UI 事件都写一次注册表"是错的，攒起来。
- **INI 的 1.5 µs/项是假便宜**：`WritePrivateProfileStringW` 改的是系统缓存、延迟落盘（我试图用
  `FlushFileBuffers(INVALID_HANDLE_VALUE)` 强制刷盘，那次调用成功与否没打印，**"INI 真实落盘成本"未测**）；
  而它的**读**每次 45 µs，是注册表读的 10 倍（每次都要重查/可能重读整个文件）。
  再加一条编码风险：它属于"缓冲不够就截断"的 ANSI 家族（第 1 节量过 `GetWindowTextA` 不保证终止符）。
- `RegGetValue`（每次自己开键关键）比持句柄的 `RegQueryValueEx` 贵一个量级——上面那 17.8 µs 是**一对**调用的合计，
  我没拆开测，所以只报这一对而不给单值；但方向明确：**循环读同一个键就先把句柄拿住**。
- 三条路的取舍：少量设置项进 **HKCU**（读便宜、随漫游、可被组策略管）；大量/结构化配置进**文件**（可备份、可版本控制、可原子替换）；
  **INI 只剩兼容价值**。

## 五、配置目录：known folder 与注册表里那两本账

`SHGetKnownFolderPath` 十个文件夹全部 `hr=0x00000000` 且目录真实存在：

```text
RoamingAppData C:\Users\wangt\AppData\Roaming   LocalAppData C:\Users\wangt\AppData\Local
LocalAppDataLow C:\Users\wangt\AppData\LocalLow  Documents C:\Users\wangt\Documents
Profile C:\Users\wangt   ProgramData C:\ProgramData
CommonStartMenu C:\ProgramData\Microsoft\Windows\Start Menu
StartUp C:\Users\wangt\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
Cookies C:\Users\wangt\AppData\Local\Microsoft\Windows\INetCookies   ← 不是老文档里的 ...\Cookies
```

`%APPDATA%`(30 字符)/`%LOCALAPPDATA%`(28)/`%USERPROFILE%`(14) 与之一致。但注册表里其实存着**两套**：

```text
HKCU\...\Explorer\User Shell Folders "AppData"      类型=2(REG_EXPAND_SZ) "%USERPROFILE%\AppData\Roaming" → 展开后与 known folder 相同
                                 "Local AppData"/"Personal"/"Desktop"/"StartUp"/"NetHood"/"SendTo" 全是 REG_EXPAND_SZ
HKCU\...\Explorer\Shell Folders   "AppData"          类型=1(REG_SZ) "C:\Users\wangt\AppData\Roaming"（已展开的那份）
```

所以 **读 `Shell Folders` 会在配置文件重定向/用户名变动后拿到过期值**，`User Shell Folders` 才是可展开的真源；
`SHGetKnownFolderPath` 可信是因为它同时处理两者、缓存、以及 OneDrive 重定向
（本机 `Documents` **没有**被重定向到 OneDrive，这点因机器而异，换环境必须重测）。
建自己的目录用 `SHCreateDirectoryExW`（会建中间层）：

```text
建 Roaming\QoderWin32eProbe\cfg（多级）rc=0 13.730 ms；再来一次 rc=183 0.572 ms；Local\cache rc=0
SHGetKnownFolderPath(flags=0x100) hr=0 与默认调用同一个串？1    写 cfg\x.txt 大小=5 字节（随后文件与目录全部删掉）
```

第二次返回 **183（`ERROR_ALREADY_EXISTS`）而不是 80（`ERROR_FILE_EXISTS`）**——判"目录已存在"要认 183。
`CreateDirectoryW` **不建中间层**，这正是我长路径探针两次失败的原因：

```text
第 1 层 全长=245 字符 CreateDirectory=0 lasterr=3 "系统找不到指定的路径。"
全长 264 字符 + \\?\ 前缀 CreateDirectory=0 lasterr=3     不加前缀 254 字符建文件 lasterr=3
```

**"MAX_PATH=260 在本机是否还生效"没测到**（我没逐级建父目录就去试第 2 层，父不存在必然 3，`\\?\` 救不了这个）；
只留下一个副证：245–264 字符得到的是 **3（路径不存在）而不是 123（名字无效）**，长度本身在这一层没被拒。
相对路径这条是配置存储里最常见的真实故障：

```text
当前目录 = …\Temp\agents\win32e   自己所在目录 = 同一个   用相对名建文件 → 落在当前目录，不是 exe 目录
GetFullPathName("config.ini") = …\agents\win32e\config.ini → SetCurrentDirectory("C:\\Windows") 之后 = C:\Windows\config.ini
```

**快捷方式的"起始位置"、被别的进程 `CreateProcess` 拉起、服务、计划任务都会换掉 CWD**，于是"配置找不到"和"配置凭空多了一份"同时发生。
正解：`GetModuleFileNameW` + 截掉文件名，或者干脆走 known folder。

## 六、开机自启与文件关联：HKCU 就能办，也都必须当场收尾

自启（`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`）**三步闭环都真的执行了**：

```text
打开 HKCU Run rc=0  现有关联自启值数=16（只数不改）
  [0] "OneDrive" 类型=1 大小=126 "C:\Program Files\Microsoft OneDrive\OneDrive.exe" /background
  [1] "com.lbyczf.clashwin" 类型=1 大小=110 D:\Clash.for.Windows-0.20.17-win\Clash for Windows.exe
  [2] "WXWork" 类型=1 大小=74 "D:\WXWork\WXWork.exe" -min -autorun
第1步 写值 rc=0（REG_EXPAND_SZ，命令串带引号 + --from-run-key）
第2步 读回 rc=0 类型=2 大小=144 内容="C:\Users\wangt\AppData\Local\Temp\agents\win32e\r1.exe" --from-run-key
      RegGetValue 探大小 rc=0 需要=146 字节（与上一行差 2，见第二节）
写后等 1 秒：FindWindow(标题含 from-run-key)=NULL → 没有启动任何东西
第3步 删除 rc=0     确认已不存在 rc=2（ERROR_FILE_NOT_FOUND）
HKLM Run 只读打开 rc=0  机器级自启值数=5（没动过）
```

**HKCU 的 Run 键不需要提权**（同进程写、读、删全 rc=0），HKLM 的才要（本机 HKLM 连 `KEY_SET_VALUE` 都是 5）。
"写完不立刻启动"是设计而不是 bug：`Run` 只在**登录时**被 Explorer 读一次，所以"勾了设置希望马上生效"的期待必然落空。
命令行必须自己加引号（路径带空格时 Explorer 按空格切）。`RunOnce` 的"由消费者启动后删值"**本机无法验证**（要注销再登录）。
另一条常用路径是第七节给出的 `StartUp` 文件夹（放快捷方式即可，无需注册表）——但它只对"这台机器的这个用户"生效，
`Run` 键是配置单元的一部分会随漫游走，两者不是一回事；生成 `.lnk` 需要 COM（第 9 节）。

文件关联只登记自定义扩展名 `.qzdemo`，全程在 `HKCU\Software\Classes`：

```text
写 .qzdemo 默认值 rc=0（"QoderWin32e.Demo"）  写 Content Type rc=0  写 ProgID 默认值 rc=0（"Qoder 演示文档"）
写 shell\open\command rc=0（"…\r1.exe" "%1"）
从 HKCR 打开 .qzdemo rc=0，HKCR 里读默认值 rc=0 类型=1 值="QoderWin32e.Demo"
AssocQueryString(COMMAND)     hr=0x00000000 值="C:\Users\wangt\AppData\Local\Temp\agents\win32e\r1.exe" "%1"
AssocQueryString(EXECUTABLE)  hr=0x00000000 值="C:\Users\wangt\AppData\Local\Temp\agents\win32e\r1.exe"
AssocQueryString(FRIENDLYDOCNAME) hr=0x00000000 值="Qoder 演示文档"
SHGetFileInfo(SHGFI_TYPENAME) 对不存在的 a.qzdemo 返回 NULL、TypeName=""
RegDeleteTreeW(.qzdemo) rc=0  RegDeleteTreeW(ProgID) rc=0  删完再开 HKCR\.qzdemo rc=2
```

- **HKCU\Software\Classes 立刻出现在 HKCR**、`AssocQueryStringW` 立刻查得到（三个 `ASSOCSTR_*` 分别给命令、可执行文件、
  ProgID 默认值当友好名）→ 关联解析是**实时读注册表**，不需要广播 `SHChangeNotify`。
- 但 **hr 判"存不存在"不可信**：对 `.zzz-no-such-ext` 的查询也返回 `0x00000000`，删掉之后仍返回 `0x00000000`
  （我这轮没打印 `pcchOut`，无法区分"空结果"与"命中了别的东西"）——要判存在性请看返回的字符串/长度。
- **"双击 .qzdemo 真的按这条走吗"不能无头验证**（要真实 shell 交互）。
  `UserChoice` 哈希保护、`OpenWithProgids`/`OpenWithList`、`AppUserModelID`、协议（URL）关联**都没测**：
  我只写自己新建的扩展名，没碰系统里已有 `UserChoice` 的关联。"用户已经选过默认程序时，写 `HKCU\Software\Classes\<.ext>` 会被盖住"
  这条只有文档依据，**本机没有证据**，别当结论用。

## 七、未测清单与清理核对

**未测**：MAX_PATH/`\\?\` 前缀的实际生效边界（探针缺"逐级建父目录"）；
`RegSaveKeyW`/`RegLoadKeyW` 的**特权**分支（被 87 挡在参数校验）；`RunOnce` 的自动删除、HKLM 自启、计划任务/服务式自启；
`UserChoice`、`OpenWith*`、协议关联、双击打开的端到端行为；`RegNotifyChangeKeyValue` 多观察者语义与远程注册表；
`RegEnableReflectionKey` 的真实反射效果（只拿到 rc=0）；`RegGetKeySecurity`/`RegSetKeySecurity`（改 ACL 风险太高，没碰）；
INI 强制落盘的真实写成本。

**清理核对**（进程内回读 + 事后用另一条路复查）：`Software\QoderWin32eProbe` `RegDeleteTreeW` rc=0 → 再开 **rc=2**；
`Probe3` rc=0；`.qzdemo` 与 `QoderWin32e.Demo` 删除后 `HKCR\.qzdemo` **rc=2**；Run 临时值删除后读回 **rc=2**；
`%TEMP%` 下的 `r1_cfg.ini`/`r1_cfg.json` 与 Roaming/Local 里建的目录都删掉了。**但进程内回读骗过了我**：`r2` 第二节删掉
`Probe2` 后确实读到 rc=2，可第三节的 `RegCreateKeyExW(…\Probe2\Big)` 又把父键**顺手重建**了回来，探针自己没再查。
退出进程后用 `reg.exe query` 独立复查才发现它还在（rc=0），当场 `reg.exe delete /f` 删掉再查才 rc=1。
教训写进代码里就是两句：**清理要在进程外再验一次**；**"删完之后还要建东西"的探针必须把删除放到最后一个动作**。
HKLM 侧全程只有 `RegOpenKeyExW(...,KEY_READ|KEY_WOW64_*)` 与 `RegQueryInfoKeyW`，事后搜索 `HKLM\SOFTWARE` 也没有任何 `QoderWin32e*` 键。

## 小结

- **视图就是门**：HKLM 的 64 视图 71 个子键 vs 32 视图 56 个，而 32 视图与字面 `Wow6432Node` 末次写入
  `134344297879504256` 相同 → 同一份数据；HKCU 三种视图都是 120 个子键 → **HKCU 不重定向**；
  `Uninstall` 220 vs 123 → **只查一个视图必漏 97 项**。
- **语义坑**：新建/已存在只看 `disposition`；`RegQueryValueExW` 缓冲不足给 **234** 且覆写 `cb`（重试前必须重置）、
  REG_SZ 读回长度恒 **+2**；`RRF_RT_REG_EXPAND_SZ` 不配 `RRF_NOEXPAND` 给 **1630**，要展开用 `RRF_RT_ANY`；
  同一个值 `RegQueryValueEx` 报 144 而 `RegGetValue` 报 146。
- **失败与上限的形状**：HKLM 一律 **5**、`REG_OPTION_BACKUP_RESTORE` **5**、本机无 VirtualStore 落点（rc=2）、
  配置单元文件被锁（32）；键名 4095、值名 16385、单值 4 MB **都不被拒**，但 `NTUSER.DAT` 21 MB 且**清理后不缩**。
- **成本**：注册表读 4.29 µs/项（持句柄）、写 70–92 µs/项（`RegFlushKey` 1.271 ms）、枚举 2.2–2.5 µs/项、
  通知 0.05–0.08 ms；INI 写 1.5 µs 是缓存假象、读 45 µs 比注册表贵 10 倍 → 大配置落文件、小设置进 HKCU。
- **目录**：`SHGetKnownFolderPath` 十个文件夹全 `hr=0`；`User Shell Folders` 是 `REG_EXPAND_SZ`（真源）、`Shell Folders` 是 `REG_SZ`（会过期）；
  `CreateDirectoryW` 不建中间层，用 `SHCreateDirectoryExW`（第二次 **183**）；相对路径落在 **CWD**，换 CWD 后 `config.ini` 变成 `C:\Windows\config.ini`。
- **自启与关联**：HKCU 级都不需要提权，Run 键"写→读回→等 1 秒确认没启动→删→确认 rc=2"最短闭环走完；
  `.qzdemo` 写 `HKCU\Software\Classes` 后 HKCR 立刻可见、`AssocQueryStringW` 三条 S_OK，`RegDeleteTreeW` 后回到 rc=2；
  **`AssocQueryString` 的 hr 不能用来判断"注册过没有"**。
