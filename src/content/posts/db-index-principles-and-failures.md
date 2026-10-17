---
title: 索引原理与失效场景：把数据库文件剖开看树
description: 把数据库文件剖开：10 万行的表占 909 页、索引字节数精确等于页数×4096；40 条 EXPLAIN QUERY PLAN 原文钉死最左前缀；表达式索引快 96 倍，覆盖索引快 165 倍。
date: 2026-10-16
tags: [数据库, SQLite, 索引, B+树, 查询计划]
category: database
section: db-index
---

> 环境同第 1、2 节：Windows 11 x64，**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ `Qt6::Sql`，插件 `plugins/sqldrivers/qsqlite.dll`，GCC 13.1.0，无头运行，**SQL 引擎是 Qt 内嵌的 SQLite 3.50.4**。本节三个探针都留存在本机：主探针 `p10_index.cpp`（**独立重跑 4 次**）、小库逐页解剖样本 `p11_pages.cpp`（单次，输出是确定性的字节解剖）、主键形态与 LIKE 复核样本 `p12_pk.cpp`（**重跑 3 次**）。
>
> 计时口径：每条 SQL 进程内连跑 3–40 次取最好值，再取多次独立运行的**中位数 + 区间**。同机同期还有其它 agent 在抢 CPU，**比值比绝对值可靠**。语义类证据（页数、cell 数、`EXPLAIN QUERY PLAN` 原文、报错原文）各次运行逐字节一致。
>
> 本节只讲索引本身。`EXPLAIN QUERY PLAN` 怎么读、JOIN 顺序怎么写是第 2、9 节的事，第 2 节已经测过的东西（每索引 10–19 B/行、点查 71 倍、选择性反转、`DROP INDEX` 不还空间、加索引让 LEFT JOIN 慢 6 倍、补覆盖索引反超 2.9 倍、`AUTOMATIC COVERING INDEX`）本节**只引用不重测**，全部往新维度走。

## 一、先确认本机能不能看页：`dbstat` 不存在，那就自己解析文件

想用 `dbstat` 虚表直接查"每个对象占多少页"，结果是这样：

```text
  Q> select name from pragma_module_list order by name
     fts3 | fts3tokenize | fts4 | fts4aux | fts5 | fts5vocab | geopoly
     json_each | json_tree | pragma_module_list | rtree | rtree_i32
  Q> select count(*) from dbstat
   FAIL> no such table: dbstat Unable to execute statement
  Q> select count(*) from sqlite_stat4
   FAIL> no such table: sqlite_stat4 Unable to execute statement
```

`pragma_compile_options` 给出了原因：Qt 这颗 `qsqlite.dll` 打开了 `ENABLE_FTS3/4/5`、`ENABLE_RTREE`、`ENABLE_GEOPOLY`、`ENABLE_MATH_FUNCTIONS`、`DIRECT_OVERFLOW_READ`，但**没有 `ENABLE_DBSTAT_VTAB`，也没有 `ENABLE_STAT4`**；关键默认值有 `DEFAULT_PAGE_SIZE=4096`、`DEFAULT_CACHE_SIZE=-2000`、`DEFAULT_SYNCHRONOUS=2`、`DEFAULT_WAL_AUTOCHECKPOINT=1000`、`MAX_ATTACHED=10`。

所以本节改用**最笨也最硬的办法**：把 `.sqlite` 文件当二进制读进内存，自己按 SQLite 文件格式走树。这样得到的每个数字都不依赖任何工具是否被编译进来。

## 二、一个 16 页的小库，逐页解剖

建 `t(id INTEGER PRIMARY KEY, name TEXT, num INTEGER)` 插 1000 行（`name='row-0001'`，`num=i%250`），再建两个索引 `i_num(num)`、`i_name(name)`。文件 **65536 字节 = 16 页**，`sqlite_master` 里的 rootpage 是 `t=2 / i_num=8 / i_name=12`。下面是每一页头 16 字节的原文（页 1 的 b-tree 头从偏移 100 开始，其余页从页首开始）：

```text
-- page 1  文件偏移 100   头 16 字节: 0D 00 00 00 03 0F 4E 00 0F B1 0F 81 0F 4E 00 00
   type=13(叶子表页)  第一个空闲块=0  ncell=3  内容区起点=3918  碎片=0
   cell0 偏移=4017  varint(长度=77) varint(rowid=1) 记录=['table'(5B) | 't'(1B) | 't'(1B) | 2]
   cell1 偏移=3969  varint(长度=46) varint(rowid=2) 记录=['index'(5B) | 'i_num'(5B) | 't'(1B) | 8]
   cell2 偏移=3918  varint(长度=49) varint(rowid=3) 记录=['index'(5B) | 'i_name'(6B) | 't'(1B) | 12]

-- page 2  文件偏移 4096  头 16 字节: 05 00 00 00 04 0F E8 00 00 00 00 07 0F FA 0F F4
   type=5(内部表页)  ncell=4  内容区起点=4072  碎片=0  -> 最右子页=7   cell 指针数组起始=4108
   cell0 偏移=4090  左子页=3  之后 varint(rowid 键=228 占2B)  【无数据】
   cell1 偏移=4084  左子页=4  之后 varint(rowid 键=450 占2B)  【无数据】
   cell2 偏移=4078  左子页=5  之后 varint(rowid 键=672 占2B)  【无数据】
   cell3 偏移=4072  左子页=6  之后 varint(rowid 键=894 占2B)  【无数据】

-- page 3  文件偏移 8192  头 16 字节: 0D 00 00 00 E4 01 DB 00 0F F2 0F E3 0F D4 0F C5
   type=13(叶子表页)  ncell=228  内容区起点=475
   cell0 偏移=4082  varint(长度=12) varint(rowid=1) 记录=[NULL | 'row-0001'(8B) | 1(常量,0字节)]
   cell1 偏移=4067  varint(长度=13) varint(rowid=2) 记录=[NULL | 'row-0002'(8B) | 2]

-- page 8  文件偏移 28672  头 16 字节: 02 00 00 00 02 0F EA 00 00 00 00 0B 0F F6 0F EA
   type=2(内部索引页)  ncell=2  内容区起点=4074  -> 最右子页=11  指针数组起始=28684
   cell0 偏移=4086  左子页=9   之后 varint(长度=5) 记录=[117 | 117]
   cell1 偏移=4074  左子页=10  之后 varint(长度=7) 记录=[220 | 720]

-- page 9  文件偏移 32768  头 16 字节: 0A 00 00 01 D4 03 B1 00 0F FA 0F F4 0F EE 0F E8
   type=10(叶子索引页)  ncell=468  内容区起点=945
   cell0 偏移=4090  varint(长度=5) 记录=[0(常量,0字节) | 250]
   cell1 偏移=4084  varint(长度=5) 记录=[0(常量,0字节) | 500]
   cell2 偏移=4078  varint(长度=5) 记录=[0(常量,0字节) | 750]
   cell3 偏移=4072  varint(长度=5) 记录=[0(常量,0字节) | 1000]

-- page 13  文件偏移 49152  type=10(叶子索引页)  ncell=263
   cell0 偏移=4084  varint(长度=11) 记录=['row-0001'(8B) | 1(常量,0字节)]

==== 全文件页类型普查 ====
  叶子表页(13)=6  叶子索引页(10)=7  内部表页(5)=1  内部索引页(2)=2  其他=0
```

