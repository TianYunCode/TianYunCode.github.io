---
title: 对话框与公共控件
description: >-
  实测：模态循环派发的是整条线程的消息——进模态前投给 owner 的 WM_USER+7 被对话框循环取走，
  嵌套第二层模态里第一层的 WM_TIMER 照样 3→4→5→6 跳；对话框基线是 7×15 而 GetDialogBaseUnits 报 8×16；
  回车属于 DM_GETDEFID 而不是焦点控件，两个 DEFPUSHBUTTON 时后写的赢且把前者的样式位清零；
  ListView 插 2000 行开重绘 597.5 ms、关掉 74.5 ms（8.02 倍），虚拟模式 100 万行只要 3.4 ms 和 32 KB；
  钩子吞掉 WM_LBUTTONDOWN 后父窗口 WM_COMMAND 从 1 变 0，BM_CLICK 也被同一把钩子拦下；
  对话框过程里 return DefDlgProcW(...) 是无限递归，进程连错误码都来不及打印就没了。
date: 2026-10-16
tags: ["Windows", "对话框", "公共控件", "ListView", "子类化"]
category: win32
section: win-dialog-control
---

> 环境：Windows 11 x64（26200），**GCC 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin`）**；
> `windres --include-dir . e.rc e_res.o` + `gcc -std=gnu11 -O2 -w e5.c e_res.o -o e5.exe -luser32 -lgdi32 -lcomctl32`。
> 探针在 `C:/Users/wangt/AppData/Local/Temp/agents/win32e/`（`e2/e3/e4/e5/e7/e8`）；上一棒 `agents/win32d/` 的
> `d1.out d2v5.out d2v6b.out d3.out d1t2.out` 里可复核的数字均标出处。**全程无截图**：证据只有几何（`GetWindowRect`/`MapDialogRect`）、
> 状态位（`IsWindowEnabled`/`GetActiveWindow`/`GetFocus`）、消息计数、返回值、`GetLastError` 文本、句柄与私有内存字节。
> 窗口默认开在屏外（`-32000`），只有需要真重绘的控件实验把父体放进 `(60,60)` 且**不激活**；会卡住的模态用看门狗父进程取证。

## 一、对话框模板：windres 写的字段位置和文档不一样

`sizeof(DLGTEMPLATE)=18`、`sizeof(DLGITEMTEMPLATE)=18`。为了定位字段，我编了一个每格都取互异值的"标记"对话框
（`101 DIALOGEX 111,222,333,444`，2 个控件，id=77/88），把 140 字节的资源原文摊开：

```text
0:0001 2:FFFF 4:0000 6:0000 8:0000 10:0000 12:00C0 14:50C0
16:0002 18:006F 20:00DE 22:014D 24:01BC 26:0000 28:0000
30:004D(M) 32:004B(K) 34:0031 36:0030 38:0031 40:0000 42:0009 44:0000 46:0100 48:0053(S)…
76:0000 78:5001 → style=0x50010000 | 80:000B 82:000C 84:0033 86:000D → x,y,cx,cy=11,12,51,13
88:004D → id=77 | 90:0000 92:FFFF 94:0080 → 类=预定义原子 BUTTON | 96..102 → "AAA"+null
```

对上号之后：DIALOGEX 头是 `dlgVer=1`、`0xFFFF`、`helpTopic`、**`exStyle`**、`style`、`cdit`、`x,y,cx,cy` 共 30 字节
（`exStyle` 在 `style` **前面**：#102 的 `EXSTYLE 1` 落在偏移 8、`STYLE 0x90C000C0` 落在 12，两个值互异不会认错）；标题/字体名/控件文本全是
**裸的 null 结尾 WCHAR 串**，没有文档说的 `0xFFFF` 标记也没有长度前缀；项的顺序是 `style(4),x,y,cx,cy,id(2)`——**id 在几何之后**，
且没有 32 位 `dwExtendedStyle` 的位置；字号后面还跟着两个来路不明的 WORD `0x0000 0x0100`。后果：**同一批字节，资源路径和内存路径的解析码路不是一套**。

```text
#101 资源字节→内存 API  失败 lasterr=1406 "无法创建最上层子窗口。"（WS_CHILD 是我写在 STYLE 里的，RC 照搬不换）
CreateDialogParamW(102) → hwnd=04c91bec 子=5 类="#32770" 可见=1（模板带 WS_VISIBLE，没 ShowWindow 就可见）
CreateDialogParamW(105) → 子=7      CreateDialogParamW(107) → 子=2
```

**手搓内存模板在本机没跑通**，这是本节唯一的负面结论：上一棒 `d1t.exe` 按文档顺序试了 8 个变体，`d1t2.out` 里
**7 个 `lasterr=1812`、1 个 `1407`**；我按观察到的 windres 排布（`x,y,cx,cy,id` + 裸串）又组了 8 个组合（`e3.c`），
第一个变体在 `CreateDialogIndirectParamW` 里面**直接把进程搞崩**（无返回值、无错误码），其余没跑到。
正路只有两条：对话框放进 `.rc`（第 3 节），或动态生成控件时老实用 `CreateWindowExW`。

更狠的坑是我自己踩的（崩了两轮才定位）：对话框过程里按窗口过程的习惯写 `return DefDlgProcW(h,m,w,l);` → **无限递归、栈溢出、静默死亡**，
现场不留任何错误码。上一棒的 `d1r.out`、`d1t.out`、`d1t2.out` 也全停在半路（同一批里的 `d1.out` 却有 `done`），很可能是同一条，但那是他们的探针，我不替他们定罪。

```text
CreateDialogParamW(102) 之前 → rc=127（崩，什么都没打印出来）
改成 return (INT_PTR)FALSE; → WM_INITDIALOG 到了 / hwnd=04c91bec lasterr=2 子=5
```

`lasterr=2` 是**成功之后**的残留值：返回值判空、`GetLastError` 另说，第 1 节的规矩在这里同样成立。

## 二、DLU 换算：本机是 7×15，而 `GetDialogBaseUnits` 报 8×16

模板 `DIALOGEX 0,0,160,90`、按钮 `7,7,50,14`，同一份模板建真窗口量到：

```text
GetDialogBaseUnits()=0x00100008 → X=8 Y=16
lfMessageFont="Microsoft YaHei UI" lfHeight=-12 tmHeight=17 tmAveCharWidth=6 "0"×10 宽=70 → 7
对话框自己的字体（WM_GETFONT）="Segoe UI" lfHeight=-12 tmHeight=15 数字平均宽=6
MapDialogRect(160,90)=(280,169) (100,100)=(175,188) (50,14)=(88,26) (4,8)=(7,15) (1,1)=(2,2) (8,8)=(14,15)
控件实际位置（客户区）：id=101 DLU(7,7)尺寸(50,14) → 像素(12,13)尺寸(88,26)；id=201 Edit DLU(7,27)(146,13) → (12,51)(256,24)
```

解方程：`160→280`、`100→175`、`50→88`、`4→7`、`1→2`、`8→14` 全部等于 `MulDiv(dluX,7,4)`；`90→169`、`14→26`、`8→15` 全部等于 `MulDiv(dluY,15,8)`。
**本机基线是 X=7、Y=15**（Y=15 正是对话框字体 Segoe UI 9pt 的 `tmHeight`），而按 `GetDialogBaseUnits` 的 8×16 算 160×90 得 **320×180**，差 40×11 像素。
结论：**换算必须走 `MapDialogRect(hDlg,…)`**（它用对话框自己的字体），`GetDialogBaseUnits` 只能用来解释"老程序在中文系统上偏大"。
X=7 具体取自字体度量的哪个字段我没对上号（数字宽 6、`tmAveCharWidth` 6 都不是 7），列进第八节。

## 三、comctl32 的两副面孔：同一个类名，v5 与 v6 差一批 API

同一份源码，`.rc` 里有没有 Common-Controls 6.0 依赖，拿到的是两个 DLL（出处：`d2v5.out` / `d2v6b.out`）：

```text
v5 …WinSxS\amd64_microsoft.windows.common-controls_…_5.82.26100.8328_…\COMCTL32.dll  DllGetVersion → 5.82.10586
   SetWindowSub=0  RemoveWindowSub=0  TaskDialog=0  TaskDialogIndirect=0  DefSubclassProc=有
   InitCommonControlsEx(ICC_STANDARD_CLASSES=0x4000) 返回=0
