---
title: README 是可执行文件
description: 把 README 的每一句声明当断言跑一遍——6 条主要断言全对，唯一说谎的地方是 `package.json` 里第 4 个脚本 `npm run check`：文档一次没提、CI 也一次没跑。
date: 2026-10-15
tags: [工程实践, 文档, README]
category: engineering
section: eng-doc
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1；Node v22.19.0（`--experimental-strip-types` 直接 import 仓库里的 TypeScript）；Python 3.14.6；curl 8.x。对象是真实仓库 `C:\Users\wangt\data\blog`，仓库级数字一律以提交 **a3bd284** 为锚点（44 个提交、README 97 行、42 篇文章、14 个大类、156 个章节）；线上站 `https://wty.blogs.abrdns.com` 只发了 GET/HEAD 请求，未做任何写操作。

## 一、文档的失败模式不是"没写"，是"写了但没人校验"

README 97 行、2 个 bash 代码块，写了这几条命令：

```text
npm ci / npm run dev / npm run build / npm run preview
```

`package.json` 的 scripts 实测有 4 个：

```text
[ 'build', 'check', 'dev', 'preview' ] 1.0.0
```

**`check` 在 README 里一次都没出现**（`"check" in README` 用 Python 判定为 `False`），而且部署流水线里也没调用它——`.github/workflows/deploy.yml` 里的 `run:` 只有两条：

```text
29:        run: npm ci
31:        run: npm run build
```

也就是说：项目里存在的第三条校验路径，文档不提、机器不跑，只有作者本人知道。这类缺口不是"文档写得少"，是"文档没有和事实对表"。

对表的做法很简单，把文档里的每个数字都变成一条能跑的断言：

```text
README 声称：14 个大类、156 个章节
脚本实测：categories 14，sections 156，重复 id 0
```

## 二、最小可运行文档结构：五段，每段一条可验证断言

| 段落 | 本仓库的答案 | 怎么验证它是真的 |
| --- | --- | --- |
| 这是什么 | 纯静态博客，Astro 5 + GitHub Pages | `astro.config.mjs` 里 `output: 'static'` |
| 怎么跑起来 | 4 条 npm 命令 | 逐条对照 `package.json` 的 scripts（这一步查出 `check` 缺失） |
| 往哪放东西 | `src/content/posts/*.md`，文件名即 URL | 抓线上 `/posts/<文件名>/` 返回 200 |
| 有什么规矩 | 9 个 frontmatter 字段、category/section 必须匹配 | 把 README 的字段清单和 zod schema 求差集 |
| 怎么发布 | 推 main，约 40 秒上线，Source 必须是 GitHub Actions | 比对 HEAD 提交时间与线上 `Last-Modified` |

"约 40 秒上线"这条实测（锚点提交那次部署的真实输出）：

```text
$ git log -1 --format='%h %cI'
a3bd284 2026-10-15T18:07:36+08:00
$ curl -sSI https://wty.blogs.abrdns.com/ | grep -i last-modified
Last-Modified: Thu, 15 Oct 2026 10:08:09 GMT
$ curl -sS -o /dev/null -w "%{http_code}\n" https://wty.blogs.abrdns.com/posts/conc-condition-variable/
200
```

18:07:36 (+08) 提交，线上内容时间戳 10:08:09 UTC（=18:08:09），**33 秒**，最新一篇可访问。README 写"约 40 秒"是保守了 7 秒——保守是允许的，方向性错误才致命。

写完这一段我又复跑了一次同一个检查，它变成了更有用的东西：

```text
$ curl -sSI https://wty.blogs.abrdns.com/ | grep -iE "^HTTP|last-modified"
HTTP/1.1 200 OK
Last-Modified: Thu, 15 Oct 2026 10:46:03 GMT        ← 对应更晚的一次部署
$ curl -sS -o /dev/null -w "%{http_code}\n" https://wty.blogs.abrdns.com/posts/engineering-style-naming-and-formatting/
404
```

同一篇 README 里还有一句"会 301 跳过来"，也复跑确认：`curl -sSI https://tianyuncode.github.io` 返回 `HTTP/1.1 301 Moved Permanently`、`Location: https://wty.blogs.abrdns.com/`。这类"一句话一条断言"的检查，写的时候 10 分钟，之后每次改域名/改路由/改字段都能重跑，这才是文档能长期不腐烂的唯一办法。

## 三、接口文档：让机器读的那份才是主文档

