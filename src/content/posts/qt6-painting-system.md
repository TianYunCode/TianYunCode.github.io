---
title: Qt 6 绘图体系
description: 实测：QRectF(0,10.4,50,4) 落在第 10–13 行、10.5 落 11–14（四舍五入）；cosmetic 画笔 2px 在 scale(4) 下仍只占 2 个设备像素，而非 cosmetic 的 3px 笔被缩到 0.75px 时整条线消失；抗锯齿把 40x40 圆的边缘从 α=255 变成 244/243、非空像素 1240→1316，300 条线的绘制从 912 µs 涨到 2276 µs（2.5 倍）；dpr=2 的 QImage 上 fillRect(10,10,5,5) 真的落在设备像素 [20..29]x[20..29] 共 100 个；QT_SCALE_FACTOR=2 让 offscreen 屏幕几何从 800x800 变 400x400、devicePixelRatio 变 2.00，但 QFontMetrics 一个数都没变；QGraphicsView 一次 render 只画 12 个 item（10000 个里），视图放大 2 倍后降到 7 个、耗时从 370 µs 变 62 µs；不设 sceneRect 时 sceneRect() 是 O(n)（50000 item 要 12.3 ms），显式设了之后 0.30 µs。
date: 2026-10-16
tags: [Qt, QPainter, QGraphicsView, 抗锯齿, 高DPI]
category: qt6
section: qt-painting
---

> 环境同本系列前面几节：**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ GCC 13.1.0 全路径（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`），`-O2 -DNDEBUG`，`QT_QPA_PLATFORM=offscreen`。**不截图**：所有绘制结论都是把东西画进 `QImage` 之后**读像素**得到的（RGBA / alpha / 墨点行数 / 墨盒范围），耗时是 `QElapsedTimer` 的 µs（3 轮取最好），绝对值受本机负载影响、比值更可靠；`fillRect`、墨盒坐标、枚举值与负载无关，可当硬事实。两条本机特有的前提要先说清：**① 离屏平台的字体度量本身是退化的（第 3.3 节给证据），凡是和"文字有多高"有关的数字都要带着这条读；② 本机没有真实显示器，高 DPI 只能靠环境变量喂给 offscreen，能验证 Qt 内部的一致性，验证不了"接上 4K 屏会怎样"。**Qt 6.9 的 API 删改全部是编译报错原文（第七节）。

## 一、坐标：取整、viewport/window、裁剪

### 1.1 小数坐标怎么落到像素格

`QRectF(0, y, 50, 4)` 用纯红 `fillRect`，扫 8..18 行看哪些行有值：

```text
  y=10.0 -> 有墨的行 10 11 12 13
  y=10.4 -> 有墨的行 10 11 12 13
  y=10.5 -> 有墨的行 11 12 13 14
  y=10.6 -> 有墨的行 11 12 13 14
  y=10.9 -> 有墨的行 11 12 13 14
```

**起点是四舍五入（.5 往上走）**，不是向下取整。想让 1px 的分隔线永远落在你预期的那一行，就传整数坐标；传 `x + 0.5` 会让它整体挪一行——这就是"画不出 1px 细线"的真相的一半，另一半在第三节（画笔宽度）。

### 1.2 viewport / window 是设备坐标的映射框

```text
  画布 200x200，setWindow(QRect(0,0,1200,1200)) + setViewport(QRect(10,10,60,60))，填 window 全域：
  (9,9)=(0,0,0,0)  (10,10)=(0,0,255,255)  (40,40)=(0,0,255,255)  (69,69)=(0,0,255,255)  (70,70)=(0,0,0,0)
  新建 painter：clipBoundingRect=(0,0,0,0) viewport=(0,0,200,200) window=(0,0,200,200)
  setClipRect(30,30,40,40) 后：clipBoundingRect=(30,30,40,40)，画满幅只留下 x30..x69（x29 与 x70 全空）
  setClipping(false) 再画满幅：x29=(0,0,255,255) x30=… x69=…  <- 裁剪整个关掉
