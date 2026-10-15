---
title: 资源脚本与图标
description: 实测：windres 编一个 2.4KB 的 .rc 要 482–905 毫秒，编一个装着 4.3MB 载荷的 .rc 也是 588–905 毫秒——成本全在启动预处理器；.rc 里的 UTF-8 中文被按 ACP=936 读进去，字符串从 6 个字符变成 9 个乱码码点，而 A 版 LoadString 又把它"错进错出"还原成正确的中文；图标请求 128×128 时系统宁可用 256 缩小也不用 48 放大；对每个资源名再查一次语言，shell32 的全量枚举从 6.02 毫秒变成 18,994 毫秒。
date: 2026-10-15
tags: [Win32, 资源, RC, 图标, LoadString, MAKEINTRESOURCE]
category: win32
section: win-resource
---

> 环境：Windows 11 x64（ACP=936，控制台切到 UTF-8 输出），**GCC 13.1.0 + GNU windres 2.39（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/`）**。做法：用一个 Python 脚本生成 `multi.ico`（16/32/48/256 四张，每张涂唯一颜色）、两张 24bpp `.bmp`、一个 4,194,322 字节的 `payload.bin`，再写四个 `.rc`（主资源 + 三种语言各一份）编成 COFF 目标链进探针 exe，然后让 exe 自查自己的资源。系统侧只读：`LOAD_LIBRARY_AS_DATAFILE` 映射几个系统 DLL 数资源，没有写入任何系统文件、注册表或服务。所有耗时给 5 次中的中位或区间，同机还有其它 agent 在跑。

## 一、`.rc` 到 exe：固定成本在编译器进程上

windres 的正确用法先踩了一个坑：

```text
gcc r1.c main.res -o r1.exe        → main.res: file not recognized: file format not recognized
windres main.rc -O coff -o main_res.o   → 4500946 字节   gcc r1.o main_res.o ... → 链接成功
```

`.res`（RES 格式）ld 不认，**必须显式 `-O coff` 变成目标文件**（或者把 `.rc` 直接交给 gcc，让它内部调 windres）。编译耗时与载荷大小无关，因为成本是"另起一个 gcc 当预处理器"：

```text
main.rc（含 4.29MB 载荷 + 285KB 图标）windres：905 / 588 / 750 ms
tiny.rc（2.4KB，两条资源）        windres：656 / 901 / 482 ms
```

链进 exe 之后，资源在 PE 里就是一个段：

```text
文件大小=4616419 字节   段数=18 子系统=3(CONSOLE)
.text  VA=0x00001000 VSize=47000   Raw=47104   Ptr=1536
.rsrc  VA=0x00016000 VSize=4501176 Raw=4501176 Ptr=64512   ← 资源段（VirtualSize = RawData，不压缩）
```

自查全量清单：

```text
类型 "MYDATA":  "PAYNAME" 1150 / #200 4194322 / #201 1150      （3 个名字）
类型 #2  (RT_BITMAP): #101 228 / #102 116                      （2 个名字）
类型 #3  (RT_ICON)  : #1 1128 / #2 4264 / #3 9640 / #4 270376  （8 个名字）
类型 #6  (RT_STRING): #1 106 / #2 78 / #3 44 / #32 78          （4 个名字）
类型 #14 (RT_GROUP_ICON): #1 62 / #2 20 / #3 48                （3 个名字）
类型 #16 (RT_VERSION): #1 580                                  （1 个名字）
汇总：类型=6 条目=21 字节合计=4499550 最大一条=4194322 全量枚举耗时=0.19 ms
```

`1 ICON "multi.ico"` 一行在资源里变成 **4 条 RT_ICON + 1 条 RT_GROUP_ICON**——组是目录，图是数据，分开编号（`#1..#4` 是全局顺序编号，不按组重排）。MinGW 手写资源清单时 `RT_MANIFEST`（#24）**一个都没有**（`EnumResourceNamesW(RT_MANIFEST)` 返回 0，`lasterr=1813 找不到映像文件中指定的资源类型`），MSVC 链接器默认会塞一份——上一节靠资源 ID 24 改 `activeCodePage` 的做法，在 MinGW 下得自己加。

windres 的语法子集也和 MSVC 的 RC 不一样，实测只有这一条能过：

