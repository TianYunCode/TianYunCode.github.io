---
title: Qt 6 控件与布局
description: 实测：QPushButton 空文本 sizeHint 62x20、写"确定"变 80x20，QLineEdit sizeHint 210x22 但 minimumSizeHint 只有 18x20——差 11.7 倍，这就是它能被压扁的原因；600px 宽的 QHBoxLayout 里 stretch=(1,2,3) 精确分出 100/200/300，而 (0,0,1) 给按钮是 80/80/440、给裸 QWidget 是 0/0/600，卡住下限的是 minimumSizeHint 不是 stretch；QSizePolicy::Expanding 真实数值是 7、Ignored 是 13（不是文档顺序里的 6 和 7）；100px 的叶子控件外面套 4 层 margin=11 的布局，minimumSize 从 122x42 一路涨到 210x130，清成 0 后回到 100x20；不换行的 25 短语中文标签把布局顶成 1800px 宽，开了 wordWrap 后 minimumSizeHint 塌回 12x12；nextInFocusChain 的环里连 NoFocus/disabled/hidden 的控件都在；1000 个控件 addWidget 摊 4.05 µs/个、首次布局 25.6 µs/个。
date: 2026-10-16
tags: [Qt, 控件, 布局, sizeHint, 焦点顺序]
category: qt6
section: qt-widget-layout
---

> 环境：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`），GCC 13.1.0（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`；PATH 上的 g++ 是 Strawberry Perl 4.9.2 32 位，用了结论就是错的），`-O2 -DNDEBUG`，全部 `QT_QPA_PLATFORM=offscreen` 无头跑、只读 `geometry()`/`sizeHint()`/`minimumSizeHint()` 的数值，不截图。风格是 **fusion**（`app.style()->objectName()=fusion`），字体 `Sans Serif` 9pt（`pixelSize=-1`，即按点尺寸走）。绝对耗时受本机负载影响（同期另有数个任务抢核），所以性能段给的是**每控件均摊值**并且 3 轮取最好；几何与枚举值与负载无关，可当硬事实。**Qt 6.9 的 API 删改全部用 `g++ -fsyntax-only` 逐例取证**，报错原文照抄。

## 一、先记住这张 sizeHint 表

`QApplication` 一建好，控件还没进任何布局，尺寸语义就已经定了（下表是本轮亲手重跑的，与前一版探针同一台机器同一套二进制复核一致）：

| 控件（默认构造） | sizeHint | minimumSizeHint | policy(h,v) | focusPolicy |
| --- | --- | --- | --- | --- |
| `QPushButton`（空文本） | **62 x 20** | 62 x 20 | (1,0) | 11 Strong |
| `QPushButton("确定")` | **80 x 20** | 80 x 20 | (1,0) | 11 |
| `QToolButton` | 24 x 23 | 24 x 23 | (0,0) 双 Fixed | 1 Tab |
| `QLabel`（空） | 12 x 14 | 12 x 14 | (5,5) | 0 NoFocus |
| `QLineEdit` | **210 x 22** | **18 x 20** | (7,0) Expanding | 11 |
| `QComboBox` | 114 x 22 | 114 x 22 | (5,0) | 15 Wheel |
| `QSpinBox` | 60 x 23 | 60 x 21 | (1,0) | 15 |
| `QSlider`（水平） | 84 x 15 | **15 x 15** | (7,0) | 11 |
| `QCheckBox`（空） | 14 x 15 | 14 x 15 | (1,0) | 11 |
| `QProgressBar` | 111 x 20 | 111 x 14 | (7,0) | 0 |
| `QTextEdit` / `QListView` / `QTableView` | **256 x 192** | 70 x 70 | (7,7) | 11 |

三个反直觉的点：