v6 …common-controls_…_6.0.26100.9278_…\COMCTL32.dll                                  DllGetVersion → 6.16.10586
   SetWindowSub=00007ffa1147bf40  TaskDialog=00007ffa11583930  InitCommonControlsEx(ICC_STANDARD_CLASSES) 返回=1
```

本轮（不带 manifest）复现到的同类事实：`InitCommonControlsEx(ICC_LISTVIEW|ICC_TREEVIEW|ICC_STANDARD|ICC_BAR)` **返回 0**，只给
`ICC_LISTVIEW_CLASSES` 时返回 1（0.024 ms）；但**返回 0 不代表类没注册**——同一进程里 `SysListView32`、`SysTreeView32`、`#32770`、`BUTTON`、
`EDIT`、`STATIC` 在调用之前就全部可见（`d1.out` 的 `[before ICC] 1 1 1 …`），因为 exe 链了 `-lcomctl32`，DLL 自己注册过了：能不能用只看
`CreateWindowExW` 的返回值。MinGW `commctrl.h` 里**没有** `SetWindowSub`/`RemoveWindowSub` 原型（只有老名字 `SetWindowSubclass`），也**没有**
`LB_ADDSTRINGW`/`LB_GETTEXTW`——列表框文本消息没有 W 版，我按直觉写 `LB_ADDSTRING(…,L"项目")`，控件按字节存了 UTF-16 原始字节，读回
`LB_GETTEXTLEN=8`、文本乱码（第六节）。这些属于第 8 节"头文件与声明缺失"的常态。

