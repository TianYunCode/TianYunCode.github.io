---
title: 资源脚本与图标
description: 实测：同一个 .rc 只加一行 `#pragma code_page(65001)`，中文串从 9 个乱码码点变成 6 个正确码点、资源块从 70 字节缩到 64 字节；图标请求 24×24 拿到的是 32×32 源缩放后的像素（色标差 3），只有精确命中的尺寸色差为 0；RT_BITMAP 里存的是 .bmp 去掉 14 字节文件头（242→228、130→116）；4MB 自定义资源 LockResource 只花 0.9 微秒且一字节不拷，逐页采样 1024 次才让 WorkingSet 涨 4.0MB；ddores.dll 文件只有 71 600 字节，而 1096 条 RT_ICON 的 SizeofResource 合计 16 303 340 字节——228 倍，且这些数据不在文件里。
date: 2026-10-15
tags: [Win32, 资源, windres, 图标, 字符串表, 本地化]
category: win32
section: win-resource
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，资源用同目录的 `D:/Qt/Tools/mingw1310_64/bin/windres.exe -i x.rc -O coff -o x_res.o` 生成，链接 `gcc r3.c main_res.o -o r3.exe -luser32 -lgdi32 -lpsapi -lversion`。本机**没有 rc.exe**（`find "C:/Program Files (x86)/Microsoft Visual Studio" "C:/Program Files (x86)/Microsoft SDKs" -iname rc.exe` 无结果），所以 MSVC 侧的 .rc 差异本节未实测。资源探针全部只读：自己的 exe + `LOAD_LIBRARY_AS_DATAFILE` 打开系统 DLL，不改任何系统状态。绝对耗时取 3–5 次中位数并给区间，同期同机还有其它 agent 在跑，只看量级。字节数、条目数、码点数、错误码这类量是这节的主角。

## 一、.rc 到 exe 的 .rsrc 段：三步，每步都会失败

`windres` 的三条语法实测（同一条数据，只改类型写法）：

| .rc 写法 | windres 结果 |
| --- | --- |
| `200 MYDATA "one.ico"`（裸标识符当自定义类型） | 通过，`.res` 1348 字节 |
| `200 "MYDATA" "one.ico"`（类型加引号） | `windres.exe: t_quot.rc:2: syntax error` |
| `201 101 "one.ico"`（类型用序数） | 通过，`.res` 1332 字节 |
| `#include <winres.h>` + 默认预处理器 | 通过，`.res` 2754 字节 |
| 同上但加 `--preprocessor=cpp` | `fatal error: winres.h: No such file or directory` |

最后一行容易踩：`--preprocessor=cpp` 会换成系统 `cpp`，它不知道 MinGW 的 include 目录，必须自己补 `-I`；默认预处理器内置了这个路径。而 `RC_INVOKED` 在 .rc 里是定义的，所以 `winuser.h` 里那个 `#ifdef RC_INVOKED → #define RT_MANIFEST 24` 分支生效——**.rc 里 `RT_MANIFEST` 是裸整数 24，C 代码里 `RT_MANIFEST` 是 `MAKEINTRESOURCE(24)` 指针**，两边写反就是"找不到资源"。

链接后进 exe 的样子（`r2.exe` 自己解析自己的 PE 头）：

```text
文件大小=4616419 字节  e_lfanew=128 signature=0x00004550 机器=0x8664 段数=18 子系统=3
.text    VA=0x00001000 VSize=47000   Raw=47104   Ptr=1536
.data    VA=0x0000D000 VSize=240     Raw=512     Ptr=48640
.rdata   VA=0x0000E000 VSize=7056    Raw=7168    Ptr=49152
.rsrc    VA=0x00016000 VSize=4501176 Raw=4501176 Ptr=64512   ← 资源段
```

资源段占了整个文件 4 501 176 / 4 616 419 = **97.5%**。全量枚举（`EnumResourceTypesW` + 每类型 `EnumResourceNamesW`，不 `LoadResource`）：

```text
类型=6 条目=21 字节合计=4499550 最大一条=4194322 全量枚举耗时=0.17 ms
  "MYDATA": "PAYNAME" 1150 / #200 4194322 / #201 1150     #2(BITMAP): #101 228 / #102 116
  #3(ICON): #1 1128 / #2 4264 / #3 9640 / #4 270376（…共 8 个名字）
  #6(STRING): #1 106 / #2 78 / #3 44 / #32 78   #14(GROUP_ICON): #1 62 / #2 20 / #3 48   #16(VERSION): #1 580
```