```

三条：**viewport/window 是整数设备像素框，映射精确到边界外一格**（60 格宽填 10..69）；**新建 painter 的 `clipBoundingRect()` 是空矩形 `(0,0,0,0)`，含义是"没有裁剪"**，别把它当成"裁剪到 0x0"；`clipBoundingRect()` 是 Qt 6 里唯一能读回裁剪范围的入口（**无参的 `QPainter::boundingRect()` 已经不存在**，见第七节）。

顺带一个离屏位图的坑：

```text
  QImage(120x120).logicalDpiX=0.0  physicalDpiX=0.0  devicePixelRatio=1.00
```

**位图没有 DPI**（0.0），所以任何用 `QPaintDevice::metric()` 做物理尺寸换算的代码，在 `QImage` 上都会拿到 0，得自己传。

### 1.3 变换的墨盒（10x10 的实心方块画出来占哪些像素）

| 变换 | 墨盒（设备像素） | 宽高 |
| --- | --- | --- |
| 无 | x[0..9] y[0..9] | 10x10 |
| `translate(20,30)` | x[20..29] y[30..39] | 10x10 |
| `scale(2,2)` | x[0..19] y[0..19] | 20x20 |
| `scale(0.5,0.5)` | x[0..4] y[0..4] | 5x5 |
| `rotate(45)`（不平移） | x[0..6] y[0..13] | **7x14（被画布裁掉一半）** |
| `translate(60,60)+rotate(45)` | x[53..66] y[60..73] | 14x14 ≈ 10√2 |
| `translate(60,60)+scale(2,2)` | x[60..79] y[60..79] | 20x20 |

`rotate` 是**绕变换坐标系原点**转的，不平移就有一半转到负坐标被裁掉——这是"我的图形转了就没了"的标准成因。缩放 0.5 时 10x10 变 5x5（四舍五入后没有空洞）。

`QTransform` 的复合顺序直接决定结果：

```text
  translate(50,0) 然后 scale(2)  : (10,10) -> (70,20)
  scale(2) 然后 translate(50,0)  : (10,10) -> (120,20)   <- 平移量也被缩放了
  a.m11=2.0 m13=0.0 determinant=4.0 isScaling=1 isTranslating=1
```

`painter.translate(); painter.scale();` 就是第一种——**后调用的变换先作用于坐标**。

## 二、画笔宽度与抗锯齿（全部是像素读数）

### 2.1 笔宽在世界坐标里，除非 cosmetic

一条 `drawLine(0,50,190,50)`，统计 x=100 那一列上哪些行有墨：

| 画笔 | 变换 | 命中的设备行 | α 剖面 |
| --- | --- | --- | --- |
| 1 px | 无 | 50 | y50:α255 |
| 2 px | 无 | **49 50** | 两个都 255 |
| 2 px | `scale(4,4)` | 196 197 198 199（线心 200 已出画布） | 4 行 255 |
| **cosmetic** 2 px | `scale(4,4)` | **只有 199**（另一行在画布外） | α255 |
| 3 px | `scale(0.25)` | **一行都没有** | 空 |

三条结论：**① 偶数笔宽是"往上线的中心偏移"画的**（2px 落在 49/50，不是 50/51）；**② `setCosmetic(true)` 才让线宽按设备像素算**——缩到 4 倍还是 2 个像素；**③ 非 cosmetic 的笔宽会被缩放吃掉，3px×0.25 = 0.75px 且关掉抗锯齿时，这条线整个不画**。想在缩放下仍然看到细线，只有两条路：cosmetic 笔，或者开 AA（但 AA 会把它变成半透明，见下）。

### 2.2 抗锯齿到底改变了什么

同一条 2px 斜线 `(2,150)→(198,10)`，在 x=100 这一列上把所有非零 α 打出来：

```text
  AA=0：y78:α255  y79:α255  y80:α255                      （阶梯，占 3 行、全是实心）
  AA=1：y78:α153  y79:α255  y80:α210  y81:α8              （4 行，边缘是覆盖率）
```

40x40 实心圆、`NoPen`、左半边缘一行 y=40：

```text
  AA=0  非空像素=1240  α 合计=316200  x19=a0  x20=a255  x21=a255  x59=a255  x60=a0
  AA=1  非空像素=1316  α 合计=318531  x19=a0  x20=a244  x21=a255  x59=a243  x60=a0