十件事一次说清，全部能在上面的原文里指认：

1. **页是唯一起始单位**：文件 = 页数组，页号从 1 开始，页 N 的文件偏移 = `(N-1) × page_size`；页 1 的前 100 字节是数据库头，所以它的 b-tree 头在偏移 100。
2. **页头字段**：`[0]` 类型 1 字节、`[1..2]` 第一个空闲块、`[3..4]` **cell 数 ncell**、`[5..6]` 内容区起点（0 表示 65536）、`[7]` 碎片字节数。页 1 的 `ncell=3` 就是 `sqlite_master` 里的 3 行（1 表 + 2 索引），对得上；cell 里解出的 4 个值正是它的前 4 列 `type/name/tbl_name/rootpage`（解析器限幅只解 4 列，第 5 列 `sql` 没解）。
3. **类型字节的真实语义（实测反推，比记口诀可靠）**：`bit0=0` 是索引树、`bit0=1` 是表树；`bit3=0` 是内部页、`bit3=1` 是叶子页。于是 **2=内部索引页、5=内部表页、0x0A=叶子索引页、0x0D=叶子表页**（10/13 都是"表/索引 + 叶子"的合法组合，`3.x` 之后表叶子用 13）。这套映射是我用页里的内容反证出来的：页 2 的 cell 拆成"4 字节子页号 + rowid 键"后完全自洽，页 9 的 cell 拆成"key+rowid 记录"后值正好是 (0,250)(0,500)(0,750)(0,1000)。
4. **cell 指针数组**在页头之后，每项 2 字节，指向页内偏移；**数组按 key 顺序排列**，所以页 3 的指针是 4082、4067、4052、4037（递减），而内容区从页尾往前长。
5. **内部页多一个字段**：页头之后紧跟 **4 字节的"最右子页号"**（页 2 = 7，页 8 = 11，页 12 = 16），cell 指针数组从偏移 12 开始。也就是说"最右指针在页尾最后 4 字节"这个流传的说法**在本机的文件里不是这样**——它就在页头正后方。这条很重要：按页尾去找右指针的解析器会得出错误的树。
6. **表叶子页的 cell** = `varint(记录长度) + varint(rowid) + 记录`；**表内部页的 cell** = `4 字节子页号 + varint(rowid 键)`，**不含任何列数据**（页 2 的 4 个 cell 每个只有 6 字节）。
7. **索引叶子页的 cell** = `varint(长度) + 记录`，记录 = 索引列 + 末尾追加的 rowid（页 13 = `['row-0001' | 1]`）。
8. **`id INTEGER PRIMARY KEY` 的列在记录里是一个 NULL 占位**：页 3 cell0 的记录是 `[NULL | 'row-0001' | 1]`——第一列 NULL，真正的 1 在 cell 的 rowid 字段里。这就是第 1 节"`INTEGER PRIMARY KEY` 就是 rowid 别名"的字节级证据，也是它为什么最省空间：**这一列不占记录里的整数空间**。
9. **序列类型（serial type）表**也要按实测记：`0=NULL`、`1..6=` 1–6 字节有符号整数、`7`=8 字节浮点、**`8`=常量 0、`9`=常量 1（不占数据字节）**、`12/14/16…`=偶数→BLOB 长度 `(s-12)/2`、`13/15/17…`=奇数→TEXT 长度 `(s-13)/2`。页 9 那 4 个 cell 的 key 值都是 0，所以只占一个 `0x08` 字节——`num=0` 的行比普通整数还省。
10. **扇出**：页 3 一个 4096 字节的页装了 228 行（内容区起点 475，可用 3621 字节，每行约 15.9 字节），所以 1000 行只需要 5 个叶子页 + 1 个内部页 = 树高 2。

## 三、SQLite 的索引树不是教科书 B+ 树：内部节点存完整 key

上面页 8（`i_num` 的根，`type=2`）的两个 cell 是 `[117 | 117]` 和 `[220 | 720]`——**完整的 (key, rowid) 对**，而且这些 key 在叶子页里**不再重复出现**（页 9 装的是 num=0 的那批，页 10、11 装别的区间）。页 2（表 `t` 的根，`type=5`）的 cell 只有一个 rowid 数字，没有任何列。

结论和教科书不一样，值得写进认知清单：

| 树 | 内部节点里有什么 | 数据在哪里 |
| --- | --- | --- |
| 表 B 树（rowid 树） | 只有 4 字节子页号 + rowid 分隔键 | 只在叶子（完整记录） |
| 索引 B 树 | 4 字节子页号 + **完整 key 记录（含 rowid）** | key 在整棵树上**只出现一次**，行数据不在树里 |

所以：**表树是 B+ 树，索引树更接近 B 树**。工程后果有两条：其一，索引的内部页也会直接给出 key，`min(key)`/`max(key)` 这类查询不需要走到叶子；其二，索引内部页比"只存分隔键"更占地方，但它换来了"每个 key 只有一份"，索引总大小仍然由叶子主导（实测：`i_c` 259 页里 258 页是叶子）。

至于 MySQL InnoDB 的二级索引叶子存的是主键而非行、内部节点存什么，**本机无法验证**，见第十四节。

## 四、树高与页账本：一次点查要读几页

把探针 `p10` 的实验库 `idx3.sqlite`（15293 页 / 62640128 字节）整本走一遍，每个对象的树形都是精确可核对的：

```text
  对象                     root  层数 内部页 叶子页 cell总数 叶子cell 每叶页cell 平均cell字节 叶页填充率
  t:customers               2     2    1       6     1005     1000     166.7       19.5       79.35%
  t:orders                  3     3    3     906   100905   100000     110.4       31.0       83.57%
  t:t3                   3411     3    7    2250   102249   100000      44.4       79.0       85.71%
  t:tlow                 6589     3    4    1305   101304   100000      76.6       47.1       88.19%
  t:pk_int               7898     3    3     809   100808   100000     123.6       27.0       81.48%
  t:pk_txt               7900     3    4    1199   101198   100000      83.4       42.9       87.33%
  t:conv                10600     2    1     116    20121    20006     172.5       18.4       77.55%
  i:i_c                   918     2    1     258   100000    99743     386.6        7.5       71.18%
  i:i_ca                 1177     3    3     348   100000    99653     286.4       11.2       78.40%
  i:i_note               1528     3    8     735   100000    99266     135.1       27.1       89.46%
  i:i_amt               13730     3    3     278   100000    99723     358.7        8.3       73.07%
  i:i_part               3384     2    1      26     9997     9972     383.5        7.5       70.59%
  i:i_abc                5668     3    4     420   100000    99581     237.1       14.2       82.20%
  i:i_name               6092     3    4     493   100000    99508     201.8       17.2       84.60%
  i:sqlite_autoindex_pk_txt_1 7901 3  6     681   100000    99320     145.8       21.6       76.77%
```

五条直接可用的推论：

