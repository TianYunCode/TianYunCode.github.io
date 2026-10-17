---
title: 高并发 IO 模型
description: 未实测（无 Linux）：Reactor 与 Proactor 的分野、多线程 accept 与 SO_REUSEPORT、每连接内存预算算法、零拷贝 sendfile 的适用边界。
date: 2026-10-16
tags: [网络, 高并发, epoll, Reactor, IOCP, 零拷贝]
category: network
section: net-highperf
---

> **本文性质声明**：本机无 Linux 环境，**epoll/io_uring/Reactor 服务器全部未实测**；本文是设计框架与文档级知识，用于建立选型地图和容量模型。文中的实测引用均来自本站其他章节的本机测量（net-socket、conc-coroutines 等）。性能数字以你的目标平台的官方文档和压测为准。

## 一、IO 模型的四级台阶

从一个连接读到数据，操作系统给了四级抽象，复杂度递增、能力也递增：

| 模型 | 做法 | 代表 | 单线程连接上限 |
| --- | --- | --- | --- |
| 阻塞 IO | 一个连接一个线程，`read` 阻塞等待 | 早期 echo server | 几百（线程栈 1MB×，win-thread-sync 实测线程栈提交行为） |
| 非阻塞 + 就绪通知 | `select`/`poll`/`epoll` 告诉你"哪个 fd 可读了"，你再读 | Linux epoll、BSD kqueue、Windows **select 不能用（仅 <64 连接）** | 几万（epoll O(1)） |
| 异步 IO（Proactor） | 你交缓冲区，系统读完**通知你** | Windows **IOCP**、Linux io_uring | 几十万 |
| 协程/无栈异步 | 把回调写成同步代码，运行时调度 | C++20 协程、Rust async、Go goroutine | 取决于运行时 |

**分水岭在第二三级之间**：Reactor（就绪通知）下"读"这个动作还是你发起的，一次 `epoll_wait` 醒来要 `read` 一次（两次系统调用）；Proactor 下读写都异步完成，一次投递一次完成通知。**Windows 的原生异步模型就是 IOCP**——把 socket 关联到完成端口，投递 `WSARecv`，工作线程从端口取"读完了"的结果。Linux 传统上只有 epoll（Reactor），io_uring 才补上 Proactor。

## 二、Reactor 的主循环：一个 epoll 服务器的骨架（文档级）

```c
// 伪代码：单 Reactor
epfd = epoll_create();
epoll_ctl(epfd, ADD, listen_fd, EPOLLIN);        // 监听可读=新连接
while (1) {
    n = epoll_wait(epfd, events, MAX, -1);        // 阻塞等到就绪
    for (i in events) {
        if (events[i].fd == listen_fd) {
            c = accept(listen_fd, ...);            // 接受
            set_nonblocking(c);                    // 必须非阻塞
            epoll_ctl(epfd, ADD, c, EPOLLIN | EPOLLET);  // 注册，可选 ET
        } else {
            n = read(events[i].fd, buf, ...);      // 读（ET 下要读到 EAGAIN）
            if (n == 0) { close(fd); epoll_ctl(DEL); }  // 对端关闭
            else handle(buf, n);                   // 业务 + 可能的 write
        }
    }
}
```

五个必须做对的点（全部是血泪级）：

1. **监听 fd 和连接 fd 都设非阻塞**：阻塞 fd 进 epoll，一次 `read` 就能把事件循环卡死——"高并发服务器偶发全站卡住"的经典根因。
2. **LT（水平触发）还是 ET（边缘触发）**：LT 简单（不丢事件，醒一次读一次），ET 高效（只在状态变化时通知，**必须一次读到 EAGAIN**，漏读就永远丢事件）。**新手用 LT，别装 ET**。
3. **accept 要在循环里accept到 EAGAIN**：一次 `epoll_wait` 醒来时可能排了多个连接，只 accept 一个会让剩下的等到下一轮。
4. **写也要关心**：socket 写缓冲区满时 `write` 返回 EAGAIN，此时要注册 EPOLLOUT，写完注销——**直接阻塞写的 Reactor 不是 Reactor**。
5. **惊群与多线程**：多线程 accept 同一个 listen fd 会惊群（所有线程被唤醒只有一个成功），Linux 的 `EPOLLEXCLUSIVE`、BSD 的 `kqueue` 级联、跨平台的 **SO_REUSEPORT**（每线程一个 listen socket，内核哈希分发）是三种解法。**Windows 没有 SO_REUSEPORT**，多线程 accept 用 IOCP 自然分发或 `AcceptEx`。

## 三、多线程 accept 与 SO_REUSEPORT（文档级）

单 Reactor 的天花板在单核——业务逻辑稍重就到几万 QPS。三种横向扩展：

