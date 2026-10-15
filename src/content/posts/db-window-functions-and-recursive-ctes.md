---
title: 窗口函数与 CTE：默认帧让累计和翻倍、递归 CTE 会挂死、把 1000 次循环压成一条 SQL 实测快 170 倍
description: >-
  实测：`sum() over (order by v)` 的默认 RANGE 帧把并列行全算进来，10 万行里 99900 行的累计值与 ROWS 帧不同；`last_value` 默认帧右端就是当前行；`row_number`/`rank`/`dense_rank` 取每组前 3 实测给 3000 / 3008 / 3000 行，`max` 连接只给 1006 行；`row_number()` 进 WHERE 报 `misuse of window function row_number()`；`generate_series` 报 `no such table: generate_series`；递归 CTE 不带截断条件遇环跑满 40 s 未返回被 timeout 杀掉，而 `select v from 无上界递归 limit 5` 正常返回 1..5；1000 次 N+1 点查中位 11282 ms vs 一条 GROUP BY 66.3 ms（中位 170 倍）；给每笔订单写 Top3 标签，应用层逐行 UPDATE 1204 ms vs `UPDATE FROM`+窗口 552 ms（2.18 倍）。
date: 2026-10-16
tags: [数据库, SQL, SQLite, Qt SQL, 窗口函数, CTE, 递归查询, TopN]
category: database
section: db-advanced-sql
---

> 环境与前两节一致：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ `Qt6::Sql`，插件 `plugins/sqldrivers/qsqlite.dll`，GCC 13.1.0 编译，无头运行，SQL 引擎 **Qt 内嵌 SQLite 3.50.4**。本文全部输出来自探针 `p8_window.cpp` 打真库，源码与每次运行的 stdout 都留存在本机。本机没有 MySQL / MariaDB / PostgreSQL 服务，凡涉及它们的表述集中在第十二节，**未在本机实测**。
>
> 计时口径：窗口函数与执行计划类实验**整个程序独立重跑 3 次**，正文给 3 个 best 值的中位数 + 区间；递归序列生成、应用层循环对比这类一次性任务另有说明，单次样本的地方**逐条标注**。同机同期有其它 agent 抢 CPU，**比值比绝对值可靠**。

## 一、先数一遍手上有什么

窗口函数不是插件，是内嵌的。`pragma_function_list` 读回来的聚合器清单：

```text
  Q> select name, narg from pragma_function_list where name in
     ('generate_series','row_number','rank','dense_rank','percent_rank','cume_dist','ntile',
      'lag','lead','first_value','last_value','nth_value','json_each') order by name
     name | narg
     cume_dist | 0
     dense_rank | 0
     first_value | 1
     lag | 1
     lag | 3
     lag | 2
     last_value | 1
     lead | 1
     lead | 3
     lead | 2
     nth_value | 2
     ntile | 1
     percent_rank | 0
     rank | 0
     row_number | 0
```

上面 13 个名字里回回来 11 个（`lag`/`lead` 各 3 种元数，共 15 行），第三参是补位默认值。没回来的是 `generate_series` 和 `json_each`——后者是表值函数，不在这张视图里，本文未复核。**`generate_series` 是真缺**：

```text
  Q> select count(*) from generate_series(1,100)
   FAIL> no such table: generate_series Unable to execute statement
  Q> pragma recursive_triggers
     recursive_triggers
     0
```

`generate_series` 在 SQLite 里是 **编译期可选的表值函数扩展**，Qt 打包的 `qsqlite.dll` 没带它——报错形式是 `no such table`（它本该是表，不是函数）。所以"造日期序列 / 造整数序列"在本机只有一条路：**递归 CTE**（第十节）。

`AS MATERIALIZED` 的支持情况顺手也试了，语法是 `WITH c AS MATERIALIZED (...)`，**不是** `AS MATERIALIZED AS (...)`：

```text
  Q> with c as materialized as (select id, customer_id, amount from orders) select count(*) from c a, c b
   FAIL> near "as": syntax error Unable to execute statement
```

## 二、ROW_NUMBER / RANK / DENSE_RANK：并列怎么断开

10 行小表（A 组 7 行含 NULL 和两对并列值，B 组 3 行含一对并列）：

```text
     id | g | v | rn | rk | dr
     1  | A | 10   | 5  | 5  | 4
     2  | A | 10   | 6  | 5  | 4
     3  | A | 30   | 9  | 9  | 6
     4  | A | NULL | 1  | 1  | 1
     5  | A | 20   | 7  | 7  | 5
     6  | A | 20   | 8  | 7  | 5
     7  | A | 40   | 10 | 10 | 7
     8  | B | 1    | 2  | 2  | 2
     9  | B | 5    | 3  | 3  | 3
     10 | B | 5    | 4  | 3  | 3
```

三条规则一次看全：

- **`row_number()` 强制给唯一序号**：id 1 和 id 2 的 `v` 都是 10，rn 仍是 5 和 6。谁在前由排序键的**并列内部顺序**决定，本例没写次级排序键，所以这个先后是**不保证的**。要做"每组 Top-N"必须在排序键后面补一个唯一列（`order by amount desc, id`），否则同一秒两条记录的先后可能随计划变。
- **`rank()` 并列同号并且跳号**：v=10 两行都是 5，下一档 v=20 直接跳到 7（6 被吃掉）。
- **`dense_rank()` 并列同号但不跳号**：10 → 4，20 → 5。
- **`NULL` 在升序里排最前**：id 4 的 `v` 是 NULL，`order by v` 给它 rn=1 / rk=1。**要 NULL 排最后必须显式写 `ORDER BY v IS NULL, v`**（SQLite 没有 `NULLS LAST` 语法，本节未实测该关键字；MySQL 的 `NULLS LAST`、PostgreSQL 的 `NULLS LAST` **未在本机实测**）。

