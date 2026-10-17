---
title: 数据定义与变更：ALTER 的能力矩阵、在线变更的双向卡死与迁移前的四道校验
description: 实测：ADD COLUMN 4.3ms 不动文件、DROP COLUMN 重写全表；别人持锁时 ALTER 等 5 秒或立即失败；ROLLBACK 比 COMMIT 快 200 倍；四道校验抓出溜进来的孤儿数据。
date: 2026-10-16
tags: [数据库, SQL, SQLite, "ALTER TABLE", 数据迁移]
category: database
section: db-ddl-dml
---

> 环境同第 1、2 节：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ `Qt6::Sql`，插件 `plugins/sqldrivers/qsqlite.dll`，GCC 13.1.0（`D:/Qt/Tools/mingw1310_64`）编译，无头运行，**SQL 引擎是 Qt 内嵌的 SQLite 3.50.4**。本节三个探针都留存在本机：主探针 `p13_ddl.cpp`（类型/ALTER/事务/迁移，**独立重跑 4 次**，n=4 取中位数）、第二探针 `p14_ddl2.cpp`（字节账/并发 ALTER/user_version，**重跑 3 次**）、表达式真值表探针 `p15_cast.cpp`（重跑 2 次，两次 stdout 逐字节一致，用 `diff` 复核过）。
>
> 计时口径：每条操作进程内取单次计时，正文给多次独立运行的**中位数 + 区间**。同机同期还有其它 agent 在抢 CPU，绝对值偏大且抖动，**比值比绝对值可靠**。语义类证据（报错原文、`EXPLAIN QUERY PLAN`、字节数、行数、typeof）各次运行逐字节一致。本机没有 MySQL / MariaDB / PostgreSQL 实例，涉及它们的表述集中在第九节，**未在本机实测**。

## 一、`ALTER TABLE` 的能级矩阵：能做什么、拒绝什么、报错长什么样

基座是一张 20000 行、带 CHECK/UNIQUE/索引/视图/外键引用的表（`base.sqlite` 954368 字节）：

```text
CREATE TABLE base(id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c REAL,
                  CONSTRAINT ck CHECK(c > 0), UNIQUE(a))
CREATE TABLE child(pid INTEGER REFERENCES base(id), x TEXT)
CREATE INDEX ix_b ON base(b)          CREATE VIEW vw AS SELECT id, a, b FROM base WHERE c > 1
```

**四类被支持的变更里，两类是"纯元数据"，一类看运气：**

```text
OK ALTER TABLE base RENAME COLUMN b TO bb       中位 5.229 ms [4.123–5.989]
   -- 目录里的引用被自动重写，索引照用：
   CREATE INDEX ix_b ON base(bb)                <- 索引定义跟着改
   CREATE VIEW vw AS SELECT id, a, bb FROM base WHERE c > 1
   EQP> select count(*) from base where bb='t1'
        SEARCH base USING COVERING INDEX ix_b (bb=?)     <- 改名没有把索引改废
OK ALTER TABLE base ADD COLUMN flag TEXT DEFAULT 'x'     中位 4.349 ms [3.863–5.343]
   ADD COLUMN 之后：库字节=954368 页数=233 freelist=0     <- 与改之前逐字节相同
```

`ADD COLUMN` 带常量默认值**根本不碰数据行**：20000 行读回 `typeof(flag)=text`、值全是 `'x'`，但文件字节数纹丝不动——默认值存在 schema 里，读取时现算。代价被推迟到"第一次真正写它"的时候：

```text
CREATE INDEX ix_flag ON base(flag)   中位 8.452 ms [8.078–8.878]   库字节→1138688
UPDATE base SET flag='y'（全表 20000 行）  中位 29.569 ms [26.846–44.248]   库字节→1245184
```

**被拒绝的写法，`QSqlError::text()` 原文**（前半句是 SQLite 的消息，`Unable to …` 是 Qt 拖的尾巴）：

```text
FAIL ALTER TABLE base ADD COLUMN nn INTEGER NOT NULL      0.220 ms
     Cannot add a NOT NULL column with default value NULL     <- 与第 1 节约束表里那条同源
FAIL ALTER TABLE base ADD COLUMN uq TEXT UNIQUE           0.020 ms
     Cannot add a UNIQUE column
FAIL ALTER TABLE base ADD COLUMN pk INTEGER PRIMARY KEY   0.005 ms
     Cannot add a PRIMARY KEY column
FAIL ALTER TABLE base ADD COLUMN e TEXT DEFAULT (strftime('%s','now'))   0.182 ms
     Cannot add a column with non-constant default
FAIL ALTER TABLE t ADD COLUMN a TEXT                      0.013 ms
     duplicate column name: a                              <- 列名已存在时
FAIL ALTER TABLE base ALTER COLUMN a TYPE TEXT            0.022 ms
     near "ALTER": syntax error                             <- 改列类型：没有这个语法
FAIL ALTER TABLE base MODIFY a TEXT                       0.008 ms
     near "MODIFY": syntax error                            <- 也没有 MySQL 方言
```

