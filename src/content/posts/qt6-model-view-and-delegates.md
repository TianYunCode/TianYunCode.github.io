---
title: Qt 6 模型/视图与委托
description: 实测：20000 行 x 4 列，QTableWidget 填 42.5–45.3 ms、净增 17.5–17.9 MB（每格 228–234 B），同一份数据自定义 QVector<Rec> 模型只要 183–226 µs、0.64 MB（每格 8–9 B）；但 20000 行挂上 QTableView 后一次重绘只花 1309–1725 µs、只问 364 次 data()——首屏和总行数无关；delegate.sizeHint 的宽精确等于"文本宽 + 6"（0/1/2/4/8/16 字符全部命中），带勾选框再 +20 宽 +2 高；SizeHintRole=(0,40) 不会自动改行高（rowHeight 仍是 30），只有 resizeRowsToContents() 才变 41，而这一步在 20000 行上要 571 ms；fillRect 放在 QStyledItemDelegate::paint 之前会被 BackgroundRole 盖掉（实测 (1,1) 读到 (255,0,0) 而不是蓝）；QSortFilterProxyModel 按 DisplayRole 排 1..12 得到 "1 10 11 12 2 3…"，同列同序再调 sort() 是 0 µs 直接 return 所以光改 setSortRole 看不到效果；50000 行改一次过滤串 15.7–16.1 ms，挂上视图后同一次改动变 100.3 ms。
date: 2026-10-16
tags: [Qt, 模型视图, 委托, QModelIndex, QSortFilterProxyModel]
category: qt6
section: qt-model-view
---

> 环境同本系列前面几节：**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ GCC 13.1.0 全路径（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`，PATH 上那个 Strawberry Perl 4.9.2 32 位 g++ 会得出错误结论），`-O2 -DNDEBUG`，`QT_QPA_PLATFORM=offscreen` 无头跑，style 为 **fusion**、字体 `Sans Serif` 9pt。**不截图**：所有结论来自打印出来的数值——`rowCount()`、`sizeHint()` 的宽高、`QImage` 上某个坐标的 RGBA、`RSS` 字节差、`QElapsedTimer` 的 µs、以及 `paint()`/`data()`/`filterAcceptsRow()` 的**调用计数**。内存与耗时类数字受本机负载影响（同期还有别的任务在抢核），所以内存给 3 轮的区间、耗时给"3 轮取最好或单次实测"，**比值比绝对值可靠**；枚举值、字节数、调用次数与负载无关，可当硬事实。所有 Qt 6.9 的 API 删改都是 `g++ -fsyntax-only` / 整包编译时真实报出来的错，原文照抄（第五节集中贴）。探针代码、原始输出留在 `%TEMP%/agents/qt6e/mv*.out`。

## 一、先算清楚"硬堆 QTableWidget"到底堆了什么

同一份数据（20000 行 x 4 列，每格一个短数字串），三种写法，**同一个进程里预热一轮之后**连做 3 轮，`GetProcessMemoryInfo().WorkingSetSize` 做差分：

| 写法 | 填充耗时（3 轮） | RSS 净增 | 每格字节 | `sizeof` 对象本体 |
| --- | --- | --- | --- | --- |
| `QTableWidget` + 每格 `new QTableWidgetItem` | 42494 / 43453 / 45277 µs | **17.46–17.88 MB** | **228–234 B** | 64 B |
| `QStandardItemModel` + 每格 `new QStandardItem` | 44933 / 47793 / 49439 µs | 17.98–18.82 MB | 235–246 B | 16 B（d 指针另算） |
| 自定义 `QAbstractTableModel`，数据是 `QVector<Rec>`（`sizeof(Rec)=32`） | **183 / 217 / 226 µs** | **0.64–0.66 MB** | **8–9 B** | 模型对象 16 B |

**内存差 25 倍、填充时间差约 200 倍**，这才是"别硬堆"的第一条理由。注意 `sizeof(QTableWidgetItem)=64` 只是对象头，228 B/格是"头 + 内部 QString/variant 存储 + 分配器取整"的实际结果；`QStandardItem` 对象只有 16 B，但每个都要额外一次堆分配存 d 指针，最后每格反而更贵（235–246 B）。

第二条理由容易记错，所以我专门去测了**它其实不成立的那一半**：

```text
  QTableWidget.insertRow(0)  2000 行: 0.76 µs/次   20000 行: 1.33 µs/次   50000 行: 0.66 µs/次
  QTableWidget.insertRow(0)（已 show 出来）: 0.85 / 1.49 / 1.61 µs/次
  自定义模型 begin/endInsertRows 未挂视图: 0.03 / 0.04 / 0.03 µs/次
  自定义模型 begin/endInsertRows 挂视图:   0.80 / 0.79 / 0.79 µs/次