`字节合计 4 499 550` 对 `.rsrc` 的 `4 501 176`：差 1626 字节就是三层目录（type/name/language）自己的开销。**枚举是便宜的**（0.17ms，不触碰数据），很多"启动慢"其实是把 `LoadResource` 放进了枚举回调里。

## 二、ID 语义：序数与名字是两套命名空间

`MAKEINTRESOURCE(i)` 就是 `(LPWSTR)(ULONG_PTR)(WORD)i`——高 48 位全 0 才被当作序数：实测 `v=0`…`v=65535` 的 `IS_INTRESOURCE` 都是 1（`0` 也算序数，只是没有资源用它），而 `65536` 变 0（当成字符串指针）。

用 `r3.exe` 里的同一条 MYDATA 试各种写法（`r11.exe`）：

| 查找写法 | 结果 | `GetLastError()` |
| --- | --- | --- |
| `MAKEINTRESOURCEW(200)` + `L"MYDATA"` | 命中 Size=4194322 | 0 |
| `MAKEINTRESOURCEW(200)` + `L"mydata"` | **同一个 HRSRC**，Size=4194322 | 0 |
| `MAKEINTRESOURCEW(200)` + 序数 `101` | 未命中（少一个字母也一样） | 1813 |
| `MAKEINTRESOURCEW(200)` + `L"*"` | 未命中 | 1813 |
| `L"PAYNAME"` / `L"payname"` + `L"MYDATA"` | **都命中**同一条 | 1813（残值，见下） |
| `L" PAYNAME"` / `L"PAYNAME "` | 未命中 | 1814 |
| 序数 `101` + `RT_BITMAP` | 命中 Size=228 | 1814（残值） |
| 字符串 `L"101"` + `RT_BITMAP` | 未命中 | 1814 |

四条规矩：**.rc 里的裸标识符类型存成"字符串类型"，序数类型永远找不到它**（想两边通用就得在 .rc 里写 `201 101 "file"`）；类型名和资源名都是**大小写不敏感**但**不忽略空格**；`FindResource` **不支持 `*` 通配**（`EnumResourceNames` 传 `NULL` 才是"全部"）；错误码分两级——**1813 = 找不到指定的资源类型，1814 = 类型在、名字不在**，这两个码能直接告诉你 .rc 里的 ID 是不是写漏了。另外 `PAYNAME` 那行明明命中了却仍然打印 `lasterr=1813`：**成功路径不重置 `GetLastError`**，判成败只看返回值。

`EnumResourceNamesW` 的回调返回 `FALSE`（包括传 `NULL` 回调）时：`返回=0 命中=1 lasterr=998`——正常的"提前停止枚举"报了个 `ERROR_INVALID_ADDRESS`，我在 r1 和 r10 两次独立看到，别拿它当故障。

## 三、字符串表：块号公式、编码、三种语言谁赢

块号公式最容易记错。`main.rc` 里我故意放了跨块的 ID（1/2/15/16/17/33/500/501），直接读块头算槽位：

```text
id=  1 → 块#1 槽 1      id= 16 → 块#2 槽 0     id= 17 → 块#2 槽 1
id= 15 → 块#1 槽15      id= 33 → 块#3 槽 1     id= 500 → 块#32 槽 4
id= 48 → 块#4 不存在 lasterr=1814（本 exe 只到 #3）
反例：块号用 id/16（不加 1）→ id=1 查块#0、id=500 查块#31，两个都 NULL lasterr=1814
块#1 Size=106 = 槽1(2+18) + 槽2(2+32) + 槽15(2+24) + 13 个空槽×2 = 26
块#2 Size= 78 = 槽0(2+22) + 槽1(2+24) + 14 个空槽×2 = 28
块#3 Size= 44 = 槽1(2+12) + 15 个空槽×2 = 30
```

**块名 = `id/16 + 1`，槽 = `id%16`**（整数除法）；块内是 `[WORD 字符数][UTF-16 文本]` 紧凑排列，**16 个槽全部占位**，空槽也花 2 字节——块大小能逐字节对上（上面三行）。`RT_STRING` 的名字是"块号"而不是字符串 ID，这就是 `FindResource(RT_STRING, MAKEINTRESOURCE(1))` 找不到 `id=1` 字符串的原因。