本仓库最重要的"接口"是 frontmatter。README 里给的是给人看的示例块（`## 写文章` 小节下那段标注为 markdown 的 frontmatter），`src/content.config.ts` 里给的是给机器看的 zod schema，两边必须一致：

```text
README 列出的字段：title description date tags category section updated draft comment  (9)
zod schema 的字段：title description date tags category section updated draft comment  (9)
差集：空
```

而且 schema 不是"记录规矩"，是**执行规矩**——`content.config.ts` 的 transform 里有 4 个 `throw new Error`，把跨文件的一致性做成了构建期硬约束。我用 Node 直接 import 真实的 `categories.ts`，复刻这 4 条守卫扫了一遍工作区（`node --experimental-strip-types`，实测 0.40 秒）：

```text
扫描 52 篇，撞守卫 0 篇；已覆盖章节 50 个
engineering 共 10 节，已写 4 节： eng-git-basics,eng-style,eng-doc,eng-git-advanced
--- 三个故意的错误 ---
「demo.md」的 section "eng-nosuch" 不存在
「demo.md」的 section "eng-style" 属于大类 "engineering"，不是 "cpp"
「demo.md」写了 section "eng-style" 但没写 category
```

（42 是锚点提交里的文章数，52 是写作本文这一行的实时数——**这个数字每小时都在变，所以它不该被写进任何散文里**，只该由脚本现场数。）三条错误信息各自指到具体文件、具体字段、具体期望值——这就是接口文档该有的样子：**报错即文档**。README 里那句"写错构建时直接报错并指出是哪篇"因此是可验证的断言，不是承诺。

示例代码同理。README 里那段示例 frontmatter（`category: cpp` / `section: cpp-template`）被我当作输入喂给同一套守卫：

```text
示例通过守卫 = true
示例指向的章节 = C++ 语言 / 模板与泛型 / 进阶
```

**文档里抄了示例，就必须把示例跑一遍**。否则示例会先于正文过期。

## 四、单一事实源：一个文件 vs 一段散文

`src/data/categories.ts` 301 行、37904 字节，是仓库里最大的非文章源文件（第二名 `src/styles/global.css` 21883 字节）。它同时承担三件事：专栏页的章节列表、每节应覆盖的知识点、以及上面那套校验用的索引（`CATEGORY_MAP` / `SECTION_INDEX`）。实测依赖面（脚本解析每条 `import` 后统计）：

| 文件 | 直接 import 它的文件数 | 传递依赖数 |
| --- | --- | --- |
| `src/utils/post.ts` | 12 | 12 |
| `src/config.ts` | 10 | 16 |
| `src/layouts/BaseLayout.astro` | 10 | 11 |
| `src/data/categories.ts` | 7 | 10 |

README 里"改章节地图只动一个文件"的说法，对应的事实就是这张表：改一处，7 个文件、10 个传递依赖方全部自动跟着变，包括校验逻辑本身。**文档描述的是机制，不是愿望**。

反面案例在本仓库也有：那 156 这个数字如果散落在 README、专栏页、任何一篇教程里，就有 3 处会过期。现在的做法是页面直接渲染 `CATEGORIES`，只有 README 里那一处硬编码。

## 五、变更记录与决策记录：本仓库的真实样本

`CHANGELOG` 文件不存在（`ls CHANGELOG*` 报 no such file），变更历史完全由提交信息承担。锚点提交上 44 条的前缀分布：

```text
feat 37   chore 3   docs 2   fix 1   init 1        ← 合计 44
```

这个分布说明两件事：一是**约定确实被执行了**（37/44 是 feat，标题里带大类名，例如 `feat(data-structures): 第十一节 贪心、分治与回溯`）；二是**约定有漏网**（`init:` 不在 Conventional Commits 的词表里，一条 `git log --format='%s' | grep -vE '^(feat|fix|docs|chore|test|refactor)'` 就能抓出来）。

决策记录（ADR 的最小可用形态）在本仓库是这么留痕的——同一个"域名"问题，5 个提交把决策过程记全了：

```text
1df0d5f docs: README 记录实际部署状态与后续加域名的步骤
affe43a chore: 站点地址定为 tianyuncode.github.io 根站
843d484 chore: 站点域名切到 wty-blog.abrdns.com
640d6d3 chore: 域名定为 wty.blogs.abrdns.com（DNS CNAME 已验证生效）
ca78df0 docs: README 记录已启用的自定义域名
```

