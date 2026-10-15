---
title: 查询：JOIN、子查询与聚合——四种 JOIN 的行数、NULL 把 NOT IN 变成空集、同一语义 13 种写法的实测
description: 实测：`dept_id <> 10` 少掉 1 行 NULL；子查询里一个 NULL 让 `NOT IN` 从 7 行变 0 行；`count(*)=7` 而 `count(dept_id)=6`，`avg` 的分母是 6 不是 7；LEFT JOIN 条件写在 ON 里 1364 行、写在 WHERE 里 1008 行；10 万行上同一语义的 5 种写法差 3.8 倍（IN 10.3 ms vs 标量相关子查询 39.6 ms）；给 orders 加两个索引后，一条 LEFT JOIN 从 9.7 ms 变成 57.8 ms（慢 6.0 倍），补一个覆盖索引才翻回 3.3 ms；`OFFSET 50000` 52.8 ms vs 键集分页 0.113 ms。
date: 2026-10-16
tags: [数据库, SQL, SQLite, Qt SQL, JOIN, 子查询, 聚合函数, "NULL"]
category: database
section: db-query
---

> 环境同第一节：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ `Qt6::Sql`，插件 `plugins/sqldrivers/qsqlite.dll`，GCC 13.1.0 编译，无头运行，**SQL 引擎是 Qt 内嵌的 SQLite 3.50.4**。本文所有原文输出都是 `QSqlQuery` 打真库拿到的，探针源码 `p3_query.cpp`、四次独立运行的 stdout 都留存在本机。本机没有 MySQL / MariaDB / PostgreSQL 服务，涉及它们的表述集中在第十二节，**未在本机实测**。
>
> 计时口径：每条 SQL 在进程内连续跑 3 次取最好/最差，整个探针程序**独立重跑 4 次**；正文给的是这 4 个 best 值的**中位数 + 区间**。同机同期还有其它 agent 在抢 CPU，绝对值不可信，**比值比绝对值可靠**。语义类结果（行数、报错原文、`EXPLAIN QUERY PLAN`）四次运行逐字节一致，已在本文复核。

## 一、两张玩具表 + 一张 10 万行真表

后文所有行数都能手算，所以先把数据集钉死。

```text
dept(id, dname, mgr_id)              emp(id, name, dept_id, salary, boss_id)
10 | Eng   | 1                        1 | Ann | 10   | 5000 | NULL
20 | Sales | 4                        2 | Bo  | 10   | 4200 | 1
30 | Empty | NULL                     3 | Cy  | 10   | 3800 | 1
                                       4 | Di  | 20   | 6000 | NULL
ord(id, emp_id, amount)               5 | Ed  | 20   | NULL | 4
1 | 1 | 100                            6 | Fay | 90   | 3000 | 4
2 | 1 | 200                            7 | Gil | NULL | 2500 | 4
3 | 2 | 100
4 | 4 | 900                            dept 3 行 / emp 7 行 / ord 6 行
5 | 4 | 900
6 | 99 | 77   <- emp_id=99 不存在
```

三处故意埋的脏：`dept` 有一行没有任何员工（`Empty`）、`emp` 有一行指向不存在的部门 90 和一行 `dept_id IS NULL`、`ord` 有一行指向不存在的员工 99。后面每一种 JOIN 的行数都由这几行决定。

10 万行那张表沿用第一节的模型：`customers(id, name, city)` 1000 行 + `orders(id, customer_id, amount)` 100000 行，建库后 **2031616 字节（无二级索引）**。

## 二、四种 JOIN 的实测行数：一行都不许靠记

```text
  Q> select count(*) inner_join from emp e join dept d on d.id=e.dept_id
     inner_join
     5
  Q> select count(*) left_join from emp e left join dept d on d.id=e.dept_id
     left_join
     7
  Q> select count(*) right_join from emp e right join dept d on d.id=e.dept_id
     right_join
     6
  Q> select count(*) full_join from emp e full join dept d on d.id=e.dept_id
     full_join
     8
  Q> select count(*) cross_join from emp e cross join dept d
     cross_join
     21
  Q> select count(*) natural_join from emp e natural join dept d
     natural_join
     0
  Q> select count(*) join_on_true from emp e join dept d on 1=1
     join_on_true
     21
  Q> select count(*) natural_join_shared_id from dept d natural join ord o
     natural_join_shared_id
     0
```

对着数据集数一遍，语义就清楚了：

| 写法 | 行数 | 怎么来的 |
| --- | --- | --- |
| `INNER JOIN` | 5 | 匹配上的 5 个员工（Ann/Bo/Cy/Di/Ed），Fay(90) 和 Gil(NULL) 掉出去 |
| `LEFT JOIN` | 7 | 左表全保留 = emp 的 7 行，一条不少 |
| `RIGHT JOIN` | 6 | 右表全保留 = dept 3 行；Eng 3 人 + Sales 2 人 + Empty 补 1 = 3+2+1 |
| `FULL JOIN` | 8 | 6 + 左表没匹配的 2 行（Fay、Gil） |
| `CROSS JOIN` | 21 | 7 × 3，笛卡尔积，不写条件就是这个数 |
| `NATURAL JOIN` | 0 | 按**同名列**自动连接 |

三条要在工程上记住的：