1. **多 Reactor + 主线程只 accept**：主线程 accept 后把连接分给多个 IO 线程（每个线程自己的 epoll）。连接在哪个线程就在哪读完一生，无跨线程数据竞争。Netty 的默认模型。
2. **SO_REUSEPORT 多 listen**：每个 IO 线程绑自己的 listen socket 到同一端口，内核做连接级负载均衡。好处是**扩容/重启平滑**（新进程绑同端口，旧的退）；坑是**同一连接永远落在同一个 socket 上，均衡粒度是连接不是请求**，长连接场景会倾斜。
3. **SO_REUSEPORT + eBPF 定制均衡**：按四元组哈希之外的策略（如按 CPU、按连接数）分发，进阶玩法，本文不展开。

**Windows 侧对照（文档级）**：没有 SO_REUSEPORT，但有 `SO_EXCLUSIVEADDRUSE`（比 SO_REUSEADDR 更强的独占，net-socket 实测过 Windows 上第二个 socket 带 SO_REUSEADDR 绑同地址报 10013）。多线程高并发在 Windows 上的正统是 **IOCP + 线程池**：完成端口本身就是队列，工作线程数 = 2×核数 是常见起点（本机 idealThreadCount=12，qt-thread 实测过）。

## 四、连接数与内存预算：算账别拍脑袋

"服务器能撑多少连接"是一道乘法题，上线前算清楚：

```
每连接内存 ≈ 接收缓冲 + 发送缓冲 + 协议缓冲 + 你的会话对象
          ≈ 8KB + 8KB + 16KB + 会话状态
C10K（一万连接）× 32KB ≈ 320 MB；C100K ≈ 3.2 GB；C1M ≈ 32 GB
```

三个推论：

1. **默认缓冲要主动调小**：Linux 默认 `tcp_rmem`/`tcp_wmem` 自动调谐（net-tcp-flow 实测过接收窗口从 65280 抬到 261888），**自动调谐在大连接数下是灾难**——每连接峰值缓冲会把内存吃光。高并发服务显式设小缓冲（如各 4–8KB），需要吞吐的场景另开大缓冲的连接。
2. **文件描述符上限是三道门**：进程级 `ulimit -n`（默认常 1024，C10K 第一道坎）、系统级 `fs.file-max`、内存（每个 fd 约 1KB 内核内存）。**改完 ulimit 要确认 systemd 单元/容器配置没覆盖它**。
3. **连接不是越多越好**：超过业务并发的连接是纯开销。客户端侧开连接池（net-dns-http 第二节实测 keep-alive 省 79% TTFB）、服务侧设 `accept` 队列上限和空闲超时（net-tcp-conn 实测过 backlog=5 时 40 条 SYN 只有 5 条拿到 SYN/ACK）。**容量规划的目标是"匹配并发的连接数"，不是"最大连接数"**。

## 五、零拷贝与 sendfile：什么时候真的省

传统 `send(file)` 的路径：磁盘 → 页缓存 → 用户缓冲区 → socket 缓冲，**两次拷贝 + 四次上下文切换**。`sendfile` 让数据在内核里从页缓存直接进 socket 缓冲，省掉用户态往返。实测引用：os-io-stack 量过映射视图写 4KB 首遍 1.72µs/页 vs WriteFile 21.86µs——同族的"少一次拷贝"在文件 IO 上的量级。

适用边界（三条都不满足就别上零拷贝）：

1. **数据本来就是文件**：静态文件服务（nginx 的 `sendfile on`）、FTP。**动态生成的内容（模板渲染、压缩）没有"内核里的源"，sendfile 无从谈起**。
2. **不需要用户态处理**：要统计、要改内容、要加密，就得回用户态。
3. **内核/网卡支持**：`sendfile` 要网卡支持 gather-DMA 才是真零拷贝，否则只是省了用户态拷贝；Linux 的 `splice`/`MSG_ZEROCOPY`、io_uring 的 registered buffers 是更彻底的形态。

**别为"零拷贝"三个字重构**：先确认瓶颈在拷贝（火焰图上 `copy_user_enhanced` 一类函数占比高，dbg-profiling 讲过读法），再动手。多数业务服务的瓶颈在业务逻辑和锁，不在内核拷贝。

## 六、选型速查

| 场景 | 推荐模型 |
| --- | --- |
| Linux 通用高并发（万级连接） | epoll LT + 多 Reactor |
| Linux 极限性能（十万级+，新内核） | io_uring |
| Windows 高并发 | IOCP + 线程池（原生异步，别用 select） |
| 跨平台代码库 | 抽象层（libuv/asio）+ 平台后端 |
| 连接数不高、开发速度优先 | 阻塞 + 线程池（qt-thread 实测过池化省创建成本）或协程 |

## 七、未实测清单

- epoll/io_uring 的任何实测——无 Linux 环境。
- IOCP 的完成端口行为——未部署服务器（conc-coroutines 那节对 C++20 协程/纤程有本机实测，可对照"异步抽象的成本"）。
- SO_REUSEPORT 的均衡行为——无 Linux。
- C10K/C100K 的内存实测——本文数字是算术不是测量。
- 网卡多队列 RSS 与中断亲和（os-interrupt 的概念层有提及）——未测。
