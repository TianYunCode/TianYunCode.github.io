---
title: CI/CD 与脚本化：门禁要验产物，不验步骤退出码
description: 实测一条 8 阶段本机流水线（总 5807ms）里的四种假绿：阶段函数返回 0 让整体 rc=0 而 report 里躺着两行 rc≠0；`gate | head -1` 把 rc=1 变成 rc=0；`make` 说 Nothing to be done 且 rc=0；产物里的构建号被冻在第一次的值。另测：`SOURCE_DATE_EPOCH` 被 MinGW 忽略、`-Wl,--no-insert-timestamp` 有效但随后的 `strip` 又把时间戳盖回来。
date: 2026-10-16
tags: [工程实践, CI, CD, 流水线, 门禁, 可观测]
category: engineering
section: eng-automation
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1；`D:/Qt/Tools/mingw1310_64/bin/g++.exe|gcc.exe`（13.1.0）、`mingw32-make.exe`（GNU Make 4.2.1，**PATH 上没有 make**）、同目录 `strip.exe`/`objdump.exe`/`nm.exe`/`ar.exe`；`clang-format` 是 22.1.8，位置 `C:/Users/wangt/AppData/Local/Python/pythoncore-3.14-64/Scripts/clang-format`（`which -a` 只有这一个命中）；Node v22.19.0；`sha256sum`/`cmp` 来自 Git Bash。**没有任何 GitHub Actions runner**：workflow 我只在本机做了 YAML 结构解析和"每一步的等价命令"，没有伪造过一行 CI 日志。真实仓库 `C:\Users\wangt\data\blog` 以 **1e37133** 为锚点（66 提交 / 115 跟踪文件 / 78 篇文章 / 0 tag），对它**只读**——`npm ci`、`npm run build` 我一次都没跑（会在仓库里写 `node_modules`/`dist`），只读了它已有的 `dist/`。流水线工程 `pipe/`、门禁脚本 `archgate.cjs`、以及所有 tag/push 实验都在 `C:/Users/wangt/AppData/Local/Temp/agents/engarch/` 下的临时仓库里做；计时是 `-j1` 串行、同机有并发 agent，所以看相对量级别看绝对毫秒。

## 一、先把 workflow 拿到本机读一遍：结构能读，语义不一定一致

用 PyYAML 解析 `.github/workflows/deploy.yml`，第一行输出就把本节的调子定了：

```text
top keys: ['name', True, 'permissions', 'concurrency', 'jobs']
on: {'push': {'branches': ['main']}, 'workflow_dispatch': None}
permissions: {'contents': 'read', 'pages': 'write', 'id-token': 'write'}
concurrency: {'group': 'pages', 'cancel-in-progress': False}
job build : runs-on=ubuntu-latest  5 步
job deploy: runs-on=ubuntu-latest  needs=build  environment={'name': 'github-pages', ...}  1 步
```

**`on:` 这个键在 YAML 1.1 里被解析成布尔 `True`**——`d['on']` 取不到东西，得写 `d[True]`。GitHub Actions 自己的解析器把它当字符串键，所以我本机这个"校验器"和平台看到的**不是同一份文档**。这就是"本地跑通了"这件事的第一层折扣：工具链、YAML 版本、shell（runner 是 `bash`，我这里 Git Bash）、`clang-format` 版本（Ubuntu 镜像里 apt 给的是哪个版本我**未实测**）都可能不同。

结构层面能确定的是：全站这条流水线一共 **2 个 job、6 个步骤**，`deploy` 依赖 `build`，`concurrency.cancel-in-progress: false`（同组并发不取消），权限是最小化的 `contents: read`。步骤清单与本机等价物：

| runner 上的步骤 | 命令 | 本机怎么对待 |
| --- | --- | --- |
| Checkout | `actions/checkout@v4` | 换成临时仓库 `git init` + `git tag` |
| Setup Node | `node-version: 22`, `cache: npm` | 本机 Node v22.19.0；**缓存未实测**（本机无 ccache、没跑 npm 缓存） |
| Install | `npm ci` | **没跑**（不许在博客仓库做 npm 写操作） |
| Build | `npm run build` | **没跑**（归总控）；改读它的产物 `dist/`：334 个文件 / 326 个 HTML / 5480 KB |
| Upload artifact | `upload-pages-artifact@v3` `path: dist/` | 换成 `sha256sum dist/app.exe tests.exe > SHA256SUMS` |
| Deploy | `deploy-pages@v4` | **未实测**，无 runner 权限；`environment` 的审批规则在服务端，本地 YAML 里看不到 |