另外三条 `LoadString` 语义：`LoadStringW(2)` 返回 16 字符 `"second %s string"`（**不做 `%s` 替换**，那是 `FormatMessage` 的活）；`nMax=5` 而串长 9 → 返回 4、只写 4 个 wchar + 终止符（**截断不报错**）；`nMax=0` → 返回长度 9 并把缓冲区指针改成资源块内部地址（`00007ff660fb195c` = `LockResource` 基址 + 4，文档行为实测成立，但那块内存只读且随时可能被 `FreeResource` 抽走）；`LoadStringW(501)` 返回 0 是合法空串，`LoadStringW(515)` 返回 0 且 `lasterr=1814` 才是真没有。

编码这个坑值得单独一段。.rc 源文件我存成 UTF-8，`cp.rc` 比 `nocp.rc` 只多一行 `#pragma code_page(65001)`，两份 .res 分别链接同一个 `r7.c`：

```text
带 pragma：LoadStringW(600) 返回=6 码点=7B2C 4E00 4E2A 4E2D 6587 4E32  "第一个中文串"  块#38 Size=64
不带 pragma：返回=9 码点=7ED7 E0FF 7AF4 6D93 E043 8151 93C2 56E6 8986  乱码            块#38 Size=70
ASCII 串（601）两边都是 10 个字符，完全看不出差别
```

**windres 默认按 ACP（本机 936）读 .rc**，UTF-8 的中文字节被当 GBK 拆成 9 个字符存进资源，块还胖了 6 字节。更阴的是它"看起来是对的"：`LoadStringA(1)` 返回 18 字节 `E7 AC AC E4 B8 80 E4 B8 AA E5 AD 97 E7 AC A6 E4 B8 B2` —— **正是「第一个字符串」的 UTF-8 编码原样回到手里**。W 版进错、A 版出错，一进一出抵消，用 `LoadStringA` + UTF-8 控制台的程序毫无察觉；只要有一次走 W 接口（控件、对话框、`LoadMenu`）就全暴露。**规矩只有一条：.rc 第一行写 `#pragma code_page(65001)`，并且程序里只走 W 接口。**

多语言（`zh.rc`/`en.rc`/`neu.rc` 三份各带 `LANGUAGE`，同一个 `RT_STRING` 块 #32）：

```text
EnumResourceLanguages(RT_STRING, #32) 返回=1 语言数=3：0x0000 0x0804 0x1009
  lang=0x0000 Size=78   lang=0x0804 Size=70   lang=0x1009 Size=90
LoadStringW(500) 不带语言 → 23 字符 "neutral language string"   ← neutral(0x0000) 胜出
本机 GetUserDefaultUILanguage=0x0804  GetUserPreferredUILanguages 第一项="zh-CN"
```

三种都在时，**语言中性块赢过本机 UI 语言**（zh-CN 就在机器上，却没被选中）：`LoadString` 走的是模块自身语言回退，不涉及 MUI 重定向。想在代码里显式挑语言只能 `FindResourceExW(..., lang)` 再自己拆块。

`VERSIONINFO` 与文件版本（`r2.exe`）：

```text
GetFileVersionInfoSizeW=1164 → GetFileVersionInfoW 返回=1
"\\" → 长度=52 magic=0xFEEF04BD File=1.2.3.4 Product=9.8.7.6 Type=1 OS=0x40004
Translation 返回=1 长度=4 字节=080404B0
080404b0\FileDescription → 1 长度=7（中文串同样被 ACP 坑成乱码）   040904b0\… → 1 长度=15 "resource probe"
04090400\FileDescription → 返回=0 长度=0        ← 代码页必须与块里写的完全一致
不存在的文件 → GetFileVersionInfoSizeW=0 lasterr=2
```

`VerQueryValue` 的子键是 `"<语言><代码页>\值名"` 拼出来的字符串，**0400 与 04b0 不等价**，写错就静默返回 0 长度。

## 四、位图和图标：资源里到底存了什么字节