1. **`RIGHT JOIN`/`FULL JOIN` 在 SQLite 里是真的支持的**，不是 MySQL 专属。版本门槛是 SQLite 3.39.0（2022）；`QSQLITE` 内嵌的 3.50.4 直接认。写迁移脚本前先确认引擎版本，别默认"反正 LEFT JOIN 够用"。
2. **`NATURAL JOIN` 那 0 行是警告，不是结论。** `emp(e)` 和 `dept(d)` 的共同列是 `id`/`dept_id` 吗？不是——同名列只有 `id`，于是 SQLite 拿 `emp.id = dept.id` 去比：emp 的 id 是 1..7，dept 的 id 是 10/20/30，交集为空，**结果 0 行，且不报错**。第二条 `dept d natural join ord o` 同样是 0 行，共享列还是 `id`（10/20/30 vs 1..6）。**`NATURAL JOIN` 会静默挑中它认为的同名列**，表一改列名结果就翻转。生产代码里请写显式 `ON`/`USING`。
3. **`JOIN ... ON 1=1` = `CROSS JOIN`**（21 行），SQLite 不做"常量条件剪枝"。

`LEFT JOIN` 补出来的到底长什么样：

```text
  Q> select e.name, e.dept_id, d.dname from emp e left join dept d on d.id=e.dept_id order by e.id
     name | dept_id | dname
     Ann | 10 | Eng
     Bo | 10 | Eng
     Cy | 10 | Eng
     Di | 20 | Sales
     Ed | 20 | Sales
     Fay | 90 | NULL
     Gil | NULL | NULL
```

Fay 和 Gil 这两行的补出方式是**整行右侧列全部 NULL**，包括 `d.id`。所以"判断哪些员工没有部门"要写 `WHERE d.id IS NULL`，不能写 `WHERE d.dname IS NULL` 之后又指望区分"Fay 的部门不存在"和"Gil 的 dept_id 是 NULL"——它们在补 NULL 之后**长得一模一样**。

## 三、LEFT JOIN：条件写 `ON` 还是写 `WHERE`，行数不一样

这是本节最容易在线上炸的一条。1000 客户 × 10 万订单：

```text
B11 LEFT JOIN 条件放 ON      select count(*) from customers c left join orders o on c.id=o.customer_id and o.amount>100   标量=1364
B12 LEFT JOIN 条件放 WHERE   select count(*) from customers c left join orders o on c.id=o.customer_id where o.amount>100  标量=1008
B13 INNER JOIN 同条件        select count(*) from customers c join orders o on c.id=o.customer_id and o.amount>100        标量=1008
```

- 条件进 **`ON`**：先补 NULL 再算，1000 个客户全在结果里，`count(*)` = 1364。
- 条件进 **`WHERE`**：补出来的行 `o.amount` 是 NULL，`NULL > 100` 不为真，被过滤掉 → **`LEFT JOIN` 被降级成 `INNER JOIN`**，1008 行，和 B13 完全相等。

**"LEFT JOIN 写 WHERE 就退化成 INNER JOIN"** 不是口诀，是能数出来的：**1364 vs 1008**，差 356。同理，`WHERE o.id IS NOT NULL` 也是退化。要"保留左表全部 + 只统计满足条件的右表"，条件必须留在 `ON` 里。

## 四、NULL 与三值逻辑：`<>` 会少行，`NOT IN` 会归零

先看 `WHERE` 里最朴素的漏行（`emp` 7 行，`dept_id` 有一个 NULL）：

```text
  Q> select count(*) all_rows from emp              -> 7
  Q> select count(*) where_ne_10 from emp where dept_id <> 10     -> 3
  Q> select count(*) where_gt_0 from emp where dept_id > 0        -> 6
  Q> select count(*) where_is_null from emp where dept_id is null -> 1
  Q> select count(*) fixed from emp where dept_id <> 10 or dept_id is null  -> 4
  Q> select count(*) is_not from emp where dept_id is not 10      -> 4
```

`<> 10` 得 3，正确答案是 4（20、20、90 再加上那个 NULL）。**任何 `<>` / `>` / `LIKE` 都会把 NULL 行丢掉**，因为比较结果是 NULL 而不是真。三种修法实测都行：`OR dept_id IS NULL`、`IS NOT 10`（SQLite 的中缀 `IS NOT` 是**空安全**的）、或者第五节的 `COALESCE`。

NULL 参与运算的原样输出：

```text
  Q> select name, dept_id is null eq_is_null, dept_id = null eq_null, dept_id <> null ne_null,
            null = null null_eq_null, null <> null null_ne_null, null = 0 null_eq_zero
     from emp where id=7
     name | eq_is_null | eq_null | ne_null | null_eq_null | null_ne_null | null_eq_zero
     Gil | 1 | NULL | NULL | NULL | NULL | NULL
```

只有 `IS NULL` 返回 1，**所有 `= NULL` / `<> NULL` 都返回 NULL**。这一条在 10 万行表上同样成立：`select 1 from orders where amount > NULL` 返回**零行**（不是报错）。

### 最贵的一条：`NOT IN` + 子查询里的 NULL = 空集

`dept.mgr_id` 是 `1, 4, NULL`（`Empty` 部门没有经理）：