1. **叶子 cell 数 = `select count(*)`**（`customers` 1000、`orders` 100000、`conv` 20006）——走树的结果和 SQL 查的结果互相同步校验，说明这本账可信。
2. **cell 总数与叶子 cell 的差，就是"住在内部页里的 key 数"，而两种树的规律不同**：`orders` 是 100905 vs 100000 → 3 个内部页里躺着 905 个**分隔 rowid**，而 100000 条**记录**全部在叶子；`i_c` 是 100000 vs 99743 → 1 个内部页里有 257 个**完整的 key**，且 `cell 总数恰好 = 行数`。这条算术就是第三节结论的硬证据：**表树是 B+ 树（数据只在叶子），索引树是 B 树（key 在整棵树上只出现一次）**。
3. **`i_part` 只有 9997 个 cell**，正好等于 `where amount > 90000` 的行数（实测 9997）。**部分索引只把满足 WHERE 的行放进去**，这条第一次在字节级被证实。
4. **树高就是 I/O 次数**：`orders` 树高 3 → 一次按 rowid 的定位最多 3 次页读（根 + 内部 + 叶子）；`i_c` 树高 2 → 2 次；**用 `i_c` 找到 rowid 再回 `orders` 取行 = 2 + 3 = 5 次页读**。第 2 节测到"点查快 71 倍"的物理原因就是 5 次页 vs 909 次页（全表扫描）。
5. **索引页的密度远高于表页**：`i_c` 每个叶子页 386.6 个键，`orders` 每个叶子页 110.4 行 → **3.5 倍**。这个数字等下会在第八节被时间实测验证。

顺带把文件级的账也结了：

```text
  总页=15293  走树可达=15257 (99.8%)  不可达=36
  全文件页类型普查: 内部索引页(2)=97 内部表页(5)=28 叶子索引页(10)=7904 叶子表页(13)=7263 其它=1
  Q> pragma freelist_count   ->  35
```

数据库头原文（同一个文件）：

```text
  [0..14]  magic='SQLite format 3'
  [16:2]=4096 页大小  [20:4]=随机数4202528  [28:4]=文件页数15293
  [32:4]=freelist 首链页15270  [36:4]=freelist 页数35  [40:4]=schema cookie44  [44:4]=schema format4
  [52:4]=reserved=0  [56:4]=encoding1(1=UTF8)
  [92:4]=version-valid-for94  [96:4]=SQLITE_VERSION_NUMBER=3050004  读回=3.50.4
```

`[36:4]` 的 35 和 `pragma freelist_count` 的 35 相等，`[28:4]` 的 15293 和 `pragma page_count` 相等——**`pragma` 读的就是这几个字段**，不是另一套账。`[96:4]` 是 `3.50.4` 的编码（`3050004`），`version-valid-for` 与 `[24:4]=94` 配对，用来判定缓存里的 schema 是否还有效。

## 五、索引空间精确到页：第 2 节那张表在这里闭合

第 2 节给了"每个索引 10–19 B/行"，本节把同一批索引的**建索引耗时**和**字节构成**一起量了（同一库逐步加，`page_count × page_size`）：

| DDL | 中位耗时（区间） | 库字节增量 | 增量 ÷ 4096 | 走树数出的页数 |
| --- | --- | --- | --- | --- |
| `CREATE INDEX i_c ON orders(customer_id)` | 44.7 ms（41.3–47.9） | +1060864 | 259 页 | 1 内部 + 258 叶 = **259** ✓ |
| `CREATE INDEX i_ca ON orders(customer_id, amount)` | 55.5 ms（52.9–59.1） | +1437696 | 351 页 | 3 + 348 = **351** ✓ |
| `CREATE INDEX i_note ON orders(note)` | 65.7 ms（62.5–73.4） | +3043328 | 743 页 | 8 + 735 = **743** ✓ |
| `CREATE UNIQUE INDEX u_id_amount ON orders(id, amount)` | 38.3 ms（35.6–38.7） | +1515520 | 370 页 | 3 + 367 = **370** ✓ |
| `CREATE INDEX i_lownote ON orders(lower(note))` | 76.0 ms（74.4–76.1） | +3043328 | 743 页 | 8 + 735 = **743** ✓ |
| `CREATE INDEX i_part ON orders(customer_id) WHERE amount > 90000` | 14.3 ms（13.5–15.6） | +110592 | 27 页 | 1 + 26 = **27** ✓ |

**字节数与页数逐条对上，一页都不多。** 三条新结论：

- **每行 10–19 B 是"短整数键"的情形**。键里塞进变长文本（`note` 长 12–31 字节）后是 **30.4 B/行**；表达式索引 `lower(note)` 与原列索引**一模一样大**（都是 743 页）——因为它存的就是那个算好的字符串。
- **部分索引的代价与"命中行数"成正比**：`i_part` 只覆盖 9997/100000 行，代价 110592 字节 ≈ 11 B/行（按全集摊）或 11 B/被索引行，建索引 14.3 ms ≈ 全表索引的 1/3。**"选择性好的 WHERE 条件"能把索引成本按比例砍掉。**
- **`CREATE UNIQUE INDEX` 不比普通索引贵**：`u_id_amount` 370 页 / 38.3 ms，比 `i_ca`（351 页 / 55.5 ms）页数还多一点、耗时反而少——唯一性检查的代价在**插入时**而不是建索引时（第十二节测到了写放大）。

## 六、最左前缀：18 条 SQL 的 `EXPLAIN QUERY PLAN` 原文

表 `t3(a,b,c,name,pad)` 100000 行：`a` 有 1000 个不同值（每值 100 行）、`b` 有 10000 个、`c` 近似唯一；索引 `i_abc ON t3(a,b,c)`、`i_name ON t3(name)`。`pragma index_info('i_abc')` 确认键序是 `0|0|a`、`1|1|b`、`2|2|c`。中位耗时取 4 次运行。

| # | 谓词 | 计划原文 | 命中行 | 中位 |
| --- | --- | --- | --- | --- |
| 1 | `a=500` | `SEARCH t3 USING COVERING INDEX i_abc (a=?)` | 100 | 0.162 ms |
| 2 | `b=500` | `SCAN t3 USING COVERING INDEX i_abc` | 15 | **2.417 ms** |
| 3 | `c=500` | `SCAN t3 USING COVERING INDEX i_abc` | 1 | 2.744 ms |
| 4 | `a=500 AND b=500` | `SEARCH ... i_abc (a=? AND b=?)` | 0 | 0.116 ms |
| 5 | `b=500 AND a=500` | `SEARCH ... i_abc (a=? AND b=?)` | 0 | 0.118 ms |
| 6 | `a=500 AND c=500` | `SEARCH ... i_abc (a=?)` | 0 | 0.118 ms |
| 7 | `b=500 AND c=500` | `SCAN t3 USING COVERING INDEX i_abc` | 0 | 2.285 ms |
| 8 | `a=500 AND b=500 AND c=500` | `SEARCH ... (a=? AND b=? AND c=?)` | 0 | 0.114 ms |
| 9 | `a>500 AND b=500` | `SEARCH ... (a>?)` | 8 | 1.183 ms |
| 10 | `a=500 AND b>500 AND c=500` | `SEARCH ... (a=? AND b>?)` | 0 | 0.122 ms |
| 11 | `a IN (500,501) AND b=5` | `SEARCH ... (a=? AND b=?)` | 0 | 0.127 ms |
| 12 | `(a,b) IN ((500,5),(501,6))` | `SEARCH ... (a=? AND b=?)` + `LIST SUBQUERY 4` / `SCAN 2 CONSTANT ROWS` / `CREATE BLOOM FILTER` | 0 | 0.128 ms |
| 13 | `a=500 AND name LIKE 'a%'` | `SEARCH t3 USING INDEX i_abc (a=?)`（**不是 COVERING**，name 要回表） | 5 | 0.170 ms |
| 14 | `a=500 AND name LIKE '%a'` | 同 13 的计划 | 5 | 0.155 ms |
| 15 | `a+0=500` | `SCAN t3 USING COVERING INDEX i_abc` | 100 | **2.702 ms** |