`DROP COLUMN`（SQLite 3.35 起支持）是**混合形态**：能删，但每行都要重写，且被任何对象引用就直接拒绝：

```text
OK   ALTER TABLE base DROP COLUMN flag    中位 16.119 ms [15.072–19.772]  changes=20000  <- 全表重写
OK   ALTER TABLE base DROP COLUMN flag2   中位 13.843 ms [12.102–15.505]  changes=20000
FAIL ALTER TABLE base DROP COLUMN a       原文> error in table base after drop column: no such column: a
FAIL ALTER TABLE base DROP COLUMN c       原文> error in table base after drop column: no such column: c
FAIL ALTER TABLE base DROP COLUMN bb      原文> error in index ix_b after drop column: no such column: bb
FAIL ALTER TABLE base DROP COLUMN id      原文> cannot drop PRIMARY KEY column: "id"
```

a/c 被视图 `vw` 引用、bb 被索引 `ix_b` 引用——**引用检查是删列前先跑一遍 `PRAGMA foreign_key_list` 式的目录校验**，失败也要 2.4–3.9 ms（校验做完了才发现不行）。**改列类型没有捷径**，只能走"建新表→`INSERT…SELECT` 搬数据→`RENAME`"，这条流程的实测耗时见第七、八节。

`RENAME TO` 整表改名默认会级联更新引用者的 schema 文本：

```text
OK ALTER TABLE base RENAME TO base2    中位 4.529 ms [4.071–5.241]
   CREATE VIEW vw AS SELECT id, a, bb FROM "base2" WHERE c > 1     <- 视图跟着改
   CREATE TABLE child(pid INTEGER REFERENCES "base2"(id), x TEXT)  <- FK 跟着改
   pragma foreign_key_list('child') -> table=base2
OK ALTER TABLE base2 DROP ... （DROP TABLE base2）  中位 5.156 ms   <- 删得掉
   select count(*) still_vw from sqlite_master where type='view' -> 1   <- 视图留下来了，悬空
```

两个开关能造出更多事故形态。**`PRAGMA legacy_alter_table=ON` 时改名不更新引用**：

```text
OK PRAGMA legacy_alter_table=ON / ALTER TABLE p RENAME TO p_new   中位 5.136 ms
   CREATE VIEW v AS SELECT id FROM p     <- 文本没动
   select count(*) from v  FAIL> no such table: main.p
```

**`PRAGMA writable_schema=ON` 直接把 `sqlite_master` 当普通表改**——同连接的模式缓存不刷新，要重开连接才生效：

```text
OK UPDATE sqlite_master SET sql='CREATE TABLE c(id INTEGER PRIMARY KEY, v TEXT, z TEXT)' WHERE name='c'
Q> pragma table_info('c')            -> 仍然只有 id, v 两列（本连接缓存旧 schema）
Q> insert into c VALUES(2,'b','c')   FAIL> table c has 2 columns but 3 values were supplied
-- 重开同一个文件后：
Q> pragma table_info('c')            -> id, v, z 三列；旧行 1 | a | NULL
Q> pragma integrity_check            -> ok
```

最后一行要反着读：`integrity_check` 说 ok 只证明**这次改得恰好没改坏**，`writable_schema` 同样能让你把目录改成真正坏掉的样子，它不设防。

## 二、在线变更风险：一个在读、一个在改，实测谁等谁

MySQL 文档里的"在线 DDL"在 SQLite 上没有对应物——本节把"变更撞上读写"的三种组合全部实测（`conc.sqlite`，20000 行，282624 字节，journal=delete，连接 A/B 两路）：

```text
场景1  B  BEGIN + SELECT（持读快照）→ A 执行 ALTER TABLE t ADD COLUMN c1 TEXT DEFAULT 'd'
  FAIL ALTER …  5522.939 ms [5491.564–5529.810]   database is locked
       之后 pragma table_info('t') 仍是 id, v 两列 —— 白等约 5 秒（Qt 默认 busy timeout 量级），原子失败
场景2  A BEGIN + INSERT（持写锁）→ B 执行 ALTER TABLE t ADD COLUMN c2 …
  FAIL ALTER …  0.074 ms   database is locked      <- 写-写冲突不排队，立即失败
场景3  B 读事务进行中，A 连做两条 autocommit ALTER 并提交 → B 继续读：
  Q> pragma table_info('t')        FAIL> database is locked
  Q> select count(*) b_sees from t FAIL> database is locked
```

