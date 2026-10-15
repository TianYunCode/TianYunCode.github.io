---
title: pthread 与 std::thread 对照
description: 实测：MinGW 上 sizeof(std::thread)=8 且 native_handle() 与 pthread_self 是同一个值；PTHREAD_CREATE_DETACHED 在这里等于 4 而不是 1；pthread_setschedparam(SCHED_FIFO) 返回 129；三种生命周期误用的退出码都是 0x00000003。
date: 2026-10-15
tags: [并发, pthread, std::thread]
category: concurrency
section: conc-api
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64）**，`-std=c++17 -O2 -Wall -Wextra -static`（C 侧用 `-std=gnu17`）。**编译 std::thread 程序没有加 `-pthread` 或 `-lpthread`，照样能跑**——这一条就是本节结论的起点。

## 一、MinGW 的 std::thread 就是 winpthreads 的一层壳

```text
  sizeof(std::thread)=8  sizeof(std::thread::id)=8  sizeof(pthread_t)=8
  native_handle()=0000000000000001，与子线程内 pthread_self 相同
  [子线程] GetCurrentThreadId=31864  pthread_self=0000000000000001
  join 后 joinable()=0，子线程确实跑过=1
```

三个尺寸全是 8 字节，而且 `t.native_handle()` 拿到的值和那个线程内部 `pthread_self()` 的返回值**一模一样**。所以在这套工具链上，`std::thread` 不是一个"抽象"，它就是**一个 pthread_t**，libstdc++ 只是包了 RAII 和状态位。

这解释了前面几节测到的所有行为：条件变量唤醒 11µs、`wait_for(10µs)` 实睡 15.1ms、`try_lock_for` 的 tick 取整——**那不是 C++ 标准库的实现，是 winpthreads 的实现**。换到 glibc 上，同一份 `std::thread` 代码走的是 NPTL，数值会完全不同。

顺带一个反直觉的观测：`pthread_self()` 在这台机器上是 **小整数**，主线程是 `2`、子线程是 `1`，不是指针。它只能拿来比较（`pthread_equal`），**不能打印出来当调试线索、更不能做算术**。

## 二、同名常数的字面值根本不是一套

写移植代码时最容易犯的错，是把 POSIX 文档里的数字当常量用。本机实测：

```text
  _POSIX_THREADS=200112  _POSIX_SEMAPHORES=200112  _POSIX_BARRIERS=200112  PTHREAD_KEYS_MAX=1048576
  PTHREAD_STACK_MIN：未定义（winpthreads 没给这个常量）
  CREATE_JOINABLE=0 CREATE_DETACHED=4
  MUTEX_NORMAL=0 RECURSIVE=2 ERRORCHECK=1 TIMED_NP=0
  EDEADLK=36 EBUSY=16 ETIMEDOUT=138 ENOTSUP=129 EINVAL=22
  SCHED_OTHER=0 SCHED_FIFO=1 SCHED_RR=2
  SCOPE_SYSTEM=16 SCOPE_PROCESS=0
```

三处必须记住的差异：

- **`PTHREAD_CREATE_DETACHED` 在这里是 4**。如果你在代码里写 `if (detach_state == 1)`（很多人凭"0/1 布尔"的印象写），在 winpthreads 上永远不成立。永远用宏，不要写数字。
- **互斥锁类型编号**是 `NORMAL=0 / ERRORCHECK=1 / RECURSIVE=2`，而 `TIMED_NP` 与 `NORMAL` 同为 0——也就是说 `PTHREAD_MUTEX_TIMED_NP` 在这套实现里只是个别名，不是独立的第四种。
- **errno 数值是 winpthreads 自定义的**：`EDEADLK=36`、`ETIMEDOUT=138`、`ENOTSUP=129`。把 `rc == 110` 当"超时"判断的代码，在这里永远不会命中。

还有一些**根本不存在**的东西，编译器直接告诉你：

```text
p2b.c:39: error: 'PTHREAD_STACK_MIN' undeclared (first use in this function); did you mean 'PTHREAD_START_ROUTINE'?
p2.c:57: warning: implicit declaration of function 'pthread_tryjoin_np'; did you mean '_pthread_tryjoin'?
p2.c:94: error: unknown type name 'sem_t'          ← 要 #include <semaphore.h>，pthread.h 不带它
```

`pthread_tryjoin_np` 在这里叫 **`_pthread_tryjoin`**（带下划线前缀，且 `_np` 系列基本没有）。Linux 上那套 `pthread_setname_np(thread, "name")` 也不是你要调的接口（见本篇第六小节）。

