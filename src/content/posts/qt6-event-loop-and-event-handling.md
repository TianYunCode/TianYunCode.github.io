---
title: Qt 6 事件循环与事件处理
description: 实测：sendEvent 派发 49 纳秒、postEvent 290 纳秒；忙等 200 毫秒错过 20 个 tick 只补发 1 个；槽里调 processEvents 每层重入吃 13.3 KB 栈。
date: 2026-10-15
tags: [Qt, 事件循环, QTimer, processEvents]
category: qt6
section: qt-event
---

> 环境：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`），GCC 13.1.0（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`；PATH 上的 g++ 是 Strawberry Perl 4.9.2 32 位，禁用），CMake 3.30.5 + Ninja，`-O2 -DNDEBUG`，GUI 一律 `QT_QPA_PLATFORM=offscreen` 无头跑，不截图。耗时为进程内多轮中位数并给区间；**本机同期有另外 3 个 agent 在抢核**，绝对值偏大、比值更可靠。时钟分辨率一项额外用**全新进程**逐项单跑（否则前面实验抬高的分辨率会污染后面的数据），编译期结论用 `g++ -fsyntax-only` 逐例取证。

## 一、五级派发：一条轨迹看清先后

给 `QPushButton` 同时挂上应用级过滤器、两个对象级过滤器、覆写 `event()`、覆写 `mousePressEvent()`，再 `sendEvent` 一条 `QEvent::User`：

```text
  notify() 进入: type=1000 layer=QPushBtn
    2a appFilter      type=1000 obj=Btn
    2b objFilter-B    type=1000          <- 后装的 B 先被调用
    2b objFilter-A    type=1000
    3  Btn::event()   type=1000
  sendEvent(User) 后: notify() 调用次数增量=1
```

| 层 | 挂法 | 能看到什么 | 能做什么 |
| --- | --- | --- | --- |
| 1 | 覆写 `QApplication::notify()` | 全部事件（含发给别的线程对象的） | 最后一道闸 |
| 2a | `app.installEventFilter()` | 全进程所有对象的所有事件 | 返回 `true` = 事件当场死亡 |
| 2b | `obj.installEventFilter()` | **只有该 obj 自己**的事件 | 同上；**多个过滤器按安装逆序执行** |
| 3 | 覆写 `QWidget::event()` | 该控件收到的全部事件 | 返回 `true` 就不再有第 4 层 |
| 4 | 覆写 `mousePressEvent()` 等 | 单类事件 | `ignore()` 让父控件接手（仅部分事件） |

```text
  过滤器装在父 Win 上、事件发给子按钮 Btn：appFilter type=2 obj=Btn（看见），Win 的 objFilter 一条没打印（看不见）
  过滤器 return true      ：mousePressEvent 增量=0  clicked 信号增量=0
  Btn::event() return true：mousePressEvent 增量=0  clicked 信号增量=0
  正常放行               ：mousePressEvent 增量=1  clicked 增量=0（只按下没抬起，本来就不该有 clicked）
  一次按下顺带派发：WindowActivate(68) → MouseButtonPress(2) → 四级链 → UpdateRequest(77)（重绘请求入队）
```

**父控件的事件过滤器看不到子控件的事件**——"全局拦截"只能挂在 `QCoreApplication` 上。而 `clicked()` 是信号不是事件，`click()` 这个槽**根本不走事件系统**：`click(): pressed=1 released=1 clicked=1 toggled=0 mousePressEvent增量=0`。三个信号全响、`mousePressEvent()` 一次没被调用，所以用 `click()` 永远验证不到事件过滤逻辑，要模拟就 `sendEvent(&btn, &QMouseEvent(...))`。

## 二、send 与 post：谁能插队，各多少钱

```text
  post 2 条后再 sendEvent 1 条 —— sendEvent 那条立刻送达，两条 post 等到 processEvents 才进来
  postEvent 优先级：post(User+10,prio=0) post(User+11,prio=200) post(User+12,prio=100)
    到达: User+11 / User+12 / User+10        ← 优先级大的先出队，同优先级 FIFO
```