场景 3 最值得抄进变更手册：**delete-journal 模式下，"快照里只有旧 schema"的承诺不存在**——别人的在线变更一提交，你手上这个还没结束的读事务下一次取数直接 `database is locked`，而不是继续看旧结构。

两个 DEFERRED 事务都想把读升级成写的经典死锁（`lock.sqlite`，B 显式设了 `QSQLITE_BUSY_TIMEOUT=200`）：

```text
OK   UPDATE t SET v='A' WHERE id=1   1.088 ms        <- A 先升级，拿到写锁
FAIL UPDATE t SET v='B' WHERE id=1   0.022 ms  database is locked   <- B 升级即败，200ms 也没等
FAIL COMMIT                      5496.129 ms  database is locked     <- 轮到 A 提交，被 B 的读快照卡住，约 5.5 s 后失败
OK   COMMIT（B，只读事务）             0.018 ms
Q> select v from t where id=1（A 自己读） -> A
```

结尾那条 `A` 是**未提交的私有视图**：A 的 COMMIT 已经失败、事务还开着，它的自读看见 `'A'` 并不代表任何人看见。升级先赢、提交反被读锁拖死、超时互相无解——SQLite 不做死锁检测，纯靠超时，这就是"在线变更窗口里不要留长读事务"的实测依据（事务与隔离的更多细节在第六节展开，锁的完整版图是第 10 节的事）。

## 三、类型选择：金额、时间戳与字符集，先算字节账再谈精度

**金额**。五张表各灌 20000 行同一笔钱（`m_txt` 存文本 `'0.1'`，`m_cent` 存 10 分，其余存 0.1）：

```text
Q> select 'm_real' t, sum(a) s, typeof(sum(a)) ty, cast(sum(a) as text) txt from m_real
   m_real | 2000 | real | 2000.0
Q> select 'm_cent' t, sum(a) s, typeof(sum(a)) ty, sum(a)/100.0 yuan from m_cent
   m_cent | 200000 | integer | 2000
Q> pragma table_info('m_dc') -> type=DECIMAL(10,2)，而 select typeof(a) -> real   <- 声明只是亲和性
```

每种声明类型单独一库（`id INTEGER PRIMARY KEY` + 一列，20000 行，page_size=4096，空库 8192 字节）：

| 声明 / 存储 | typeof() | 库文件字节 | 净增值列 B/行 |
| --- | --- | --- | --- |
| `REAL` / `NUMERIC` / `DECIMAL(10,2)` | real | 335872 | 16.38 |
| `TEXT`（'1234.56'） | text | 315392 | 15.36 |
| `INTEGER`（分） | integer | **233472** | **11.26** |

INTEGER 分最小、且 `sum` 精确到分（200000 分 = 2000.00 元，`typeof(sum)=integer`）；REAL 那 2000.0 是浮点累加碰巧干净，等值判断立刻露馅（`p15_cast`，同一列 `a` 存 20000 个 0.1）：

```text
select count(*) where a=0.1          -> 20000
select count(*) where a*3=0.3        -> 0        <- 0.1*3 = 0.30000000000000004
select count(*) where a*10=1         -> 20000    <- 乘 10 恰好又是精确的，别当成规律
select 0.1+0.2 two, 0.1+0.2=0.3 eq, (0.1+0.2)-0.3 diff
   0.30000000000000004 | 0 | 5.551115123125783e-17
select round(2.675,2), round(1.005,2), cast(0.29*100 as int), round(0.29*100)
   2.67 | 1 | 28 | 29                    <- 银行家进位不存在，但二进制表示先输了一半
select round(2.5), round(3.5), round(-2.5) -> 3 | 4 | -3     <- ROUND 是零外进位
```

`printf('%.20f', 2.675)` 打出来是 `2.67500000000000000000`、`printf('%.20f', 0.1+0.2)` 是 `0.30000000000000000000`——**SQLite 自带 printf 的显示不能拿来验证二进制尾数**，上面 `0.30000000000000004` 那种列值直读才算数。结论：钱用 INTEGER 分（或 BLOB 存定点），REAL 列上的 `=` 谓词是埋雷（正确写法 `abs(a*3-0.3)<1e-12` 实测 20000 全中）。