```text
  Q> select mgr_id from dept
     mgr_id
     1
     4
     NULL
  Q> select name from emp where dept_id not in (select mgr_id from dept)
     name
     （零行）
  Q> select count(*) not_in_answer from emp where dept_id not in (select mgr_id from dept)
     not_in_answer
     0
  Q> select count(*) not_in_fixed from emp e where not exists (select 1 from dept d where d.mgr_id = e.dept_id)
     not_in_fixed
     7
```

**正确答案是 7（没有任何部门的经理编号是 10/20/90），`NOT IN` 给出 0，`NOT EXISTS` 给出 7。** 机制：`x NOT IN (1,4,NULL)` 展开成 `x<>1 AND x<>4 AND x<>NULL`，最后一项永远是 NULL，整个 AND 链塌成 NULL，**没有任何一行能被判为真**。

这不是"性能问题"而是**正确性问题**：多一个 NULL，业务查询直接返回空列表，前端显示"暂无数据"，没有任何报错。落地建议两条：

- 反连接一律优先 `NOT EXISTS`（实测还更快，见第八节）；
- 如果必须用 `NOT IN`，子查询里加 `AND mgr_id IS NOT NULL`，或者给该列上 `NOT NULL` 约束（第一节讲过 SQLite 的约束是真 enforced 的）。

顺带一条同族的：`select count(*) scalar_from_empty from emp where salary > (select max(salary) from emp where 0)` → **0**。空集上的 `max()` 返回 NULL（第五节），于是 `salary > NULL` 全假。"子查询返回空"和"子查询返回 NULL"在 SQL 里是一回事。

## 五、聚合函数不是"一视同仁"：`count` / `sum` / `avg` / `total`

```text
  Q> select count(*) cnt, count(dept_id) cnt_dept, count(distinct dept_id) dist_dept,
            count(distinct salary) dist_sal, sum(salary) sum_sal, sum(distinct salary) sum_dist,
            total(salary) total_, avg(salary) avg_, max(salary) mx, min(salary) mn,
            group_concat(name) gcon
     from emp
     cnt | cnt_dept | dist_dept | dist_sal | sum_sal | sum_dist | total_ | avg_ | mx | mn | gcon
     7 | 6 | 3 | 6 | 24500 | 24500 | 24500 | 4083.3333333333335 | 6000 | 2500 | Ann,Bo,Cy,Di,Ed,Fay,Gil
```

四个数字里藏着四条规则：

- `count(*) = 7`，`count(dept_id) = 6`：**`count(表达式)` 数的是非 NULL 的个数**。
- `count(distinct dept_id) = 3`（10/20/90）——`dept_id` 的 6 个非 NULL 值里去重后只剩 3，那个 NULL **又不参与 DISTINCT** 了。
- `avg(salary) = 4083.3333333333335` = `24500 / 6`，**分母是 6 不是 7**。`Ed` 的工资是 NULL，它既不进分子也不进分母。想要"按人头算平均、缺工资按 0 计"，得自己写 `sum(coalesce(salary,0))/count(*)`。
- `count(distinct salary) = 6` 而 `sum_dist = 24500`：这 6 个非 NULL 工资刚好互不相等，所以 `sum(distinct)` 恰好等于 `sum`，**别把这条当成规律**（分组下的例子见下一节：部门 20 的 `count(distinct salary)` 是 1，而它有 2 行）。

空集上的聚合（`where 0`）：

```text
  Q> select count(*) cnt, sum(salary) s, avg(salary) a, max(salary) mx, min(salary) mn, total(salary) t
     from emp where 0
     cnt | s | a | mx | mn | t
     0 | NULL | NULL | NULL | NULL | 0
```

**只有 `count` 和 `total` 有身份，其它全 NULL**。所以"查一个不存在客户的消费总额"拿到的是 `NULL`，在 Qt 侧就是 `QVariant()` 无效值，`value().toDouble()` 静默变 0；而 `total()` 天生返回 0。要么 `COALESCE`，要么用 `total()`。

```text
  coal | ifn | raw
  0 | -1 | NULL
```

`coalesce` / `ifnull` / `nullif` 三件套在 `emp` 上的原文：

```text
  Q> select name, salary, salary > 3000 gt, coalesce(salary,-1) coal, ifnull(salary,-2) ifnull_,
            nullif(salary,5000) nullif_ from emp order by id
     Ann | 5000 | 1 | 5000 | 5000 | NULL
     Bo   | 4200 | 1 | 4200 | 4200 | 4200
     Ed   | NULL | NULL | -1 | -2 | NULL
     Fay  | 3000 | 0 | 3000 | 3000 | 3000
```

`nullif(5000,5000)` → NULL，这是把"0 除"和"哨兵值"变 NULL 的标准写法。

算术里的 NULL 也一并量了：

```text
  Q> select cast('abc' as integer) cast_int, typeof(cast('abc' as integer)) t,
            1/0 div0, typeof(1/0) t_div0, 5/2 int_div, 5.0/2 real_div, 7%3 mod_, 7%0 mod0,
            typeof(7%0) t_mod0
     cast_int | t | div0 | t_div0 | int_div | real_div | mod_ | mod0 | t_mod0
     0 | integer | NULL | null | 2 | 2.5 | 1 | NULL | null
```

**`1/0` 不报错，返回 NULL**；`7%0` 同样 NULL；`cast('abc' as integer)` 返回 **0 而不是 NULL**。这三条在别处是"抛异常"的地方，在 SQLite 里全都变成 NULL，然后顺着第四节的规则一路污染到 `WHERE` 和聚合。**除法必须先 `nullif(分母, 0)`。**

