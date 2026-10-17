---
title: IO 多路复用
description: 未实测（本机无 Linux）：select/poll/epoll 三代 API 的差别、LT/ET 的选择建议、一个 epoll 服务器的完整骨架、eventfd/timerfd/signalfd 统一事件源。
date: 2026-10-16
tags: [Linux, epoll, select, poll, IO 多路复用]
category: linux
section: linux-io-multiplex
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级框架。站内对照：net-highperf（Reactor 模型设计）、conc-coroutines（C++20 协程 vs 纤程的本机实测）、os-io-stack（Windows IO 完成端口概念）。所有代码是教学骨架，上生产前以 `man epoll` 和你的压测为准。

## 一、三代 API：select → poll → epoll

| | select | poll | epoll |
| --- | --- | --- | --- |
| fd 数量上限 | `FD_SETSIZE`（常 1024） | 无硬上限 | 无硬上限（受内存） |
| 就绪集合传递 | 每次调用重设 fd_set | 每次重填 pollfd 数组 | 内核记住关注列表，只回就绪的 |
| 复杂度 | O(n) 每次全扫 | O(n) | O(就绪数) |
| 触发模式 | LT | LT | **LT + ET** |

**select 的两个硬伤**：fd 上限（改内核重编译才行）和"每次全量重传 + 内核全量扫描"——连接数上千后 CPU 全花在扫表上。poll 修了上限，没修扫描。**epoll 的革命性是把"关注列表"搬进内核**：`epoll_ctl` 增删一次，`epoll_wait` 只拿就绪的——C10K 的名字就是这么来的。

## 二、epoll 的三次调用与两种触发

```c
epfd = epoll_create1(0);                       // 建实例
epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);       // 注册：关注的事件 + 用户数据
n = epoll_wait(epfd, events, MAX, -1);         // 等待：只回就绪的
```

**LT（水平触发，默认）**：fd 就绪期间每次 `epoll_wait` 都报它——**没读完下次还提醒**，编程简单，漏读不致命。
**ET（边缘触发，`EPOLLET`）**：只在状态变化时报一次——**必须一次读到 `EAGAIN`**，漏读就永远丢事件，且非阻塞 fd 是前提。

**选 LT**。ET 的收益是"减少系统调用次数"，代价是"任何一次读不干净就是隐蔽的丢数据 bug"——只在 latency 极端敏感且代码经过充分对拍时用。本站 net-highperf 那节说过同样的建议：新手别装 ET。

`EPOLLONESHOT`：一个 fd 只报一次，处理完要重新 arm——多线程共享 epoll 时防两个线程同时拿到同一 fd 的标准手法。`EPOLLEXCLUSIVE`：多线程 accept 同一 listen fd 时防惊群（net-highperf 提过）。

## 三、一个 epoll 服务器的完整骨架

```c
// 1. listen fd 非阻塞 + 注册 EPOLLIN
listen_fd = socket(...); set_nonblocking(listen_fd);
bind(...); listen(listen_fd, 511);
ev.events = EPOLLIN; ev.data.fd = listen_fd;
epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev);

while (1) {
    int n = epoll_wait(epfd, events, MAXEVENTS, -1);
    for (int i = 0; i < n; i++) {
        int fd = events[i].data.fd;
        if (fd == listen_fd) {
            // 2. 循环 accept 到 EAGAIN（一次醒可能排了多个连接）
            while (1) {
                int c = accept(listen_fd, NULL, NULL);
                if (c < 0) break;                    // EAGAIN = 接完了
                set_nonblocking(c);
                ev.events = EPOLLIN | EPOLLET;       // 或 LT
                ev.data.fd = c;
                epoll_ctl(epfd, EPOLL_CTL_ADD, c, &ev);
            }
        } else if (events[i].events & EPOLLIN) {
            // 3. 读到 EAGAIN/0：0 = 对端关闭，摘除并 close
            while (1) {
                ssize_t r = read(fd, buf, BUF);
                if (r == 0) { epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL); close(fd); break; }
                if (r < 0) break;                    // EAGAIN
                handle(fd, buf, r);                  // 业务 + 可能的写
            }
        }
        // 4. EPOLLOUT：写缓冲区可写了，把积压的写完，写完注销 EPOLLOUT
    }
}
```

四个必查点（net-highperf 有同样清单，这里给 epoll 特有问题）：listen fd 非阻塞、accept 到 EAGAIN、读 ET 到 EAGAIN/LT 一次一读、**写也要注册 EPOLLOUT 且写完注销**。第五个 epoll 特有：**`events[i].events` 可能同时带 EPOLLERR/EPOLLHUP**——不查它们会把错误事件当可读处理然后 read 返回错误。

## 四、统一事件源：eventfd / timerfd / signalfd

Linux 把三类"信号性事件"也变成 fd，塞进同一个 epoll：

| fd | 替代 | 用途 |
| --- | --- | --- |
| `timerfd` | `setitimer` + SIGALRM | 定时器进事件循环，精度到 ns 级 `CLOCK_MONOTONIC`——**比信号 handler 里干活的模式干净一个数量级** |
| `signalfd` | `sigaction` + self-pipe | 信号变可读事件（linux-signal 提过它 vs self-pipe 的取舍） |
| `eventfd` | 管道的一个字节 | **线程/进程间唤醒**：写个 8 字节计数器，读的人 `epoll_wait` 醒——比 pipe 省一对 fd、比条件变量能进 epoll |

**架构收益**：整个程序只有一个事件循环，超时、信号、跨线程唤醒、socket 全是 fd——**没有第二套异步机制要协调**。Qt 的事件循环、libuv 的内部都是这个哲学（本站 qt-event 量过 Qt 侧的事件派发成本）。

## 五、多线程模型选型

单 epoll 吃满一个核后，三条路（net-highperf 有完整对比，这里给要点）：

1. **主线程 accept + 多 worker 各管一组 fd**：连接按轮询分给 worker，一个连接一生在一个线程——无跨线程竞争，Netty 默认。
2. **SO_REUSEPORT 多 listen**：每线程独立 accept，内核做连接级均衡——扩缩容平滑，但**同一条长连接永远落同一个 socket**，热点连接会让线程倾斜。
3. **一个 epoll 多线程 wait**：配 `EPOLLEXCLUSIVE` 缓解惊群——能用但收益不如前两者直接。

## 六、排障索引

| 症状 | 入口 |
| --- | --- |
| CPU 空转但 QPS 上不去 | LT 下没读干净反复就绪；或 accept 循环漏了 EAGAIN |
| 偶发连接挂住不收数据 | ET 漏读；或 EPOLLOUT 注册了没注销（写完还在报可写 = 忙循环） |
| 客户端批量断开后 fd 泄漏 | EPOLLHUP/EPOLLERR 没处理，只看了 EPOLLIN |
| 惊群：多核 CPU 全 100% 但吞吐低 | 多线程 accept 无 EPOLLEXCLUSIVE/SO_REUSEPORT |
| 延迟毛刺 | 单线程事件循环里混了耗时业务——拆出去（net-highperf 的 Proactor/线程池） |

## 七、未实测清单

- 本文所有 epoll 行为、LT/ET 差异、代码——无 Linux 环境，未测。
- epoll 的连接数上限实测——未测。
- io_uring（Proactor 路线）——未测，net-highperf 概念层提及。
- 各内核版本的 epoll 行为差异——未对比。