**时间戳**。三种存法在同一库（`ts.sqlite`，1400832 字节）里各 20000 行，值部分字节账 `sum(length(cast(ts as blob)))`：`t_int`（unix 秒）200000 = **10 B/行**，`t_real`（儒略日）281664 = 14.08 B/行，`t_txt`（`'2026-01-01 08:00:00'`）380000 = **19 B/行**。TEXT 最可读也最大，但**必须零填充**，否则排序和函数一起翻车（`t_bad` 故意存成 `'2026-M-D'`）：

```text
Q> select count(*) n_bad_order from t_bad where ts < '2026-3-1'      -> 8332
   同库 t_txt（零填充）substr(ts,1,10) < '2026-03-01'                 -> 3334
Q> select count(*) from t_bad where ts >= '2026-10'                  -> 18333
   真正 10 月及以后的行数（按数值取月）                                 -> 4998
Q> select min(ts), max(ts) from t_bad                                 -> 2026-1-1 | 2026-9-9
```

字符串比较把 1 月之后的 `2026-10-xx` 全漏掉、把 9 月当成最大月。六行小样本（p15）看得更清楚：`order by ts` 得到 `2026-01-05, 2026-09-09, 2026-1-5, 2026-10-01, 2026-3-1, 2026-9-9`；且 `date('2026-1-5')` 返回 **NULL**——`where date(ts) is null` 命中 3/6 行，非零填充的日期函数直接解析失败。时区侧实测：`datetime('now')` 与 `datetime('now','localtime')` 差 8 小时，`unixepoch('2026-10-16 08:00:00')`=1792137600、`datetime(1760000000,'unixepoch','localtime')`=`2025-10-09 16:53:20`——**INTEGER 存 epoch 就没有这堆歧义**。

**字符集**。`PRAGMA encoding` 只能在**空库**时定（`p13` 实测建库前设置成功，读回 UTF-16le；对已有数据的库改编码未实测）。同样 5000 行"数据库测试🎉行N"：

```text
UTF-8  库文件 = 180224 字节   length(s)=8 字符, length(cast(s as blob))=23 字节
UTF-16le 库文件 = 167936 字节  length(s)=8 字符, blob 字节=18；substr(s,6,1) hex=3CD889DF unicode=127881
Q> select upper('数据库abc'), lower('ABC数据库')  -> 数据库ABC | abc数据库    <- 只有 ASCII 变大小写
Q> select count(*) from t where s like '%🎉%'（UTF-16le 库）-> 5000
```

CJK 为主的文本 UTF-16le 反而省 7%（emoji 在 UTF-16 里是代理对，`length()` 按 UTF-16 计数算 1 个字符）。`upper()/lower()` 不做中文/重音是预期行为——**SQLite 全库一个编码、列级没有字符集/排序规则可选**，`COLLATE NOCASE` 只管 ASCII（第 1 节实测过），带重音的语言学排序需要自建 COLLATION。MySQL 的 `utf8mb4`/`_ci` 那一套见第九节。

## 四、CAST：迁移路上那个静默改值的家伙

`CAST` 和亲和性转换几乎不报错，它只给你想要的类型的"最接近的尸体"（p15 全表原文）：

```text
select cast('abc' as integer), cast('12abc' as integer), cast('1e3' as integer), cast('' as integer)
   0 | 12 | 1 | 0          <- '1e3' 不是 1000，取到非数字前缀就停
select cast('9999999999999999999999' as integer), cast(1e30 as integer), cast(-1e30 as integer)
   9223372036854775807 | 9223372036854775807 | -9223372036854775808    <- 饱和到 int64 两端，不报错
select cast(9007199254740993 as real)      -> 9007199254740992         <- 越过 2^53 精度丢失
select cast('abc' as real), cast('12.5abc' as real)  -> 0 | 12.5
select cast(42.0 as text), cast(42.50 as text)       -> '42.0' | '42.5'
select substr('C',2), cast(substr('C',2) as integer) -> '' | 0          <- 经典 substr 越界→0 号事故
select 9223372036854775807+1, 9223372036854775807*2  -> 9223372036854776000 | 18446744073709552000
   <- 整型算术溢出静默升级成 REAL，末位已经错了
select 1/3, 10/4, 10%4     -> 0 | 2 | 2
```

`C`+1=1、`C1`+1=1——文本进算术按 `CAST(... AS INTEGER)` 规则吃前缀，两种脏值算出同一个 1。迁移脚本里最常见的 `CAST(substr(cust,2) AS INTEGER)` 对 `'C4x'` 得到 4、对 `''` 得到 0、对 NULL 得到 NULL，**没有一个会报错**。

