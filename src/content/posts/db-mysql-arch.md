---
title: MySQL 架构与 InnoDB
description: 未实测（本机无 MySQL 实例）：连接器、Server 层与 InnoDB 的三层拆分，Buffer Pool/redo/undo/doublewrite/binlog 的职责与落盘路径，以及关键参数的选型表。
date: 2026-10-16
tags: [数据库, MySQL, InnoDB, 架构]
category: database
section: db-mysql-arch
---

> **本文性质声明**：本机没有 MySQL 实例，**所有内容均未实测**，是官方文档与《InnoDB 存储引擎》级别知识的整理，用于建立架构地图和排障时的检索索引。文中不出现任何性能数字——没有实例就不会有可信的数字。要看实测，本站同专栏的 db-transaction / db-sqlite / db-optimize / db-lock-mvcc 四篇全部有本机 SQLite 3.53.1 的测量。MySQL 的行为以你手头版本的官方文档为准。

## 一、三层拆分：先建立地图

MySQL 的架构可以压成三层，任何排障问题先定位在哪层：

| 层 | 组件 | 职责 | 典型问题出在哪 |
| --- | --- | --- | --- |
| 连接层 | 连接器、连接池、线程缓存 | 握手认证、维持连接、管理每个连接的工作线程 | 连接数打满、长连接堆积、`Too many connections` |
| Server 层 | 解析器、预处理器、**优化器**、执行器、缓存（8.0 已移除查询缓存） | SQL 解析 → 生成执行计划 → 调存储引擎接口 | 选错索引、执行计划抖动、`Sort buffer` 不足 |
| 存储引擎层 | **InnoDB**（默认）/ MyISAM / Memory | 数据怎么存、事务怎么实现、锁怎么加 | 行锁等待、Buffer Pool 命中率、redo 写满 |

**InnoDB 是存储引擎，不是"MySQL 的磁盘格式"**——这是插件式架构的关键：`SHOW ENGINES` 能列出全部可用引擎，`CREATE TABLE ... ENGINE=` 按表选。同一个实例里可以有的表用 InnoDB（要事务）、有的用 Memory（要速度）、有的用 CSV（要交换）。

## 二、连接器：连接的真相是"一个连接一个线程"

1. **连接器只做认证和维持**，不缓存 SQL。连接建立后，即使你 8 小时没发语句，它也在（`Sleep` 状态，`SHOW PROCESSLIST` 可见）。
2. **长连接的代价是内存**：连接的内存随执行中的查询临时分配（`sort_buffer`、`join_buffer`、`read_buffer` 按需增长），**执行完不归还系统**，只复用。长时间跑复杂查询的连接会一直占着大块内存——`SHOW STATUS LIKE 'Sort%'` 看不到单连接视角，这是连接池要设最大生命周期的原因。
3. **连接池是必选项不是可选项**：每次新建连接 = TCP + 认证 + 建线程。MySQL 的 `thread_cache_size` 能缓存空闲线程，减少创建开销，但认证和 TCP 省不掉。应用侧（HikariCP、Druid）的池化是标准做法。
4. **`wait_timeout` 决定连接被服务端踢掉前的空闲上限**。应用侧池子的 `maxLifetime` 必须小于它，否则会出现"池子里握着一条已被服务端关闭的连接，第一次用时才报 `Communications link failure`"——这类错误的特征是**偶发、重启后恢复、总在空闲最久的那条连接上**。

## 三、优化器：选错索引是 Server 层最常见的病

优化器的输入是解析树 + 统计信息，输出是执行计划。它**不保证选中最优索引**，只按成本模型估算。选错索引的常见诱因：

1. **统计信息过期**：`ANALYZE TABLE` 重采；大批量导入/删除后必须做（SQLite 侧本文有实测：`ANALYZE` 写 `sqlite_stat1`）。
2. **函数/运算包裹索引列**：`WHERE YEAR(create_time)=2026` 用不上索引，改范围条件才行。
3. **隐式类型转换**：字符串列用数字条件比，索引作废。
4. **优化器开关被关**：`optimizer_switch` 里的 `index_merge`、`condition_fanout_filter` 等，排查时先确认没被全局关掉。
5. **`EXPLAIN` 的 `rows` 是估算**：离谱大时即使走了索引也可能是统计问题。`EXPLAIN FORMAT=TREE`（8.0+）比传统 `EXPLAIN` 更接近真实执行结构。

**读执行计划的口诀**：`type` 从好到差是 `system > const > eq_ref > ref > range > index > ALL`；`Extra` 里 `Using filesort`（额外排序）和 `Using temporary`（临时表）是要盯的两个词，出现它们说明有排序/分组没走索引。

## 四、InnoDB 内存：Buffer Pool 是绝对核心

Buffer Pool 是 InnoDB 的页面缓存，**数据页、索引页、undo 页、插入缓冲、自适应哈希都在里面争内存**。理解它就理解了 InnoDB 的性能：

| 组件 | 作用 | 出问题的样子 |
| --- | --- | --- |
| Buffer Pool | 缓存磁盘页，读写都先过它 | 命中率低 → 磁盘 IOPS 打满，`Innodb_buffer_pool_reads` 涨 |
| Change Buffer | 写不命中索引页时先缓冲，减少随机读 | 写多且索引多的表收益大 |
| Adaptive Hash Index | 热页自动建哈希加速点查 | 争用 latch 时反而成瓶颈，可关 |
| Log Buffer | redo 的写缓冲 | 大事务提交时的一次性写入 |

