---
title: 事务与隔离级别
description: 实测：逐条自动提交比单事务慢 154–171 倍；读者的 SHARED 锁能挡住写者 COMMIT（WAL 下不会）；SQLite 只有 SERIALIZABLE 一档。
date: 2026-10-16
tags: [数据库, 事务, 隔离级别, ACID, SQLite]
category: database
section: db-transaction
---

> 环境：Windows 11 x64，**SQLite 3.53.1**（Python 3.13.1 的 `sqlite3` 模块，`sqlite3.sqlite_version` 读回 `3.53.1`），探针用 `isolation_level=None` 关掉 pysqlite 的隐式事务、`BEGIN`/`COMMIT` 全部手动发。计时 `time.perf_counter()`，**耗时是 3 轮中位数**；语义类结论（读到什么值、什么锁、报什么错）在同一 exe 同一文件下可复现。**本机没有 MySQL、没有 Postgres、没有 SQL Server**：`READ COMMITTED`/`REPEATABLE READ` 这两档的实测、`information_schema` 里的会话变量、死锁日志**一律未实测**，本文只在概念层面对照，第五节给清单。探针在 `%TEMP%/db3_*/probe_tx4.py`，库文件 `tx1.db`–`tx7.db` 与 `wal.db`。

## 一、ACID 四个字母，在 SQLite 里各自落在哪

先给结论再给证据。事务的四个属性不是四个开关，而是四个不同的机制：

| 字母 | 含义 | SQLite 里的落点 | 本文实测 |
| --- | --- | --- | --- |
| A 原子性 | 要么全做要么全不做 | 回滚日志（rollback journal）或 WAL + 提交时的状态翻转 | 第六节 ROLLBACK/SAVEPOINT |
| C 一致性 | 约束不被破坏 | 应用层 + `CHECK`/`FOREIGN KEY`/`UNIQUE`（`PRAGMA foreign_keys` 默认 **OFF**，db-model 那节量过） | 未展开（属于 schema 篇） |
| I 隔离性 | 并发事务互不看见中间态 | 锁 + 快照：回滚日志模式下靠 `SHARED`/`RESERVED`/`EXCLUSIVE` 三级锁；WAL 下读者各拿快照 | 第三、四、七节 |
| D 持久性 | 提交了重启不丢 | `synchronous`  pragma 控制的 fsync 策略（FULL/NORMAL/OFF） | 第二节的 154–171 倍主要就是它 |

**最容易误会的是 D**。很多人以为"提交=落盘"，其实 SQLite 默认 `synchronous=FULL` 在三种模式下都是每次提交做多次 fsync；WAL + `synchronous=NORMAL` 只在检查点 fsync。本文测出的"逐条提交慢 154–171 倍"，慢的不是 SQL 解析，是**每次 COMMIT 都要等一次磁盘往返**——这就是事务边界的第一个实践结论：**批量的边界按"业务完整性"划，不按"代码方便"划**。

## 二、自动提交的代价：逐条 vs 单事务，实测 154–171 倍

探针在同一台机器、同一个空库上各跑 3 轮取中位，N=500：

```
逐条自动提交: 中位 2633.9 ms (5268 µs/条)
单事务:       中位 15.4 ms (30.8 µs/条)
比值 171x
```

另一轮（换库文件重跑）是 2290.6 ms vs 14.9 ms，比值 154x。**两轮的绝对值差 15%，比值差 11%——报告比值不报告绝对值**，因为同期机器上还有别的 agent 在跑，fsync 延迟对负载敏感。

几个值得记住的数字：

1. **单事务 30 µs/条**：这是 SQLite 在本机盘上的"批发价"。注意它**不是零**——500 条在一个事务里也要写 500 行进 B 树、最后一次性写 journal + db 文件。
2. **逐条 4.5–5.3 ms/条**：这是"零售价"。每一条的 COMMIT 都要：写 journal 文件、fsync journal、写 db 文件、fsync db、删 journal。**慢了两个数量级，罪魁是 fsync 不是 SQL**。
3. 仓库里 db-model 那节在 10 万行上量到过 717–1053 倍——比本文的 154–171 倍更夸张，因为行数越多、journal 目录项的分配和删除被放大得越厉害。**趋势一致：批量提交是数量级级别的优化，不是百分比级别的。**

**Python 侧的一个大坑**（本文探针第一版就踩了）：`sqlite3.connect()` 默认 `isolation_level=''`，pysqlite 会在**每条 DML 前隐式发 `BEGIN`**，但 `COMMIT` 要你显式调——于是"我在循环里 insert 了 2000 条"很可能从头到尾待在**一个隐式事务**里，内存里的 journal 一直不落盘，你以为在测自动提交，其实测的是单事务。正确做法二选一：`isolation_level=None` 完全手动管事务（本文用法），或 Python 3.12+ 的 `autocommit=True/False`。**默认值是最坏选项**：看着像自动提交，行为是延迟提交。