这些规则叠加亲和性，就是迁移库里的静默改值现场。源表 `s`（5 行，声明了 REAL/INTEGER 列但实际什么都存过）：

```text
Q> select id, cust, amount, big, txt, typeof(cust), typeof(amount), typeof(big) from s order by id
   1 | C1   | 1.5    | 10                  | ok  | text | real  | integer
   2 | NULL | NULL   | NULL                | NULL| null | null  | null
   3 | (空串)| 0     | 9223372036854775807 | x   | text | real  | integer
   4 | C4x  | abc    | 9.9                 | y   | text | text  | real    <- REAL 列存了文本、INTEGER 列存了 real
   5 | C5   | 1e+30  | 3                   | (40个汉字,120字节) | text | real | integer
```

目标表 `d(cust_id INTEGER NOT NULL, cents INTEGER NOT NULL, …)`，一条 `INSERT INTO d SELECT id, CAST(substr(cust,2) AS INTEGER), CAST(round(amount*100) AS INTEGER), … FROM src.s` 的真实下场：

```text
FAIL> NOT NULL constraint failed: d.cust_id      （第 2 行的 NULL 触发）
Q> select count(*) rows_in, (select count(*) from src.s) rows_out from d  -> 0 | 5
Q> select count(*) from d where id in (2,3)  -> 0     <- 第 3 行那个 cust_id=0 也没进去
```

**INSERT…SELECT 是单条语句，一行坏、全条回滚，0 行入库**——不存在"好的先进去"。但反过来，如果脏值没撞上任何约束（第 4 行的 `abc`→cents 走 `CAST(round('abc'*100))=0`、第 5 行的 `1e+30`），它们就会**一声不吭地**换着样子进去。校验四件套（第八节）就是为这种行准备的。

## 五、DDL 也是事务性的：BEGIN 能包住 CREATE/ALTER/DROP

这是 SQLite 和 MySQL 最大的日常行为差别之一，实测原文：

```text
OK BEGIN / OK CREATE TABLE tmp_ddl(a INTEGER) 1.245 ms / OK ALTER TABLE t ADD COLUMN more TEXT 0.109 ms
Q> select count(*) from sqlite_master where name='tmp_ddl'  -> 1     <- 事务内已"存在"
OK ROLLBACK 1.522 ms
Q> select count(*) from sqlite_master where name='tmp_ddl'  -> 0     <- 表没了
Q> pragma table_info('t')  -> 仍然只有 id, v 两列                     <- ALTER 同样被撤销
FAIL DROP TABLE tmp_ddl  原文> no such table: tmp_ddl
```

以及边界三件套的报错原文：

```text
FAIL ROLLBACK（无事务）> cannot rollback - no transaction is active
FAIL COMMIT（无事务）  > cannot commit - no transaction is active
FAIL BEGIN（事务内）   > cannot start a transaction within a transaction
```

所以**多步 schema 变更可以整段原子回滚**——这在"建新表→搬数据→改名"流程里是安全垫（第七节实测）；而 MySQL 的 DDL 隐式提交给不了这个保证（未实测，见第九节）。

## 六、事务内的 DML：回滚的真实价格、SAVEPOINT 的可见性、半提交与 total_changes

同一张表、同样 100000 行未提交插入，`journal_mode=delete`：

```text
ROLLBACK 100000 行   中位 2.032 ms [1.984–2.499]    之后行数=0 库字节=8192
COMMIT   100000 行   中位 413.240 ms [394.147–418.605]  之后行数=100000 库字节=1486848
```

**回滚比提交便宜约 200 倍**（中位比）：未提交的页大多还压在缓存/回滚日志里，回滚只丢日志，提交要写全量 1.48 MB 并 sync。别把"事务太大回滚很慢"当直觉——这里的实测方向恰好相反，大事务贵的是**提交**。

SAVEPOINT 嵌套的可见性逐帧：

```text
BEGIN / SAVEPOINT sp1 / INSERT 900001 / SAVEPOINT sp2 / INSERT 900002
Q> select count(*) where id>=900001  -> 2                 <- sp2 的行对本连接可见
OK ROLLBACK TO sp2   -> count=1                            <- 只吞掉 sp2 之后的
FAIL ROLLBACK TO nosuch  原文> no such savepoint: nosuch
OK RELEASE sp2 / OK COMMIT 3.060 ms → 最终只剩 900001
```

**半提交形态**（Qt 层不自动回滚失败语句）：事务里插 4 条、第 2 条撞主键——

```text
重复主键那一条 ok=0  原文> UNIQUE constraint failed: t.id
COMMIT 后： half_committed=3  ids=1,2,3
```