`RT_BITMAP` 不是 .bmp 文件原样：`big24.bmp` 磁盘上 242 字节，资源里 `SizeofResource=228`；`odd24.bmp` 130 字节 → 资源 116 字节。**恰好各减 14 = `BITMAPFILEHEADER` 的大小**。资源里存的是裸 `BITMAPINFOHEADER` + 像素。头 24 字节的原样十六进制：

```text
28 00 00 00 08 00 00 00 08 00 00 00 01 00 18 00 00 00 00 00 C0 00 00 00
biSize=40  biWidth=8  biHeight=8  biPlanes=1 biBitCount=24  biCompression=0(BI_RGB)  biSizeImage=192
源文件 odd24.bmp 前 4 字节=42 4D（"BM"），资源里没有
```

我第一版把这行读错了：按 `DWORD` 数组取 `dw[3]` 当 `biCompression`，打印出 `compression=0x180001`，于是怀疑是 `BI_BITFIELDS(3)` 要跟 12 字节颜色掩码——其实 `dw[3]` 是 `biPlanes | biBitCount<<16`（`0x0018_0001` = 1 平面 24 位），真正的 `biCompression` 在 `dw[4]=0`，`biSizeImage` 在 `dw[5]=192`。**结构体字段类型不确定时，先把原始字节打出来再对表**，不然一个字段错位能编出整套假结论。`LoadImage` 之后 `bmWidthBytes=16`（5 像素 × 3 字节 = 15 → 补到 4 的倍数），而 `biSizeImage` 写的是 192 而不是带填充的 192/80 混值，也说明**别用 `biSizeImage` 反推行数**。

图标：`multi.ico` 装了 4 张（16/32/48/256，每张一种唯一色标：16→BGR(30,20,10)、32→(60,50,40)、48→(90,80,70)、256→(C0,B0,A0)），`LoadImage` 请求不同尺寸后读像素 (4,3) 反查用了哪一张：

| 请求 | 得到 | 实测 BGR | 判定 |
| --- | --- | --- | --- |
| 0×0 / 16×16 | 16×16 | 30 20 10 | 精确命中（差 0） |
| 24×24 | 24×24 | 5F 4F 3F | 由 32 缩放（差 3） |
| 32×32 | 32×32 | 60 50 40 | 精确命中（差 0） |
| 40×40 / 64×64 | 同尺寸 | 8F 7F 6F | 由 48 缩放（差 3） |
| 48×48 | 48×48 | 90 80 70 | 精确命中（差 0） |
| 128×128 / 256×256 | 同尺寸 | C0 B0 A0 | 由 256 缩小，色标恰好没变（差 0） |
| 300×300 | 300×300 | BF AF 9F | 由 256 放大（差 3） |

`SM_CXICON=32 SM_CXSMICON=16 LOGPIXELSX=96`；`LR_DEFAULTSIZE`（cx=cy=0）→ 32×32，不带该标志、cx=cy=0 → 16×16；每张都是 32bpp 颜色 + 同尺寸 1bpp AND 掩码，**颜色像素第 4 字节恒 00**（GDI 的 DIB 不带 alpha，与上一节的分层窗口对不上）；`LR_SHARED` 两次加载句柄相同=1（同一个 HICON，别 `DestroyIcon`）；`LoadIconW(不存在的 id=77)` 返回 NULL `lasterr=1813`。

**请求尺寸不在 .ico 里就有 3/255 的色偏和一次重采样**（`GetDIBits` 给的是重采样后的行数）。图标要清晰就把 16/24/32/48/64/128/256 都塞进 .ico；`RT_ICON` 与 `RT_GROUP_ICON` 是两个类型、两套条目（本 exe 里 8 条 vs 3 条），`shell32.dll` 里是 2485 条 vs 335 条——**组和成员分开数**，别以为一个图标 ID 对应一条资源。

## 五、什么时候真的进内存：自己的 4MB 和系统 DLL 的 16MB

`MYDATA #200` 是一条 4 194 322 字节的自定义资源（4MB-24 字节头 + 尾部标记），逐步观察：

```text
FindResource+SizeofResource：6.0 µs（8.3 µs 另一次）    ← 只读目录，不碰数据
LoadResource+LockResource：0.9 µs → ptr=00007ff709446960  两次 LoadResource 句柄相同=1 FreeResource=0
调用前 WorkingSet=7.6 MB Private=6.5 MB 页错误=2014；每 4KB 采样一次（1024 次）：1.62 ms 页错误 +1023 工作集 +4.0 MB Private +0.0 MB
再采样一次（页已在）0.01 ms；VirtualQuery State=0x1000 Protect=0x8 RegionSize=4501504（= .rsrc 的 4501176 向上取整）
```

