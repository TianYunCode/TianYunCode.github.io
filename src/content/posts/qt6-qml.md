---
title: QML/Quick 与 C++ 混合
description: 实测：offscreen 下 QML 引擎首次加载 302ms、组件创建均摊 0.035ms；C++ 属性写 1000 次经 5 层绑定链传播共 1ms 且末端值正确；附 Widgets 与 QML 的选型判据。
date: 2026-10-16
tags: [Qt, QML, Quick, 混合编程, 属性绑定]
category: qt6
section: qt-qml
---

> 环境：Windows 11 x64，**Qt 6.9.3 for MinGW**，GCC 13.1.0，release 构建，`QT_QPA_PLATFORM=offscreen` 无头跑。探针 `%TEMP%/qtqml/`：`Main.qml`（组件加载）、`Bind.qml`（绑定链）。**offscreen 下 QML 引擎可以完整跑起来**（编译、实例化、绑定、属性系统全部工作），只是没有真实窗口合成——所以本文的结构性结论（加载成本构成、绑定传播、C++/QML 边界）可靠，**渲染帧率类数字不可靠**（没有合成器）。另外注意 release 默认 `-DQT_NO_DEBUG` 把 `qDebug` 编译掉，探针用 `fprintf`。

## 一、QML 引擎的三笔固定开销

```
QQmlApplicationEngine 首次加载: 302 ms
QQmlComponent::create x200: 7 ms（均摊 0.035 ms/个）
C++ 属性写 x1000 → 5 层绑定链刷新: 1 ms（每次约 1 µs），末端 computed = 1003 ✓
```

三个数字定义了 QML 应用的性能画像：

1. **302 ms 是引擎启动税**：QML 引擎初始化（编译缓存、类型系统、内置模块注册）在第一次加载时一次性付出，**和应用界面复杂度无关**。所以 QML 应用的冷启动通常比 Widgets 应用慢几百毫秒——这不是你的 QML 写得差，是引擎的固定成本。缓解手段：`qmlcachegen`/`qt6_add_qml_module` 做编译期缓存（把 QML 编译成 C++，省掉运行时的解析）、启动画面先显示（Widgets 窗口或 `QSplashScreen`）再加载引擎。
2. **组件创建 0.035 ms/个很便宜**：实例化一个声明式组件的成本和创建几个 QObject 相当。动态创建/销毁 delegate（列表滚动）的开销不在创建，在绑定维护和绘制。
3. **绑定传播 1 µs/次**：C++ 侧一次属性写触发整条依赖链重算（本文 5 层深），均摊 1 µs。**绑定不是性能瓶颈，滥用绑定导致的意外重算才是**——一个绑定了 `backend.counter` 的属性，counter 每变一次它就重算一次，不管有没有人在看。

## 二、绑定机制：声明式的心跳，也是最大的坑

QML 的属性绑定是**依赖自动跟踪的响应式图**：`property int b: a + 1` 在 `a` 变化时自动重算。实测确认这条链在 C++ 属性写入时正确传播到末端（1003）。用它的四条军规：

1. **绑定是惰性求值 + 变化推送**：`b` 被读到时是当前值，`a` 变时 `b` 被推着重算。**别在绑定表达式里写副作用**（`onXChanged: doSomething()` 是信号处理器，可以；绑定表达式里调函数改状态，调试地狱）。
2. **绑定会被赋值打断**：`b = 5`（命令式赋值）之后，`a` 再变也不会更新 `b` 了——绑定被覆盖。想恢复只能重新赋绑定表达式。这个行为是"声明式 UI 状态莫名不更新"的头号原因。
3. **`Qt.binding()` 显式重建**：需要在命令式赋值后恢复绑定时用。
4. **列表数据用模型，不要用绑定数组**：`property var items: [...]` 每次改都重建；数据集合走 `QAbstractItemModel`（C++）或 `ListModel`（QML），视图只消费模型。

## 三、把 C++ 暴露给 QML：四条通道，按场景选

