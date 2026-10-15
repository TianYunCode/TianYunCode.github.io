---
title: GDI 绘图与双缓冲
description: 实测：同样 120 个矩形，画在窗口 DC 上每个 16.9 微秒，画在内存 DC 上每个 1.3 微秒（13 倍），双缓冲把一帧从 2.110 毫秒压到 0.293 毫秒；SetPixel 每点 581 纳秒而直接写位图内存 1.5 纳秒（398 倍）；StretchBlt 缩小 8 倍时 HALFTONE 比 COLORONCOLOR 慢 207 倍；一次提前的 ReleaseDC 让后面所有 GetDeviceCaps 静默返回 0，而 GetLastError 一动不动。
date: 2026-10-15
tags: [Win32, GDI, 双缓冲, BitBlt, AlphaBlend, 分层窗口]
category: win32
section: win-gdi
---

> 环境：Windows 11 x64（1920×1080，DWM 合成开启），**GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，`-std=gnu11 -O2 -Wall -DUNICODE -lgdi32 -luser32 -lmsimg32 -lpsapi`。所有绝对耗时取 **5 轮中位数并给区间**；同期同机还有 4 个 agent 在跑，所以每个数都带着很宽的区间，只看量级不看末位。绘图全部走内存 DC（`CreateCompatibleDC`+`CreateDIBSection`），窗口放在屏幕角落、探针退出前销毁；不截图。上一节留下的两个坑这节接着处理：**句柄/DC 一律留到退出前才释放**，**每一步打印返回值**。

## 一、每个 GDI 对象占一个槽位，DC 也不例外

基线：控制台进程 `GDI=0`，取一个屏幕 DC 之后 `GDI=1`。各类对象建 200 个再全删（5 轮，报第一轮槽位与 5 轮中位单价）：

```text
CreatePen                  建200个: 槽 1→201（每个 1.00 槽）删成功 200/200 → 净残留 +0
   建 1186 ns（836–1432）   删 745 ns（594–1148）
CreateSolidBrush           槽 1→201 每个 1.00 删 200/200 → 净残留 +10   建 850 删 848 ns
CreateRectRgn              每个 1.00 删 200/200 → 净残留 +8             建 1374 删 2140 ns
CreateBitmap 16x16x24      每个 1.00 → +0                               建 1687 删 1367 ns
CreateDIBSection 16x16     每个 1.00 → +0                               建 4875 删 5194 ns
CreateCompatibleBitmap     每个 1.00 → +0                               建 4427 删 2979 ns
CreateFontW Segoe UI       每个 1.00 → +0                               建 2738 删 1424 ns
CreatePalette 1 项         每个 1.00 → +0                               建 1233 删 918 ns
内核句柄全程 = 100（一个没涨）
```

- **任何一类 GDI 对象都只占 1 个槽位**，`GetGuiResources` 数的就是槽位数；`CreateDIBSection` 最贵（4.9µs），是画笔的 4 倍——贵在建完后映射内存页，不在"对象"本身。
- 画刷和区域第一轮留下 **+10 / +8** 的残留，第二轮起就是 **0**。这是 GDI 的每类型空闲链，**不是泄漏**：判断标准是"同一操作多轮是否单调增长"，不是"有没有回到基线"（上一节同样吃过这个教训）。
- 8 类对象全程 **内核句柄 +0**，与上一节"1 万支画笔只涨 96 个句柄"一致：GDI 表和内核句柄表是两本账。

DC 本身也是 GDI 对象，这条最容易忘：

```text
基线 GDI=0
100 次 GetDC(NULL) 不释放：句柄各不相同（31016733 / 33012f76 / 20013062）→ GDI 0→100（净 +100）
补 100 次 ReleaseDC(NULL,·) 成功 100 个 → GDI=0
GetDC+ReleaseDC 一对：中位 19810 ns（8487–26828）
CreateCompatibleDC+DeleteDC 一对：中位 7763 ns（7274–18317）
```

**同一个窗口反复 `GetDC` 每次都给新句柄、新槽位**，不存在"一个窗口一个 DC"的复用；`GetDC`+`ReleaseDC` 比建一个内存 DC 还贵 2.6 倍，所以"每画一笔取一次 DC"是双重浪费。连续 `CreateCompatibleDC(NULL)` 到失败：**成功 9999 个，第 10000 次返回 NULL 且 `GetLastError()=0`**，此刻 `GDI=10000`、内核句柄只从 99 涨到 187——上一节的 USER/GDI 各 10000 的配额里，DC 和画笔画刷平起平坐。

