---
title: 模块划分与依赖管理：分层要靠链接器证明，不是靠目录树
description: 实测：4 模块 11 条边里 3 条反向依赖把全部粘成一个强连通分量，而 make 退出码 0；穷举 84 种割集只有 5 种能破环，其中仅 1 种只拆违规边。
date: 2026-10-16
tags: [工程实践, 模块化, 依赖管理, 循环依赖, 插件化]
category: engineering
section: eng-arch
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1；Node v22.19.0；`D:/Qt/Tools/mingw1310_64/bin/g++.exe`（13.1.0，`-std=c++17 -O1 -Wall -Wextra`）——PATH 上的 `gcc` 是 Strawberry Perl 4.9.2，禁用。**PATH 上没有 `make`**，`which make` 空，实测用的是 `D:/Qt/Tools/mingw1310_64/bin/mingw32-make.exe`（GNU Make 4.2.1，Built for x86_64-w64-mingw32），同目录还有 `ar.exe`/`nm.exe`/`objdump.exe`。真实仓库 `C:\Users\wangt\data\blog` 以提交 **1e37133** 为锚点：66 个提交、115 个跟踪文件、78 个 `.md`、0 个 merge、0 个 tag、`git branch -a` 只有 `main` 与 `origin/main`；博客仓库只跑只读命令，所有写操作与构建都在 `C:/Users/wangt/AppData/Local/Temp/agents/engarch/` 下的 `cycle/ fixed/ cycinc/ fat/ thin/ plugin/ reg/` 七个临时工程里做。计时一律 `mingw32-make -j1`（串行，否则扇出被并行掩盖），3 轮取最好值并报区间；同机有多个 agent 在抢 CPU，所以**比值比绝对值可靠**。

## 一、分层违规在构建层面是完全隐形的

目录树写的是四层（`core` L0 → `infra` L1 → `domain` L2 → `ui` L3），代码里我故意种了 3 条反向包含。用 150 行的脚本（`deps.cjs`：抽 `#include "…"` → 归并成模块级有向图 → Tarjan 求强连通分量 → 穷举破环割集）量出来的原文：

```text
扫描文件 17 个，其中含项目内 include/import 的 14 个
文件级边 23 条，模块级有向边 11 条，模块节点 5 个：app, core, domain, infra, ui

  core -> domain   【违规：L0 -> L2】  core/logger.cpp:2 "domain/order.h"
  infra -> domain  【违规：L1 -> L2】  infra/http.cpp:2 "domain/pricing.h"
  infra -> ui      【违规：L1 -> L3】  infra/db.cpp:2 "ui/panel.h" ; infra/http.cpp:3 "ui/panel.h"

== 分层违规边：3 条
== 强连通分量（size>1）：1 个   {core, domain, infra, ui}  size=4
```

**这 3 条违规边，构建系统一条都不会报告**：`mingw32-make -j1 all` 退出码 **0**、9 个 TU 全部通过 `-Wall -Wextra` **零警告**、耗时 4297ms、`app.exe` 正常跑完。也就是说"分层"这件事在你不专门去量之前，只存在于目录名里。

那它的症状在哪？在**运行时行为**上。同一份 `main.cpp` 只做四件事（建单、刷面板、打报表、打汇总），两个版本的输出：

```text
cycle 版：[log] db / [panel] paints=1 / [log] http / [panel] paints=2 / [log] price
          / [panel] paints=3 / [report] rows=1 / [log] report / [report] orders=2
fixed 版：[log] db / [log] http / [panel] paints=1 / [report] rows=1 / [log] report / [report] src=2
```

底层调 `db_query`、调 `http_get`，本意是"查完数据"，实际是"查完数据顺手把 UI 重画了一遍"——**面板被刷了 3 次而不是 1 次**。这就是反向依赖最典型的病灶：一个底层动作触发了上层的副作用，而底层根本不知道自己碰到了 UI。看输出顺序还能看到 `cycle` 版的 `[log] price` 是 `infra/http.cpp` 里为了"顺便算个价"冒出来的，`fixed` 版整条路径上根本没有。

## 二、循环依赖只有链接器会宣布死刑

把四个模块各打成一个静态库（`ar rcs`），按分层图 supposed 的"拓扑顺序"去链接：