```

AA 把边界像素变成 **α=244 / 243** 的半透明，边缘"多出" 76 个像素，α 总量只多 0.7%（面积基本守恒）。**这就是像素级校验最容易翻车的地方：你画的是纯黑 (0,0,0)，AA 开与关时同一个坐标读出来是 `(0,0,0,a255)` 和 `(0,0,0,a244)`**——写断言时要比灰度和 alpha，不能只比 RGB。

代价（3 轮取最好，同一张 400x400 的 `QImage`）：

```text
  300 条线 AA=off = 912 us     AA=on = 2276 us   （2.5 倍）
  300 个 100x100 椭圆 AA=on   = 8610 us
```

2.5 倍听着可接受，但把它乘上每帧的图元数就是你的重绘预算——第 10 节《性能与卡顿诊断》里"重绘风暴"的乘数就是它。

## 三、字体度量：`ascent` 可信，`height` 未必

### 3.1 advance 与 boundingRect

Sans Serif 9pt（`pointSize=9, pixelSize=-1`）：

```text
  fm.height=12 ascent=12 descent=0 leading=2 averageCharWidth=0.0 maxWidth=12
  ASCII "Hg"      advance=24  boundingRect=24x12   boundingRectF=(100000,100000,24,12)
  只 "h"          advance=12  12x12
  只 "g"          advance=12  12x12
  中文 "模型视图"  advance=48  48x12
  混排 "a模b"      advance=36  36x12
  10 个 "m"        advance=120 120x12
  单空格           advance=12  12x12
  QLabel("模型视图").sizeHint() = 48x12      ← 正好 = advance x height
```

两个实用点：**`QFontMetrics::boundingRect(str)` 返回的 `QRect` 的 x/y 是 `100000` 这个魔数（表示"起点偏移无意义"），只有 width/height 可信**；本机上中西文字符宽度相同（各 12 px），所以别拿"中文一定是双倍宽"当假设——它取决于实际命中的字体（见 3.3）。

### 3.2 基线在哪：把 `drawText(10, 60, s)` 的墨盒量出来

`drawText` 的第 2 个参数是**基线**，不是外接框左上角。把基线钉死在 y=60：

```text
  "h"      墨的行 [48..55]   列 [10..17]
  "g"      墨的行 [48..55]   列 [10..17]
  中文 4 字 墨的行 [48..55]   列 [10..53]
  10 个 m  墨的行 [48..55]   列 [10..125]
```

**顶行 48 = 60 − ascent(12)**，精确命中——所以垂直居中要用 `baseline = y + ascent`，别用 `y + height/2`（会偏下半格）。而底部只到 55，也就是**真实墨高只有 8 行，`fm.height()` 报 12**：`height = ascent + descent`，本机 `descent=0`，多出来的 4 行是行距/leading，不是字形。用 `height` 当文字高度会把行高压得偏松。

### 3.3 本机字体状态是退化的，必须带着这条读上面两个数

```text
  应用字体 family="Sans Serif" pointSize=9 pixelSize=-1
  QFontInfo 解析出的 family=（空串）  pointSizeF=-0.8  pixelSize=-1  bold=0
  fm.descent=0  fm.averageCharWidth=0.0