## 二、我如何把自己的测量污染了两次

这两次都是真实事故，值得单独写成一节。

**事故一：把 DC 提前释放了。** `ReleaseDC` 的第一个形参是 `HWND`，第二个是 `HDC`。写反之后：

```text
ReleaseDC(把HDC当HWND, 同一个DC) 返回=1（成功！） GDI=2 lasterr=0
ReleaseDC(NULL, 桌面DC)          返回=1（成功！） GDI=1 lasterr=0
之后：GetDeviceCaps(hScr, 任何索引)=0  lasterr=0
      CreateCompatibleDC(hScr)=NULL  lasterr=87 "参数不正确。"
      再次 ReleaseDC(同一个已释放 DC) 返回=0 lasterr=0
```

`ReleaseDC` **不校验窗口句柄和 DC 是否配对**，参数写反照样返回 1 并真的归还槽位；槽位一还，句柄值就成了悬空指针，此后所有基于它的测量全部失败，而 `GetLastError()` 保持 0。我第一版探针的"屏幕 caps 全是 0"就是这么来的——不是系统没有 caps，是我的 DC 没了。同一份代码改成"退出前才释放"之后立刻拿到真值：

```text
HORZRES=1920 VERTRES=1080 BITSPIXEL=32 PLANES=1 LOGPIXELSX=96 LOGPIXELSY=96
NUMRESERVED=20 TECHNOLOGY=1(DT_RASTER) RASTERCAPS=32409(0x7E99) 置位: 0x1 0x8 0x10 0x80 0x200 0x400 0x800 0x1000 0x2000 0x4000
DESKTOPHORZRES=1920 DESKTOPVERTRES=1080 → HORZRES/DESKTOPHORZRES = 1.000（本机没被 DPI 虚拟化）
CreateCompatibleDC(屏幕DC) 继承: HORZRES=1920 BITSPIXEL=32 RASTERCAPS=0x7E99
```

顺带两条：`RASTERCAPS` 里 0x800(`RC_STRETCHBLT`) 是置位的；`NUMFONTS`、`TEXTMETRICS` 这类索引在现代驱动上一律返回 0，别拿它们判断 anything。另外 MinGW 的 `wingdi.h` 没有 `SIZEBOX(10)`/`CURSIZE(13)`/`VTECHNOLOGY(14)`/`XCURSIZE(15)`/`PENVERSION(17)`/`MAXCOLCOLOR(18)`/`BLITIMAGE`/`COLORTABLE` 这些宏（MSVC 有），只能自己写裸值——传裸值给 `GetDeviceCaps` 会返回 0 且 `lasterr=87`。

**事故二：把"循环里取 DC"当成了位图泄漏。** 有一版按类型统计槽位的探针报告：

```text
CreateCompatibleBitmap 建100个: GDI 19→219  删成功100 → 119  净残留 +100（三轮都是 +100）
```

看起来像"兼容位图每张占 2 个槽、`DeleteObject` 只还 1 个"。把 `GetDC(NULL)` 从构造函数里提到循环外，残留立刻归零：

```text
CreateCompatibleBitmap(屏幕DC) 建30个: 槽 2→32（每个 1.00 槽）删成功 30/30 → 2  净残留 +0
```

真相是每轮 100 次 `GetDC(NULL)` 没配对 `ReleaseDC`，漏的正是 100 个 **DC 槽位**。归因错误会让结论完全反过来（"用 DIBSection 别用兼容位图"），而它唯一的破绽就是"残留数恰好等于循环次数"。**每次只改一个变量，并且把嫌疑对象的创建/释放各打印一次计数**。

还有一个更隐蔽的：同一行 `printf` 里放两个 `ReleaseDC` 调用，打印出来是

```text
ReleaseDC(NULL,x) 返回=0（失败）  ReleaseDC(NULL,x) 返回=1（成功）
```

像是"第一次失败第二次成功"。C 语言的**求值顺序未定义**，这两个调用谁先执行编译器说了算。拆成两条语句后真相是 `1, 0`（第一次成功、重复释放失败且 `lasterr` 保持 0）。

## 三、像素层面：行序、通道序，以及"画到空气里"

