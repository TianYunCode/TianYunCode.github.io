---
title: 并发设计模式
description: 实测：std::async 每次派生 53.3 微秒，500 个小任务不 get 只靠析构兑现要 110.3 毫秒；launch::deferred 在 get 之前一次都不执行；COW 快照的盈亏平衡点。
date: 2026-10-15
tags: [并发, future, 无锁快照]
category: concurrency
section: conc-async-patterns
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64）**，`g++ -std=c++17 -O2 -Wall -Wextra -static`。同期有其他 agent 在抢核，绝对值偏大，**比值和拐点才是本节要给的结论**。所有涉及"算得对不对"的地方都带了校验和（300000 条消息的和 = 44999850000，两种投递方式都命中同一个值）。

## 一、future / promise：异步结果的四种正确用法与三种陷阱

先给单价：

```text
  std::async(launch::async) ×500 个空任务：26.6 ms ⇒ 每次派生 53.3 µs
  派生 500 个 0.1ms 任务后不 get，只靠析构 future：110.3 ms（析构会阻塞等结果）
  launch::deferred：Sleep(30) 后执行次数=0，get() 之后=1（返回值 42）⇒ 延迟到 get 的人才跑
  跨线程 promise→future 首次交付：76.0 µs（值=7）
  future 就绪后 wait_for 一轮：20.3 ns/次
  future.wait_for(0) 轮询：转了 1200097 次，14.5 ns/次
```

读法：

1. **派生一个 `std::async` 任务值 53.3µs**（第一节量的"创建+join 一个线程 120.8µs"是它的两倍——`std::async` 走的线程创建路径更轻，但仍比一次加锁贵 4000 倍）。**不要用它做细粒度并行**：`for (i) std::async(...)` 派生 500 个 0.1ms 任务，理论 0.1ms×500÷并行度，实测 **110.3ms**，因为——
2. **`std::future` 的析构会阻塞**（当它是 `launch::async` 且来自 `std::async` 时）。上面那 110.3ms 就是这么来的：每轮循环结尾 `f` 出作用域 → 等这个任务算完 → 完全串行。**想要"发出去就不管"，必须显式 `f.detach()`（把 shared state 交出去）或根本别留 future。**
3. **`launch::deferred` 不是"稍后由线程池跑"，而是"由调用 `get()` 的那个线程就地跑"**。实测：`Sleep(30)` 之后任务执行次数还是 **0**，`get()` 之后才变 1。这意味着把它塞进线程池时，任务会在**取结果的线程**（往往是 UI 线程）上执行——这是"我没有开线程怎么界面还是被后台任务卡住了"的成因之一。
4. **轮询 `wait_for(0)` 只要 14.5ns**，比一次条件变量唤醒（11.35µs）便宜 780 倍。所以"轻量地看一眼有没有结果"用 `wait_for(0)` 完全不丢人；但**别用它做主等待方式**（那 120 万次自转会占满一个核）。
5. **首次跨线程交付 76µs**：包含了对端线程的调度与唤醒。`future` 就绪之后的检查才 20.3ns。**所以 `future` 的代价在"等"，不在"取"。**

实践选择：

| 需求 | 用什么 |
| --- | --- |
| 要返回值、调用方愿意等 | `std::async` + `get()`（或干脆同步调用） |
| 要返回值、调用方不等 | `packaged_task`/`promise` 塞进池，结果交给回调或队列 |
| 只通知完成 | `std::binary_semaphore` / `condition_variable` / 完成计数 |
| 多个结果按序取 | 任务自己带序号，或用 `when_any`（注意 GCC 13 的 `when_any` 语义坑） |
| 细粒度并行 | **不要用 `std::async`**（53µs/个），用池 + 批处理 |

一个容易忽略的点：`promise`/`packaged_task` 的 shared state 是**线程安全的**（`set_value` 与 `get` 之间有同步），所以它是少数"可以放心跨线程交接"的标准对象。反面教材是裸的 `bool done` + 轮询——那是数据竞争（第二节量过：volatile 强制真读写后丢 70.7%）。

## 二、actor / 消息传递：它换来的不是速度，是"没有共享可变状态"

单生产者 → 单 actor 的邮箱（`deque` + 一把锁 + 一个条件变量），投 30 万条：

```text
  每消息一次加锁+notify：  27.2 ms ⇒ 0.091 µs/条，收到 300000 条，和=44999850000（期望 44999850000）
  一次锁投 1000 条（消费者整批取走）： 6.9 ms ⇒ 0.023 µs/条，收到 300000 条，和=44999850000
```

