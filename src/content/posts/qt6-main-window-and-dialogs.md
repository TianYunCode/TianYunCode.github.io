---
title: Qt 6 主窗口体系与对话框
description: 实测：800x600 的 QMainWindow 五区几何逐区量过；藏掉 dock 中央区从 514 涨到 600；模态拦的是平台输入路由，不是 Qt 的派发层。
date: 2026-10-16
tags: [Qt, QMainWindow, QDialog, QSettings, 模态]
category: qt6
section: qt-mainwindow-dialog
---

> 环境同上一节：**Qt 6.9.3 for MinGW** + GCC 13.1.0（全路径，PATH 上那个 Strawberry Perl 4.9.2 32 位 g++ 会得出错误结论），`-O2 -DNDEBUG`，`QT_QPA_PLATFORM=offscreen` 无头跑，只读 `geometry()`/`sizeHint()`/字节数/计数，不截图。style 为 fusion。所有 Qt 6.9 的 API 删改都是 `g++ -fsyntax-only` 或整包编译时**真实报出来的错**，原文照抄。本机没有窗口管理器参与，所以与"激活/焦点在哪个原生窗口"有关的量（`isActiveWindow()`）恒为 0，下面会明确标出。

## 一、五大区域：先用几何把它们钉死

`QMainWindow` 装齐菜单条、工具栏、中央控件、三个方向的 dock、状态栏，`resize(800,600)` 后实测（offscreen，`show()` + `processEvents()`）：

| 区域 | 几何 | 说明 |
| --- | --- | --- |
| `menuBar()` | **800 x 17 @ (0,0)** | 高度固定 17，宽度永远等于窗口宽 |
| `addToolBar()` | **800 x 27 @ (0,17)** | `movable=1 floatable=1 toolButtonStyle=0 iconSize=24x24` |
| 中央 widget | **628 x 492 @ (86,44)** | x=86 = 左 dock 80 + 把手 6 |
| 左 dock | 80 x 36 @ (0,44) | 标题栏占 **16px**（36 = 内容 20 + 标题栏 16） |
| 右 dock | 80 x 36 @ (720,44) | |
| 底部 dock | **800 x 36 @ (0,542)** | 底部 dock 横跨整宽，因为它在左右 dock 下面 |
| `statusBar()` | **800 x 22 @ (0,578)** | `isSizeGripEnabled()` 默认为真 |

两条加减法把布局钉死：

```text
  横向: 80(左dock) + 80(右dock) + 628(中央) = 788，窗口 800  → 差的 12 = 2 条 6px 把手
  垂向: 17(menu) + 27(toolbar) + 492(中央) + 22(status) = 558，窗口 600 → 差的 42 = 底部 dock 36 + 把手 6
```

**dock 和中央之间那条 6px 是 `QMainWindow` 内部的 splitter**，任何"我的中央区怎么少了 6 像素"都在这里。另外 `corner(Qt::BottomLeftCorner)` 默认返回 **8（BottomDockWidgetArea）**——左下角归底部 dock，`Qt::LeftDockWidgetArea=1 Right=2 Top=4 Bottom=8`；给它设一个与该角不相邻的区域（如 `setCorner(BottomLeft, RightDockWidgetArea)`）**被静默忽略**，实测仍是 8。

`takeCentralWidget()` 返回原指针并把中央清空，但 **`menuBar()` 和 `statusBar()` 不会被销毁**：实测 `takeCentralWidget()` 之后 `w.menuBar()` 仍非空、且和最初那个指针是同一个。

## 二、藏掉某一区，中央能多拿多少

同一套内容（中央一个按钮）开关各区，800x600 窗口实测：

| 配置 | 中央区几何 | 增量解读 |
| --- | --- | --- |
| 五区齐全 | **714 x 534 @ (86,44)** | 基线 |
| 无菜单栏 | 714 x 551 @ (86,27) | 只省 **17px**，且整体上移 |
| 无工具栏 | 714 x 561 @ (86,17) | 省 **27px** |
| 无状态栏 | 714 x 556 @ (86,44) | 省 **22px**（y 不变，说明状态栏在最下） |
| 无 dock | **800** x 534 @ (**0**,44) | 横向一下多出 **86px**（80 dock + 6 把手） |
| 只有中央 | **800 x 600 @ (0,0)** | 中央按钮也跟着变 800 宽 |

单独看 dock 的开关（600x400 窗口）：