`CreateDIBSection` 的 `biHeight` 正负决定内存行序，而 DC 坐标原点恒在左上：

```text
SetPixel(mdc,0,0, RGB(0x11,0x22,0x33)) 之后内存哪个索引变了：
  自上而下 biHeight<0 : 内存索引=0    → 行0 列0
  自下而上 biHeight>0 : 内存索引=4032 → 行63 列0     （高 64，差 63 行）
  内存头 4 字节 = 33 22 11 00 → 通道顺序是 B,G,R,A
  GetPixel(mU,0,0)=332211  GetPixel(mD,0,0)=332211（两种位图的 DC 坐标都是左上原点）
```

用负 `biHeight` 建位图，内存偏移就是 `y*stride+x`，直觉一致；用正 `biHeight`（GDI 位图的默认）而你以为 `bits[0]` 是左上角，整张图就是上下翻的。

15 个三元 raster op 逐像素验真（src=RGB(12,34,56)、dst=RGB(9A,BC,DE)、pat=RGB(0F,F0,55)）：

```text
SRCCOPY      rop=0x00CC0020  实测 R12 G34 B56  公式一致
NOTSRCCOPY   rop=0x00330008  R ED G CB B A9    ~s
SRCAND       rop=0x008800C6  R 12 G 34 B 56    s&d
SRCPAINT     rop=0x00EE0086  R 9A G BC B DE    s|d
SRCINVERT    rop=0x00660046  R 88 G 88 B 88    s^d
SRCERASE     rop=0x00440328  全 00             s&~d
MERGEPAINT   rop=0x00BB0226  全 FF             ~s|d
MERGECOPY    rop=0x00C000CA  R 02 G 30 B 54    s&p
NOTSRCERASE  rop=0x001100A6  R 65 G 43 B 21    ~(s|d)
DSTINVERT    rop=0x00550009  R 65 G 43 B 21    ~d
PATCOPY      rop=0x00F00021  R 0F G F0 B 55    p
PATINVERT    rop=0x005A0049  R 95 G 4C B 8B    p^d
PATPAINT     rop=0x00FB0A09  全 FF             p|~s|d
BLACKNESS    rop=0x00000042  全 00
WHITENESS    rop=0x00FF0062  全 FF
15 个 rop 全部与逐通道位运算公式一致
```

**别手写 `0x00FFFFFF` 这种"文档里的"编码**：`WHITENESS` 头文件里是 `0x00FF0062`、`BLACKNESS` 是 `0x00000042`、`PATINVERT` 是 `0x005A0049`——同一语义的低 16 位是常量输入的真值表，抄错就落到 `default` 分支。永远用宏。

图元单价（同一个内存 DC，5000 次/轮 × 3 轮取中位）：

| 操作 | 单价 | 对照 |
| --- | --- | --- |
| 直接写 DIB 内存 | **1.5 ns** | 基准 |
| `MoveToEx` | 10 ns | 只记录位置 |
| `PatBlt` 16×16 | 682 ns | |
| `SetPixel` | **581 ns** | 比直接写内存慢 **398 倍** |
| `FillRect` 32×32 | 1479 ns | |
| `GetPixel` | 2208 ns | 比 `SetPixel` 还贵 3.8 倍 |
| `Rectangle` 4×4（带画笔） | 2166 ns | |

`GdiFlush` 不是"憋到最后才干活"：3000 次 `SetPixel` 在调用期间就花掉 2.25ms（751ns/次），随后的 `GdiFlush` 只花 0.009ms。所以慢就是真的慢，别指望 flush 帮你省。

最阴的一条——内存 DC 的默认位图**拿不到句柄**，而清空它之后绘图"全部成功"：

```text
新内存 DC：SelectObject(mdc,NULL) 返回=0  GetObjectType(0)=0  GetObject 写入=0
清空位图后 Rectangle(mdc,...) 返回=1  BitBlt(mdc 作目的) 返回=1  lasterr=6
  （返回值说成功，像素一个都没写）
GetDeviceCaps(内存DC,HORZRES)=1920 VERTRES=1080  ← 即使当前选入的是 200x150 位图
```

两条纪律：**判断缓冲区尺寸用 `GetObject` 拿 `bmWidth/bmHeight/bmWidthBytes`，不要用 `GetDeviceCaps`**（它报的是创建 DC 时继承的设备，不是当前位图）；**别为了"恢复现场"把 `NULL` 选进内存 DC**，要保存并选回原来那个对象，而且新 DC 的 `SelectObject(hdc,NULL)` 返回 0，说明默认位图的句柄从一开始就取不到。