## 四、模态循环是"线程级"的：它替整条线程派发消息

`e4.exe`：屏外可见 owner + 见证窗口，`DialogBoxParamW(102, owner, …)`，对话框 `WM_INITDIALOG` 里开 50 ms 定时器：

```text
进模态前投给 owner 的 3 条 WM_USER+7，外层自己取走（owner 计数=0）
[owner] WM_ENABLE wParam=0（tick=0）              ← 对话框还没 INIT，owner 先被禁用
WM_INITDIALOG：GetActiveWindow=0 焦点=0(id=-1) IsWindowEnabled(owner)=0
[owner] 取到外层投的 WM_USER+7 —— 派发它的是模态循环，tick=1      ★
tick1：IsWindowEnabled(owner)=0  GetActiveWindow 是对话框=1  焦点控件 id=101
tick1：嵌套 PeekMessage 抢走 2 条；witness SendMessage 到达=1 PostMessage 被派发=1
返回=262 用时 391.3 ms INIT=1 tick=6 owner: WM_ENABLE=2 WM_ACTIVATE=1 WM_PAINT=0
出模态后：IsWindowEnabled(owner)=1  旧对话框句柄 IsWindowEnabled=0  队列残留=1 条
```

`★` 是全部要点：**模态只挡输入，不挡消息**。`DialogBoxParamW` 内层是线程范围的 `GetMessage` 循环，本线程任何窗口收到的消息
都由它派发；外层"看起来卡住"，但它的 WndProc 一直在跑；owner 进出各一次 `WM_ENABLE`。真·嵌套
（在模态对话框的 `WM_TIMER` 里再开一个 `DialogBoxParamW`，内层也开定时器并在回调里跑自己的 `PeekMessage` 循环）：