## 六、`GROUP BY` 与 `HAVING`：裸列取哪一行，`count(*)` 与 `count(col)` 差 1

```text
  Q> select dept_id, count(*) n, sum(salary) s from emp group by dept_id order by dept_id
     NULL | 1 | 2500
     10   | 3 | 13000
     20   | 2 | 6000
     90   | 1 | 3000
```

**`NULL` 自己成一组**（GROUP BY 里 NULL 是"彼此相等"的，和 DISTINCT 丢弃 NULL 恰好相反——同一种值在两个位置规则不同，见第七节的 `union`）。

`HAVING` 能直接引用 `SELECT` 里的别名，也能引用聚合；`GROUP BY` 能用序号：

```text
  having s > 5000        -> 10 | 3 | 13000 / 20 | 2 | 6000     （s 是 select 里的别名）
  group by 1 having count(*) > 1   -> 同上两行                  （group by 1 = 第一列）
```

**"裸列"（既不在 GROUP BY 里也不是聚合）在 SQLite 里不报错**，标准 SQL 会拒。它取的是该组里"某一行"的值：

```text
  Q> select dept_id, name, salary from emp group by dept_id
     NULL | Gil | 2500
     10   | Ann | 5000
     20   | Di  | 6000
     90   | Fay | 3000
```

同一条 SQL 在 MySQL（`ONLY_FULL_GROUP_BY` 默认开）里是 **报错**，在开了老模式时会给你一个不保证的行。**这是"在 SQLite 上跑得好好的，搬到 MySQL 直接 1055"的头号来源。** 想要"每组里工资最高的那个人的名字"，正确写法是窗口函数（第四节）或相关子查询，不是裸列。

`max()` 和裸列同时出现时，本例**碰巧**对上了（`10 | 5000 | Ann`）：

```text
  Q> select dept_id, max(salary) mx, name from emp group by dept_id order by dept_id
     NULL | 2500 | Gil    10 | 5000 | Ann    20 | 6000 | Di    90 | 3000 | Fay
```

SQLite 对"单个 `min`/`max` + 裸列"有专门的实现（取产生极值那一行的值），**但这是实现细节不是标准**，跨引擎不保证，别把它写进业务逻辑。

### `count(*)` 和 `count(右表列)` 在无子行时差 1

左连接 + 分组的必考题，实测：

```text
  Q> select d.dname, count(e.id) n_emp, count(*) n_star, sum(e.salary) payroll
     from dept d left join emp e on e.dept_id=d.id group by d.id, d.dname order by n_emp desc
     Eng   | 3 | 3 | 13000
     Sales | 2 | 2 | 6000
     Empty | 0 | 1 | NULL
```

`Empty` 部门：`count(e.id) = 0`（补出来的行里 `e.id` 是 NULL），`count(*) = 1`（确实有一行），`payroll = NULL`（不是 0）。**报表里"0 个员工"和"1 个员工工资未知"的区别就在这两个 count 上**；`payroll` 还要再包一层 `coalesce(...,0)` 才不会在导出 CSV 时变成空字段。

其它分组成员函数：

```text
  group_concat(name,'+')   -> NULL|Gil  10|Ann+Bo+Cy  20|Di+Ed  90|Fay
  count(distinct salary)   -> NULL|1    10|3          20|1      90|1
```

部门 20 有 2 行但 `count(distinct salary)` = 1 —— 因为 `Ed` 的工资是 NULL，**DISTINCT 又把它丢了**。这一格同时踩了第四、五节两条规则。

## 七、子查询：`IN` / `EXISTS` / 相关标量 / 行构造器，以及 `ANY` 不存在

```text
  where dept_id in (select id from dept where dname='Eng')      -> Ann Bo Cy
  where dept_id in (select id from dept where dname='NoSuch')   -> 零行（不报错）
  where exists (select 1 from ord o where o.emp_id=e.id)        -> Ann Bo Di
  where not exists (select 1 from dept d where d.id=e.dept_id)  -> Fay Gil
  select name, (select count(*) from ord o where o.emp_id=e.id) n_ord  -> Cy|0 Ed|0 Fay|0 Gil|0
```

标量相关子查询的空结果就是 **0 而不是 NULL**（因为 `count(*)` 有身份，第五节），这是"每个客户的订单数"能直接用 `LEFT JOIN + count` 替掉它的原因。

**行构造器 `IN` 在 SQLite 里可用**，而且顺带演示了一次 NULL 杀伤力：

```text
  Q> select name from emp where (dept_id, salary) in
            (select dept_id, max(salary) from emp group by dept_id)
     Ann
     Di
     Fay
```

分组结果里有 `(NULL, 2500)` 这一组（Gil），但 `NULL` 与任何值比较都不是真，**Gil 取不回来**；`Ed`（salary NULL）同理。想要"每组最大值对应的那一行"，请写 `ROW_NUMBER() = 1`（第四节）或 `WHERE NOT EXISTS (同组里存在更大的)`。

派生表（FROM 里的子查询）和普通 CTE：

```text
  Q> select dname, n_emp from (select d.id did, d.dname dname, count(e.id) n_emp
            from dept d left join emp e on e.dept_id=d.id group by d.id, d.dname) t
       where n_emp >= 2
     Eng | 3
     Sales | 2
  Q> with big as (select name, salary from emp where salary > 3500) select * from big order by salary desc
     Di | 6000   Ann | 5000   Bo | 4200   Cy | 3800
```

