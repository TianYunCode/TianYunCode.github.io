---
title: Qt 6 信号槽与元对象系统
description: 实测：不带类型码前缀的裸字符串 connect 恒失败并报 `Use the SIGNAL macro to bind ...`；宏式 connect 比函数指针版贵 2.7 倍、字符串版贵 4.0 倍、拼错名字再贵 4.6 倍；emit 每多一个连接 +15–22ns，跨线程入队是同线程的 15–21 倍；`QMetaObject::Connection` 在 6.9 已无 `isValid()`；`connectSlotsByName` 重复调用会把同一个槽接两遍；`property()` 比直接 getter 慢 120 倍且代价随属性在表里的**位置**线性上涨。
date: 2026-10-15
tags: [Qt, 信号槽, 元对象, Q_PROPERTY]
category: qt6
section: qt-signal-slot
---

> 环境：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`），GCC 13.1.0（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`，PATH 上的 g++ 是 Strawberry Perl 4.9.2 32 位，禁用），CMake 3.30.5 + Ninja，`-O2 -DNDEBUG`，`QT_QPA_PLATFORM=offscreen`。耗时为进程内 5 轮中位数，关键项**再跑 5 个独立进程**取跨进程区间；本机同期有其他编译/基准任务在跑，绝对值偏大，**比值更可靠**。编译期报错原文用 `g++ -fsyntax-only` 逐例取得。

## 一、五种 connect 写法：检查时机完全不同

`SIGNAL()`/`SLOT()` 不是普通字符串宏，Qt 6.9 的展开是 `QT_PREFIX_CODE(code, a)`，`code` 是**类型码**：

```text
SIGNAL(sigVoid())  ->  "2sigVoid()"    QSIGNAL_CODE = 2
SLOT(sInt(int))    ->  "1sInt(int)"    QSLOT_CODE   = 1
METHOD(foo())      ->  "0foo()"        QMETHOD_CODE = 0
Debug 构建还会拼上 "\0文件名:行号"（qFlagLocation），Release 没有
```

于是字符串写法分两种——**带类型码前缀**的和**不带的**，后者根本连不上：

```text
  [宏式] SIGNAL(sigVoid())/SLOT(sVoid()) 返回=1 告警=0
  [裸字符串信号 + SLOT() 宏] 返回=0 告警=1
      warn: QObject::connect: Use the SIGNAL macro to bind Emitter::sigInt(int)
  connect(&e, "2sigInt(int)", &r, "1sInt(int)") -> 返回=1，告警 0 条
  connect(&e, "2sigInt(int)", &r, "sInt(int)")  -> 返回=0
      warn: QObject::connect: Use the SLOT or SIGNAL macro to connect Recv::sInt(int)
```

| # | 写法 | 检查时机 | 返回值 | 实测要点 |
| --- | --- | --- | --- | --- |
| 1 | `SIGNAL()/SLOT()` 宏 | **运行期** | `Connection`（隐式转 bool） | 拼错只出 warning |
| 2 | 带类型码前缀裸字符串 | 运行期 | 同上 | 与宏式本来就是同一个东西 |
| 3 | 不带前缀裸字符串 | 运行期 | **恒失败** | 报 "Use the SIGNAL macro" |
| 4 | 函数指针 `&Emitter::sigInt, &Recv::sInt` | **编译期** | `Connection` | 可连**非槽**的 public 成员函数 |
| 5 | 函数指针 + lambda（带/不带上下文） | 编译期 | `Connection` | 不带上下文=悬垂风险 |
| 6 | 函数指针 + 显式 `Qt::ConnectionType` | 编译期 | `Connection` | 必须带 receiver/上下文 |

第 6 条是硬编译错误——`connect(sender, signal, functor)` 这个重载**根本没有 ConnectionType 形参**：

```text
error: no matching function for call to 'QObject::connect(Sig*, void (Sig::*)(), main()::<lambda()>, Qt::ConnectionType)'
note:   candidate expects 3 arguments, 4 provided
```

要给 lambda 指定队列连接只能写 `connect(sender, signal, contextObject, lambda, type)`。

`Connection` 本身 8 字节，Qt 6.9 里**没有 `isValid()`**（Qt 5 有），只有受限 `operator bool`（`d_ptr && isConnected_helper()`），`disconnect()` 是 `QObject` 的静态方法而不是成员：

