---
title: Code Review：能让机检的都别留给眼睛
description: 实测把 12 种坏 frontmatter 喂给本仓库现有的门禁，机器抓住 8 种、放过 4 种，其中"date 带时间"会让发布日静默退一天；而 12 种注入 + 57 篇文章全量校验只花 0.58 秒（3 次中位）——评审预算该花在哪，数字很清楚。
date: 2026-10-15
tags: [工程实践, Code Review, 静态检查]
category: engineering
section: eng-review
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1；Node v22.19.0，校验用的 zod 是仓库 `node_modules` 里的真实副本。仓库级数字以提交 **b43d2ad** 为锚点（50 个提交、94 个跟踪文件、57 篇文章、14 大类 156 节）。博客仓库只跑了只读命令（`git log --numstat` / `git archive` / `git ls-files`），所有写入与注入实验都在 `C:/Users/wangt/AppData/Local/Temp/agents/engineering3/`；本轮按纪律没有跑 `npm`/`npx`，所以 `astro check` 的耗时属于**未实测**。第三节的守卫逻辑是逐字抄自 `src/content.config.ts`（那份文件第 1 行 import `astro:content`，Node 加载不了，实测报 `ERR_UNSUPPORTED_ESM_URL_SCHEME … 'astro:'`）。

## 一、先决定评审预算花在哪：50 个提交里只有 9 个改了行为

```text
$ git log --numstat --format=@%h --date=short b43d2ad     # 402 行输出，脚本聚合
提交数=50  改动行数 min=2 中位=190 p75=254 p90=538 max=7801 平均=402
>200 行=20  >400=7  >800=4  >2000=1；每提交文件数 中位=1 p90=4 max=36
动过代码/配置的提交=9/50；代码行合计=8499；纯文章提交=41
  df25077 代码  7431 文章   189 文件 36  init: Astro 内容集合博客 + GitHub Pages 部署流水线
  04c0556 代码  1000 文章     2 文件 16  feat: 14 个技术专栏的章节地图与占位页
  e1a65f4 代码    44 文章   504 文件  7  feat(concurrency): 第五节 pthread 与 std::thread
除 init(df25077) 外代码改动共 1068 行、8 个提交，中位=5.5，最大=1000
```

这张表直接给出优先级：**"会改变程序行为"的提交只有 9/50，而且去掉第一个 init 之后，单个提交平均只改 5.5 行代码**——这类改动值得逐行读。另外 41 个是纯内容提交，中位数 190 行，读法完全不同（核事实、核跑没跑过，不核逻辑）。

评审真正不可行的地方也很具体：

```text
纯文章提交 top3（锚点 b43d2ad）：
  c38eed2  文章 1150 行  文件  7   feat(...): 收录 4 篇文章
  b43d2ad  文章  887 行  文件  4   feat(concurrency+qt6): 第八节 原子操作与内存序；Qt 第二节 信号槽与元对象系统
  91028b2  文章  512 行  文件  4   feat(concurrency+engineering): 第七节 并发设计模式；工程实践三节复核重写
代码+文章混在一个提交的=5 个: e1a65f4(代码44/文章504), c2adf17(代码5/文章441), fc4937a(代码6/文章396), 04c0556(代码1000/文章2), df25077(代码7431/文章189)
```

1150 行一次提交，等于宣告"这次没人会真读"。**"一篇一提交"和"代码改动不与内容改动混在一个提交"这两条规矩，本仓库的数据是：后者被违反了 5 次**，而这 5 个恰好是最需要人读的那几个（`04c0556` 的 1000 行代码被 2 行文章淹没在同一个 diff 里）。小步不是美德，小步是**让"逐行读"这个动作在物理上成立**。

## 二、现有的自动化门禁清单：只有构建

| 门禁 | 实测状态 |
| --- | --- |
| CI 里的步骤 | `deploy.yml` 的 `run:` 只有 `['npm ci', 'npm run build']`，**0 条** test / lint / check |
| `package.json` | scripts 有 `check`，但 `devDependencies` = **None**，CI 不调用（上一节已证） |
| 本地钩子 | `.git/hooks` 里非 `.sample` 的文件 = **0** |
| 构建期守卫 | `content.config.ts`：9 个字段 zod schema + transform 里 4 个 `throw` |