```text
200 "MYDATA" "payload.bin"   → windres: syntax error（引号类型 + 文件名）
200 MYDATA   "payload.bin"   → 通过，4194400 字节
204 "MYDATA" { 1,2,3 }       → 通过（引号类型 + 内联数据可以）
"PAYNAME" "MYDATA" "one.ico" → syntax error；"PAYNAME" MYDATA "one.ico" → 通过
```

**自定义类型要写裸标识符**，同时名字可以是字符串（`PAYNAME`）——于是同一个 `MYDATA` 类型下出现了 `"PAYNAME"`、`#200`、`#201` 三种名字并存。

## 二、资源 ID 的三套语义：数字、名字、块号

`MAKEINTRESOURCE` 只是把数字塞进指针低位，所以 **数字类型和字符串类型不通用**：

```text
EnumResourceNamesW(hMod, (LPCWSTR)101, …) → 返回=0 命中=0 lasterr=1813
EnumResourceNamesW(hMod, L"MYDATA",   …) → 返回=1 命中=3
FindResourceW(hMod, MAKEINTRESOURCEW(200), L"MYDATA") → 00007ff660b67360（找到）
FindResourceW(hMod, L"PAYNAME",         L"MYDATA")    → 00007ff660b67350（找到，同类型不同名字）
FindResourceW(hMod, MAKEINTRESOURCEW(999), L"MYDATA") → NULL lasterr=1813
```

字符串表的编号规则是这节最容易算错的地方。实测块号 **= id/16 + 1**，槽位 **= id%16**，块内布局是 `[WORD 长度][UTF-16 串]` 紧排：

```text
id=  1 → 块#1 槽 1  len=9   id=  2 → 块#1 槽 2  len=16   id= 15 → 块#1 槽15 len=12
id= 16 → 块#2 槽 0  len=11   id= 17 → 块#2 槽 1  len=12   id= 33 → 块#3 槽 1 len=6
id= 48 → 块#4 槽 0  不存在 lasterr=1814
反例（按 id/16 不加 1）：id=1 用 #0 → NULL lasterr=1814   id=500 用 #31 → NULL lasterr=1814
```

`LoadStringW` 的缓冲区语义比 `GetWindowTextA`（上一节）规矩得多，但 `nMax=0` 那个"魔法用法"是真的：

```text
缓冲区给 10（串长 16）→ 返回 9，内容截断   缓冲区给 5 → 返回 4，第 5 个 wchar=0000（不越界）
LoadStringW(h,1,buf,0)  → 返回长度 9，并且把内部地址写进 buf：00007ff660fb195c
同一块 LockResource 的基址 =                         00007ff660fb1958   ← 差 4 字节 = 那个 WORD 长度字段
按 %s 的串：LoadStringW(id=2, 64) → 16 字符 "second %s string"（不做任何替换）
```

也就是说 `nMax=0` 时第三个参数被当成 `LPTSTR*` 用，返回的是资源映射里的指针，**零拷贝**；`%1` 这类替换要自己走 `FormatMessage`。

## 三、编码：`.rc` 是 UTF-8 时，不加 pragma 就坏

同一个字符串、同一个程序、两份 `.rc`（唯一差别是一行 `#pragma code_page(65001)`），链成两个 exe：

```text
带 #pragma code_page(65001)：LoadStringW(600) → 6 个码点 7B2C 4E00 4E2A 4E2D 6587 4E32 = 第一个中文串   块大小=64 字节
不带 pragma             ：LoadStringW(600) → 9 个码点 7ED7 E0FF 7AF4 6D93 E043 8151 93C2 56E6 8986 = 绗涓竴涓腑鏂囦覆  块大小=70 字节
同一份 .rc 里的 ASCII 串："ascii only" → 两份都是 10 字符，完全正常
```

windres 默认按**当前 ACP（本机 936）**解释 `.rc` 源文件，UTF-8 的三字节中文被拆成 GBK 的双字节字，存进资源表的就是一堆错码点，而且**字符数都变了**（6→9，块 64→70 字节）。真正恶心的是它会被"错进错出"掩盖：

```text
LoadStringA(1) → 18 字节 E7 AC AC E4 B8 80 E4 B8 AA E5 AD 97 E7 AC A6 E4 B8 B2
把这 18 字节按 ACP=936 再解释 → "第一个字符串"（看起来完全正确！）
```