```

`QFontInfo` 拿不到真实字体名、`descent=0`、`averageCharWidth=0` 都不正常——**offscreen 平台的字体数据库是不完整的**。`advance`、`ascent` 与像素实测自洽（48 = 60−12、每字符 12 px），所以坐标关系可信；**绝对字号（比如"12 px 字在真实 Windows 字体下有多高"）不能外推**，列进第八节。

## 四、高 DPI：能测的一致性和不能测的真实缩放

同一份 `main`，三种环境变量各跑一次（offscreen）：

| 环境变量 | `QScreen::geometry()` | `devicePixelRatio` | `logicalDotsPerInch` | `physicalDotsPerInch` | `fm.height` | `"Hg"` advance |
| --- | --- | --- | --- | --- | --- | --- |
| 无 | 800 x 800 | 1.00 | 96.0 | 100.0 | 12 | 24 |
| `QT_ENABLE_HIGHDPI_SCALING=1 QT_SCALE_FACTOR=2` | **400 x 400** | **2.00** | 96.0 | **50.0** | 12 | 24 |
| `QT_SCREEN_SCALE_FACTORS=2` | 400 x 400 | 2.00 | 96.0 | 50.0 | 12 | 24 |

**缩放因子把屏幕的"逻辑几何"对半砍、dpr 抬到 2、`physicalDotsPerInch` 减半，而 `logicalDotsPerInch` 一直是 96、`QFontMetrics` 一个数字都没变。** 也就是说：在 offscreen 上 `QT_SCALE_FACTOR` 只动了坐标系统，没动字号——真实的 Windows 缩放下字号会变（走的是 `logicalDotsPerInch`），本机测不到，第八节列明。

能测且很重要的是**位图 dpr 的行为**（这条是 Qt 6 绘制里最容易做错的）：

```text
  QPixmap(100,60)：size=100x60 devicePixelRatio=1.00；setDevicePixelRatio(2) 后 size 仍是 100x60、dpr=2.00
  QImage(100,100) 普通：fillRect(QRect(10,10,5,5)) -> 有值像素 25（=5x5）
  QImage(100,100) dpr=2：同一次 fillRect(10,10,5,5) -> 有值像素 100，盒子 = 设备像素 [20..29] x [20..29]
```

**给图像设了 `devicePixelRatio(2)` 之后，`QPainter` 的坐标就变成"逻辑像素"，同一个 `fillRect(10,10,5,5)` 真的写在 2 倍的物理格子上。** 反过来读像素时要用设备坐标——这就是"高分屏下我的自绘控件偏一半 / 鼠标点不准"的机制。`QWidget::devicePixelRatio()` 在本机恒为 1.00（无真实屏幕）。

另外：`QImage::sizeInDevicePixels()` **在 6.9 不存在**（只能自己 `width()*devicePixelRatio()`），见第七节。

## 五、离屏绘制：QPixmap / QImage / 缩放，各花多少钱

全在 1920x1080 与 64x64 两种尺寸上量，3 轮取最好：

```text
  fill(整幅红)          QImage 1308 us    QPixmap 1952 us
  2000 条线              QImage 8810 us    QPixmap 7558 us
  QPixmap::toImage()     0 us       ← 不复制：offscreen 是 raster 后端，QPixmap 内部就是 QImage，共享缓冲
  QPixmap::fromImage()   2753 us    ← 真复制 8.29 MB
  scaled 1920x1080 -> 960x540:  Fast 4275 us   Smooth 4623 us（1.08 倍）  两种结果只有 1200/518400 个像素不同
  画 1000 个 64x64：drawImage(QImage) = 703 us（0.70 us/个）
                    drawPixmap(QPixmap::fromImage(小图)) + SmoothPixmapTransform = 1839 us（1.84 us/个）
  QImage::sizeInBytes: 1920x1080 ARGB32 = 8294400 字节   64x64 = 16384 字节
```

读法：

1. **离屏准备位图，`QImage` 通常不比 `QPixmap` 差**：填充 QImage 更快（1308 vs 1952 µs，`QPixmap` 要走平台绘制管线），画线反而 QPixmap 略快（8810→7558 µs）。两者在本机同一后端下差距都在 1.5 倍内，**没必要为了"性能"把中间结果转成 `QPixmap`**——转一次就 2.75 ms。
2. **`toImage()` 是 0 µs 的陷阱**：offscreen/raster 下它和原 pixmap 共享数据。在真实平台上可能是 OpenGL 后端，那时就是逐像素回读。别把这条 0 µs 当"随便调"。
3. **`SmoothTransformation` 在整数倍缩小时几乎不贵**（1.08 倍），而且这台机器上画出来的差异只有 1200 个像素——**"关掉平滑缩放来提速"这个建议在缩小 2 倍场景里没有收益**（非整数倍、放大场景本机未测，见第八节）。
4. `drawPixmap` 那组慢的原因是 **`QPixmap::fromImage()` 被写进了循环里**（1000 次转换），不是 `drawPixmap` 本身贵。做微基准时把一次性开销放进循环，结论就废了——和第 6 节里"printf 参数求值顺序骗过我一次"是同一类错误。

补一条视图相关的：`QGraphicsView::render()` **只有 `QPainter*` 重载**，而 `QWidget::render()` 有 `QPaintDevice*` 重载：

```text
  error: cannot convert 'QImage*' to 'QPainter*'   // view（QGraphicsView）.render(&img)
