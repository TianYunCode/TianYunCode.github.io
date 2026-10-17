---
title: 执行计划与慢查询优化
description: 实测：EXPLAIN QUERY PLAN 的 SCAN/SEARCH/COVERING INDEX 三种形态；OFFSET 99000 要 9.97ms 而键集分页 0.08ms；executemany 不加事务和逐条一样慢。
date: 2026-10-16
tags: [数据库, SQL, EXPLAIN, 索引, 分页, 性能]
category: database
section: db-optimize
---

> 环境：Windows 11 x64，**SQLite 3.53.1**（Python 3.13.1），探针 `%TEMP%/db3o_*/probe_opt.py`。测试表 `orders`：10 万行，`id INTEGER PRIMARY KEY / cust INT / amt REAL / ts INT / note TEXT`。耗时为 3–5 轮中位；计划输出是 `EXPLAIN QUERY PLAN` 原文。**本机没有 MySQL**：`EXPLAIN` 的 `type/key/rows/Extra` 列、`optimizer_trace`、慢查询日志文件**未实测**，第六节给对照。

## 一、先看计划再动手：三种计划形态

`EXPLAIN QUERY PLAN`（SQLite 的读计划命令，输出的是规划器选的存取路径）就三种核心形态，全部实测：

```
WHERE cust=123（无索引）      : SCAN orders
WHERE cust=123（已建索引）     : SEARCH orders USING INDEX i_cust (cust=?)
SELECT id ... WHERE cust=123  : SEARCH orders USING COVERING INDEX i_cust (cust=?)
GROUP BY cust                 : SCAN orders USING COVERING INDEX i_cust
```

| 形态 | 含义 | 代价量级 |
| --- | --- | --- |
| `SCAN 表` | 全表扫，每行过一遍 WHERE | O(行数)，10 万行毫秒级但随表涨 |
| `SEARCH … USING INDEX` | 走 B 树定位到少量行，**再回表**取其他列 | O(匹配行 × log 行数) |
| `SEARCH … USING COVERING INDEX` | 要的列全在索引里，**不回表** | 同上但常数小得多 |

优化的全部动作，就是把计划从左边推到右边。**动手前先跑一次 `EXPLAIN QUERY PLAN`**——本文所有结论都能在计划里直接读到，不需要猜。反过来说：计划没变（还是 `SCAN`）的"优化"都是幻觉，比如给 `amt` 建索引前 `amt>1000` 的计划就是 `SCAN orders`。

## 二、联合索引的最左前缀：计划的逐条证据

`orders(cust, ts)` 上建联合索引后：

```
WHERE cust=?                  : SEARCH orders USING INDEX i_ct (cust=?)
WHERE ts=?（缺最左列）          : SCAN orders                          ← 索引作废
WHERE cust=? AND ts=?         : SEARCH orders USING INDEX i_ct (cust=? AND ts=?)
ORDER BY ts（cust 定值）        : SEARCH orders USING INDEX i_ct (cust=?)
ORDER BY ts（无 cust 定值）      : SCAN orders | USE TEMP B-TREE FOR ORDER BY
```

四条规则从这四行直接读出来：

1. **最左列必须出现在等值条件里**，否则整个索引不参与（`WHERE ts=?` 退化成全表扫）。
2. **两列都有等值条件时，索引把两层定位都用上**（`cust=? AND ts=?`）。
3. **定值 + 排序可以免排序**：`cust=?` 让第一列定值，第二列 `ts` 在索引里天然有序，计划里没有 `USE TEMP B-TREE`。
4. **无定值的 ORDER BY 要额外建临时 B 树排序**——10 万行上这一项就是几十毫秒，比扫描本身还贵。

设计索引时的两个推论：**把等值列放联合索引左边、范围/排序列放右边**；`ORDER BY` 的列顺序要能和索引对齐，否则排序兜底。

## 三、统计信息：ANALYZE 到底改变了什么

规划器在多索引可选择时**猜**，`ANALYZE` 把猜测换成实测。SQLite 把统计写进 `sqlite_stat1`：

```
ANALYZE 前: [('orders', 'i_ct', ...)]   ← 表不存在或为空
ANALYZE 后: [('orders', 'i_ct', '100000 20 1'), ('orders', 'i_cust', '100000 20')]
```

`'100000 20 1'` 的读法：索引覆盖 10 万行、`cust` 平均 20 行一个值、`(cust,ts)` 两列组合后每个 `cust` 内 `ts` 几乎唯一（1）。规划器据此估算"这个条件能过滤掉百分之几"，在 `SEARCH i_cust` 和 `SCAN` 之间做正确选择。

三个实践点：

1. **`ANALYZE` 是一次性快照，不是触发器**。大批量导入/删除后统计会过期，计划随之变坏。SQLite 的 `PRAGMA optimize` 会在合适时机自动补跑（连接关闭时按行数变化判断），**导入后手动 `ANALYZE` 一次是最稳的习惯**。
2. 单列索引 `i_cust` 的统计 `'100000 20'` 说明 `cust=123` 预计命中 20 行——这个估算直接决定规划器敢不敢用它。
3. 统计**只影响计划选择，不影响正确性**。`ANALYZE` 前后同一个查询结果一致（本文实测 count 8.28 ms 那行就是证据：数字不变，只是可能换条路走）。

