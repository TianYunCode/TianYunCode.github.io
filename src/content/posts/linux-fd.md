---
title: 文件描述符与 IO 系统调用
description: 未实测（本机无 Linux）：fd 表与 fork/dup 的共享语义、open/read/write/close 的完整语义、O_NONBLOCK 与 EAGAIN、fcntl 记录锁与 OFD 锁的跨进程互斥。
date: 2026-10-16
tags: [Linux, 系统编程, 文件描述符, fcntl]
category: linux
section: linux-fd
---

> **本文性质声明**：本机无 Linux 环境，**全部内容未实测**，是 Linux 系统编程的语义框架（man page 级知识整理），用于建立心智模型和排障索引。本站的 Windows 对侧实测见 os-io-stack（句柄与 IO 栈）、win-handle-message（句柄表）。用到时以你系统上 `man 2 open` 一类手册为准。

## 一、fd 是什么：一张表、三个标准入口

Linux 的"一切皆文件"落在实现上就是**每个进程一张文件描述符表**：

```
进程 → fd 表（数组）→ 打开文件描述（系统级 open file description）→ inode
```

三个层次各有主人：**fd 编号是进程私有的**（同一个文件在不同进程 fd 号可以不同）；**打开文件描述是系统级的**（含偏移、状态标志，`dup`/`fork` 共享它）；**inode 是文件系统的**。这个分层解释了一切经典怪现象：

1. **`fork` 后父子共享文件偏移**：因为共享的是同一个打开文件描述。父进程 `lseek` 后子进程读到的位置也变了——**"两个进程交替读同一文件不重复不遗漏"就是靠这个**，也是"fork 后忘记各自 `lseek` 导致读取交错"的原因。
2. **`dup`/`dup2` 是别名不是拷贝**：`dup2(fd, 1)` 把 fd 指到同一个打开文件描述，关掉任何一个另一个仍有效——**重定向的实现就是它**（shell 的 `> file` 内部就是 open + dup2）。
3. **`close(fd)` 只是摘除引用**：只有当最后一个引用关闭，内核才真正关闭文件。`fork` 出来没关的 fd 会让对端看不到 EOF——**"socket 一端退出了另一端还阻塞在 read"的经典原因**。

## 二、open/read/write/close 的语义细节

**`open(path, flags, mode)`**：`O_RDONLY/WRONLY/RDWR` 三选一；`O_CREAT` 时 mode 才生效且**要过 umask**（linux-permission 那节细说）；`O_APPEND` 让每次写原子地追加到末尾（多进程写日志的正规做法）；`O_TRUNC` 先清空；`O_EXCL` 配 `O_CREAT` 做"存在即失败"的原子创建（锁文件的标准做法）。

**`read(fd, buf, n)`**：返回值是**实际读到的字节数**，可能小于 n（文件到尾部、信号打断、管道数据不足）。**读到 0 才是 EOF**——`read` 返回 -1 且 errno 为 `EINTR` 表示被信号打断，此时**重试而不是当错误**（慢系统调用语义）。

**`write(fd, buf, n)`**：同样可能写部分（磁盘满、管道缓冲满、非阻塞 socket）。**循环写完是整个 write 封装的基本要求**。

**`close(fd)`**：立刻返回，但数据可能还在内核缓冲（`close` 不保证落盘，`fsync` 才保证）。**close 的返回码也要查**：某些文件系统（NFS）的 close 会报告延迟的写错误，忽略它可能丢数据。

## 三、阻塞与非阻塞：O_NONBLOCK 的两面

默认的阻塞 IO：`read` 没数据就睡，`write` 缓冲满就睡——简单，但**一个慢对端能挂起一个线程**。`O_NONBLOCK` 打开后：

- `read` 没数据立即返回 -1 + `EAGAIN/EWOULDBLOCK`
- `write` 缓冲满立即返回 -1 + `EAGAIN`
- `connect` 对慢主机不再同步等待，立即返回 `EINPROGRESS`

**`EAGAIN` 不是错误，是"现在不行，晚点再来"**——它是所有高性能 IO 模型（select/poll/epoll）的基石。轮询 + sleep 是浪费 CPU 的做法；正确姿势是把"晚点再来"的判断交给内核的就绪通知机制（linux-io-multiplex 那节）。

一个混合模式：**普通文件几乎不受 O_NONBLOCK 影响**（页缓存命中就返回），它真正生效在管道、socket、字符设备上。

## 四、fcntl 与文件锁

`fcntl` 是 fd 的万能操作台：复制 fd（`F_DUPFD`）、get/set 状态标志（`F_GETFL`/`F_SETFL`，改 `O_NONBLOCK` 的正规途径）、get/set 信号属主（`F_SETOWN`，配合 `SIGIO`）、以及**记录锁**。

记录锁（`F_SETLK`/`F_SETLKW`，W=等待）的三个反直觉点：

1. **锁的单位是字节区间不是文件**：`l_start`/`l_len` 指定范围，`l_len=0` 表示"到文件尾"（含以后追加的字节——**用它锁一个会增长的文件**）。
2. **锁关联的是进程不是 fd**：进程退出时它所有的记录锁**全部释放**（不管 fd 关没关）——这是它和 System V 信号量最大的行为差异。
3. **`F_SETLK` 失败返回 `EACCES/EWOULDBLOCK`**：查 `l_type` 是读锁还是写锁被占。跨进程互斥的典型用法：两个实例抢同一文件的同一区间，拿到锁的当主。

**Open File Description（OFD）锁**（`F_OFD_SETLK`，Linux 3.15+）修的是老记录锁的坑：同一个进程内**不同 fd 抢同一区间也会互斥**（老记录锁同进程总是成功，多线程场景形同虚设），且 `fork` 不继承。新代码用 OFD。

## 五、排障索引

| 症状 | 第一嫌疑 |
| --- | --- |
| `EMFILE`（too many open files） | fd 泄漏：循环里 open 没 close；查 `ls /proc/<pid>/fd | wc -l` vs `ulimit -n` |
| 读文件总是空 | 打开时带了 `O_TRUNC`；或 `O_WRONLY` 读 |
| 读到的位置不对 | fork/lseek 语义（第一节）；多线程共享 fd |
| 写日志丢最后几行 | close 不 flush 的是用户态库缓冲（stdio 的 `fflush`）；内核侧要 `fsync` |
| 进程退出后锁还在 | 用了 flock（关联 fd）而非记录锁；或锁文件的 fd 被 fork 继承忘了关 |

## 六、未实测清单

- 本文所有系统调用行为、错误码、锁语义——无 Linux 环境，未测；均为手册级知识。
- `io_uring` 的提交/完成队列——属于 linux-io-multiplex 的概念层，未测。
- `/proc/<pid>/fd`、`lsof` 的实际输出——未抓。
- NFS/网络文件系统上的 close 错误延迟报告——未测（手册级提及）。