## 四、拷进与合成：谁在花钱

`BitBlt` 满幅与 `memcpy` 同字节数（1920×1080×4=7.9MB，30 次/轮 × 5 轮）：

| 操作 | 中位 | 区间 | 等效带宽 |
| --- | --- | --- | --- |
| `BitBlt` SRCCOPY 内存 DC→内存 DC | 1.099 ms | 1.049–1.228 | **7.55 GB/s** |
| `memcpy` 7.9MB | 0.909 ms | 0.734–1.130 | 8.4–11.3 GB/s |
| `AlphaBlend` 满幅（A=255+逐像素） | 7.48 ms | 6.71–11.19 | 1.11 GB/s |

`BitBlt` 的开销只有 `memcpy` 的 1.2 倍，全幅拷贝基本贴着内存带宽；而 `AlphaBlend` 贵 **6.8 倍**——逐像素混合是逐像素乘法，不是拷贝。**能用 `BitBlt` 就别用 `AlphaBlend`**。

`StretchBlt` 8 倍降采样（1920×1080→240×135，源图含 1px 白竖线、2px 线、50% 棋盘、纯 128 灰块）：

| SetStretchBltMode | 中位耗时 | 1px 线存活 | 2px 线存活 | 128 灰块出现的灰阶数 |
| --- | --- | --- | --- | --- |
| BLACKBOX(AND 扫描) | 2.80 ms | **0/135** | 0/135 | 2（128×121, 0×48） |
| WHITEBOX(OR 扫描) | 2.09 ms | 135/135 | 135/135 | **1**（只有 128） |
| COLORONCOLOR(最近邻) | **0.03 ms** | 0/135 | 0/135 | 2（128×144, 0×25） |
| HALFTONE(抖动) | 6.20 ms | 135/135 | 135/135 | **9**（128×100, 144×21, 64×20…） |

- **207 倍**的耗时差，而且是语义差不是实现差：`COLORONCOLOR` 只读被命中的那一个源像素（成本 ~O(目标面积)），`HALFTONE` 要扫完全部源像素再抖动（~O(源面积)）。
- 降采样时 `BLACKBOX` 会**把 1px 和 2px 的线整个吃掉**（0/135），`WHITEBOX` 全留住但会把灰块里多余的值"或"成不变——所以图标缩放要细线不消失得用 `HALFTONE`，代价是它给**纯色区域造出 9 种灰阶**（128 的平面上出现 144 和 64），这是抖动的固有噪声，不是 bug。

`AlphaBlend` 的混合公式：src=(R200,G0,B0,A=pa)、dst=(R0,G100,B200,A=0)，5×5 全组合实测：

```text
      ca=    0     64    128    192    255      （格内 = 实测R 实测G 实测A）
  pa=  0    0100  0   0100  0   0100  0   0100  0   0100  0      ← 整像素跳过
  pa= 64     ⋯    50 94 16   100 87 32   151 81 48   200 75 64
  pa=128     ⋯    50 87 32   100 75 64   151 62 96   200 50128
  pa=255     ⋯    50 75 64   100 50128   151 25192   200  0255
```

25 组全部落在同一个整数模型上（`f = round(pa*ca/255)`，通道四舍五入到 8 位）：

```text
A_out = round(pa*ca/255)
R_out = round(src*ca/255) + round(dst*(255-f)/255)     ← 注意 src 那一侧只乘 ca，不乘 pa！
pa=0  → 整个像素被跳过（实测 5 列全是原 dst）
```

**GDI 的 `AlphaBlend` 要求预乘 alpha。** 拿"颜色完整 + alpha 另存"的非预乘数据（GDI 自己画出来的 32bpp 位图就是这个形状：alpha 字节恒为 0）直接喂进去，会有两个后果：`pa=0` 时**图像完全消失**；`pa=128` 时颜色项**按不透明算**（实测 R=200→200 而不是 100），边缘发白。上一节说过 GDI 画不出 alpha，这节就是它的代价。`TransparentBlt` 则根本不看 alpha，只按色键精确匹配：