1. **`QLineEdit` 的 210 只是"愿望"，18 才是底线**（差 11.7 倍）。布局里它被压到 30px 宽是完全合法的，别指望 sizeHint 撑住。
2. **`QComboBox` 的 sizeHint 和 minimumSizeHint 相等**（114x22、90x22 都是），所以它**压不小**——选中项文字长就把整行顶宽。要它别顶，只能 `setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon)`。
3. `QSlider` 水平时 minimumSizeHint 是 15x15（只剩把手宽度），`QTextEdit` 的 70x70 是它的底线，256x192 只是缺省。

## 二、SizePolicy 的真实数值是位或，不是序号

`QSizePolicy::Policy` 底层是 4 个标志位的组合（`qsizepolicy.h`，本轮实测 `(int)` 输出）：

```text
  PolicyFlag: GrowFlag=1 ExpandFlag=2 ShrinkFlag=4 IgnoreFlag=8
  Fixed=0 Minimum=1 Maximum=4 Preferred=5 MinimumExpanding=3 Expanding=7 Ignored=13
```

也就是说 **`Expanding` 是 7 不是 6、`Ignored` 是 13 不是 7、`Maximum` 是 4 不是 2**。按枚举名去背数字，写进 `setProperty` 或跨进程协议里就会错位。语义上只有三件事：能不能涨（Grow）、能不能缩（Shrink）、要不要无视 sizeHint（Ignore）。

顺带一个 6.9 的签名变化：`QSplitter::isCollapsible()` **收的是下标不是指针**——

```text
  g++: error: invalid conversion from 'QPushButton*' to 'int' [-fpermissive]
  note: initializing argument 1 of 'bool QSplitter::isCollapsible(int) const'
```

## 三、stretch 与 policy 一起决定分配，下限来自 minimumSizeHint

同一个 600px 窗口、`QHBoxLayout`，`setContentsMargins(0,0,0,0)` + `setSpacing(0)`，三个控件全 `Expanding`：

| 配置 | 结果宽 | 解读 |
| --- | --- | --- |
| stretch=(1,2,3) | **100 / 200 / 300** | 剩余空间严格按比例，1:2:3 精确到位 |
| stretch=(0,0,1) | **80 / 80 / 440** | 按钮 minimumSizeHint=80 卡住，前两个缩不动 |
| stretch=(0,0,1)，换成裸 `QWidget` | **0 / 0 / 600** | 裸 QWidget 的 minimumSizeHint 是 `-1x-1`（未定义→当 0），所以能压到 0 |
| stretch 全 0 + 三个 Preferred | 200 / 200 / 200 | Preferred 也能吃剩余空间，均分 |
| stretch=(1,0,0) + 第 1 个 Minimum | 600 / 0 / 0 | Minimum 带 Grow 位，同样吃满 |
| 三个 Ignored | 200 / 200 / 200 | sizeHint 被忽略，退化成均分 |
| 三个 Fixed | **0 / 0 / 0** | 这行用的是裸 `QWidget`（sizeHint 本身就是 0x0）；换成按钮就会按各自 sizeHint 摆 |

**结论：只有带 Grow 位的策略（Minimum/Preferred/Expanding/…）才谈伸缩，`Ignored` 与 `Minimum` 都带 Grow，真正缩不动的底线是 `minimumSizeHint()`。** 把 `QPushButton` 换成 `QWidget` 就掉到 0，这不是布局算法变了，是下限没了。

`QGridLayout` 同理，列宽 = 该列所有 item 的最大值，`setColumnStretch` 才分配剩余：

```text
  无列 stretch（500px 窗口，margin/spacing=0）: a.w=250 b.w=250 c.w=500   ← c 跨两列
  setColumnStretch(0,1) + (1,3): a.w=125 b.w=375   ← 500px 整体按 1:3 重分（125+375=500）
  布局 minimumSize=160x40 sizeHint=160x40
```

隐藏一个控件时空间会被回收，除非显式 `retainSizeWhenHidden`：