**除失败那条外其余照单全收**。SQLite 没有 PostgreSQL 那种"语句报错即中止整个事务"，迁移/批量写入的代码必须在每条失败时自己决定 `rollback()`。

`total_changes()` 不随回滚退账：

```text
select total_changes() -> 300006 → 事务内插 1 行后 300007 → ROLLBACK 后仍 300007（行已不在，row_there=0）
```

**外键延迟检查**（`DEFERRABLE INITIALLY DEFERRED` 列级 / `PRAGMA defer_foreign_keys=ON` 事务级，两者都实测）让"先插子、后补父"成为合法迁移手法：

```text
OK INSERT INTO kid VALUES(1,'先插子行')   <- 语句时不检查
OK INSERT INTO par VALUES(1,'后补父行')
OK COMMIT  3.183 ms                        <- 提交时检查通过
OK INSERT INTO kid VALUES(999,'父永远不来') / FAIL COMMIT  原文> FOREIGN KEY constraint failed
此时同连接 select count(*) from kid -> 2   <- COMMIT 失败但事务没有随之结束，行仍在开着的事务里
```

`defer_foreign_keys` 同款（孤儿行 pid=7 照插，COMMIT 报 `FOREIGN KEY constraint failed`）。**报错点从语句挪到了 COMMIT**，批量导入脚本要把 COMMIT 的返回值当回事；且失败后事务还开着，必须显式 ROLLBACK。

## 七、跨库搬迁：ATTACH 的事务原子性、VACUUM INTO 与 WAL 长事务

迁移模型：旧库 `old.sqlite`（`orders(id, cust TEXT, amount REAL, note TEXT)`，100000 行，2265088 字节，`user_version=3`）搬进新结构（`customers` + `orders(cents, updated_at)`，含 FK）。全程一个事务：

```text
OK ATTACH 'old.sqlite' AS old                        中位 1.972 ms
INSERT INTO customers SELECT DISTINCT CAST(substr(cust,2) AS INTEGER) FROM old.orders
   17.044 ms，997 行
INSERT INTO orders(id,cust_id,cents,note) SELECT id, CAST(substr(cust,2) AS INTEGER),
       CAST(round(amount*100) AS INTEGER), note FROM old.orders
   中位 46.142 ms [42.688–46.578]，100000 行，库字节→2985984
OK CREATE INDEX ix_cust ON orders(cust_id)           中位 28.915 ms [26.806–30.640]
OK COMMIT（整个迁移）                                 中位 9.802 ms [8.532–11.102]
新库：文件 4046848 字节，integrity=ok，user_version=0   <- 旧库是 3，新库不会自己长版本，见第八节
```

顺序代价对照（同 100000 行 + 2 索引，独立子库实测）：**先灌数后建索引** 中位 659.682 ms [587.131–668.721]、4308992 字节；**先建索引后灌数** 中位 762.281 ms [704.674–775.837]、8863744 字节（**1.16× 时间、2.06× 体积**）；`CREATE TABLE s3 AS SELECT * FROM s1` 最快（中位 27.7 ms）但 `table_info` 显示列类型全变成 `INT`、`s3_indexes=0`——**CTAS 不带走主键/索引/约束**，只能当数据搬运工。`VACUUM` 整理空页：254.237 ms [195.980–256.682]，10915840→10665984 字节。

跨库原子性实测——**ROLLBACK 会同时回滚 ATTACH 进来的库**：

```text
BEGIN / INSERT main.orders(1000001…) OK / INSERT old.orders(1000001…) OK   <- 同事务写两个文件
ROLLBACK 后： main_side=0, old_side=0；DETACH 重开旧库 count=100000，integrity ok
FAIL DETACH main   原文> cannot detach database main
```

`p14` 还测了混合 journal（main=delete + att=wal）的跨库事务：两侧各插一行后 ROLLBACK，`main_after_rb=1 / att_after_rb=1`，两侧都干净回滚，重开连接后仍是 1 行。**注意**：这是"同一进程同一连接"的原子性，不是分布式事务——别的连接此刻只看得到各自库的旧状态。

`VACUUM INTO` 生成在线副本时若目标文件已存在，直接拒绝，不会覆盖：

```text
VACUUM INTO copy.sqlite  ok=0  原文> output file already exists
```

WAL 下长事务（迁移没提交时来读数）的完整账本（`wal_long.sqlite`）：