`ANY` / `SOME` 直接语法报错，原文照抄：

```text
  Q> select name from emp where id = any(select emp_id from ord)
   FAIL> near "select": syntax error Unable to execute statement
  Q> select name from emp where id some (select emp_id from ord)
   FAIL> near "some": syntax error Unable to execute statement
  Q> select name from emp where id in (select emp_id from ord)   -> Ann Bo Di
```

MySQL 的 `= ANY (SELECT ...)` 语法和 `SOME` 是同义词（**本机未实测**）；在 SQLite 上只有 `IN`。

相关标量子查询还能做"与本部门均值之差"：

```text
  Q> select name, salary, salary - (select avg(salary) from emp e2 where e2.dept_id=e.dept_id) delta
     Ann | 5000 | 666.666666666667      Bo | 4200 | -133.33333333333303
     Di   | 6000 | 0                    Ed | NULL | NULL      Gil | 2500 | NULL
```

`Gil` 的 `delta` 是 NULL：他的 `dept_id` 是 NULL，子查询里 `e2.dept_id = NULL` 一行都匹配不到，`avg(空集)` = NULL。同一件事在窗口函数里叫"分区"，写法不同、结果也不同（第四节会对照）。

`UNION` 系列的规则也一次性量了：

```text
  union(distinct) emp.id ∪ dept.id          -> 1,2,3,4,5,6,7,10,20,30（10 行，自动排序去重）
  union all 计数                             -> 10   （7+3，不去重）
  select dept_id from emp union select id from dept  -> 5
  intersect(emp.id ∩ ord.emp_id)             -> 3
  except(emp.id − ord.emp_id)                -> 4
  select id from emp union select id from dept except select emp_id from ord order by id
                                             -> 3,5,6,7,10,20,30（7 行）
```

`union_dist = 5` 的算法：`emp.dept_id` 去重 = {10,20,90}（NULL 被 DISTINCT 丢掉），`dept.id` = {10,20,30}，并集 {10,20,30,90} 是 4 个……为什么是 5？因为 **UNION 去重发生在合并之后的整行层面**，`emp.dept_id` 那一侧实际参与的是 7 行值 {10,10,10,20,20,90,NULL}，与 {10,20,30} 合并后 DISTINCT 结果是 {10,20,30,90} 加一个 **NULL**——`UNION`（非 ALL）在 SQLite 里把 NULL 当作一个可保留的值：**实测 5 = 4 + 1 个 NULL**。这条和第七节 `DISTINCT` 丢 NULL 的表现**不一致**，是本节里我唯一没能在标准里找到合理解释、只能用输出说话的地方：`count(distinct dept_id)=3` 不含 NULL，`... union ...` 含 NULL。要用 NULL 做并集计数请显式 `select count(*) from (... where x is not null)`。

最后一条：`ORDER BY` / `LIMIT` / `OFFSET` 属于**整个复合查询**，写在最后一个 `SELECT` 后面：

```text
  Q> select id, name from emp union all select dname, id from dept limit 3
     id | name
     1 | Ann
     2 | Bo
     3 | Cy
```

列名取第一支（`id | name`），`ORDER BY` 也只用这套名字；两支类型不一致（文本 `dname` 对整数 `id`）时 SQLite 不报错，按亲和性各自存着——迁移到有强类型的引擎里这条直接失败。

## 八、10 万行上，同一语义的 13 种写法差多少

`select count(*) ... city='Wuhan'` 有 5 种等价写法（B1–B5），反连接 3 种（B6–B8），其余 5 种是聚合/自连接/ON-WHERE 对照。四次独立运行的 best 中位数（区间 = 4 个 best 的最小–最大）：

| # | 写法 | 无索引 中位（区间） | 两个索引后 中位 | 与 B1 比 |
| --- | --- | --- | --- | --- |
| B1 | `JOIN` + `WHERE` 过滤 | **25.341 ms**（17.163–29.459） | 0.434 ms | 1.00× |
| B2 | 逗号旧式 `,` 连接 | 25.871 ms（17.807–37.840） | 0.370 ms | 1.02× |
| B3 | `IN` 子查询 | **10.318 ms**（5.681–12.545） | 0.392 ms | **0.41×** |
| B4 | `EXISTS` 相关子查询 | 36.271 ms（22.784–49.100） | 21.868 ms | 1.43× |
| B5 | 标量相关子查询 | **39.583 ms**（22.991–62.678） | 22.252 ms | **1.56×** |
| B6 | `LEFT JOIN ... WHERE o.id IS NULL` | **75.941 ms**（53.482–93.783） | 4.834 ms | 3.00× |
| B7 | `NOT IN` 反连接 | 29.554 ms（18.184–37.903） | 0.367 ms | 1.17× |
| B8 | `NOT EXISTS` 反连接 | 40.057 ms（25.818–46.126） | 0.549 ms | 1.58× |
| B9 | `GROUP BY`+`HAVING` 派生表 | 61.751 ms（33.424–64.857） | 56.818 ms | 2.44× |
| B10 | 自连接（同城市对） | 7.653 ms（4.557–9.064） | 5.840 ms | 0.30× |
| B11 | `LEFT JOIN` 条件在 `ON` | 9.653 ms（8.390–14.055） | **57.783 ms** | 0.38× → **2.28×** |
| B12 | `LEFT JOIN` 条件在 `WHERE` | 7.418 ms（4.837–10.143） | 5.046 ms | 0.29× |
| B13 | `INNER JOIN` 同条件 | 7.742 ms（4.694–8.774） | 8.301 ms | 0.31× |