```text
  初始:  dock=80x36  central=514x400
  d->hide(): central=600x400  dock.isVisible=0     ← 藏 dock 立刻把 86px 还给中央
  d->show(): dock=80x36 central=514x400            ← 完全可逆
  d->setFloating(true): dock=80x20 central=600x400 isFloating=1   ← 浮动后 dock 只剩内容大小
```

`QDockWidget::features` 的位值（6.9 的头文件，**没有 `DockWidgetDockable` 这个枚举**，别按老文章写）：

```text
  DockWidgetClosable=0x01  DockWidgetMovable=0x02  DockWidgetFloatable=0x04  DockWidgetVerticalTitleBar=0x08
  DockWidgetFeatureMask=0x0f  NoDockWidgetFeatures=0x00
```

`dockWidgetArea(d)` 返回 `1`=Left（**注意：6.9 里没有 `QMainWindow::dockArea()`，写上去编译报错**）。两个 dock 叠在左侧时是上下排列：`d1=62x36@(0,0)`、`d2=62x36@(0,42)`（42 = 36 + 6px 把手），中央 532x300。`tabifyDockWidget(d1,d2)` 后中央缩到 **471x300**，但 offscreen 下 `d1.isVisible` 和 `d2.isVisible` **同时为 1**——tab 组的互斥可见性由真实窗口系统给，本机测不到，见第十节。

## 三、`saveState()/restoreState()`：存的是 objectName

```text
  2 个 dock + 1 个工具栏（都给了 objectName）：saveState() = 177 字节
  把字节流里的可打印字符抽出来：包含 "dock1"=是  "dock2"=是  "tb1"=是
  另一个窗口（故意把 dock1 放右侧）restoreState(那 177 字节) 返回 1，dock1 被搬到 x=0（左侧）
```

`restoreState()` 返回 `bool`——**它只在"存进去的字节里有这个 objectName"时才成功**，所以工具栏/dock/菜单动作没设 objectName 就等于没存。前 4 字节是 `0x00 0x00 0x00 0xff`：版本 0 + `quint8` 的"字节序标志 0xff"（Qt 用它记录写入端的字节序，跨架构读回时会翻转）。

## 四、状态栏：`showMessage` 的 timeout 是"活多久"而不是"多久后出现"

```text
  showMessage("m", 0)   ：立即出现，149 ms 后仍在   ← 0 = 常驻
  showMessage("m", 50)  ：立即出现，200 ms 后已消失
  showMessage("m", 500) ：立即出现，649 ms 后已消失
```

控件几何（500x22 状态栏）：

```text
  statusBar=500x22  sizeHint=128x22
  addWidget(NORM)      -> x=2   w=48   （左侧）
  addPermanentWidget(PERM) -> x=428 w=48   （右侧）
  showMessage("temporary text here") 之后 PERM 仍在 x=428  ← 常驻控件位置不动，临时消息只吃中间的空档
```

**`addWidget` 与 `addPermanentWidget` 的区别就是"进度条该放哪"**：中间那块会被任何 `showMessage` 挤掉，右侧那块不会。状态栏高度恒为 22px（fusion + 9pt）。

工具栏的按钮几何：`actionGeometry(A)=44x19`（在 500x27 的工具栏里），`addAction` 两次得到 2 个 action、没有隐式分隔符。

## 五、QDialog：exec 的返回值，以及 6.9 的类型陷阱

```text
  QTimer 里 d.accept() → d.exec() 返回 int=1，耗时 29–30 ms，d.result()=1
  d.reject()          → 返回 0
  d.done(3)           → 返回 3        ← 结果码是任意 int，不是只有 0/1
```

Qt 6.9 的编译取证（这三条是很多人按旧文章写会踩的）：

```text
  int r = dlg.exec();                     [OK]  —— 6.9 的 exec() 声明就是 int
  QDialog::Result r = dlg.exec();         error: 'Result' is not a member of 'QDialog'
  QDialog::DialogCode r = dlg.exec();     error: invalid conversion from 'int' to 'QDialog::DialogCode' [-fpermissive]
```

**别写 `QDialog::DialogCode r = dlg.exec();`**——`Accepted=1/Rejected=0` 这两个枚举值还在，但 `exec()` 的返回类型是 `int`，严格类型的编译器（MSVC）会直接拒绝。`done(int)` 是最通用的出口，`accept()`/`reject()` 只是 `done(1)`/`done(0)` 的语法糖。

`QDialogButtonBox` 的 role 数值（实测 `(int)` 输出）：