```text
事务内 50000 行未提交：主库=4096  -wal 从 8272 涨到 700432
本连接 select count(*) -> 50000；另一连接 reader -> 0            <- 未提交对外不可见
Q> pragma wal_checkpoint   FAIL> database table is locked        <- 长事务挡 checkpoint
FAIL 另一连接 INSERT       5468.124 ms  database is locked        <- 挡写
OK ROLLBACK 之后：主库=4096  -wal=704552                          <- 回滚不把 -wal 缩小
pragma wal_checkpoint(TRUNCATE) -> busy=0 log=0 checkpointed=0，主库=8192 -wal=0
```

迁移窗口内 WAL 文件按未提交量线性膨胀、checkpoint 和写者全部停摆——第 8 节（db-sqlite）讲 WAL 时再细账，这里记行为。

## 八、迁移版本号与一致性校验：四件套 + foreign_key_check + user_version 阶梯

**四件套**对 `old.sqlite` vs 新库逐条跑（100000 行，两侧 schema 已不同，先折算到可比的列）：

```text
Q> select (select count(*) from old.orders), (select count(*) from orders)   -> 100000 | 100000
Q> select (select cast(sum(amount*100) as int) from old.orders), (select sum(cents) from orders)
   -> 750007500000 | 750007500000                                            <- 分单位总账
Q> select count(*) from old.orders o join orders n on n.id=o.id
   where cast(round(o.amount*100) as int) <> n.cents                          -> 0   <- 逐行金额
Q> select count(*) from (select id, note from old.orders EXCEPT select id, note from orders)  -> 0
Q> select count(*) from (select id, note FROM orders EXCEPT select id, note from old.orders)  -> 0
   EXCEPT 单方向 10 万行：中位 45.240 ms [37.828–57.511]
Q> pragma integrity_check -> ok       Q> pragma foreign_key_check -> 空
```

EXCEPT 那条的计划原文（解释了为什么它要给区间而不是承诺常数）：

```text
EQP> select count(*) from (select id, note from old.orders EXCEPT SELECT id, note FROM orders)
   CO-ROUTINE (subquery-2) / COMPOUND QUERY / LEFT-MOST SUBQUERY / SCAN old.orders
   EXCEPT USING TEMP B-TREE / SCAN orders / SCAN (subquery-2)
```

**四件套全绿也照样漏外键孤儿**，因为迁移脚本的目标表 FK 写了也白写（`foreign_keys` 默认 OFF，第 1 节）——实测在新库连做两次"合法"的坏写入：

```text
OK INSERT INTO orders(id,cust_id,cents) VALUES(2000002,1,NULL)   <- customers 里没有 id=1，不报错
FAIL UPDATE orders SET updated_at=NULL WHERE id=1
     原文> NOT NULL constraint failed: orders.updated_at          <- NOT NULL 倒是真的
OK UPDATE orders SET cust_id=123456789 WHERE id=1                 <- 指向不存在的客户，静默成功
Q> pragma foreign_key_check  ->  orders | 1 | customers | 0       <- 只有它抓得到
```

所以校验清单是**五件**：count / 折算 sum / EXCEPT 双向 / integrity_check / **foreign_key_check**。

**版本号用 `PRAGMA user_version`**（一个 4 字节整数，落在库头，重开连接仍在——第 1 节测过它的持久性；而这次迁移完的新库读回 0，提醒我们搬数据不会搬版本号）。阶梯迁移循环实测幂等（`ver.sqlite`）：

```text
PRAGMA user_version=1
step 2: transaction=1 alter=1 setver=1 commit=1 -> user_version=2 列数=3
step 3: … -> user_version=3 列数=4     step 4: … -> user_version=4 列数=5
重跑 step 2/3/4：当前 user_version=4 -> 全部跳过；pragma_table_info('t') 恒 5 列
```

每一步 = `BEGIN + ALTER + PRAGMA user_version=N + COMMIT`：第五节证明 DDL 可回滚，所以中途断电/报错时 schema 与版本号不会分家，重放安全。另外迁移脚本自身最常见的两种坏法也有原文：`table orders has 5 columns but 6 values were supplied`（列数错位的 INSERT）与第一节那一串 `Cannot add …` ——先建临时表校验 `INSERT INTO … SELECT` 一行再放开跑，成本是毫秒级。

## 九、MySQL 侧的字符集与在线 DDL：未在本机实测

本机没有 MySQL/MariaDB/PostgreSQL 实例和客户端，下面**只陈述机制名，不给任何数字**，全部标注为待有环境复核：