结果值四次全一致：B1–B5 = **8009**，B6–B9 = **0**，B10 = **50105**，B11/12/13 = **1364/1008/1008**。

读法（**只读比值，别读绝对值**）：

1. **`IN` 子查询（B3）是无索引下最快的等价写法，只有 `JOIN`（B1）的 0.41 倍时间**。原因是 SQLite 把 `IN (SELECT ...)` 里的 `city='Wuhan'` 谓词下推到 `customers` 侧先扫 1000 行，再去 `orders` 走主键；而 `JOIN` 那支它选了"先扫 10 万行 orders"的计划。
2. **`EXISTS` / 标量相关子查询（B4/B5）比 B1 慢 1.4–1.6 倍**，而且**建了索引也只降到 21.9/22.3 ms，比 B1 的 0.43 ms 慢 50 倍**。原因在计划原文里：子查询是 `CORRELATED SCALAR SUBQUERY`，**10 万次逐行执行**，索引只是让每次执行变便宜，没有改变执行次数。
3. **B6（LEFT JOIN 反连接）是无索引下最慢的一条，75.9 ms，是 `NOT IN`（B7，29.6 ms）的 2.6 倍**。第四节的正确性结论加上这一条性能结论，反连接的推荐写法是 `NOT EXISTS`（B8 无索引 40.1 ms，有索引 0.549 ms）。**注意 B6 有索引后 4.83 ms 而 B7/B8 是 0.37/0.55 ms——`LEFT JOIN ... IS NULL` 在 SQLite 上没有自动变成 anti-join。**
4. **旧式逗号连接（B2）与显式 `JOIN`（B1）实测同速**（25.87 vs 25.34，落在彼此区间内）。所以"显式 JOIN 比逗号快"这句话**在本机不成立**，选 `JOIN` 是为了可读性和不写出笛卡尔积，不是为了性能。

计划原文（无索引）：

```text
  EQP> select count(*) from orders o join customers c on c.id=o.customer_id where c.city='Wuhan'
     SCAN o
     SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
  EQP> select count(*) from orders o where exists (select 1 from customers c where c.id=o.customer_id and c.city='Wuhan')
     SCAN o
     CORRELATED SCALAR SUBQUERY 1
     SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
  EQP> select count(*) from customers c left join orders o on c.id=o.customer_id where o.id is null
     SCAN c
     BLOOM FILTER ON o (customer_id=?)
     SEARCH o USING AUTOMATIC COVERING INDEX (customer_id=?) LEFT-JOIN
  EQP> select count(*) from customers a join customers b on a.city=b.city and a.id<b.id
     SCAN a
     SEARCH b USING AUTOMATIC COVERING INDEX (city=?)
```

`AUTOMATIC COVERING INDEX` 是 SQLite **临时自己建的索引**（本次查询用完就丢），`BLOOM FILTER` 是它加的布隆过滤。这两条说明：**没有索引时它并不傻**，只是把代价挪到了每次查询的建索引上。

## 九、负面结果：加索引让一条查询慢了 6.0 倍

`CREATE INDEX idx_orders_cust ON orders(customer_id)` + `CREATE INDEX idx_cust_city ON customers(city, name)`，库文件 2031616 → **3121152 字节（+1089536）**。B1 从 25.3 ms 掉到 **0.434 ms**（快 58 倍），B3 从 10.3 掉到 0.392 ms——但：

```text
B11 LEFT JOIN 条件放 ON    无索引 9.653 ms   两个索引后 57.783 ms    <- 慢 6.0 倍
  EQP> select count(*) from customers c left join orders o on c.id=o.customer_id and o.amount>100
     SCAN c
     SEARCH o USING INDEX idx_orders_cust (customer_id=?) LEFT-JOIN
```

`idx_orders_cust` 里只有 `customer_id`，谓词要的 `amount` **不在索引里**，于是每命中一个 rowid 都要回 `orders` 取页：1000 客户 × 平均 100 单 = **10 万次随机回表**。没有索引时 SQLite 反而建了自动覆盖索引（把 `amount` 一起抄进去了），顺序一趟就够。

再补一个真覆盖索引 `CREATE INDEX idx_orders_cust_amt ON orders(customer_id, amount)`（库 → **5087232 字节**）：

```text
  EQP> select count(*) from customers c left join orders o on c.id=o.customer_id and o.amount>100
     SCAN c
     SEARCH o USING COVERING INDEX idx_orders_cust_amt (customer_id=? AND amount>?) LEFT-JOIN
B11  57.783 ms -> 3.288 ms（2.327–3.645）      <- 比无索引的 9.653 ms 还快 2.9 倍
B9   56.818 ms -> 5.727 ms（4.500–6.463）      <- 10 倍
  EQP> select count(*) from (select customer_id, sum(amount) s from orders group by customer_id having s>100000) t
     CO-ROUTINE t
     SCAN orders USING COVERING INDEX idx_orders_cust_amt
     SCAN t
```