```

`QTableView v; v.render(&img);` 能编，`QGraphicsView v; v.render(&img);` 编不过——两个 render 不是同一个函数。

## 六、QGraphicsView / QGraphicsScene：坐标两套、只画看得见的

### 6.1 局部坐标 vs 场景坐标

```text
  QGraphicsRectItem(100, 200, 50, 40)（pos 默认 0,0）
    boundingRect()        = 100,200, 51 x 41     ← 宽 50 变 51：默认画笔占了一格
    sceneBoundingRect()   = 100,200, 51 x 41
  setPos(30, 40) 之后
    sceneBoundingRect().x = 130（= 局部 100 + pos 30）
    boundingRect()        = 仍是 100,200           ← 局部框永远不变
```

`boundingRect()` 是**局部分支坐标系里的"我可能画到哪"**（自己实现的 item 里返回少了会被裁掉），`pos()`/`transform()` 只改变它与场景的相对位置。另外**任何 item 的墨盒都比几何大一格**（51x41），做命中测试时别按 50x40 算。

### 6.2 视图变换与往返映射

```text
  场景 2000x1500，视图 400x300（viewport 实际 384x284），centerOn(125,220)
  mapFromScene(125,220) = (125.0, 142.0)     viewport 尺寸=384x284  滚动条 y=78
  mapToScene(那个 viewport 点) = (125.0, 220.0)   ← 往返精确
  视图变换 m11=1.00
```

`centerOn` 之后场景点 (125,220) 落在 viewport 的 (125,142)——**x 恰好相等是巧合（滚动条钳在 0），y 被搬到接近视口中点 (284/2=142)**。视图的 `scrollbars` 值（0, 78）才是"场景点搬到视口中点"的实现方式。

### 6.3 虚拟化：一次重绘只调可见 item 的 `paint()`

10000 个 item 沿 y 每 20 px 一个，视图 320x240（viewport 224 高），显式设了 `sceneRect(0,0,400,200000)`：

```text
  show+processEvents 后一次 render：被画 item=12 个，rowId 范围=[4994..5005]
                                     视口高 224 / 行距 20 -> 理论 11.2 个  ✓
  滚到第 5000 行后一次 render：被画 item=12 个，范围=[5000..5011]
  这次 render 总耗时=370 us，item.paint() 调用 12 次
  view.scale(2,2) 后一次 render：被画 item=7 个，耗时=62 us   ← 视野变小，画得更少
```

两点：**首次显示时视图把场景中心摆到视口中点**，所以第一批被画的是 `4994..5005`，不是 `0..11`；`scale(2)` 让可见 item 从 12 降到 7、耗时从 370 µs 降到 62 µs（**放大反而更省**，因为场景裁剪在 `paint` 之前）。

### 6.4 建场景、查场景的账

| 操作 | 1000 | 10000 | 50000 |
| --- | --- | --- | --- |
| `addItem()` 累计 | 440 µs（0.44 µs/个） | 3122 µs（0.31 µs/个） | 18530 µs（**0.37 µs/个**） |
| `scene.items()` | 32 µs | 814 µs | **11425 µs** |
| `scene.sceneRect()`（没显式设过） | 68.8 µs | 1098 µs | **12325 µs** |
| `scene.sceneRect()`（显式 `setSceneRect`） | — | — | **0.30 µs** |

**不设 `sceneRect` 时它是 O(n) 的**（Qt 要遍历所有 item 求并集），50000 个 item 每次问都要 12.3 ms。视图在若干时机确实会问它——所以**大场景第一件事就是显式 `setSceneRect()`**，这一条从 12.3 ms 变成 0.30 µs，是本节最划算的优化。

索引后端（20000 个 20x20 的 item 摆成 30px 稠密网格）：

```text
  默认（不设置）：首个 itemAt=9966 us    100 次 items(800x800 区域) 平均 4945.8 us/次  每次返回 784 个
  显式 NoIndex  ：首个 itemAt=13463 us   100 次同样的查询        平均 4127.5 us/次  每次返回 784 个