**攒批把每条消息的成本从 91ns 压到 23ns，4 倍**，而校验和一模一样。这条比"actor 比锁快/慢"重要得多：**消息传递的成本在进出邮箱的同步动作上，批量是唯一有效的杠杆**。同理，第三节"缓冲容量 1→256 带来 71 倍"讲的是同一件事。

那 actor 到底换来了什么？看这份消费者代码：

```cpp
while (!finished) {
    std::unique_lock<std::mutex> lk(m);
    cv.wait(lk, [&] { return !box.empty() || finished; });
    if (finished && box.empty()) return;
    sumv += box.front(); box.pop_front(); ++got;      // ← 数据只在 owner 线程里被改
}
```

`sumv`、`got` 都只有这一个线程碰，所以**业务逻辑部分完全不需要锁**，也不需要有内存序的知识。锁只出现在"交接"这一次，代价 91ns/条。对比第二节的写法：同一份状态被 8 个线程共享，每个字段都要加锁，临界区长一点就退化成串行。

所以选型判据不是性能，而是**状态归属**：

- 状态可以清晰归属某个 owner、且访问模式是"投递意图"（改配置、提任务、发事件）→ actor/邮箱。
- 状态是被大量线程读的小快照 → 下一节的 COW。
- 状态必须原地改、且有不变量跨字段 → 老老实实锁。

顺带两个 actor 的真实坑，我在这段代码里踩过：

1. **退出条件必须写进谓词**。第一版我写 `cv.wait(lk, []{return !box.empty();})`，然后设 `finished=true` 再 notify——消费者此时队列已空，谓词为假，**永远睡回去**。正确谓词是 `!box.empty() || finished`，且醒来后要"`finished && 空` 才退出"（否则关掉时队列里的消息被丢，正是第六节实测的 1860 个）。
2. **actor 里不能阻塞**。它只有一个线程，任何 `Sleep`/网络等待都会把整条邮箱堵住——第二节那句"等待放锁外"在这里升级为"等待放另一个 actor 里"。

## 三、双检锁与惰性初始化：标准件更快，也更短

第四节量过：**`call_once` 的"已完成"路径 3.11ns，比 `std::mutex`（13.29ns）还便宜 4 倍**。所以手写 DCLP 没有任何性能理由，只有出错理由。手写版的经典错法（用普通 bool + 裸指针）：

```cpp
if (!p) {                      // 无同步地读
    std::lock_guard<std::mutex> g(m);
    if (!p) { p = new X(); }   // 与上面那次读构成数据竞争；且 new 的写序可能被重排
}
```

三重问题：`p` 的两次访问没有 happens-before（第二节实测：无保护 RMW 丢 70.7%）；构造 `X` 的写与 `p` 的赋值之间没有屏障，别的线程可能拿到"指针非空但对象没构造完"；`new` 抛异常时状态不一致。

正确答案按优先级排：

1. **函数内静态局部变量**（Magic Static）。第四节反汇编验证过：热路径就是一次字节 load + test + 分支，`movzbl`；可零初始化的对象甚至**守卫都不生成**（只剩 `lea; ret`）。
2. **`std::call_once`**：需要"初始化失败可以重试"的语义时用它（标准保证异常时复位标志）。
3. 只有当上面两者都塞不进结构（比如对象由外部生命周期管理）才考虑原子指针 + acquire/release——那已经属于第八节内存序的范围。

## 四、读写快照（COW）：什么时候真的赢

写侧构造一份新数据、原子替换指针；读侧拿到指针后**不持任何锁**地慢慢用。C++17 用 `std::atomic_load/atomic_store` 这对自由函数（**注意：`std::atomic<std::shared_ptr<T>>` 在 GCC 13 的 C++17 下编不过**：`static assertion failed: std::atomic requires a trivially copyable type`，要 C++20 才 specialization）：

```cpp
std::shared_ptr<Config> g_conf = std::make_shared<Config>(...);
// 读者：auto c = std::atomic_load(&g_conf);  用 c 干活，不需要锁
// 写者：auto nw = std::make_shared<Config>(计算好的新值); std::atomic_store(&g_conf, nw);
```

单次读的开销（无竞争，20 万次 × 2 轮）：

```text
  atomic<shared_ptr> 快照 25.8 / 28.9 ns | shared_mutex 读锁 77.3 / 76.8 ns | mutex 18.4 / 18.8 ns
```

**这里有个反直觉的第一层**：读一个字段时 COW（26ns）**比 mutex（18.4ns）还慢**——因为 `atomic_load` 要复制 `shared_ptr`，附带一次**原子的引用计数自增**。而 `std::mutex` 在这台机器上是一次无竞争原子交换。所以"无锁一定更快"不成立。