`B9` 那条更能说明问题：只加 `idx_orders_cust` 时它是 `SCAN orders USING INDEX idx_orders_cust`，**中位数从 61.75 ms 变成 56.82 ms——几乎没变**（4 个样本区间 41.84–68.13，与无索引的 33.42–64.86 大幅重叠，不构成结论）；换成覆盖索引才 5.73 ms。**"索引没用"和"索引方向对了"之间的差别，常常就是索引里少没少一列。**

同时，`B12/B13`（`amount` 条件在 WHERE / INNER JOIN）三个阶段的值是 7.42 → 5.05 → 7.23 和 7.74 → 8.30 → 9.05，**变化全在样本区间内，属于噪声**，我不会把这两条写成结论。

顺带看 `GROUP BY` 能不能白拿排序（这是索引的另一种回报）：

```text
  EQP> select customer_id, sum(amount) from orders group by customer_id order by customer_id limit 5
     SCAN orders USING COVERING INDEX idx_orders_cust_amt
  EQP> select city, count(*) from customers group by city
     SCAN customers USING COVERING INDEX idx_cust_city
```

**没有 `USE TEMP B-TREE FOR GROUP BY` 了**——索引本身就是有序的，分组和排序一起省掉。对比第八节前 `B9` 无索引时那句 `USE TEMP B-TREE FOR GROUP BY`，这就是"聚合列建索引"的全部原理。

## 十、视图不是物化的，深分页是线性的

```text
  Q> select type, name, tbl_name from sqlite_master order by type, name
     table | t_real | t_real
     view  | v_filt | v_filt
     view  | v_join | v_join
  Q> select sql from sqlite_master where name='v_filt'
     CREATE VIEW v_filt AS SELECT id, a FROM t_real WHERE b > 15
```

视图在目录里**只存一段 SQL 文本**，没有任何数据。所以三种写入全部失败，原文：

```text
  Q> update v_filt set a='W' where id=2       FAIL> cannot modify v_filt because it is a view Unable to execute statement
  Q> insert into v_filt values(99,'ins')      FAIL> cannot modify v_filt because it is a view Unable to execute statement
  Q> delete from v_filt where id=2            FAIL> cannot modify v_filt because it is a view Unable to execute statement
```

更值得注意的是**视图不校验定义里的表是否存在**：`v_join` 建的时候引用了当时不存在的 `emp`，`CREATE VIEW` 成功了，查它的时候才炸：

```text
  EQP> select * from v_join
     FAIL no such table: main.emp Unable to execute statement
```

改表结构不会让视图报错在修改那一刻——**报错推迟到查询那一刻**。迁移脚本必须把视图一起重建，别指望 `ALTER TABLE` 帮你维护它们。

`LIMIT n OFFSET m` 的代价（10 万行，`order by id` 与 `order by amount`，4 次运行中位数）：

| offset | 主键序 `order by id` | 无索引列 `order by amount` |
| --- | --- | --- |
| 0 | 0.113 ms（0.108–0.118） | 4.142 ms（3.755–4.557） |
| 1000 | 0.119 ms（0.113–0.178） | 8.116 ms（7.784–8.340） |
| 10000 | 0.169 ms（0.159–0.182） | 23.050 ms（22.528–23.638） |
| 50000 | 0.389 ms（0.367–0.404） | **52.770 ms**（52.406–56.991） |
| 99000 | 0.656 ms（0.627–0.694） | **72.230 ms**（70.049–82.620） |

```text
  EQP> select id, amount from orders order by amount limit 20 offset 50000
     SCAN orders
     USE TEMP B-TREE FOR ORDER BY
  EQP> select id, amount from orders order by id limit 20 offset 50000
     SCAN orders
```

两条曲线都是**线性**的：offset 从 0 → 99000，无索引列从 4.14 → 72.23 ms（17.4 倍），主键序从 0.113 → 0.656 ms（5.8 倍）。**`OFFSET` 不是"跳过"，是"读过并丢掉"**——第 99000 页之前的每一行都被物化过。

两种解法，实测：

```text
键集分页  where id > 50000 order by id limit 20   0.113 ms（0.107–0.135，4 次）
amount 建索引后 offset=50000                       0.393 ms（0.378–0.407）
  EQP> select id, amount from orders order by amount limit 20 offset 50000
     SCAN orders USING COVERING INDEX idx_amount
```

- **键集分页（seek method）比 `OFFSET 50000` 快 3.4 倍**（主键序情形），且**不随页码增长**，代价是只能上一页/下一页、不能跳页。
- 排序列建索引后 `OFFSET` 也能从 52.77 → 0.393 ms（**134 倍**），因为它把 `USE TEMP B-TREE FOR ORDER BY` 消掉了，只剩有序扫描。**深分页的第一根因往往不是 OFFSET，而是那个临时 B 树排序。**

## 十一、把本节变成规矩