```

"QTableWidget 插一行要把所有 item 重排一遍"这个说法**在本机 6.9.3 上不成立**：0.7–1.6 µs，看不出随行数增长。同样地，`QTableView` 挂 20000 行的自定义模型，一次整视图 `render()` 是 **1309–1725 µs**，和挂 `QTableWidget` 的 **1880 µs** 没有数量级差别——因为**只画放得下的那十几行**：

```text
  60 行 x 5 列的模型，视口 276x168（行高 16，其中第 2 行被显式设成 70）：
  一次 view.render(): delegate.paint() 被调 24 次
  paint 见过的 row 范围=[0..7]，col 范围=[0..2]  -> 8 行 x 3 列 = 24 格  ✓ 严格等于可见格
  模型总格数=300
```

所以"硬堆"的真实代价是三件事：**每格一个堆对象的内存**、**填充/序列化的时间**、以及**数据不在你手里**（第 3 条见下）。不是"卡首屏"。

第 3 条的实测证据：`insertRow(0)` 之后行号与 item 的对应关系整体下移，我预埋在第 5 行的 `R5` 那个格子变成了空——

```text
  QTableWidget 无视图 20000 行: row5 文本 R5 -> （空）    行数现在=20300
```

想按"业务行号"找数据，你得自己维护映射；而自定义模型里 `setData`/`data` 直接对上你自己的 vector 下标。另外 `QTableWidget` **不能塞进 `QTableView::setModel()`**：

```text
  error: cannot convert 'QTableWidget*' to 'QAbstractItemModel*'
```

它是视图不是模型（`QTableWidget : QTableView`），这点老文章里混用的写法在 6.9 直接编不过。

## 二、通知发出去之后发生了什么（以及一个被编译器骗到的坑）

| 操作（20000 行模型，视图已显示） | 实测 |
| --- | --- |
| `dataChanged(index(3,0), index(3,3))` x1000 次，**无视图** | 0.010 µs/次 |
| 同上，**有视图** | 0.160 µs/次，期间 `data()` 被问 **0 次** |
| 有视图但改的是看不见的第 19999 行 | 0.096 µs/次，`data()` 仍是 0 次 |
| 1000 次"只改内部数据、不发信号" | 0.00 µs/次 ← **这个数是假的** |

前三行说明：`dataChanged` 只做标脏 + 排队，**一次都不会回头问你的数据**，重画要等事件循环转起来。第四行是反面教材：那个 0 µs 是编译器把整个循环当死代码删了。对照做了才发现：

```text
  20000 次只写不读=12.30 us   写+读回来=24.90 us   （写循环本身没被删，但"读"才是不可省的那半）
```

结论：**微基准里凡是"写完不读"的循环，测出的 0 一律不可信**，我在第四节把代理的测量全部改成"先算完存进变量、再打印"，就是为了躲开 `printf` 参数求值顺序这个坑（第一版就中招了，见 4.2）。

## 三、`QModelIndex` 到底是什么：24 字节的坐标，不是句柄

```text
  sizeof: QModelIndex=24  QPersistentModelIndex=8  QVariant=32
          QAbstractItemModel=16  QAbstractTableModel=16  QTableWidgetItem=64  QStandardItem=16
```

一个最小可用的表模型（3 列）实测：

```text
  rowCount()=6  rowCount(index(0,0))=0  columnCount()=3
  index(2,1): valid=1 row=2 col=1 internalPointer=0000000000000000 internalId=0 parent().isValid=0
  index(2,1,非空parent) valid=0          // 表模型必须对任何 parent 返回 invalid
  index(6,0) valid=0  index(0,3) valid=0  index(-1,0) valid=0     // 越界是 invalid，不是崩
  hasChildren(index(0,0))=0  hasChildren(根)=1
```

四条语义就钉死了：**`rowCount(parent)`/`columnCount(parent)` 是"每个父节点各自的行列数"**，表模型对任何有效 parent 都给 0（这正是它"不是树"的表达方式，而不是报错）；越界永远返回 invalid 的 index；顶层 index 的 `parent()` 是 invalid QModelIndex；`internalPointer()` 是你自己塞进去的东西——我在树模型里塞了个 `999`，读回来就是 `999`：

```text
  TREE: rowCount(root)=3 rowCount(top)=2 top.internalPointer=0000000000000000
        kid.internalId=999  kid.parent().row=0  kid.parent().isValid=1
```

而**代理模型的内部指针给了你也没用**：

```text
  proxy.index(0,0): row=0 col=0 internalPointer=000001fd5af77b60  -> mapToSource row=0
  跨模型比较 proxyIdx==srcIdx: 0
  同 row/col 不同模型: a==b ? 0    a.model()==b.model() ? 0