```

**负面结果照实写：在这份稠密网格数据上，Qt 的默认索引没有跑赢 `NoIndex`——单次区域查询反而慢 20%**（4946 vs 4128 µs），只有"第一次查询"更便宜（9966 vs 13463 µs）。原因不难理解：区域 800x800 已经占了场景相当大一块，返回 784 个命中，索引树遍历的常数抵消了裁剪收益。**别照着"item 多就开索引 / 关索引"的经验下结论，先用你自己的分布测一次**；查询稀疏（每次只命中几个）时索引才可能划算，本机未测那种分布。

另外两个坑：

```text
  scene.itemAt(QPointF(1,1))                       error: no matching function for call to 'QGraphicsScene::itemAt(QPointF)'
                                                   → Qt 6 必须 scene.itemAt(pos, deviceTransform)
  view.itemAt(QPoint(1,1))                         命中第 -1 个（viewport 左上角没有 item，因为它在场景坐标里对不上）
```

`QGraphicsScene::itemAt` 在 Qt 6 **强制要求传 `deviceTransform`**（因为同一场景可以挂在多个不同变换的视图上）；`QGraphicsView::itemAt` 才收 viewport 坐标。这两个函数名字一样、坐标系完全不同，是"我 itemAt 明明放了东西却返回 null"的常见来源。

### 6.5 缓存：本机没测出收益

| 配置 | 一次 render 的调用计数 |
| --- | --- |
| 基线（这一组场景里只有一个 item，且它在 (500,500)） | `drawBackground()`=1 次/渲染，该 item `paint()`=0 次（不在视野内） |
| 连续两次 render，中间什么都没改 | `drawBackground()` 各 1 次 |
| 视图 `setCacheMode(QGraphicsView::CacheBackground)` 后连 render 两次 | **`drawBackground()` 仍是 2 次**（一点没省） |
| item `setCacheMode(DeviceCoordinateCache)` 后连 render 三次 | 计数无效——那个测试 item 在 (500,500)，压根不在视野里，`paint()` 恒 0 |

结论只敢下一条：**在 `QWidget::render()` 这种"整幅强制重绘"的路径上，`CacheBackground` 不减少 `drawBackground()` 调用**。缓存是为"增量重绘 + 滚动"准备的，而本机离屏环境没有真正的脏区域合成（`update()` 的合并行为属于第 10 节）。**`DeviceCoordinateCache` / `CacheBackground` 在滚动场景下的实际收益，本节未测出有效数字**，列进第八节。

## 七、Qt 6.9 的删改：本节的编译报错原文

全部由 `g++ -std=c++17 -fsyntax-only` 对单个探针文件报出（一个函数一个 API，原文照抄）：

```text
  QPainter::HighQualityAntialiasing   error: 'HighQualityAntialiasing' is not a member of 'QPainter'
  QPainter::toDevice(QPointF)         error: 'class QPainter' has no member named 'toDevice'; did you mean 'device'?
  QPainter::setWorldMatrix(...)       error: 'class QPainter' has no member named 'setWorldMatrix'; did you mean 'setWorldMatrixEnabled'?
  QPainter::worldMatrix()             error: 'class QPainter' has no member named 'worldMatrix'          → worldTransform()
  QPainter::boundingRect()            error: no matching function for call to 'QPainter::boundingRect()'  → clipBoundingRect() / viewport()
  QPainter::setPaintingActive(bool)   error: 'class QPainter' has no member named 'setPaintingActive'
  QFontMetrics::width(QString)        error: has no member named 'width'                                  → horizontalAdvance()
  QFontMetrics::minWidth()            error: 'class QFontMetrics' has no member named 'minWidth'; did you mean 'maxWidth'?
  QFontMetrics::maxCharWidth()        error: has no member named 'maxCharWidth'; did you mean 'maxWidth'?
  QImage::sizeInDevicePixels()        error: 'class QImage' has no member named 'sizeInDevicePixels'
  Qt::ThresholdDithering              error: 'ThresholdDithering' is not a member of 'Qt'; did you mean 'ThresholdDither'?
  QApplication::desktop()             error: 'desktop' is not a member of 'QApplication'
  QApplication::setGraphicsSystem()   error: 'setGraphicsSystem' is not a member of 'QApplication'   ← Qt6 彻底没有 raster/desktop 图形系统切换
  QGraphicsScene::itemAt(QPointF)     error: no matching function for call to 'QGraphicsScene::itemAt(QPointF)'  ← 必须带 deviceTransform
  QGraphicsScene::BspIndexDepth(1)    error: 'BspIndexDepth' is not a member of 'QGraphicsScene'    → 只有 setItemIndexMethod(NoIndex) 这一个枚举值可传
  QGraphicsView::renderHint(...)      error: 'class QGraphicsView' has no member named 'renderHint'; did you mean 'renderHints'?
  QGraphicsView::render(&qimage)      error: cannot convert 'QImage*' to 'QPainter*'                 → 只有 QPainter* 重载