因为 A 版做的是 UTF-16→GBK，正好把 windres 的 GBK→UTF-16 逆回去。**只用 A 版 API 的人看不见问题**，只有 W 版调用、或者把资源交给别人（MUI、本地化流程）时才炸。规则：`.rc` 里加 `#pragma code_page(65001)`，或者整个文件用 ACP 编码保存。

## 四、图标：多尺寸的选择规则

我的 `multi.ico` 四张图各涂一种唯一颜色（BGR）：16→(30,20,10)、32→(60,50,40)、48→(90,80,70)、256→(C0,B0,A0)。`LoadImageW(hMod, MAKEINTRESOURCE(1), IMAGE_ICON, cx, cx, …)` 之后用 `GetIconInfo` + `GetDIBits` 读回像素，反推它用了哪一张：

```text
请求   0×  0 → 16x16  像素(4,3)=BGR(30 20 10) 源=16 精确        请求  40× 40 → 40x40  BGR(8F 7F 6F) 源=48 缩放（色差 3）
请求  16× 16 → 16x16  BGR(30 20 10) 精确                        请求  48× 48 → 48x48  BGR(90 80 70) 精确
请求  24× 24 → 24x24  BGR(5F 4F 3F) 源=32 缩放（色差 3）        请求  64× 64 → 64x64  BGR(8F 7F 6F) 源=48 放大
请求  32× 32 → 32x32  BGR(60 50 40) 精确                        请求 128×128 → 128x128 BGR(C0 B0 A0) 源=256 缩小 ★
请求 200×200 → 200x200 BGR(BF AF 9F) 源=256 缩放                请求 256×256 → 256x256 BGR(C0 B0 A0) 精确
请求 300×300 → 300x300 BGR(BF AF 9F) 源=256 放大                color 32bpp + mask 恒 1bpp，热点=(w/2,h/2)
```

`★128×128` 是重点：源里有 48 却没有 128，系统**没有把 48 放大，而是把 256 缩小**——宁可降采样也不升采样。这就是"少给一个大尺寸图标，Windows 100% 缩放下反而糊"的原因。另外三条：

```text
LR_DEFAULTSIZE + cx=cy=0 → 32x32 = SM_CXICON        不带 LR_DEFAULTSIZE 的 cx=cy=0 → 16x16 = SM_CXSMICON
LR_SHARED 连续两次 LoadImage → 两个句柄相同（=1）→ 这种图标不能 DestroyIcon，DestroyIcon 会把别人正在用的句柄干掉
LoadIconW(不存在的 id) → NULL lasterr=1813   LoadIconW(NULL,IDI_APPLICATION)=0x1002b（系统图标是原子句柄）
CopyIcon(h) → 给出不同的句柄 0x105b614f，可安全 DestroyIcon
SizeofResource(RT_ICON) #1..#4 = 1128 / 4264 / 9640 / 270376
   270376 = 256×256×4(262144) + 掩码 256 行×32 字节(8192) + BITMAPINFOHEADER(40)  ← 分毫不差
```

掩码恒 1bpp、颜色图的 alpha 字节全 0（我写 ICO 时就是填 0）——**BI_RGB 的 32bpp 图标不靠 alpha 透明，靠 AND 掩码**。上一节 `AlphaBlend` 那个"alpha=0 就整个消失"的坑，在图标上不存在，但把图标当 DIB 直接喂 `AlphaBlend` 就会整个消失。

现代系统把 PNG 塞进 `RT_ICON`，实测扫描：

```text
shell32.dll 的 RT_ICON #1..#600：命中 595，其中 PNG 签名(89 50 4E 47) 66 个共 1430919 字节，
                                 剩 529 个是 BITMAPINFOHEADER 共 2952264 字节
ddores.dll  同样扫描：600 个命中，PNG 77 个共 1437220 字节
```

## 五、`LoadResource`/`LockResource` 不拷贝，读它才缺页

对那条 4,194,322 字节的自定义资源：

```text
FindResource + SizeofResource：8.3 µs
LoadResource + LockResource  ：2.6 µs → ptr=00007ff7a9656960（就在镜像映射里，没有分配、没有拷贝）
VirtualQuery(ptr)：State=0x1000(MEM_COMMIT) Protect=0x8(PAGE_EXECUTE_READ) 所在区=整个镜像 4501504 字节
调用前：WorkingSet=8.1 MB  Private=6.6 MB  页错误=2158
每 4KB 采样一次（1024 次）：3.50 ms   页错误 +1023   WorkingSet +4.0 MB   Private +0.0 MB
再采样一次（页已在）    ：0.02 ms（175 倍差）
第二次 LoadResource 返回同一个句柄；FreeResource 返回 0（文档说它是空操作）
```