```

`QModelIndex::operator==` 连 model 指针一起比，所以代理的 index 和源的 index 就算行列一样也不相等；那个 `000001fd…` 是 `QSortFilterProxyModel` 内部的 `Node`，你既不能解引用也不该存下来。

### 裸索引 vs 持久索引（经典 bug 的可复现版）

```text
  insertRow(0) 后: 裸索引 row=5 指向的数据=a4   （原来这一行是 a5）
                 持久索引 row=6 指向的数据=a5
  removeRow(它自己) 后: per.isValid=0 per.row=-1   裸索引 row=5
```

裸 `QModelIndex` 就是 `(row, col, 指针)` 三元组，插一行之后它还指着"第 5 行"，但那已经是别的数据了——**不报错、不失效、静默指错**。要跨结构变化存位置，只能 `QPersistentModelIndex`；它只有 8 字节（一个 d 指针），代价是注册进模型的持久索引表，**别拿它当数组用**（第四节里视图选择丢失的修复思路就是它）。

`QPersistentModelIndex` 在 Qt 6 还少了一个构造方式：

```text
  error: no matching function for call to 'QPersistentModelIndex::QPersistentModelIndex(QAbstractTableModel*, int, int)'
```

只能 `QPersistentModelIndex(model.index(r,c))`。

### 角色与标志位的真值（别按 Qt4/5 的顺序背）

```text
  ROLES: Display=0 Edit=2 ToolTip=3 StatusTip=4 WhatsThis=5 Decoration=1 Font=6 TextAlignment=7
         Background=8 Foreground=9 CheckState=10 AccessibleText=11 SizeHint=13 UserRole=256
  FLAGS: NoItemFlags=0 Selectable=1 Editable=2 DragEnabled=4 DropEnabled=8 UserCheckable=16
         Enabled=32 NeverHasChildren=128 UserTristate=256
  表模型默认 flags(有效 index)=161   = Selectable|Enabled|NeverHasChildren
  普通 QAbstractItemModel 默认=33    = Selectable|Enabled   （没有 NeverHasChildren）
  flags(无效 index)=0
```

**默认 flags 里没有 `ItemIsEditable`**。这直接导致一个非常难查的"什么都不发生"：

```text
  flags=33(不含 Editable)  view->edit(index(1,0)): indexWidget=0000000000000000  commitData=0
  补上 ItemIsEditable 后 edit(): 编辑器=QExpandingLineEdit  几何=99x29@0,30
```

`edit()` 不调 `createEditor`、不发信号、不打警告，静静什么都不做。同理 `Qt::ItemIsUserCheckable` 不给，勾选框点了也不发 `setData`。

`data()` 里没用到的角色要返回**空 QVariant**，实测视图对未实现角色的取值行为是 `isValid=0`、`toString().isNull()=1`；`DisplayRole` 返回 `int` 是合法的，`QStyledItemDelegate` 会用视图的 locale 转成串（第六节的 `displayText` 那步，实测 `option.text` 从 `int 300` 变成 `"300"`）。

顺带把 `QVariant` 走 `QDataStream` 的字节数量了（做拖放/自定义 mime 时会用到）：

```text
  int(42)=9  bool=6  double=13  QString("hello")=19  QString(3 个中文)=15  QDate=13  空=5
```

固定头 5 字节，`QString` 是 **长度(4)+2 字节/字符**（所以中文按 UTF-16 计，不额外膨胀）。

## 四、自定义 delegate：绘制、编辑器、以及三个反直觉点

### 4.1 `sizeHint()` 的公式是"文本宽 + 6"

一列、fusion、Sans Serif 9pt（`fm.height()=12`），逐格实测：

| DisplayRole 文本 | `fm.horizontalAdvance` | `delegate.sizeHint` | 宽 − 文本宽 |
| --- | --- | --- | --- |
| 0 字符 | 0 | **6 x 12** | 6 |
| 1 字符 | 12 | 18 x 12 | 6 |
| 2 字符 | 24 | 30 x 12 | 6 |
| 4 字符 | 48 | 54 x 12 | 6 |
| 8 字符 | 96 | 102 x 12 | 6 |
| 16 字符 | 192 | 198 x 12 | 6 |

**宽 = 文本宽 + 6，高 = 行文字高**，精确成立。加上 `CheckStateRole` 变成 `218 x 14`（+20 宽、+2 高：勾选框 14x14 + 边距），加一个**空的 `QIcon()`** 不加宽（`198 x 12`）——null 图标不占位。`view.iconSize()` 默认是 `-1x-1`（没设过），delegate 会退到 style 的 `PM_SmallIconSize=16`。

**`SizeHintRole` 不会自动改行高**，这是本节最值钱的一条：

```text
  无 SizeHintRole:  rowHeight(0)=30  vheader defaultSectionSize=30  sizeHintForRow(0)=15
  模型给 SizeHintRole=(0,40) 且 view.reset() 后: rowHeight(0)=30  sizeHintForRow(0)=41
  resizeRowsToContents() 后: rowHeight(0)=41 rowHeight(5)=41  vheader sectionSize(0)=41
  收回 SizeHintRole 并再 resizeRowsToContents(): rowHeight(0)=16  delegate.sizeHint=54x12
  显式 setRowHeight(2,70): rowHeight(2)=70 其余=16
