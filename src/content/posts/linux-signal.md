---
title: 信号与异步安全
description: 未实测（本机无 Linux）：信号投递与默认处置表、sigaction 相对 signal 的三个修正、异步信号安全函数清单（为什么 handler 里不能 printf）、self-pipe 把信号转成事件循环的标准模式。
date: 2026-10-16
tags: [Linux, 信号, sigaction, 异步安全, self-pipe]
category: linux
section: linux-signal
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级框架。相关实测引用：本站 dbg-crash 量过 Windows 侧的信号式终止码（0xC0000094 除零等）与栈溢出现场；conc-mutex 量过锁单价。信号语义以 `man 7 signal` 为准。

## 一、信号是什么：软件中断

信号是内核发给进程的**异步通知**：来源可以是用户（Ctrl-C）、内核（段错误、子进程退出）、其他进程（`kill`）。生命周期三段：**产生 → 挂起（pending） → 投递（进程在核态返回时检查并处理）**。处理方式三种：

1. **默认处置**：终止（TERM/INT/SEGV…）、终止+core（QUIT/ABRT…）、停止（STOP）、继续（CONT）、**忽略**（CHLD/WINCH…）。
2. **自定义 handler**：`sigaction` 注册的函数。
3. **忽略**：`SIG_IGN`（**SIGKILL/SIGSTOP 不可捕获不可忽略**，这是内核留给管理员的后门）。

两个常被忘的点：**信号不排队**——同一信号在 pending 期间重复发送只投递一次（标准信号是位图不是队列）；**阻塞（block）≠ 忽略**：`sigprocmask` 阻塞的信号到达时挂起，解除阻塞才投递——**"用阻塞代替 handler 做临界区"是标准模式**。

## 二、sigaction：signal() 的三个修正

老 API `signal()` 有三个坑，`sigaction` 全修了：

| 坑 | signal 的行为 | sigaction 的修法 |
| --- | --- | --- |
| handler 触发时内核把处置重置为默认 | 必须 handler 第一行再注册（竞态窗口） | `SA_RESTART`/不带都好，**不自动重置** |
| 慢系统调用被信号打断即返回 EINTR | 要么自己重试要么认了 | `SA_RESTART` 自动重启可重启的系统调用 |
| 拿不到发送者信息 | 不知道是谁发的 | `SA_SIGINFO` + `sa_sigaction` 拿 `si_pid`/`si_code`/`si_value` |

最小骨架：

```c
struct sigaction sa = {0};
sa.sa_handler = on_sigchld;        // 或 SA_SIGINFO + sa.sigaction
sigemptyset(&sa.sa_mask);          // handler 执行期间额外阻塞的信号
sa.sa_flags = SA_RESTART;          // 慢系统调用自动重启
sigaction(SIGCHLD, &sa, NULL);
```

**`sa_mask` 的用途**：handler 本身不可重入（同一信号再次到达会阻塞在 handler 里，不会并发执行），但**不同信号会并发嵌套 handler**——把相关的都塞进 sa_mask，把复合操作保护起来。

## 三、异步信号安全：handler 里的白名单

handler 运行在**任意两条指令之间**——它可能打断一个正拿着锁的 `malloc`。此时 handler 里调 `malloc`/`printf`/`exit`，就是**在自己身上制造死锁**。POSIX 规定了一小组**异步信号安全（async-signal-safe）**函数，白名单外的一律不能在 handler 里调。安全的核心：`write`、`_exit`、`kill`、`signal` 类、`abort`、`sleep`（部分实现）。**`printf` 不在名单里**（它内部要拿 stdout 锁 + malloc）。

所以 handler 里的标准姿势只有三件事：**置一个 `volatile sig_atomic_t` 标志、`write` 一个字节、`_exit`**。任何"在 handler 里干活"的冲动，都用第五节的自管道模式疏导。

## 四、常用信号的语义速查

| 信号 | 默认 | 典型用途与语义 |
| --- | --- | --- |
| SIGINT (2) | 终止 | Ctrl-C，**前台进程组全体收到**（linux-process） |
| SIGTERM (15) | 终止 | "请优雅退出"的标准请求——**优雅退出的程序必须处理它** |
| SIGKILL (9) | 终止 | 不可捕获，内核强杀；systemd 的 KillMode 最后手段 |
| SIGSEGV/SIGBUS/SIGILL/SIGFPE (11/7/4/8) | core | 程序错误的信号形态；**段错误的 handler 里只能 _exit 或 async-safe 操作**（dbg-crash 量过 Windows 侧对应物） |
| SIGCHLD (17) | 忽略 | 子进程停止/退出；`wait` 配 `WNOHANG` 轮询或 handler 里置标志 |
| SIGPIPE (13) | 终止 | **写已关闭的管道/socket**——网络程序的第一杀手：必须忽略它（`SIG_IGN`），否则对端早退时本地被莫名杀死 |
| SIGALRM/SIGUSR1/2 | 终止 | 定时器/用户自定义（老式超时机制，现代用 timerfd） |
| SIGSTOP/SIGCONT (19/18) | 停止/继续 | 作业控制；STOP 不可捕获 |

## 五、self-pipe：把信号变成事件循环里的事件

信号和事件循环（select/epoll）混用的死结：handler 里不能做 IO，而事件循环只在 `epoll_wait` 返回时醒——**信号到达时循环可能正睡着，永远不醒**。标准解法是 **self-pipe trick**：

```c
int pipefd[2]; pipe2(pipefd, O_NONBLOCK | O_CLOEXEC);   // 创建即设好标志
sigaction(SIGINT, &sa_with_handler_write_to_pipe, NULL);
// epoll 关注 pipefd[0] 的 EPOLLIN
// handler: write(pipefd[1], "x", 1);   ← 白名单里的 write
// 事件循环：pipefd[0] 可读 → drain 管道 → 检查标志 → 处理
```

要点：**写端非阻塞**（管道满时 handler 的 write 不能阻塞——非阻塞下满了静默丢也没关系，信号状态本来就是标志位）、**读端读完**（ET 模式下读到 EAGAIN）。Linux 上还有更干净的 `signalfd`：把信号集变成可 epoll 的 fd，彻底不用 handler——代价是丢了"信号处理函数"的通用性（linux-io-multiplex 会把它和 eventfd/timerfd 并列讲）。

## 六、排障索引

| 症状 | 入口 |
| --- | --- |
| 进程收到信号就死且没日志 | handler 没注册或调了非安全函数崩了；`dmesg` 看 core 记录 |
| 对端关闭后本地进程消失 | SIGPIPE 没忽略（第四节） |
| 优雅退出慢半拍 | handler 只置了标志但主循环阻塞在长 IO；检查阻塞点是否可被 EINTR 打断 |
| 信号"丢了" | 标准信号不排队，密集发送会合并；要排队用实时信号（SIGRTMIN+n）或 signalfd |
| 多线程里信号投递混乱 | 信号投递给"不阻塞它的任一线程"；**专用信号线程**（`pthread_sigmask` 全阻塞 + 一线程 sigwait）比 handler 更可预测 |

## 七、未实测清单

- 本文所有信号语义与代码行为——无 Linux 环境，未测。
- core dump 的生成与分析（`ulimit -c`、`core_pattern`、gdb 加载）——未测；Windows 侧的 minidump 实测见 dbg-crash。
- signalfd/timerfd 的实测——未测。
- 实时信号的排队行为——未测。