```text
[dlg2] 第1 拍：我的嵌套循环派发了 1 条；期间第一层 tick 3→4；IsWindowEnabled(dlg1)=0
[dlg2] 第2 拍：派发 1 条；第一层 tick 4→5
[owner] WM_ENABLE wParam=1（此刻 tick=6）        ← 最内层还没退出，owner 就已经被恢复
[dlg2] 第3 拍：派发 2 条；第一层 tick 5→6
tick3：第二层 DialogBoxParamW 返回=518（第二层跑了 3 拍；返回时第一层 tick=6）
```

三件事：**内层模态期间外层定时器照跳**（tick 3→6，那些 `WM_TIMER` 是最内层循环派的）；**嵌套会把 owner 提前恢复使能**（对话框退出时恢复自己的 owner，
不是整条链结束时）；**每拍内层循环"抢走"1–2 条消息，外层永远看不到**。win32d 的 `d2v5.out` 同机同构（模态期间同步 SendMessage 到达 6 条、PostMessage 被 pump 掉
8 条、出模态后外层还能捞到 1 条）——任何 `processEvents` 一类的嵌套泵都是这个机制。

看门狗取证（父进程起两种子模式，各 2 秒后采一次 CPU 差值）：

```text
[hang] 2 秒后 WaitForSingleObject=WAIT_TIMEOUT 退出码=259(STILL_ACTIVE) 线程 CPU 1 秒内 +0.0 ms
       FindWindow(#32770,"探针 DIALOGEX")=0000000000df0ba6 IsWindowEnabled=1 SendMessageTimeout(WM_NULL,500ms)=1
       发 WM_CLOSE 之后：退出码=99（我那句"不该走到这里"）Wait=已退出
[spin] 2 秒后 WAIT_TIMEOUT 退出码=259 线程 CPU 1 秒内 +984.0 ms
       child spin: PeekMessage 空转 3 秒 共取 0 条 线程 CPU 用了 2984.4 ms
```

**"界面没响应"要先分清是哪种**：卡在模态等待的线程 1 秒 CPU 差值 `+0.0 ms`（睡在 `GetMessage` 里），空转 `PeekMessage` 的循环
1 秒吃 `+984.0 ms`（约 99.5% 一个核）；而前者**仍然能接跨线程消息**（`SendMessageTimeout` 返回 1，`WM_CLOSE` 走 `EndDialog` 正常退出）。
判断卡死不能只看 CPU，要看 `SendMessageTimeout` 有没有回音；CPU 满格的循环反而可能一直在派发消息。

## 五、默认按钮与回车归属：认 `DM_GETDEFID`，不认焦点

实测宏值：`DM_GETDEFID=WM_USER+0=0x0400`、`DM_SETDEFID=0x0401`、`DC_HASDEFID=0x534B`、`ES_WANTRETURN=0x1000`、`WS_TABSTOP=0x10000`。
模板 #105（甲=DEFPUSHBUTTON id=101）建好后 `DM_GETDEFID=0x534B0065` → **id=101**：

```text
id=101 STYLE=0x50010001 默认位=1 TABSTOP=1 GROUP=0      id=104 STYLE=0x50030000 默认位=0 TABSTOP=1 GROUP=1
id=102/103 STYLE=0x50010000 默认位=0 TABSTOP=1          id=201 Edit TABSTOP=1   id=202 Static STYLE=0x50000100 TABSTOP=0
```

104 那行值得记：`.rc` 里我只给 `BS_TEXT|WS_GROUP`，**`WS_TABSTOP` 仍被 RC 加上**——想踢出 Tab 链必须显式去掉，"不写"没用。