```text
键=RGB(FF,00,FF)，dst 预涂 0x11：
  BGR(FF,00,FF) A=FF → 未写入（被键掉）      BGR(FE,00,FF) A=FF → 已写入   ← 差 1 就不算
  BGR(10,20,30) A=00 → 已写入                BGR(FF,00,FF) A=00 → 未写入（被键掉）
```

色键是**逐通道精确相等**，半透明像素照原样贴上去。抗锯齿边缘用色键一定会留一圈边。

## 五、双缓冲省的不是"画的次数"，是"画在窗口 DC 上"

同一份绘图代码（每帧 120 个矩形，客户区 320×200），两个窗口：A 的窗口类有背景刷、直接画窗口 DC；B 的类背景刷为 `NULL`、画进 `CreateDIBSection` 缓冲区再一次 `BitBlt`。60 帧 × 5 轮：

| 指标 | A 直接绘制 | B 双缓冲 | 比 |
| --- | --- | --- | --- |
| 每帧中位 | **2.110 ms**（1.919–2.169） | **0.293 ms**（0.230–0.293） | 7.2 倍 |
| WM_PAINT / WM_ERASEBKGND | 60 / 60 | 60 / 60 | — |
| WM_ERASEBKGND 累计 | 1.91 ms（0.032/帧） | 0.26 ms（0.004/帧） | 7.3 倍 |
| `BeginPaint` 的 `ps.fErase=1` | **0 次** | **60 次** | 反的 |
| 写到窗口 DC 的图元 | 7200 个（120/帧） | **60 个**（1 次 BitBlt/帧） | 120 倍 |
| 最长"背景已擦、内容未画" | **2.951 ms** | 0.752 ms | 3.9 倍 |
| `rcPaint` | (0,0)-(320,200) | (0,0)-(320,200) | — |

单位成本的差别才是一切的来源（同一个 `Rectangle`，1000 次/轮 × 4 轮）：

```text
轮1 窗口 DC 16866 ns/个   内存 DC 1216 ns/个   比值 13.9 倍
轮2 窗口 DC 17197 ns/个   内存 DC 1384 ns/个   比值 12.4 倍
轮3 窗口 DC 14536 ns/个   内存 DC 1795 ns/个   比值  8.1 倍
轮4 窗口 DC 16196 ns/个   内存 DC 1320 ns/个   比值 12.3 倍
整块 BitBlt 缓冲→窗口 320x200（0.24MB）：53.2 µs/次
只拷 1/16 面积：15.5 µs/次（面积 6.25%，耗时 29%）
```

**画在窗口 DC 上每个图元贵 8–14 倍**：每次都要经过 win32k 的重定向表面，而内存 DC 就在本进程地址里。双缓冲的收益不是"少画了几个图元"（一个都没少），而是把 120 次昂贵调用换成 120 次便宜调用 + 1 次 `BitBlt`。`WM_ERASEBKGND` 两次都收到 60 次，但 A 花 32µs/帧（`DefWindowProc` 真的填了一遍背景），B 只花 4µs/帧（类没有背景刷，`DefWindowProc` 直接返回）——**双缓冲必须把窗口类的 `hbrBackground` 设为 NULL**，否则白擦一遍。`ps.fErase` 的读数刚好相反（有背景刷的 0 次、无背景刷的 60 次），它是"这次 `BeginPaint` 有没有替你擦过"的标记，**不能用它判断要不要擦**。

无效区的合并与撤销（全实测）：

```text
40 个小块 InvalidateRect(FALSE) + 1 次 UpdateWindow → WM_PAINT=1 次 rcPaint=(0,0)-(303,184)（并集）
同样 40 次但自己 PeekMessage 取 → 取出 4 条消息，WM_PAINT 回调 1 次
InvalidateRect(NULL,TRUE) 后紧跟 ValidateRect(NULL) → WM_PAINT=0（无效区被撤销，一次都不画）
bErase=TRUE → WM_ERASEBKGND=1，bErase=FALSE → WM_ERASEBKGND=0（类里有背景刷也一样）
两次分离的小无效区 + 各一次 UpdateWindow → WM_PAINT=2 次（合并只发生在同一次 UpdateWindow 之前）
窗口在 -32000（屏幕外）→ rcPaint=(0,0)-(0,0)，WM_ERASEBKGND=0：整个客户区被裁掉，画了等于没画
```