读法：

- **`SEARCH` vs `SCAN` 是第一判别**：`SEARCH ... USING INDEX` = 用索引定位（有 seek key）；`SCAN ... USING COVERING INDEX` = **把索引当"窄表"整本扫一遍**，索引还在，但没有 seek。第 2、3、7、15 行就是这个状态：索引没被"忽略"，但退化成一次全索引扫描。
- **括号里写的是"真正参与 seek 的列"**，这是最左前缀最诚实的呈现：`a=? AND c=?` 只打印 `(a=?)`（第 6 行）——`c` 完全没参与定位，因为 `b` 断了链；`a>? AND b=?` 只打印 `(a>?)`（第 9 行）——**范围条件之后的列不能再用**，所以第 9 行扫了 49900 个键才挑出 8 行；`a=500 AND b>500 AND c=500` 打印 `(a=? AND b>?)`（第 10 行）——`b` 的范围可以用，但 `c` 又不行了。
- **WHERE 里书写顺序无关**（第 4 与第 5 行计划一字不差），**优化器看的是索引列的顺序，不是你打字顺序**。
- **`IN` 不会打断链**（第 11、12 行仍然 `(a=? AND b=?)`），SQLite 把 `IN` 展开成多次 seek；行构造器 `(a,b) IN (...)` 也能吃到两列，代价是那句 `CREATE BLOOM FILTER`。
- **`a+0=500` 让索引退化成 SCAN**（第 15 行）：列出现在表达式里，优化器不做代数化简。

## 七、`ORDER BY` 的方向能不能白拿

| SQL | 计划 | 中位 |
| --- | --- | --- |
| `ORDER BY a,b,c LIMIT 3` | `SCAN t3 USING COVERING INDEX i_abc` | 0.113 ms |
| `ORDER BY a DESC, b DESC, c DESC LIMIT 3` | **同上，一字不差** | 0.114 ms |
| `ORDER BY a ASC, b DESC LIMIT 3` | `SCAN ... USING COVERING INDEX i_abc` + `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` | 0.190 ms |
| `ORDER BY b LIMIT 3` | `SCAN ... USING COVERING INDEX i_abc` + `USE TEMP B-TREE FOR ORDER BY` | **3.345 ms** |
| `ORDER BY c LIMIT 3` | 同上 | 4.214 ms |
| `WHERE a=5 ORDER BY b DESC LIMIT 3` | `SEARCH ... (a=?)`（无 TEMP B-TREE） | 0.123 ms |
| `WHERE a=5 ORDER BY b, c DESC LIMIT 3` | `SEARCH ... (a=?)` + `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` | 0.123 ms |

- **全反向是免费的**：`a DESC, b DESC, c DESC` 的计划与正向完全相同——SQLite 会**反向走叶子链表**，不建临时 B 树。"降序索引"这个需求在 SQLite 上不存在。
- **混合方向只惩罚最后一项**：`USE TEMP B-TREE FOR LAST TERM OF ORDER BY` 是 SQLite 很聪明的实现——前缀 `a ASC` 仍按索引序，只对每个 `a` 内部的 `b` 排序。所以代价远小于整序（0.190 vs 3.345 ms）。
- **`ORDER BY b`（跳过低基数首列之后）才是真贵**：3.345 ms，比索引可用的那条慢 **30 倍**。
- `WHERE a=5 ORDER BY b DESC`：等值 + 单列排序，反向扫描依旧免费（0.123 ms）。

## 八、负结果：首列低基数时 SQLite 不会跳扫

教科书说"首列基数低时可以做 index skip scan"。实测 `tlow(g,h)` 100000 行、`g` 只有 5 个值（每组 19835–20105 行）、索引 `i_gh(g,h)`：

```text
  EQP> select count(*) from tlow where h=12345
     SCAN tlow USING COVERING INDEX i_gh        <- 没有 skip scan 这类字样
  EQP> select count(*) from tlow where h=12345
     SCAN tlow                                  <- 删掉索引之后
```

中位耗时：有索引 **2.191 ms**（2.040–2.386）、无索引 **8.206 ms**（7.582–8.833）、`g=3 AND h=12345`（完整左前缀）**0.123 ms**。

诚实结论：**本机 SQLite 3.50.4 不做跳扫**（`h=12345` 的计划就是整本扫索引），但"扫索引"比"扫表"快 **3.75 倍**——这个比值和第四节页账本算出的 **3.5 倍**（`i_c` 259 页 vs `orders` 909 页）对上，两套完全独立的证据（时间 / 页数）互相印证。所以"索引失效"要分清层次：**列没被 seek（SCAN USING INDEX）不等于索引没用**，它仍然带来 3.7 倍的常数收益，只是没拿到 O(log N)。

## 九、覆盖索引与回表：同一谓词，换一列取就换一个数量级

第 2 节已经证明"缺列导致 10 万次回表，一条 LEFT JOIN 慢 6 倍"。本节把**回表代价本身**拆开量。

**(a) 判别法 + 点查（`orders` 里 `customer_id=42` 有 96 行）**

| SQL | 计划原文 | 中位 |
| --- | --- | --- |
| `select count(*) ...` | `SEARCH orders USING COVERING INDEX i_c (customer_id=?)` | 0.117 ms |
| `select sum(amount) ...` | `SEARCH ... USING COVERING INDEX i_ca (customer_id=?)` | 0.119 ms |
| `select id ...` | `SEARCH ... USING COVERING INDEX i_c (customer_id=?)` | 0.127 ms |
| `select note ...` | `SEARCH orders USING INDEX i_c (customer_id=?)` | 0.166 ms |
| `select * ...` | `SEARCH orders USING INDEX i_c (customer_id=?)` | 0.165 ms |
| `select sum(amount) ... BETWEEN 42 AND 45` | `SEARCH ... USING COVERING INDEX i_ca (customer_id>? AND customer_id<?)` | 0.126 ms |
| 同 `count(*)` 但 `FROM orders NOT INDEXED` | `SCAN orders` | **6.675 ms** |