```text
  sizeof(QObject)=16 sizeof(QMetaObject)=64 sizeof(QMetaObject::Connection)=8 sizeof(QMetaProperty)=32
  disconnect(PMF)=1 disconnect(lambda+上下文)=1 disconnect(无上下文lambda)=1
  重复 disconnect 同一条连接: 返回=0   已失效的 conn 转 bool=0
```

## 二、编译期报错原文 vs 运行期告警原文

| 错误写法（`-fsyntax-only`） | GCC 13.1 原文 |
| --- | --- |
| 槽参数比信号多 | `error: static assertion failed: The slot requires more arguments than the signal provides.` |
| 重载信号不加消歧 | `error: no matching function for call to 'QObject::connect(Sig*, <unresolved overloaded function type>, Slot*, void (Slot::*)(int))'` |
| 成员名拼错 | `error: 'noSuchThing' is not a member of 'Slot'` |
| 把普通成员当信号 | `error: no matching function for call to 'QObject::connect(Sig*, int Sig::*, Slot*, void (Slot::*)())'` |
| lambda 参数个数不符 | `error: no type named 'type' in 'struct QtPrivate::FunctorReturnType<main()::<lambda(int, QString)>, QtPrivate::List<> >'` |
| PMF 连 private 槽 | `error: 'void Slot::priv()' is private within this context` |
| `SIGNAL(sigNoSuch())` | **零错误零警告** |

反过来，字符串写法**绕开 C++ 访问控制**——同一个 private 槽，宏式连得上、`invokeMethod` 调得动（累计命中从 0 变 2）。这不是 bug，是 `connectSlotsByName`/`.ui` 自动接线的工作前提，但 PMF 写法和宏写法在这一点上语义确实不同。

运行期告警原文（`qInstallMessageHandler` 捕获，Release 构建）：

```text
QObject::connect: No such signal Emitter::sigNoSuch()
QObject::connect: No such slot Recv::slotNoSuch()
QObject::connect: Use the SIGNAL macro to bind Emitter::sigVoid()zz
QObject::connect: Attempt to bind non-signal Emitter::sigVoid()
QObject::connect: Cannot connect (nullptr)::sigVoid() to Recv::sVoid()
QObject::connect: Incompatible sender/receiver arguments
  Emitter::sigVoid() --> Prop::bump(int)
QMetaObject::invokeMethod: No such method Prop::bump(QString)
Candidates are:
    bump(int)
```

全部返回 `false`／失效 Connection，**不 assert、不抛异常**。想提前自检就别用字符串版，用元对象接口——注意 `indexOf*()` 收的是**不带前缀**的规范签名，和 `connect()` 的字符串参数正好相反：

```text
  indexOfSignal("sigNoSuch()")=-1  indexOfSlot("slotNoSuch()")=-1
  indexOfSignal("sigVoid()")=4     indexOfSlot("sVoid()")=4
```

## 三、一次 connect / emit 多少钱

`connect` 那一列是"建连 + 立刻显式断开"的完整周期，30000 次/轮 × 5 轮 × 5 个独立进程：

| 写法 | 中位 | 跨进程区间 | 相对函数指针 |
| --- | --- | --- | --- |
| 函数指针 | **397.6 ns** | 370.4 – 531.2 | 1.0× |
| `SIGNAL/SLOT` 宏 | **1084.3 ns** | 864.1 – 1546.1 | **2.7×** |
| 规范字符串（带前缀） | **1594.7 ns** | 1184.2 – 1707.1 | **4.0×** |
| 名字拼错走完整失败路径 | **1847.5 ns** | 1634.8 – 2094.1 | 4.6× |

多出来的钱花在 `normalizedSignature()` 的字符串规范化 + `indexOfSignal/indexOfSlot` 查表；失败路径还要额外格式化一条 warning。**函数指针版没有可拼错的字符串**，这是它真正的性能论据，不只是类型安全。

`emit` 侧（同一信号接 N 个成员槽）：

```text
  emit 到    0 个成员槽:      6.8 ns/emit      （5 进程区间 6.7 – 12.8）
  emit 到    1 个成员槽:     35.9 ns/emit      （35.9 – 50.6）
  emit 到   10 个成员槽:    192.6 ns/emit   摊到每个连接 19.26 ns
  emit 到  100 个成员槽:   1556.0 ns/emit   摊到每个连接 15.56 ns
  emit 到 1000 个成员槽:  15833.0 ns/emit   摊到每个连接 15.83 ns
  emit 到  100 个 lambda :   1689.9 ns/emit   摊到每个连接 16.90 ns
```