`percent_rank` / `cume_dist` / `ntile` 的定义可以用这张表验证（A 组 7 行，n=7）：

```text
     id | v    | pr                 | cd                 | nt
     4  | NULL | 0                  | 0.14285714285714285| 1
     1  | 10   | 0.16666666666666666| 0.42857142857142855| 1
     2  | 10   | 0.16666666666666666| 0.42857142857142855| 1
     5  | 20   | 0.5                | 0.7142857142857143 | 2
     6  | 20   | 0.5                | 0.7142857142857143 | 2
     3  | 30   | 0.8333333333333334 | 0.8571428571428571 | 3
     7  | 40   | 1                  | 1                  | 3
```

`percent_rank = (rank-1)/(n-1)`：v=20 的 rank 是 4，`(4-1)/6 = 0.5` ✓。`cume_dist` 是"值 ≤ 我 的行数 / 总行数"，并列行拿同一个值 ✓。`ntile(3)` 把 7 行分 3 桶 → 3/2/2，**余数摊给前面的桶**，所以第 1 桶 3 行。

真实数据上校一下 `ntile`：10 万行 `ntile(10) over (order by amount)` → **10 个桶，每桶精确 10000 行**；`ntile(4)` 的四分位边界：

```text
     q | n     | mn    | mx
     1 | 25000 | 1     | 25.99
     2 | 25000 | 25.99 | 50.99
     3 | 25000 | 50.99 | 76.14
     4 | 25000 | 76.14 | 100.99
```

**边界是重叠的**（q1 的 max = 25.99，q2 的 min 也是 25.99）——并列值恰好跨桶被切开。用 `ntile` 做分层抽样/分位报表时，别拿桶边界当"分位数值"，要拿 `percentile` 语义就自己写 `nth_value` 或 `order by ... limit 1 offset n/4`。

## 三、PARTITION BY 与命名 WINDOW：分区就是"组内不聚合"

```text
     id | g | v    | rn | gsum | gcnt | star
     1  | A | 10   | 2  | 130  | 6    | 7
     2  | A | 10   | 3  | 130  | 6    | 7
     3  | A | 30   | 6  | 130  | 6    | 7
     4  | A | NULL | 1  | 130  | 6    | 7
     5  | A | 20   | 4  | 130  | 6    | 7
     6  | A | 20   | 5  | 130  | 6    | 7
     7  | A | 40   | 7  | 130  | 6    | 7
     8  | B | 1    | 1  | 11   | 3    | 3
     9  | B | 5    | 2  | 11   | 3    | 3
     10 | B | 5    | 3  | 11   | 3    | 3
```

关键在 `gcnt = 6` 而 `star = 7`：**上一篇《查询》第五节的 `count(表达式)` 与 `count(*)` 规则在窗口里一模一样**，NULL 又被丢了一次。

命名窗口子句把同一份帧定义复用三次，省字也防抄错：

```text
  Q> select id, g, v, sum(v) over w gsum, row_number() over w rn, max(v) over w gmax
     from s window w as (partition by g) order by g, id
     1 | A | 10   | 130 | 1 | 40     ...   8 | B | 1 | 11 | 1 | 5
```

`window w as (partition by g)` 里**没有 ORDER BY**，于是 `row_number()` 的序号来自分区内的物理到达顺序（本例 = rowid 序）：**又一次说明"不写排序键就没有保证的顺序"**。

## 四、本节最贵的一条：默认帧把累计和算成"含所有并列行"

同一张表，同一份数据，只差一个帧：

```text
  Q> select id, v,
             sum(v)   over (order by v)                        default_range,
             sum(v)   over (order by v rows unbounded preceding) rows_cum,
             count(*) over (order by v)                        cnt_range,
             count(*) over (order by v rows unbounded preceding) cnt_rows
     from s where g='A' order by v, id
     id | v    | default_range | rows_cum | cnt_range | cnt_rows
     4  | NULL | NULL          | NULL     | 1         | 1
     1  | 10   | 20            | 10       | 3         | 2
     2  | 10   | 20            | 20       | 3         | 3
     5  | 20   | 60            | 40       | 5         | 4
     6  | 20   | 60            | 60       | 5         | 5
     3  | 30   | 90            | 90       | 6         | 6
     7  | 40   | 130           | 130      | 7         | 7
```

**带 `ORDER BY` 的窗口，默认帧是 `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`，而 `RANGE` 的 "CURRENT ROW" 指的是"与我排序值相同的所有行"**（peer group）。所以 id 1 和 id 2 都拿到 20（= NULL 不算 + 10 + 10），而不是 10 和 20。

这就是线上最常见的"累计余额对不上"事故：`sum() over (order by ts)` 里同一时间戳的多笔交易**每笔都拿到同样的累计值**，最后一笔之前的行全都偏高。真实数据上的实测：

```text
  Q> select ts, count(*) n from orders group by ts order by n desc limit 3
     1744243200 | 1000
     1744156800 | 1000
     1744070400 | 1000
  Q> select count(*) diff_rows from (select id, sum(amount) over (order by ts, id) a,
             sum(amount) over (order by ts, id rows unbounded preceding) b from orders) where a<>b
     diff_rows
     0
  Q> select count(*) ties_on_ts_only from (select id, sum(amount) over (order by ts) a,
             sum(amount) over (order by ts rows unbounded preceding) b from orders) where a<>b
     ties_on_ts_only
     99900
```

**同一个排序，只把 `, id` 拿掉，就有 99900 行（10 万行的 99.9%）两种帧算出不一样。** 因为本机这份数据每个 `ts` 正好 1000 行并列。加上唯一列 `, id` 之后差异归零——这就是修法的正确形态：**累计和的排序键必须以唯一列结尾**，或者干脆显式写 `ROWS UNBOUNDED PRECEDING`。