## 四、深分页：OFFSET 的线性代价与键集分页

深分页是"功能正确、性能线性恶化"的典型。实测 `ORDER BY id LIMIT 20 OFFSET n`：

```
OFFSET    100:    0.09 ms
OFFSET  10000:    0.91 ms
OFFSET  50000:    4.09 ms
OFFSET  99000:    9.97 ms
键集分页 id>99000: 0.08 ms
```

**OFFSET 的代价是线性的**：数据库必须把前 n 行全部取出来再扔掉，n=99000 时 9.97 ms，而且这个数字随表增长——表变成 1000 万行时同样的 OFFSET 就是 1 秒级。键集分页（`WHERE id > 上次最后的id ORDER BY id LIMIT 20`）把"跳过多少"换成"从哪开始"，**代价与深度无关**，实测 0.08 ms，和第一页一样快。

适用边界：键集分页要求排序键唯一且单调（`id` 最理想，`created_at` 有重复值时要加 tiebreaker）；OFFSET 只适合"跳转到第 n 页"这种浅页和管理后台的小表。**分页 API 设计的第一天就该决定用哪种**——上线后从 OFFSET 迁到键集要改前端游标协议。

## 五、批量写：显式事务是唯一的分水岭

本节是本文数字最大的一处。同一台机器、同一个 3000 行的插入：

```
逐条自动提交 3000 行:      1827.2 ms
executemany 无显式事务:    1827.4 ms   ← 和逐条一样慢
executemany 单事务:           4.0 ms   ← 457x
每 200 行一批(单事务内):      2.5 ms   ← 731x
```

三个结论：

1. **快的是事务，不是 executemany**。`executemany` 只是省了 Python→C 的调用开销（每行几百纳秒），如果每条还在各自提交，该 fsync 的一次不少——1827.4 ms 对 1827.2 ms，统计上没差别。
2. **显式 `BEGIN`/`COMMIT` 是分水岭**：3000 次 fsync 变成 1 次，457 倍。
3. **单事务内再分 200 行一批几乎不损失速度**（2.5 ms 甚至更快，WAL 下大事务的帧写入更连续）。所以"单事务太长怕内存爆"的担心在 3000 行这个量级不成立，**分批复用是为了失败重试粒度，不是为了性能**。

配套的坑（本文探针第一版就踩了）：Python 的 `sqlite3` 默认 `isolation_level=''` 会隐式开事务但不自动提交，**你以为的"自动提交"其实是延迟提交**；要精确控制，`isolation_level=None` 然后自己发 `BEGIN`。db-transaction 第二节有完整实测。

## 六、MySQL/PG 侧对照（未实测）

本机没有 MySQL 实例，以下为文档语义对照，不是本文量出来的：

| SQLite | MySQL | 说明 |
| --- | --- | --- |
| `EXPLAIN QUERY PLAN` | `EXPLAIN` | MySQL 输出 `type/key/rows/Extra` 列，`type=ALL` 等价于本文的 `SCAN` |
| `SCAN orders` | `type=ALL` | 全表扫 |
| `SEARCH … USING INDEX` | `type=ref/range` + `key` | 走索引 |
| `COVERING INDEX` | `Extra=Using index` | 覆盖索引 |
| `USE TEMP B-TREE FOR ORDER BY` | `Extra=Using filesort` | 额外排序 |
| `sqlite_stat1` | `SHOW INDEX` 的 `Cardinality` | 统计信息 |
| 无 | 慢查询日志 `slow_query_log` | 按 `long_query_time` 落盘，是线上找慢 SQL 的正规入口 |
| 无 | `optimizer_trace` | 打开后能看到规划器的完整决策过程 |

**迁移时的读法差异**：SQLite 的 `EXPLAIN QUERY PLAN` 只给存取路径，MySQL 的 `EXPLAIN` 还给**预估行数**（`rows` 列）——那个数字离谱大时，即使计划看着走了索引也要警惕（统计过期或函数导致索引失效）。

## 七、慢查询的定位顺序

把本文结论排成一个可执行顺序：

1. **拿到 SQL 和执行计划**（线上：慢查询日志；开发：`EXPLAIN QUERY PLAN`）。没有计划不动手。
2. **看是不是 `SCAN`**。是 → 第三步；不是（已 SEARCH）→ 直接第五步。
3. **给 WHERE/JOIN/ORDER 的列建索引**，等值列在前、范围/排序列在后，建完重跑计划确认变成 `SEARCH`。
4. **看能不能覆盖**：SELECT 的列收窄到索引内，计划出现 `COVERING INDEX`。
5. **批量操作套事务**：导入/更新脚本先确认在单事务里（第五节数字）。
6. **分页换键集**：`OFFSET` 超过几千行就换（第四节数字）。
7. **`ANALYZE`** 收尾：大批量变更后统计归位，防止规划器在坏统计下选错索引。
8. 以上做完还慢，**瓶颈大概不在数据库**——回到 dbg-bottleneck 那节的判断次序（IO/CPU/锁/数据布局），别在 SQL 上继续雕花。