**空信号只 7–13ns**（接近一次虚调用，不是免费）；**每多一个连接稳定 +15–22ns**；**lambda 和成员槽没有差价**（1689.9 vs 1556.0ns，在负载噪声内），"为性能把 lambda 改成槽"是伪优化。带参也一样：`emit(int)` 43.0–44.8ns，`emit(int,QString)` 38.2–47.9ns。

拆连接：显式 `disconnect` 1000 条 = **131.8 – 282.3 µs**（132–282 ns/条）；直接 `delete` 这 1000 个 receiver 让 Qt 自动拆 = **122.6 – 258.1 µs**，还**包含**了 1000 次对象析构。自动断开不额外收钱。

## 四、UniqueConnection、SingleShotConnection 与 connectSlotsByName

```text
  UniqueConnection(PMF) 连 2 次后 emit 1 次 -> sVoid=1 次  第一条=1 第二条=0
  宏式 + UniqueConnection 连 2 次: 返回=1/0，emit 1 次后 sVoid=1 次
  带 2/1 前缀的裸字符串 + UniqueConnection: 返回=0，emit 后 sVoid=1 次
  Qt::SingleShotConnection(6.9 新增 0x100): emit 3 次 -> nInt=1 lastInt=1 触发后 conn=0
```

`Qt::UniqueConnection`（0x80）对宏式、字符串式、函数指针式**都生效**，重复连接返回失效 Connection——"宏式不支持去重"是 Qt 4 时代的旧话。它**不能**配 lambda（上面那条编译错误）。`Qt::SingleShotConnection`（0x100）是 6.9 新枚举，触发一次即自动断开，省掉手写 lambda + disconnect。

`connectSlotsByName`（`uic` 生成的 `setupUi()` 最后一步）有个可复现的坑：**重复调用会重复接线**。

```text
  connectSlotsByName 后 click() -> on_btnOk_clicked 命中，hits=1，告警=0
  重复调用 connectSlotsByName -> 第二次 click 后 hits=3
  没有对应槽的子按钮 click -> hits=3 告警=0（静默跳过）
```

第一次 click +1，第二次 click **+2**——槽被接了两遍。命名规则 `on_<objectName>_<signalName>`，找不到对应槽时**一条告警都不给**。反复 `setupUi`、动态重建 UI 就会撞上。

## 五、队列连接：槽在谁的线程里跑

| 场景 | 实测 |
| --- | --- |
| 同线程 + Auto | `emit` 返回时 `nInt=1`，槽线程句柄 == 主线程句柄（Auto 退化成 Direct） |
| 跨线程 + Auto | `emit` 返回时 `got=0`；稍后 `got=1 last=42`，槽 handle 属于 `"W1"` |
| 跨线程 + **强制 Direct** | 槽 handle == **主线程** handle：槽跑在发射方线程，共享数据直接开 race |
| `BlockingQueuedConnection` | `emit` 返回时 `got=1`，本次 emit 阻塞 **0.391 – 1.051 ms** |
| `QueuedConnection` 端到端 | 5 次中位 **0.031 ms**，区间 **0.010 – 2.575 ms** |
| 入队成本 | 跨线程 `emit(int)` **634.6 – 931.5 ns/次**，同线程 Direct **37.8 – 44.0 ns** → **15–21 倍** |

`AutoConnection` 是在 **emit 那一刻**比较 `receiver->thread()` 与 `QThread::currentThread()` 决定的，`moveToThread` 之后行为立刻变，不用重连。接收方线程没跑事件循环时：

```text
  接收线程没 exec(): emit 2 次 -> got=0（事件躺在队列里没人取）
  线程退出后再 emit: got=0（无告警、无返回值可查，静默丢弃）
```

`emit` 返回 `void`，投递失败**没有任何信号**，诊断只能靠"槽里打点 + 计数器"。

自定义类型的 `qRegisterMetaType` 需求比旧文档松得多。`Custom`（没写 `Q_DECLARE_METATYPE`）走 `QueuedConnection` 的三种写法**全部零告警、值正确送达**：