## 三、两套 API 的等价关系，以及 std::thread 缺什么

| 要做的事 | pthread（本机实测） | std::thread / std 对应物 |
| --- | --- | --- |
| 创建并回收 | `pthread_create` / `pthread_join` rc=0 | `std::thread` + `join()` |
| 分离 | `pthread_attr_setdetachstate` / `pthread_detach` | `t.detach()` |
| 试探性回收 | `_pthread_tryjoin`（非标准名） | **没有** `try_join` |
| 互斥 | `pthread_mutex_*` + 4 种类型属性 | `std::mutex` / `recursive_mutex` / `timed_mutex` |
| 读写锁 | `pthread_rwlock_*` 可用 | `std::shared_mutex`（C++17） |
| 条件变量 | `pthread_cond_*` | `std::condition_variable[_any]` |
| 信号量 | `sem_init/wait/post`（在 `<semaphore.h>`） | `std::counting_semaphore`（C++20） |
| 屏障 | `pthread_barrier_init`，`_POSIX_BARRIERS=200112` | `std::barrier`（C++20） |
| 一次性初始化 | `pthread_once` | `std::once_flag` + `call_once` |
| 线程局部 | `__thread int` 与 `pthread_key_t` **都可用** | `thread_local` |
| 取消线程 | `pthread_cancel` 语义 | **没有**（只能自己传标志位） |
| 栈大小 | `pthread_attr_setstacksize`（`PTHREAD_STACK_MIN` 缺声明） | **没有**接口 |
| 优先级/亲和性 | `pthread_setschedparam` **在此平台不可用** | **没有**接口 |

std::thread 侧缺的那四行（取消、栈大小、优先级、亲和性）正是很多人回去用 pthread 的唯一理由。但它们在这台机器上也并不都能用——看本篇第五小节。

本机的 POSIX 语义确实齐全（读写锁、信号量、屏障都能跑）：

```text
  rwlock：rdlock=0 再 rdlock=0 持读时 trywrlock=16（非 0 才对）unlock=0
  sem_init(2)：2 → sem_wait 后 1 → sem_post 后 2
```

递归读锁允许（两次 rdlock 都是 0），持读锁时抢写锁立刻返回 `EBUSY(16)`，信号量计数按预期增减。

顺带把 `ERRORCHECK` 型锁的行为钉住（这是 std 侧没有的第三种锁）：

```text
  lock=0 同线程重入 lock=36(EDEADLK=36) trylock=16(EBUSY=16) unlock=0 多余 unlock=1
```

同线程重入返回 `EDEADLK` 而不是阻塞、多解一次返回 1（`EPERM`）。而 `NORMAL` 型锁在同一线程已持有时 `trylock` 返回 16（EBUSY），**但阻塞版 `lock` 会真的死锁**——这正是本篇第三小节表格里"std::mutex 相当于 NORMAL 型"的实际含义。

## 四、三种生命周期误用，退出码都是 3

每项都另起一个子进程跑（否则主进程被 terminate 就看不到后面的了）：

```text
  线程抛异常 + detach         ⇒ 结束，退出码 0x00000003
  线程抛异常 + 主线程 join    ⇒ 结束，退出码 0x00000003
  joinable 状态下析构 std::thread ⇒ 结束，退出码 0x00000003
```

对应的 stderr 原文：

```text
terminate called after throwing an instance of 'std::runtime_error'
  what():  boom
terminate called after throwing an instance of 'std::runtime_error'
  what():  boom
terminate called without an active exception
```

三条必须刻在脑子里的规则：

1. **线程里抛出的异常不会传给你**，无论 `join` 还是 `detach`。它没人接手，`std::terminate` 立刻生效，进程退出码 3。`join()` 不是 `future.get()`，它不带回异常。
2. 线程函数应当当作 `noexcept` 来写：入口包一层 `try { … } catch (...) { 记录 }`。
3. `std::thread` 析构时如果还 joinable，**是程序化终止而不是异常**——第三种情形打的就是"without an active exception"，`catch(...)` 抓不到，`set_terminate` 才是唯一的补救点。

pthread 侧没有这个陷阱：`pthread_create` 之后你不调 `pthread_join` 也不会终止进程（泄漏一个句柄而已），函数里抛 C++ 异常同样 `terminate`。这是两种 API 在"忘记收尾"时行为上的真实差别。

## 五、跨 API 动 handle：成功，但埋雷