真正的门禁（格式、告警、架构、测试、产物校验）在 CI 上不可用之前，得先在本机成立，所以下面这些我全部逐条跑过。

## 二、8 阶段流水线的骨架与实测耗时

`pipeline.sh` 把一次"发布前检查"拆成 8 个阶段，每个阶段就是一个能被退出码表达的函数，逐阶段记 `rc` 和耗时：

```text
=== 本机流水线（mode=collect，-j1 串行）===
identity   rc=0     228ms     git describe --dirty --always --tags，脏就拒
format     rc=0     399ms     clang-format --dry-run --Werror <6 个文件>
arch       rc=0     272ms     node archgate.cjs . layers.json
build      rc=0    1701ms     make -j1 WARN="-Wall -Wextra -Werror"
test       rc=0     158ms     ./tests.exe（退出码 = 失败断言数）
package    rc=0     211ms     strip + sha256sum dist/app.exe tests.exe > SHA256SUMS
verify     rc=0     174ms     grep -ao "$BUILD_ID" dist/app.exe && sha256sum -c
repro      rc=1    2664ms     清干净重编一次，cmp 两次产物
--- 失败阶段的日志尾部 ---
### repro
两次构建产物不一致：2 个字节不同
COLLECT-rc=1
```

总耗时 **5807ms**，去掉 `repro`（它内含两次完整重建）是 **3143ms**。每个阶段的返回值设计比命令本身重要：`tests.exe` 的退出码就是失败断言数（日志 `cases=5 failed=0`），所以它能直接喂给 `git bisect run`（第 4 节）、CI 门禁和发布前检查——第 5 节讲框架选型时那句"能不能用一个返回码表达通过/失败"在这里兑现了。

阶段顺序也有实测依据：`identity` 放最前是因为它最便宜（228ms）且能一票否决；`arch` 放在 `build` 前面是因为它比编译快一个数量级（272ms vs 1701ms），**能在烧 CPU 之前先拦住结构性问题**。

## 三、静态检查门禁：三种工具，三份原文

**格式**（`clang-format 22.1.8`）。第一版工程里我随手写了不规范的代码，门禁报的是**逐位置**的错误，23 条命中、rc=1：

```text
app/main.cpp:6:28: error: code should be clang-formatted [-Wclang-format-violations]
    int unused_counter = 0;              // -Wall -Wextra 下必报，-Werror 就该拦下
core/util.cpp:7:17: error: code should be clang-formatted [-Wclang-format-violations]
int clamp(int v,int lo,int hi){
                ^
```

注意 `--Werror` 在这里是**开关不是修饰**。同一份故意写坏的文件（`badly.cpp`，6 行 5 处不规范）实测：

```text
$ clang-format --dry-run badly.cpp          → 13 条 "warning: code should be clang-formatted"，rc=0
$ clang-format --dry-run --Werror badly.cpp → 13 条 "error: code should be clang-formatted"，  rc=1
```

差别有两层：措辞从 `warning:` 变 `error:`，以及**只有加 `--Werror` 才把退出码变成 1**；另外诊断信息是打到 **stderr** 的（第一条命令我用 `| wc -l` 数 stdout，得到 0 行）——CI 里如果只收 stdout，连"它报了 13 处"这件事都看不见。`clang-format -i` 跑完再检查，rc=0，同一批 6 个文件的检查耗时 399ms。

**告警**（`-Wall -Wextra -Werror`）：

```text
app/main.cpp:6:9: error: unused variable 'unused_counter' [-Werror=unused-variable]
cc1plus.exe: all warnings being treated as errors
mingw32-make: *** [Makefile:25: app/main.o] Error 1
```

`build` 阶段的 rc 是 **2**（make 的错误码）而不是 1，`test` 阶段在 `tests.exe` 没生成时是 **127**（command not found）。通知里把 0/1/2/127 分清楚，一眼就能区分"门禁拦下了"和"环境没准备好"——后者是排障时最浪费时间的噪声。第 8 节那条 `-Wcast-function-type` 告警也提醒同一件事：**`-Werror` 开之前先把现存告警清零**，否则它会把一个正常的平台 API 用法（`GetProcAddress` 强转）变成构建失败。

**架构**：第 8 节那套"分层违规 + 强连通分量"分析只有变成退出码才进得了流水线。`archgate.cjs`（Kahn 拓扑排序 + 层号比较，约 60 行）在三个工程上的实测：