`sendEvent` 同步（返回时目标已处理完，`notify()` 恰好 +1），它不进队列，所以**能插到已入队事件前面**。价格（20 万次/轮 × 5 轮中位）：

| 路径 | 中位 | 说明 |
| --- | --- | --- |
| 栈上 `QEvent` + `sendEvent`（含 3 层过滤器） | **49.4 – 55.1 ns** | 一次虚派发 |
| `postEvent`（堆分配 + 加锁 + 入队） | **156.1 ns** | 还没派发 |
| `sendPostedEvents` 排空 | **134.0 ns/条** | 派发那一段 |
| 裸 `QEvent` 构造+析构 | 6.8 ns | 下限参照 |

**post 一条再派发的总成本 ≈290ns，是同一次 send 的 5.9 倍**，多出来的是 `new QEvent`、投递锁和队列；跨线程还得叠加唤醒对端线程的开销（上一节量到跨线程 `emit` 是同线程的 15–21 倍）。

```text
  sizeof(QEvent)=16  QMouseEvent=80  QPaintEvent=48  QResizeEvent=32
  Timer=1 MouseButtonPress=2 FocusIn=8 Paint=12 Move=13 Resize=14 Show=17 Hide=18 Close=19
  KeyPress=6 DeferredDelete=52 Polish=75 LayoutRequest=76 UpdateRequest=77 User=1000 MaxUser=65535
```

自定义事件只能占 `User..MaxUser`。注意 **`QEvent` 不是 `QObject`**：`e.setProperty("k",1)` 直接编译错误，要带数据必须自己派生子类。`spontaneous()` 区分"平台送进来的"和"Qt 自己造的"，`show()` + 60ms 循环里只看这一个控件：`spontaneous=3  非自发=13`——**首帧那批事件里只有 3 个来自平台**，其余全是 Qt 内部投递/发送的，这正是 `offscreen` 下整套 UI 逻辑照样能跑的原因。

## 三、Windows 的 15.6ms tick 困不住 Qt 定时器

基线（全新进程，什么都没干）：`Sleep(1)=14.94  Sleep(10)=15.10  Sleep(16)=30.59`（ms）——tick ≈15.6ms，所有等待向上取整，与本系列前面量到的 `Sleep(1)` 14.7–15.9ms 一致。再看 Qt（同一个进程，第一件事就是起 10ms `PreciseTimer`）：

```text
  10 ms 定时器跑 300ms -> 触发 30 次 avg=9.961  min=2.868 p95=11.223 max=17.657
  紧接着 2 ms 定时器跑 300ms -> 触发 150 次 avg=1.997  min=0.280 p95=2.666
  singleShot(1ms) 6 次: median=1.875 min=0.601 max=2.623 ms
  singleShot(0ms) 6 次: median=0.003 ms      ← 0ms 真的当轮就兑现
```

一次没漏（30/300ms）。原因不是 Qt 会算，而是它把进程的系统时钟分辨率抬上去了：

| 状态 | Sleep(1) 实测 |
| --- | --- |
| 全新进程（基线） | 14.94 – 15.42 ms |
| 有活动 QTimer 时，在 tick 回调里测 | **1.63 – 1.79 ms** |
| 显式 `timeBeginPeriod(1)` | **1.81 – 1.87 ms** |
| 显式 `timeEndPeriod(1)` 之后 | 13.79 – 15.38 ms |

**Qt 的 Win32 派发器在有活动定时器期间等价于 `timeBeginPeriod(1)`**，`stop()` 之后就还回去（实测回到 15.38ms）。所以"Windows 定时器只有 15.6ms 精度"对 `Sleep()` 成立、对 `QTimer` 不成立；反过来也提醒自己：**GUI 里挂一个 1ms 定时器会把全进程的时钟精度拉高**。