`ROWS` / `RANGE` / `GROUPS` 三种帧在同一条 SQL 里并排跑（`order by id`，id 唯一 → 三者等价）：

```text
     id | v    | r1 | rng1 | grp1
     1  | 10   | 10 | 10   | 10
     2  | 10   | 20 | 20   | 20
     3  | 30   | 40 | 40   | 40
     4  | NULL | 30 | 30   | 30
     5  | 20   | 20 | 20   | 20
     6  | 20   | 40 | 40   | 40
     7  | 40   | 60 | 60   | 60
```

`GROUPS` 帧语法被接受（SQLite 3.28+ 起支持），本例没有并列所以和 ROWS 一致——**要看出差异必须让排序键有并列**，就像上面 `order by v` 那一组。

反向窗口（未来 N 行）也照样能写，`fwd` 列：

```text
  Q> select id, v, sum(v) over (order by id rows between current row and 2 following) fwd
     from s where g='A' order by id
     1 | 10   | 50
     2 | 10   | 40
     3 | 30   | 50
     4 | NULL | 40
     5 | 20   | 80
     6 | 20   | 60
     7 | 40   | 40
```

## 五、EXCLUDE、`last_value`、`lag`/`lead`

帧内排除（`EXCLUDE CURRENT ROW` / `EXCLUDE GROUP` / `EXCLUDE TIES` / `EXCLUDE NO OTHERS`）实测可用：

```text
     id | v    | s3 | s2  | sall | arng
     1  | 10   | 20 | 10  | 130  | 10
     2  | 10   | 50 | 40  | 130  | 16.666666666666668
     3  | 30   | 40 | 10  | 130  | 20
     4  | NULL | 50 | 50  | 130  | 25
     5  | 20   | 40 | 20  | 130  | 20
     6  | 20   | 80 | 60  | 130  | 26.666666666666668
     7  | 40   | 60 | 20  | 130  | 30
```

`s3` 是前后各一行的三行移动和，`s2` 加了 `exclude current row` → 变成"邻居和"，这正是**移动平均/环比要排除自己**的场景。id 4 那行 `s3 = s2 = 50`：因为当前行是 NULL，聚合本来就不吃它，排除不排除一个样。

`last_value` 的坑是默认帧的直接后果：

```text
  Q> select id, v, last_value(v) over (order by id) lv_default,
             last_value(v) over (order by id rows between unbounded preceding and unbounded following) lv_all,
             first_value(v) over (order by id) fv, nth_value(v,2) over (order by id) nv2
     from s where g='A' order by id
     1 | 10   | 10   | 40 | 10 | NULL
     2 | 10   | 10   | 40 | 10 | 10
     3 | 30   | 30   | 40 | 10 | 10
     4 | NULL | NULL | 40 | 10 | 10
     5 | 20   | 20   | 40 | 10 | 10
     6 | 20   | 20   | 40 | 10 | 10
     7 | 40   | 40   | 40 | 10 | 10
```

**`last_value(v) over (order by id)` 恒等于当前行的 `v`**——因为默认帧的右端就是当前行。想要"分区里真正的最后一行"必须自己写 `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`（`lv_all` 全 40）。`nv2` 第一行是 NULL：第 1 行的帧里只有 1 行，取不到第 2 个。

`lag` / `lead`：

```text
     id | v    | l1   | l2   | l0   | f1   | diff
     1  | 10   | NULL | NULL | 0    | 10   | NULL
     2  | 10   | 10   | NULL | 10   | 30   | 0
     3  | 30   | 10   | 10   | 10   | NULL | 20
     4  | NULL | 30   | 10   | 30   | 20   | NULL
     5  | 20   | NULL | 30   | NULL | 20   | NULL
     6  | 20   | 20   | NULL | 20   | 40   | 0
     7  | 40   | 20   | 20   | 20   | NULL | 20
```

三点：首行 `lag` 是 NULL（**不是 0**），要 0 就写第三参 `lag(v,1,0)`；`v - lag(v)` 让整列差分从第 2 行起才有值，**"增长率"报表第一行必然是 NULL，导出前 `coalesce`**；id 3 的 `f1` 是 NULL 而不是下一行 id 4 的值——那是最后一行。

还有一个把窗口当计数器用的写法，实测正确：

```text
  Q> select id, count(*) over (order by v range between current row and unbounded following) cnt_ge
     from s where g='A' order by v, id
     4(NULL) | 7   1|6   2|6   5|4   6|4   3|2   7|1
```

"值 ≥ 我 的行数"，并列行拿同一个数——这是不用自连接就能算"我排第几档"的正规做法。

## 六、Top-N per group：四种写法的实测行数不一样

小表"每组前 2 名"，四种写法：

| 写法 | 结果 |
| --- | --- |
| `row_number() ... where rn<=2` | A: 7(40), 3(30) / B: 9(5), 10(5) |
| 相关子查询"比我大的不足 2 个" | A: 7, 3, **4(NULL)** / B: 9, 10 |
| `rank() ... where rk<=2` | A: 7, 3 / B: 9, 10 |
| `JOIN (select g, max(v) ...) on v = mx` | A: 7 / B: 9, 10 —— **第二名整个丢了** |

两种翻车：

- **相关子查询写法把 NULL 行也塞进 Top-2**（id 4）。因为 `b.v > NULL` 永不为真，"比我大的有几个"= 0，于是 NULL 成了组内第一名。这正是第二节 `NULL` 排序规则的反面：**`ORDER BY` 里 NULL 最小，`>` 比较里 NULL 谁都不大于。**
- **`JOIN max` 只能回答"每组最大值是谁"**，它给的 1006 ≠ 1000 是并列造成的，永远给不出前 3 名。