```text
  三个均分: 100 100 100
  隐藏中间那个: A=150  B 仍在 x=100 w=100 但可见=0  C=150     ← 空间被 A/C 吃掉
  sizePolicy().setRetainSizeWhenHidden(true) 后: A.x=0 A.w=100  C.x=200 C.w=100   ← B 的坑留着
```

## 四、默认 margin=11、spacing=6：嵌套是要交税的

布局自己不存这些默认值，它们来自 style：

```text
  QHBoxLayout  spacing=6   contentsMargins=(11,11,11,11)
  QVBoxLayout  spacing=-1  contentsMargins=(0,0,0,0)      ← -1 表示"每方向按 style 现算"，不是 0
  QGridLayout  spacing=-1  （6.9 没有 hSpacing()/vSpacing() 公开 getter，只有 setter 和 spacing()）
  style: PM_LayoutHorizontalSpacing=6  PM_LayoutVerticalSpacing=6  PM_LayoutLeftMargin=11  PM_LayoutTopMargin=11
```

所以**每多套一层布局，宽和高各加 22px**（左右/上下各 11）。叶子是一个固定 100x20 的按钮，实测：

| 嵌套层数（每层 margin=11） | 布局 minimumSize | 算式 |
| --- | --- | --- |
| 0 层（直接在窗口里） | **122 x 42** | 100+2x11 = 122；20+2x11 = 42 |
| 1 层 | 144 x 64 | 100+2x2x11 |
| 2 层 | 166 x 86 | 100+3x2x11 |
| 4 层 | **210 x 130** | 100+5x2x11 |
| 4 层，margin/spacing 全清 0 | **100 x 20** | 一分税都不交 |

**"窗口最小尺寸莫名其妙 210 宽"九成不是控件的锅**——`layers=4` 那行的算式和实测完全对上。`spacing` 在纯垂直/水平链里不进宽度，但每加一层就把高度也吃掉 22px。

装第二个布局会被**静默拒绝**，这是最难查的一类 bug：

```text
  给已有 HBox 的 w 再 setLayout(v): w.layout() 仍是 HBox ? 1   v->parent() 是 w ? 0
  往被拒绝的那个 v 里 addWidget 后: b 的几何=100x30@(0,0)   w 的 minimumSize=0x0
```

`v` 没被接管、也没报错，`addWidget` 照样成功，但控件从此不归布局管——表现就是"我明明加了布局，控件却待在 (0,0)"。

## 五、sizeHint 失控的四个常见嫌疑人

**① 不换行的长文本。** 25 个中文短语拼成一个 `QLabel`：

```text
  不换行: sizeHint=1800x12  minimumSizeHint=1800x12  hasHeightForWidth=0
  开 wordWrap: sizeHint=480x54  minimumSizeHint=12x12  hasHeightForWidth=1
  heightForWidth(300)=82   heightForWidth(100)=264   （单短语宽 72，行高 12）
```

不换行时 **1800 同时是 sizeHint 和 minimumSizeHint**——它会把整个窗口顶成 1800 宽且缩不下去。开 `setWordWrap(true)` 后底线塌回 12px，代价是布局必须回头问 `heightForWidth()`，宽 100 时要 264 高。**这就是"给 label 加不加 wordWrap 会改变窗口最小宽度"的全部原因。**

**② `QStackedWidget` 被最宽的页面顶住。**

```text
  两个 80 宽按钮的页：sizeHint=80x20  当前页宽=150  非当前页 isVisible=0
  再加一个长按钮页后：sizeHint=98x20          ← 藏着的页面照样参与尺寸协商
```

**③ `QSplitter` 把手是实打实的宽度。**

```text
  400px 窗口：handleWidth=4，两半各 198（198+198+4=400）
  setSizes({300,100}) -> 实测 297/99（把手占掉 4）
  左块 setMinimumWidth(250) 后强设 {50,350} -> 250/146   ← 最小尺寸赢过 setSizes
  再设 {10,390} -> 250/146（childrenCollapsible=1 也救不了，因为不是 collapse 而是 min 卡住）
```