也就是说唯一硬门禁是构建期那份 schema+守卫。它值不值得用？跑一遍全量的代价：

```text
node gate.mjs(12 种注入 + 57 篇真实文件跑 schema 与守卫)  → 0.58 s
node --test pure.test.ts(18 test / 36 断言)               → 0.62 s
node --test di.test.ts(5 test 注入式)                      → 0.61 s
git log --numstat 全历史(50 提交)                          → 1.03 s
git status --porcelain                                    → 0.22 s
```

（每个都跑 3 次取中位；同机还有别的 agent 在跑，单次会漂移 20-40%。）**半秒级**。任何"这条规则我们靠评审保证"的说法，在这个成本面前都不成立——评审时间应该只留给机检给不出的东西。

## 三、把 12 种错误喂进去，机器抓住几种

`gate.out` 原样输出（① 是合法基线）：

```text
①最小合法                    通过 → 落库值 tags=[] description="" date=2026-10-15 draft=false
②没 title                    zod 拦下：title / invalid_type
③没 date                     zod 拦下：date / invalid_type
④date 带时间                  通过 → 落库值 tags=[] description="" date=2026-10-14 draft=false
⑤date 非法                    zod 拦下：date / invalid_type
⑥tags 写成 tag（拼错）         通过 → 落库值 tags=[] description="" date=2026-10-15 draft=false
⑦tags 是字符串不是数组         zod 拦下：tags / invalid_type
⑧draft 写成字符串             zod 拦下：draft / invalid_type
⑨description 空              通过 → 落库值 tags=[] description="" date=2026-10-15 draft=false
⑩section 拼错                transform 拦下：section 不存在
⑪只有 category               transform 拦下：category 不在大类清单里
⑫没有 category 只有 section   transform 拦下：写了 section 但没写 category
```

**8/12 被拦，4 个通过——其中 3 个是应该拦的漏网**，而且漏网的三种全是同一个脾气："不报错，只静默改数据"：

| 漏网 | 后果 | 为什么机检抓不到 |
| --- | --- | --- |
| ④ `date` 带时间 | 落库日期从 10-15 变成 **10-14** | `z.coerce.date()` 认为它合法，且已经"修好"了 |
| ⑥ `tags:` 拼成 `tag:` | 文章从所有标签页消失（`tags` 走 `.default([])`） | zod 默认丢弃未知键，不报错 |
| ⑨ `description` 空 | 列表页 / OG / RSS 摘要空字符串 | `.default('')` 明写允许空 |

真实数据这一遍：`真实 57 篇：schema 通过=57 拦截=0；无 section 的=2`、`被 2 篇以上占用的章节 id=0`。**"重复章节"和"category 不匹配"确实被守住了**，值得肯定；但注意 transform 的三条 `if` 全都在 `if (section)` 里面——**没写 section 的文章（锚点上 2 篇）永远不会被检查**，这类"不进章节地图"的文章可以随便挂错大类。

## 四、人才能抓的第一条：一个 `date` 少写一个 Z，发布日退一天

④ 不是理论问题，链条完整可复现（8 种写法实测，本机 `TZ offset=-480`）：

```text
"2026-10-15"                 通过 → ISO=2026-10-15T00:00:00  显示=2026-10-15 / 2026年10月15日
"2026-10-15T00:30"           通过 → ISO=2026-10-14T16:30:00  显示=2026-10-14 / 2026年10月14日
"2026-10-15 00:30"           通过 → ISO=2026-10-14T16:30:00  显示=2026-10-14 / 2026年10月14日
"2026-10-15T23:30:00+08:00"  通过 → ISO=2026-10-15T15:30:00  显示=2026-10-15 / 2026年10月15日
"10/15/2026"                 通过 → ISO=2026-10-14T16:00:00  显示=2026-10-14 / 2026年10月14日
"2026-13-45"                 zod 拒绝：invalid_type
```