真正的差别要放到并发读里看。8 个线程各做 3000 次读，读段长度不同：

```text
  读段    0 次累加：COW    2.4 ms | mutex   1.1 ms | shared_mutex   8.9 ms  ⇒ COW 比 mutex 快 0.45x
  读段   50 次累加：COW    3.3 ms | mutex   1.4 ms | shared_mutex   8.9 ms  ⇒ COW 比 mutex 快 0.41x
  读段  200 次累加：COW    5.3 ms | mutex   3.4 ms | shared_mutex  12.0 ms  ⇒ COW 比 mutex 快 0.64x
  读段  800 次累加：COW    6.3 ms | mutex  10.7 ms | shared_mutex  13.7 ms  ⇒ COW 比 mutex 快 1.70x
```

三条曲线说明了三件事：

- **交叉点在"读段 ~400 次累加"附近**。比它短，COW 的固定成本（原子引用计数）占主导，mutex 更好；比它长，mutex 的**串行化**开始收费（8 个线程排队），COW 因为读者互不阻塞而反超。
- **`shared_mutex` 全程最差**（8.9–13.7ms），和第四节的单价一致：它的读锁要 77ns，还未必能真正并行。**读写锁是这三者里最贵的设计**。
- COW 的时间随读段增长几乎是平的（2.4 → 6.3ms，8 倍读段只涨 2.6 倍），mutex 是线性的（1.1 → 10.7ms，涨 9.7 倍）。**读者并发度就是 COW 的全部收益来源**。

用 COW 的前提（缺一不可）：

1. **写少**——每次写都要复制整份数据（构造新 `shared_ptr`），写频繁就是灾难。
2. **读者要能容忍旧快照**。这是语义问题不是性能问题：读者拿到的指针可能来自几微秒前的版本，**跨两次读不能假设是同一版本**（每次 `atomic_load` 各自取一次）。要么一次读满所有需要的字段，要么把版本号和值一起打包进快照。
3. 数据必须**逻辑上不可变**（`const` 传下去），否则共享的副本会被偷偷改掉。
4. 生命周期靠 `shared_ptr` 兜住：老快照在最后一个读者放手后才析构——**这正是它比手写"指针+RCU 宽限期"安全的地方**，代价就是那一次原子引用计数。

## 五、四个模式的选择表

| 模式 | 本机实测依据 | 什么时候选 | 什么时候别选 |
| --- | --- | --- | --- |
| `std::async`/`future` | 派生 53.3µs；析构阻塞致串行 110.3ms；deferred 在 get 前 0 次执行 | 粗粒度、需要返回值、调用方愿意等 | 细粒度并行；UI 线程 `get()`；`deferred` 交给池 |
| actor/邮箱 | 逐条 0.091µs，攒批 0.023µs；校验和一致 | 状态可归属 owner、消息是"意图" | 需要原地读改共享结构、actor 里可能阻塞 |
| `call_once`/Magic Static | 已完成路径 3.11ns < mutex 13.29ns | 一切惰性单例 | 手写 DCLP（无性能理由，只有 bug） |
| COW 快照 | 读 26ns；读段 800 次时 1.70x 于 mutex | 读多写少、读者可容忍旧版本 | 读极短（不如 mutex）、写频繁 |

## 六、小结

- `std::async` 的隐藏成本是 **53.3µs 派生 + future 析构阻塞**，实测 500 个 0.1ms 任务被串行成 110.3ms；`launch::deferred` 的任务**在 `get()` 之前一次都没执行**，它跑在取结果的人身上。
- actor 的收益不是"快"，是**把锁的接触面缩到交接那一次**；而交接的成本可以用攒批从 91ns/条降到 23ns/条（4 倍）。退出谓词必须写成 `!box.empty() || finished`，否则会永久睡死或静默丢消息。
- **手写双检锁在这个平台上没有任何理由**：`call_once` 已完成路径 3.11ns，函数内静态变量的守卫是一次 `movzbl + test + 分支`，可零初始化的对象连守卫都没有。
- COW 快照的读单价（26ns）**比 mutex（18.4ns）贵**，因为要复制 `shared_ptr`（原子引用计数）；它的收益全部来自读者互不阻塞，读段要长到 800 次累加量级才反超（1.70x）。`shared_mutex` 在本机是三者中最贵的（8.9–13.7ms），全程没赢过。
- 三个平台事实要记住：GCC 13 的 C++17 **不接受 `std::atomic<shared_ptr>`**（trivially copyable 静态断言），得用 `atomic_load/atomic_store` 自由函数；`when_any`/协程属于后面两节。