10 万行 × 1000 客户上的同一道题（`p8_2.txt`，三次运行数值完全一致）：

```text
  Q> ... row_number() over (partition by customer_id order by amount desc, id) rn ... where rn<=3
     rn3   = 3000
  Q> ... rank() over (partition by customer_id order by amount desc) rk ... where rk<=3
     rank3 = 3008
  Q> select count(*) joinmax from orders o join (select customer_id, max(amount) mx from orders group by customer_id) m
       on m.customer_id=o.customer_id and o.amount=m.mx
     joinmax = 1006
```

**`row_number` 精确 3000 = 1000 × 3（排序键带了唯一列 `id`，绝无并列）；`rank` 给 3008，多了 8 行——并列值让它"超过"配额；`max` 连接给 1006 而不是 1000，说明有客户存在两笔金额完全相同的最大订单。** 业务上"每客户前 3 笔"到底该给 3000 还是 3008，必须自己定：**给固定条数用 `row_number`，给"并列都要"用 `rank`，用 `dense_rank` 会把并列后的名次压缩、语义又不同。** 这一格数字是选择函数的唯一依据，不能靠猜。

## 七、10 万行上窗口函数的代价（三次运行中位数）

`orders` 100000 行，`db=2523136` 字节（**无二级索引**）。每条 SQL 进程内跑 3 次取 best，程序独立重跑 3 次：

| # | 查询 | 无索引 中位（区间） | 建 `idx(customer_id, amount)` 后 中位 |
| --- | --- | --- | --- |
| C1 | 全局累计和，默认 RANGE 帧 | 87.751 ms（83.266–122.215） | 未复测 |
| C2 | 全局累计和，显式 ROWS 帧 | **81.389 ms**（72.767–82.141） | 未复测 |
| C3 | 分区累计和（每客户） | 96.275 ms（95.534–110.591） | **251.497 ms** ← 慢 2.6× |
| C4 | 分区 `row_number()` | 101.619 ms（92.430–148.882） | 67.286 ms ← 快 1.5× |
| C5 | 每客户 Top3（窗口） | 105.921 ms（105.203–195.504） | 67.615 ms ← 快 1.6× |
| C8 | 纯 `GROUP BY` 计数（对照组） | 43.112 ms（36.430–110.774） | **6.028 ms** ← 快 7.2× |
| C9 | 28 行移动平均（ROWS） | 58.138 ms（54.403–101.162） | 未复测 |
| C10 | `lag` 差分（分区） | 94.489 ms（84.918–160.569） | 未复测 |
| C6 | 每客户最大单（相关子查询） | **本节未实测**（O(n²)，40 s 未跑完） | 30.625 ms（26.557–33.571） |
| C7 | 每客户最大单（GROUP BY JOIN） | **本节未实测**（同上） | **7.342 ms**（5.979–8.364） |

计划原文解释了这一切（窗口函数被实现成 **两层 CO-ROUTINE**：先协程产出排好序的行，再协程按帧算值）：

```text
  EQP> select count(*) from (select id, sum(amount) over (order by ts, id) run from orders)
     CO-ROUTINE (subquery-1)
     CO-ROUTINE (subquery-3)
     SCAN orders
     USE TEMP B-TREE FOR ORDER BY
     SCAN (subquery-3)
     SCAN (subquery-1)
```

**窗口函数的固定成本 = 一次把全表按 `(partition, order)` 排序的临时 B 树。** 所以：

1. **C8 纯 GROUP BY 只要 43 ms，加了窗口就 100 ms 量级**（2.3 倍）。能用 GROUP BY 解决的别上窗口。
2. **C1(默认 RANGE 帧) 87.8 ms vs C2(ROWS 帧) 81.4 ms**，落在彼此区间内 → **本例帧类型不构成性能差别**（排序键含唯一列 `id`，每帧只有 1 行，RANGE 找 peer 边界的额外开销为零）。不要把帧当成性能选项，它是**正确性**选项。
3. **C3 建索引后反而慢 2.6 倍**，这是本节第二个负面结果：

```text
  C3 无索引：      SCAN orders                            + USE TEMP B-TREE FOR ORDER BY
  C3 两个索引后：  SCAN orders USING INDEX idx_orders_cust_amt
                   + USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY
```

`idx_orders_cust_amt` 是 `(customer_id, amount)`，排序键要的是 `(customer_id, ts, id)`。索引只提供了第一列的顺序，`(ts, id)` 仍要排序（`LAST 2 TERMS`），**而且这个索引不含 `ts`/`amount` 之外的列，扫索引还要回表取 `ts`**——多付一趟随机回表，一点也没省掉排序。库文件也从 2523136 → **4489216 字节（+1966080）**。

4. 反过来 **C4/C5 建索引后快 1.5–1.6 倍**，计划变成 `USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY`（排序键 `(customer_id, amount desc, id)`，前两列由索引给出）。C8 的 7.2 倍更直接：

```text
  EQP> select count(*) from (select customer_id, count(*) n, sum(amount) s from orders group by customer_id)
     CO-ROUTINE ...  SCAN orders USING COVERING INDEX idx_orders_cust_amt   （无 TEMP B-TREE）
```

**"省不省 temp B-tree"是这一节所有比值的解释变量**，比"索引/不索引"这个词本身有信息量得多。要吃到这个收益，索引必须按 `(分区列, 排序列...)` 的顺序建，并且把 SELECT 用到的列全包住。

`UPDATE...FROM` + 窗口（第十一节的写法）在索引后的计划：