最后一条是我第二版探针的坑：**把"不挡用户视线"理解成"扔到屏幕外"**，结果 `BeginPaint` 给的是空矩形，闪烁对比全部失真（第一版测出"双缓冲 32ms/帧"这种荒谬数字）。窗口必须留在屏幕内，测量才有意义。

 paint 里只建不删的后果（把窗口 DC 拿到手，循环建画笔不删）：

```text
建成画笔=9987 支（GDI 计数=10000）用时 808.1 ms  CreatePen 失败时 lasterr=0
此刻 Rectangle 返回=1（还在画，用的是上一次成功选中的画笔）
连画线都成功：MoveToEx=1 LineTo=1 lasterr=0
删除全部后 GDI=14 → 再建一支画笔立刻成功
DeleteObject(正被自己线程 DC 选中的画笔/位图) 返回=1（文档说不允许）
DeleteObject(stock WHITE_BRUSH) 返回=1 lasterr=6，之后用它 FillRect 仍返回=1
```

GDI 耗尽**不崩不报错**：`CreatePen` 返回 NULL 而 `lasterr=0`，后续绘制继续"成功"，只是用着别人留下的旧对象——画面变成"颜色不更新"这种最难查的症状。stock 对象删了没死（返回 1 但 lasterr=6），别把 `DeleteObject` 的返回值当"确实释放"的证据。

## 六、分层窗口：两种玩法，别混用

`SetLayeredWindowAttributes`（整窗一个 alpha/一个色键）与 `UpdateLayeredWindow`（逐像素 alpha 位图）实测：

```text
SetLayeredWindowAttributes(LWA_ALPHA) 中位 678.0 µs/次（654–1176）→ 只是个属性设置
UpdateLayeredWindow（源 ARGB 位图，5 次中位）：
    160x100  （0.06 MB）0.201 ms → 等效 0.32 GB/s
    320x200  （0.24 MB）0.136 ms → 等效 1.88 GB/s
    800x600  （1.83 MB）0.692 ms → 等效 2.78 GB/s
   1920x1080 （7.91 MB）1.490 ms → 等效 5.57 GB/s
   调用期间 GDI 72→72，连做 50 次后 72→72（不随调用增长）；DestroyWindow 后 70
   ULW 会改写窗口矩形：320x200@(680,0) 传 1920x1080 → 变成 1920x1080@(680,0)
   位图自上而下(biHeight<0) / 自下而上(>0) 都返回 TRUE；hdcDst 传 GetWindowDC 或 NULL 都 TRUE
   源用 CreateCompatibleBitmap（非 DIBSection）也返回 TRUE
   屏幕外 ptDst=(-32000,-32000)、SW_HIDE 的窗口、最小化的 WS_OVERLAPPED 窗口：全部 TRUE
非分层窗口：UpdateLayeredWindow 返回=FALSE lasterr=87
           SetLayeredWindowAttributes 返回=FALSE lasterr=87，且不会自动加上 WS_EX_LAYERED
GetWindowLongW 读回 GWL_EXSTYLE=0x80100（含 WS_EX_LAYERED=0x80000）
SetLayeredWindowAttributes(alpha 形参传 300) 返回=TRUE → 读回 alpha=44（300 被 BYTE 截断，不校验）
```

最值钱的一条是**两者的状态冲突**。同一个分层窗口按顺序做：

```text
刚建成（纯净的分层窗口）        ULW 返回=TRUE  lasterr=0
SLWA(RGB(FF,00,FF),128,LWA_ALPHA|LWA_COLORKEY) 返回=TRUE lasterr=0 读回 alpha=128 flags=0x0
属性=A|KEY 之后                 ULW 返回=FALSE lasterr=87
SLWA(0,0,flags=0) 返回=TRUE     ULW 返回=FALSE lasterr=87
恢复：摘掉再挂回 WS_EX_LAYERED  ULW 返回=TRUE  lasterr=0     ← 唯一有效的恢复
恢复：SLWA(A=255,LWA_ALPHA)     ULW 返回=FALSE lasterr=87    ← 反而又坏了
恢复：SLWA(键=0,LWA_COLORKEY)   ULW 返回=FALSE lasterr=87
```

