---
title: 关系模型与 SQL 入门：把表、主键、外键放到机器上量一遍
description: 实测：VARCHAR(10) 存进 20 字符照样成功，TEXT 主键允许两个 NULL，外键默认 OFF；逐条 autocommit 比单事务慢 717–1053 倍。
date: 2026-10-15
tags: [数据库, 关系模型, SQL, SQLite, Qt SQL]
category: database
section: db-model
---

> 环境：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ `Qt6::Sql`，插件 `plugins/sqldrivers/qsqlite.dll`，GCC 13.1.0 编译，无头运行。**SQL 引擎是 Qt 内嵌的 SQLite 3.50.4**（`select sqlite_version()` 读回），所有结论都是 `QSqlQuery` 打真库拿到的原文输出。本机没有 MySQL / MariaDB / PostgreSQL 服务，也没有 `mysql`/`psql` 客户端，凡涉及它们的表述都单列在第十节，**未在本机实测**。
>
> 计时部分：本机同期还有其它任务在抢 CPU，绝对值偏大且抖动，**文中一律给"3 次样本的中位数 + 区间"，比值比绝对值可靠**。

## 一、先认清手上是什么：连接与数据库层的真实能力

```text
available drivers = QIBASE, QSQLITE, QMIMER, QOCI, QODBC, QPSQL
driver=QSQLITE  sqlite_version=3.50.4  Qt=6.9.3
hasFeature: PreparedQueries=1 Transactions=1 NamedPlaceholders=1 BLOB=1 EventNotifications=1
新建库文件 open() 之后大小 = 0 bytes（第一次写入才落盘）
page_size=4096 journal_mode=delete synchronous=2 foreign_keys=0 auto_vacuum=0
user_version=0 max_page_count=4294967294
```

`QSqlDatabase::addDatabase("QSQLITE", "conn")` + `setDatabaseName("x.sqlite")` + `open()` 就是完整的一台数据库。`foreign_keys=0` 是**出厂默认**，第五节会咬人。`QSqlError::text()` 在约束失败时还会拖一句 Qt 自己的尾巴（`... Unable to fetch row`），SQLite 原始消息是前半段。

## 二、类型亲和：VARCHAR(10) 不是长度限制

声明的类型只是"亲和性建议"。同一列插入不同字面量，`typeof()` 读回的实际存储类型：

| 声明类型 | 插入字面量 | 存储 typeof() | 存下来的值 |
| --- | --- | --- | --- |
| `VARCHAR(10)` | `'1234567890ABCDEFGHIJ'` | text | 20 个字符，**没报错** |
| `INTEGER` | `'42'` | integer | 42（文本转成了整数） |
| `INTEGER` | `'42.0'` | integer | 42（小数点被吃掉） |
| `INTEGER` | `'3.7'` | real | 3.7（转不成整数，保留 REAL） |
| `INTEGER` | `'abc'` | text | 'abc'（**INTEGER 列里存了文本**） |
| `NUMERIC` | `'1e5'` | integer | 100000 |
| `BLOB` | `'42'` | text | 原样不动 |
| 无声明类型 | `'7'` | text | 原样不动 |

三条工程结论：

1. **长度、精度在 SQLite 里不做校验**，`QSqlField` 读回的元数据也是空的（`length=-1 requiredStatus=-1`）——别指望它替你拦脏数据。
2. `'42'` 进 INTEGER 列会变成真正的整数，因此 `WHERE i = 42` 能命中；反过来把 ID 声明成 TEXT 列再塞 `'42'`，比较时就会走文本规则。
3. **主键、唯一约束这类"关系完整性"是真的**（第三节），所以 SQLite 的取舍是：类型宽松、键严格。

## 三、主键：`INTEGER PRIMARY KEY` 是 rowid 的别名，其它都不是

