---
title: 句柄、消息与窗口过程
description: 实测：句柄值是 4 字节步进的表索引，关掉再建立刻复用；一个线程的消息队列只能堆 10000 条（第 10001 次 PostMessage 报 1816 配额不足）；同线程 SendMessage 56 纳秒，跨线程 27.8 微秒，差 493 倍；USER 与 GDI 各自的配额都是每进程 10000，而 GDI 耗尽时 GetLastError 一动不动。
date: 2026-10-15
tags: [Win32, 句柄, 消息队列, WndProc, Unicode]
category: win32
section: win-handle-message
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，`-std=gnu11 -O2 -Wall -lgdi32 -luser32 -lpsapi`。计时一律 7 轮 × 3000 次取**中位数并给区间**。对系统的观察全部只读（`EnumProcesses`+`GetProcessHandleCount`+`NtQuerySystemInformation`），没动服务、注册表和网络配置；建的临时文件与命名对象都在探针退出时清掉。

## 一、句柄不是指针，是进程私有表的下标

空控制台程序起点 **96 个句柄**，创建 5 个内核对象：

```text
基线（进 main）   句柄数=96  USER=1  GDI=0
创建 5 个内核对象 句柄数=101 USER=1  GDI=0
  句柄值 ev=00000000000000d0 mu=...d4 sem=...d8 tm=...dc mm=...e0
  差值 mu-ev=4 sem-mu=4 tm-sem=4 mm-tm=4
全部 CloseHandle 后 句柄数=97 USER=1  GDI=0
```

- **相邻句柄值差 4**：句柄是句柄表索引，表项 4 字节，x64 上高 32 位恒为 0。所以 `0xd0` 这种"小地址"是合法句柄——它从来不是地址。
- 5 个对象 = +5 句柄，线性；全部关闭后回到 97 而不是 96，因为中途 `LoadLibraryW(ntdll)`/`FormatMessage` 自己会开句柄。**判断泄漏要看趋势，不能要求"回到基线"。**

关掉句柄后槽位立刻复用：连续建 3 个事件得到 `0xec 0xf0 0xf4`，关掉 `0xf0`，下一个新建**又拿到 `0xf0`**。这是 Win32 最难查的一类 bug 的根源——**悬空句柄不保证失败**，同一个值可能已经指向别人的新对象。失败时能拿到的信息也只有错误码：

```text
CloseHandle(0x1234) 返回=FALSE lasterr=6   FormatMessage="句柄无效。"
已关闭的句柄再 CloseHandle：返回=FALSE lasterr=6  FormatMessage="句柄无效。"
OpenProcess(pid=4, PROCESS_VM_WRITE) 返回=NULL lasterr=5 FormatMessage="拒绝访问。"
同名第二次 CreateEventW -> h=0e4（第一次 0xd0）lasterr=183 FormatMessage="当文件已存在时，无法创建该文件。"
```

最后一条：`CreateEventW` 撞上同名对象**不失败**，返回新句柄 + `ERROR_ALREADY_EXISTS(183)`。而 183 的系统文本是"当文件已存在时……"——`FormatMessage` 是按错误码查通用消息表，语义要自己翻译。

## 二、一个内核对象上的两层计数

`NtQueryObject(ObjectBasicInformation)` 读对象自身（`sizeof(OBJECT_BASIC_INFORMATION)=56`，实测 `写入=56`）：

```text
  Event(ev)      h=d0 HandleCount=1 granted=0x001f0003 类型=Event(系统对象数=69793 句柄数=74828)
  Mutex(mu)      h=d4 HandleCount=1 granted=0x001f0001 类型=Mutant(系统对象数=3119 句柄数=25446)
  Semaphore(sem) h=d8 HandleCount=1 类型=Semaphore(系统对象数=12536 句柄数=12635)
  TimerEx(tm)    h=dc HandleCount=1 类型=IRTimer(系统对象数=4571 句柄数=4571)
  Section(mm)    h=e0 HandleCount=1 类型=Section(系统对象数=30568 句柄数=24172)
  Event(ev) 2个句柄 h=d0 HandleCount=2   ← 同名再开
  Event(ev) +dup    h=d0 HandleCount=3   ← DuplicateHandle 给了 h=0xec
  Event(ev) -dup    h=d0 HandleCount=2   ← 关掉 0xec
```