**④ `QScrollArea` 的 `setWidgetResizable`。**

```text
  resizable=0（widget 固定 800x600，视口 200x200）: 视口=184x184  widget=800x600  水平滚动条可见=1   ← 16px 给了两条滚动条
  resizable=1（widget 非固定尺寸）: widget=198x198 = 视口  滚动条可见=0
```

## 六、常用控件的信号语义：程序化 vs 用户操作

下表全部是**信号计数器**（与负载无关），每行是一次独立操作后的增量：

| 操作 | 实测增量 |
| --- | --- |
| `QCheckBox::setChecked(true)` | `clicked=0 toggled=1 stateChanged=1 checkStateChanged=1` |
| `QCheckBox::click()` | 四个计数各再 +1（`clicked` 只有这条会加） |
| 紧接着再 `setChecked(true)`（同值） | `clicked` 仍 0、`toggled` 仍 1 —— **同值不重复发**（表里是累计计数） |
| `setCheckState(Partial)` | `toggled` 不变、`stateChanged`/`checkStateChanged` 各 +1——**toggled 只认 true/false 的翻转** |
| 聚焦后按 Space | `clicked=1 toggled=1 stateChanged=1`（不聚焦时 `clicked=0`，键被丢掉） |
| `QSpinBox::setValue(11)` | `valueChanged=1 textChanged=1`；**重复设同值：全静默** |
| `stepUp()` / 聚焦后 Up 键 | 都 `valueChanged=1 textChanged=1` |
| `setMinimum(50)` 把现值 11 夹住 | `valueChanged=1 现值=50`——**改边界也会发信号** |
| `setReadOnly(true)` 后 `setValue(60)` | `valueChanged=1 现值=60`，只读不拦程序化写入 |
| `QLineEdit::setText("hello")` | `textChanged=1 textEdited=0 editingFinished=0` |
| 模拟敲两个键 | `textChanged=2 textEdited=2` |
| 回车 | `returnPressed=1 editingFinished=1`；随后**失焦不再重复发** `editingFinished` |
| `QComboBox::addItem("A")` | `currentIndexChanged=1 currentTextChanged=1`（-1→0 自动选中） |
| `addItems({"B","C"})` | `currentIndexChanged=0`（后续项不动指针） |
| `setCurrentIndex(2)` | `currentIndexChanged=1` 但 **`activated=0`** |
| `QSlider::setValue(50)` | `valueChanged=1 sliderMoved=0 actionTriggered=0` |
| 聚焦后两次右箭头 | `valueChanged=2 actionTriggered=2 sliderMoved=0` |
| 模拟按下+拖动+抬起 | `valueChanged=1 actionTriggered=1`，而 `pressed/moved/released` 三个 QAbstractSlider 信号都是 0 |
| `QPushButton::animateClick()` | `clicked` 在调用后 **98 / 117 / 108 ms** 到达（3 次，设计值 100ms），且 `pressed=1 released=1 toggled=1` 全套走一遍 |
| `setDefault(true)` + 窗口显示后按 Return | `clicked=1`；再按 Space 累计 `clicked=2` |
| 按钮上挂 `QShortcut Ctrl+K` | 全局发键时 `clicked 增量=0`——挂在按钮上的 shortcut 需要窗口激活 |

两条红线：**程序化 `setCurrentIndex`/`setValue` 不会发 `activated`/`sliderMoved`**，想区分"用户改的"和"代码改的"，只有 `activated`、`sliderMoved`、`textEdited` 这三个信号可以依赖；**`QAbstractSlider::pressed/released` 用 sendEvent 模拟鼠标拖动时并不发**（`actionTriggered` 会发），别拿它们当"用户开始拖"的钩子。

## 七、焦点顺序与 Tab 导航

