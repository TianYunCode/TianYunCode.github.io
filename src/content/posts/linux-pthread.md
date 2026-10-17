---
title: 多线程与同步
description: 未实测（本机无 Linux）：pthread 创建/分离的生命周期、互斥/条件/读写锁的属性与适用场景、线程取消的两阶段与取消点、以及线程名和栈大小的工程调法。
date: 2026-10-16
tags: [Linux, pthread, 互斥锁, 条件变量, 线程取消]
category: linux
section: linux-pthread
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级框架。站内对照实测：conc-mutex（锁的 uncontended 单价、数据竞争丢失率）、conc-condition-variable（谓词循环、notify 选择）、conc-task-queue（线程池参数）、conc-pthread-vs-std-thread（两套 API 对照，MinGW 侧实测）、win-thread-sync（Windows 临界区/互斥体/TLS 实测）。

## 一、pthread 的生命周期：创建、汇入与分离

```c
pthread_t th;
pthread_create(&th, NULL, worker, arg);   // 启动，立即返回
pthread_join(th, &retval);                // 阻塞等它结束，拿返回值，回收资源
// 或
pthread_detach(th);                       // 声明"我没打算 join"，结束时自动回收
```

三条规则：

1. **每个线程要么 join 要么 detach，没有第三种**。都不做的线程退出后资源不回收——**线程版的内存泄漏**，跑几万次创建后 `pthread_create` 开始失败。
2. **join 只能 join 一次，detach 之后不能 join**。join 一个已 detach 的线程返回 `EINVAL`。
3. **`pthread_exit` 与 `return` 的差别**：前者从线程函数任意位置退出并触发取消清理回调，后者只从函数末尾；**主线程 `return` 会杀掉整个进程里所有线程**（包括没 join 的），要等子线程必须主线程 `pthread_exit`。

属性（`pthread_attr_t`）常用两个：**栈大小**（默认 8MB 是虚拟内存，递归深的算法要么显式调大，要么 `pthread_attr_setstack` 指自己的栈）、**分离状态**（创建时即 detach，省一次调用）。线程名（`pthread_setname_np`，Linux 限 15 字符 + `\0`）是调试时 `top -H`/gdb 里认线程的唯一舒服方式——**不设名字的线程池在 core dump 里是一堆 `LWP 1234`**。

## 二、互斥锁：从普通到递归

| 类型 | 语义 | 场景 |
| --- | --- | --- |
| `PTHREAD_MUTEX_NORMAL`（默认 fast） | 重复加锁**死锁或未定义** | 大多数场景 |
| `PTHREAD_MUTEX_RECURSIVE` | 同线程可重复加锁，计数配对 | 递归函数、回调里可能重入的 API |
| `PTHREAD_MUTEX_ERRORCHECK` | 重复加锁返回 `EDEADLK` 而非挂住 | 调试期抓"忘记解锁" |
| `PTHREAD_MUTEX_ADAPTIVE`（glibc 扩展） | 竞争时先自旋再睡 | 临界区极短（几十 ns）的高争用锁 |

**强属性（robust）**：持锁线程死了，下一个加锁者拿到 `EOWNERDEAD`——能恢复共享状态后 `pthread_mutex_consistent` 继续，否则锁作废。用于"持锁进程可能被 kill"的场景，普通服务用不上。

**优先级继承**（`PTHREAD_PRIO_INHERIT`）：治优先级反转——低优先级线程持锁、高优先级等锁、中优先级把低优先级挤跑，高优先级就被中优先级无限期挡着。嵌入手动配，Linux 用户态默认不开。

**粒度原则**（conc-mutex 实测过的数字支撑）：临界区越小越好，但"每次加锁解锁"本身有成本（本站实测 uncontended 16.65ns 级）——**别为了粒度把一个大锁拆成八个小锁然后总是全拿**，那比一把大锁更慢还更易死锁。

## 三、条件变量：等待/通知的正确姿势

```c
pthread_mutex_lock(&m);
while (!condition_ready)              // ← 必须是 while 不是 if
    pthread_cond_wait(&cv, &m);       // 原子地：解锁 + 睡眠 + 被唤醒后重新加锁
// 条件成立，干活
pthread_mutex_unlock(&m);
```

三个为什么：

1. **为什么是 while**：**虚假唤醒**（实现可能无通知唤醒）、以及"醒来时条件可能又被别人改回去了"——重新检查是唯一正确姿势。
2. **为什么 wait 要持锁**：wait 原子释放锁并睡眠，否则"检查条件"和"进入睡眠"之间到来的一次通知会永久丢失（丢失唤醒 = 死等）。
3. **notify_one vs notify_all**：一个条件只放行一个等待者时用 one；条件变化影响多个等待者、或等待者在不同条件上时用 all。**用错 one 的经典症状是"该醒的没醒"**（本站实测过 notify_one 在小缓冲上死锁、notify_all 慢 5 倍的对照）。

**超时变体** `pthread_cond_timedwait` 用**绝对时间**（`clock_gettime(CLOCK_REALTIME)`）——相对时间的老接口在系统改时间时会永久失效，新代码用 `pthread_condattr_setclock(CLOCK_MONOTONIC)`。

## 四、线程取消：两阶段与取消点

`pthread_cancel(th)` 只是**请求**，目标线程走到**取消点**才真正退：取消点包括 `read`/`write`/`wait`/`sleep` 一类阻塞调用（可被 `pthread_testcancel` 手动插入）。控制手段：

- `pthread_setcancelstate(DISABLE/ENABLE)`：开关取消。
- `pthread_setcanceltype(ASYNCHRONOUS/DEFERRED)`：异步取消**任何时候生效**——极度危险（资源泄漏风险），只用在线程自己控制的纯净代码段。
- **取消清理回调**（`pthread_cleanup_push/pop`）：线程被取消时自动执行——**解锁、释放内存的唯一可靠时机**（相当于取消的 RAII）。

**现代实践是别用取消**：用"请求退出标志 + 自己检查"（本站 qt-thread 那节讲 Qt 侧协作式停止时给过完整骨架，conc 专栏同观点）。取消只在"线程可能永远阻塞在一个你不能控制的调用上"时兜底，且必须配清理回调。

## 五、排障索引

| 症状 | 入口 |
| --- | --- |
| 偶发卡死，`top -H` 看所有线程 D 状态 | 死锁：`gdb -p` 对所有线程 `thread apply all bt`，看谁等谁持有的锁 |
| 线程数缓慢增长 | join/detach 漏了（第一节） |
| CPU 100% 但无进展 | 自旋锁/忙等（取消点都碰不到）；或虚假唤醒风暴 |
| 偶发数据错乱 | 忘了加锁的共享变量；用 helgrind/DRD 或 TSan（dbg-sanitizer 提过 TSan 的原理） |
| 优先级反转式卡顿 | 配 `PTHREAD_PRIO_INHERIT` 或重设计锁顺序 |

## 六、未实测清单

- 本文所有 pthread 行为与成本——无 Linux 环境，未测。
- glibc 的 `PTHREAD_MUTEX_ADAPTIVE` 自旋行为——未测。
- 线程取消与清理回调的交互——未测。
- NPTL 与老 LinuxThreads 的差异（历史知识点）——未涉及。