```

行高来自**竖表头的 section 尺寸**，默认是 `defaultSectionSize=30`（固定模式）；`SizeHintRole` 只影响 `sizeHintForRow()` 的返回值，**只有你调 `resizeRowsToContents()`（或把表头设成 ResizeToContents）才会被采纳**。而且注意第 4 行：一旦调过，行高就从 30 变成按内容算的 16，**回不去 30 了**。

这个调用有多贵？

```text
  60 行:   resizeRowsToContents()=1657 us
  20000 行: resizeRowsToContents()=571557 us   ← 半秒，它要问遍每一行
  同规模一次整视图 render 只要 1309 us
```

**"每次数据变化都 resizeRowsToContents"在两万行上就是 571 ms 的卡顿**，比任何单次绘制都贵两个数量级。

### 4.2 `paint()` 入口拿到的 option 是"视图级快照"

`QStyledItemDelegate::paint()` 内部会先 `initStyleOption()` 再交给 style 画。如果你重写 `paint()` 并**直接用传进来的 `option`**，读到的是没灌数据的快照：

```text
  row0: 入口 text=[] features=0 font=9pt bg=(0,0,0,255)  |  init 后 text=[x0y0] features=8 font=9pt bg=(0,0,0,255)
  row1(BackgroundRole 红): 入口 bg=(0,0,0,255)  init 后 bg=(255,0,0,255)
  row2(FontRole 14pt bold): 入口 font=9pt  init 后 font=14pt
  DisplayRole 返回 int(300) 时，init 后 option.text=[300]（type=int）
```

所以想在自绘里拿到本格的文本/字体/背景/图标，**必须自己调 `initStyleOption(&opt, index)`**（它是 `protected`，只能在 delegate 子类里调），别在 `paint()` 开头读 `option.text`——那是空的。`features` 也从 0 变成 `8`（`HasDisplay`）。

### 4.3 自绘底色的顺序：fillRect 放在 base paint 之前会被盖掉

在 `QImage` 上画完读像素（`Format_ARGB32`，格子 120x40，白底）：

```text
  自绘列（fillRect 蓝 + base paint + 画绿线）: 中心 (60,20)=(0,128,255,255)  右边界 (119,20)=(0,255,0,255)  左边界 (0,20)=(0,128,255,255)
  同一行、模型给了 BackgroundRole=红 的第 1 列: (1,1)=(255,0,0,255)  中心=(255,0,0,255)  右边界=(0,255,0,255)
  走默认 paint 的第 2 列: (1,1)=(255,0,0,255)
```

蓝色被红色**完全覆盖**（`(1,1)` 和中心都是 255,0,0），只有 base paint **之后**画的绿线活下来。规则很直白：`QStyledItemDelegate::paint()` 会先把整格按 `BackgroundRole`/palette 填一遍，**任何垫底自绘必须放在它后面**。

`state` 位还会悄悄改色：

| `option.state` | 格子中心 (75,20) 的 RGBA | 左上 (2,2) |
| --- | --- | --- |
| `Enabled(1)` | (255,0,0,255) | (255,0,0,255) |
| `Enabled|Active(65537)` | (255,0,0,255) | (255,0,0,255) |
| `Enabled|HasFocus(257)` | **(231,17,24,255)** | (232,21,29,255) |
| `initFrom(viewport)` 原样(65793) | (231,17,24,255) | (232,21,29,255) |
| `Enabled|Selected(32769)` | **(48,140,198,255)** | (48,140,198,255) |
| `Enabled|Selected|HasFocus(33025)` | (48,141,199,255) | (49,144,204,255) |
| `Enabled|Sunken(5)` | (255,0,0,255) | (255,0,0,255) |
| 对照：row0 无 BackgroundRole，`Enabled` | (255,255,255,255) | (255,255,255,255) |

三点要记住：**① `HasFocus` 会让 fusion 把你的颜色调暗（255,0,0 → 231,17,24），你按"我设了纯红"去校验像素会失败；② `Selected` 时 `BackgroundRole` 被 palette 的 `Highlight=(48,140,198,255)` 整个盖掉；③ 手工 `initFrom(viewport)` 得到的 state 是 65793（含 `HasFocus`+`Active`），和"选中前"想当然的 1 不一样。**

`view.render()` 一次的像素对照（视口 502x282，列宽被 `resizeColumnsToContents()` 收成 16/83/83/103）：

```text
  viewport (1,1)=(251,251,251,255)   第 0 格右下角(15,20)=(249,249,249,255)   第 1 格中心(40,20)=(255,255,255,255)
  palette: Base=(255,255,255) Window=(239,239,239) Highlight=(48,140,198) HighlightedText=(255,255,255) Text=(0,0,0)