`LoadResource` 名义上是"加载"，实测**一次内存拷贝都没有**：它只是在映射里定位，真正付出代价的是**你读它**——1024 次采样 = 1023 个硬页错误 + 4.0MB 工作集，第二次采样便宜 162 倍。`Private` 全程 +0.0MB，说明这些页是可被丢弃的文件映射页，不是堆。所以"加载大资源占内存"这个说法要改成：**只有你读过的页占内存**。

反过来，"把所有资源的 `SizeofResource` 加起来"能不能用来估算体积？对系统 DLL 完全不成立（`r5/r8/r9/r10` 四个探针只读观察）：

```text
ddores.dll  文件=71600 字节  SizeOfImage=61440  段数=7
  .rsrc VSize=1376 Raw=4096 Ptr=53248；DataDirectory[RTE_Resources] VA=0xD000 Size=1376
  RT_ICON 枚举 1096 条，SizeofResource 合计=16303340 字节 = 文件大小的 228 倍
  1096 个 LockResource 指针两两不同（去重后=1096），全部落在同一区域：AllocationBase=000001401a5d0000
    RegionSize=16322560 State=0x1000 Protect=0x2(PAGE_READONLY) Type=0x40000(MEM_MAPPED)；逐条读声明范围最后一个字节 1096/1096 可读
  把整个 71600 字节文件读进内存，逐偏移搜索最大那条的前 32 字节（89 50 4E 47 …，PNG IHDR 256×256）：0 命中
  文件流只有 ::$DATA(71600)，无其它 ADS；逐条 Lock 完 1096 条之后 WorkingSet=5616KB→5616KB Private=924KB→924KB 页错误=1482→1482
mmres.dll   文件=12288 字节 RTE_Resources Size=2352，而 RT_ICON #1 声明 27917 字节（比整个文件大）
           #2 头 16 字节 = 28 00 00 00 40 00 00 00 80 00 00 00 01 00 20 00 → w=64 h=128（双高 DIB，下半是 AND 掩码）
shell32.dll 文件=8009440 资源合计=18255765（227.9%）  类型=19 条目=3570
```

结论有三层。**第一**，`SizeofResource` 是目录里的**声明值**，求和既不是文件大小也不是内存占用，别拿它做资源体积预算。**第二**，`LockResource` 对这些系统 DLL 返回的指针**不在模块镜像里**（完整加载后 `GetModuleInformation` 给 `SizeOfImage=61440`，指针却在几百 MB 之外的另一个分配），那是一块 `MEM_MAPPED` + `PAGE_READONLY` 的共享映射：内容有效（PNG 签名、`h=2w` 的图标 DIB 都对得上），但**在这 71 600 字节的文件里逐偏移搜不到**，且读满 1096 条之后工作集/私有内存/页错误计数一个都没动——它跨进程共享，不是你进程新占的量。**这 16MB 的磁盘来源我没查清**（文件里没有、无 ADS、不是解压到私有内存），剩下属于装载器内部实现，本节到此为止不猜。

还有一个纯粹由写法造成的性能悬崖，同一份 shell32、同样 3570 个条目：**只按名字取尺寸**（每个名字一次 `FindResourceExW`）全量枚举 **3.79–6.02 ms**；在同一次遍历里对每个 (类型,名字) **再多问一句 `EnumResourceLanguagesW`**，两次运行分别是 **18 994 ms 和 33 105 ms——约 5000 倍**。语言列表要按需查，不要全量扫：单次调用看着不起眼，乘上条目数就是三个数量级。

DATAFILE 的其它只读盘点数字：