先把两个概念分开：**`nextInFocusChain()` 的环包含所有子控件（哪怕不可聚焦）**，而 Tab 走的是"可聚焦子集"。同一窗口里几何上 X 在最右（x=300）、Y 中间、Z 最左，创建顺序 Z→Y→X，另加 NoFocus / disabled / hidden 三个：

```text
  全链: [X Y Z Nof Dis Hid]              ← 顺序跟创建顺序走，和几何位置无关
  可聚焦子集: [Z Y X]                     ← Tab 实际在这三个里转
  QWidget::setTabOrder({X,Y,Z}) 后从 X 按 4 次 Tab: [Y Z X Y]
  从 Z 按 Shift+Tab 2 次: [X Z]           ← Backtab 沿环反向
```

- **Tab 顺序默认等于创建顺序**，跟拖到哪儿没关系。想让"从左到右"就是 Tab 顺序，必须显式 `setTabOrder()`（或反过来按视觉顺序创建控件）。
- `setTabOrder(A,B)` 是把 B **插到 A 之后**，不是交换；插错顺序会走出看起来多了一圈的链（前一版探针实测 `setTabOrder(Y,W)` 后沿环走 5 步得到 `Z->Y->X->Z->Y`）。
- `NoFocus`、`setEnabled(false)`、`hide()` 的控件仍在环里，但 Tab 会跳过（上面那次"可聚焦子集 `[Z Y X]`"就是在有 Nof/Dis/Hid 三个控件的情况下量出来的）。
- **窗口 `show()` 之后 new 出来的子控件**：`isVisible=0 isHidden=1` 但已经进了焦点环（实测环 `[A B]`）。补一句 `b->show()` 之后，从 A 按 3 次 Tab 得到 `[B A B]`——**动态添加的控件要么显式 `show()`，要么交给布局管**，否则它在环里占位却看不见。
- 默认 focusPolicy：`QPushButton=11(Strong)`、`QToolButton=1(Tab)`、`QLabel=0`、`QLineEdit=11`、`QComboBox=15(Wheel)`、`QSpinBox=15`、`QSlider=11`、`QCheckBox=11`。**`QToolButton` 是 Tab 而不是 Strong，所以点它不抢焦点**——这是工具栏按钮"点完继续敲快捷键"的实现基础。

`Qt::FocusPolicy` 数值备忘：`NoFocus=0 TabFocus=1 ClickFocus=2 StrongFocus=11 WheelFocus=15`。

## 八、`sizeConstraint`：窗口到底能不能被用户拖

给同一个装 3 个按钮（内容尺寸 132x70，尺寸提示 232x70）的窗口换四种约束，`show()` 后再 `resize(600,400)`：

| `QLayout::SizeConstraint` | show 后 | resize(600,400) 后 | minimumSize | maximumSize |
| --- | --- | --- | --- | --- |
| `SetDefaultConstraint` | 232x70 | **600x400** | 132x70 | 无限 |
| `SetMinimumSize` | 232x70 | 600x400 | 132x70 | 无限 |
| `SetFixedSize` | 232x70 | **232x70**（改不动） | 232x70 | 232x70 |
| `SetNoConstraint` | 232x70 | 600x400 | **0x0** | 无限 |

`SetDefaultConstraint` 只锁最小值、不锁最大值；`SetFixedSize` 同时把 min 和 max 设成 sizeHint，**副作用是窗口边框的缩放把手也没了**。`SetNoConstraint` 把 minimumSize 清零，用户可以把窗口拖到比内容还小、内容被裁掉——除非你要自绘滚动，否则别用。

## 九、布局重算花多少钱

每轮的"最好值"（3 轮取 min，`QElapsedTimer`，`-O2`，offscreen），n 个 `QPushButton` 进一个 `QVBoxLayout`：