```

`(249,249,249)` 是网格线，`(251,251,251)` 是表头边——**别以为 (0,0) 是第一个格子的左上角**。

### 4.4 编辑器的生命周期

`view.edit(index(1,1))` 之后（模型给了 `ItemIsEditable`）：

```text
  createEditor=1  setEditorData=1  updateEditorGeometry=2      ← 几何被问两次，别假设一次
  编辑器几何=82x29@16,30   visualRect(index)=82x29@16,30       ← 默认 updateEditorGeometry 就是贴 visualRect
  setEditorData 灌的是 EditRole（"C1R1"），不是 DisplayRole（"c1r1"）
  默认工厂给的编辑器类名=QExpandingLineEdit
```

提交/撤销的语义（每行都是独立跑出来的计数）：

| 操作 | 结果 |
| --- | --- |
| 编辑器里按 Enter | `commitData=1 closeEditor=1 hint=3(SubmitModelCache)`，`setData` 收到 `role=2 val=[C1R1!]` |
| 按 Esc | `commitData=0 closeEditor=1 hint=4(RevertModelCache)`，`setData` 增量 0 |
| 编辑中 `setCurrentIndex()` 切到别的行 | `setData` 增量=0，**编辑器还在**（没提交也没关） |
| 编辑中 `setModel(nullptr)` | `setData` 增量=**1**（提交进旧模型，不是丢弃） |
| 编辑中 `view.hide()` | `setData` 增量=1 |
| 编辑中 `setModel(同一个模型)` | `setData` 增量=0 |

`hint=3/4` 对应 `QAbstractItemDelegate::EndEditHint{NoHint=0,EditNextItem=1,EditPreviousItem=2,SubmitModelCache=3,RevertModelCache=4}`。**换模型是"提交"而不是"回滚"**，这条最容易踩：编辑到一半刷新整个数据源，半截内容会被写进旧模型。

另外，视图上那两个看着最合适的信号其实连不上：

```text
  error: 'virtual void QAbstractItemView::commitData(QWidget*)' is protected within this context
  error: 'virtual void QAbstractItemView::closeEditor(QWidget*, QAbstractItemDelegate::EndEditHint)' is protected within this context
```

要观测提交，只能连**委托**的 `QAbstractItemDelegate::commitData/closeEditor`。同一批"降级为 protected/不存在"的还有 `QAbstractItemView::state()`、`closeEditor()`、`viewOptions()`（见第五节）。

### 4.5 勾选框的命中矩形比格子小得多

```text
  格子 rect=99x29@0,0
  不置 HasCheckIndicator 时 subElementRect(SE_ItemViewItemCheckIndicator)=0x0@0,0    ← 完全没位置
  置了 HasCheckIndicator + checkState 后 = 14x14@3,7     (PM_IndicatorWidth=PM_IndicatorHeight=14)

  点格子正中 (49,14):   editorEvent 收到，setData=0 次
  点指示器中心 (9,13):  setData=1 次  role=10(CheckStateRole) val=2(Checked)
  点格子右上角（离指示器 82 px）: setData=0 次
```

两件事：**① 想拿勾选框位置，option 里必须置 `HasCheckIndicator`（和 `checkState`），否则 style 给你一个 0x0；② 默认 delegate 只在 14x14 的框里响应点击**，点格子的其它地方什么都不发生——用户抱怨"点勾选列点不中"就是这个。要整格可点，就在 `editorEvent()` 里自己判 `QEvent::MouseButtonRelease` 并调 `model->setData(index, ..., Qt::CheckStateRole)`。

### 4.6 一个本机没测出差异的点

`view.setTextElideMode()` 在格子比文本窄时到底省不省略，我用两种办法都没测出区别：

```text
  ElideRight/ElideLeft/ElideMiddle/ElideNone  四种，60px 格子里 240px 文本：墨点数都是 84，x=59 列都没有墨
  option.widget 传 viewport 与传视图本身：墨点数都是 84