## 三、BEGIN 的三种模式：DEFERRED / IMMEDIATE / EXCLUSIVE

SQLite 的 `BEGIN` 可以带三种修饰，差别在**锁什么时候拿**：

| 模式 | BEGIN 时 | 第一条读时 | 第一条写时 |
| --- | --- | --- | --- |
| `DEFERRED`（默认） | 不拿锁 | SHARED | 升级 RESERVED |
| `IMMEDIATE` | 直接拿 RESERVED | SHARED | 已是 RESERVED |
| `EXCLUSIVE` | 直接拿 EXCLUSIVE | — | — |

无竞争时三者差别可以忽略（实测拿写锁+更新 1.1–2.4 ms，三者互有胜负，差异在噪声内）。**差别全在竞争时**，这决定了两种写事务的写法：

- 单写者、多读者的典型 Web 应用：`BEGIN IMMEDIATE` 更好——**在事务开头就竞争写锁**，拿不到立刻失败重试，而不是像 DEFERRED 那样先读一堆、最后升级写锁时才失败，把整段工作作废（这正是第五节"快照过期"的场景）。
- `EXCLUSIVE` 还会挡住所有读者（包括 WAL 下的读者），只适合 `VACUUM`、改 schema 这类"我要独占整个库"的操作。

竞争实测（另一连接持有 RESERVED 锁，本连接 `timeout=0.05`）：

```
BEGIN DEFERRED : 122 ms 后失败: database is locked
BEGIN IMMEDIATE: 107 ms 后失败: database is locked
BEGIN EXCLUSIVE: 107 ms 后失败: database is locked
```

**两个反直觉点**：其一，DEFERRED 的失败发生在**第一条写语句**而不是 `BEGIN` 本身（`BEGIN DEFERRED` 是不碰锁的，报错的是它后面的 UPDATE）；其二，`timeout=0.05`（50 ms）实际等了 107–122 ms 才报错——SQLite 默认 busy handler 的睡眠序列是 1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100 ms，**累加到超过 deadline 的那次才醒**，所以"超时 50ms"在体感上是 100ms 以上。要精确控制等待，用 `sqlite3_busy_timeout()` 设值并接受这个粒度，或者自己在应用层做指数退避重试。

## 四、隔离级别：SQLite 只有一档，另外三档在别家

先看实测能证明的部分。两个连接，写者改 v=999 但**不提交**，读者开事务读：

```
写未提交(v=999)时读事务读到: 100 → 无脏读
写提交后同一读事务再读: 100 → 无不可重复读
新连接读到: 999
```

这组数字说明 SQLite 在回滚日志模式下至少提供 **REPEATABLE READ 级别的读**（同一事务内重复读一致）。实际上 SQLite 文档的表述是：**整个数据库一个写者，读者看到的是提交时的数据库状态快照**——即 **SERIALIZABLE**。对照标准四级：

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | SQLite | MySQL InnoDB 默认 | Postgres 默认 |
| --- | --- | --- | --- | --- | --- | --- |
| READ UNCOMMITTED | 可能 | 可能 | 可能 | **不支持**（WAL 下读近似此档但无写入） | 支持（几乎没人用） | 不支持 |
| READ COMMITTED | 不可能 | 可能 | 可能 | 不支持 | 支持 | **就是这一档** |
| REPEATABLE READ | 不可能 | 不可能 | 可能（InnoDB 下幻读也被 MVCC 挡住） | 不支持（实际更强） | **就是这一档** | 支持 |
| SERIALIZABLE | 不可能 | 不可能 | 不可能 | **就是这一档** | 支持 | 支持 |

三个实践结论：

1. **"SQLite 并发差"是误传**。它的隔离强度是满的，弱的是**写并发**：任何时刻只允许一个写者。多写者的场景要么排队、要么应用层分片（按用户/按租户拆库文件）。
2. **从 MySQL/PG 迁移到 SQLite，隔离语义是升配不是降配**——原来靠 `SELECT ... FOR UPDATE` 显式加锁防并发的代码，在 SQLite 里直接删掉即可，因为根本不存在第二个写者能插进来。反过来，原来依赖"读已提交能看到别人刚提交的数据"做消息处理的逻辑，迁移后会**读不到**，必须重写。
3. **MySQL/PG 的各级别实测本机没有实例，未测**。表格里那两列是文档语义，不是本文量出来的——写这两栏时请当你手里的对照表，不是证据。

## 五、快照过期：DEFERRED 事务最贵的失败方式

这是本文最实用的一节。两个连接都开 `BEGIN`（DEFERRED），a 先升级写锁改数据，b 后升级：