- **字符集与排序规则**：`utf8mb4` vs `utf8mb4_bin`、`_ci`（大小写不敏感）collation 对 UNIQUE、`=`、`ORDER BY` 的影响；`VARCHAR(10)` 在 MySQL 里是真长度校验（SQLite 不校验，第 1 节已实测）。与第三节"emoji/代理对"对应的问题是 `utf8mb3` 存不下 4 字节字符——**未实测**。
- **在线 DDL**：`ALTER TABLE … ALGORITHM=INPLACE / COPY`、`LOCK=NONE`、8.0 的 instant ADD COLUMN。对照本文第三节：SQLite 的常量默认值 `ADD COLUMN` 实测就是"instant"（文件逐字节不变），`DROP COLUMN` 实测全表重写（16.1 ms/20000 行）；MySQL 各算法在哪条路径上、加列何时重写表，**未实测**。
- **`pt-online-schema-change` / `gh-ost`**：影子表 + 触发器/日志回放 + 改名切换，本质是第 7 节"建新表→搬数据→改名"流程的托管版；SQLite 侧那条流程的每一环已实测，MySQL 侧的窗口与锁行为**未实测**。
- **DDL 隐式提交**：MySQL 的 DDL 不能回滚（无事务 DDL），与第五节实测的 SQLite 行为相反——机制陈述，**未实测**。
- 第九节《执行计划》与第 6 节《事务》发布时同样会标注 MySQL 差异；本节引用它们的"未实测"范围以各自文章为准。

## 十、小结

- **`ALTER TABLE` 能力矩阵（SQLite 3.50.4 实测）**：`RENAME COLUMN/TO` 级联改写索引/视图/FK 的 schema 文本（5.229/4.529 ms）；常量默认值 `ADD COLUMN` 纯元数据、文件 954368→954368 字节；`NOT NULL` 不带默认值、`UNIQUE`、`PRIMARY KEY`、非常量默认值四类直接被拒（原文见第一节）；`DROP COLUMN` 能用但重写全表（changes=20000、16.1 ms）且被视图/索引/PK 引用即失败；**改列类型没有 ALTER**，只能建新表搬数据。
- **在线变更在 SQLite = 全库互斥**：读事务进行时 ALTER 等满约 5 s 拿 `database is locked`；写锁在手时后来者 0.074 ms 立即失败；变更提交还会让**别人的**在途读事务报 `database is locked`；两个 DEFERRED 事务互卡，先升级者反而在 COMMIT 上超时失败（5496 ms）——变更窗口必须清空长事务。
- **类型选择用字节和等值判断说话**：钱 = INTEGER 分（11.26 B/行、sum 精确）；REAL 16.38 B/行且 `a*3=0.3` 0 命中、`round(2.675,2)=2.67`；时间戳 TEXT 必须零填充（不填充的字符串比较把 3334 行错成 8332 行、`date()` 直接 NULL）；全库单一编码，UTF-16le 空库可设、CJK 下比 UTF-8 小 7%，`upper/lower` 只动 ASCII；`DECIMAL(10,2)` 是摆设（typeof=real）。
- **CAST 无警告**：`'1e3'→1`、超大→int64 饱和、`2^53+1` 丢精度、`substr` 越界→0、整型溢出静默转 REAL。`INSERT…SELECT` 一行违规整条 0 行入库，但**没违规的脏值会换样子进去**。
- **DDL 是事务性的**（CREATE/ALTER 可 ROLLBACK），DML 侧：回滚 10 万行 2.0 ms vs 提交 413 ms（约 200 倍）；SAVEPOINT 分段回滚/RELEASE 实测可见性；单条失败**不**中止事务（半提交 3/4 行）；`total_changes()` 不随回滚退账；DEFERRED FK 把报错挪到 COMMIT，且失败后事务仍在，要显式回滚。
- **迁移的正确姿势**：`ATTACH` + 单事务（ROLLBACK 同时回滚两库文件，实测 0|0），先灌数后建索引（省 1.16× 时间、2.06× 体积），CTAS 不带约束；`VACUUM INTO` 拒覆盖已存在文件；WAL 下未提交长事务把 -wal 撑到 700 KB、挡 checkpoint 挡写。
- **校验五件套**：count、折算 sum、EXCEPT 双向、`integrity_check`，外加**`foreign_key_check`**——FK 默认 OFF 让孤儿静默入库，前四件全绿它单独抓到 `orders|1|customers|0`。版本用 `PRAGMA user_version` 阶梯 + 每步一事务，重跑幂等。
- MySQL 的字符集/collation、在线 DDL 与 pt-osc **未在本机实测**，全部圈在第九节。

下一节进入 SQL 表达力本身：窗口函数 `ROW_NUMBER/RANK` 在并列值上的真实分布、递归 CTE 拆树形结构、以及哪些应用层循环能一条 SQL 替掉。