```text
     CO-ROUTINE (subquery-1)
     CO-ROUTINE (subquery-3)
     SCAN orders USING COVERING INDEX idx_orders_cust_amt
     USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY
     SCAN (subquery-3)
     SCAN (subquery-1)
```

## 八、递归 CTE 的骨架：只有两个分支，锚点决定列

```text
  Q> with recursive t(a,b) as (select 1, 'x' union all select a+1, b||'y' from t where a<3)
       select a, b, length(b) from t
     1 | x   | 1
     2 | xy  | 2
     3 | xyy | 3
```

列名/列数由**锚点分支**（或 CTE 后面的 `(a,b)` 别名表）决定；递归分支只是"再跑一遍"，SQLite 按 rowid 顺序物化递归结果，所以**能引用 `t` 自身**。不加别名表也行，列名取锚点的：

```text
  Q> with recursive t as (select 1 v union all select v+1 from t where v<3) select v, typeof(v) from t
     1 | integer    2 | integer    3 | integer
```

`UNION`（去重）在递归 CTE 里合法，但结果和 `UNION ALL` 完全不同——**别把两种混着用**：

```text
  Q> with recursive t(v) as (select 1 union select 2 union all select v+1 from t where v<3) select v from t
     1  2  2  3  3
```

**树形查询的标准写法**（带深度和物化路径），`node` 表 15 行，故意埋了孤儿和环：

```text
     id | name | parent_id
     1  | ROOT    | NULL      9  | cyc-a  | 10      <- 环
     2  | a       | 1         10 | cyc-b  | 9       <- 环
     3  | a-1     | 2         11 | d1     | NULL    <- 另一个根
     4  | a-2     | 2         12 | d2     | 11
     5  | a-1-1   | 3         13 | d3     | 12
     6  | a-1-2   | 3         14 | d4     | 13
     7  | a-2-1   | 4         15 | d5     | 14
     8  | orphan  | 999       <- 父不存在
```

```text
  Q> with recursive t(id,name,lvl,path) as (
       select id,name,1,name from node where name='ROOT'
       union all
       select n.id, n.name, t.lvl+1, t.path||'/'||n.name from node n join t on n.parent_id=t.id)
     select lvl, id, name, path from t order by lvl, id
     lvl | id | name    | path
     1   | 1  | ROOT    | ROOT
     2   | 2  | a       | ROOT/a
     3   | 3  | a-1     | ROOT/a/a-1
     3   | 4  | a-2     | ROOT/a/a-2
     4   | 5  | a-1-1   | ROOT/a/a-1/a-1-1
     4   | 6  | a-1-2   | ROOT/a/a-1/a-1-2
     4   | 7  | a-2-1   | ROOT/a/a-2/a-2-1
```

路径就是用 `||` 一路拼出来的，**没有 `SYS_CONNECT_BY_PATH`，也没有 `CONNECT BY`**（Oracle 语法，本机无对应实现，`connect by` 会被当成列名报错——此处未逐条复测）。

**不写 `ORDER BY` 时的真实产出顺序是广度优先（一层一层），不是深度优先**：

```text
  Q> with recursive t(id,name,lvl) as (select id,name,1 from node where parent_id is null
       union all select n.id,n.name,t.lvl+1 from node n join t on n.parent_id=t.id)
       select id, name, lvl from t
     1 | ROOT | 1
     11 | d1 | 1
     2 | a | 2
     12 | d2 | 2
     3 | a-1 | 3
     4 | a-2 | 3
     13 | d3 | 3
     5 | a-1-1 | 4
     6 | a-1-2 | 4
     7 | a-2-1 | 4
     14 | d4 | 4
     15 | d5 | 5
```

`lvl` 序列是 1,1,2,2,3,3,3,4,4,4,4,5——**整层整层地排开，绝不会先钻到某一条链的底再回头**，这就是广度优先；两个根一起走完 12 个可达节点。**想按"某条链"输出就必须自己 `ORDER BY path` 或带 `lvl` 排；不要指望递归顺序就是 DFS。**

反向（从叶子往上找全部祖先，`up` 表每一行是自己的一跳）：

```text
  Q> with recursive up(id,name,ancestor,lvl) as (select id,name,parent_id,0 from node
       union all select u.id, n.name, n.parent_id, u.lvl+1 from up u join node n on n.id=u.ancestor
       where u.lvl<10)
       select id, group_concat(name,' < ') chain from up where id in (5,14) group by id
     5  | a-1-1 < a-1 < a < ROOT
     14 | d4 < d3 < d2 < d1
```

## 九、递归 CTE 会挂死：环、截断、可达性

`node` 里 `cyc-a(9) → cyc-b(10) → cyc-a` 是一个二元环。**同一条递归 SQL，加不加截断条件，是"能返回"和"永不返回"的差别。**

带 `lvl` 上限（能返回，但环只是被**截断**，不是被**识别**）：

```text
  Q> with recursive t(id,name,lvl) as (select id,name,1 from node where name='cyc-a'
       union all select n.id,n.name,t.lvl+1 from node n join t on n.parent_id=t.id where t.lvl<6)
     lvl | id | name
     1 | 9  | cyc-a
     2 | 10 | cyc-b
     3 | 9  | cyc-a
     4 | 10 | cyc-b
     5 | 9  | cyc-a
     6 | 10 | cyc-b
```

同样这条用在第八节的祖先链上，环节点 9/10 的结果是 `hops=11 deepest=10`（其它正常节点 hops 1–5）：**它只是被上限拦停，数据里那个环根本没被发现。**

真正识别环要靠"路径里已见过的 id"（SQLite 没有 `CYCLE ... SET` 子句——那是 Oracle / PostgreSQL 14+ 的语法，本机未测其原文），手工版用 `instr` 查 `seen` 串：