```text
$ node archgate.cjs cycle layers-4.json
archgate | 扫描文件 17 | include 边 23 | 模块边 11 | 分层违规 3 | 成环模块数 4
  违规 core(L0) -> domain(L2)
  违规 infra(L1) -> ui(L3)
  违规 infra(L1) -> domain(L2)
  成环：有 4 个模块参与循环依赖（Kahn 拓扑排序没能消化）
rc=1

$ node archgate.cjs fixed layers-4.json   → 分层违规 0 | 成环模块数 0     rc=0
$ node archgate.cjs . layers.json（pipe/）→ 扫描文件 7 | 模块边 1        rc=0
```

这条门禁的价值在于：`cycle/` 在构建层面是**完全正常**的（第 8 节实测 `make` rc=0、零警告、程序跑对），只有架构门禁会红。**编译器的退出码不覆盖架构**。

## 四、假绿的四种形态（其中两种是我自己写出来的）

这一节是本节的正文。四种形态全部实测，前两种是我写这个流水线时**自己踩的**，不是构想出来的：

**1）阶段函数吞掉退出码。** 我的 `stage()` 第一版这样收尾：失败时只在 fail-fast 模式 `return 1`，收集模式下 `return 0`。把这一版复刻出来重跑，实测：

```text
identity   rc=1     206ms      ← 树脏
format     rc=0     299ms
arch       rc=0     425ms
build      rc=0    1173ms
test       rc=0     129ms
package    rc=0     215ms
verify     rc=0     180ms
repro      rc=1    2476ms      ← 重编不等价
整体退出码（脚本自称）= 0
```

八个阶段里两个 rc≠0，脚本宣布成功。改法是让 `stage()` 无条件把真实 rc 传出来，改完之后同一份工程 `COLLECT-rc=1`。**这是所有"包装层"的通病**：封装函数、Makefile 的聚合目标、workflow 里多命令拼一个 `run:` 块（Actions 用什么返回码规则我**没有 runner 可测**，但本机这条足以说明为什么要主动核对整体退出码，而不是相信"红了就停"）。

**2）管道吃掉退出码。** 拿真实的架构门禁命令测：

```text
$ bash -c 'node archgate.cjs cycle layers-4.json | head -1; echo rc=$?'
  无 pipefail: rc=0        ← 明明报了 3 条违规
$ bash -c 'set -o pipefail; node archgate.cjs cycle layers-4.json | head -1; echo rc=$?'
  有 pipefail: rc=1
```

同一条命令、同一个失败、只差 `set -o pipefail`。CI 脚本里 `... | tee log.txt`、`... | tail -50` 到处都是，**默认 shell 不报错只吞码**。

**3）增量构建说"没事做"。** 第 8 节实测过的同一条，放在 CI 语境里更致命：

```text
$ touch common/render_detail.h && make -f Makefile.nodeps all
mingw32-make: Nothing to be done for 'all'.
rc=0
```

Makefile 没写头文件依赖时，缓存里有旧 `.o` 的 runner 会得到"构建成功"，而产物是**改动之前的代码**。这种失败连"绿"都算不上绿——它什么都没做。

**4）产物身份被冻结。** `core/version.h` 由 `printf ... > $@` 生成，规则**没有任何依赖**，于是第一次生成之后就永不更新：构建 rc=0、测试 rc=0、产物里的 `BUILD_ID` 却停在 `v1.0.0`，而流水线声称的是 `v1.0.0-2-g49ec78e`。拦住它的是 `verify` 阶段那行 `grep -ao "$BUILD_ID" dist/app.exe`：

```text
### verify
产物里没有构建标识        rc=1
```

修法是把生成规则挂上 `FORCE` 依赖（`core/version.h: FORCE`），改完 `verify: 产物含 v1.0.0-4-gc237f0f 且校验和一致` rc=0。**这一条和第 9 节"dist 里 0 处版本标识"是同一个病的两个阶段**：不是步骤失败了，而是产物没有身份证。

（前棒在处理 Pages 时记录过两条同类现象：空仓库默认走 legacy 源、`deploy-pages` 报成功但页面没变。**我在本机无法复现——没有 runner，本栏已发布文章里也没有它们的原文**，这里只作为同构论据引用，不当作实测结论。上面四种假绿是我自己跑出来的。）

## 五、自动发布的边界：机器能判的，和必须有人按钮的

`identity` 阶段是本节唯一"人工确认边界"的机械化实现：

```text
$ git describe --dirty --always --tags
v1.0.0-4-gc237f0f-dirty
工作区有未提交改动：拒绝出包（自动发布的人工确认边界）      identity rc=1
```