`COVERING` 这个词就是判据：**计划里出现 `USING INDEX`（没有 COVERING）就意味着要回表**。另外注意第三行——`select id` 是 rowid，**索引的每条记录尾部本来就带 rowid**，所以取 rowid 永远不需要回表，这也是 `count(*)` 能覆盖的原因。`NOT INDEXED` 是同一条 SQL 上最干净的对照：**索引 vs 全表 = 53 倍**。

**(b) 范围命中 50% 时，回表有多贵（100000 行，`amount BETWEEN 1 AND 50000` = 49792 行）**

| SQL | 计划 | 中位（区间） |
| --- | --- | --- |
| `select count(*) ... amount BETWEEN 1 AND 50000` | `SEARCH ... USING COVERING INDEX i_amt (amount>? AND amount<?)` | 1.08 ms（1.04–1.21） |
| `select note ... amount BETWEEN 1 AND 50000` | `SEARCH ... USING INDEX i_amt (amount>? AND amount<?)` | **178.8 ms**（172.2–203.5） |
| `select count(*) ... amount BETWEEN 99000 AND 100000`（1019 行） | `SEARCH ... USING COVERING INDEX i_amt` | 0.132 ms |
| `select note ... amount BETWEEN 99000 AND 100000` | `SEARCH ... USING INDEX i_amt` | 4.98 ms（3.49–5.07） |
| `select count(*) ... NOT INDEXED`（同 50% 范围） | `SCAN orders` | 9.46 ms（7.26–13.13） |

**同一个谓词、同一个索引，只是取哪一列不同，1.08 ms → 178.8 ms，差 165 倍。** 更反直觉的一格：50% 命中时**不回表的覆盖索引（1.08 ms）比全表扫描（9.46 ms）还快 8.8 倍**——第 2 节"20% 命中时索引反而慢 2.6 倍"的那笔账，元凶从来不是索引，而是回表；只要能不回表，即使命中一半数据，索引依旧完胜。

**(c) 回表的"局部性"实验：计划完全相同，代价差 44%**

`loc.sqlite`（30000 行 ×(k INT, v TEXT×160B)，2769 页），两张表数据完全同分布，唯一区别是：`t_seq` 里 `k` 与 rowid 同序（索引顺序 = 物理顺序），`t_rnd` 里 `k` 与 rowid 反序（最坏乱序）。

```text
  EQP> select count(length(v)) from t_seq where k between 10000 and 11000
     SEARCH t_seq USING INDEX i_seq (k>? AND k<?)
  EQP> select count(length(v)) from t_rnd where k between 10000 and 11000
     SEARCH t_rnd USING INDEX i_rnd (k>? AND k<?)     <- 计划一模一样
```

| 配置 | rowid 同序 | rowid 反序 | 同条件不回表（覆盖） |
| --- | --- | --- | --- |
| 默认 `cache_size=-2000`（≈2 MB） | 0.234 ms（0.212–0.237） | 0.337 ms（0.311–0.339）**1.44×** | — |
| `PRAGMA cache_size=8`（8 页） | 0.409 ms（0.392–0.589） | 0.516 ms（0.495–1.381）**1.26×** | 0.127 ms（0.121–0.148） |

**回表罚金的两个来源被分开了**：数据全在页缓存里时，乱序只贵 44%（寻址与重组开销）；缓存被压到 8 页时，不回表的覆盖路径是 0.127 ms，而乱序回表是 0.516 ms = **4.1 倍**（同序 3.2 倍）。所以"回表慢"本质是**随机页访问 + 缓存装不下**；库里数据能全部驻留时，回表没那么可怕——这也解释了为什么本机 100k 行的 `select note`（0.166 ms）看起来毫无痛苦，而 50% 范围的 `select note`（178 ms）惨不忍睹：**行数从 96 涨到 49792 之后，随机页访问数量超过了缓存容量**。

**(d) 主键形态就是"要不要永久回表"**（探针 `p12_pk.cpp`，同样 100000 行、同样 24 字节的 `v` 列）

```text
  EQP> select v from pk_int where id=50000
     SEARCH pk_int USING INTEGER PRIMARY KEY (rowid=?)
  EQP> select v from pk_txt where id='uuid-0050000-450'
     SEARCH pk_txt USING INDEX sqlite_autoindex_pk_txt_1 (id=?)     <- 二级索引，命中后还要按 rowid 回表
```

| 对象 | 走树数出的页 | 折合字节 |
| --- | --- | --- |
| `pk_int` 表树（`INTEGER PRIMARY KEY`） | 3 内部 + 809 叶 = 812 页 | 3325952 |
| `pk_txt` 表树 + `sqlite_autoindex_pk_txt_1` | (4 + 1199) + (6 + 681) = **1890 页** | 7741440 |

`pk_txt` 光主键文本就占 `sum(length(id))` = **1588964 字节**，加上 autoindex 的 687 页，**同样 10 万行贵了 2.33 倍**。时间上：点查各 40 次取 best、3 次运行中位——`pk_int` 0.100 ms vs `pk_txt` 0.101 ms（**差 1%，测不出来**，一次 autoindex seek + 一次 rowid 定位都在同一批已缓存的页里）；范围 1000 行则 `0.251 ms` vs `0.301 ms` = **1.20 倍**，`select rowid` 反而与 `pk_int` 打平（0.101 ms，因为不需要回表）。

结论与第 1 节呼应、并给它补上物理依据：**`INTEGER PRIMARY KEY` 是"数据即索引"，其它任何形式的主键都等于"永久挂一个唯一索引 + 每次查询固定回表"**。点查感知不到，范围/连接/排序会按倍数放大，空间则立刻贵一倍以上。

## 十、索引失效写法清单（全部贴计划原文）

`i_name ON t3(name)`（100000 行，name 是 8–15 字符小写随机文本）：

| 写法 | 计划 | 中位 |
| --- | --- | --- |
| `lower(name)='aaaaaaaa'` | `SCAN t3 USING COVERING INDEX i_name` | **16.20 ms** |
| `upper(name)='AAAAAAAA'` | 同上 SCAN | 19.30 ms |
| `substr(name,1,3)='aaa'` | 同上 SCAN | 9.58 ms |
| `length(name)=8` | 同上 SCAN | 7.04 ms |
| `cast(name as text)='aaaaaaaa'` | 同上 SCAN | 6.07 ms |
| `name || '' = 'aaaaaaaa'` | 同上 SCAN | 6.47 ms |
| `coalesce(a,0)=5` | `SCAN t3 USING COVERING INDEX i_abc` | 2.47 ms |
| `name = 'aaaaaaaa'` | `SEARCH ... USING COVERING INDEX i_name (name=?)` | 0.191 ms |
| `name LIKE 'aaaaaaaa'`（无通配符） | `SCAN t3 USING COVERING INDEX i_name` | 5.77 ms |
| `name GLOB '*aaa*'` | `SCAN ...` | 9.56 ms |
| `name GLOB 'aaa*'` | `SEARCH ... (name>? AND name<?)` | 0.162 ms |
| `name LIKE 'ab%'` | `SEARCH ... USING COVERING INDEX i_t3_nc (name>? AND name<?)` | 0.121 ms |
| `name LIKE 'a%b%'` | `SEARCH ... i_t3_nc (name>? AND name<?)`（只吃前缀） | 0.587 ms |
| `name LIKE '%aaa%'` | `SCAN`（中缀无法 seek） | 9.23 ms |
| `name>='ab' AND name<'ac'`（手写范围） | `SEARCH ... USING COVERING INDEX i_name (name>? AND name<?)` | 0.110 ms |