- **写 JOIN 就写显式 `ON`**：`NATURAL JOIN` 会静默选中同名列（实测两个 0 行、不报错），`JOIN ... ON 1=1` 就是笛卡尔积（21 行），旧式逗号与 `JOIN` 实测同速，所以语法收益只在"不写错"。
- **`LEFT JOIN` 的过滤条件留在 `ON`**：`ON` 里 1364 行、`WHERE` 里 1008 行，写错就把外连接变成内连接，不报错。
- **`NULL` 不进比较**：`<> 10` 少一行、`> 0` 少一行、`IS NOT 10` 才对（4 行）；**`NOT IN` 的子查询里只要有一个 NULL，结果恒为空**（实测 7 → 0）。反连接用 `NOT EXISTS`（正确且有索引后 0.549 ms）。
- **聚合函数各有各的 NULL 规则**：`count(*)=7` / `count(col)=6`；`count(distinct)` 和 `sum` 丢 NULL；**`avg` 的分母是 6**；空集上只有 `count`→0 和 `total`→0，其余全 NULL；`1/0`、`7%0`、`cast('abc' as integer)` 分别给 NULL / NULL / **0**，一律不报错。
- **`GROUP BY` 的裸列在 SQLite 不报错、在 MySQL 报错**，`NULL` 自成一组但被 `DISTINCT` 丢弃，`HAVING` 可以引用 `SELECT` 别名。**"每组 Top-1"请用窗口函数，不要用 `max()` + 裸列。**
- **等价写法的实测差 3.8 倍**（10 万行无索引：`IN` 10.3 ms / `JOIN` 25.3 ms / `EXISTS` 36.3 ms / 标量子查询 39.6 ms / `LEFT JOIN` 反连接 75.9 ms），根因写在计划里：`CORRELATED SCALAR SUBQUERY` 是逐行执行，索引治不了次数。
- **索引可能让查询慢 6.0 倍**（B11：9.65 → 57.78 ms），因为缺的那一列导致 10 万次回表；把索引做成覆盖索引后同一条变 3.29 ms。**加索引前先 `EXPLAIN QUERY PLAN`，看有没有 `USING INDEX` 之后还要回表的 SEARCH。**
- **深分页用键集分页**（3.4 倍），或给排序列建索引（134 倍）；`OFFSET` 的代价是线性的，因为它真的在逐行丢弃。

## 十二、其它引擎的差异：本节未在本机实测

以下差异在文档/标准层面成立，**没有一条在本机验证过**（本机无 MySQL / MariaDB / PostgreSQL 实例），需要复核后才能写进跨库规范：

- **`RIGHT JOIN` / `FULL JOIN`**：MySQL 支持 `RIGHT JOIN` 但**不支持 `FULL OUTER JOIN`**（要用 `UNION` 两段 LEFT JOIN 拼）；PostgreSQL 两者都支持——**未在本机实测**。
- **`GROUP BY` 裸列**：MySQL 5.7+ 默认 `ONLY_FULL_GROUP_BY`，第六节那条 SQL 在 MySQL 上是 `ERROR 1055`；SQLite 的 `min/max + 裸列` 特殊行为在 MySQL 里没有对应实现——**未在本机实测**。
- **`HAVING` 引用 `SELECT` 别名**：MySQL 允许（且有额外的 `NULL`/表达式规则），**标准 SQL 与 PostgreSQL 不允许在 `HAVING` 里引用 `SELECT` 别名**（PostgreSQL 可写 `GROUP BY` 表达式或 CTE）——**未在本机实测**。
- **`UNION` 与 NULL**：第七节提到的"SQLite 的 `UNION` 保留一个 NULL、`DISTINCT` 丢 NULL"的不一致，在其它引擎上如何表现**未在本机实测**，请勿把本文那条当通用结论。
- **`IS NOT <值>` 的空安全比较**：SQLite 的中缀 `IS`/`IS NOT` 可对普通值使用，MySQL 只有 `IS NOT NULL` 形态，PostgreSQL 用 `IS DISTINCT FROM`——**未在本机实测**。
- **`ANY` / `SOME`**：MySQL/PostgreSQL 支持 `= ANY (subquery)`，SQLite 报 `near "select": syntax error`（这一条是本机实测的原文）——**其它两家的原文未实测**。
- **`AUTOMATIC COVERING INDEX` 与 `BLOOM FILTER`** 是 SQLite 优化器独有的行为，`EXPLAIN QUERY PLAN` 的整个格式都无法搬到 MySQL 的 `EXPLAIN` 或 PostgreSQL 的 `EXPLAIN (ANALYZE)`——**第八、九节那张表不能照搬，必须重跑**。
- **深分页**：MySQL InnoDB 的 `LIMIT m, n` 在大 offset 上同样是"读后丢弃"，键集分页同样有效，但具体倍数**必须在该引擎上实测**，未在本机验证。

## 十三、小结

JOIN 的行数是可以手算的（5/7/6/8/21/0），算不出来就说明你对语义的理解是听来的；`NULL` 的三值逻辑是唯一能让一个查询从 7 行变成 0 行且不报错的机制，所以 `NOT IN` + 子查询要当危险写法对待；聚合函数对 `NULL` 的处理**每个函数都不一样**，`count(*)`/`count(col)`/`avg` 分母/空集返回值这四格是报表数据出错的常客；写法之间没有"高级"只有代价，10 万行上实测 `IN` 比 `JOIN` 快 2.5 倍、比标量相关子查询快 3.8 倍，而索引能把快的一档再快 58 倍、同时把另一条慢 6.0 倍——**所以 `EXPLAIN QUERY PLAN` 应该是查询上线前的固定动作，而不是出事后才查**。

下一节（第三节《数据定义与变更》）离开查询，讲 `ALTER TABLE` 在 SQLite 上到底能做什么、为什么改一列要重建整张表，以及事务里混 DDL 的真实行为。