```text
-- pragma_table_info：pk_i(k INTEGER PRIMARY KEY) / pk_t(k TEXT PRIMARY KEY)
cid=0 name=k type=INTEGER notnull=0 pk=1      cid=0 name=k type=TEXT notnull=0 pk=1
INSERT INTO pk_i(k,s) VALUES(1099511627776,'big')  -> last_insert_rowid=1099511627776
select rowid from pk_i -> 1099511627776   typeof(k)=integer
-- sqlite_master 里被生成的对象
index|sqlite_autoindex_pk_c_1|pk_c     index|sqlite_autoindex_pk_t_1|pk_t
table|pk_i  table|pk_t  table|pk_c  table|pk_ai        （pk_i 没有 autoindex）
```

- **`INTEGER PRIMARY KEY` 就是 rowid 本身**：不生成 `sqlite_autoindex_*`，可以显式写 2^40 这么大的值，`rowid` 与它完全相等。所以它是**最快也最省空间的主键形式**。
- **`TEXT`/复合主键要额外建唯一索引**（`sqlite_autoindex_pk_t_1`），代价见第七节的字节数。
- **`notnull=0`：SQLite 的 PRIMARY KEY 不隐含 NOT NULL**。两张 NULL 都插进去了：

```text
pk_t 内容： rowid=1 k=NULL s=n1 (typeof=null)   rowid=2 k=NULL s=n2 (typeof=null)
            rowid=3 k=x1  s=v1
再插 k='x1'  -> FAIL UNIQUE constraint failed: pk_t.k
复合主键重复 -> FAIL UNIQUE constraint failed: pk_c.a, pk_c.b
```

这是 SQLite 长期保留的兼容性行为（NULL 之间在 UNIQUE 里被视为互不相等）。**要 NOT NULL 必须自己写**。

### AUTOINCREMENT 与"号会不会被复用"

```text
k INTEGER PRIMARY KEY AUTOINCREMENT：插 1,2,3 -> DELETE WHERE k=3 -> 再插
  pk_ai 内容: 1=r1  2=r2  4=after delete       sqlite_sequence: pk_ai | 4
k INTEGER PRIMARY KEY（无 AUTOINCREMENT）：插 1,2,3 -> 删掉 max -> 再插
  pk_p 内容: 1=r1  2=r2  3=reused?              last_insert_rowid=3
```

**AUTOINCREMENT 的语义是"号绝不复用"，代价是一张 `sqlite_sequence` 表和一次额外更新**；普通 rowid 表在删掉当前最大值后会把同一个号发出去。下游有外部系统按 ID 对账时，这个差别比性能重要。

## 四、约束失败的原文，和三种"撞了怎么办"

| 语句 | `QSqlError::text()` 原文 |
| --- | --- |
| 重复 UNIQUE 值 | `UNIQUE constraint failed: cst.code Unable to fetch row` |
| 重复主键 | `UNIQUE constraint failed: cst.id Unable to fetch row` |
| NOT NULL 列插 NULL | `NOT NULL constraint failed: cst.code Unable to fetch row` |
| CHECK 违例（`qty<1000` 插 1000） | `CHECK constraint failed: qty>=0 AND qty<1000 Unable to fetch row` |
| 不存在的列 | `table cst has no column named ghost Unable to execute statement` |
| 加不带默认值的 NOT NULL 列 | `Cannot add a NOT NULL column with default value NULL` |
| 引用不存在的表 | `no such table: nope_nope` |

```text
INSERT OR IGNORE (重复)      -> OK  changes=0
INSERT OR REPLACE (同 id)    -> OK  changes=1   结果行被整体替换
ON CONFLICT(id) DO UPDATE SET qty=qty+1 -> OK  changes=1  qty 9 -> 10
UPDATE cst SET qty=5 WHERE id=12345     -> numRowsAffected=0
SELECT total_changes()                  -> 13
```

**`numRowsAffected()` 为 0 不是错误**，业务代码要单独判；`OR REPLACE` 是"删了再插"（其它列会被清掉），`ON CONFLICT DO UPDATE` 才是原地更新。这两者在 MySQL 里对应 `ON DUPLICATE KEY UPDATE` / `REPLACE`，语义差别同样存在——但**本机未实测**。

## 五、外键：默认不生效，而且 `integrity_check` 不报