```text
  Q> with recursive t(id,name,lvl,seen) as (
       select id,name,1,','||id||',' from node where name='cyc-a'
       union all
       select n.id,n.name,t.lvl+1, t.seen||n.id||',' from node n join t on n.parent_id=t.id
       where instr(t.seen, ','||n.id||',')=0)
     select count(*) guarded, min(lvl), max(lvl) from t
     guarded | min(lvl) | max(lvl)
     2 | 1 | 2
```

**正常终止，只产出 2 行。** 代价是多带一个 `seen` 字符串列，每跳一次拼接一次并做一次 `instr`——树很深时这一列本身就是 O(深度²) 的字符串，权衡见本节末尾的传递闭包写法。

```text
  Q> with recursive t(id,name) as (select id,name from node where name='cyc-a'
       union all select n.id,n.name from node n join t on n.parent_id=t.id) select count(*) from t
     —— 外层 timeout 40 s 到点杀掉，进程未返回，SQLite 没有报任何错
```

同一个杀手还有一个更隐蔽的形态——**递归本身没有上界**：

```text
  Q> with recursive t(v) as (select 1 union all select v+1 from t) select count(*) from t
     —— 同样跑满 40 s 被 timeout 杀掉
```

但它带 `LIMIT` 就立刻能返回：

```text
  Q> with recursive t(v) as (select 1 union all select v+1 from t) select v from t limit 5
     1  2  3  4  5
```

**递归 CTE 是协程（第七节计划里那句 `CO-ROUTINE` 不是装饰）：它按需一行产出，`LIMIT` 能提前把源头掐掉。** 所以"防挂死"不能靠 `LIMIT`——`select count(*) from 无上界递归` 里没有能提前停的东西。工程上必须有的是：**递归分支的 `WHERE` 里写死深度或写死 `seen` 检查**，二者至少有一个。

数据质量审计三件套（一次跑完，实测数字）：

```text
  孤儿（父不存在）：  id=8 orphan parent_id=999
  可达性：            all_nodes | reachable | unreachable = 15 | 12 | 3
  传递闭包（带 lvl<10 护栏）：
     root | subtree        10 | 11   9 | 11   1 | 7   2 | 6   11 | 5   12 | 4
     deepest | rows_ = 10 | 59
```

`unreachable = 3` 正好是 orphan + 环上两个节点（它们没有根，所以永远走不到）。环上 `subtree=11` 而不是"无限"，也是护栏的产物——**传闭包在有环的数据上是错的，必须先清环**。

## 十、递归 CTE 当序列生成器 / 日历表

本机 `generate_series` 缺席（第一节），替代方案实测：

```text
  Q> with recursive seq(n) as (select 1 union all select n+1 from seq where n<100000)
       select count(*) n, sum(n) s from seq
     100000 | 5000050000
  递归 10 万行 耗时 14.2 ms ok=1
```

`5000050000` = 100000×100001/2，逐行核对通过。**单次样本 14.2 ms，没有取中位**（这条不是本文要下的结论，只是"能不能用"）。同一形态跑 100 万行：

```text
  Q> with recursive seq(n) as (select 1 union all select n+1 from seq where n<1000000) select count(*) from seq
     返回耗时 160.7 ms ok=1 首值=1000000
```

**100 万行 160.7 ms（单次样本）**——比"建一张 100 万行的临时表"便宜得多，所以日历表/序号直接现算即可。造日历 + `LEFT JOIN` 补零（把没有订单的日期补成 0，报表必备）：

```text
  with recursive days(d) as (select 0 union all select d+1 from days where d<29)  -> n_days | mn | mx = 30 | 0 | 29
  接 orders 补零：daynum | n   -> 0 | 1000   1 | 1000   2 | 1000   3 | 1000   4 | 1000
```

（第一版我写成 `20000+daynum` 去匹配 `ts/86400`，结果全是 0 —— 日期纪元算错了，`1735689600/86400 = 20089` 才对。**这个坑是实测出来的，不是我推的：`n` 全 0 的那次输出留在 `p8_3.txt` 上一版里。**）

CTE 被引用两次时 SQLite 才真的物化，一次就内联（这条对性能直觉有直接纠正作用）：

```text
  EQP> with c as (select id, customer_id, amount from orders) select count(*) from c a join c b on a.id=b.customer_id
     SCAN orders
     SEARCH orders USING INTEGER PRIMARY KEY (rowid=?)          <- 没有 MATERIALIZE，内联成两次扫描
  Q> ... 同上 ... count(*) = 100000

  EQP> with c as (select customer_id, sum(amount) s from orders group by customer_id) select count(*) from c a, c b
     MATERIALIZE c                                             <- 这次物化了
     SCAN orders
     USE TEMP B-TREE FOR GROUP BY
     SCAN a
     SCAN b
  Q> ... 同上 ... count(*) = 1000000
```

`MATERIALIZE` 出现的条件是 **CTE 带聚合/LIMIT 这类"必须落地"的算子**，而不是"被引用两次"。含 `LIMIT 100` 的纯投影 CTE 也被物化（`MATERIALIZE c / SCAN orders / SCAN a / SCAN b`），因为 LIMIT 是阻断下推的算子。**加不加 `AS MATERIALIZED` 提示，SQLite 3.50.4 对聚合 CTE 的选择一样**（不加也 MATERIALIZE）；`AS NOT MATERIALIZED` 语法被接受。

谓词能不能推下 CTE 也顺手验了：`with c as (select ... group by customer_id) select count(*) from c where s>5000` → **570**（和外层直接 `HAVING sum(amount)>5000` 一致）；`select (select count(*) from c where s>5000) x, (select count(*) from c where s<100) y` → `570 | 0`。