**1024 次采样 = 1023 次缺页**，正好每页一次；第二次 0.02ms 证明代价全在首次触碰。`Protect=PAGE_EXECUTE_READ` 说明资源在镜像的只读段里——写它会直接崩，要改就得先 `VirtualProtect` 或拷出来。另外 `LoadResource(hMod, 乱填的 HRSRC)` → NULL + `lasterr=193 "%1 不是有效的 Win32 应用程序"`（错误串来自通用表，跟资源没关系）。

## 六、语言：三个 `.rc`、四种语言 ID、谁也没按 UI 语言选

三个只含字符串表的 `.rc`，唯一区别是 `LANGUAGE` 行，实际写进目录的语言：

```text
LANGUAGE 4, 2   → 0x0804 (zh-CN)      LANGUAGE 9, 4 → 0x1009 (en-CA！)   ← 子语言 4 是加拿大英语，美国英语是 1
LANGUAGE 0, 0   → 0x0000 (语言中性)   没写 LANGUAGE → 0x0409（windres 默认）
EnumResourceLanguagesW(RT_STRING, #32) 返回=1 命中 3 个语言：0x0000 0x0804 0x1009
  lang=0x0000 → Size=78   lang=0x0804 → Size=70   lang=0x1009 → Size=90   ← 同块号同类型，三份独立数据
```

然后是关键结果——**加载器选中了语言中性那一份**：

```text
LoadStringW(500) → 23 字符 "neutral language string"     ← 中性遮蔽了 zh-CN 和 en-CA
LoadStringW(501) → 0 字符（501 只存在于 zh 和 en-CA 块里，取不到）
LoadStringW(515) → 0 字符 lasterr=1814
本机 GetUserDefaultUILanguage=0x0804  GetUserPreferredUILanguages 第一项="zh-CN"  ACP=936
GetProcAddress(user32,"LoadStringExW") = NULL lasterr=127   ← 想显式指定语言的 API 拿不到
```

用户 UI 语言明明是 zh-CN，结果仍然是中性优先。所以要拿指定语言，只能自己 `FindResourceExW(hMod, RT_STRING, MAKEINTRESOURCE(id/16+1), langId)` 再按块内布局解析（第二节的公式在这里复用）。

## 七、只读盘点系统 DLL：DATAFILE 的边界与一个 O(n²)

| 文件 | 大小 | DATAFILE 映射 | 全量枚举（只 FindResourceEx） | 类型 | 条目 |
| --- | --- | --- | --- | --- | --- |
| user32.dll | 1.83 MB | 0.68–0.83 ms | 1.41 ms | 13 | 223 |
| comdlg32.dll | 0.94 MB | 1.09 ms | 1.23 ms | 11 | 173 |
| msctf.dll | 1.37 MB | 1.15 ms | 1.28 ms | 7 | 178 |
| shell32.dll | 7.64 MB | 0.89 ms | **6.02 ms** | 19 | 3570 |
| explorer.exe | 3.23 MB | 1.54 ms | 1.27 ms | 8 | 226 |

```text
comdlg32：DATAFILE 平均 2.03 ms vs 完整 LoadLibrary 平均 7.98 ms（5 次）
DATAFILE 句柄 = 00000274acc10001（低位是 1！）完整加载 = 00007ffa31f80000 → 同一 DLL 两种映射并存
DATAFILE 句柄上 GetProcAddress("DialogBoxIndirectParamW") → NULL lasterr=126 找不到指定的模块
   （但 user32 的 DATAFILE 句柄上同一个调用返回了真地址，因为 user32 本来就被完整加载过）
shell32 的 RT_GROUP_ICON 条目=335，耗时 0.32 ms；RT_ICON 条目=2485，耗时 3.23 ms
user32 类型 #21（RT_WAVE）名字 #32665 Size=77440，前 8 字节 52 49 46 46 = "RIFF"（WAVE 内嵌）
```

**`DATAFILE` 句柄不是模块句柄**：低位带标记、`GetProcAddress` 不可靠，只能拿它读资源。