```text
  [成员槽 + 未注册类型 + Queued]  connect 阶段告警 0 条 / emit 后告警 0 条，w.got=1 last=3
  [lambda  + 未注册类型 + Queued]  告警 0 条，lamHits=3
  [字符串式 SIGNAL/SLOT + Queued]  connect 返回=1，告警 0 条 / emit 后 w2.got=1 last=3
```

边界在**名字注册表**而不是队列连接：

```text
    fromName 查未引用过的类型：Custom=0 Loose=0 NoSuchTypeAtAll=0
    fromType<T>() 调用之后：fromName("Custom")=0  id=65537/65538
    qRegisterMetaType<Custom>("Custom") 之后：fromName("Custom")=1 id=65537 name=Custom
```

新式 connect 用编译期生成的 `QMetaTypeInterface`，不查名字表；但 `QVariant`／`Q_PROPERTY`／QML 侧要按名字找类型，那时仍得 `qRegisterMetaType`。注意 `QMetaType::fromType<T>()` **本身不写名字表**（实测 fromName 仍为 0）。

## 六、生命周期：连接什么时候消失

```text
  delete receiver 后再 emit 2 次: 告警=0 条，无崩溃（2 条连接自动拆除）
  receiver 析构后 conn 转 bool=0  再 disconnect(c) 返回=0
  sender 析构后 conn 转 bool=0（连接随 sender 一起消失）
  lambda+上下文析构后再 emit 2 次: hits 停在 1（上下文即 receiver，析构即断开）
  delete a 后 emit #2: b.nVoid=2（别的 receiver 不受影响）
```

`deleteLater()` 的时机最容易读错：

```text
  槽1 里 deleteLater()：同一次 emit 内 k1=1 k2=1（两个槽都跑完）对象还活着? 是
  processEvents() 之后 guard=仍非空，k2=1（processEvents 不兑现 DeferredDelete）
  显式 sendPostedEvents(nullptr, DeferredDelete) 之后 guard=空
  改用最外层 QEventLoop::exec() 走一圈: guard=空（loop 退出时兑现延迟删除）
```

**`QCoreApplication::processEvents()` 不处理 `DeferredDelete`**。槽里 `deleteLater()` 之后，同一次 `emit` 里后面的槽照旧执行、`this` 照旧有效；对象要等最外层循环退出或显式 `sendPostedEvents`。

真正的危险只有无上下文 lambda 捕获裸指针。做了确定性验证：连接里 `b->bump()`，然后 `delete b` 并往那块内存喷写毒值，再 `emit` 三次——

```text
  悬垂 lambda 捕获裸指针：delete+喷毒后 emit 3 次，未崩溃、告警 0 条（正常 magic=4370）
```

不崩、不报警，只是往已经不属于你的内存里写。**lambda 一律带上下文对象**（第三个参数传 receiver），或捕获 `QPointer`，别指望用崩溃来提示。

## 七、Q_PROPERTY：120 倍的价格和静默失败的写操作

```text
  propertyCount=6（声明 5 个 + 继承 objectName），propertyOffset=1
    [ 0] objectName   type=QString      READ=1 WRITE=1 notifyIdx=2  bindable=1 stored=1
    [ 1] count        type=int          READ=1 WRITE=1 notifyIdx=4  bindable=0 stored=1
    [ 3] readOnlyOnly type=int          READ=1 WRITE=0 notifyIdx=-1 bindable=0 stored=1
    [ 4] memberProp   type=int          READ=1 WRITE=1 notifyIdx=4  bindable=0 stored=1
    [ 5] status       type=Prop::Status READ=1 WRITE=1 notifyIdx=6  bindable=0 stored=1
```

手写的 5 个 `Q_PROPERTY` 的 `bindable` 全是 **0**，只有 Qt 自己用 `QProperty` 实现的 `objectName` 是 1——**想用 6.x 的属性绑定必须显式写 `BINDABLE`**。

失败面几乎全是静默的：

```text
  p.setProperty("nope", 1)   -> 返回=0，告警 0 条
  p.property("nope")         -> isValid=1 typeName=int   ← 上一步悄悄建了动态属性
  写只读属性 readOnlyOnly=5  -> 返回=0，告警 0 条，值不变
  写不存在的枚举值 status=77 -> 返回=1，告警 0 条        ← Q_ENUM 不校验取值
```

`setProperty()` 对未声明的名字**不报错，而是建一个动态属性**，返回 0 是唯一线索，紧接着 `property()` 就能读回来，看起来"生效了"——属性名拼错的 bug 能一路活到线上。