`HandleCount` 是句柄表引用数，随 `DuplicateHandle`/`CloseHandle` 精确变动。内核类型名和 Win32 叫法对不上：互斥体叫 **Mutant**、内存映射叫 **Section**、`CreateWaitableTimerEx` 叫 **IRTimer**。造 1000 个事件验证：

```text
建 1000 个事件：Event 对象数 70153 -> 71153，句柄数 75312 -> 76312
关掉 1000 个后：Event 对象数=70153 句柄数=75312
```

同增同减、立刻归零：**最后一个句柄关闭时对象就没了**，没有延迟回收。`granted` 那列说明句柄可以只带部分权限（事件 `0x1f0003`=EVENT_ALL_ACCESS，互斥体 `0x1f0001` 只有 SYNCHRONIZE + 标准 rights）。

## 三、系统级盘点：need 不能信，均值更不能信

`NtQuerySystemInformation(SystemExtendedHandleInformation=64)` 免特权可跑，但第一次探长度返回的 `need` 是坑：

```text
探长度：st=0xc0000004 need=56
  第2次：缓冲区=37170296 字节 st=0000000000 返回 need=37170296
系统句柄总数=929257 本进程=94 每项40字节 → 该数组占 35 MB
```

`56` 只是头大小，真实需要 37 MB，**必须翻倍重试**。免特权看别人更简单的办法是 `EnumProcesses` + `GetProcessHandleCount`：

```text
EnumProcesses 进程数=561 可查句柄数=367 句柄合计=824126 平均=2319.7
    top0 pid=4340   句柄=558379  C:\ProgramData\UDisplay\UDisplay.exe
    top1 pid=17940  句柄=41864   C:\Windows\System32\audiodg.exe
    top2 pid=21564  句柄=21862   C:\Program Files\Adobe\...\node.exe
    top3 pid=3084   句柄=13731   C:\Windows\System32\Taskmgr.exe
```

**平均值 2319 是骗人的**：扣掉 `UDisplay.exe` 的 55.8 万，剩下 366 个进程合计 26.6 万，人均 726。一个第三方进程占了整机 68% 的句柄，它就是在泄漏。**查句柄先看离群值。** 另外 `本进程=94` 与 `GetProcessHandleCount` 在不同运行里差过 1–2，枚举有快照时延，别要求两者严格相等。

## 四、USER / GDI 是另一套配额：各 10000，且 GDI 不报错

把窗口建到失败，再把画笔画刷建到失败：

```text
  起点（1 个窗口类） 内核句柄=100  USER=1      GDI=0
  CreateWindowExW 第 1 次失败: lasterr=1158 "当前程序已使用了 Window 管理器对象的系统允许的所有句柄。"
  成功创建窗口 9998 个
  窗口建满后        内核句柄=133  USER=10000  GDI=0    → 销毁一半：USER=5001，又能建 4999 个
  CreatePen 第 1 次失败: lasterr=0 "操作成功完成。"
  成功创建 GDI 画笔 9999 支
  GDI 建满后        内核句柄=197  USER=10000  GDI=10000 → 全部 DeleteObject 后 GDI=1，又能建 9999 支
```

**USER 与 GDI 各 10000/进程**，`GetGuiResources` 读的就是这两张表；`DestroyWindow`/`DeleteObject` 归还立刻可见。最反直觉的一条：**GDI 耗尽时 `CreatePen` 返回 NULL，而 `GetLastError()` 是 0**（"操作成功完成"）——`if(!h) err(GetLastError())` 这条标准写法对 GDI 完全失效，只能靠返回值判 NULL。另一条：建 9998 个窗口内核句柄只从 100 涨到 133，建 9999 支画笔涨到 197，**USER/GDI 基本不占内核句柄**，所以"句柄数正常"排除不了 UI 资源泄漏，三个数要分开盯（这就是任务管理器"句柄数/对象数"两列的来源）。GDI 对象的泄漏与 DC 成本第二节细量。

## 五、CreateWindowExW 期间 WndProc 已被回调 4 次

把 `printf` 塞进 WndProc，不跑任何消息循环，只调 `CreateWindowExW(WS_OVERLAPPED)`：

```text
  #0   +0.0 us     WM_GETMINMAXINFO  lp=000000202dbfeee0  W=01373872 tid=96064
  #1   +44.8 us    WM_NCCREATE       lp=000000202dbfee90
  #2   +3908.0 us  WM_NCCALCSIZE     lp=000000202dbfef00
  #3   +4865.5 us  WM_CREATE         lp=000000202dbfee80
```

