---
title: SQLite 与嵌入式集成
description: 实测：读者持锁时回滚日志模式写者 COMMIT 失败 296ms，WAL 下 0.71ms 成功；busy_timeout=0.05 实际等 111ms；cache 从 2MB 加到 64MB 全表扫快 3.1 倍。
date: 2026-10-16
tags: [数据库, SQLite, 嵌入式, WAL, 备份]
category: database
section: db-sqlite
---

> 环境：Windows 11 x64，**SQLite 3.53.1**（Python 3.13.1 `sqlite3` 模块），探针 `%TEMP%/db3s_*/probe_sqlite.py`。语义结论（锁、报错、行数）可复现；耗时是 3 轮中位，**报告比值不报告绝对值**（同期机器有别的 agent 在跑）。**本机没有 Android 设备、没有 RTOS 目标机**：SQLite 在 Android/嵌入式 Linux 上的编译选项（`SQLITE_ENABLE_*`）、`sqlite3_os_init` 的自定义 VFS**未实测**，第七节给清单。

## 一、什么时候该选 SQLite：三个判据

SQLite 不是"玩具 MySQL"，它是**进程内库**——没有守护进程、没有 socket、没有用户权限，你的进程链接一个 `.c`  amalgamation 就拥有了整个数据库。选型判据只有三条：

1. **数据在同一台机器、同一个进程或同机多进程**。需要跨网络访问、连接池、细粒度用户权限时，SQLite 从根上就不匹配。
2. **并发写的峰值低**。任何时刻**一个写者**，这是 SQLite 的硬模型（db-transaction 那节量过）。读可以任意并发。
3. **运维预算接近零**。没有要装的的服务、没有要备份的实例状态、没有要调的连接数。一个文件 `cp` 走就是备份（前提见第五节）。

反过来，以下场景请直接用客户端/服务器数据库：写 QPS 四位数以上且多主机、需要在线加字段不停机、需要行级权限。**SQLite 的 WAL 能把读写并发做得很好，但永远解决不了多写者**——那是模型问题不是调优问题。

## 二、库头三个 pragma：建库时就要想清楚

```
默认: page_size=4096 encoding=UTF-8 journal_mode=delete
空库上设置: page_size=8192 encoding=UTF-16le 文件 16384 B
非空库改 page_size: 8192（需 VACUUM 生效）文件 16384 B
```

| pragma | 默认 | 何时改 | 坑 |
| --- | --- | --- | --- |
| `page_size` | 4096 | 大记录/大 blob 库升到 8192/16384，减少页分裂 | **必须在建表前设**；非空库改了要 `VACUUM` 才重写 |
| `encoding` | UTF-8 | 几乎永远不用改 | **只在空库上有效**，已存数据的库改不动 |
| `journal_mode` | delete | 见第三节 | `WAL` 是持久设置，写进库头 |

**`page_size` 的实测体感**：10 万行 × 88 字节的库，4096 页下是 2325 页 / 9,457,664 字节。页越大，同样数据的页数越少、B 树越矮、随机读的磁盘往返越少；但每次读至少搬运一页，页太大在小记录库上是浪费。**默认值适合绝大多数场景，改它是 specialist 动作**。

## 三、WAL 模式：把"读者挡写者"拆掉（本节核心）

回滚日志（journal）模式下，读者持锁时写者 COMMIT 会被挡住——实测：

```
[delete] 写中自动提交读: v=1  0.73 ms          ← 读者不持锁时读没问题
[delete] 读者持锁时写者 COMMIT 失败: 296.10 ms database is locked
[wal]   写中自动提交读: v=1  1.45 ms
[wal]   读者持锁时写者 COMMIT: 0.71 ms 成功
```

注意 `[delete]` 那行：读者如果**不开事务**（自动提交的 SELECT），SHARED 锁拿了就还，写者不受影响。挡住写者的是**长时间不结束的读事务**——循环里 `BEGIN; SELECT; ...; COMMIT` 跨了几百毫秒的那种。这就是 journal 模式的结构性问题：读者的读窗口直接变成写者的不可用窗口。

WAL 把写改成追加：写者只往 `-wal` 文件尾部加帧，读者各自记着"我读到第几帧"，**两个操作碰的是不同字节**。于是同样场景下写者 COMMIT 0.71 ms 成功。WAL 的三条代价：

1. **库文件从 1 个变 3 个**：`db`、`db-wal`、`db-shm`。拷贝、打包、同步工具（网盘、rsync、`cp`）必须三个一起，漏一个就是数据丢失。
2. **要 checkpoint**：WAL 无限涨，读多写少时定期把帧合并回主库（默认 1000 页自动触发，可 `PRAGMA wal_checkpoint(TRUNCATE)` 手动）。
3. **网络文件系统上不可用**：`-shm` 靠共享内存实现，NFS/SMB 上行为未定义。共享库留在 `DELETE` 模式。

选型：单进程嵌入式用默认 `DELETE`；多连接读写混合用 `WAL`——**这一条能消掉大多数"偶发 database is locked"的工单**。

## 四、busy_timeout：等待的真实粒度

`timeout`（C 层 `sqlite3_busy_timeout`）是"锁冲突时最多等多久"。实测（另一连接持写锁）：

```
timeout=0.0s: 2 ms 后 database is locked
timeout=0.05s: 111 ms 后 database is locked
timeout=0.3s: 402 ms 后 database is locked
```