```text
  隐式转换: "42"->42(ok=1)  42.7->43(ok=1)  true->1(ok=1)     ← 四舍五入，不是截断
  QString 属性写 int 7: ok=1 -> label="7"
  枚举属性写 5: ok=1 -> typeName=Prop::Status toString="Running" toInt=5
  用枚举名字符串 "Paused" 写: ok=1 -> status()=9
  MEMBER 属性写 99: 返回=1 property()=99 直接成员 memberVar=99（同一块内存）
  setProperty(name, QVariant()) 删动态属性后数量 3 -> 2
  用空 QVariant 清【已声明】属性 count: 返回=1 现值=0（是 reset，不是删除）
```

`MEMBER` 省一次函数调用，代价是**绕过 setter**。成本（20 万次/轮 × 5）：

| 访问方式 | 中位 | 区间 | 相对直接 getter |
| --- | --- | --- | --- |
| `obj->property("count")` | **79.6 ns** | 58.8 – 101.3 | **约 120×** |
| `QMetaProperty::read()`（预算句柄） | 50.9 ns | 46.7 – 56.0 | 约 80× |
| 直接 getter `q.count()` | 0.6 ns | 0.5 – 0.6 | 1× |
| `setProperty("count", i)` | 60.0 – 100.5 ns | 52.1 – 157.0 | 4–8× |
| 直接 setter `setCount(i)` | 7.7 – 14.8 ns | 7.1 – 81.9 | 1× |

名字查找**不是 O(1)**，代价随属性在声明表里的**位置**线性增长（`Big` 声明 31 个属性）：

```text
    p0=74.1  p5=71.2  p10=128.8  p15=101.7  p20=134.4  p25=159.0  p29=195.4   （未命中 nope=77.4）
```

热属性**排在 Q_PROPERTY 前面**，或者缓存 `QMetaProperty`（省 30%），要么就别用字符串接口。`QPushButton` 有 75 个属性，循环里写 `property("geometry")` 是要命的。

## 八、元对象遍历与反射能力

```text
  继承链：QPushButton(+1 方法) -> QAbstractButton(+10) -> QWidget(+29) -> QObject(+4)，共 4 层
  methodCount=44 propertyCount=75 enumeratorCount=0 classInfoCount=0 constructorCount=0
  QPushButton 本类新增：signal=0 slot=1  ——  [43] Slot showMenu()
  本类新增属性 3 个（propertyOffset=72）： autoDefault default flat
  indexOfProperty("text")=61 typeName=QString
  objectName 索引=0（< propertyOffset=72 => 来自 QObject 层）；down 属性索引=71
```

**`QPushButton` 自己没有 `clicked()`**，它来自 `QAbstractButton`。遍历本类成员必须用 `methodOffset()`～`methodCount()` 切，`methodCount()`/`propertyCount()` 是含继承的全量。每个 QObject 子类都白拿 4 个方法（实测 `Prop` 方法表，`methodOffset=4`）：

```text
    [ 0] Signal destroyed(QObject*)   [ 1] Signal destroyed()
    [ 2] Signal objectNameChanged(QString)   [ 3] Slot deleteLater()
```

枚举数值要对表读：`MethodType{Method=0, Signal=1, Slot=2, Constructor=3}`、`Access{Private=0, Protected=1, Public=2}`。

反射调用的边界——**`invokeMethod` 只认槽，不认普通成员函数**：

```text
  invokeMethod("bump", Q_ARG(int,5)) ok=1 -> count=5 NOTIFY=1 次
  invokeMethod("retFive", Q_RETURN_ARG(int, v)) -> 返回=1 v=5
  invokeMethod("count",  Q_RETURN_ARG(int, v))   -> 返回=0，No such method Prop::count()
  QMetaProperty: hasNotifySignal=1 notifySignalIndex=4 notifySignal=countChanged(int)
  手动 invoke 通知信号: 返回=1，累计 NOTIFY 次数=2
```

`count()` 是 public 成员函数、也是属性 READ，`invokeMethod` 就是找不到；反射取值请用 `QMetaProperty::read()`。想在外部补发 NOTIFY 是可行的：`mp.notifySignal().invoke(&obj, Qt::DirectConnection, Q_ARG(...))`。把元对象表当反射器自动接线的实测：