```

活着但容易被误删的（同一次编译里没报错）：`QPainter::setCompositionMode/compositionMode`、`QStaticText + drawStaticText`、`QTextLayout`（Qt6 又回到公开 API）、`QGraphicsItem::ItemIgnoresTransformations`、`QPen::isCosmetic/joinStyle`、`QStyleOptionGraphicsItem::levelOfDetailFromTransform`、`QGraphicsView::resizeAnchor`、`QPixmap::transformed`、`QPainter::drawTiledPixmap`。

## 八、本节未在本机实测的内容

- **真实显示器的 DPI 行为**：第四节只在 offscreen 上用 `QT_SCALE_FACTOR` / `QT_SCREEN_SCALE_FACTORS` 验证了"几何减半、dpr 变 2、字号不变"。接真实高分屏时 `logicalDotsPerInch` 会变、字号会跟着变，`QT_ENABLE_HIGHDPI_SCALING` 下的分数缩放（125%/150%）与多屏不同缩放因子的组合，本机没有显示器、也没有 Linux/WSL，测不出来。
- **绝对字号**：3.3 那三条（`QFontInfo::family()` 为空、`descent=0`、`averageCharWidth=0`）说明离屏字体库退化。表格里"每字符 12 px""墨高 8 行"只在本机自洽，不能当 Windows 真实字体（Segoe UI / 微软雅黑）下的数字用。
- **`QPlatformWindow` 级的绘制与 `QOpenGLWidget` 后端**：`QApplication::setGraphicsSystem` 在 Qt6 已删除（见第七节），本机也没有可用 GL 上下文，所有数字都是 raster 后端的。
- **item/视图缓存的真实收益**：6.5 的 `DeviceCoordinateCache` 测试无效（item 不可见），`CacheBackground` 在滚动/局部脏区域下能省多少 `paint()`，需要用真实窗口和鼠标滚轮才能取证。
- **`update()` 合并与重绘风暴**：属于第 10 节《性能与卡顿诊断》，本节没测脏区域合并、`repaint()` 与 `update()` 的调用计数差异。
- **非整数倍缩放与放大**：第五节只测了 1920x1080 → 960x540（正好 2 倍），Smooth 与 Fast 差 1.08 倍、只有 1200 个像素不同；放大（例如 →2400x1350）和非整数倍（→1000x563）下的比值与观感差异未测，"Smooth 未必贵"这条结论**不能外推**。
- **`toImage()` 的 0 µs**：只在 offscreen 的 raster 后端成立。真实平台的 QPixmap 若走光栅化以外的合成路径，回读代价完全不同。
- **稀疏查询下的索引收益**：6.4 用的是 800x800 的大区域（命中 784 个）。点选（命中 1~3 个）时的 `itemAt`/`items` 比值未测。
- **`QPainter` 在 PDF/SVG 输出设备上的度量**（`QPdfWriter`、`QSvgGenerator`）：本节只画到 `QImage`/`QPixmap`。