```text
pragma foreign_keys = 0                         <- 出厂默认
FK OFF: INSERT INTO ch VALUES(1,999,'while off') -> OK    （999 这个父行不存在）
PRAGMA foreign_keys=ON  -> 读回 1
FK ON : INSERT INTO ch VALUES(2,999,'blocked')   -> FAIL FOREIGN KEY constraint failed
PRAGMA foreign_keys=OFF 在事务里执行 -> "没有报错"，但读回仍然是 1   <- 事务内是 no-op
```

删父行时三种动作的真结果（FK ON）：

| 子表定义 | 操作 | 实测结果 |
| --- | --- | --- |
| `ON DELETE CASCADE` | `DELETE FROM pa WHERE id=1` | 子行被删（`children after cascade` 只剩 FK OFF 时那个孤儿） |
| `ON UPDATE CASCADE` | `UPDATE r0 SET id=2` | 子行 `r0_id` 跟着变成 2 |
| `ON DELETE SET NULL` | `DELETE FROM s0 WHERE id=1` | 子行 `s0_id = NULL`，`typeof()` 读回 null |
| 未写动作（NO ACTION） | `DELETE FROM t0 WHERE id=1` | `FAIL FOREIGN KEY constraint failed` |

**最坑的一条**：FK OFF 期间写进去的孤儿，事后开 FK 也不会被追溯。

```text
PRAGMA foreign_key_check ->  ch|1|pa|0   r1|9|r0|0
PRAGMA integrity_check   ->  ok
```

`integrity_check` 只管 B 树结构，**不管参照完整性**。清孤儿必须显式跑 `foreign_key_check`。另外 Qt 每个连接都要单独设 `PRAGMA foreign_keys=ON`——它在关闭连接后不保留（第十节实测：重开同一个文件读回 0）。

## 六、范式 vs 反范式：用 10 万行订单算三笔账

模型：`customers(id, name, city, email)` 1000 行 + `orders(id, customer_id, amount, note)` 100000 行。反范式版本把 `cust_name/cust_city/cust_email` 三个字段抄进订单表。同一份数据、单事务 prepared 批量写入，3 次样本：

| 指标 | 归一化（含 1 个二级索引） | 反范式（无二级索引） | 比值 |
| --- | --- | --- | --- |
| 库文件字节 | 4329472 | 7925760 | **1.83×** |
| 每行字节 | 42.87 B/行 | 79.26 B/行 | 1.85× |
| 10 万行写入耗时 | 中位 503 ms（404–538） | 中位 583 ms（513–847） | 中位 1.25×（1.13–1.57） |

读侧（`customer_id BETWEEN 1 AND 200`，两边都返回 **20081 行**，best of 7）：

```text
JOIN + INTEGER PRIMARY KEY 回表    中位 90.3 ms（79.4–179.6）
冗余单表                           中位 59.2 ms（38.8–68.7）   比值 1.52–2.62，中位 2.05
GROUP BY city 全表汇总              比值 0.99 / 1.28 / 1.30（基本打平）
```

写侧的账最难看：把城市 `Suzhou-B` 改名成 `Suzhou`——

```text
归一化  : UPDATE customers 改动 116 行，orders 一行不动
反范式  : UPDATE orders_d   改动 11643 行       <- 100 倍
```

计划原文（`EXPLAIN QUERY PLAN`，这是最不怕机器负载的证据）：

```text
SELECT o.id,o.amount,o.note,c.name,c.city,c.email FROM orders_n o JOIN customers c ON c.id=o.customer_id
  WHERE o.customer_id BETWEEN 1 AND 200 ORDER BY o.id
     SEARCH o USING INDEX idx_orders_cust (customer_id>? AND customer_id<?)
     SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
     USE TEMP B-TREE FOR ORDER BY
SELECT id,amount,note,cust_name,cust_city,cust_email FROM orders_d WHERE customer_id BETWEEN 1 AND 200 ORDER BY id
     SCAN orders_d
```