```text
  AcceptRole=0  RejectRole=1  DestructiveRole=2  ActionRole=3  HelpRole=4  YesRole=5  NoRole=6  ResetRole=7  ApplyRole=8
```

按钮排布（fusion / 从左到右方向，实测各按钮 `x()`）：

```text
  Ok|Cancel                     -> [OK(206)  Cancel(292)]           按钮宽 80 / 86
  Yes|No|Cancel                 -> [Cancel(292)  &Yes(120)  &No(206)]  ← Cancel 不在最右！
  Save|Discard|Cancel|RestoreDefaults -> [Save(212) Cancel(402) Discard(298) Restore Defaults(0)]
  只有 HelpRole 一个按钮时 accepted=0 rejected=0 clicked=0   ← HelpRole 谁都不触发
  再加 Accept+Reject：ok->x=20  help->x=198   ← 加了标准 role 后 HelpRole 被挪到最右，AcceptRole 到左边
  点 OK：accepted 增量=1，clicked 增量=1（clicked 永远会发，accepted/rejected 只认 role）
```

三个要点：① 标准按钮文本带助记符（`&Yes`、`&No`），自己 `addButton("Yes", YesRole)` 就没有 `&`；② **`clicked` 和 `accepted/rejected` 是两条不同的信号**，用 `connect(box, &QDialogButtonBox::accepted, dialog, &QDialog::accept)` 才是标准接法；③ 6.9 的 `QDialogButtonBox` **没有 `buttons(role)` 重载、也没有 `buttonLayoutDirection()` getter**：

```text
  error: no matching function for call to 'QDialogButtonBox::buttons(QDialogButtonBox::ButtonRole)'
  error: 'class QDialogButtonBox' has no member named 'buttonLayoutDirection'
```

只有无参 `buttons()`（返回 `QList<QAbstractButton*>`，按视觉顺序）和 `buttonRole(b)`。同理 `QMenu` 有 `setPopupMode()` 却没有 `popupMode()` getter；`QStatusBar` 的 getter 叫 **`isSizeGripEnabled()`**（`sizeGripEnabled()` / `isSizeGripVisible()` 都是编译错误）。

对话框自己的尺寸约束（对照上一节）：

```text
  dialog=200x100 内部按钮=178x20 layout minimumSize=144x42
  layout()->setSizeConstraint(SetFixedSize) 后 dialog=144x42   ← 被顶成 minimumSize
  QDialog 本身没有 setSizeConstraint()（error: 'class QDialog' has no member），必须调 layout 的
  sizeGripEnabled 在 QDialog 上默认=0，但 QMainWindow 的 statusBar 上=1
```

## 六、模态拦的到底是什么

先给能测的：

```text
  A) 在 d->exec() 的循环内部（定时器回调里）往父窗口的按钮 sendEvent Space：
     mode=NonModal      ：activeModalWidget=dlg  focusWidget=D  父按钮 clicked=1
     mode=WindowModal   ：activeModalWidget=dlg  focusWidget=D  父按钮 clicked=1
     mode=ApplicationModal：activeModalWidget=dlg focusWidget=D 父按钮 clicked=1
  B) setModal(true) + show()（不进 exec）：
     d1.isModal=1  QApplication::activeModalWidget()==&d1 ? 1
     d1.hide() 后：activeModalWidget 变回空
  C) 只用 setWindowModality(...) + show()（不 exec、不 setModal）：
     WindowModal / ApplicationModal 时 isModal=1，但 activeModalWidget() 认不出这个对话框
```

结论有两条，而且第二条最容易出事：

1. **`exec()` 和 `setModal(true)+show()` 都会把对话框登记成 `activeModalWidget`；单纯 `setWindowModality()+show()` 不会。** 也就是说"我设了 ApplicationModal 啊"这句话在 Qt 内部并不等于"它现在是活动模态窗口"，`QApplication::activeModalWidget()` 只认前者。
2. **三种模态都拦不住程序化投递的事件**——`sendEvent`/`postEvent` 到别的窗口的控件照样触发 `clicked`。模态是**平台输入路由层**（窗口系统不给别的窗口送鼠标键盘）实现的，不是 Qt 在 `notify()` 里过滤的。所以任何"我设了模态，所以后台代码不会误触发主窗口"的假设都不成立；要防的是自己写的代码，得靠 `setEnabled(false)` 或标志位。

顺带：offscreen 下 `parent.isActiveWindow()` 和 `d.isActiveWindow()` **恒为 0**（没有窗口管理器），真实环境里"另一个窗口点不动"这条没法在本机取证。