| 设定 | offscreen/core avg（3 轮区间） | windows 平台 avg | 备注 |
| --- | --- | --- | --- |
| 1 ms | 1.046（1.046–1.095） | 1.053（1.053–1.088） | min 0.19ms，真能到 1ms 级 |
| 10 ms | 9.999（9.984–9.999） | 10.022（9.993–10.022） | |
| 15 ms | 14.986 | 15.009 | 这里才开始和 tick 撞上 |
| 16 ms | 15.997 | 16.007 | 一帧 16ms 不会变成 30ms |
| 50 ms | 49.746 | 50.045 | |

换后端不改变精度，只改变派发器名字：`offscreen`/`QCoreApplication` 是 `QEventDispatcherWin32`，`windows`/`QApplication` 是 `QWindowsGuiEventDispatcher`。

## 四、三种 TimerType：差别全在"允许偏差"

`Qt::TimerType` 只剩三个值（**`Qt::DefaultTimer` 在 6.9 已不存在**，写上去就是编译错误），而 `QTimer` 默认给的是 `1`：`QTimer 默认 timerType()=1  枚举值 Precise=0 Coarse=1 VeryCoarse=2`。同一 interval、8 秒窗口、独立进程实测（avg = 相邻 tick 间隔均值）：

| interval | PreciseTimer | CoarseTimer | VeryCoarseTimer |
| --- | --- | --- | --- |
| 1 ms | 1.046 – 1.125 | 1.187 | **400ms 窗口内 0 次** |
| 50 ms | 49.918（60 次） | **62.633（47 次，+25%）** | 8s 内 2 次 |
| 300 ms | 300.001（26 次） | 312.553（25 次，+4.2%） | **1000.864（7 次，=3.3×）** |

`CoarseTimer` 文档说容差 5%：300ms 上 +4.2% 符合，但 **50ms 上实测 +25%、3 秒少触发 13 次**，短 interval 段偏差被放大，不能把 5% 当保证。`VeryCoarseTimer` 是"对齐到整秒"——300ms 直接变 1000.9ms，它是给倒计时类 UI 省 CPU 的，不是精度工具。动画/采样一律显式 `setTimerType(Qt::PreciseTimer)`。

**事件循环被卡住时，错过的 tick 不补。** 10ms Precise + 忙等 200ms（错过约 20 个 tick）：

```text
  正常 100ms 里 tick=10（理论 10）
  忙等后第一次 processEvents(AllEvents,1ms) 只送达 1 个 timeout；再跑 60ms 累计 7（理论 6）
  => 错过的 tick 被合并成 1 个事件，不补帧
```

这就是"卡完跳一帧"的物理原因：Qt 派发时只问"该醒几次"，答案永远是一次。要保证节拍得在回调里用 `QElapsedTimer` 自己补算，而不是数 `timeout` 次数。

## 五、processEvents()：三宗罪，全部可复现

**罪一：`maxtime` 拦不住已经排队的风暴，也不肯等未来的事件。**

```text
  队列 5000 条，给 1ms 时间片：实际送达 5000 条，调用耗时 353 us
  队列已空，给 300ms：送达 0 条，耗时 1 us（不会白等，立刻返回）
  120ms 后才有 1 条事件，给 300ms：送达 0 条，耗时 514 us —— maxtime 不会让它等
  同一批，改用 WaitForMoreEvents：送达 0 条，耗时 1 us（exec() 之外这个标志也不生效）
```

`maxtime` 只限时间、不限条数：5000 条已在队列里时，1ms 时间片照样一口气派发完。想给 UI 留喘息只能少投递。

**罪二：重入是吃栈的。** 在事件处理器里调 `processEvents()`，队列里 2000 条事件（护栏：最深 60 层）：

```text
  派发 2000 条，最大重入深度 60，耗时 0 ms
  栈跨度：最深帧与第 1 帧相差 786352 字节 => 每层嵌套约 13328 字节栈
  对照（处理器里不调 processEvents）：本次派发 0 条，深度 0
```