```text
a) 焦点=edit，VK_RETURN 的 keydown+keyup 投给对话框 → IsDialogMessage 吃掉 4/4，WM_COMMAND: id=201×1（EN_*）id=101×1
b) 焦点=按钮 103（非默认）→ WM_COMMAND: id=201×1 id=101×1        ← 回车不看焦点在谁身上
c) 直接把 VK_RETURN 发给 edit → edit 收到 WM_KEYDOWN=0（被 IsDialogMessage 吞）WM_CHAR(0x0D)=2，WM_COMMAND: id=101×1
#106（两个都写 BS_DEFPUSHBUTTON）：101 BS=0x00 102 BS=0x01  DM_GETDEFID=0x534B0066 → id=102  回车 → id=102×1
DM_SETDEFID(103)：返回旧值=1；之后 DM_GETDEFID=0x534B0067；回车 → id=103×1；样式位 101=0 103=1
```

三条反直觉：**后写的 `DEFPUSHBUTTON` 赢，而且系统会把前一个的样式位清零**；**`DM_SETDEFID` 连 `BS_DEFPUSHBUTTON` 一起搬**（我原本注释说"外观不变"，
被自己的输出推翻——粗边框跟着 DEFID 走，所以"按输入内容切换默认按钮"的视觉提示可信）；**`DM_SETDEFID` 返回的旧值是 1（`IDOK`），不是刚才读到的 101**
（`d2v5.out` 同样是"旧=0x00000001"，不是偶发）。

`ES_WANTRETURN` 对照组证明 `IsDialogMessage` 判断的是**消息的 hwnd**：

```text
#107 edit STYLE=0x50011044（ES_MULTILINE|ES_WANTRETURN|ES_AUTOVSCROLL）
  keydown+WM_CHAR(0x0D)+keyup 投给 edit，3 次 → EM_GETLINECOUNT=10 光标行=9  WM_COMMAND: id=201×24，没有 101
  摘掉 ES_WANTRETURN 后再投 2 次给 edit → WM_COMMAND: id=101×2（回到默认按钮）
  对比：同样 3 次回车投给"对话框"时，即使 ES_WANTRETURN=1，默认按钮照样收到 3 次点击
```

**真键盘消息一定带焦点控件的 hwnd**；合成按键投给对话框就会得出完全相反的结论。其余归属实验：

```text
Esc（投给对话框）→ WM_COMMAND id=2（IDCANCEL）×1，非模态对话框不自杀（IsWindow 仍=1）
BM_CLICK(按钮 103) → WM_COMMAND: id=201×1 id=103×1   BM_CLICK(静态 202,SS_NOTIFY) → 无   BM_CLICK(edit 201) → 无
普通窗口(E5Plain，子 EDIT+BUTTON) 上 IsDialogMessage(VK_TAB)=1 但焦点没动；VK_RETURN=1 但父窗口没收到 WM_COMMAND
```

最后一条很阴：`IsDialogMessage` **吞掉按键（返回 1）却什么都不做**——那个窗口不是 `#32770`、也没有内部焦点记录，用它就是"键盘失灵"。
**Tab 走查我没测出可信结果**：即使 `ShowWindow`+`SetActiveWindow`（`GetActiveWindow` 确实等于对话框），`SetFocus(edit)` 后连发 9 次 `VK_TAB`，焦点每次都停在 **101**；
而 `d2v5.out` 在同机、同为"非模态 + 手工 `IsDialogMessage`"下量到完整循环（`201→101→102→103→201→…`）。
差异应在"对话框内部记录的当前焦点控件"有没有被真实焦点链更新，我没能复现——**验 Tab 顺序必须用真实键盘**。

## 六、ListView / LISTBOX 自绘 / TreeView：只画可见行，虚拟模式近乎免费

`SysListView32 LVS_REPORT`（父窗体放进屏幕内：屏外不重绘、成本假小，`d3.out` 的 4.99 倍就是屏外条件）：