小库 `p12`（50000 行，`name='nm-1'..'nm-50000'`，同时有 `i_name` 与 `i_nc(name COLLATE NOCASE)`）把上面几条的计划原文再钉了一遍，并且给出 LIKE/GLOB 各自挑哪个索引：

```text
  EQP> select count(*) from t3 where name like '%aaa%'
     SCAN t3 USING COVERING INDEX i_nc                <- 中缀：整本扫索引
  EQP> select count(*) from t3 where name like 'nm-1%'
     SEARCH t3 USING COVERING INDEX i_nc (name>? AND name<?)   命中=11111  best 0.476 ms
  EQP> select count(*) from t3 where name LIKE 'NM-1%'
     SEARCH t3 USING COVERING INDEX i_nc (name>? AND name<?)   命中=11111  best 0.436 ms
  EQP> select count(*) from t3 where name >= 'nm-1' and name < 'nm-2'
     SEARCH t3 USING COVERING INDEX i_name (name>? AND name<?) 命中=11111  best 0.352 ms
  EQP> select count(*) from t3 where name GLOB 'nm-1*'
     SEARCH t3 USING COVERING INDEX i_name (name>? AND name<?) 命中=11111  best 0.361 ms
  EQP> select count(*) from t3 where name GLOB '*-1*'
     SCAN t3 USING COVERING INDEX i_nc               命中=11111  best 2.429 ms
```

`LIKE 'NM-1%'` 用大写也能命中 11111 行**并且仍然 seek**——这就是"默认 `LIKE` 走 NOCASE 语义"的直接证据（库里的值全是小写），也解释了为什么它挑 `i_nc` 而显式 `>=`/`<` 和 `GLOB`（天生大小写敏感）挑 `i_name`。**`LIKE`/`GLOB` 的前缀形态都能用索引，中缀形态都不能**，代价从 0.35 ms 跳到 2.4 ms（50000 行）。

`OR` / `!=` / `IS NULL` 组：

| 写法 | 计划 | 中位 |
| --- | --- | --- |
| `a=5 OR b=5`（`b` 无独立可用索引） | `SCAN t3 USING COVERING INDEX i_abc` | 3.35 ms |
| `a=5 OR pad='zz'`（`pad` 有 `i_pad`） | **`MULTI-INDEX OR`** → `INDEX 1: SEARCH USING INDEX i_abc (a=?)` / `INDEX 2: SEARCH USING INDEX i_pad (pad=?)` | 0.135 ms |
| `a=5 OR name='aaaaaaaa'` | `MULTI-INDEX OR`（i_abc + i_name） | 0.129 ms |
| `a<>5` / `a NOT IN (5,6)` / `NOT (a=5)` | 全部 `SCAN t3 USING COVERING INDEX i_abc` | 2.93 / 3.32 / 2.38 ms |
| `pad IS NULL` | `SEARCH ... USING COVERING INDEX i_pad (pad=?)` | 0.341 ms |
| `pad IS NOT NULL` | `SEARCH ... USING COVERING INDEX i_pad (pad>?)` | 9.33 ms |
| `a=5 AND NOT (b=6)` | `SEARCH ... i_abc (a=?)` | 0.159 ms |

四条要点：

1. **`MULTI-INDEX OR` 是真实存在的计划节点**（SQLite 用一个临时 rowid 集合合并多路 seek），所以"OR 一定让索引失效"**不成立**：条件是 `a=5 OR pad='zz'` 时是 0.135 ms，条件是 `a=5 OR b=5`（`b` 只是复合索引的第二列）时是 3.35 ms。**决定成败的是"OR 的每一侧能不能各自 seek"，不是 OR 这个字。**
2. **`!=` / `NOT IN` / `NOT` 一律 SCAN**（它们定义的是"除了一小块之外的全部"，本来就该扫），但**不意味着慢**——扫的是覆盖索引，2.4–3.3 ms；`a=5 AND NOT (b=6)` 仍然是 `(a=?)`，NOT 只是过滤条件。
3. **`IS NULL` 能用索引**（计划里写作 `(pad=?)`），`IS NOT NULL` 也走索引但被写成范围 `(pad>?)`，本例 9.33 ms 是因为它几乎等于全表。
4. **`LIKE` 的比较规则跟着 collation 走**：默认 `case_sensitive_like=OFF`，`LIKE` 用 NOCASE 语义，所以它挑中的是 `CREATE INDEX i_t3_nc ON t3(name COLLATE NOCASE)` 这个索引（`SEARCH ... i_t3_nc`）；而显式 `>=`/`<` 比较走 BINARY，用的是 `i_name`。`pragma index_xinfo('i_t3_nc')` 显示 `seqno=0 cid=3 name=name desc=0 coll=NOCASE key=1`，第二行 `cid=-1` 就是追加的 rowid。本库可用的 collation 只有 `RTRIM / NOCASE / BINARY`。

**表达式索引实测可用**（第 1 次跑就确认）：

```text
  CREATE INDEX i_t3_lower ON t3(lower(name)) -> OK   中位 90.0 ms（78.6–105.8）
  EQP> select count(*) from t3 where lower(name)='aaaaaaaa'
     SEARCH t3 USING COVERING INDEX i_t3_lower (<expr>=?)     <- 计划里就是这个 "<expr>=?"
  中位 0.168 ms（0.127–0.196）      vs 无表达式索引 16.20 ms  ->  96 倍
```

**部分索引实测可用，但优化器不选它**（诚实的负结果）：建了 `i_part ON orders(customer_id) WHERE amount>90000` 之后，三条相关查询全部挑了覆盖索引 `i_ca`：

```text
  EQP> select count(*) from orders where customer_id=42 and amount>90000
     SEARCH orders USING COVERING INDEX i_ca (customer_id=? AND amount>?)   -- 0.179 ms
  EQP> ... amount>89999  -> 同上  -- 0.179 ms
  EQP> ... amount>95000  -> 同上  -- 0.180 ms
```

也就是说部分索引**在本机没有换来时间**（它换来的只是 1/10 的空间，见第五节）；它的真实战场是"表很大、热点小、且没有更省事的覆盖索引"。

## 十一、"隐式类型转换让索引失效"在 SQLite 上不是这个形状

第 1 节讲过类型亲和。本节把 MySQL 圈里那句最有名的口诀拿去实测，结论是：**SQLite 的计划不变，变的是结果。**

建 `conv(i INTEGER, t VARCHAR(20), n NUMERIC, b BLOB, x)`（`x` 不带类型声明），每列都建索引，各插 20000 行（`i` 与 `t` 分别是整数 i 和字符串 `str(i)`）：