```text
  元对象遍历自动接线：裸 methodSignature() 成功 0 个；加 '2' 前缀成功 6 个、失败 0 个，命中 5 次
```

`QMetaMethod::methodSignature()` 给的是 `sigVoid()`，直接塞给 `connect()` 一条也接不上；补 `'2'` 前缀（即 `SIGNAL()` 宏的产物）后 6 个信号（含 2 个 `sigOvl` 重载）全部接上。

类型转换价格（30 万次/轮 × 5）：

| 写法 | 中位 | 区间 |
| --- | --- | --- |
| `qobject_cast<Prop*>(QObject*)` | **7.3 ns** | 6.4 – 7.9 |
| `dynamic_cast<Prop*>(QObject*)` | **39.8 ns** | 35.0 – 46.6 |
| `dynamic_cast` 失败路径 | 53.3 ns | 40.9 – 58.2 |
| `qobject_cast` 失败路径 | 8.4 ns | 7.5 – 9.8 |
| `metaObject()->inherits(...)` | 6.5 ns | 5.9 – 7.0 |
| `QObject::isWidgetType()` | 0.5 ns | 0.5 – 0.6 |

**`qobject_cast` 快 5 倍以上，且失败路径同样便宜**——它比的是 `QMetaObject*` 指针，不走 MSVC RTTI。另外 Qt 6.9 的几处签名变化只能靠编译验证：`QMetaMethod::parameterType(i)` 返回 **int 类型 id**（要自己 `QMetaType(id)` 包一层）；`QMetaType::name()`／`QVariant::typeName()` 返回 `const char*` 而非 `QByteArray`；`QThread::currentThreadId()` 返回 `Qt::HANDLE`（`QThreadId` 在这套头文件里根本搜不到）；`QMetaProperty` 上没有 `hasNotify()`／`notify()`，是 `hasNotifySignal()`／`notifySignal()`／`notifySignalIndex()`。

## 九、小结

- **只有函数指针版在编译期检查**。字符串写法必须带类型码前缀（`2`=signal／`1`=slot／`0`=method），不带就恒失败并报 `Use the SIGNAL macro to bind ...`；宏式与字符串式还能绕过 C++ 访问控制连到 private 槽。
- 价格：**函数指针 398ns < 宏式 1084ns（2.7×）< 字符串式 1595ns（4.0×）**，拼错名字 1848ns。`emit` 空信号 7–13ns，每加一个连接 **+15–22ns**，lambda 与成员槽**无差价**。
- 6.9 API 现状：`Connection` 无 `isValid()`；`UniqueConnection` 对三种字符串/指针写法都去重（第二次返回失效连接）但**不能配 lambda**；`SingleShotConnection`（0x100）为 6.9 新增。
- **`connectSlotsByName` 重复调用会把同一个槽接两遍**（第二次 click 让计数 +2），且找不到槽时零告警。
- 队列连接：`Auto` 在 emit 时按线程判定；强制 `Direct` 会让槽跑在**发射方线程**；`BlockingQueued` 阻塞 0.39–1.05ms；跨线程入队是同线程 **15–21 倍**；接收线程没 `exec()` 或已退出时**静默丢弃**。自定义类型的队列传递实测不需要 `qRegisterMetaType`，但 `QVariant`/属性系统按名字查类型时仍需要。
- 生命周期：sender 或 receiver 析构都自动拆连接；`deleteLater()` **不被 `processEvents()` 兑现**；无上下文 lambda 捕获裸指针实测**不崩溃、不告警、静默写脏内存**。
- 属性：`property()` 慢约 **120×**，且代价随属性在声明表里的**位置**线性上涨（p0 74ns → p29 195ns，未命中反而 77ns）；`setProperty()` 写不存在的名字**静默建动态属性**；`Q_ENUM` **不校验取值**；`BINDABLE` 默认全关。
- 反射：`invokeMethod` **只能调槽**，读值要 `QMetaProperty::read`；`qobject_cast` 比 `dynamic_cast` 快 5 倍；本类新增成员只能靠 `methodOffset()`/`propertyOffset()` 切出来（`QPushButton` 自己一个新信号都没有）。

下一节进入事件系统：`notify()`、应用级过滤器、控件级过滤器、`event()` 覆写、专门的 `xxxEvent()` 处理器这五层的**实际调用顺序**，以及 `processEvents()` 的重入半径。