```text
libcycle-core.a 2598   libcycle-domain.a 2704   libcycle-infra.a 3062   libcycle-ui.a 3186

=== 自顶向下 ui domain infra core ===  rc=1
ld.exe: libcycle-infra.a(http.o):http.cpp:(.text+0x62): undefined reference to `domain::price(double, double)'
collect2.exe: error: ld returned 1 exit status

=== 自底向上 core infra domain ui ===  rc=1
ld.exe: libcycle-domain.a(order.o):order.cpp:(.text+0xf): undefined reference to `infra::db_query(long)'
ld.exe: libcycle-domain.a(order.o):order.cpp:(.text+0x1b): undefined reference to `infra::http_get(char const*)'
ld.exe: libcycle-domain.a(order.o):order.cpp:(.text+0x2c): undefined reference to `infra::db_count()'
ld.exe: libcycle-ui.a(report.o):report.cpp:(.text+0x48): undefined reference to `infra::db_count()'
collect2.exe: error: ld returned 1 exit status
```

**两种顺序都失败，这才是循环依赖的定义。** 对照组是修复版（`fixed/`，0 条违规边）：

| 工程 | 自顶向下 | 自底向上 | `-Wl,--start-group` |
| --- | --- | --- | --- |
| cycle | rc=1（1 处未定义） | rc=1（4 处未定义） | **rc=0**，`app_group.exe` 82381 字节 |
| fixed | **rc=0**，82765 字节 | rc=1（5 处未定义） | rc=0，82765 字节 |

三条只能靠实测才记得住的细节：

1. **DAG 与环的区别就是"存在不存在一个合法顺序"**。`fixed` 版反过来排照样报 5 处 undefined——顺序错了永远会报错，但只有环是"怎么排都错"。
2. **报错清单不等于环的清单**。`cycle` 版自顶向下只报了 1 处（`domain::price`），链接器遇到第一个填不上的缺口就退出了；剩下的环要等你修完这条才会露出来。用 `--start-group` 把它一次性"医好"之后，环的数量信息就永久丢失了——**`--start-group` 是麻醉剂不是手术**：它确实让 `app.exe` 链接成功，但那条 `infra -> domain` 的边还在图里，下次有人加边时没人知道上限在哪。
3. 单目标构建（直接链 `.o`，不经过归档）**永远不会报这个错**——`make all` 用的是 `main.o + 8 个 .o`，退出码 0。链接器对 `.o` 是全部纳入、对 `.a` 是"只拉出被引用到的成员"，所以：**只有把模块真的做成库，环才会咬人。** 一个只在目录层面分层、从不切分归档的工程，它的循环依赖是量不出"链接期后果"的。

## 三、破环不是"剪掉最刺眼的那条边"

Tarjan 跑出来的结果本身就反直觉：我种的是 3 对两两互环（core↔domain、infra↔ui、infra↔domain 加 ui→infra/panel），**检测出来是 1 个 4 元强连通分量**，不是 3 个小环——SCC 有传递性，环粘环就变成一个整体。于是"要拆几条边"变成可穷举的问题，脚本在环内的 9 条边里逐个数：

```text
== 破环最小割集穷举（候选边 9 条）
  k=1: 组合 9 种，可行解 0 个
  k=2: 组合 36 种，可行解 0 个
  k=3: 组合 84 种，可行解 5 个
    解：core|domain + domain|infra + infra|ui
    解：core|domain + domain|infra + ui|infra
    解：core|domain + infra|ui + infra|domain
    解：domain|infra + domain|core + infra|ui
    解：domain|infra + domain|core + ui|infra
  只砍 3 条【违规方向】的边：core|domain + infra|ui + infra|domain
    -> 是否变成 DAG：true