```text
  EQP> select count(*) from conv where t=123      -- TEXT 列 vs 整数字面量
     SEARCH conv USING COVERING INDEX ix_t (t=?)   命中值=1   best 0.320 ms
  EQP> select count(*) from conv where i='123'     -- INTEGER 列 vs 文本字面量
     SEARCH conv USING COVERING INDEX ix_i (i=?)   命中值=1
  EQP> select count(*) from conv where n='123'
     SEARCH conv USING COVERING INDEX ix_n (n=?)   命中值=1
  EQP> select count(*) from conv where b='123'     -- BLOB 亲和列 vs 文本
     SEARCH conv USING COVERING INDEX ix_b (b=?)   命中值=0   <- 计划照样走索引，结果一行都没有
  EQP> select count(*) from conv where x='123'     -- 无亲和列 vs 文本
     SEARCH conv USING COVERING INDEX ix_x (x=?)   命中值=0
```

机制：SQLite 的亲和性把**字面量那一侧**转换成列的亲和（`TEXT` 列比整数 → 整数被转成 `'123'`，照样命中、照样 seek），而 `BLOB`/无亲和列**不做任何转换**，于是整数 `123` 与文本 `'123'` 是两种可比较但永不相等的值。再往同一列里混存两种类型，效果最直观：

```text
  Q> select b, typeof(b), x, typeof(x) from conv where i>=99001 order by i
     123 | integer | 123 | integer
     123 | text    | 123 | text
     123 | integer | 123 | text
     123 | text    | 123 | integer
  Q> select count(*) from conv where b=123   ->  3      -- 只数到整数那批
  Q> select count(*) from conv where b='123' ->  2      -- 只数到文本那批
  Q> select count(*) from conv where x=123   ->  3
  Q> select count(*) from conv where x='123' ->  2
  Q> select count(*) from conv where t=123   ->  2      -- TEXT 列：整数被转成文本，两种写法都能命中
  Q> select count(*) from conv where t=987654    ->  1  -- 插进去的整数已被转成文本 '987654'
  Q> select count(*) from conv where t='987654'  ->  1  -- 与上一条完全等价
```

**所以 SQLite 上类型混用的失效形式是"少行且不报错"，不是"慢"。** 4 行里存着两种类型，两种写法各查回一半——这比慢 10 倍危险得多，因为它会静默改变业务结论。规矩：**列的亲和要写明确（`TEXT`/`INTEGER`），别用无类型列存 ID**；跨类型比较一律显式 `CAST`；`PRAGMA table_info` 的 `type` 空值就是危险信号。

顺带一条 `TEXT` 亲和列存进 20 字符不受限（第 1 节已证）与 `length()` 返回字符数（不是字节）的组合：本项目所有中文行都靠这两条对齐。

## 十二、索引的写代价与统计信息

**写放大**（同一张表结构 `w(id PK, a, b, c, d, t)`，插 20000 行 / 单事务 / 3 rep × 4 次运行，单位 ms）：

| 索引数 | 0 | 1 (`a`) | 2 (`a,b`) | 3 (`a,b,c`) | 4 (`a,b,c,t`) |
| --- | --- | --- | --- | --- | --- |
| 中位区间 | 144.5–174.8 | 159.2–212.3 | 157.6–202.1 | 165.1–191.2 | 189.8–387.5 |
| 中位 | **155.4** | 171.0 | 172.0 | 179.0 | **208.1** |

**4 个索引 = 插入慢 1.34 倍**，且第 1 个索引吃掉的份额最大（155→171，+10%），后面每个约 +5%——因为维护成本主要是"每索引一次 b-tree 插入 + 页分裂"，而 b-tree 插入是 O(log N) 且页缓存命中率高。作为对照，`CREATE INDEX` 一个 10 万行的索引要 40–80 ms（第五节），**"先灌数据再建索引"永远是批量导入的正确顺序**。

**改一列的代价**：`UPDATE w4 SET a=a+1`（被索引列）中位 24.7/25.3/25.3 ms，`SET d=d+1`（未索引列）15.8/29.5/34.4 ms，`SET t=t+1`（被索引 TEXT 列）29.4/29.4/31.8 ms。**区间大幅重叠，本机测不出"改索引列更贵"**——原因是全表 UPDATE 时表页与索引页都要写，瓶颈在别处。我不会把这条写成结论。

**ANALYZE 与 `sqlite_stat1` 原文**（对全库跑一次，中位 162.2 ms，区间 143.1–197.1）：

```text
  Q> select * from sqlite_stat1 order by tbl, idx
     customers | NULL      | 1000
     orders    | i_c       | 100000 100
     orders    | i_ca      | 100000 100 1
     orders    | i_amt     | 100000 2
     orders    | i_note    | 100000 1
     orders    | i_part    | 9997 10
     orders    | u_id_amount | 100000 1 1
     t3        | i_abc     | 100000 100 1 1
     t3        | i_pad     | 100000 2
     pk_txt    | sqlite_autoindex_pk_txt_1 | 100000 1
     tlow      | NULL      | 100000
```

`stat` 的格式读法（与本文第四、五小节的实测数字逐条对上）：**第一个数 = 表的索引条目总数**（`i_part` 是 9997，正是部分索引的行数），**之后每个数 = 按前 k 列分组后每组的平均行数**。`i_c | 100000 100` = 按 `customer_id` 平均 100 行/组（`a=500` 实测正好 100 行 ✓）；`i_ca | 100000 100 1` = 加上 `amount` 后每组 1 行；`i_abc | 100000 100 1 1`；表自身的统计行 `idx=NULL` 只存总行数。这些数字就是代价模型的输入。

**诚实的负结果**：我准备了 4 条范围/连接查询想看 `ANALYZE` 前后的**计划翻转**，结果一条都没翻——`amount BETWEEN 1 AND 50000`（命中 50%）在 ANALYZE 前后都是 `SEARCH ... USING INDEX i_amt`，`tlow where h=12345` 前后都是 `SCAN`，`DELETE FROM sqlite_stat1` 之后也是同样计划；`PRAGMA optimize` 只花 0.332 ms。所以本节能给的结论只有：**统计信息决定的是"选哪个索引/是否改用 SCAN"这类阈值判断，本机这些数据恰好都在同一侧**；`sqlite_stat4`（更细的采样）在本机不可用。想在 MySQL 上看翻转，请在第 9 节的框架下重做实验。

## 十三、把本节变成规矩