**每层重入约 13.3KB 栈**，默认 1MB 线程栈大约 **75 层就爆**，而且没有任何 Qt 告警。这就是"用户连点两次、第二次落在第一次的槽里 → 同一函数跑两遍 → 状态被写坏"的物理形态。护栏要么 `if (busy) return;`，要么判 `QEventLoop::isRunning()`；`QCoreApplication::processEvents()` 返回 `void`，问不到"处理了几条"，唯一线索是 `QEventLoop::processEvents()` 的 `bool`。

**罪三：应用级过滤器一旦吞掉 Timer 事件，循环就再也出不来。** 装一个对所有 `QEvent::Timer` 返回 `true` 的过滤器（靠不依赖定时器的逃生事件才测出来）：

```text
  [对照：未装过滤器      ] l.exec() 实际阻塞   50 ms（Timer 被吞 0 条 / 逃生事件 1 条）
  [装了吞 Timer 的过滤器 ] l.exec() 实际阻塞  411 ms（Timer 被吞 8 条 / 逃生事件 1 条）
```

本应 50ms 退出变成 411ms——`QTimer::singleShot` 内部也是定时器事件，被同一个过滤器吃掉了。**`quit()`/`exec()` 的退出路径和所有业务定时器共用一条通道**，全局过滤要按 type 精确放行，别一把梭 `return true`。嵌套 `exec()` 的另一面是内层把队列整个吃掉：

```text
  100 条 User 事件：第 1 条里嵌套 inner.exec()；inner 返回时已派发 100 条
  => 内层把外层的 99 条提前消费掉了（outer 自己一条都没分到）
```

`QDialog::exec()`、`QMessageBox`、进度条里手写的 `QEventLoop` 都是这个结构。再叠加上一节的实测——`processEvents()` **不兑现 `DeferredDelete`**——就是"槽里 `deleteLater()` + 子过程里弹了个对话框"的翻车现场。

## 六、合并与不合并：Qt 压什么、不压什么

| 操作 | 次数 | 产生的事件 | 结论 |
| --- | --- | --- | --- |
| `widget->update()` | 1000 | Paint **1**（本轮共 2） | 压缩比 500:1 |
| `update()` ×3 + `processEvents(ExcludeUserInputEvents)` | 3 | Paint 1 | 合并与标志位无关 |
| `layout->addWidget()` | 500 | LayoutRequest **2**（add 期间 0 次） | 布局失效是"标脏+合并"，不同步派发 |
| `widget->resize()` | 500 | Resize **499**，耗时 1 ms | **不压缩**，每条同步派发 |
| `postEvent(QEvent::User)` | 1000 | 全部送达 1000 条 | 自定义事件永不合并 |

最该记住的一对：**`update()` 一千次也只有一个 Paint，`resize()` 五百次就是五百次同步派发**。改尺寸、改字体、`setVisible`、往布局里加控件都是"立刻算一遍"的贵操作，重绘是"记账、空闲时算一遍"的便宜操作。批量改 UI 的正确姿势是先 `setUpdatesEnabled(false)` 或先隐藏，改完再打开。

## 七、Qt 6.9 里这些旧写法已经不成立（逐条编译验证）

