---
title: 协程与异步模型
description: 实测：C++20 协程 resume 只要 3.56 纳秒，10 万个协程 15.6 毫秒；Win32 Fiber 每个实占 32 KB，10 万个吃掉 3 GB；线程创建要 120.8 微秒。
date: 2026-10-15
tags: [并发, 协程, Fiber, IOCP]
category: concurrency
section: conc-coroutine
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64）**，`g++ -std=c++20 -O2 -Wall -Wextra -static -lpsapi`。C++20 协程与 Win32 Fiber 都在这台机器上真跑真量。**本节没有 Linux，所以 `epoll` / `io_uring` 只做机制说明、不给数字**；IOCP 与 select 的吞吐对比留给网络专栏，本节也不谎称测过。

## 一、异步的两张面孔：Reactor 与 Proactor

这两种模型的区别不是"同步/异步"，而是**"通知你什么"**：

| | Reactor（观察者） | Proactor（完成者） |
| --- | --- | --- |
| 通知内容 | "**可以**开始做 I/O 了"（就绪事件） | "I/O **已经做完**了"（完成事件） |
| 谁执行拷贝 | 你的线程调 `recv()` 时才真正拷贝 | 内核/DMA 在你发起时就拷完了 |
| 典型实现 | Linux `epoll`、`select`、Windows `WSAEventSelect` | **Windows IOCP**、Linux `io_uring` |
| 一次往返的代码量 | 就绪 → 再发一次 syscall | 发起 → 只等完成 |
| 多线程消费 | 要自己防两个线程同时处理同一 socket | `GetQueuedCompletionStatus` 天然分派 |

这也是为什么 Windows 网络代码的习惯是把**接收也做成"发起后等完成"**（`WSARecv` + IOCP），而 POSIX 世界习惯"就绪了再 `read`"。同一个业务在两种模型下的状态机形状是不同的：Proactor 里你必须处理"我发出去了但完成的字节数少于请求"和"完成携带错误码"，Reactor 里这些发生在下一次 syscall。

**Proactor 的隐藏代价**：`ReadFile`/`WSARecv` 传了 overlapped 结构也可能**同步返回**（短读、命中缓存、参数错误）。判据是 `GetOverlappedResultEx`/`WSAGetOverlappedResult`——`ERROR_IO_PENDING` 才是"真的异步"。很多人写 IOCP 只处理"完成包"这一路，同步返回那一支就漏了，表现为偶发挂死。

## 二、C++20 协程：编译器做的三件事，和本机实测的单价

一个最小的、真的能跑的协程（不依赖任何库）。注意我用的 awaitable **不能**在 `await_suspend` 里同步 `resume`——那样会把 n 次 await 变成 n 层递归调用，我第一版就是这么写的，100 万次 await 直接爆栈：

```cpp
struct Suspend {
    bool await_ready()  const noexcept { return false; }
    void await_suspend(std::coroutine_handle<>) noexcept {}   // 只是留在挂起态
    void await_resume() const noexcept {}
};
struct Task {
    struct promise_type {
        Task get_return_object() { return Task{std::coroutine_handle<promise_type>::from_promise(*this)}; }
        std::suspend_never  initial_suspend() noexcept { return {}; }   // 调用即开始执行
        std::suspend_always final_suspend()   noexcept { return {}; }   // 结束后不自动销毁
        void return_void() {}
        void unhandled_exception() {}
    };
    std::coroutine_handle<promise_type> h;
    void resume() { h.resume(); }
    bool done() const { return h.done(); }
    ~Task() { if (h) h.destroy(); }
};
Task loop_coro(int n) { for (int i = 0; i < n; ++i) co_await Suspend{}; }
```

`co_await` 展开成什么，只有三件事：**把局部状态搬进堆上的帧**、`await_suspend` 里保存恢复点、返回调用方。恢复时从保存点跳回，局部变量还在。

本机把全局 `operator new` 换上计数器，量出来的就是这三件事的价格：

```text
  创建并销毁 100000 个协程：   15.6 ms ⇒ 每个 0.16 µs
  堆分配次数=100001 总字节=6400000 ⇒ 单个协程帧约 64.0 字节（promise_type + handle + 局部量）
  单协程内 1000000 次 co_await，驱动循环 resume 1000000 次：     3.6 ms ⇒ 3.56 ns/次；堆分配=1 次
```