1. **读计划先分三层**：`SEARCH ... USING COVERING INDEX`（最好：定位且不回表）→ `SEARCH ... USING INDEX`（定位但回表，括号外的列都要回表取）→ `SCAN ... USING COVERING INDEX`（没定位，只是把索引当窄表扫，仍有约 3.7 倍常数优势）→ `SCAN 表`（全表）。中间出现 `USE TEMP B-TREE` 就是在额外排序/分组。
2. **最左前缀的判据是"计划括号里有没有你的列"**：断开链的列一律不进括号；**范围条件之后的列全部作废**（`a>? AND b=?` 只剩 `a>?`）；书写顺序无关；`IN` 不断链。
3. **想让某列进括号，只有两条路**：把它提到复合索引的前面，或者单独建索引。建复合索引前先想清楚"哪些谓词会一起出现"，列序按"等值列在前、范围列在后"。
4. **覆盖索引是数量级问题**：同谓词 178.8 ms vs 1.08 ms（165 倍）；能不回表就别回。反过来说，**索引里多塞一列**几乎总是值得的（`i_ca` 比 `i_c` 多 92 页 / +45% 空间，换来 50% 命中时不回表）。
5. **`ORDER BY` 全反向免费，混合方向只罚最后一项，跳列排序最贵**（0.11 vs 3.35 ms）。不要为了 DESC 建"降序索引"，SQLite 会反向扫。
6. **失效写法清单（SQLite 实测）**：列上套函数 / `CAST` / `||` / `coalesce` → SCAN；`LIKE '%x'`、`LIKE 'x%y%'`（后半截）、`GLOB '*x*'` → SCAN；`!=`/`NOT IN`/`NOT` → SCAN（但不等于慢）；`IS NULL` 能用索引；`OR` 两侧各自可 seek 时走 `MULTI-INDEX OR`，有一侧不可 seek 时整条退化成 SCAN。
7. **对策**：大小写不敏感就建**表达式索引** `ON t(lower(name))` 或 `COLLATE NOCASE` 索引（实测 16.2 ms → 0.168 ms，96 倍）；前缀匹配用 `LIKE 'x%'` 或手写 `>= / <` 范围；热点小表用**部分索引**（空间按命中比例，代价 1/10）。
8. **类型混用不改变计划、只减少行数**：`BLOB`/无亲和列里同时存过整数和文本时，`=123` 与 `='123'` 各查回一半，**不报错**。列亲和写明确，比较两侧类型对齐。
9. **索引成本按页可预算**：`(内部页 + 叶子页) × page_size`，短整数键约 10 B/行、长文本键约 30 B/行、部分索引按被索引行数摊。写侧实测 4 索引 = 插入 ×1.34，批量导入请**先导数据后建索引**。
10. **`dbstat` / `sqlite_stat4` 是否可用取决于编译选项**，别在迁移脚本里假设它们存在；需要空间账本时，`page_count × page_size` 加 `freelist_count` 是通用办法（第 2 节：`DROP INDEX` 不还空间，要 `VACUUM`；本节补充：`VACUUM` 实测 1133 ms 把 5259264 字节、1284 页还给了文件系统）。

## 十四、其它引擎的差异：本节未在本机实测

本机没有 MySQL / MariaDB / PostgreSQL 服务，也没有 `mysql`/`psql` 客户端。下面每一条都**只是问题清单，没有一条被验证过，需要复核**，且**不给任何数字**：

- **聚簇索引模型完全不同**：InnoDB 的表本身就是按主键组织的 B+ 树，二级索引叶子存的是**主键值**而不是 rowid，"回表"要按主键再走一遍聚簇树；PostgreSQL 则是堆表 + 索引指向 `(block, offset)`，回表要看 visibility map 与 HOT。**第九节所有回表倍数都不能照搬**——需要复核。
- **索引内部节点存什么**：本文第三节"索引树内部页也存完整 key"是对 SQLite 的实测；MySQL/PostgreSQL 的 B+ 树内部节点通常只存分隔键——**需要复核**。
- **`EXPLAIN` 的输出格式与 SQLite 的 `EXPLAIN QUERY PLAN` 无关**：MySQL 是 `type/key/rows/Extra`（`Using index` ≈ COVERING、`Using index condition` ≈ ICP，但对应关系**未在本机验证**），PostgreSQL 是节点树 + `Index Cond`/`Index Only Scan`/`Heap Fetches`。第六节那张 18 行对照表必须在目标引擎上重跑。
- **最左前缀在 MySQL 上是"最左前缀匹配 + ICP"两层机制**，`a>? AND b=?` 在 MySQL 里可能靠 Index Condition Pushdown 把 `b` 下推到存储引擎过滤，计划文本仍显示用了索引但 `key_len` 只覆盖 `a`——**需要复核**。
- **降序索引**：MySQL 8.0 起支持真正的 `DESC` 索引，8.0 之前解析时忽略 DESC；PostgreSQL 支持 `COLLATE`/`ASC/DESC` 混合索引。SQLite 的"反向扫描免费"（第七节）在其它引擎上表现**未在本机验证**。
- **skip scan**：Oracle 有、MySQL 8.0.13+ 有 index skip scan、PostgreSQL 没有该概念。第八节的负结果**只对 SQLite 成立**。
- **函数索引 / 部分索引**：MySQL 8.0.13+ 用函数索引（且要求表达式两边写法严格一致），PostgreSQL 两者都支持且部分索引可以带 `WHERE`；具体能否命中、`EXPLAIN` 里如何显示——**需要复核**。
- **`utf8mb4` 与字符集/排序规则**：MySQL 里索引键长受 `utf8mb4` 的 4 字节/字符影响（前缀索引 `length` 限制、`innodb_large_prefix`）、`_ci` collation 影响大小写与重音判定，从而改变"能不能用索引"的结论。本节只测了 `NOCASE`/`BINARY`/`RTRIM`（第 1 节已述）——MySQL 侧**必须实测**。
- **在线变更**：第 3 节要讲的 `ALTER TABLE ... ALGORITHM=INPLACE, LOCK=NONE` 建索引、`OPTIMIZE TABLE`、MySQL 的 `CREATE INDEX` 是否阻塞写入，本机**全部未验证**。
- **统计信息**：MySQL 的 `ANALYZE TABLE` 采样 `innodb_stats_persistent`，PostgreSQL 的 `ANALYZE` 写 `pg_statistic`（含直方图与 MCV），代价模型与本文 `sqlite_stat1` 的"每列平均分组数"格式毫无共同点。第十二节那条"没测到计划翻转"**不能推断到它们**。

## 十五、小结

第 2 节教会我"上线前 `EXPLAIN QUERY PLAN` 是固定动作"，本节把这句话的物理依据补完了：**文件被切成 4096 字节的页，每张表是一棵树、每个索引是另一棵树；树高决定 I/O 次数，页里的 cell 密度决定扫描代价，索引记录尾部自带 rowid 所以 `count(*)`/rowid 永远覆盖，而任何一列不在索引里就意味着要按 rowid 回另一棵树做随机页访问**。这三个事实把第六节（最左前缀）、第九节（165 倍的覆盖/回表差）、第十节（写放大 1.34 倍）和第十二节（页账本与字节增量精确闭合）全部串起来了。

失效的场景也只有三种，都能被一眼识别：**列被包进表达式**（`SCAN ... USING COVERING INDEX`，16.2 ms）、**链在中间断了**（括号里少一列，`SCAN` 或 `(a>?)` 之后全弃）、**结果集大到回表比扫表更贵**（第 2 节的 20%/100% 两格 + 本节 50% 那格 178 ms）。而"隐式类型转换"在 SQLite 上不属于任何一种——它不改计划，只悄悄少行，这也是本节最想把人叫醒的一条。

下一节（第 6 节《事务与隔离级别》）离开"怎么查得快"，改问"并发时谁会看到谁"：自动提交与事务边界、脏读/不可重复读/幻读在单写者模型上怎么复现、`BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE` 三种开头的真实差别，以及 `database is locked` 的等待与超时。
