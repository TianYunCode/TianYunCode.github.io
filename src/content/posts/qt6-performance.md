---
title: Qt 6 性能与卡顿诊断
description: 实测：1000 次 update() 只触发 1 次 paint，repaint 每次 50µs；1000 次 resize 94ms；release 下 qDebug 被 QT_NO_DEBUG 编译掉。
date: 2026-10-16
tags: [Qt, 性能, 卡顿, 重绘, update, 启动优化]
category: qt6
section: qt-performance
---

> 环境：Windows 11 x64，**Qt 6.9.3 for MinGW**，GCC 13.1.0，release（`-O2 -DNDEBUG`），`QT_QPA_PLATFORM=offscreen` 无头跑。计时 `QElapsedTimer`。**注意 release 构建默认带 `-DQT_NO_DEBUG`，`qDebug()` 被编译掉**——本文探针统一 `fprintf(stderr,…)`（这是"我在 release 里加的日志怎么不输出"的第一嫌疑）。探针 `%TEMP%/qt3p_*`。offscreen 平台下没有真实合成器，**绝对耗时比真机低，但合批/计数类语义与真机一致**。

## 一、卡顿的分类：先判是哪一种，再决定动谁

UI 卡顿在 Qt 世界里只有三种病，症状不同、药方不同：

| 病 | 机理 | 症状 | 本篇对应 |
| --- | --- | --- | --- |
| **事件循环阻塞** | 主线程被同步代码占住（磁盘、锁、Sleep、死循环） | 整个窗口冻结，定时器、动画、输入全停 | 第二节 |
| **重绘风暴** | paint 次数或单次成本失控 | 窗口响应但掉帧、拖动残影、CPU 占满 | 第三、四节 |
| **布局/数据过重** | 控件数量、模型行数、布局嵌套超过每次事件的预算 | 特定操作（打开大表、滚动）卡，其他时候正常 | 第五节 |

**定位顺序**：先确认是不是阻塞（定时器还能不能准时响），再数 paint 次数，最后才怀疑绘制成本。**90% 的"Qt 卡"是第一种，而大多数优化动作在做第三种**——顺序反了就会在错误的层级雕花。

## 二、阻塞：一个定时器就能抓住现行

判断主线程是否被阻塞，不需要调试器：挂一个 10 ms 的 `QTimer`，打印实际到达间隔。到达间隔从 10 ms 涨到 500 ms，说明主线程在这 500 ms 里被别的东西占着——拿 `QElapsedTimer` 在可疑操作前后打点即可定位区间。这个手法 qt-event 那节实测过（忙等 200ms 错过 20 个 tick）。

阻塞的常见来源，按出现频率：

1. **主线程做 IO**：读文件、`QNetworkAccessManager` 的同步等待、数据库查询。解法：丢到 worker 线程（qt-thread 那节的骨架）。
2. **主线程等锁**：等一个工作线程持有的 `QMutex`。解法：重新设计所有权，或换 `Qt::BlockingQueuedConnection` 语义想清楚。
3. **`processEvents()` 滥用**：在长任务里手动泵事件来"保活界面"——它会把重入、状态机混乱一并泵进来（qt-event 那节量过每层重入 13.3KB 栈）。
4. **单次 paint 太贵**：这不是阻塞但表现像——`paintEvent` 里做了几百毫秒的活，事件循环被一个事件占满。区分方法：卡的时候定时器**还能准时响**（说明循环没死，是单个事件贵）。

## 三、update() 与 repaint()：合批是 Qt 送给你的礼物

实测（Canvas 800×600，`paintEvent` 里画 100 条线）：

```
1000 次 update() 调用本身: 0 ms（亚毫秒）
1000 次 update() → 实际 paint 事件数: 1
20 次 repaint() → 20 次 paint，共 1 ms，每次 50 µs
1000 次 resize() → 94 ms，期间 paint 数: 1
```

三个数字对应三条铁律：

1. **`update()` 只是标记脏区，不画**。1000 次 `update(QRect)` 的调用成本亚毫秒，Qt 把脏区合并，**回到事件循环时只发一个 paint 事件**。所以"我在循环里 update 了 1000 次"从来不是卡顿的原因——除非你每次都手动 `QApplication::processEvents()` 把合批拆了。
2. **`repaint()` 立即同步绘制，绕过合批**。20 次 repaint = 20 次 paint，每次 50 µs。它只应在"必须马上看到结果"的场景用（拖拽中的 rubber band、游戏主循环），**业务代码里用 repaint 一律按 bug  review**。
3. **`resize()` 触发布局，比 update 贵两个数量级**：1000 次 94 ms（每次约 94 µs，要跑一遍布局系统）。**"重绘风暴"很多时候是布局风暴**——`setFixedSize`/`resize` 在循环里被反复调。批量改尺寸先 `setUpdatesEnabled(false)` 包起来，或一次算好最终尺寸再设。