结论不神秘：**反范式把 JOIN 换成了一次顺序扫描**，读得快、写得少、体积小全没有；它买的是"读简单"，付的是"1.83 倍空间 + 100 倍更新行"。城市这类**低变动、高读取**的字段是合理冗余；姓名/价格这类会变的是坑。

## 七、索引不是免费午餐：字节与选择性反转

同一张 100k 表逐步加索引（`page_count × page_size`，3 次样本完全一致）：

| 阶段 | 库字节 | B/行 | 点查 `customer_id=42`（best of 5） |
| --- | --- | --- | --- |
| 无二级索引 | 3088384 | 30.88 | 中位 12.0 ms（8.9–15.7） |
| `+ i_c(customer_id)` | 4149248（+1.06 MB） | 41.49 | 中位 0.169 ms（0.149–0.209） |
| `+ i_ca(customer_id, amount)` | 6115328（+1.97 MB） | 61.15 | 0.162–0.170 ms |
| `+ i_note(note)` | 7991296（+1.88 MB） | 79.91 | 0.150–0.191 ms |

点查加速 **71 倍**（12.0 → 0.169 ms），代价是**每索引约 10–19 字节/行**。`DROP INDEX` 之后文件仍是 7991296，`freelist_count=458`（页还进了空闲表），`VACUUM` 之后才回到 6115328——**空间不会自己回来**。

选择性反转实验（同一条 JOIN，取不同比例的订单，A=归一化无索引，B=归一化有索引，C=反范式无索引，D=反范式有索引，中位 of 3 runs）：

| 取多少客户 | 命中行数 | A 归一+无idx | B 归一+idx | B/A | C 反范+无idx | D 反范+idx | D/C |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20（2%） | 1978 | 13.5 ms | 8.4 ms | **0.62** | 22.1 ms | 17.2 ms | 0.78 |
| 200（20%） | 20081 | 28.0 ms | 72.5 ms | **2.59** | 26.0 ms | 139.1 ms | 5.35 |
| 1000（100%） | 100000 | 90.2 ms | 578.2 ms | **6.41** | 113.4 ms | 851.5 ms | 7.51 |

**2% 选择性时索引快 1.6 倍，20% 时反而慢 2.6 倍，全表时慢 6.4 倍。** 因为索引命中后要按 rowid 回表随机取页，而 `SCAN` 是顺序读。同一条 SQL 换计划就换数量级，`EXPLAIN QUERY PLAN` 里 `SCAN o` 和 `SEARCH o USING INDEX` 谁更快取决于命中行数，不是谁更"高级"。

## 八、命名与标识符：中文表名能用，保留字必须引号

```text
CREATE TABLE 订单(编号 INTEGER PRIMARY KEY, 客户姓名 TEXT, 金额 REAL)   -> OK
SELECT 编号, 客户姓名 FROM 订单                                        -> OK
SELECT [编号] FROM [订单]                                             -> OK（方括号也认）
sElEcT 编号 fRoM 订单                                                  -> OK（标识符大小写不敏感）
CREATE TABLE t_bad(order INTEGER)     -> near "order": syntax error
CREATE TABLE "1t"(i int)              -> OK；不加引号 CREATE TABLE 1t -> unrecognized token: "1t"
CREATE TABLE sp("a b" int)            -> OK，SELECT "a b" FROM sp -> OK
```

顺带测到的两条大小写规则，建唯一约束前必须知道：

```text
UNIQUE 列已有 'x'，再插 'X'          -> OK（默认区分大小写，两条都进去了）
COLLATE NOCASE 的 UNIQUE 列再插 'X'   -> FAIL UNIQUE constraint failed: u3.a
空串不是 NULL：'' is null = 0，length('') = 0，'' = '' 为 1
```

能落地成规范的观察：**SQLite 允许中文表名/列名、带空格列名、128 字节的长表名**——它不阻止你写难看的东西；`order`、`group`、`select` 这类保留字**必须**加双引号；表名列名一律小写 + 下划线 + 加复数（`orders.customer_id`）不是风格洁癖，是为了让 `JOIN ... USING` 和跨库迁移不出第八节那种惊喜。

