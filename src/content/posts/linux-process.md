---
title: 进程创建与执行
description: 未实测（本机无 Linux）：fork 的写时复制与"返回两次"、exec 族的参数传递与 PATH 搜索、wait/WNOHANG 与僵尸进程、进程组/会话/控制终端的信号投递规则。
date: 2026-10-16
tags: [Linux, 系统编程, fork, exec, 僵尸进程]
category: linux
section: linux-process
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，是手册级知识框架。Windows 对侧的本机实测见 os-process-and-thread（纤程切换、Sleep(0) 的上下文切换计数）与 win-thread-sync（CreateThread 的栈提交行为）。

## 一、fork：一次调用，两个返回

`fork()` 是 Linux 创建进程的唯一系统调用（`clone` 的封装）。它的语义是三句话：

1. **子进程拿到父进程的完整副本**：地址空间（写时复制）、fd 表（共享打开文件描述）、信号处置（**忽略的继承、捕获的复位为默认**）、进程属性。
2. **返回两次**：父进程拿子进程 PID，子进程拿 0。**两个返回之后的代码是完全并发的两条路**——这是所有 fork 程序的第一复杂性来源：共享的 fd、缓冲区的双份（stdio 缓冲在 fork 前没 flush 会两边各输出一次）。
3. **写时复制（COW）**：fork 时不真拷贝内存，只把页标为只读，写的时候才复制。所以 fork 一个占用 2GB 的进程是瞬时的——**"fork 很慢"是误解，"fork 后 touch 每一页"才慢**。

**fork 的安全禁区**：多线程进程里 fork，子进程只继承**调用线程那一个**——其他线程持有的锁在子进程里永远没人释放。子进程里只能做**异步信号安全**的事然后立刻 `exec` 或 `_exit`。这是"多线程服务器 fork 后死锁"的根因。

## 二、exec 族：换程序不换进程

`execl/execlp/execle/execv/execvp/execvpe` 是同一系统调用的不同封装（参数列表 vs 数组、是否搜 PATH、是否传环境）。语义：

- **进程不变，程序替换**：PID、fd（除非设了 `FD_CLOEXEC`）、进程属性全部保留；代码段、数据段、栈全新。
- **`FD_CLOEXEC` 是卫生习惯**：所有 `open` 的 fd 默认**会**被 exec 继承——忘了设这个标志，exec 出来的程序会攥着一堆不该有的 fd（经典事故：被 exec 的守护进程攥着监听 socket，导致原进程退出后端口不释放）。正确做法是创建时就带 `O_CLOEXEC`。
- **`execvp` 搜 PATH**：`execl("/bin/ls", ...)` 是绝对路径不搜；`execlp("ls", ...)` 搜 PATH——**PATH 来自调用方的环境，不确定的 PATH 是安全隐患**。
- **失败只有一种返回**：exec 成功就不返回；返回 -1 就是失败，错误在 errno（`ENOENT` 找不到、`EACCES` 没执行位、`ENOEXEC` 不是可执行格式）。

**经典组合 `fork + exec`**（shell 跑一条命令的骨架）：fork 出子进程，子进程 `execvp`，父进程 `waitpid`。中间还要处理：stdio 重定向（子进程 dup2）、管道（pipe + dup2 两头）、忽略信号复位。

## 三、等待与僵尸进程

子进程退出时**不会立刻消失**：它在进程表里留一个退出状态条目等父进程收，这就是**僵尸（zombie）**——不占内存，但占 PID。父进程收它的手段：

- `wait(&status)`：阻塞等任意子进程。
- `waitpid(pid, &status, options)`：等指定的；`WNOHANG` 非阻塞轮询（事件循环里配 SIGCHLD 用）；`WCONTINUED` 等停止后继续的。
- **退出码读法**：`WIFEXITED` + `WEXITSTATUS`（正常退出码，0–255）；`WIFSIGNALED` + `WTERMSIG`（被信号杀死，**shell 的 128+n 就是这么来的**）；`WIFSTOPPED`（被作业控制停住）。

僵尸的两种死法：**父进程不收**（编程 bug——每个 fork 都要有配对的 wait，或者父进程明确声明 `SA_NOCLDWAIT` 忽略 SIGCHLD）；**父进程先死**（init 收养并收尸，所以短命僵尸常见于"父进程忘了 wait"的长命服务）。排障：`ps aux | grep Z` 看到 `[name] <defunct>` 后，去查它的 PPID。

## 四、进程组、会话与控制终端

这三个概念是作业控制（shell 的 Ctrl-C、后台任务）的地基：

```
会话（session）── 首领进程 + 若干进程组 + 控制终端
进程组（process group）── 首领 + 若干成员，PGID = 首领 PID
```

- **`setpgid` 建组**：shell 把一条管道的所有进程放进同一进程组，Ctrl-C 时内核把 SIGINT **发给整个前台进程组**——这就是"按一次 Ctrl-C 整条管道都停"。
- **`setsid` 建会话**：调用者成为新会话首领、新进程组首领、**脱离控制终端**——守护进程标准动作的第一步（linux-daemon 那节）。
- **控制终端**：会话最多一个；前台进程组的成员能读终端，**后台进程组读终端会收到 SIGTTIN**（写是 SIGTTOU，`stty tostop` 开启时）。ssh 断开时内核给前台组发 SIGHUP——**不处理 SIGHUP 的后台任务会被杀**（nohup/disown 就是绕这个）。

## 五、排障索引

| 症状 | 第一嫌疑 |
| --- | --- |
| 一堆 `<defunct>` | 父进程没 wait（第三节） |
| 服务端口不释放 | exec 继承的 fd 没设 CLOEXEC，或子进程攥着监听 socket |
| 输出重复一份 | fork 前没 fflush，stdio 缓冲两边各写 |
| Ctrl-C 杀不掉子进程 | 子进程 `setsid` 脱了组，或自己建了进程组 |
| nohup 的任务还是死了 | 进程在 SIGHUP 到达后又前台化了；或 systemd 的 KillMode 收割 |
| 退出码 137/139 | 128+9（SIGKILL，OOM 杀手常见）/128+11（SIGSEGV） |

## 六、未实测清单

- 本文所有系统调用与信号语义——无 Linux，未测。
- fork 的 COW 页计数实测——未测（Windows 对侧有工作集实测，见 os-memory-layout）。
- systemd 的 cgroup 收割细节——linux-ns 那节概念层提及，未测。