| n | `addWidget` 累计 | show + 首次布局 | 改宽 1px 后重排 |
| --- | --- | --- | --- |
| 250 | 1039 µs（**4.16 µs/个**） | 6839 µs（27.4 µs/个） | 6222 µs（24.9 µs/个） |
| 500 | 1897 µs（3.79 µs/个） | 14235 µs（28.5 µs/个） | 11738 µs（23.5 µs/个） |
| 1000 | 4052 µs（**4.05 µs/个**） | 25577 µs（**25.6 µs/个**） | 24656 µs（24.7 µs/个） |

三个量都是**线性**的：`addWidget` 每次约 4 µs、首次布局每控件约 26 µs、重排每控件约 25 µs。**1000 个控件的窗口，光布局就要 26 ms**——这就是"上千行表单别用布局硬堆、改 `QTableView` + delegate"的量化理由。`addWidget` 阶段不派发 `LayoutRequest`（实测 500 次同步派发 0 次，事件循环转起来才累计 1 次），所以逐个 `addWidget` 不会把事件队列刷爆，但会在第一次 `show()` 时一起结算。

## 十、Qt 6.9 的删改：这一节的编译报错原文

以下每条都是 `g++ -std=c++17 -fsyntax-only` 单独跑出来的**第一行原文**，不是文档抄的：

```text
  Qt::DefaultTimer                     error: 'DefaultTimer' is not a member of 'Qt'
  QRegExp                              fatal error: QRegExp: No such file or directory
  QString::SkipEmptyParts              error: 'SkipEmptyParts' is not a member of 'QString'   → 用 Qt::SkipEmptyParts
  QFormLayout::AllFieldsGrow           error: 'AllFieldsGrow' is not a member of 'QFormLayout' → 只剩 AllNonFixedFieldsGrow(=2)
  QFormLayout::formStyle()             error: 'class QFormLayout' has no member named 'formStyle'   （只有 setFormStyle，没有 getter）
  QGridLayout::hSpacing()/vSpacing()   同样没有公开 getter，只有 spacing()
  QFontMetrics::width(QString)         error: 'class QFontMetrics' has no member named 'width' → horizontalAdvance()
  QApplication::desktop()              error: 'desktop' is not a member of 'QApplication'      → QScreen 拿几何
  QRegExpValidator                     error: expected type-specifier before 'QRegExpValidator'
  QLayoutWidget                        error: expected type-specifier before 'QLayoutWidget'   → 用 QWidget + setLayout
  QSplitter::isCollapsible(QWidget*)   error: invalid conversion from 'QPushButton*' to 'int'  → 参数是 int 下标
  qAsConst(container)                  warning: 'qAsConst' is deprecated: Use std::as_const() instead   ← 只是警告，照旧能编
```

另外 `QDialogButtonBox`/`QMenu`/`QStatusBar` 的一批 getter 消失，见本系列下一节。

## 十一、本节未在本机实测的内容

- **真实 DPI 与缩放**：`offscreen` 平台报告的 geometry 是逻辑像素，`QT_SCREEN_SCALE_FACTORS`/`QT_ENABLE_HIGHDPI_SCALING` 下同一份代码的 62x20 会整体缩放，需要接真显示器验证，本机无头环境测不出可信数字。
- **Windows 原生 style（`windowsvista`）下的 sizeHint**：本机 `platformName=offscreen` 时 style 固定为 **fusion**，`PM_LayoutLeftMargin=11`、按钮 80x20 这些是 fusion 的值；换成 windows 平台后 `SH_*` 由 QVistaStyle 给出，表格要整张重测。
- **鼠标真实点击路径**：第六节的"模拟按下+拖动+抬起"是 `QApplication::sendEvent` 注入的 `QMouseEvent`，`pressed/released` 不发；真实鼠标下 QAbstractSlider 自己会发，这条差异只能靠有窗口的环境确认。
- **QML/Quick 的布局**：本节的 `sizeHint`/`stretch` 语义全属 Widgets，QML 的 Layout 附加属性另说。