**核心比率**：`innodb_buffer_pool_size` 应占到**专用数据库服务器总内存的 50%–75%**（留余量给连接、操作系统、其他引擎）。`Innodb_buffer_pool_read_requests / (reads + read_requests)` 是命中率，健康值 99%+；低于 99% 先想是不是池子太小或全表扫把池冲了。

**调优的三个常识**：预热（重启后 Buffer Pool 空了，`innodb_buffer_pool_dump_at_shutdown`/`load_at_startup` 能存能恢复，或故意不重启）；多实例（`innodb_buffer_pool_instances` 减少内部锁争用，8.0 默认 64 以下池自动细分）；**大页**（`innodb_buffer_pool_chunk_size` + 大页分配减少 TLB miss）。

## 五、InnoDB 磁盘：页、undo、redo、doublewrite、binlog

### 5.1 页与表空间

InnoDB 的基本 IO 单位是**页**（默认 16 KB），B 树的一个节点就是一组页。表空间（`.ibd`）从段→区→页逐级组织。**"为什么 InnoDB 喜欢自增主键"**在这里得到解释：自增主键顺序插入，页的填充率稳定；UUID 主键随机插入，页分裂、碎片、写放大全来。

### 5.2 undo：回滚与 MVCC 的弹药

`UPDATE`/`DELETE` 不原地改，旧版本写 **undo log**。undo 有两个消费者：**事务回滚**（ROLLBACK 时反向 apply）和 **MVCC**（快照读从 undo 里找历史版本）。所以 undo 不是"回滚专用"，长事务会**阻止 purge 清理旧版本**——`information_schema.innodb_trx` 里那些跑了几小时的事务，会让 undo 表空间和 history list 持续增长，这是"表没动、磁盘一直涨"的经典原因。

### 5.3 redo：崩溃恢复的命根子

Buffer Pool 里的页是脏的，**已提交事务必须在 redo log 里**，否则断电丢事务。写入路径：

```
事务提交 → 写 redo log buffer → fsync 到 ib_logfile0/1（循环写）
→ 后台把脏页刷到 .ibd（checkpoint 机制）
```

`innodb_flush_log_at_trx_commit` 三个值：`1`（默认，每次提交 fsync，不丢）、`2`（写 OS 缓存不 fsync，只在 OS 崩时丢）、`0`（每秒写， OS 崩丢 1 秒）。**这个参数是"性能换持久性"的总闸**，批量导入临时改 2、跑完改回 1 是常见操作；改 0 要想清楚你能丢多少。

### 5.4 doublewrite：页写一半的保险

InnoDB 页 16 KB，文件系统/硬页 4 KB——**写页写到一半断电，页就撕裂了**。doublewrite 的做法是脏页先顺序写到一块共享区（doublewrite buffer），再写回真正的表空间；恢复时发现撕裂就从共享区拷回来。代价是每次刷脏页多一次顺序 IO，**这是 InnoDB 默认开启且不建议关的原因**——除非你的存储本身保证原子写（某些企业 NVMe + 特定文件系统）。

### 5.5 binlog：Server 层的另一套日志

容易混的是 redo 和 binlog 的分工：**redo 是 InnoDB 的崩溃恢复日志（循环写、物理页）**，**binlog 是 Server 层的归档/复制日志（追加写、逻辑事件）**。一个提交要写两份，于是有**两阶段提交**：prepare 阶段写 redo，commit 阶段写 binlog 再改 redo 状态——保证两份日志以"提交"为准对齐。binlog 有三种格式：`ROW`（记录行变更，主从一致最稳，默认推荐）、`STATEMENT`（记录 SQL，日志小但函数/触发器有坑）、`MIXED`（折中）。

## 六、关键参数速查表（文档级，未实测）

| 参数 | 建议 | 理由 |
| --- | --- | --- |
| `innodb_buffer_pool_size` | 专用机 50%–75% 内存 | 第四节 |
| `innodb_flush_log_at_trx_commit` | 1，导入期可临时 2 | 第五节 |
| `sync_binlog` | 1（金融级）/ 0 或 N（读多写少） | binlog fsync 频率 |
| `innodb_flush_method` | Linux `O_DIRECT` | 跳过 OS 缓存避免双缓冲 |
| `max_connections` | 按连接池总量算，别默认 151 裸奔 | 每连接 = 线程 + 缓冲 |
| `innodb_io_capacity` | 按磁盘实测设 | 脏页刷写速率上限 |
| `log_bin` | 开 | 没 binlog 就不能主从、不能按时间点恢复 |

## 七、未实测清单

- 以上所有参数的实际收益、Buffer Pool 命中率数字、刷脏页行为——**无实例，未测**。
- 8.0 的原子 DDL、`innodb_dedicated_server` 自动推荐——文档级了解。
- MySQL 与 MariaDB 的差异、Percona/XtraDB 分支——不在本文范围。
- InnoDB Cluster / Group Replication / MGR——见 db-replica 那节的概念层。

下一篇 db-replica 讲复制与备份 recovery 的思路；要动手的读者请拿测试实例对照本文第七节的口径逐项验证。