```

墨点 84 ≈ 5 个字符的笔画——说明**文本是被裁掉的，不是被省略号化的**，但我无法在本机证明"什么时候才会真的出现 `nam…`"（`QFontMetrics::elidedText("name-0", ElideRight, 60)` 单独调是能拿到 `nam…` 的）。这条列进第六节未实测。

## 五、QSortFilterProxyModel：排序错乱、过滤的账、以及懒执行的坑

### 5.1 按 `DisplayRole` 排序 = 按字符串排序

同一份数据，col0 把数字给成 `QString`、col1 给成真 `int`：

```text
  源数据 1..12 以 DisplayRole=QString 给，按 col0 升序前 12 行: 1 10 11 12 2 3 4 5 6 7 8 9
  同一份数据（打乱的 400 行）：按字符串列前 6 行=[0 1032 1050 1068 1086 1124]
                              按 int  列前 6 行=[0 37 56 74 92 130]
  sort(col0) 2000 行: 3039 us  lessThan 被问 20758 次
  sort(col1) 2000 行:  319 us  lessThan 被问 13781 次   ← 同样的比较次数，字符串比较贵 10 倍
```

修法：把数字放进 `EditRole`/`UserRole` 这类**带真实类型**的角色，然后 `setSortRole(那个角色)`；或者重写 `lessThan()`。但有个坑：

```text
  再 sort 同列同序: 0 us  lessThan=0   ← 直接 return，什么都不干
  setSortRole(UserRole) 后只调 sort(0)（列和序都没变）: 顺序原样不动
  改成 UserRole + 先 sort(0,Desc) 再 sort(0,Asc) 逼它重排: 前 6 行=[0 37 56 74 92 130]（模型没给 UserRole，key 全空）
```

**光调 `setSortRole()` 不会重排**，必须让排序指示器发生变化（或者 `invalidate()`）。而 `sortRole` 指向一个模型不提供角色时，所有 key 都是空 QVariant、比较全等，顺序就跟显示文本再无关系（上表里它恰好等于按 col1 数字排出来的序）。

### 5.2 过滤的账：第一次是懒的，之后每次同步全额

10000 行、`filterKeyColumn(0)`、`filterFixedString` 逐次测量（计时只包住 setter 本身，随后单独读 `rowCount()`）：

| 操作 | 10000 行 | 50000 行 |
| --- | --- | --- |
| **第一次** `setFilterFixedString("12")` | **4 µs**（随后第一次 `rowCount()` 才把 10000 行问完） | **2 µs**（问行 50000） |
| 改成不同的串 `"123"` | **3429 µs**，问行 +10000，`rowsAboutToBeRemoved` +21 | **16138 µs**，问行 +50000，rem +101 |
| **重复设同一个串** `"123"` | **3207 µs**，问行 +10000，**0 个行信号** | **15978 µs**，问行 +50000 |
| `invalidateFilter()` | 3189 µs，问行 +10000 | 15658 µs，问行 +50000 |
| 清空过滤串 | 343 µs（回到 10000 行） | 3181 µs（回到 50000 行） |
| **同一个改动，视图已 show** | **7755 µs**，插入/删除信号增量 2211 | **100265 µs**，信号增量 11058 |

五条能落地的结论：

1. **`setFilterFixedString()` 第一次只置脏**（4/2 µs），真正的匹配推迟到下一次查询；之后再改就是**同步全量重过滤**。写代码时不要把"第一次很快"当成"过滤很便宜"。
2. **同值不短路**：把同一个串再设一遍照样跑 3.2–16 ms。搜索框的 `textChanged` 必须自己 debounce（或者比较一下 `filterRegularExpression().pattern()` 再决定要不要设）。
3. `invalidateFilter()`（数据变了但过滤条件没变时用的那个）**和重设过滤串同价**——它是全量重过滤，不是增量。
4. **清空过滤串比设置过滤串便宜 10 倍**（343 vs 3429 µs）：因为不需要挪行。
5. **挂上视图才是贵的那一步**：50000 行一次按键 100 ms，信号增量 11058 条——这是插入/删除区间通知，视图要在里面维护几何。**这是过滤框卡顿的真实来源**，不是代理的字符串比较。

每行的代价也量出来了：首轮过滤是 `filterAcceptsRow()` 每行 1 次 + `source.data()` 每行 1 次（实测 10000/10000）。**从已过滤状态再改一次串时，同一批行会被重问一遍**（另一次独立探针实测：10000 行的第二次过滤 `data()` 累计 20000、`filterAcceptsRow()` 20000）。所以**过滤列的 `data()` 一定要 O(1)**：在里面做 `QString::arg`、查 map、跑正则的话，这每行 1~2 次调用就是主要成本。

`dynamicSortFilter` 的开关在这两种测法下**对过滤成本没有任何影响**（只影响"数据变化后要不要自动重排"）：

```text
  关 dynamicSortFilter 后 invalidateFilter(): 与开着一样的问行数、同样的量级耗时