CTE 上的 DML：读侧可以，写侧不行——原文：

```text
  Q> with c as (select id from node where id<3) delete from node where id in (select id from c)
     OK（CTE 只作读侧，删除生效）
  Q> with c as (select id from node where id<3) update c set name='x'
   FAIL> no such table: c Unable to execute statement
  Q> with t(v) as (select 1 union all select 2) insert into node values(100,'cte-insert',null)
     OK（同样只有读侧）
```

**`WITH` 能挂在 `INSERT`/`UPDATE`/`DELETE` 前面，但改的必须是真表**，CTE 本身不可写（上一篇《查询》第十节讲视图时同理，且这里的报错形式还不一样：视图是 `cannot modify ... because it is a view`，CTE 是 `no such table: c`）。

## 十一、用 SQL 替代应用层循环：三个任务，三种结局

任务口径：`customers` 1000 行 / `orders` 100000 行，**无二级索引**（这是前提，结论 2 的倍数严重依赖它）。程序独立重跑 3 次。

**任务 1：给"总消费 > 5000"的客户打 `flag='big'`**（命中 570 个）

```text
run1  循环（1 条 GROUP BY + 570 次 UPDATE）149.6 ms   单条 UPDATE...IN(子查询) 109.0 ms   比值 1.37
run2  循环 45.0 ms                                    单条 41.2 ms                        比值 1.09
run3  循环 50.2 ms                                    单条 77.7 ms                        比值 0.65
```

**中位比值 1.09，区间 0.65–1.37 —— 打平，方向都不稳定。** 两边都要先跑同一条 `GROUP BY`（43 ms 那趟），570 次 prepared UPDATE 在单事务里只花几毫秒。**"集合写法一定快过循环"是错的：循环快的前提是它只循环"聚合之后"的 570 行，而不是 10 万行。**

**任务 2：对 1000 个客户各查一次聚合（真 N+1）**

```text
run1  循环 1000 次点查(prepare) 16388.8 ms   单条 GROUP BY 64.1 ms
run2  循环 11282.4 ms                         单条 GROUP BY 66.3 ms
run3  循环  8571.5 ms                         单条 GROUP BY 98.0 ms
```

中位 **11282.4 ms vs 66.3 ms**，逐次比值 255.7 / 170.2 / 87.5 → **中位 170 倍，区间 87.5–255.7**。原因写在计划里：`SCAN orders / USE TEMP B-TREE FOR GROUP BY` 是**一趟扫 10 万行**，而循环版本是 **1000 × 10 万 = 1 亿行**扫描（无索引，每次都全表）。

**这个 170 倍里有"没建索引"这一半**：如果 `customer_id` 上有索引，点查从全表扫描变成 B 树查找，循环版本会快一到两个数量级，比值会明显收窄（**本节的有索引版本未实测**，只给出这一句作为方向性说明，不给数字）。但即便如此，`一条 GROUP BY` 依然是正确写法——因为它把往返次数从 N 压到 1，这跟索引无关。

**任务 3：给每笔订单按同客户金额排名，Top3 写 `tier='gold'`**（gold 必须 3000 行）

| 写法 | run1 | run2 | run3 | 中位（区间） | gold 行数 |
| --- | --- | --- | --- | --- | --- |
| 应用层游标逐行 UPDATE（10 万次） | 1204.1 ms | 908.8 ms | 1624.2 ms | **1204.1 ms**（908.8–1624.2） | 3000 |
| `UPDATE ... FROM (窗口子查询)` | 551.8 ms | 729.2 ms | 541.7 ms | **551.8 ms**（541.7–729.2） | 3000 |
| 窗口函数直接进 `SET` | — | — | — | **未产生数字** | — |

比值逐次 2.18 / 1.25 / 3.00 → **中位 2.18 倍**。可用的那条 SQL：

```sql
update orders set tier = case when r.rn <= 3 then 'gold' else 'std' end
from (select id, row_number() over (partition by customer_id order by amount desc, id) rn
      from orders) r
where r.id = orders.id;
```

`UPDATE ... FROM` 是 SQLite 3.33.0 引入的语法，本机 3.50.4 直接认。而把窗口函数塞进 `SET` 表达式里，原文是：

```text
  Q> update orders set tier = case when row_number() over (...) <= 3 then 'gold' else 'std' end
   FAIL> misuse of window function row_number() Unable to execute statement
```

**同一个错误在 `WHERE` / `DELETE` 里也一样**：

```text
  Q> select id from orders where row_number() over (order by id) <= 3
   FAIL> misuse of window function row_number() Unable to execute statement
  Q> delete from orders where row_number() over (order by id) > 999999
   FAIL> misuse of window function row_number() Unable to execute statement
```

**窗口函数只能出现在 `SELECT` 的投影列表和 `ORDER BY` 里**，任何过滤都得靠"外面再套一层"：

```text
  Q> with r as (select id, row_number() over (order by amount desc) rn from orders)
       select id, rn from r where rn<=3
     3729 | 1    13042 | 2    17764 | 3
```

对照第二节的教训：这里的并列值是 100.99（`order by amount desc limit 3` 给的三行金额**都是 100.99**），`row_number` 靠 `id` 之外的隐式物理顺序把它们分开了 —— **不带唯一列的排序键，Top-3 的名字会随计划变。这就是第六节里 `rank3=3008` 比 `rn3=3000` 多 8 行的同一件事。**

## 十二、其它引擎：本节未在本机实测

以下每一条在 SQLite 上的行为本文已实测，但**跨引擎结论没有一条在本机验证过**（本机无 MySQL / MariaDB / PostgreSQL 实例），必须在有实例的环境逐条复核：