| 旧写法 | 结果 |
| --- | --- |
| `bool ok = QCoreApplication::postEvent(...)` | `error: void value not ignored as it ought to be`——**postEvent 现在返回 void**，投递失败不告诉你 |
| `bool r = QCoreApplication::processEvents()` | 同上，返回 void |
| `QCoreApplication::hasPendingEvents()` | `error: 'hasPendingEvents' is not a member`——符号整个没了，探测队列只能自己数事件 |
| `QCoreApplication::wakeUp()` | `error: 'wakeUp' is not a member`——只有 `QAbstractEventDispatcher::wakeUp()` |
| `QApplication::instance()->eventLoop()` | `error: has no member named 'eventLoop'`（不再公开） |
| `QEvent::NumberOfTypes` / `QEvent::GraphicsSetup` | `error: ... is not a member of 'QEvent'`——6.9 里 **217 号是 `PlatformSurface`**，最大内置类型是 227 `SafeAreaMarginsChange` |
| `Qt::TimerType tt = Qt::DefaultTimer` | `error: 'DefaultTimer' is not a member of 'Qt'` |
| `QEvent e(QEvent::User + 7)` | `error: invalid conversion from 'int' to 'QEvent::Type'`——构造函数是 `explicit`，必须 `static_cast` |
| `e.setProperty("k", 1)` | `error: 'class QEvent' has no member named 'setProperty'` |
| `QEvent::registerEventType(QStringLiteral("Foo"))` | `error: cannot convert 'QString' to 'int'`——签名变成 `registerEventType(int hint = -1)` |
| `d->wakingEnabled()` | `error: has no member`（不再公开） |
| `qInstallMsgHandler(...)` | `error: ... did you mean 'qInstallMessageHandler'?` |
| `QCoreApplication::sendPostedEvents(&o, QEvent::User)` | **能编译**（形参是 `int event_type`，枚举自动提升） |

## 八、小结

- 派发链固定五级：`notify()` → 应用过滤器 → 对象过滤器（**逆安装序**）→ `event()` → 专用处理器。**父控件的过滤器看不到子控件的事件**；2a/2b 或 `event()` 返回 `true` 会让后面的层和 `clicked()` 一起消失。`click()` 不走事件系统（`mousePressEvent` 增量 0）。
- 成本：**sendEvent 49.4–55.1ns，postEvent 156.1ns + 排空 134.0ns ≈ 5.9 倍**。`sendEvent` 能插到已入队事件前面；`postEvent` 按优先级出队（200→100→0），同优先级 FIFO。`show()` 首轮只有 3 个自发事件 / 13 个内部事件。
- **Windows 15.6ms tick 只卡 `Sleep`（Sleep(1)=14.94ms、Sleep(16)=30.59ms），不卡 QTimer**：`QTimer(10ms)` 实测 30 次/300ms、avg 9.96–10.02ms，1ms 定时器 avg 1.05ms；机制是有活动定时器期间进程时钟分辨率被抬到 1ms（tick 里 Sleep(1)=1.63–1.79ms，`timeBeginPeriod(1)` 手工验证等价）。`offscreen` 与 `windows` 两档精度一致，只是派发器换了名字。
- TimerType：**默认 CoarseTimer(1)**。VeryCoarse 把 300ms 变成 **1000.9ms（3.3×）**；Coarse 的 50ms 实测 **62.6ms（+25%，3 秒少 13 次）**，"5% 容差"不能当承诺。
- 阻塞后**错过的 tick 合并成 1 个事件**，不补帧。`maxtime` 不限条数（1ms 派发完 5000 条）、不等未来事件、`WaitForMoreEvents` 在 `exec()` 外不生效。
- `processEvents()` 每层重入 **13.3KB 栈**（约 75 层耗尽 1MB）；嵌套 `exec()` 让内层吃掉外层排队的事件（实测 99/100）；应用级过滤器吞掉 Timer 会让本应 50ms 退出的循环变成 411ms。
- 合并表：`update()` 1000→1 Paint，`addWidget()` 500→2 LayoutRequest，`resize()` 500→499 个同步 Resize 事件；批量改 UI 前先关更新。
- 13 条 Qt 6.9 API 删改全部编译验证：`postEvent`/`processEvents` 改返回 void，`hasPendingEvents`/`Qt::DefaultTimer`/`QEvent::NumberOfTypes` 已删，`QEvent::User+N` 必须显式转型。
- **本节未在本机实测**：真实显示器下的合成/垂直同步节奏、`qdirect2d` 后端下的 Paint 时序、Wayland/X11 侧的事件打包差异（本机只有 Windows 一套 Qt）。

下一节进入控件与布局：`sizeHint` 从哪来、伸缩因子怎么分配空白、`setMinimumWidth` 为什么会把整行顶宽，以及 Tab 焦点链的真实排序规则。