**这 4 条没进过任何队列**，USER32 在 `CreateWindowExW` 的调用栈上直接回调你的 WndProc。`ShowWindow(SW_SHOW)` 触发 16 条，顺序是实测：

```text
WM_SHOWWINDOW → WM_WINDOWPOSCHANGING → WM_WINDOWPOSCHANGING → WM_ACTIVATEAPP → WM_NCACTIVATE
→ WM_ACTIVATE → WM_IME_SETCONTEXT → WM_IME_NOTIFY → WM_GETOBJECT → WM_GETOBJECT
→ WM_SETFOCUS → WM_NCPAINT → WM_ERASEBKGND → WM_WINDOWPOSCHANGED → WM_SIZE → WM_MOVE
```

`WM_WINDOWPOSCHANGING` **连发两次**，`WM_SIZE`/`WM_MOVE` 排在最后——"先收到 SIZE 再显示"的假设不成立。`WM_IME_*` 每次激活都来，`WM_GETOBJECT` 是无障碍/UIA 在问话（本机每次 ShowWindow 固定 2 条）。`UpdateWindow` 只给 **1 条 WM_PAINT**（在调用栈上，`BeginPaint` 报 `rcPaint=(0,0)-(394,271) erase=0`）；`InvalidateRect` 交给消息循环时是 5 条（多了 `WM_DWMNCRENDERINGCHANGED`、一个未公开的 `0xc378`、以及 `WM_GETICON`）。`DestroyWindow` 给 3 条：`0x0090`（+0.0µs，MinGW `winuser.h` 的 251 条 WM_ 名字表里查不到，是 UAH 内部通知）→ `WM_DESTROY`（+468.6µs）→ `WM_NCDESTROY`（+9161.9µs），后两者之间是释放本窗口 GDI 对象的最后时机。

## 六、Post 与 Send：56 纳秒 vs 27.8 微秒

| 操作 | 中位单价 | 区间 |
| --- | --- | --- |
| `SendMessageW` 同线程窗口 | **56.4 ns** | 56.1 – 58.6 |
| `PostMessageW` 同线程窗口 | 1463 ns | 1167 – 6574 |
| `PeekMessageW(PM_REMOVE)` 取一条 | 1204 ns | 984 – 7034 |
| `PostThreadMessageW` 到别的线程 | 16640 ns | 15425 – 30013 |
| `PostMessageW` 跨线程窗口 | 17053 ns | 15723 – 33133 |
| `SendMessageW` 跨线程窗口 | **27818 ns** | 16835 – 42312 |

- 同线程 `SendMessage` 就是**一次直接函数调用**（56ns，与 `std::mutex` 无竞争加锁同量级），不入队。
- 跨线程 `SendMessage` = 唤醒成本 + 等回音，**是同线程的 493 倍**，与《线程与进程模型》量的"一次条件变量唤醒交接 11.35µs"同源。
- 同线程 `PostMessage` 也要 1.4µs：队列是 USER32 与 win32k 共享的结构，入队从来不免费。

`PostMessageW(NULL,...)` 是线程消息，实测进**调用线程自己的队列**（`成功 9999 次 lasterr=1816`，A 线程排空 10000 条）；而 `SendMessageW(NULL,...)` 直接失败：`返回=0 lasterr=1400`，两个线程的 WndProc 一次都没被调用。这个区别救过一次误判——我最初版探针忘了给事件句柄赋值，`WaitForSingleObject` 返回 `4294967295`（WAIT_FAILED）却没检查，主线程于是读到工作线程的 `hwnd` 仍是 0，"跨线程 SendMessage 不重入"的假结论全部来自那次静默失败。**先打印同步原语自身的返回值，再谈 API 行为。**

## 七、队列配额 10000 条，和 SendMessage 的重入

```text
同一个窗口：成功投递 10000 条后 PostMessageW 开始失败，lasterr=1816 "配额不足，无法处理此命令。"
紧接着往同线程的另一个窗口投递：成功 0 条，lasterr=1816
先排空，再投 5 条 WM_NULL + 1 条 WM_USER+9；PeekMessage 取到 6 条，其中 WM_NULL 5 条
PM_NOREMOVE 两次=1,1；PM_REMOVE 两次=1,0
空队列时 GetQueueStatus(QS_ALLINPUT)=0x00100000 低16=0 高16=0x10
```