7 种被接受，**4 种渲染成前一天**，连 `10/15/2026` 这种"看起来该报错"的写法也被吞下并回退一天。机制在两处接缝：`z.coerce.date()` 对无时区的时间串按**本地**解析，而 `src/utils/post.ts` 的 `utc()` 取的是 `getUTCFullYear/getUTCMonth/getUTCDate`。UTC+8 上任何早于 08:00 的时间都会退一天，08:00 整又恰好正确——**边界藏在"看起来没问题"的那一侧**。

必须诚实标注现状：锚点 57 篇里 `date` 带时间成分的 = **0**，所以这是尚未发作的雷，不是线上事故。

评审意见该写成这样（现象 + 复现 + 影响 + 可执行二选一 + 严重性），而不是"日期处理有问题"：

```text
严重性：中（当前 0 篇触发；一旦有人补 updated 时间就静默改历史日期）
现象：date: 2026-10-15T00:30 在 UTC+8 构建后显示为 2026-10-14
复现：8 种输入的 zod 解析 + isoDate 渲染结果表（脚本 0.58s 可重跑）
建议二选一：
  A. content.config.ts 加一行 shape：date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).pipe(z.coerce.date())
  B. utc() 改用 getFullYear/getMonth/getDate（本地日）——但这会让 CI(Ubuntu) 与本地(Windows) 结果不同
```

A 是机检，一次改动，之后 ④ 变成"构建失败"。B 引入跨平台不确定性。**好的评审意见会顺带指出"哪个选项能让这条意见以后不再需要人提"**。

## 五、人才能抓的第二条：注释比实现大（以及怎么记录没复现的失败）

`tagFolder` 上方的注释写着"必须压成跨平台安全的形态"。实测它对这几类完全不处理（`probe.out`）：

```text
tf('NUL')      => "NUL"        tf('Git.')     => "Git."
tf('CON')      => "CON"        tf('COM1.doc') => "COM1.doc"
tf('lpt9')     => "lpt9"       tf('Windows / Win32 编程') => "Windows - Win32 编程"
```

保留名（CON/NUL/COM1/LPT9）、结尾点号、以及"空格照样留在目录名里"都过了。我据此写了一条评审意见，断言"Windows 本地构建会炸"——**然后实测没炸**。我把两种建目录的方式放进同一个临时目录跑了两遍，第二遍的结果比第一遍更值得写（`reserved.txt`，同一个目录里先由 Python 建 8 个，再由 Node 建 4 个）：

```text
CON / NUL / com1 / LPT9 / Git. / aux.txt / foo.. / C++-QT   python os.mkdir 全部 -> OK
python listdir(resvmk2) = ['C++-QT','CON','Git','LPT9','aux.txt','com1','foo']
python isdir: NUL=False   CON=True   Git.=True   Git=True

n_CON / n_NUL / n_com2 / n_Git.  node mkdirSync -> OK
write into n_NUL -> OK
node readdir = [...,"Git","LPT9","n_com2","n_CON","n_Git.","n_NUL"]
read back n_NUL/index.html = "hello"
```

三个都是事实，且互相打脸：**Python 报成功的 `NUL` 在 listdir 里根本不存在**（`isdir('NUL')=False`，是静默空操作）；**Python 建的 `Git.` 落成了 `Git`**（尾点被剥掉，但用 `'Git.'` 去 stat 又返回 True）；而**同一个目录里 Node 建的 `n_NUL`、`n_Git.` 是真的存在**，写进去的文件还能原样读回。我另起的一次复跑里，`cmd` 的 `dir /b` 也列出了 Node 建的 `NUL` 目录，`type` 还能读到里面的文件内容。