**`UpdateLayeredWindow` 一旦成功，再调 `SetLayeredWindowAttributes` 就会把窗口锁进"属性模式"，此后所有 `ULW` 报 87**，而 `SLWA` 自己一直返回 TRUE。更要命的是 `GetLayeredWindowAttributes` 在 `SLWA(A|KEY)` 之后读回 `flags=0x0`（另一个窗口上纯 `SLWA` 序列读回的是 `0x3`/`0x2`/`0x1`）——查询接口都说不清当前状态。规矩：**一个窗口只用一种分层方式**，切换必须摘掉 `WS_EX_LAYERED` 再挂回去（等价于重建分层状态）。我第一版探针里那 4 个尺寸全部 `ULW` 报 87，一开始怀疑屏幕外坐标、怀疑 `biHeight` 符号，实测都不是——就是前面顺手调了一次 `SetLayeredWindowAttributes`。**"失败原因不在参数里"的情况，先把上一个成功调用之后所有对同一对象的写操作列出来。**

## 小结

- **GDI 对象和 DC 共用一本 10000 槽位的账**：8 类对象实测每个占 1.00 槽，删干净后除画刷 +10/区域 +8（一次性内部缓存，第二轮起为 0）外无残留；`CreateCompatibleDC` 连开 9999 个后第 10000 次返回 NULL 且 `lasterr=0`；全程内核句柄不涨——三本账要分开盯。
- **句柄纪律是这节的全部教训**：`ReleaseDC` 参数写反照样返回 1 并真的释放（之后 `GetDeviceCaps` 静默返 0、`CreateCompatibleDC` 报 87）；重复释放返回 0 但不设 `lasterr`；`GetLastError` 在连续成功调用后仍保留旧值（实测残留 2）；`GetDC` 写在循环里漏 100 次就是 100 个槽位，我把它误判成"兼容位图占 2 槽"。规则：**DC/句柄取一次、用到最后、每步打印返回值、同一行不要放两个有副作用的调用**。
- **像素层**：`biHeight` 正负=内存行序（DC 恒左上），通道是 B,G,R,A；15 个 rop 与逐通道公式全对得上，但头文件编码与直觉不同（`WHITENESS=0x00FF0062`），只用宏；`SetPixel` 581ns vs 直接写内存 1.5ns（398 倍）；内存 DC 的 `GetDeviceCaps` 不随选入位图变，判断尺寸要用 `GetObject`；把位图选成 `NULL` 之后所有绘图调用返回 TRUE 而像素不动。
- **合成**：`BitBlt` 7.55GB/s 贴着内存带宽，`AlphaBlend` 慢 6.8 倍；`StretchBlt` 里 `COLORONCOLOR` 比 `HALFTONE` 快 **207 倍**，而 8 倍降采样时只有 `WHITEBOX`/`HALFTONE` 留住 1px 细线，`HALFTONE` 会给纯色面注入 9 种灰阶。`AlphaBlend` 实测公式是"源颜色只乘 `SourceConstantAlpha`、不乘逐像素 alpha"——**必须喂预乘数据**，`pa=0` 整像素消失；`TransparentBlt` 只做逐通道精确色键，完全无视 alpha。
- **双缓冲**：一帧 2.110ms→0.293ms（7.2 倍），根因是同一个 `Rectangle` 在窗口 DC 上 14.5–17.2µs、在内存 DC 上 1.2–1.8µs（**8–14 倍**）；窗口类背景刷要设 `NULL`（否则每帧白擦 32µs）；`ps.fErase` 不能用来判断该不该擦；无效区只在同一次 `UpdateWindow` 之前合并（40 块→1 次 `WM_PAINT`，`ValidateRect` 可撤销）；窗口在屏幕外时 `rcPaint` 是空矩形，画了等于没画。
- **分层窗口**：`SLWA` 678µs 是属性设置，`ULW` 满幅 1.49ms（5.57GB/s 等效带宽）且会顺手改掉窗口矩形；不随调用泄漏 GDI 对象。**`ULW` 成功后调 `SLWA` 会让 `ULW` 永久报 87**，`SLWA` 一路返回 TRUE，`GetLayeredWindowAttributes` 连 `flags` 都读不准，唯一恢复是摘掉再挂回 `WS_EX_LAYERED`。alpha 传 300 被静默截断成 44。
- **本机未实测**：分层窗口合成后屏幕上的真实像素（需要截屏，本轮约定不截图），只验证了返回值、窗口矩形变化、耗时与源位图内容；关闭 DWM 合成（`DwmIsCompositionEnabled=FALSE`）时双缓冲的收益差异——不允许改系统设置，未测；`CreatePatternBrush`/调色板动画路径未测。
