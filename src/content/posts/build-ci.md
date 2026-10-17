---
title: CI 构建与缓存
description: 实测：本项目热缓存 268MB 下 npm ci 仍要 5 分 5 秒；结合本站 Actions 工作流，讲矩阵构建、缓存命中结构、产物与测试报告的门禁设计、以及失败可复现的四条纪律。
date: 2026-10-16
tags: [编译, 构建, CI, 缓存, GitHub Actions]
category: build
section: build-ci
---

> 环境：Windows 11 x64，npm 缓存 268 MB（`npm config get cache` 实测大小），`npm ci --prefer-offline` 三次计时。本站 CI 是 GitHub Actions（`.github/workflows/deploy.yml`：ubuntu-latest、Node 22、`cache: npm`、`npm ci` → `npm run build` → 上传 dist）。**本机不是 Linux**：ccache 对 C++ 编译的加速比未实测（本文用 npm 侧的实测 + 文档级框架）；GitHub Actions 的账单/队列行为以官方文档为准。

## 一、CI 时长的账：先算再优化

本站一次 CI 的构成（按 ubuntu-latest  runners 的典型值，npm 侧有本机实测背书）：

```
checkout + setup-node + 缓存恢复     ~10–20 s（命中时）
npm ci（268MB 缓存，热）              本机实测三轮 5m05/5m04/5m00 ← 最大头
astro build                           本机实测 ~1m（dist 462 文件）
上传/部署 artifact                     ~10–30 s
```

**第一课：优化前先拆账**。没拆账就"上缓存"是常见的瞎忙——本例里缓存已配（`cache: npm`），npm ci 仍要 5 分钟，说明瓶颈不在"要不要下载"而在"解包 + 链接 + 跑 install 脚本"：node_modules 一千多个包，`npm ci` 每次全删重建。三个针对性动作（按收益）：

1. **只缓存会复用的东西**：npm 的 `~/.npm` 缓存 CI 已做；**别把 `node_modules` 本身也缓存**——看起来省了 install，实际恢复一个 500MB 的 node_modules 常常比 install 还慢，且破坏 `npm ci` 的"干净安装"语义（cache 污染会制造"本地好使 CI 挂"）。
2. **拆 job 并行**：install 和 lint/typecheck 并行、测试分片（`--shard`）——runner 分钟数是相加的，墙钟时间可以砍半。
3. **增量构建**：本站这种 Astro 全量构建 1 分钟级，没有增量空间；C++ 项目的 ccache（编译缓存）和 sccache（分布式）才是对应物——**key 设计不好时命中率上不去**（第四节）。

## 二、矩阵构建：多平台不是多份 YAML

矩阵把"同一逻辑 × 多配置"变成一张表：

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
    node: [20, 22]
```

三条纪律：

1. **排除不可能的组合**：`exclude` 掉已知失败的格子（某平台某版本不兼容），别让 CI 长期带红——**长期带红的 CI 等于没有 CI**。
2. **fail-fast: false**：一个格子失败不取消其他格子——你要的是"全平台报告"，不是"第一个错误"。
3. **平台差异进脚本不进 YAML**：`.github/workflows/build.sh` 一类脚本吸收 `uname` 分支，YAML 保持声明式。本站的 deploy.yml 只有 Linux 一个格子（GitHub Pages 的 ubuntu 镜像即可），但**本地开发是 Windows**——所以"本地能构建"不等于"CI 能构建"，本站的 CI 恰好是 Linux 构建 Windows 开发者写的内容，这类交叉要以 CI 为准绳。

## 三、门禁设计：验产物，不验步骤

本站 engineering-ci-cd 那节实测过四种"假绿"（阶段函数返回 0 让整体 rc=0、`gate | head -1` 吞掉失败、`make` 说 Nothing to be done、产物里的构建号被冻住）。CI 门禁的设计原则从那些实测里提炼：

1. **每一步的退出码必须被检查**：shell 脚本里 `set -e`（或每一步显式 `|| exit 1`）；管道场景要 `set -o pipefail`，否则只有最后一段的退出码算数。
2. **门禁验产物不验过程**："测试通过了"不如"产物里确实有测试报告且数字达标"。本站 deploy.yml 的隐含门禁是 `npm run build` 的退出码 + Astro 的 schema 校验——**构建失败即门禁失败**，这比"跑一遍 lint 但不阻断"强。
3. **上传一切**：测试报告、覆盖率、构建产物，失败时也上传（`if: always()`）——**失败现场的日志比成功日志值钱十倍**。
4. **定时任务也要门禁**：`schedule` 触发的依赖升级/安全扫描，失败要开 issue 或通知，别让"没人看的红格子"躺一周。

## 四、缓存命中结构：key 决定命运

CI 缓存（`actions/cache`、`actions/setup-node` 的 cache）的 key 设计：

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: ${{ runner.os }}-node-   # 前缀兜底：lock 没变时的部分命中
```