三条结论：

1. **一次 `resume()` 只要 3.56ns**，和第八节量的 `atomic fetch_add`（5.4ns）同量级——协程切换**不系统调用、不换栈、不改寄存器组**，本质是一次间接跳转 + 几个 load/store。这是它相对线程的全部优势来源。
2. **代价在"堆分配那一次"**：整个 100 万次 await 只分配了 **1 次**（帧），而创建/销毁 10 万个协程就是 10 万次分配，摊到 0.16µs/个——全在那一次 `new` 上。**帧分配器是协程性能的第一优化点**（池化帧、把帧塞进 arena）。
3. **帧只有 64 字节**（我这个协程只有一个 int 循环变量）。挂起状态更多时（配置里带 4 次 await 的 10 万个协程）实测 78 字节/个。**协程的内存是"活数据的大小"，不是"栈的大小"**——这句是和本篇第三小节 Fiber 对比的关键。

对照本专栏已经量到的三个数：

| 单位 | 创建 | 每次交接/切换 | 常驻内存 |
| --- | --- | --- | --- |
| 线程 | 120.8 µs（第一节） | 唤醒 11.44 µs（第三节） | ≈37 KB（第一节实测 200 线程 +7.45MB） |
| Fiber（有栈协程） | 见下节 | **41 ns/次切换** | **32172 字节/个** |
| C++20 协程（无栈） | 0.16 µs | **3.56 ns/次** | 64–78 字节/个 |

## 三、有栈协程的另一极：Win32 Fiber

Fiber 是系统提供的**有栈协程**：每个 fiber 有自己的栈，切换靠 `SwitchToFiber`。MinGW 的头里不一定声明了这些 API，我用 `GetProcAddress` 动态取（这本身也是一条 Windows 侧的常见处理方式）：

```text
  Fiber 来回切换 200000 次：    16.3 ms ⇒ 81.58 ns/次（一次完整往返 = 2 次切换）
```

**41ns 一次切换**，比协程的 3.56ns 贵 11 倍，但比线程唤醒的 11.4µs 便宜 278 倍。它贵在必须保存/恢复栈基址与相关上下文（`Tib.StackBase/StackLimit` 那套）。

真正决定取舍的是内存。同时创建 10 万个"挂起中"的单位：

```text
  100000 个挂起中的协程：私有提交 0.66 → 8.07 MB（每协程约 78 字节）
  100000 个创建好但没跑过的 Fiber（预留 16KB/提交 4KB）：私有提交 1.68 → 3069.83 MB（每个约 32172 字节）
```

**我明明请求了"预留 16KB、提交 4KB"，实际每个 Fiber 占了 32172 字节 ≈ 32KB**（分配粒度与 Fiber 结构本身的开销叠加），是协程帧的 **412 倍**，10 万个直接压进 **3 GB 提交内存**。注意这 10 万个 Fiber **一个都还没执行过**——栈的预留是"创建即付"的，不管你有没有用。

于是取舍很清楚：

| 维度 | 有栈（Fiber / ucontext / Go 协程） | 无栈（C++20 协程） |
| --- | --- | --- |
| 切换成本 | 41 ns | 3.56 ns |
| 每单位内存 | 32 KB（创建即占，与使用无关） | 64–78 字节（等于活数据大小） |
| 能存活的单位数 | 受提交内存限制（10 万个 = 3GB） | 百万级轻松（10 万个 = 8MB） |
| 能调用同步/第三方代码 | **能**：任何函数里都能切换，栈自动跟着走 | 不能：`co_await` 必须一路穿透调用链（"函数颜色"问题） |
| 栈溢出 | 有栈就要估深度（本节的 Fiber 我给了 16KB，深递归会炸） | 无栈：帧在堆上，但**递归 await 会把调用栈吃光**——我第一版 100 万次同步 `resume` 就是这么崩的 |
| 调试与局部变量 | 完整保留在栈上，栈回溯正常 | 局部变量搬到堆帧，部分调试器看不全 |
| 生命周期 | Fiber 必须显式 `DeleteFiber`（本文实测在删之前一直占内存） | RAII：`Task` 析构即 `destroy()` |