```text
LVM_INSERTCOLUMN=1.196 ms   重绘开着 2000 行=597.5 ms（298.74 us/行）  WM_SETREDRAW(FALSE) 期间=74.5 ms（37.24 us/行）
恢复重绘+整控件刷新=2.8 ms → 真实比值 597.5/74.5=8.02（我的探针把比值打印成 26.93，分母选错）
LVM_SORTITEMS 4000 行：比较 23728 次 0.3 ms（13 ns/次；n·log2n≈47800，实测只有一半）
LVM_GETITEMTEXTW 2000 次=0.22 ms（108 ns/次）  LVM_DELETEALLITEMS=3.12 ms  句柄 169→178 私有内存 1560→2256→(删空)1756 KB
整控件重绘一次：WM_NOTIFY=8 NM_CUSTOMDRAW=8 阶段 PREPAINT=1 ITEMPREPAINT=7 SUBITEM=0 其它=0
加 LVS_EX_FULLROWSELECT 重绘：NM_CUSTOMDRAW=8 ITEMPRE=7 SUB=0   LVM_SETITEMSTATE 选中→WM_NOTIFY=2
```

**批量灌数据先关重绘省 523 ms**（代价是之后必须自己 `RedrawWindow(…,RDW_INVALIDATE|RDW_UPDATENOW)`，2.8 ms）；自绘通知条数 = **可见行数**
（7 条而不是 4000）；`LVM_SORTITEMS` 比较次数只有 `n·log2n` 的一半，别拿它当正确性的证据；删空后内存不回落基线（1560→1756），控件内部有 freelist，
**"删了不降"不等于泄漏**。两处失败：`LVM_GETITEMRECT(0)` 拿到 `(64,0,0,0)`（行高没测出来，后面按 16 px 兜底）；返回 `CDRF_NOTIFYSUBITEMDRAW` 之后
**`SUBITEM` 阶段一次都没来**（单列、加 FULLROWSELECT 都一样）。虚拟模式：

```text
LVM_SETITEMCOUNT(1000000)=3.429 ms 行数=1000000 期间 LVN_GETDISPINFO=0 句柄不变 私有内存 +32 KB
取第 500000 行：返回字符数=0 0.005 ms 通知=1（带文本 1）缓冲仍为空     连续取 100 行 0.027 ms（0.27 us/行，通知 100）
整控件重绘：通知=0 NM_CUSTOMDRAW=7（PRE=1 ITEMPRE=6）   LVM_SORTITEMS：比较 0 次
LVM_SETSCROLLPOSITION(1,999990) 返回=0 读回 0 LVM_GETTOPINDEX=0   ← 滚动没生效（WM_USER+234 是 MinGW 缺符号我自己填的）
```

**100 万虚拟行 = 3.4 ms + 32 KB + 0 个内核句柄**，而真实 4000 行花了 672 ms 和 696 KB——"大列表必须虚拟化"的定量依据。`LVM_SETITEMCOUNT` 本身**不发**通知，数据只在被问时给：**"文本没显示"在虚拟模式下永远是通知没接好**，不是控件坏了。

```text
LISTBOX LBS_OWNERDRAWFIXED：LB_ADDSTRING x1000=35.19 ms 行高=16 可见行=4
  整控件重绘：WM_MEASUREITEM=0 WM_DRAWITEM=4（ODA_DRAWENTIRE=4）；滚到 500 行重绘=8；选中 505 重绘=4 ODA_SELECT=0 ODS_SELECTED=0
  LB_SETCURSEL(77,TRUE) → 父窗口 WM_COMMAND=0（程序化选择不发 LBN_SELCHANGE）  LB_GETTEXT(10) 长度=8 内容=乱码
SysTreeView32：插 root=0.394 ms 平铺 2000 个=140.7 ms（70.35 us/个）再串 200 层深=15.97 ms（79.87 us/个）TVM_GETCOUNT=2201
  TVM_GETITEMHEIGHT=20  TVM_SELECTITEM(CARET)→WM_NOTIFY=4  TVM_EXPAND(根)=14.82 ms  TVM_SORTCHILDRENCB：比较 0 次
  TVM_DELETEITEM(整棵树)=355.5 ms → TVM_GETCOUNT=0   句柄 178 全程不变 私有内存 1788→2260→(删空)1868 KB
```