那个 O(n²)：把同一个 shell32 的枚举里再加一句 `EnumResourceLanguagesW(每个名字)`，耗时从 **6.02 ms 变成 18,994 ms（3156 倍）**；ddores.dll 全量枚举 352 ms、user32 151 ms。**语言列表要按需查，不要全量扫。**

还有一处我没查明白，如实记下：按名字求 `SizeofResource` 时，user32 得到 950,768 字节，和它 `.rsrc` 的 VirtualSize 953,936 只差目录开销（3,168）；但 shell32 求到 18,255,765 字节（文件才 8,009,440），ddores 求到 16,329,752 字节（文件 71,600，`.rsrc` VSize 只有 1,376）。已排除"文件被压缩"：`GetFileSizeEx`、`GetCompressedFileSizeW`、`FindFirstFileW` 三个数字完全一致，属性只有 0x20（普通文件）。这两类模块的字节合计我**不采信**，条目数和时间才是可复现的。

## 小结

- **构建链路**：MinGW 下 `.res` 要 `-O coff` 才链得动；windres 的成本是固定 0.48–0.9 秒（4.3MB 载荷和 2.4KB 没差别）；自定义类型必须写 `ID MYDATA "file"`，引号类型 + 文件名直接 syntax error；默认不生成 `RT_MANIFEST`。
- **ID 三套语义**：类型/名字的"数字 vs 字符串"不互通（`(LPCWSTR)101` 找不到 `L"MYDATA"`，`lasterr=1813`）；字符串表 **块号 = id/16 + 1、槽 = id%16**（按 `id/16` 查全部 1814）；块内是 `[WORD 长度][UTF-16]` 紧排；`LoadStringW(nMax=0)` 返回的是**资源映射里的指针**（实测与 `LockResource` 基址差 4 字节），零拷贝；截断规矩（给 5 返回 4 并补 0）。
- **编码**：不加 `#pragma code_page(65001)`，UTF-8 的 `.rc` 会被按 ACP=936 读成 9 个错码点（正确是 6 个），块从 64 字节变 70 字节；而 A 版 `LoadStringA` 会把它错进错出还原成正确中文，**A 版调用完全看不出故障**。
- **图标**：一行 `ICON` 变 N 条 RT_ICON + 1 条组；256 那张 `SizeofResource` 精确等于 `w*h*4 + w/8 对齐*h + 40`；尺寸选择是"**宁可大图缩小，也不小图放大**"（请求 128 时选了 256 而不是 48）；`LR_DEFAULTSIZE` 给 SM_CXICON(32)、不给则 16；`LR_SHARED` 返回共享句柄不能 Destroy；BI_RGB 图标 alpha=0、透明靠 AND 掩码；系统 DLL 里 PNG 图标占了 66–77 条。
- **加载语义**：`Find`+`Sizeof`=8.3µs、`Load`+`Lock`=2.6µs 都不拷贝，数据在 `PAGE_EXECUTE_READ` 的镜像段里；1024 次跨页采样产生 1023 次缺页、3.50 ms，页已在后只要 0.02 ms；`FreeResource` 是空操作。
- **语言**：`LANGUAGE` 的第二参数是子语言（4 是 en-CA 不是 en-US）；同一块可以在 0x0000/0x0804/0x1009 各存一份且大小不同；**`LoadString` 选了语言中性那份，遮蔽了具体语言，即使本机 UI 语言就是 zh-CN**；user32 里没有 `LoadStringExW` 导出，要指定语言只能 `FindResourceExW` + 自己解析块。
- **系统侧观察**：`DATAFILE` 句柄低位为 1、`GetProcAddress` 报 126（除非该 DLL 已被完整加载），映射 0.7–1.5 ms 而完整加载 comdlg32 要 7.98 ms；全量枚举时对每个名字再查语言会把 6 ms 放大到 19 秒。
- **本机未实测/不采信**：shell32、ddores 的 `SizeofResource` 求和（远超文件与 `.rsrc` 大小，机制未查明，只报条目数与耗时）；PNG 图标经 `LoadImage` 解压后的实际像素质量未测；`.mui` 与 MUI 重定向路径未测（需要写注册表/改系统文件）；`RT_CURSOR`/动画游标、`RT_ACCELERATOR`/菜单/对话框模板的字段解析未测（留给后续章节）。