选择判据：**并发单位数 × 每个单位的活数据大小**决定用哪个。10 万个连接、每连接几十上百字节状态 → 无栈协程（8MB）；有栈（3GB）不可行。反过来，要在**既有同步代码深处**做挂起（第三方阻塞库、递归解析器），无栈协程做不到，只能有栈或者退回线程池。

## 四、Linux 那一侧：epoll 与 io_uring（本节未实测，只讲机制差别）

本机没有 Linux/WSL，所以这两句明确写出来：**epoll 和 io_uring 的行为数字我没有测过**，下面是机制说明，需要你在有 Linux 的环境复核后才能当结论用。

- **epoll**：Reactor。`epoll_ctl` 注册 fd，`epoll_wait` 拿就绪列表。它比 `select` 好的点是"不用每次重复传 fd 集合"（O(1) 注册、O(就绪数) 返回）。它解决的是"哪个 fd 可以读"，不解决"读好了数据在哪"。
- **io_uring**：Proactor。用户态提交队列（SQ）放 `read/write/accept` 这类请求，内核完成队列（CQ）取回结果；批量提交、可选真正的异步（支持的设备上 DMA 直达 buffer）。它同时省掉了"每次 syscall 一次陷入"的开销——这是它相对 epoll 结构性的优势。
- 两者都能配协程：epoll + 协程 = "就绪了再 resume 那个协程"；io_uring + 协程 = "提交时把协程句柄塞进 SQE，完成时 resume"。**协程和 I/O 多路复用是两层东西**，协程管"挂起/恢复的代码写法"，多路复用管"什么时候知道事件到了"。把它们混为一谈是常见的理解障碍。

## 五、Qt 里的协程（顺带一句，避免走偏）

Qt 6.9 的官方主线**没有**把协程当作业务层的标准写法（有实验性支持，不在此节实测范围）。Qt 的异步骨架仍然是**事件循环 + 信号槽 + 定时器**：`QTimer` 的精度问题不是协程能救的，因为唤醒源在事件循环里，而事件循环本身受系统定时器 tick 支配——本专栏量过的 `Sleep(1)` 实测 14.7–15.9ms、`wait_for(10µs)` 实测 15.1ms 就是同一条根因。想让定时更准，方向是"提高事件循环唤醒频率或改绝对期限定时器"，不是把同步代码改写成 `co_await`。

## 六、上手协程前先记住的四件事

1. **初始挂起/最终挂起的组合决定语义**：`suspend_never` 起始 = 调用即开始跑（我上面用的就是这个），`suspend_always` 起始 = 惰性（类似 `std::launch::deferred`，第七节量过它"在 get 之前一次都没执行"）。
2. **帧是堆分配**，所以 `promise_type::operator new` 是可以重写的钩子——把它接到 arena/pool，就是本篇第二小节说的"第一优化点"。
3. **异常要跨挂起点传递**，必须在 `unhandled_exception()` 里存下来，再在恢复方重抛。默认什么都不做 = 异常被吞掉。
4. **协程不是抢占**。它只在 `co_await` 处让出，所以**协程里的长计算会独占整个事件循环**——等价于"单线程 actor 里不能阻塞"（第七节）。CPU 密集那段该丢给线程池，回来再 `co_await` 结果。

## 七、小结

- **协程的单价（本机）**：`resume` 3.56ns、帧 64 字节、创建+销毁 10 万个共 15.6ms（0.16µs/个，其中一次堆分配是全部成本）；挂起态含局部变量时 78 字节/个。
- **有栈协程（Win32 Fiber）的单价**：切换 41ns（协程的 11 倍，线程唤醒 11.44µs 的 1/278），但每个 Fiber 实占 **32172 字节**——请求"预留 16KB/提交 4KB"仍吃掉 32KB，10 万个 = **3069.84 MB 提交内存**，而 10 万个协程只要 8.07 MB，**差 412 倍**。
- 取舍判据是**单位数 × 活数据大小**，不是"哪个更快"：百万级并发状态必须无栈；要在既有同步代码深处挂起只能用有栈或线程。
- Reactor 通知"可以做"，Proactor 通知"做完了"；Windows 的网络异步是 IOCP（Proactor），Linux 传统是 epoll（Reactor）、io_uring 才是 Proactor——**后两者本机未实测，只作机制说明**。
- Proactor 的必修课：发起后可能**同步完成**，必须两边都处理；协程的必修课：**只在 await 点让出**，所以协程里不能跑长计算。