```

（第一版探针把这里测成"67 µs，和重设串一样贵"，是 `printf` 参数从右往左求值，把计数器在懒执行之前读走造成的假数字。修正为"先算完存变量、再打印"后才是上表。）

### 5.3 代理自身的花费与几个必须知道的语义

```text
  50000 行 sort(col1) 建立映射后 RSS 增量 = 425984 字节 = 每行 8.5 B
  10000 次 mapToSource(proxy.index(i,1)) = 390–573 us  -> 0.039 us/次
  10000 次 proxy.index(i,1)               = 198 us      -> 0.020 us/次，期间 source->index() 被问 0 次
  视图重绘：挂代理 666 us / source.data() 378 次；换成裸模型 645 us / 378 次  -> 绘制路径上代理只加价 3%
```

`proxy.index()` **不会**下探到源模型去建索引（源 `index()` 计数 0），映射表在代理自己手里，所以每格 0.02 µs；重绘路径上的加价可以忽略。真正花钱的地方是 5.2 里的"改一次过滤串"。

选择和越界的行为：

```text
  选中代理第 3 行（源第 3 行）→ 过滤 "1" → 当前代理行=0，源行=0    （选中悄悄跑了，不报错）
  proxy.index(999999,0).isValid=0   mapToSource 后 row=-1
  filterKeyColumn(-1)（所有列参与）在 50000 行匹配 "name-7": rowCount=5666
  再加 CaseInsensitive 匹配 "AAA": rowCount=42857
```

**过滤/排序会静默改变"代理第 N 行"的含义**，想保住用户选中的那一行，得存 `QPersistentModelIndex`（它跟着代理走）或者存**源索引 + 你自己的业务主键**，别存行号。`sortColumn()`/`sortOrder()`/`dynamicSortFilter()`/`sortRole()`/`filterRole()` 这些 getter 在 6.9 都是齐的（实测 `sortColumn()=1 sortOrder()=1 dynamicSortFilter()=1 sortRole()=0 filterRole()=0`）。

同族另外三个代理（`QIdentityProxyModel`、`QTransposeProxyModel`、`QConcatenateTablesProxyModel`）在本机只是编译链接通过；`QColumnFilterProxyModel` **在这个 6.9.3 MinGW 包里不存在**：

```text
  error: 'QColumnFilterProxyModel' was not declared in this scope; did you mean 'QSortFilterProxyModel'?