```

最小割集大小是 **3**，但 84 种三元组合里只有 **5** 种成立，而其中 **4 种要砍掉一条方向本来就合规的边**（`domain|infra`、`ui|infra` 是 L2→L1、L3→L1 的正常依赖）。唯一"只拆违规边"的解就是脚本单独验证的那一组。**这就是"随便找条边切开"的真实概率：你大概率会切出一个"合法但别扭"的形状**——比如把 `domain → infra` 拆掉之后，业务层不再依赖数据访问层，改由数据访问层反向调用业务层，环没了，分层也没了。

实际的破环手法与结果（`fixed/` 的 diff 只有三处）：

- `core → domain`（L0 想打一份"订单数汇总"）：core 只声明它需要什么——`typedef int (*Counter)(); void set_report_source(Counter);`，由 L4 的 `main.cpp` 把 `&domain::order_total` 递进去。边的方向从 `core→domain` 变成 `app→core` + `app→domain`，**装配发生在最上层**。
- `infra → ui`（"查完刷新面板"）：删掉，改成调用方（ui）自己刷。
- `infra → domain`（"http 顺便算个价"）：删掉。

修复后的图（原文）：`扫描文件 19 个 / 文件级边 22 条 / 模块级有向边 9 条 / 分层违规边：0 条 / 强连通分量（size>1）：0 个`。边比原来少 2 条，模块边界反而更清楚了。

### 循环"包含"是另一回事：报错位置会指到无辜的文件

上面说的是模块级环（编译器不报）。头文件之间互相包含时编译器会报，但**报的地方通常不是该改的地方**。两个头文件互相按值持有对方：

```text
$ g++ -fsyntax-only tu_widget_first.cpp        # TU 只写 #include "widget.h"
In file included from widget.h:2, from tu_widget_first.cpp:1:
paint.h:5:5: error: 'Widget' does not name a type
    5 |     Widget w;         // 按值持有 —— 与 widget.h 互相依赖

$ g++ -fsyntax-only tu_paint_first.cpp         # TU 只写 #include "paint.h"
In file included from paint.h:2, from tu_paint_first.cpp:1:
widget.h:5:5: error: 'Paint' does not name a type; did you mean 'int'?
    5 |     Paint p;          // 按值持有
```

两次都 rc=1，但**报错行落在"第二个被打开"的那个文件上**——`#pragma once` 让重复包含变成空操作，于是环里总有一方的类型是未完成类型。同一个环，换个包含顺序就换个受害者，"did you mean 'int'?" 这种建议更是纯噪声。破除只需要一条前置声明：`widget_fwd.h` 里 `struct Paint;` + `Paint* p;`，`g++ -Wall -Wextra -fsyntax-only` 退出码 **0**。

## 四、接口与实现分离：把它量成字节和毫秒

同一份逻辑做两个版本，8 个用户 TU + 1 个实现 TU + main：`fat` 的公开头 `common/render.h` 直接 `#include "common/render_detail.h"` 并按值持有那个"重"结构体（内含 7 个标准库头）；`thin` 用前置声明 + `std::unique_ptr<RenderDetail>`（PIMPL），只有 `render.cpp` 包含内部头。

| 指标（实测） | fat | thin |
| --- | --- | --- |
| `tu1.cpp` 的 `-E` 预处理输出 | **1730849 字节** | **988429 字节**（−43%） |
| `g++ -M` 里的项目头个数 | 2（render.h + render_detail.h） | 1（只有 render.h） |
| `-M` 依赖清单条目总数 | 138 | 118 |
| clean build（-j1，3 轮最好） | 8615ms（区间 8615–9881） | 6868ms（区间 6868–7142） |
| `touch common/render_detail.h` 后重建 | **重编 10 个 TU**，8472ms（区间 8472–9950） | **重编 1 个 TU**，2065ms（区间 2065–2646） |
| 改动代价 ÷ 全量重建 | **98%**（等于没增量） | **30%** |

比值很直白：`fat` 版改一个**纯内部**的头，代价和 `make clean && make` 几乎一样——因为 10 个 TU 全都通过公开头间接依赖它。`thin` 版把这条边切断后，同样的改动只重编 1 个 TU。30% 而不是接近 0，是因为那 2065ms 里含了一次链接（MinGW 链接约 1.5 秒量级）；**接口分离省的是编译，不省链接**。附带一条：`-E` 的字节数就是"编译器每个 TU 都要重读多少文本"，1730849 → 988429 是纯粹的白读，8 个 TU 各读一遍。

然后是最容易翻车的一条，实测原文：

```text
$ make -f Makefile.nodeps all      # Makefile 里没写头文件依赖（没 -include *.d）
mingw32-make: Nothing to be done for 'all'.
rc=0
```

我给 `common/render_detail.h` 做了 `touch`，而这一版退出码是 **0**、什么都没做。规则 `%.o: %.cpp` 只认源文件，头文件依赖要靠 `-MMD -MP` + `-include $(DEPS)` 才存在。**这是增量构建里最坏的一种失败：它不报错。** 本地开发时表现为"改了头文件行为没变，重启一次全量构建就好了"，而在 CI 上（缓存里有旧 `.o`）它就是一个把过期产物当成功的假绿——第 10 节讲门禁时会再撞上它。