- **窗口函数可用性**：MySQL 8.0 起才支持 `ROW_NUMBER()` 等，5.7 完全不支持（常见绕法就是本文第六节那种自连接/相关子查询）；PostgreSQL 从 8.4 起支持。**具体版本号与报错原文未在本机实测。**
- **默认帧**：`RANGE UNBOUNDED PRECEDING` 这个默认值是三标准/PG/MySQL 一致的，但 **MySQL 对 `GROUPS` 帧和 `EXCLUDE` 子句的支持情况未在本机实测**；本文第四节那 99900 行的差异数字**只对 SQLite 成立**。
- **`UPDATE ... FROM`**：SQLite 3.33+ / PostgreSQL 用 `UPDATE ... FROM`，**MySQL 的更新连接写法是 `UPDATE a JOIN b ON ... SET ...`**，两种语法不通用——**未在本机实测**。
- **窗口函数不能进 `WHERE`**：本文的 `misuse of window function row_number()` 是 SQLite 原文；MySQL/PostgreSQL 的错误码与措辞不同（PG 是 `Windows functions are not allowed in WHERE` 一类）——**未在本机实测**。
- **`WITH RECURSIVE`**：三家的关键字都要求写 `RECURSIVE`（SQLite 不写会当成普通 CTE 并报错），但**深度限制、`CYCLE ... SET` 子句（PostgreSQL 14+/Oracle）、MySQL 的 `cte_max_recursion_depth` 默认 1000** 这类护栏参数**全部未在本机实测**。本文第九节"环会挂死、要自己加 `lvl` 上限"的结论在 SQLite 上是实测的；在有默认深度上限的引擎上，同一条 SQL 会变成"到深度就报错"，**这是两种不同的故障表现，必须各测一次**。
- **`generate_series`**：PostgreSQL 是内建表值函数，SQLite 本机没有（`no such table`）——**MySQL 侧无对应物，未实测。**
- **`NULLS LAST` / `ORDER BY v IS NULL, v`**：SQLite 本机不支持 `NULLS LAST` 关键字（本文未逐条复测原文），第二节用的 `IS NULL` 前置排序技巧是标准做法但在 MySQL 上更常见的写法是 `ISNULL(v)`——**未在本机实测。**
- **`CTE 物化时机`**：PostgreSQL 12+ 才有 `MATERIALIZED / NOT MATERIALIZED` 提示，之前的 CTE 总物化；MySQL 8.0 的 CTE 合并/物化策略与本文第十节完全不同——**必须实测，不能照搬。**

## 十三、小结

- **`row_number` / `rank` / `dense_rank` 的区别只在并列**：10 万行实测"每组前 3"给 **3000 / 3008 / 3000**，`JOIN max` 只给 **1006**。排序键**必须以唯一列收尾**（`order by amount desc, id`），否则并列行的先后不保证。
- **`NULL` 在 `ORDER BY` 里最小、在 `>` 比较里谁都不大于**：第六节那个把 NULL 塞进 Top-2 的自连接写法就是这么坏的；NULL 排末位要自己写 `IS NULL` 前置键。
- **默认帧是 `RANGE`，不是 `ROWS`**——同一时间戳的并列行会一起进入累计，实测 10 万行里 **99900 行**的累计和两种帧算出的值不同；把 `, id` 加进排序键后差异归零。**写累计列请显式 `ROWS UNBOUNDED PRECEDING`。**
- **`last_value` 默认帧右端是当前行**，所以它等于"本行自己"，取真末值必须写全帧。`lag` 首行是 NULL 不是 0（要 0 用第三参），差分报表第一行必空。
- **窗口函数的代价 = 一次临时 B 树排序**：10 万行上纯 `GROUP BY` 43 ms、加分区窗口 102–106 ms（2.3×）。索引按 `(分区列, 排序列…)` 建能砍到 67 ms，**建错列（`amount` 换成不含 `ts` 的组合）会让分区累计和慢 2.6 倍**。比值全部由"还剩多少 temp B-tree、要不要回表"决定。
- **递归 CTE 只有两个分支，产出顺序是广度优先，实现是协程**：`LIMIT` 能掐断无上界的递归，`count(*)` 不能——不加 `WHERE lvl<N` 或 `seen` 检查的环**跑满 40 s 未返回且零报错**。`lvl` 上限只是"截断"（环节点 hops=11 与正常节点 hops≤5 摆在一起看），`instr(seen,...)` 才是"识别"（正确终止于 2 行）。
- **`generate_series` 在本机不存在**（`no such table`），序列/日历一律递归 CTE：10 万行 14.2 ms、100 万行 160.7 ms（单次样本）。
- **`MATERIALIZE` 的触发条件是算子不是引用次数**：投影 CTE 引用两次仍内联，含聚合/LIMIT 的 CTE 自动物化；CTE 只能挂在 DML 的读侧，写 CTE 报 `no such table: c`，写视图报 `cannot modify ... because it is a view`。
- **替代应用层循环的收益要分情况**：循环只跑"聚合后 570 行"时与单条 SQL **打平（比值中位 1.09，区间 0.65–1.37）**；循环跑 1000 次无索引点查时是一条 `GROUP BY` 的 **170 倍**（区间 87.5–255.7）；循环做 10 万次 UPDATE 时是 `UPDATE...FROM`+窗口的 **2.18 倍**（区间 1.25–3.00）。**窗口函数进 `SET`/`WHERE` 一律报 `misuse of window function row_number()`**，必须外面再套一层子查询或 CTE。

地图上的第三节《数据定义与变更》回到 `ALTER TABLE` 与迁移，第五节《索引原理与失效场景》会把本文第七节"索引让分区累计和慢 2.6 倍"那两例展开成完整的索引设计规则；本节先把"读"和"算"这两件事的工具箱补齐。