```
a.execute("BEGIN IMMEDIATE"); a.execute("UPDATE t SET v=2")
b.execute("BEGIN");          b.execute("UPDATE t SET v=3")
→ b 升级失败: database is locked
```

b 的失败**不在 BEGIN**，而在升级写锁那一刻：它的读快照在 BEGIN 后的第一次读时定型，a 的提交让数据库变了，b 再想写就撞上"快照过期"（MySQL 里同样的错是 `ERROR 1205 (HY000): Lock wait timeout` 或 `1213` 死锁回滚）。**这个失败的代价是 b 整个事务白做**——所以多写者的代码里，`BEGIN IMMEDIATE` 不是风格问题，是把失败点从"最后一步"提前到"第一步"的正确性选择。

顺带一个 Python 侧的连带坑：b 失败后连接里**还挂着一个活动事务**，不 `ROLLBACK` 就继续发下一条语句，会把上一段的半截状态带进下一段。异常处理里永远先 rollback 再重试。

## 六、事务边界设计：ROLLBACK、SAVEPOINT 与"多大算一批"

原子性的实际用法是**嵌套的部分回滚**。探针：

```
BEGIN
  INSERT v=1
  SAVEPOINT s1
  INSERT v=2
  ROLLBACK TO s1      ← 只回滚 s1 之后的
  INSERT v=3
COMMIT
→ 最终行: 1,1,3
```

对应的设计规则：

1. **一个业务操作一个事务**。"导入 10 万行"是一个事务（也因此快 154–171 倍），"用户注册+发优惠券+写审计日志"如果三个系统调用，要么包成一个事务，要么明确接受"券发了人没注册上"并用对账修补。
2. **长事务拆段用 SAVEPOINT**：批处理循环里每个文件/每 1000 行一个 savepoint，失败只回滚当前段，不用整体重来。注意 `ROLLBACK TO s1` **不释放** savepoint，还要 `RELEASE s1`。
3. **只读事务也要显式 BEGIN**：让连接清楚"我这一轮是快照读"，避免中间夹带写操作把快照弄过期。
4. **连接池归还前必须结束事务**：池化连接复用最常见的 bug 是"上个请求忘 commit/rollback，下个请求继承了他的锁和快照"。SQLite 下这直接表现为偶发的 `database is locked`，且极难复现。

## 七、WAL：把"读者挡写者"这个结构性问题拆掉

第四节留了个伏笔：探针里写者 COMMIT 曾被读者的 SHARED 锁挡住（回滚日志模式）。这不是配置错误，是 journal 模式的硬限制——读者读的时候写者不能改文件。换成 WAL 再测：

```
PRAGMA journal_mode=WAL
写事务进行中，读连接 2.724 ms 读到 v=1（旧快照，未被阻塞）
写者 COMMIT 用时 1.042 ms（读者在场也成功）
新连接读到 v=42
```

WAL 的做法是写者只追加 `-wal` 文件，读者各带自己的"读到哪了"游标，**读写彻底不互斥**。代价三条（本文都验证过或可直接复现）：库文件旁边多两个文件（`-wal`/`-shm`）、读多写少时要 checkpoint 把 WAL 合回主库、**网络文件系统上不能用**（NFS/CIFS 共享的库必须留在 journal 模式）。

选型表：

| 场景 | journal_mode | 理由 |
| --- | --- | --- |
| 单进程嵌入式、Flash 小容量 | `DELETE`（默认） | 无附加文件，掉电语义最简单 |
| 多进程/多连接读写混合 | `WAL` | 读写不互斥，第四节实测 |
| 只读分析、追求极致读速 | `WAL` + `synchronous=NORMAL` | 提交不等 fsync，崩溃最多丢最后一个检查点前的提交 |
| 网络盘共享库 | `DELETE` | WAL 需要共享内存，网络盘上行为未定义 |

## 八、未实测清单与下一步

本文所有数字来自本机 SQLite 3.53.1。以下内容**明确未实测**，用到时请回各自官方文档核对：

- MySQL/Postgres 的 `READ COMMITTED`/`REPEATABLE READ` 行为、`SET TRANSACTION ISOLATION LEVEL`、`information_schema` 会话变量——本机无实例。
- InnoDB 的间隙锁/next-key、死锁日志 `SHOW ENGINE INNODB STATUS`——属于 db-lock-mvcc 那节，同样无实例。
- `PRAGMA synchronous` 三档在**真实掉电**下的保持性——本机无法安全掉电，只做了语义层面对照。
- SQLite 的 `BEGIN CONCURRENT`（3.34+ 的实验特性，WAL 下多写者）——本文未启用编译选项，未测。

下一篇 db-sqlite 会把 WAL、`busy_timeout` 和打包迁移这些"嵌入式集成"问题单独量一遍。