上限是**每线程 10000 条**，与窗口无关：UI 线程被长任务卡死时，别人只能投进 1 万条，之后 `PostMessage` 静默失败——这就是"后台通知 UI、UI 卡住后通知丢了"的机制，要可靠就换事件/IOCP 而不是消息队列。`WM_NULL` **会被 `PeekMessage` 正常取出**（"系统吞掉 WM_NULL"在 Peek 路径上不成立）；`PM_NOREMOVE` 真的不摘；`GetQueueStatus` 低 16 位是"请求且已置位"的 flags，高 16 位是队列里出现过的类别并集。重入实测：A `Send(hB,100)` → B 的 handler `Send(hA,101)` → A 的 handler 再 `Send(hB,200)`：

```text
[B] 收到 A 的 SendMessage(WM_USER+100)，深度=1 → 我回手 SendMessage(A, WM_USER+101)
[A] WndProc 深度=1（A 此刻其实卡在 SendMessage(WM_USER+100) 内部）
[B] ★重入★ 上一个 WM_USER+100 还没返回，WndProc 又被调用（WM_USER+200），深度=2
A 的 WndProc 最大深度=1   B 的 WndProc 最大深度=2
```

**跨线程 SendMessage 能把 WndProc 叠成任意深的嵌套**，栈上同时摆着若干"做了一半"的状态——这就是"WndProc 里不要等锁、不要干重活"的物理原因。超时与"未响应"判定：

```text
B 正在 WndProc 里 Sleep(3000)：IsHungAppWindow=0 lasterr=1816
SMTO_ABORTIFHUNG + 500ms：返回=FALSE 用时=513.2 ms lasterr=1460 "由于超时时间已过，该操作返回。"
再发一次 uTimeout=0（无限等）：返回=TRUE 用时=2450.6 ms lasterr=1460
```

`IsHungAppWindow` 对"忙 3 秒"不敏感（它看的是窗口是否响应系统消息），`SMTO_ABORTIFHUNG` 于是退化成"等满 500ms"（实测 513.2ms，多出来的是定时器粒度）。最后一行还带两个陷阱：成功后 `lasterr` 仍是上一次的 1460，`uTimeout=0` 是无限等而不是立刻。

## 八、A/W 两套 API：导出表里没有"不带后缀"的名字

同一份源码编译两次，`(void*)CreateEvent` 指向不同函数：

```text
带 -DUNICODE  ：CreateEvent==CreateEventW ? 1  ==CreateEventA ? 0   sizeof(TCHAR)=2
不带 -DUNICODE：CreateEvent==CreateEventW ? 0  ==CreateEventA ? 1   sizeof(TCHAR)=1
GetProcAddress("CreateEvent   ") = 0     GetProcAddress("CreateEventW")    = 00007ffa31436e80
GetProcAddress("CreateWindowEx") = 0     GetProcAddress("CreateWindowExW") = 00007ffa3209c110
```

`UNICODE` 是**纯编译期宏**。手工解析 PE 导出表：

```text
kernel32 导出 1697 个具名函数：A 结尾 264，W 结尾 293，其余 1140；A/W 成对 264 组
user32   导出 1050 个具名函数：A 结尾 149，W 结尾 152，其余 749；A/W 成对 147 组
只有 W 版、没有 A 版的 27 个里含：FindFirstStreamW FindFirstFileNameW FindNextStreamW
  GetVolumeInformationByHandleW DnsHostnameToComputerNameExW …
```

`FindFirstStreamW`（枚举 NTFS 备用数据流）这类**从来没有 ANSI 版本**，写 `FindFirstStreamA` 只会得到 `undefined reference`。**转换本身极便宜，贵的是别的**（7 轮中位）：

```text
MultiByteToWideChar(CP_ACP) 14 字节 43.8 ns（39.4–92.1）  WideCharToMultiByte 9 字符 32.1 ns（31.3–35.8）
SetWindowTextW（隐藏，ASCII）187.3 µs（104.5–348.6）      SetWindowTextA（隐藏，ASCII）253.2 µs（173.9–351.3）
```

`SetWindowText` 的单价是转换的 **4000 倍**，A/W 差值完全被重绘噪声吃掉（区间大幅重叠）——要优化的是**调用次数**，不是字符集。代码页语义（本机 ACP=936），以及把 `activeCodePage=UTF-8` 写进 exe 的资源 ID 24（RT_MANIFEST）重链之后——**没动任何系统设置**：