| 通道 | 写法 | 适用 | 注意 |
| --- | --- | --- | --- |
| 上下文属性 | `rootContext()->setContextProperty("backend", &obj)` | 单例式的后台对象（本文探针用法） | 类型是 `QObject*`，QML 侧当 JS 对象用 |
| `qmlRegisterType` | `qmlRegisterType<Backend>("App", 1, 0, "Backend")` | QML 里要 `Backend { }` 实例化 | 需要 `Q_OBJECT` + 默认构造 |
| `QML_ELEMENT`（Qt 6） | 类定义旁加宏，构建系统自动注册 | 新项目的首选，少写注册代码 | 需要 `qt6_add_qml_module` 配合 |
| 单例 `QML_SINGLETON` | 配合 `qmlRegisterSingletonInstance` | 全局只用一个实例（设置、服务） | 注意初始化顺序 |

**暴露属性的最小充分集**：`Q_PROPERTY(Type name READ getter WRITE setter NOTIFY changed)` 四件套。缺 NOTIFY，QML 的绑定收不到变化通知（C++ 改了 QML 不刷新）；缺 WRITE，QML 赋值报错；类型如果不是 QVariant 可转换的内置类型，要 `Q_DECLARE_METATYPE`。

**方法**：`public slots:` 或 `Q_INVOKABLE` 都能被 QML 调用，返回值和参数类型走元对象系统转换（`int`/`QString`/`QVariantMap`/`QObject*` 都行，自定义结构体要注册）。

## 四、线程边界：QML 渲染线程与 C++ 对象的宿命

Qt Quick 的线程模型比 Widgets 多一层：**QML 场景图可以在独立渲染线程**（`basic`/`threaded` 渲染循环），但**所有 QObject 的事件、属性、绑定仍在主线程（GUI 线程）**。规则：

1. **C++ 对象默认住主线程**，QML 里直接调用它的方法/属性都在主线程——**别在 C++ getter 里做耗时操作**，它会卡住整个 UI（QML 的绑定求值同步发生）。
2. **工作线程的数据要用模型或信号桥接**：后台线程算完的数据，通过 `QAbstractItemModel`（模型有跨线程安全的数据变更接口）或信号槽（队列连接）送到主线程，再让 QML 读。**直接在 getter 里读工作线程的变量 = 数据竞争**。
3. **图片/大对象的解码放工作线程**，用 `QQuickImageProvider`（异步提供）或自己管理 `QPixmap` + 信号——Qt Quick 不会替你并行化 getter。
4. `WorkerScript`（QML 内的工作线程）**不能用 DOM/可视对象**，只能做纯计算 + `sendMessage` 回主线程——它的定位是"把一段计算从 UI 线程挪走"，不是"并发渲染"。

## 五、Widgets 还是 QML：四条判据

本站同专栏的 widget-layout、model-view、painting 三节量过 Widgets 的完整能力，本文量了 QML 的骨架成本。选型判据：

| 判据 | 选 Widgets | 选 QML |
| --- | --- | --- |
| 界面形态 | 桌面级复杂界面（多面板、菜单、停靠、原生对话框） | 类 App 的流畅界面（动画、转场、触摸手势） |
| 团队技能 | C++ 为主，有 Win32/Qt Widgets 存量代码 | 有前端经验，设计师要能改界面 |
| 启动预算 | 敏感（QML 引擎 302 ms 税） | 不敏感（有启动画面） |
| 生态依赖 | 大量原生控件、复杂表格/树 | 要炫的动画、移动端、车载 HMI |

**混合是常态不是妥协**：Qt 6 官方推的就是混合架构——**QML 做界面层，C++ 做逻辑与数据层**（暴露模型和单例），重的原生界面（设置对话框、关于框）继续用 Widgets。本站的实践建议更直接：**桌面工具、内部工具、要原生感的，Widgets；要动画要好看的、面向触屏的，QML；别用 QML 重写已经跑着的 Widgets 界面**——那是用引擎税换皮肤。

## 六、未实测清单

- offscreen 下没有真实渲染循环，**帧率、GPU 上传、场景图遍历成本未测**——这些要在真机/真窗口上测。
- `qt6_add_qml_module` + `qmlcachegen` 的启动加速效果——本文用的是 `engine.load(QUrl)` 直接加载，未走编译期缓存路径。
- QML 的 `ShaderEffect`、粒子系统、3D（Quick3D）——未涉及。
- `QQuickWidget`（把 QML 嵌进 Widgets 界面）的合成开销——未测；已知它有额外的纹理拷贝，性能敏感的场景要么纯 Widgets 要么纯 QML。

下一篇 qt-cross-platform 讲 windeployqt 与部署，把"本机能跑、别人机器上缺 DLL"这件事量完。