推论：**卡顿时先数 paint**。在 `paintEvent` 里加计数（release 下用 `fprintf` 或原子计数器），如果"一帧里 paint 了 50 次"，问题在有人直刷或疯狂 invalidate；如果"一帧只 paint 1 次但 200 ms"，问题在单次绘制成本（第三节药方：减少绘制物、缓存 `QPixmap`、用 `QOpenGLWidget`）。

## 四、单次 paint 的降本手段（按收益排序）

1. **只画脏区**：`paintEvent` 的 `QPaintEvent::region()` 是真正脏的区域。全屏重画 800×600 的 `fillRect` 在 offscreen 下几十微秒，但真实窗口带合成器、带半透明时就是几百微秒——用 `event->rect()` 裁剪是白送的收益。
2. **缓存静态内容**：不随帧变的部分（网格、背景、表头）画进一张 `QPixmap`，`paintEvent` 里一次 `drawPixmap` 贴上去。从"每帧画 100 条线"变成"贴一张图"，本文实测单次 paint 50 µs 的量级还能再降一个数量级。
3. **关掉用不到的抗锯齿和合成模式**：`QPainter::Antialiasing` 在本文的 qt-painting 实测里让 300 条线从 912 µs 涨到 2276 µs（2.5 倍）。静态图、小控件、缩略图不值得开。
4. **简单控件用 `QWidget` 别用 `QGraphicsView`**：后者适合 item 多、需要缩放旋转的场景；两三个按钮的界面上它纯属烧钱。

## 五、大数据量列表：虚拟化是唯一正解

2 万行 × 4 列的数据，两种做法的实测差距在 qt-model-view 那节：`QTableWidget` 填 42.5–45.3 ms、17.5 MB（每格 228–234 B），自定义 `QVector<Rec>` 模型 183–226 µs、0.64 MB（每格 8–9 B）；挂上 `QTableView` 后一次重绘 1309–1725 µs、只问 364 次 `data()`——**首屏成本和总行数无关**。

结论直接可用：**超过 1000 行的列表，不要用 item 类控件（`QTableWidget`/`QTreeWidget`/`QListWidget`）**，它们是"一行一个 item 对象"的非虚拟化设计，2 万行就是 2 万个 `QTableWidgetItem`。改用模型/视图：`QAbstractTableModel` + `QTableView`，`data()` 按需回答，视图只创建可见行的 delegate。深分页的数据库侧代价见 db-optimize 那节（OFFSET 99000 要 9.97 ms，键集 0.08 ms）。

## 六、启动时间：24ms 的构成与优化顺序

实测冷启动到 `main` 后：

```
QApplication 构造: 24 ms
show(): 0 ms（offscreen；真机上首次 show 会触发平台窗口创建和首次合成）
```

24 ms 的构成（offscreen 无窗口）：字体数据库初始化、样式加载（fusion）、单例构造、事件循环准备。**优化启动的三个动作按收益排序**：

1. **延迟加载**：启动路径上只做"显示首屏必须的事"。配置读取、插件扫描、历史记录加载全部丢到首屏显示之后（`QTimer::singleShot(0, …)`）。
2. **减少链接的 Qt 模块**：每多链一个模块（Network/Sql/Multimedia）就多一批 DLL 要加载——windeployqt 那节（qt-cross-platform）量过：只链 Core/Gui/Widgets 的 exe 是 91,546 字节，部署 60 个文件 79 MB。`QT += core gui widgets` 之外每加一个模块，启动时 `LoadLibrary` 和静态初始化都涨。
3. **静态注册元类型减半**：`qRegisterMetaType` 在启动期做，别在热路径；大量 `Q_INVOKABLE`/属性也会拖慢 `moc` 生成对象的元对象表构造（qt-overview 那节实测 `Q_OBJECT` 让编译 +26%）。

**量化习惯**：启动时间至少测 10 次取中位——首次运行有磁盘冷缓存，单次测量能把优化效果放大或缩小一倍。

## 七、未实测清单

- offscreen 平台下的真实 GPU 合成、`QOpenGLWidget` 的渲染路径——无头环境不涉及。
- Windows 上真实的 DWM 合成延迟、高 DPI 缩放对 paint 的影响——本文未测。
- `QLoggingCategory` 的性能过滤（按类别开关日志）——未测；推荐做法：热点路径的日志用 `qCDebug(category)` 包起来，默认关，需要时按类别开，而不是 `#ifdef` 重编译。
- 启动时间的模块级拆解（哪个 DLL 加载慢）——本文只测了总量。

诊断卡顿的完整工具链思路汇总成一句：**定时器探阻塞，计数器探重绘，QElapsedTimer 探段落，模型化探数据量**——四件事都不需要 profiler，需要的是先分类再动手。
