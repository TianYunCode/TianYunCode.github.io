---
title: Qt 6 多线程
description: 实测：idealThreadCount=12，QThread 创建均摊 1.4ms；线程池 10000 任务 156ms；release 默认定义 QT_NO_DEBUG 把 qDebug 编译掉。
date: 2026-10-16
tags: [Qt, 多线程, QThread, 线程池, QtConcurrent]
category: qt6
section: qt-thread
---

> 环境：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`），GCC 13.1.0，`-O2 -DNDEBUG` release 构建，探针用 `QT_QPA_PLATFORM=offscreen` 无头跑。**本文踩到的第一个坑值得先记下来**：release 构建的编译行里默认带 `-DQT_NO_DEBUG`，`qDebug()` 被**编译掉**——程序跑得飞起但一行日志都没有。本文所有探针改用 `fprintf(stderr, …)` 输出；要在 release 里用回 qDebug，在 `.pro` 里 `DEFINES -= QT_NO_DEBUG`。探针目录 `%TEMP%/qt3t3_*`，三个子目录各一套 `.pro`/`main.cpp`。

## 一、对象亲和：Qt 线程模型的基石

Qt 的线程模型和"线程函数"模型（pthread/Win32）的根本差别：**QObject 有亲和线程（affinity），`moveToThread()` 能把它搬到另一个线程**。规则三条：

1. **对象在哪个线程创建，就亲和哪个线程**（构造时 `thread()` 记录）。
2. **`w->moveToThread(th)` 之后，`w` 的事件由 `th` 的事件循环派发**——探针实测 `moveToThread 后 affinity == th: 1`。
3. **跨线程直接调用成员函数是未定义行为**，不是"可能慢"，是"可能踩数据竞争"。必须走信号槽（队列连接）或 `QMetaObject::invokeMethod`。

三条推论：GUI 对象只能住主线程（`QWidget` 及其子类，没有任何例外，连创建都不行）；工作对象（`QObject` 子类，不含 GUI）住工作线程；**跨线程通信只走事件循环**——这是"工作对象模式"的全部要点。

## 二、QThread 的两种正确用法与一种经典错误

Qt 4 时代的标准用法是**继承 QThread 并重写 `run()`**；Qt 4.8 之后官方推荐的是**worker 对象模式**：

```cpp
QThread* th = new QThread;
Worker* w = new Worker;          // 纯 QObject 子类，不含 GUI
w->moveToThread(th);
th->start();
// 之后：跨线程调用 w 的槽，通过信号槽（自动变队列连接）
```

两种用法的分工：

| 用法 | 适用 | 理由 |
| --- | --- | --- |
| 继承 QThread 重写 `run()` | `run()` 里是一个**不依赖事件循环的自包含任务**（跑完就退） | 简单，但没有事件循环就没有队列连接、定时器、跨线程调用 |
| worker 对象 + `moveToThread` | **长生命周期的工作线程**（要持续收任务、发进度） | 有事件循环，槽/定时器/跨线程调用全可用 |

**经典错误是两种混用**：继承了 QThread 又把 worker `moveToThread(this)`，或者 `run()` 里既写业务逻辑又指望事件循环处理槽——`run()` 默认实现是 `exec()`（启动事件循环），你重写了它，事件循环就没了，队列连接全部堆积不执行。症状是"跨线程调用偶尔灵偶尔不灵"，根因是目标线程有没有在跑事件循环。

**关闭顺序也有讲究**：`quit()` 只是请求退出事件循环，`wait()` 才阻塞到线程真的结束。worker 对象要在 `quit()` 之后、`wait()` 之前或之后用 `deleteLater()` 删（它在工作线程，不能主线程直接 `delete`）。探针里用 `aboutToQuit` 钩子做的就是这个顺序。

## 三、创建成本与默认值：1.4ms 与"0 字节栈"

实测（release，无竞争）：

```
idealThreadCount: 12                          ← 本机逻辑处理器数
create+start+wait+delete x50: 70 ms            ← 均摊 1.4 ms/线程
default stackSize: 0 bytes                     ← 0 = 用系统默认
优先级枚举: Idle=0 Lowest=1 Low=2 Normal=3 High=4 Highest=5 TimeCritical=6 Inherit=7
```

1. **1.4 ms/线程**意味着"来一个任务建一个线程"在每秒几百任务的量级上就是几百毫秒的纯开销——这是线程池存在的第一个理由。
2. **`stackSize()==0` 是用系统默认**（Windows 上通常 1 MB，见 win-thread-sync 那节的实测）。递归深的算法（解析、回溯）在线程里跑要显式 `setStackSize()`，否则爆栈的栈溢出信息指向一片混沌。
3. **优先级枚举 0–7 是 Qt 的抽象**，映射到平台优先级（见 os-scheduling 那节）：在 Windows 上 `TimeCritical` 映射到 `THREAD_PRIORITY_TIME_CRITICAL`（=15），**把计算线程设成 Highest 以上通常会拖垮整个机器**——实时优先级不是"更快"，是"抢别人的"。

## 四、QThreadPool 与 QtConcurrent：别自己管线程

`QThreadPool::globalInstance()` 的默认行为实测：

```
pool maxThreadCount: 12, expiryTimeout: 30000 ms
QThreadPool 10000 任务 x1000 自增: 156 ms, counter=10000000 ✓
QtConcurrent::run 1000 任务: 19 ms, counter=1000000 ✓
```

- **`maxThreadCount` 默认 = `idealThreadCount()`**（本机 12），空闲线程 30 秒后回收。10000 个 `QRunnable` 任务跑完只创建了至多 12 个线程——**1.4ms × 10000 = 14 秒的创建成本被摊成 0**。
- **`expiryTimeout=30000`** 是双刃剑：突发流量后线程保留 30 秒，对连续突发友好；但每个保留线程都占着栈（1 MB 提交），12 个就是 12 MB 常驻（win-thread-sync 实测过线程栈的提交行为）。
- `QtConcurrent::run` 是 `QThreadPool` 的语法糖，返回 `QFuture`；`blockingMap/blockingFilter` 是批量并行。本文测 `blockingMap` 10 万个"乘二加一"只用了 0 ms、和串行 for 无差别——**工作量太小测不出调度开销**，这不是 QtConcurrent 快，是 trivial 操作的地板效应。要用它，任务得有真实的计算量（本文的 10000×1000 自增就是：156 ms）。

**线程数的经验值**：CPU 密集型任务，池大小 = 逻辑核数（默认就对）；IO 密集型（等网络/磁盘），可以开到 2–4 倍核数——Qt 的 `QThreadPool` 不区分，超了就是上下文切换白耗。**别把 `maxThreadCount` 设成 64 碰运气**，那是把调度问题转嫁给操作系统。

## 五、跨线程信号槽：连接类型决定执行位置

信号槽跨线程时 `Qt::AutoConnection` 自动变成 `Qt::QueuedConnection`：**发射时把调用打包成事件，投递到接收者线程的事件队列，由接收者线程执行**。四个必知点：

1. **槽在接收者线程执行，发射者线程继续跑**——"发射完立刻读结果"是错的，要等另一个信号回来。
2. **第五个参数可以指定连接类型**：`Qt::DirectConnection` 强制在发射者线程直接调（接收者的槽跑在发射者线程里，这时才需要自己加锁）；`Qt::BlockingQueuedConnection` 发射者阻塞等槽跑完（**两条线程相同会死锁**，Qt 有检测会警告）。
3. **队列连接的参数是拷贝**：`emit progress(value)` 传的值在投递时拷贝，接收者改拷贝不影响发射者。跨线程传大对象用 `QSharedPointer`/`std::shared_ptr` 或注册元类型传指针。
4. **`QMetaObject::invokeMethod(w, fn, Qt::QueuedConnection)`** 是不定义信号时的等价物，本文探针实测 affinity 切换后投递正常。

**数据竞争的最后防线**：跨线程共享的可变状态，要么用 `QAtomicPointer`/`std::atomic`，要么用 `QMutex` 包住。信号槽**不保证互斥**，它保证的是"在接收者线程里执行"——两个工作线程互相发信号，各自线程里的槽仍然并发。

## 六、worker 对象模式的完整骨架

把上面的规则拼成可直接抄的模板：

```cpp
// worker.h：纯 QObject，不含任何 GUI
class Worker : public QObject {
    Q_OBJECT
public slots:
    void start() {           // 在 th 线程执行
        for (int i = 0; i < 100; i++) {
            if (stopped) return;
            emit progress(i);        // 队列回主线程
        }
        emit finished();
    }
    void stop() { stopped = true; }
signals:
    void progress(int);
    void finished();
};
// main：创建、接线、销毁
QThread* th = new QThread;
Worker* w = new Worker();
w->moveToThread(th);
connect(w, &Worker::progress, this, &MainWnd::onProgress);   // 队列
connect(w, &Worker::finished, th, &QThread::quit);           // 完成即退循环
connect(th, &QThread::finished, w, &QObject::deleteLater);   // 线程结束后删 worker
th->start();
// 退出：w->stop()（跨线程调用，要在 worker 里用原子标志）
```

五个细节都别省：`stopped` 用 `std::atomic<bool>`（主线程写、工作线程读）；`deleteLater` 而不是 `delete`（对象在别的线程）；`finished` 接 `quit()` 而不是外部猜什么时候完；`progress` 的频率要节流（每毫秒发一次信号等于用事件循环做忙等）；**线程对象本身归属主线程**，`delete th` 在主线程做。

## 七、与 pthread/Win32 的对照与未实测清单

| 概念 | Qt | 原生 |
| --- | --- | --- |
| 创建 | `QThread::create` / 继承 / 池 | `pthread_create` / `CreateThread` |
| 线程函数 | 事件循环（`exec()`）或无返回的 `run()` | 函数指针 + void* 参数 |
| 等待 | `wait()` | `join` / `WaitForSingleObject` |
| 取消 | 无（用原子标志协作式） | `pthread_cancel`（危险，本站不推荐） |
| 线程局部 | `thread_local` 或 `QThreadStorage` | TLS |

**Qt 没有线程取消**——这是特性不是缺陷：取消点语义在 C++ 里几乎不可能做对（资源泄漏风险），协作式停止（原子标志 + 定期检查）是唯一安全姿势。conc 那节的 `stop` 请求模式和这里同一个思想。

**未实测清单**：`QThread::setPriority` 在 Windows 上的实际调度效果（属于 os-scheduling 篇的范围）；`QtConcurrent::run` 的 `QThreadPool` 在自定义 `QThreadPool` 实例上的隔离行为；QML 工作线程（`WorkerScript`）——本文未涉及；线程 sanitizer（TSan）对 Qt 信号槽的检查（MinGW 上 TSan 链不上，conc-mutex 那节量过）。

下一篇 qt-performance 讲界面卡顿的定位：重绘风暴、事件循环阻塞和大列表虚拟化。