## 七、菜单与快捷键

```text
  menuBar 高=17；'File' 这个 action 的 actionGeometry=56x17@(6,0)（左右各 6px padding）
  QMenu sizeHint=555x102，6 行 action 的高度合计正好 102：
    [New 555x20@0,0] [Open 555x20@0,20] [分隔符 555x2@0,40] [Verbose 555x20@0,42]
    [Recent 555x20@0,62] [Quit 555x20@0,82]
  → 普通项 20px、分隔符 2px、子菜单也只是一行 20px（它的 menuAction()->text()="Recent"）
  再加一行 action：sizeHint 变 555x122（+20）
  fm->popup(QPoint(50,50))：aboutToShow 计数=1，弹出后 pos=(50,50) size=555x122；hide() 后 aboutToHide=1
```

- **`addAction()` 可以在菜单已经 `popup()` 之后调**，实测 `actions()` 从 6 变 7；这是懒加载子菜单的实现基础，但视觉刷新要靠 `aboutToShow`。
- **菜单项图标大小在 6.9 无从下手**——`QMenu` 和 `QAction` 两级的 icon size 接口都没了：

```text
  error: 'class QMenu' has no member named 'iconSize'; did you mean 'setIcon'?
  error: 'class QMenu'   has no member named 'setIconSize'
  error: 'class QAction' has no member named 'setIconSize'
```

  只能靠 style 的 `pixelMetric`：本机 `PM_SmallIconSize=16 PM_LargeIconSize=32 PM_MenuButtonIndicator=12`（子菜单箭头占 12px）。
- **快捷键**：`QKeySequence("Ctrl+N")` 存进去、`shortcut().toString()` 原样读回 "Ctrl+N"。给 action 设 `setShortcutContext(Qt::ApplicationShortcut)` 后，向主窗口 `sendEvent` 一个 `QKeyEvent(Key_N, ControlModifier)`，`triggered` **计数=1**（能命中）；但 `Qt::WindowShortcut`（默认）下把同一个事件发给别的窗口就命中不了。按钮上直接挂的 shortcut，在窗口未激活时实测 `clicked 增量=0`。
- `QMenu::separatorsCollapsible()` 默认 **1**（连续分隔符会收起来）、`toolTipsVisible()` 默认 **0**（菜单项的 toolTip 不显示，要显示得显式开）。

## 八、QMessageBox：静态函数的返回值与助记符

```text
  QMessageBox::information(nullptr,"t","body") 被一个 5ms 的 singleShot 里 done(0) 关掉，调用点返回耗时 13 ms
  Question 框 setStandardButtons(Yes|No|Cancel) + setDefaultButton(No)：
     button(Yes)->text()=[&Yes]  button(No)=[&No]   defaultButton() 就是 No 那个指针 =1
  iconPixmap() 非空=1  informativeText 默认空=0  detailedText 默认空=0
  windowFlags=0x8003103，含 Qt::Dialog 位
```

`QMessageBox::question()` 的返回值 **可以赋给 `int`**（`StandardButton` 是无作用域枚举，隐式转换合法），但 `QMessageBox::button(which)` 返回的是 `QAbstractButton*`，想 `->text()` 就别写成 `QPushButton*`：

```text
  error: invalid conversion from 'QAbstractButton*' to 'QPushButton*' [-fpermissive]
```

**静态弹窗函数在 offscreen 下必须外部 `done()`/`reject()`**，否则 `exec()` 永远不返回——自动化测试里标准做法是 `QTimer::singleShot(0, msgBox, &QMessageBox::reject)`。

`QDialog` 的键盘行为有三条容易翻车的红线，这里一并记下（本系列前面踩过）：对话框布局里的按钮 **`autoDefault` 默认 true**，焦点落在某个按钮上时按 Enter 会在 **KeyRelease** 上点击它；**`setDefault(true)` 的按钮是所有未被消费的 Enter 的归宿**，所以"打印/删除/覆盖保存"这类有代价的动作不能当默认按钮；谁能收到键取决于焦点在哪个 widget，`QListWidget` 选中一行时画布根本收不到 Delete。

## 九、QSettings：字节、格式与两个坑

`QSettings(路径, QSettings::IniFormat)` 写 5 个键后 `sync()`，**文件 79 字节**，原文逐行：

```ini
[ui]
geometry=@ByteArray(abc)
split=a, b, c
count=42
ratio=1.5
flag=true
```