`WM_MEASUREITEM` 一次没来是 `OWNERDRAWFIXED`（固定行高）的正确表现；滚动后来 8 条是新旧两块可见区都被重绘——**自绘按脏矩形计费**；
`LB_SETCURSEL` 不产生通知；乱码那条见第三节。**插 2201 个 156.7 ms、删整棵树 355.5 ms，贵 2.3 倍**（`d3.out` 在更大的树上量到 2136 ms）：
TreeView 的节点都是控件内部对象，删除要逐个走通知链再释放，"关窗口时卡一下"常常是树在拆自己。`TVM_GETCOUNT` 折叠与展开都是 2201 →
**它不是可见项数**；`TVM_SORTCHILDRENCB` 按文档传参一次比较都没发生，未复现。

## 七、控件子类化与消息拦截：钩子内不内链，成本差一个量级

`GWLP_WNDPROC` 换掉按钮的过程，钩子里吞掉 `WM_LBUTTONDOWN/UP`、`WM_KEYDOWN/UP`：

```text
未子类化：BM_CLICK → 父窗口 WM_COMMAND=1
钩子吞掉 WM_LBUTTONDOWN/UP：命中=2 吞掉=2 父窗口 WM_COMMAND=0     ← 拦截生效
同一个钩子下 BM_CLICK：命中=3 吞掉=2 父窗口 WM_COMMAND=0
空格键（键盘激活按钮）：命中=2 吞掉=2 父窗口 WM_COMMAND=0     摘掉钩子后同样的鼠标点击：WM_COMMAND=1（恢复）
```

`BM_CLICK` **内部会补发 `WM_LBUTTONDOWN/WM_LBUTTONUP`**，所以拦得住真实鼠标的钩子同样拦得住它（`d2v5.out` 得出过相反结论，那把钩子只吞
键盘消息，条件不同）；空格那行说明键盘激活走的也是按键消息。要"禁用某个按钮"请用 `EnableWindow`。成本（消息-only 窗口，20 万条同线程 `WM_NULL`）：

```text
本轮 e7：未子类化 63.3 ns/条 | 钩子直接 DefWindowProcW 终结 64.1 ns/条（命中 200000）
d2v6b：  未子类化 47.3–65.0 | GWLP_WNDPROC 钩子再 CallWindowProcW 转发 93.9–114.6 ns/条（净增 28.9–67.3）
        SetWindowSub(v6) 649.1 ns/条（净增 584.1）；注册 ×1000=0.93 ms；RemoveWindowSub ×1000=1.38 ms
        RemoveWindowSub(refData=0)=0  RemoveWindowSub(refData=42)=1   ← refData 不匹配摘不掉
查询类：DM_GETDEFID ≈100 ns  EM_GETLINE ≈100 ns  IsDialogMessage(WM_NULL) ≈1200 ns（d2v5：1012–1402）GetDlgCtrlID 3.4 ns
        WM_NEXTDLGCTL ≈929 us/条（我的探针把单位标签印成 ns，实为 µs）
```

三档很清楚：**钩子自己终结 ≈ 免费（+0.8 ns）；链回原过程 +30–67 ns；`SetWindowSub` +584 ns**（每层都要过它自己的派发链），高频消息（`WM_MOUSEMOVE`、自绘、`WM_GETDLGCODE`）上挂 `SetWindowSub` 要算账。`RemoveWindowSub` 必须给回**注册时那个 `dwRefData`**，否则返回 0、
钩子永久留在链上——"改了代码钩子还在跑"就是这么来的。另外 `IsDialogMessage` 一条 1.2 µs 是同线程 `SendMessage` 的 20 倍：**UI 循环的成本基线
就被它定下来**；`WM_NEXTDLGCTL` 显式改焦点贵到 0.9 ms/次（同期同机还有别的 agent 抢核，绝对值偏保守），**别在循环里摆焦点**。