```text
映射耗时（我的运行 / 同事的运行，冷热混合）：user32 0.46/2.39 ms  comdlg32 0.72/12.22 ms  shell32 0.73/1.08 ms
comdlg32：DATAFILE 平均 2.03 ms vs 完整 LoadLibrary 平均 7.98 ms（各 5 次）——只要资源就别完整加载
DATAFILE 句柄低位是 1（00000210d4420001）；同一 DLL 的 DATAFILE 句柄与完整加载句柄是两个不同值
DATAFILE 句柄上 GetProcAddress：user32 → 00007ffa320e2180（竟然成功）；comdlg32/shell32/msctf → NULL lasterr=126
DATAFILE 句柄上 LoadStringW(user32,1) → 0 字符，而 FindResource(RT_STRING,#1) 能拿到 HRSRC
GetModuleHandleW(L"user32") 与 L"user32.dll" 同一基址；kernel32 里没有 LoadStringW 导出，user32!LoadStringEx=NULL lasterr=127
```

`GetProcAddress` 在 DATAFILE 句柄上**依模块而异**（有的给地址、有的报 126），因为数据文件映射没有执行权限也没跑 DLL 入口——能拿到地址只是运气，别调它。

## 小结

- **.rc → .res → .rsrc**：windres 只认 `200 MYDATA "file"`（裸标识符类型），写成 `"MYDATA"` 直接 syntax error；序数类型 `201 101 "file"` 合法；`--preprocessor=cpp` 会丢 include 路径；`RT_MANIFEST` 在 .rc 里是整数 24、在 C 里是 `MAKEINTRESOURCE(24)`。资源段能占 exe 的 97.5%，`.rsrc` 段大小 = 资源字节合计 + 1626 字节的目录开销；纯枚举 21 条只花 0.17ms。
- **ID 语义**：`.rc` 的裸标识符类型 = 字符串类型，序数写法永远找不到；类型名/资源名大小写不敏感但不忽略空格；`FindResource` 不支持 `*`；`1813`=类型不在、`1814`=名字不在（这两个码直接指出 ID 写漏在哪一层），而成功路径不清 `GetLastError`，判成败只看返回值。
- **字符串表**：块号 `id/16+1`、槽 `id%16`，块内 `[WORD len][UTF-16]` 紧排、空槽也占 2 字节；`LoadString` 截断不报错（`nMax=5` 给 9 字符的串只写 4 个）、`nMax=0` 返回内部指针、不做 `%s` 替换；**.rc 必须写 `#pragma code_page(65001)`**，否则中文按 ACP=936 拆错（6 码点变 9 码点、块从 64 变 70 字节），而 `LoadStringA` 又把它转回来，只有走 W 接口的地方才暴露。三种语言同块时语言中性(0x0000) 胜出，本机 zh-CN 没被选中；`VerQueryValue` 的 `04090400` 与 `040904b0` 不等价。
- **位图/图标**：`RT_BITMAP` = .bmp 去掉 14 字节文件头（242→228、130→116），头是 `BITMAPINFOHEADER(40)`、`biCompression=0`；我一度把 `dw[3]` 读成 compression 得出 0x180001 的假 BI_BITFIELDS，靠原始十六进制纠正。图标请求尺寸不在 .ico 里就重采样（色差 3），精确命中差 0；`LR_DEFAULTSIZE`→32 而裸 `cx=cy=0`→16；32bpp 颜色的 alpha 字节恒 0；`LR_SHARED` 同句柄；`RT_ICON` 与 `RT_GROUP_ICON` 条目数分开（本 exe 8 vs 3，shell32 2485 vs 335）。
- **内存驻留**：`LoadResource` 不拷贝（0.9µs、Private +0），代价在"读"——每 4KB 采样一次 = 1023 次页错误 + 4.0MB 工作集；只要资源就用 `LOAD_LIBRARY_AS_DATAFILE`（comdlg32 2.03ms vs 完整加载 7.98ms）。`SizeofResource` 合计对系统 DLL 毫无预算意义：ddores.dll 声明 16 303 340 字节 / 文件 71 600 字节，指针在镜像外的共享 `MEM_MAPPED` 只读区，读满 1096 条不动工作集，且这些字节在文件里搜不到——**该 DLL 的数据来源本机未查清，本节不下结论**。
- **本机未实测**：`rc.exe`/MSVC 资源编译差异（机器上没有 rc.exe）；`RT_MENU`/`RT_DIALOG`/`RT_ACCELERATOR` 的结构解析（属于对话框一节）；`LoadMUIString` 与 .mui 重定向（涉及改系统目录，未做）；图标在桌面上真实渲染的大小（需要 GUI 交互）；上面那 16MB 的磁盘来源。