```

## 六、Qt 6.9 的删改：本节全部编译报错原文

以下每一条都是 `g++ -std=c++17 -fsyntax-only` 对 `mv6.cpp` 单独报出来的（一行一个探针），不是文档抄的：

```text
  Qt::BackgroundColorRole          error: 'BackgroundColorRole' is not a member of 'Qt'; did you mean 'BackgroundRole'?
  Qt::IconRole                     error: 'IconRole' is not a member of 'Qt'                     → 用 DecorationRole(=1)
  Qt::ItemIsTristate               error: 'ItemIsTristate' is not a member of 'Qt'; did you mean 'ItemIsUserTristate'?
  Qt::ItemIsUserEditable           error: 'ItemIsUserEditable' is not a member of 'Qt'; did you mean 'ItemIsEditable'?
  model->hasChildren(index)        error: 'virtual bool QAbstractTableModel::hasChildren(const QModelIndex&) const' is private within this context
  model->parent(index)             error: 'virtual QModelIndex QAbstractTableModel::parent(const QModelIndex&) const' is private within this context
  model->beginInsertRows(...)      error: 'void QAbstractItemModel::beginInsertRows(const QModelIndex&, int, int)' is protected within this context
  model->beginResetModel()         error: 'void QAbstractItemModel::beginResetModel()' is protected within this context
  QModelIndex i = model->match(...) error: no match for 'operator=' (operand types are 'QModelIndex' and 'QModelIndexList' {aka 'QList<QModelIndex>'})
  view->viewOptions()              error: 'class QTableView' has no member named 'viewOptions'
  view->sizeHintForRow(0)          error: 'virtual int QTableView::sizeHintForRow(int) const' is protected within this context
  view->sizeHintForColumn(0)       error: 'virtual int QTableView::sizeHintForColumn(int) const' is protected within this context
  QAbstractItemView::Pressed       error: 'Pressed' is not a member of 'QAbstractItemView'        → EditTrigger 里没有它
  QAbstractItemDelegate::EditCommitHint  error: 'EditCommitHint' is not a member of 'QAbstractItemDelegate'  → 只剩 EndEditHint
  connect(view, &QAbstractItemView::commitData, ...)  error: 'virtual void QAbstractItemView::commitData(QWidget*)' is protected within this context
  view->closeEditor(...)           error: 'virtual void QAbstractItemView::closeEditor(QWidget*, QAbstractItemDelegate::EndEditHint)' is protected within this context
  view->state()                    error: 'QAbstractItemView::State QAbstractItemView::state() const' is protected within this context
  view->itemDelegate(index)        warning: deprecated: Use itemDelegateForIndex instead（仍然能编，会出告警）
  proxy->sortIndicator(...)        error: 'class QSortFilterProxyModel' has no member named 'sortIndicator'
  proxy->isDynamicSortFilter()     error: has no member named 'isDynamicSortFilter'; did you mean 'dynamicSortFilter'?
  proxy->invalidateFilter()        error: 'void QSortFilterProxyModel::invalidateFilter()' is protected within this context
  proxy->filterFixedString()       error: has no member named 'filterFixedString'; did you mean 'setFilterFixedString'?   ← 只有 setter，读不回来
  proxy->setMultiColumnSort(true)  error: 'class QSortFilterProxyModel' has no member named 'setMultiColumnSort'
  QColumnFilterProxyModel          error: was not declared in this scope; did you mean 'QSortFilterProxyModel'?
  header->resizeMode()             error: 'class QHeaderView' has no member named 'resizeMode'; did you mean 'ResizeMode'?  ← 只有 setter
  QItemSelectionModel::merge(...)  error: 'class QItemSelectionModel' has no member named 'merge'
  model->mimeTypes()               error: conversion from 'QList<QString>' to non-scalar type 'QList<QByteArray>' requested  ← 返回类型变了
  view->setIndexRange(a,b)         error: 'class QTableView' has no member named 'setIndexRange'; did you mean 'setIndexWidget'?
  view->setTabKeyNavEnabled(b)     error: 'class QTableView' has no member named 'setTabKeyNavEnabled'; did you mean 'setTabKeyNavigation'?
  QVariant::type()                 warning: deprecated: Use typeId() or metaType()
  QPersistentModelIndex(model,r,c) error: no matching function（只剩 QModelIndex 版构造）
  QTableView* 传 setModel         error: cannot convert 'QTableWidget*' to 'QAbstractItemModel*'
```

三个"只有 setter、读不回来"的坑特别值得一提：`QSortFilterProxyModel::filterFixedString`、`QHeaderView::resizeMode`、`QAbstractItemModel` 系列里被降级的 `hasChildren/parent`。想读状态只能自己缓存或走 `property("…")`。

## 七、本节未在本机实测的内容

- **`setTextElideMode` 的实际省略行为**：4.6 那组墨点数在四种 elide 模式、`option.widget` 传 viewport 与传视图两种情况下**全部相同（84）**，无法判断省略号何时出现；要确认得在有真实字体后端与窗口系统的平台上重测（`elidedText` 本身能拿到 `nam…`，但走 style 的绘制路径没复现出差异）。
- **`QTextBrowser`/富文本 delegate、`QWidget` 型 indexWidget（`setIndexWidget`）的布局交互**：本节只测了 `createEditor` 的默认工厂路径。
- **`QGraphicsView` 里嵌 item view（`QGraphicsProxyWidget`）**：与第 7 节《绘图体系》一起说，本机未测。
- **真实鼠标/键盘路径下的提交时机**：第四节全部是 `QApplication::sendEvent` 注入 `QKeyEvent`/`QMouseEvent`，`Enter`/`Esc`/点击命中都是程序化事件；真实输入法（IME 组合中按 Enter）、双击、拖框选择未测。
- **`windowsvista` 原生 style 下的 delegate 像素**：`offscreen` 平台固定 fusion，上表 (48,140,198) 这个 Highlight 是 fusion 调色板；换原生风格后色值、勾选框 14px、`+6` 的边距都要重测。
- **高 DPI / 分数缩放下的行高列宽**：`+6`、14x14、`defaultSectionSize=30` 都是 96dpi 逻辑像素下的值，本机无真实显示器，`QT_SCREEN_SCALE_FACTORS` 下的值未测。
- **多列排序 / `setRecursiveFilteringEnabled` 的行为**：`QSortFilterProxyModel::setMultiColumnSort` 在本机这个构建里直接不存在（见第五节报错），递归过滤只在头文件里见到声明，未在树模型上跑通。
- **超大表（>10⁵ 行）**：为控制单次实验时长，内存与过滤只测到 20000/50000 行；10⁶ 行的 RSS 与 `filterAcceptsRow` 全量扫描时间未测，别把上面的 µs 线性外推。
- **跨线程的模型/视图**（`QAbstractItemModel` 必须在 GUI 线程）属于第 9 节《Qt 多线程》。