它的价值在一次真实的翻车上得到验证：我为了让报告文件可提交，把 `report.tsv` **提交进了仓库**，于是流水线每次运行都会改写它 → 工作区永远脏 → 门禁永远红，而且**原因是门禁自己造成的**：

```text
$ git status --porcelain
 M report.tsv
```

修法：`git rm --cached report.tsv` + 写进 `.gitignore`，之后 `identity rc=0`（上面第二节的表就是修好之后的运行）。这条比"要有一个 dirty 门禁"更值得记：**流水线的输出必须落在不被跟踪的路径里**，否则它污染自己的输入。

重入性（同一命令跑两次会不会出两个结果）实测：

```text
$ git tag -a v1.0.0 -m again   → fatal: tag 'v1.0.0' already exists        rc=128
$ git tag v1.0.0               → fatal: tag 'v1.0.0' already exists        rc=128
$ git push origin v1.0.0       → * [new tag]  v1.0.0 -> v1.0.0            rc=0
$ git push origin v1.0.0（第二次）→ Everything up-to-date                   rc=0
$ git tag -f -a v1.0.0 HEAD    → Updated tag 'v1.0.0' (was 20f1c17)        rc=0
$ git push --force origin v1.0.0 → + 20f1c17...eeec958 v1.0.0 (forced update)  rc=0
```

**打 tag 天然重入安全（第二次硬失败），推 tag 天然幂等（第二次"up-to-date"）——这两件都不用写脚本兜。要防的是第三件：`-f` 能在本机把一个已经发布的 tag 悄悄挪到别的提交上（`20f1c17 → eeec958`），全程 rc=0、一句警告都没有。** 我在本地 bare 远端上验证了这条路完全通畅；服务端有没有拦（tag protection、signed tags、environment 审批）本机**未实测**，因为没有 runner 也没有仓库管理权限。

于是边界的划分标准可以写成一句：**能用退出码判定的就自动化（dirty、tag 是否已存在、产物哈希、schema 校验、覆盖率、架构违规数），需要"承担不可逆后果"的必须人按钮（移动/删除已发布 tag、放量比例、回滚决定、CHANGELOG 冲突的取舍）。** 第 9 节里那条 CHANGELOG 回滚必冲突就是典型：机器能报冲突，但"保留哪一行"是人决定的。

## 六、失败通知与可观测：一张表 + "哪些阶段没跑"

`report.tsv` 就是本节的最小可用可观测层——每行一个阶段、一个退出码、一个耗时，机器可解析、人能扫一眼：

```text
identity   rc=0     228ms
format     rc=0     399ms
arch       rc=0     272ms
build      rc=0    1701ms
test       rc=0     158ms
package    rc=0     211ms
verify     rc=0     174ms
repro      rc=1    2664ms
```

两种执行模式的实测差别：

```text
mode=stop（遇错即停）    identity rc=1  228ms  →  FAILFAST 停在 identity（后续阶段未执行，结论未知）
                          只跑了 1 个阶段，228ms 结束，整体 rc=1
mode=collect（跑完全部）  8 个阶段 5807ms，能回答"这次一共坏了 1 个"
```

**贵 25 倍的时间换来的是"失败总数"**。实践中我的取舍是：门禁类阶段（格式、静态检查、架构）用 collect 全跑，因为它们互不依赖、一次看全比来回修三轮省时间；而 `build` 之后的阶段天然依赖它，build 红了就没什么可看的——这时 fail-fast 才是对的。注意那条标记行必须写"结论未知"：第 8 节量过链接器**只报第一个缺口**——同一个循环依赖工程，自顶向下那一遍只报了 1 处 `undefined reference`，而反向那一遍报出 4 处，"遇错即停"的报告天生低估问题的数量。

通知正文要带的字段，按我这次踩的顺序排：`BUILD_ID`（含不含 `-dirty`）、失败阶段名、该阶段日志尾部、以及"哪些阶段没跑"。日志尾部的行数本身也会出错——我拿 `tail -4` 抽失败阶段时，把汇总脚本内部的 `FAILFAST` 标记行也当成了阶段名：

```text
### STAGE-FAIL-FAST:
tail: cannot open 'log/STAGE-FAIL-FAST:.txt' for reading: No such file or directory
```

**可观测层自己也要被测一遍**：任何"把行首 token 当事件名"的解析都会把自家日志当数据。修法是给标记行固定一个可过滤的第一列（`FAILFAST\trc=…`）并在 awk 里排除。