一条好的决策记录只需要四个要素，这里全齐：**决定了什么**（域名）、**否决了什么**（前一个方案，843d484 被 640d6d3 覆盖）、**怎么验证的**（"DNS CNAME 已验证生效"）、**文档同步了吗**（ca78df0 单独一个 docs 提交）。`dist/CNAME` 里那行 `wty.blogs.abrdns.com` 是最后一块拼图——注意 `dist/` 是构建产物、没有进版本控制，所以它是"当前构建"的物证而不是"历史"的物证，历史仍然只能靠提交信息。

不建议把决策写进 README 正文的段落里：散文会被改写，提交信息不会。需要长期存档时，单独一个 `docs/decisions/NNN-xxx.md` 文件 + 一次提交，比 wiki 页面可靠，因为它的历史是内容的一部分。

## 六、"让新人一天内跑起来"是可以验收的

这句话不该出现在 README 里当口号，它是一张检查表。按本仓库实测：

| 步骤 | 需要的时间/信息 | 卡点 |
| --- | --- | --- |
| 装依赖 | `npm ci`，锁文件 203055 字节（198.3 KB）、395 个 `"resolved"` 条目、3 个直接依赖 | 无 |
| 起本地站 | `npm run dev` → localhost:4321 | 无 |
| 知道往哪写 | README 明示 `src/content/posts/`，"文件名即 URL" | 无 |
| 知道字段怎么填 | 一个可跑的示例 + 4 条守卫的报错 | 唯一硬门槛：得先在 `categories.ts` 找到 section id |
| 知道怎么发布 | 推 main；33 秒；Source 必须是 GitHub Actions | README 明确写了报 `Pages not enabled` 时去看哪里 |

真正决定"一天能不能跑起来"的是第 4 行：**新人不需要问人**。这一条本仓库是靠"报错信息可定位"实现的——写错 section 不会静默丢文章，而是构建失败并指到文件名。反例是"章节挂了但地图上看不见"，那种项目新人要问三天。

还有一个容易被忽略的文档面：**没写的东西也要可见**。`dist/categories/` 里每个大类页把 156 节全部列出，已写的挂链接、未写的显示"敬请期待"并列出该节计划覆盖的知识点——当前构建产物里这个串出现 **113 次**（165 个文件、约 3 MB）。这就是"路线图即文档"，比 `TODO.md` 更新得快。

## 七、文档腐烂的三个信号

用本仓库的数据说，三个信号分别长这样：

1. **文档提到的命令不在 scripts 里，或 scripts 里有文档没提的**（实测：`check` 命中后者，1/4 的脚本没进文档，且 CI 不调用）。
2. **文档里的数字没有对应的校验**（实测：14/156 目前属实，但没有任何一条守卫保证它下周还属实；把它写进 `categories.ts` 的自检或用断言脚本才是解法）。
3. **文档指向的产物和内容脱节**：`dist/` 是上一次构建的快照而不是当前源码的快照。本文两次测量之间它就从"152 个文件/116 处占位"漂到"165 个文件/113 处占位"——所以文档里要写"**如何确认线上状态**"（curl + `Last-Modified` 对比），而不是写"线上有什么"。

写文档的纪律因此可以压缩成三行：

- 能变成断言的句子，都变成断言；
- 不能变成断言的句子，只写"怎么验证"；
- 每次改行为，同一个 PR 里改文档（本仓库 `docs` 提交 2 次，都紧跟在行为改动之后）。

## 八、小结

- README 97 行里可验证的断言我逐条跑了：**14 个大类/156 个章节、0 重复 id、301 跳转、CNAME 值、9 个字段与 zod schema 差集为空、示例 frontmatter 通过 4 条守卫**——全对。
- 查出来的真实缺口只有一个：`npm run check` 存在但 README 没提、CI 没跑（流水线只有 `npm ci` + `npm run build`）。
- "约 40 秒上线"实测 **33 秒**（提交 18:07:36 → 线上内容时间戳 18:08:09，最新页面 HTTP 200）；同一检查复跑还能发现"写了但没发布"的文章返回 404。
- 文档的正确形态是**可执行的**：把规矩写进 `content.config.ts`（4 个 throw，扫 52 篇 0 违规、0.40 秒），比写进散文可靠一万倍。
- 决策记录放在提交信息里（域名演进 5 个提交全说清了），变更记录也放在提交信息里（44 条，前缀违规 1 条可用 grep 抓出来）。
- 判断文档好坏的唯一标准：新人照着走能不能不问人跑通，以及机器能不能在文档说谎时失败。
