---
title: 进程间通信
description: 未实测（本机无 Linux）：管道/FIFO 的字节流语义与容量、共享内存的同步责任、System V IPC 的 key 与残留问题、Unix 域套接字与 SCM_RIGHTS 传 fd 的完整模式。
date: 2026-10-16
tags: [Linux, IPC, 管道, 共享内存, Unix 域套接字]
category: linux
section: linux-ipc
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，为手册级框架。站内对照实测：conc-task-queue（任务队列模式）、net-socket（TCP socket 本机实测）、linux-io-multiplex（多路复用概念）。

## 一、四种 IPC 的选择地图

| 机制 | 模型 | 关系 | 拿手 | 别指望 |
| --- | --- | --- | --- | --- |
| 管道/FIFO | 字节流 | 亲缘或有共同路径名的进程 | shell 管道、父子线程序列化 | 随机访问、多播 |
| 共享内存 | 共享内存页 | 任意 | 最快的大数据交换（零拷贝） | **它自己不同步** |
| System V IPC | 消息队列/信号量/共享段 | 任意（按 key） | 老代码遗产 | 生命周期管理难 |
| Unix 域套接字 | 套接字 | 任意（按路径） | **传 fd**、抽象命名空间、credential 校验 | 跨机器 |

选型的 defaults：**父子/线程序列化用管道；同机高性能大数据用共享内存（自己加同步）；要传 fd 或想要"本地版 TCP"用 Unix 域套接字**。System V IPC 只在维护老代码时碰。

## 二、管道与 FIFO

`pipe(fd[2])` 给一对 fd：写 `fd[1]`、读 `fd[0]`，**字节流、无消息边界**（写两次 10 字节，读一次可能拿到 20 字节——粘包在读侧界定，本站 net-socket 量过 TCP 侧的同类现象）。

关键语义：

1. **容量有限**（默认 64KB，`fcntl(F_SETPIPE_SZ)` 可调）：写满时写者阻塞（或 `EAGAIN` 非阻塞时）——**"生产者消费者天然背压"就靠这个**。
2. **读端全关时写者收 SIGPIPE**（忽略它，否则进程被杀）；写端全关时读者读到 **EOF**。
3. **fork 前创建的管道父子各持一端**：忘了关不需要的那端，EOF 永远不来——经典 bug（linux-process 提过 fork 与 fd 继承）。
4. **FIFO（命名管道）**是管道进文件系统：`mkfifo` 创建，无亲缘关系的进程按路径打开。**open 一个 FIFO 默认阻塞到对端也打开**（`O_RDONLY` 等写者、`O_WRONLY` 等读者）——忘了这点的程序"卡在 open"。

## 三、共享内存：快，但同步是你的责任

`shm_open` + `mmap`（POSIX）或 `shmget` + `shmat`（System V）把同一块物理内存映射进多个进程的地址空间——**写入即对方可见，零拷贝**。代价：

1. **没有内置同步**：两个进程同时写 = 数据竞争，和线程一样（只是没编译器和 CPU 帮你看到）。**共享内存必须配信号量或 pthread 的进程间属性锁**（`PTHREAD_PROCESS_SHARED` 的互斥锁/条件变量放共享内存里）。
2. **缓存一致性**：x86 硬件保证缓存一致，但**编译器/CPU 可能重排**——跨进程的内存序要靠屏障/原子（conc-atomics 的内存序知识原样适用）。
3. **生命周期**：`shm_open` 的段在 `munmap` 后仍存在（要 `shm_unlink` 才删）；System V 的段更是**重启不删**——`ipcs` 看残留、`ipcrm` 清，是运维例行。

**典型架构**：一块大共享区（环形队列放数据）+ 两个信号量（空/满计数）——经典的无锁/少锁大数据通路。小消息场景别用它，管道或套接字更省心。

## 四、System V IPC：key、权限与残留

`ftok(path, id)` 生成 key → `shmget/semget/msgget` 创建或打开。三个坑：

1. **key 冲突**：`ftok` 基于路径+序号，两个不相关的项目用了同路径同 id 就撞——指定固定 `IPC_PRIVATE` 或自选 key 更可控。
2. **`IPC_CREAT | IPC_EXCL`** 做"已存在即失败"（建单例的正规姿势，linux-fd 的 O_EXCL 同款思路）。
3. **重启残留**：段/队列不随进程退出删除（和管道/FIFO 相反），容器里表现为"重启后 IPC 已存在"启动失败——**守护进程启动时先清自己的 IPC 是惯例**。

**信号量是计数资源的标准抽象**：P/V（`semop`）操作可以原子地加减任意值——比互斥锁表达力强（能表示"N 个资源"）。消息队列有类型字段，可做优先级，但吞吐和大小都有限，现代场景基本被 Unix 套接字取代。

## 五、Unix 域套接字：本机通信的正规军

`socket(AF_UNIX, SOCK_STREAM, 0)` 绑一个文件系统路径（或 Linux 的抽象名——首字节 `\0`，不进文件系统）。它相对 TCP loopback 的优势：**不经过网络协议栈**（更快、无端口冲突）、**能验证对端身份**（`SO_PEERCRED` 拿对端 pid/uid/gid——"只允许 root 连接"的服务靠它）、以及独门绝技 **SCM_RIGHTS 传文件描述符**：

```c
// 发送方：把一个 fd 打进辅助数据
struct msghdr msg = {0};
char buf[CMSG_SPACE(sizeof(int))];
msg.msg_control = buf;
struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
*((int *)CMSG_DATA(c)) = fd_to_pass;
msg.msg_controllen = CMSG_SPACE(sizeof(int));
sendmsg(sock, &msg, 0);
// 接收方：recvmsg 时从 CMSG_DATA 取出 fd——拿到的是内核新分配的 fd 编号
```

传 fd 的标准用途：**权限分离的网关架构**——一个特权进程接受连接/打开文件，把 fd 传给无特权的 worker 进程干活。systemd 的 socket activation 就是这套（`LISTEN_FDS` 环境变量 + fd 3 起步）。

## 六、排障索引

| 症状 | 入口 |
| --- | --- |
| `ipcs` 一堆残留段 | 进程没删 IPC（第四节）；容器重启后先清 |
| 管道 read 永久阻塞 | 对端 fd 没关全（第二节）；或 FIFO 只开了一端 |
| 共享内存数据偶发错乱 | 同步漏了（第三节）；先查内存序再查锁 |
| Unix socket 连接被拒 | 路径权限（要 x 权限才能连）+ SELinux；抽象名不受权限管 |
| 传过去的 fd 不可用 | SCM_RIGHTS 的对端必须真的 recvmsg；fd 在发送方 close 不影响接收方持有 |

## 七、未实测清单

- 本文所有 IPC 行为与成本——无 Linux 环境，未测。
- 管道容量、共享内存带宽——未测（概念引用 net-socket 的 TCP 实测做量级对照）。
- systemd socket activation——linux-daemon 概念层提及，未测。
- io_uring 的 registered fd 传递——未涉及。