```text
  pthread_detach(native_handle) rc=0（成功），但 t.joinable() 仍是 1
terminate called after throwing an instance of 'std::system_error'
  what():  No such process
```

拿 `std::thread` 的 `native_handle()` 去调 `pthread_detach`：**返回 0，detach 真的生效了**，可 `std::thread` 对象内部的 `joinable` 标志它不知道，仍然是 `true`。之后你对同一个对象调 `detach()`（或 `join()`），libstdc++ 会去对一个已经不存在的线程下手，抛出 `std::system_error: No such process`——而在析构路径上抛异常，就是 `terminate`。

结论：**handle 只能读，不能改**。要么全程 std::thread，要么全程 pthread，混用只在"取来打印/取来比较"这个安全子集内。

## 六、命名、优先级、亲和性：std 侧没有，POSIX 侧也不全有

**优先级**这条最反直觉——本机的 POSIX 接口直接拒绝：

```text
  pthread_setschedparam(SCHED_FIFO) rc=129 → Windows 没有实时调度策略，只能映射到线程优先级
```

129 就是本机的 `ENOTSUP`。Windows 的调度模型只有 7 级线程优先级类，没有 POSIX 的实时策略与优先级数值域，所以 winpthreads 只能拒绝。想在 Windows 上提优先级，只能走 Win32：

```text
  绑到 0b100 后 GetCurrentProcessorNumber=2，GetThreadPriority=2（THREAD_PRIORITY_HIGHEST=2，THREAD_PRIORITY_NORMAL=0）
```

**注意这两个 API 是在线程函数体内部调用的**。原因就在本篇第二小节：`native_handle()` 给你的是 `pthread_t`（一个内部编号），不是 Win32 的 `HANDLE`，你在外面拿它调 `SetThreadAffinityMask` 是无效的。要在线程外面操作，得先用 `GetCurrentThreadId()` 传出来，再 `OpenThread`——代价是权限和生命周期都要自己管。**实践结论：亲和性和优先级一律在线程自己的第一件事里设置，不要试图从创建方设置。**

**线程命名**在这套工具链上是"两头都不顺"：

- MinGW 的 `windows.h` **没有声明** `SetThreadDescription`（Win10 1607+ 才有），隐式声明会给出警告：

```text
p1.c:9:18: warning: implicit declaration of function 'SetThreadDescription'; did you mean 'SetThreadDesktop'?
```

  正确做法是 `GetProcAddress` 动态取函数指针（这样在老系统上还能优雅降级）：

```text
  [子线程] SetThreadDescription 动态取到函数后设置，GetThreadDescription 读回名字=[probe-worker]
```

- `pthread_setname_np` 这套实现在 Windows 上没有对应效果，别指望调试器里看到它。

命名这件事的真实价值只在调试期（GDB/Process Explorer 里认线程），所以放到线程入口顺手做掉即可，不要为它增加跨平台分支——除非你愿意写"Linux 用 `pthread_setname_np`，Windows 用 `SetThreadDescription`"两条路径。

## 七、小结

- MinGW 上 `std::thread` = 8 字节 = 一个 `pthread_t`，`native_handle()` 与线程内的 `pthread_self()` 同值；不用 `-pthread`。**前面几节测出的所有时间行为，本质是 winpthreads 的行为。**
- POSIX 常量的**字面值不可移植**：本机 `PTHREAD_CREATE_DETACHED=4`、`EDEADLK=36`、`ETIMEDOUT=138`、`ENOTSUP=129`，且没有 `PTHREAD_STACK_MIN`，`pthread_tryjoin_np` 叫 `_pthread_tryjoin`，`sem_*` 在 `<semaphore.h>` 里。任何拿数字或凭别处文档写的判断都会静默失效。
- `std::thread` 缺四样：取消、栈大小、优先级、亲和性；pthread 侧的优先级在 Windows 上也被 `ENOTSUP` 拒绝。**亲和性/优先级只能在线程内部用 Win32 设**，因为 handle 类型对不上。
- 生命周期三坑退出码统一是 `0x00000003`：线程抛异常（join 也带不出来）、joinable 状态析构（`terminate called without an active exception`，`catch` 抓不到）。跨 API 用 `pthread_detach(native_handle())` 会返回成功但把 `std::thread` 对象留在错误状态，之后必抛 `No such process`。
- 迁移建议：**同一层抽象里走完**。需要 POSIX 特性就用 pthread 并放弃 std::thread；需要 C++ 就用 std 并把 OS 特有设置放线程入口；两边混用的部分只读不改。