- `QStringList` 序列化成 **逗号+空格**（`a, b, c`）——值里含逗号时必须用 `QStringList` 而不是自己拼字符串，否则读回来会裂。
- `QByteArray` 走 `@ByteArray(...)` 前缀；读回 `QVariant::typeId()=2`（int）/`typeName()="int"`，`geometry` 的 typeName 是 `QByteArray`，类型是自解释的。
- `flag=true` 而非 `1`（Qt 用 `true`/`false`），读回用 `toBool()`。
- 原生格式在 Windows 上是注册表：`QSettings("Qt6dTestOrg","Qt6dTestApp").fileName()` = `\HKEY_CURRENT_USER\Software\Qt6dTestOrg\Qt6dTestApp`，`format()=0`（NativeFormat）。**没设 `QCoreApplication::organizationName()` 时 `applicationName()` 会自动取可执行文件名**（本机跑 `mw1.exe` → `applicationName="mw1"`），所以发布前一定要显式 `setOrganizationName`，否则配置落在 `HKCU\Software\mw1\` 这种名字下。

**坑一：`remove()` 只改内存，落盘要 `sync()`。** 实测：

```text
  写 3 键 bytes=20 allKeys=3
  remove("g/b") 之后（还没 sync）：内存 allKeys=2 contains(b)=0   但文件仍是 20 字节
  sync() 之后：文件 15 字节；重新打开 allKeys=2 = [g/a,g/c]
```

**坑二：`setValue(key, QVariant())` 不是删除。** 官方文档的说法容易让人以为传个无效 QVariant 就等价于 `remove()`，实测正好相反：

```text
  setValue("g/a", QVariant()) + sync() 后重开：allKeys=2 = [g/a,g/c]   文件涨到 24 字节
  文件原文：|[g]||a=@Invalid()||c=3||
  value("g/a").isValid()=0   toString() 读回空串
```

它写了一行 `a=@Invalid()`，键还在（`contains()` 仍为真），文件反而变大。**要删就用 `remove()`。**

其他与负载无关的常量：

```text
  QSettings::Status 只有三个值：NoError=0 AccessError=1 FormatError=2
      （error: 'LockError'/'UndeterminedError' is not a member —— 老文章里的名字 6.9 已无）
  把一个 ini 设成只读再写：sync() 后 status=1(AccessError)，文件内容一个字节没变（原样 [g]/k=1）
  Format 枚举：NativeFormat=0 IniFormat=1 InvalidFormat=16（CustomFormat 在 6.9 已被删，编译报错）
  Scope：UserScope=0 SystemScope=1
  setDefaultFormat 收的是 QSettings::Format，传字符串是编译错误（cannot convert 'QString' to 'QSettings::Format'）
```

写 5 个键 + `sync()` 的耗时本机 20 ms（含文件 IO 与可能的杀软扫描），**别在 UI 线程高频 sync()**，`QSettings` 自带约 3 秒的缓存续期，但显式 `sync()` 是同步阻塞的。

## 十、本节未在本机实测的内容

- **多显示器 / 高 DPI 下的主窗口布局**：offscreen 只有一个虚拟屏幕，`QScreen::geometry()` 拿不到真实分辨率与缩放；dock 尺寸在不同 DPI 下会按逻辑像素等比放大，需要接真显示器重测。
- **原生窗口激活语义**：`isActiveWindow()` 在本机恒为 0，"ApplicationModal 时别的窗口点不动"这条只能靠真实窗口系统验证；本节只能证明 **Qt 的事件派发层不拦程序化投递的事件**（第六节）。
- **`tabifyDockWidget` 后 tab 条的互斥可见性**：offscreen 下 `d1` 与 `d2` 的 `isVisible` 同时为 1，tab 头的几何与切换行为未取到可信数值。
- **原生对话框与原生菜单**：`QFileDialog::getOpenFileName`、`QMessageBox` 在 Windows 上默认走原生实现，本机 `platformName=offscreen` 只会走 Qt 自己的实现，二者的按钮顺序、`DontUseNativeDialog` 的实际差异未测。
- **`restoreState()` 跨 Qt 版本兼容**：字节流第 0 字节是版本号，本节只在同机同版本（6.9.3 → 6.9.3）验证往返成功，跨 6.x 小版本能否读回未测——需要另装一个 Qt 版本。
- **注册表实写**：`QSettings` 的 NativeFormat 只读取了 `fileName()` 字符串，没有真往 `HKCU` 写键，避免污染机器环境。