三个要点：

1. **key 里必须有关键输入的文件哈希**：`package-lock.json` 变了才重建缓存——用 `hashFiles` 而不是分支名/日期，**日期做 key 等于每天全量重来**。
2. **restore-keys 是部分命中**：精确 key 没中时按前缀恢复旧缓存，npm 会只补差异包——比完全冷启动快，但别指望它和全命中一样快。
3. **缓存会骗人**：命中了一个"lock 没变但内容有毒"的缓存时，表现是"某次提交后 CI 莫名失败，回滚也失败"。修法是**能随时清缓存重跑**（把缓存 key 加个版本号 `v2-`），以及"失败先清缓存再排查"进 runbook。

C++ 侧的对应物是 ccache：key 是**预处理后的源码哈希 + 编译器版本 + 关键 flag**——只换注释不该失效、换 `-O` 级别必须失效。**ccache 命中率低的头号原因是 flag 里带了绝对路径/时间戳**（`__DATE__`、构建号），修法是 `SOURCE_DATE_EPOCH`（本站 engineering-ci-cd 实测过 MinGW 忽略它、`-Wl,--no-insert-timestamp` 有效但 strip 又盖回来）。

## 五、失败可复现的四条纪律

CI 失败最贵的不是失败本身，是"本地复现不了"。四条纪律：

1. **环境进版本控制**：runner 镜像版本（`ubuntu-24.04` 而不是 `ubuntu-latest`）、Node 版本、lockfile——**`latest` 标签是未来的惊喜**。
2. **失败时把现场打出来**：`--verbose` 的 install、失败时的 `node_modules` 列表、`git diff` 状态——**"CI 上不行本地行"的差距通常在环境**，现场数据是唯一线索。
3. **本地能跑 CI 的同款命令**：本站的本地命令（`npm ci` / `npm run build`）和 CI 逐字相同——**CI 应该是"你本地命令的无头版"**，不是另一套。
4. **失败分类进看板**： flaky（重跑就好）、环境（runner 升级）、真 bug——flaky 测试要标记重试但**必须留记录**，超过 1% 重试率的测试是在训练团队忽略红色。

## 六、本站 deploy.yml 的逐行读法

```yaml
on: push: branches: [main] + workflow_dispatch   # 手动触发是救命口
permissions: contents/pages/id-token 最小化
concurrency: pages, cancel-in-progress: false    # 不取消在途部署，防半新半旧
jobs: build(ubuntu, node 22, cache npm, npm ci → build → upload dist/) → deploy(environment github-pages)
```

四个值得学的设计：`workflow_dispatch`（CI 卡了能手动重放）、最小权限、concurrency 防竞态、**build 和 deploy 分 job**（部署失败不用重构建）。可改进处（本站现状）：没有测试门禁（纯静态站无运行时测试，但至少可以加 `npm run check` 的定时任务——注意本机 astro check 极慢，20 分钟无输出，见本站 MEMORY 的教训，**别把它放进每次 push 的门禁**）、没有缓存版本化的清缓存预案。

## 七、未实测清单

- GitHub Actions 的排队/计费/大仓库 checkout 优化——未压测。
- ccache/sccache 的命中率——无 C++ CI 环境。
- Docker 层缓存的多阶段构建优化——本站不用容器。
- 自建 runner——未部署。
- npm ci 的 5 分钟在 Linux runner 上的对应值——本机是 Windows，绝对值不可比，**趋势（install 是最大头）可迁移**。