## 五、插件化：把边界做成运行时边界，代价也要称出来

`plugin/` 是一个宿主 + 三个 DLL 插件，接口是 C 结构体函数表（`PluginVtable{api, struct_size, name, run}`，宿主同时校验 `api` 和 `struct_size`）：

```text
[host] 已加载 plug1.dll: name=scaler-v1 api=2 struct=24 run(7)=15
[host] 已加载 plug2.dll: name=scaler-v2 api=2 struct=24 run(7)=16
[host] 拒绝加载：插件自报 api=99, 宿主编译期期望 api=2         → rc=13
[host] LoadLibraryA("nope.dll") 失败, GetLastError=126        → rc=10
```

产物尺寸：`host.exe` 78224 字节，三个插件各 **36378 字节**（`-static -shared`；不带 `-static` 重编一份 `plug_dyn.dll` 也是 36378 字节——PE 的段对齐把这点差异吃掉了，所以**别拿"DLL 更小"当插件化的理由**）。真正的收益在重建范围上：

| 改动的东西 | `make all` 重编的目标 |
| --- | --- |
| `plug1.c`（插件实现） | **只有 `-o plug1.dll`** 一行，宿主 0 重编 |
| `plugin_api.h`（接口头） | host.exe + 3 个 dll，共 **4 个目标** |

这就是"接口与实现分离"做到运行时的形态：**改实现不动宿主，改接口全体重编**。顺带一条真实警告（改接口头重编宿主时报的）：

```text
host.cpp:12:27: warning: cast between incompatible function types from
'FARPROC' {aka 'long long int (*)()'} to 'PluginEntryFn' {aka 'const PluginVtable* (*)()'} [-Wcast-function-type]
```

`GetProcAddress` 返回的是 `FARPROC`，往函数指针强转在 MinGW 的 `-Wextra` 下必然告警——这不是你的插件写错了，是这套 API 的签名本身不携带类型。**插件边界的类型安全只能靠你在运行时的 `api`/`struct_size` 校验，编译器帮不了你。**

### 静态库 + 自注册：最容易静默失效的组合

如果插件不做成 DLL，而是"链进主程序的静态库 + 靠静态对象自动注册"，实测结果是：

```text
$ g++ -static main.o libplug.a libreg.a -o app_plain.exe   → 链接 rc=0
$ ./app_plain.exe                                          → registered=0，运行 rc=0

$ g++ -static main.o -Wl,--whole-archive libplug.a -Wl,--no-whole-archive libreg.a
$ ./app_whole.exe  → registered=2 [triple->21] [double->14]

$ nm app_plain.exe | grep -c plug_(double|triple)_anchor  → 0
$ nm app_whole.exe | grep -c plug_(double|triple)_anchor  → 4
字节数：app_plain.exe 498560 / app_whole.exe 500073 / app_anchor.exe 500073
```

**链接成功、程序正常退出、注册表是空的**，连一个警告都没有——归档里那两个 `.o` 根本没被拉进来（`nm` 计数 0），因为没有任何符号引用它们。修法三种：`--whole-archive`（体积 +1513 字节）、给每个插件加一个必须被引用的锚点符号（`main2.cpp` 调 `plug_double_anchor()`，`registered=2`）、或者干脆回到动态库。

顺带量到一条更阴的：**注册顺序由归档成员顺序决定，而归档成员顺序由你敲 `ar rcs` 时的参数顺序决定。**

```text
ar rcs libplug.a    plug_double.o plug_triple.o  → registered=2 [triple->21] [double->14]
ar rcs libplug_rev.a plug_triple.o plug_double.o → registered=2 [double->14] [triple->21]
```

同一份源码、同样的链接命令，只换归档参数顺序，注册表顺序就整体翻转（`ar t libplug.a` 显示的成员顺序确实是 double 在前，但初始化顺序却是 triple 先跑——链接器摆放 `.o` 的顺序与归档成员顺序并不一致）。我重跑 3 次结果稳定，但**它稳定在"构建命令的写法"上，不稳定在源码上**。任何依赖注册次序的插件系统（比如"按注册顺序覆盖同名处理器"）都会在这里中招。