所以正确的结论不是"tagFolder 有 bug，构建一定失败"，而是：**"这段代码把安全性押在一个连本机两个 API 都不一致的未定义区上"**。同名目录、同一次运行、两种结果——它没兑现注释里的承诺，也很难兑现。这种意见在评审里应该以提问落地，而不是以断言落地："要不要显式排除保留名/尾点/尾空格？如果决定不管，请把注释改成它实际保证的东西（只替换 `<>:"/\|?*` 和控制字符）。"

顺带一条同样只有人会发现的东西：`isoDate` 用 `padStart(2,'0')` 补零，`formatDate` 不补（实测同一日期得到 `2026-01-05` 与 `2026年1月5日`）。这不是错，但**同一次提交里两个相邻函数对同一个概念用两种规范**，是评审该问"是不是有意的"那一类——机检永远不会报它。

## 六、写进 schema 的约定 0 漂移，写进散文的约定漂成四种

同一批"规矩"，两种载体，实测差别是全部的：

```text
锚点 b43d2ad 提取 57 篇文章实测：
"> 环境：" 开头=53/57          有"小结/结论"章=18/57
首个 ## 以"一、"开头=54/57      行数 min/中位/p90/max=47/186/253/442
description 长度 min/中位/max=37/98/289（<40 的 1 篇）
零表格文章=10；无 section 字段=2
无 "> 环境：" 开头的 4 篇 = astro-content-collections.md, c-basics-types-operators.md, git-daily-workflow.md, hello-github-pages.md
```

对照第二、三节：`category/section` 一致性 57 篇 **0 违规**，因为它是代码；"> 环境"开头缺 4 篇、"小结"只有 18/57、章节标题样式 3 种写法，因为它们只活在作者脑子里和提示词里。

结论一句话：**评审时看到风格不一致，别写评论，写守卫**。`description` 最短 37 字符、最长 289——真要管就写 `z.string().min(20).max(160)`；不想管就把它写成"允许为空"，然后别再在评审里提它。

## 七、最小落地顺序（按实测成本排）

| 顺序 | 动作 | 成本（实测/推算） | 立刻抓掉第三节里的哪个漏网 |
| --- | --- | --- | --- |
| 1 | 给 `date` 加 `regex(/^\d{4}-\d{2}-\d{2}$/)` | 一行 schema 代码 | ④ |
| 2 | `schema.strict()` 或显式列出允许的键 | 一行 | ⑥（拼错的 `tag:` 会当场报错） |
| 3 | `description` 给下限，或把 `section` 从 optional 改成必填 | 一行 | ⑨ / "2 篇无 section" |
| 4 | CI 增加一步 `node --test`（`node:test` 内置，无需装依赖） | ~0.9 秒（本机实测） | 行为回归 |
| 5 | 把内容/代码拆分提交，1150 行那种一篇一提交 | 纪律，不花时间 | 让 1–4 的意见有人真读 |

前三条都是**构建期**改动，等于把评审意见一次性固化；第 4 条把"跑测试"接进唯一那个门禁。未实测的点：`astro check`（`npm run check`）接入 CI 的实际耗时——本轮禁止跑 `npm`/`npx`，只知道它存在且从未被调用；GitHub Actions 那边的 `node-version: 22` 与本机 `v22.19.0` 同大版本，`node:test` 可用。

## 八、小结

- 评审预算按数据分：50 个提交里**只有 9 个改了行为**，去掉 init 后代码改动中位 **5.5 行**；41 个纯内容提交中位 190 行，5 个提交把代码和内容混在一起（最极端 `04c0556`：1000 行代码 + 2 行文章）。
- 机检便宜到没有借口：**12 种注入 + 57 篇全量校验 = 0.58 秒**（3 次中位），`node --test` 0.62 秒，全历史 `numstat` 1.03 秒。
- 现有门禁抓住 **8/12**；漏掉的三种全是"静默改数据"型：`date` 带时间退一天、`tag:` 拼错丢标签、`description` 空。**transform 的三条守卫都写在 `if (section)` 里，没写 section 就永不检查**（锚点上真实存在 2 篇）。
- 人才能抓的：①`z.coerce.date()` + `utc()` 两处接缝导致 UTC+8 上 8 种写法里 4 种渲染前一天（现状 0 篇触发，是雷不是事故）；②注释承诺大于实现——保留名/尾点原样通过，而失败无法断言，因为**同一台机器上 Python 建 `NUL` 是空操作、Node 建 `NUL` 成功且可读写**，两个 API 不一致本身就是结论。
- 约定载体决定漂移量：进 schema 的 0 违规，进散文的缺 4 篇 / 只有 18 篇有小结 / 3 种标题样式。看到不一致就写守卫，别写评论。
- 评论格式：现象 + 复现命令 + 影响面 + 可执行二选一 + 严重性；最好的意见会附带"选哪个方案能让这条意见以后不用再提"。