## 九、Qt 侧的建库流程：连接、PRAGMA 持久性、批量写

**PRAGMA 哪些落盘、哪些每次都要重设**（对同一个文件 close 再 open）：

```text
设置后：page_size=4096 journal_mode=wal synchronous=1 foreign_keys=1 user_version=3 auto_vacuum=0
重开后：page_size=4096 journal_mode=wal user_version=3  <- 持久
        foreign_keys=0 synchronous=2 auto_vacuum=0      <- 回到默认，不持久
```

`auto_vacuum` 建表之后改不动（读回仍 0，要 `VACUUM` 才生效）。所以**建库脚本的正确顺序**是：`page_size` → `auto_vacuum` → 建表 → `PRAGMA user_version=N`（用它做 schema 版本号，`QSqlQuery` 读回即可判断要不要迁移）→ 每个连接打开后立刻 `PRAGMA foreign_keys=ON`。

**journal / WAL 的行为**（严格按语句顺序取数）：

```text
默认：journal_mode=delete synchronous=2 locking_mode=normal cache_size=-2000
事务中 PRAGMA journal_mode=WAL -> FAIL cannot change into wal mode from within a transaction
WAL 下 BEGIN + 5000 行未提交：主库=4096 B  -wal=8272 B  -shm=32768 B
COMMIT 之后：主库=4096 B  -wal=82432 B
wal_checkpoint(TRUNCATE) -> busy=0 log=0 checkpointed=0 ，之后 主库=73728 B  -wal=0 B
```

批量写 20000 行（单事务，3 次取最好）：`DELETE` 模式 30.0/31.0/39.0 ms，`WAL` 模式 25.0/29.0/35.0 ms——**同一份数据只快 ~1.07 倍**。真正决定生死的是事务边界：

| 写法（2000 行） | 3 次样本 | 与单事务比值 |
| --- | --- | --- |
| 每条一个 autocommit | 9480 / 10323 / 10575 ms | **717–1053×** |
| 每 500 条一提交 | 22 / 26 / 26 ms | 345–431× 快于逐条 |
| 全部一个事务 | 9 / 10 / 13 ms | 1× |

`PRAGMA synchronous=0/1/2/3` 在单事务批量下只差 8→10 ms（20%），因为整个事务只 sync 一次。**导入数据先包事务，比调任何 PRAGMA 都有效。**

**Qt 连接管理踩到的三条原文警告**（用 `qInstallMessageHandler` 抓的）：

```text
WARN QSqlDatabasePrivate::addDatabase: duplicate connection name 'n1', old connection removed.
WARN QSqlDatabasePrivate::removeDatabase: connection 'busy' is still in use, all queries will cease to work.
database("no_such_conn") -> isValid=0  lastError=[Driver not loaded Driver not loaded]
```

`QSqlDatabase::cloneDatabase(src, "ro")` + `setConnectOptions("QSQLITE_OPEN_READONLY")` 得到只读视图：

```text
RO 连接 SELECT -> OK       RO 连接 INSERT -> attempt to write a readonly database
QSQLITE_BUSY_TIMEOUT=250：A 连接 BEGIN EXCLUSIVE，B 连接 INSERT
  -> database is locked，实测等待 752 ms 后失败
QSQLITE_ENABLE_REGEXP：不开 -> no such function: regexp ；开了 -> 'abc' regexp 'b' = 1
QSQLITE_NO_USE_EXTENDED_RESULT_CODES -> nativeErrorCode=19；默认（扩展码）=1555（=19|6<<8，SQLITE_CONSTRAINT_UNIQUE）
prepare+bind 20k 行 = 35/38/42 ms，每条拼字符串重新解析 = 63/69/83 ms，比值 1.75–2.13×
```

## 十、MySQL 侧的差异：本节未在本机实测

上面每一条都是 SQLite 的真值。下面这些是文档/标准语义层面的对照，**没有一条在本机验证过**（本机无 MySQL 服务），需要在有实例的环境逐条复核后再写进你的规范：