## 八、本机没测出来 / 没做的项目

**Tab 焦点走查**（合成按键下每次都停在 101，与 win32d 的完整循环不一致，真实键盘无法注入）；
**手搓 `DLGTEMPLATE`**（`d1t` 8 个变体 1812/1407，我的 8 个组合第一个就崩，**没跑通**）；
**`NM_CUSTOMDRAW` 的 `SUBITEM` 阶段**（返回 `CDRF_NOTIFYSUBITEMDRAW` 仍为 0，未解释）；
**`LVM_SETSCROLLPOSITION`、虚拟模式 `LVM_SORTITEMS`、`TVM_SORTCHILDRENCB`**（各自返回 0 / 比较 0 次，未复现文档行为）；
**`MapDialogRect` 的 X=7 取自哪个字体字段**；**`TaskDialog` 的真实界面**（只取到地址，调用会弹真窗口且要截图）；
**v6 manifest 在 `e7v6.exe` 上没生效**（`SetWindowSub` 仍 `NULL`）而 win32d 同写法生效，原因未查；**`LVS_EX_*` 全套、拖放、内联编辑、
`TVN_*` 通知掩码**；**高 DPI**（本机 96 DPI，`GetDeviceCaps(LOGPIXELSX)=96`，Per-Monitor V2 的 DLU 分支要改系统显示设置，没动）。

## 小结

- **模板有两套码路**：windres 的资源模板（`dlgVer,0xFFFF,helpTopic,exStyle,style,cdit,x,y,cx,cy` + 裸 null 串 + 项里 `x,y,cx,cy,id`）
  能被 `CreateDialogParamW` 正常解析（#102 建出 5 个子控件、几何与模板一致），但同一批字节喂 `CreateDialogIndirectParamW` 报 **1406**，
  照文档手搓 1812 或崩溃 → **用 `.rc`，别手搓**；对话框过程里 **`return DefDlgProcW(...)` = 无限递归 = 静默栈溢出**。
- **DLU 换算走 `MapDialogRect`**（本机 7×15 vs `GetDialogBaseUnits` 的 8×16，差 40×11 像素）；**能力取决于 comctl32 版本**（5.82 vs 6.16）：
  `SetWindowSub`/`TaskDialog` 只在 v6，`InitCommonControlsEx` 返回 0 不代表类没注册，MinGW 头缺 `SetWindowSub`/`LB_*W` 原型。
- **模态是线程级的**：它派发本线程所有窗口的消息、只把 owner `WM_ENABLE` 掉；嵌套模态时最内层循环会偷走外层消息（每拍 1–2 条）；
  `hang` 的 1 秒 CPU 差值 `+0.0 ms`、`spin` 是 `+984.0 ms` → **卡住 ≠ 死循环，判据是 `SendMessageTimeout` 的回音**。
- **回车只认 `DM_GETDEFID`**（`DC_HASDEFID=0x534B`）：两个 `DEFPUSHBUTTON` 后者赢并清掉前者样式位；`DM_SETDEFID` 连样式位一起搬、
  返回旧值却是 1；`ES_WANTRETURN` 只在消息 `hwnd` 就是那个编辑框时生效；`Esc→IDCANCEL`；`BM_CLICK` 会补发鼠标消息所以会被拦。
- **控件的成本结构**：`WM_SETREDRAW(FALSE)` 让批量插入快 **8.02 倍**；虚拟 100 万行 3.4 ms + 32 KB + 0 句柄；自绘只画可见行
  （`ITEMPREPAINT=7`、`WM_DRAWITEM=4`）；TreeView 删除比插入贵 2.3 倍；删空后内存不回落基线不是泄漏。
- **子类化按用途选**：终结型钩子几乎免费，链回原过程 +30–67 ns，`SetWindowSub` +584 ns，且 `RemoveWindowSub` 必须给回同一个 `dwRefData`。