**三个数字都比设定值大**，而且不是抖动：SQLite 默认 busy handler 的睡眠序列是 1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100 ms，**累加过线的那一觉才醒**——50 ms 的预算实际睡到 111 ms，300 ms 的预算睡到 402 ms。工程含义：

- `timeout=0` 不是"不等待"，是"等 2 ms"（第一觉）。**"快速失败"的正确做法是 `timeout=0` + 应用层立刻重试**，不是把它当精确超时用。
- 想压住并发写的失败率，`timeout` 给 1–5 s 并接受粒度粗糙；真正可控的做法是应用层指数退避（50/100/200/400 ms，最多 5 次），失败后**回滚并重开整个事务**——别在半截事务上续写，快照可能已过期（db-transaction 第五节）。
- **busy_timeout 是连接级设置**，连接池里每个新连接都要设一遍；漏设的连接会用默认的 0 或构造函数传的值，表现为"偶发锁错误只在某台机器出现"。

## 五、备份：两条路，两种语义

SQLite 的备份有两个 API，语义不同，实测对照（源库 10000 行 + WAL 模式）：

| 方式 | 耗时 | 产物 | 语义 |
| --- | --- | --- | --- |
| `VACUUM INTO 'copy.db'` | 9.2 ms | 110,592 B，md5 `e9a44c20…` | **重建**：重排页面、无碎片、无 WAL 残留 |
| `conn.backup(dst)` | 5.3 ms | 110,592 B，md5 `9a890b6b…` | **逐页复制**：保留原页面布局 |

两者字节数相同、md5 不同——**备份的"一致性"指行数一致，不是字节一致**。选型：归档/分发用 `VACUUM INTO`（顺带瘦身）；热备份用 `backup()`（可跨连接、可增量步进 `sleep` 参数）。

**未提交数据不在备份里**，实测：写事务插了 777 未提交时备份行数 10000，提交后再备是 10001。这是正确行为（备份的是数据库状态，不是某个连接的事务），但如果你的"备份"指望把内存里未落盘的改动带走，会静默少数据。

备份的三条军规：

1. **WAL 模式下三个文件一起走**，或者先 `PRAGMA wal_checkpoint(TRUNCATE)` 再拷单文件。
2. 备份完跑 `PRAGMA quick_check`（实测本机返回 `ok`，10 万行库上毫秒级）——`integrity_check` 更彻底但慢，归档前跑一次。
3. 备份文件**不要放在同一个磁盘**上。同盘备份防不住磁盘故障，这是所有备份建议里最容易被忽略的一条。

## 六、性能调优：四个 pragma 的实测排序

同一库（10 万行 × 88 B，2325 页 / 9,457,664 B），`SELECT count(*), sum(v)` 全表扫，3 轮中位：

```
默认 cache_size=-2000(2MB)    :    16.6 ms
cache_size=-64000(64MB)       :     5.3 ms   ← 3.1x
+mmap_size=256MB              :     4.5 ms
+temp_store=MEMORY            :     4.3 ms
```

排序结论：**先加 cache，再考虑 mmap，temp_store 锦上添花**。逐条说：

1. **`cache_size`**（负值=KB）：默认 2 MB 只够放 1/4 的库，全表扫要反复回操作系统取页。64 MB 直接 3.1 倍。**嵌入式设备上这条最敏感**——内存预算紧的机器这是主要矛盾。
2. **`mmap_size`**：把库文件映射进地址空间，读走页缓存不走 `read()` 系统调用。2 GB 以上大库收益明显；小库上和 cache 重叠。**注意它让"读文件"变成"读内存"，断电语义不变但调试 core 时栈上看不到文件偏移**。
3. **`temp_store=MEMORY`**：`ORDER BY`/`GROUP BY` 的临时表进内存。数据量大时是**内存换速度**，和设备场景冲突，默认 `FILE` 有它的理由。
4. 没测但值得知道的：`PRAGMA optimize`（构建后跑一次，给查询规划器喂统计）、`ANALYZE`（db-optimize 那节细说）。

**调优的顺序永远是先看查询再看 pragma**——一个没走索引的全表扫，调大 cache 只是把 16.6 ms 变成 5.3 ms，加对索引是变成 0.05 ms。pragma 是放大器，不是替身。

## 七、打包、迁移与未实测清单

打包三件事：amalgamation（`sqlite3.c` 单文件进你的构建）、编译选项（`SQLITE_THREADSAFE`、`SQLITE_ENABLE_FTS5` 按需）、版本管理（`PRAGMA user_version` 记 schema 版本，比文件名可靠）。迁移策略：`user_version` + 启动时按版本顺序执行 DDL，和 ORM 的 migration 一个思路，SQLite 自己不管。

**明确未实测**（本机条件限制，用到时回官方文档核对）：

- Android/嵌入式 Linux 上的 `SQLITE_ENABLE_*` 编译矩阵与自定义 VFS——无目标设备。
- `SQLITE_ENABLE_STMT_SCANSTATS` 等实验特性——未启用编译。
- `sqlite3_rsync`/Litestream 这类外部复制方案——未部署。
- 掉电保持性（`synchronous` 三档）——无法安全掉电，只做了语义对照。

下一篇 db-optimize 把 `EXPLAIN QUERY PLAN` 和慢查询的定位过程量一遍。