- **`VARCHAR(10)` 的长度限制、`utf8mb4` 与字符集/排序规则**：MySQL 会真的校验长度并在严格模式下报错；`utf8mb4_general_ci` 与 `utf8mb4_0900_ai_ci` 的大小写/重音判定会影响唯一约束——**需要复核**。
- **`PRIMARY KEY` 隐含 `NOT NULL`，`AUTO_INCREMENT` 必须是某个键的首列**，InnoDB 的表本身就是按主键组织的聚簇索引（与 SQLite 的 rowid 逻辑相近，但**没有独立的 rowid 列可查**，`_ROWID_` 别名行为不同）——**需要复核**。
- **外键在 InnoDB 默认可用且需要子表索引**，`ON DELETE RESTRICT`/`NO ACTION` 的措辞与 SQLite 的 `NO ACTION`（立即检查）语义不完全相同——**需要复核**。
- **`ALTER TABLE` 的在线变更（`ALGORITHM=INPLACE`/`COPY`、`LOCK=NONE`）** 与 `CHECK` 约束在 MySQL 8.0.16 之前不生效——**需要复核**。
- **`EXPLAIN` 的输出字段（`type`/`key`/`rows`/`Extra`）**与本文的 `EXPLAIN QUERY PLAN` 完全不同格式，第七节那张"选择性反转"的表**不能直接照搬到 MySQL**：InnoDB 的聚簇索引、二级索引叶子带主键、回表代价模型都不同——**必须实测**。

## 十一、小结

- **SQLite 的类型是亲和性的**：`VARCHAR(10)` 收 20 字符、`INTEGER` 列能存 `'abc'`，长度/精度不校验；但主键、UNIQUE、NOT NULL、CHECK 是真 enforced，报错原文形如 `UNIQUE constraint failed: cst.code`。
- **主键选型就是存储选型**：`INTEGER PRIMARY KEY` = rowid 别名（不建 autoindex，`rowid` 与它相等，可显式写 2^40）；`TEXT`/复合主键要额外唯一索引，且**不隐含 NOT NULL**（两张 NULL 实测都进去了）。`AUTOINCREMENT` 唯一保证是"号不复用"（`sqlite_sequence` 记 4，`pk_p` 复用 3）。
- **外键默认 OFF**，事务内改不动（no-op），孤儿一旦写进去 `integrity_check` 依旧返回 `ok`——审计要用 `PRAGMA foreign_key_check`。CASCADE / SET NULL / UPDATE CASCADE 三种动作实测行为见第五节表。
- **范式化付的是空间与更新代价的账**：100k 订单反范式 = **+1.83× 字节、+1.25× 写入、改名多改 100× 行**，读侧只在"结果集里要带客户字段"时快 1.5–2.6 倍，全表汇总打平。
- **索引的点查收益实测 71×，但 20% 命中时反而慢 2.6×、100% 命中慢 6.4×**；每个二级索引实测吃 10–19 B/行；`DROP INDEX` 不还空间，要 `VACUUM`。
- **导入数据必须包事务**：逐条 autocommit vs 单事务实测差 717–1053×，而 WAL/synchronous 只有 20% 级别的影响。
- **Qt 层三件事**：`PRAGMA foreign_keys`/`synchronous` 每连接重设（`page_size`/`journal_mode`/`user_version` 持久）；连接名重复会静默替换旧连接并 WARN，`removeDatabase` 时留着 `QSqlQuery` 也 WARN；`QSQLITE_OPEN_READONLY`、`QSQLITE_BUSY_TIMEOUT`、`QSQLITE_ENABLE_REGEXP`、`QSQLITE_NO_USE_EXTENDED_RESULT_CODES` 这几个连接选项实测有效，其中扩展结果码能把 `19` 细化成 `1555`。
- MySQL 相关的表述集中在第十节，**全部未在本机实测**。

下一节进入查询本身：四种 JOIN 的结果行数、`NULL` 参与的三值逻辑为什么会把 `NOT IN` 变成空集、`GROUP BY` 裸列的取值规则，以及同一语义的五种写法在 10 万行上的实测差距。