```text
ACP=936  ：U+2603→"3f 20"（UsedDefaultChar=1，雪人被换成 '?'）
           CreateFileW(中文)=0x68 ok   CreateFileA(GBK 字节名)=0x68 ok   CreateFileA(UTF-8 字节名)=INVALID lasterr=2
ACP=65001：U+2603→"e2 98 83 20"（UsedDefaultChar=0，真 UTF-8）  控制台输出 CP 仍 936
           CreateFileA(UTF-8 字节名)=0x64 ok   CreateFileA(GBK 字节名)=INVALID lasterr=2
```

两条 A 版 API 的行为**整个反过来**。同一轮实验里 `CreateActCtxW`+`ActivateActCtx` 返回成功（`=1`）但 `GetACP()` 仍是 936：**ACP 覆盖只在进程加载时读嵌入 manifest 生效**。控制台 CP 不跟着变，所以第一次跑 `FormatMessage` 我拿到的是乱码，之后所有探针都改成 `WideCharToMultiByte(CP_UTF8,…)`+`fputs`。MinGW 另有一个坑：`IDC_ARROW`/`MAKEINTRESOURCE` 也随 `UNICODE` 展开，不带 `-DUNICODE` 时它是 `MAKEINTRESOURCEA`，传给 `LoadCursorW` 直接报 incompatible pointer types。

`GetWindowText*` 的缓冲区语义是本节最危险的发现。标题"中文标题 café"（9 字符 / CP936 下 14 字节）：

```text
A 版：nMax=2 →返回2 前2字节 d6 d0        无终止符   nMax=4  →返回6 前4字节 d6 d0 ce c4  无终止符
      nMax=8 →返回11 d6 d0 ce c4 b1 ea cc e2 无终止符  nMax=14 →返回14 无终止符  nMax=15 →返回14 有终止符
W 版：nMax=2 →返回1（4e2d 0000）  nMax=9 →返回8  nMax=10 →返回9  三种都有终止符
```

W 版规矩：nMax 含终止符、返回值=实际拷贝字符数、永远补 0。A 版三条全违反：**返回值能大于写进缓冲区的字节数（nMax=4 却返回 6）**、**不保证补终止符**、nMax 在 DBCS 下按字符还是按字节也不透明。`char buf[N]; GetWindowTextA(hwnd,buf,N); use(buf);` 一定在读越界。

## 小结

- 句柄 = 4 字节步进的进程私有表索引，值关掉立刻复用；`CloseHandle` 只能报 6（句柄无效），双关闭不崩，悬空句柄更可能"关到别人的对象"；命名对象二次打开返回成功 + 183。
- 对象上有句柄计数与引用计数两层，**最后一个句柄关闭即销毁**（1000 个事件：70153→71153→70153）。全机 93 万个句柄免特权可数，本机一个进程占 68%——查泄漏看离群值不看均值；`NtQuerySystemInformation` 首次 `need` 只是头大小（56 vs 真实 37MB），必须翻倍重试。
- USER 与 GDI 各 **10000/进程**且几乎不占内核句柄；窗口耗尽报 1158，**GDI 耗尽 `GetLastError()=0`**。
- 创建期 4 条 / ShowWindow 16 条 / Destroy 3 条消息都是**调用栈上直接回调**，不经过队列；同线程 `SendMessage` 56ns，跨线程 27.8µs（493 倍），且跨线程 `SendMessage` 实测把 WndProc 叠到深度 2。
- 队列配额 **10000 条/线程**（不是每窗口），投满后 1816 静默丢消息；`WM_NULL` 会被正常取出；`IsHungAppWindow` 对"忙 3 秒"不敏感，`SMTO_ABORTIFHUNG` 只是超时器。
- A/W 是编译期宏，导出表里没有无后缀名字（kernel32 有 27 个 W-only）；转换 32–44ns 而 `SetWindowText` 190–250µs，**优化调用次数而不是字符集**；RT_MANIFEST 的 `activeCodePage=UTF-8` 能把 A 版语义整体翻转，`ActivateActCtx` 做不到。而 `GetWindowTextA` 不保证终止符、返回值不可信，`GetWindowTextW` 两者都保证——**窗口文本一律走 W 版**。