真实通知通道（邮件、Webhook、IM 机器人）**未实测**：本机没有 runner，也没有可写的 webhook 端点；`report.tsv` + 进程退出码是能在这里交付的全部接口——不过这两样恰好就是通道对接需要的全部输入。

### 附：可复现性门禁要不要上？四条实测

我在第 9 节把"`SOURCE_DATE_EPOCH` 能不能让 MinGW 产物逐字节可复现"列为未实测，这里补测了，结论一条比一条意外：

```text
① 同一份源码两次构建（默认）      84932 字节，差 2 个字节（偏移 137 = TimeDateStamp 低字节；217-219 = PE CheckSum）
② SOURCE_DATE_EPOCH=1700000000    Time/Date 仍是真实钟点 01:34:58，两次构建差 1 字节      → MinGW 这条链不认它
③ -Wl,--no-insert-timestamp       Time/Date = Thu Jan 01 08:00:00 1970，两次构建 sha256 完全相同（20e1f0857c9b713ab…）
④ 但流水线的最后一步是 strip：     同一份输入隔 4 秒各 strip 一次 → 又差 2 个字节（偏移 137）
```

第 ④ 条是意外：`strip --strip-all` 会把 PE 的 `TimeDateStamp` **重新写成当前时间**，把第 ③ 条的努力覆盖掉。所以"两次构建必须逐字节一致"这条门禁在当前工具链下**上不了**——它不会变成"发现真实问题"的信号，只会变成一个永远红的合法失败，而永远红的门禁的最终结局是所有人忽略它。正确的做法是第 9 节那条：**归档产物 + 哈希，回滚时取归档**，而不是要求重编等价。

## 小结

- 本机能对 workflow 做的只有**结构解析 + 等价命令**：`deploy.yml` 是 2 job / 6 步，`permissions` 最小化、`concurrency.cancel-in-progress: false`；而 PyYAML 把 `on:` 读成布尔 `True` 这一条就说明，**本地校验器和平台解释器不是同一份语义**。`npm ci` / `npm run build` / 部署我一步没跑（无 runner，博客仓库只读）。
- 8 阶段流水线全绿实测 5807ms（去掉重编型阶段 `repro` 是 3143ms），每阶段一个退出码：`clang-format` 399ms、架构门禁 272ms、`-Werror` 构建 1701ms、测试 158ms、打包+校验 211ms、产物验证 174ms。**测试程序的退出码就是失败断言数**，这一步做到之前谈不上门禁。
- **假绿四种，全部实测**：阶段包装层 `return 0`（8 个阶段里 2 个 rc≠0，而脚本自称整体 rc=0）、`gate | head -1` 让 rc 从 1 变 0（`set -o pipefail` 才 1）、`make` 回 `Nothing to be done for 'all'.` 且 rc=0、生成的 `version.h` 无依赖导致构建号被冻在第一次的值（构建 rc=0，`verify` 用 `grep -ao "$BUILD_ID" dist/app.exe` 拦下）。**门禁的判据是产物，不是步骤退出码。**
- 架构门禁能让第 8 节那个"编译运行全正常"的循环依赖工程红掉：`分层违规 3 | 成环模块数 4` rc=1，修复版 `0 | 0` rc=0——编译器的退出码不覆盖架构。
- 自动化的边界用退出码划：`git describe --dirty` 拒脏树（实测 `v1.0.0-4-gc237f0f-dirty` rc=1），但**报告文件一旦被 Git 跟踪，流水线就会把自己弄脏**（` M report.tsv`），这是门禁自造的死循环；`git tag` 重入硬失败（rc=128）、`git push` tag 幂等（`Everything up-to-date`），而 `git tag -f` + `git push --force` 挪走已发布 tag 全程 rc=0 无警告——**这类不可逆动作只能靠服务端保护和人来按钮**。
- 可观测层的取舍是"遇错即停省钱但低估问题数"（实测只跑 1 阶段 228ms vs 全跑 5807ms；链接器只报第一个缺口），而且汇总脚本自己也会把内部标记行当事件名（`tail: cannot open 'log/STAGE-FAIL-FAST:.txt'`）。
- **未实测清单**：GitHub Actions 上的真实日志与耗时、`ubuntu-latest` 里 `clang-format` 的版本与门禁差异、npm/依赖缓存的命中率、`environment` 审批与 tag protection 的服务端行为、任何真实通知通道（邮件/Webhook/IM）、以及"流水线在 runner 上的失败可观测性"（我只能交付 `report.tsv` + 退出码这一层接口）。