## 六、把同一把尺子量回本仓库（只读）

`node deps.cjs C:/Users/wangt/data/blog ts`（抽 `from './…'` 与 `import './…'`，按 `data < utils < components/layouts < pages` 分层）：

```text
扫描文件 25 个，其中含项目内 include/import 的 18 个
文件级边 50 条，模块级有向边 14 条，模块节点 7 个：components, config.ts, data, layouts, pages, styles, utils
== 分层违规边：0 条
== 强连通分量（size>1）：0 个
== 入度排行：src/utils/post.ts 入度=12 来自 12 个文件；src/config.ts 入度=10；
   src/layouts/BaseLayout.astro 入度=10；src/data/categories.ts 入度=7
```

结构上它是干净的：唯一的"数据/逻辑"底层是 `utils → data` 一条边，10 个页面 + 2 个展示单元全在往上依赖往下，0 环 0 违规。**但"0 违规"不等于没问题，第四节的教训正好适用**：`src/utils/post.ts` 入度 **12**（10 个页面/RSS 入口 + `PostItem.astro` + `PostLayout.astro`），而它第 1 行 `import { getCollection } from 'astro:content'` 让这整份文件无法被 Node 加载——第 5 节实测过 `ERR_UNSUPPORTED_ESM_URL_SCHEME | Received protocol 'astro:'`。**12 个调用方共享同一个不可测、不可替换的实现单元，这就是 TS 项目里的"公开头按值持有内部结构体"**：依赖方向是对的，缺的是接口与实现分离（把 6 个零依赖纯函数放进不 import 虚拟模块的 `pure.ts`，`post.ts` 只做装配，等价于第四节的 `thin` 版）。

本节只测到静态 import 边为止，说清未实测的三点：(1) 本仓库没有引入任何依赖检查工具（没 ESLint 的 import 插件、没 dependency-cruiser），上面的图是我自己的脚本抽的，`astro:` 虚拟模块带来的运行时隐式依赖不在图里；(2) `Astro` 的 `npm run build` 归总控在跑，我没有验证"若出现循环 import，构建会告警还是静默通过"；(3) 插件化在本仓库没有对应形态，第五节的全部数字来自 MinGW 的 Windows DLL，Linux 下 `dlopen` 与符号可见性规则不同，不能照搬结论。

## 小结

- **分层违规不会有人告诉你**：3 条反向边、4 个模块全被粘进一个强连通分量，而 `make -j1` 退出码 0、`-Wall -Wextra` 零警告、程序照跑——唯一的可见症状是那次实测里 **UI 面板被刷了 3 次而不是 1 次**。目录树不是架构，图才是。
- **只有链接器能宣判循环依赖**：拆成 4 个静态库后，自顶向下报 `undefined reference to 'domain::price(double, double)'`、自底向上报 4 处，**两种顺序都 rc=1**；`--start-group` 能链接成功（82381 字节）但那是麻醉剂，而且它报的缺口数永远小于环的个数。直接链 `.o` 时这个错永不出现。
- **破环要算割集**：环内 9 条边，k=1（9 种）、k=2（36 种）全部无解，k=3（84 种）只有 **5** 种可行，其中 **4** 种要牺牲一条方向合规的边——"随手剪一条最刺眼的边"有 4/5 的概率把架构剪成别扭形状。正解是依赖倒置：core 声明 `Counter`，装配放在最上层。
- **接口分离能称出重量**：改一个内部头，`fat` 版重编 10 个 TU（最好 8472ms，是全量重建的 **98%**），`thin` 版重编 1 个 TU（2065ms，**30%**），每个 TU 的预处理文本从 1730849 降到 988429 字节（−43%）。以及那条最危险的：Makefile 不写头文件依赖时，`touch` 之后 make 说 `Nothing to be done for 'all'.` 且退出码 0。
- **插件化的收益是"宿主 0 重编"（改 plug1.c 只出 1 个目标，改接口头出 4 个目标），成本是运行时校验与体积**（宿主 78224 字节、每插件 36378 字节、`-Wcast-function-type` 警告只能靠 `api`/`struct_size` 自检兜住）；而"静态库 + 自注册"实测 `registered=0` 却 `rc=0`，`nm` 证明那两个 `.o` 压根没进来，注册顺序还随 `ar` 参数顺序翻转。
