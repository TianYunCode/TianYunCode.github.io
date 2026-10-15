---
title: 分支模型与历史整理：先把只读的路走稳
description: 实测：64 个提交的回归引入点，`git bisect run` 只测 6 个提交、9.6 秒定位；因为把 check.exe 提交进了仓库，同一次 bisect 直接罢工；跳过中间提交的 cherry-pick 会在冲突标记里看见被跳过那行的影子；`reset --soft` 抹掉的 3 个提交靠 reflog 原样捞回。
date: 2026-10-18
tags: [工程实践, Git, 分支策略]
category: engineering
section: eng-git-advanced
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1（`git version 2.56.0.windows.1`）；GCC 13.1.0 全路径 `D:/Qt/Tools/mingw1310_64/bin/g++.exe`；真实仓库 `C:\Users\wangt\data\blog`（取证时 44 个提交、单分支 `main` + `origin/main`、**0 个 tag**）；所有需要写操作的实验都在 `C:/Users/wangt/AppData/Local/Temp/agents/engineering/` 下新建的临时仓库里做，博客仓库只跑只读命令。

## 一、先走稳只读的四条路

排查问题时的第一原则：**不改变仓库状态也能拿到 90% 的信息**。在本仓库真实跑一遍：

```text
$ git log -1 --format='%h %cI %s'
a3bd284 2026-10-15T18:07:36+08:00 feat(concurrency): 第三节 条件变量与等待通知

$ git blame -L 270,276 -- src/data/categories.ts
04c0556 (wty 2026-10-15 11:11:33 +0800 270)     slug: 'engineering',
04c0556 (wty 2026-10-15 11:11:33 +0800 271)     title: '工程实践',
...
04c0556 (wty 2026-10-15 11:11:33 +0800 276)       { id: 'eng-style', title: '命名、格式与可读性', ...

$ git log --oneline -S"eng-git-basics" -- src/data/categories.ts
04c0556 feat: 14 个技术专栏的章节地图与占位页

$ git log --format='%h %ad %s' --date=short -- astro.config.mjs
640d6d3 2026-10-15 chore: 域名定为 wty.blogs.abrdns.com（DNS CNAME 已验证生效）
843d484 2026-10-15 chore: 站点域名切到 wty-blog.abrdns.com
affe43a 2026-10-15 chore: 站点地址定为 tianyuncode.github.io 根站
df25077 2026-10-15 init: Astro 内容集合博客 + GitHub Pages 部署流水线
```

四条命令对应四种问题："现在在哪"（`log -1`）、"这行谁写的"（`blame -L`）、"这个字符串何时出现"（`log -S`，pickaxe）、"这个文件的决策怎么演变"（`log -- <file>`）。再加两个：`git log --follow` 能跨过重命名（本仓库 `git-daily-workflow.md` 只有 2 个提交，从未改名），`git diff -w` 能在评审时排除空白噪声——但排不掉格式化提交（上一篇实测 28 行差异里 `-w` 只省 2 行）。

## 二、bisect：6 次判定换 9.6 秒

在临时仓库里造一个真回归：64 个提交，每次往 `calc.h` 里加一项累加，第 37 次把 `acc += 7` 写成 `acc -= 7`；测试脚本 `run_check.sh` 会重新编译并跑自检，返回码 0/1。

```text
$ git bisect start HEAD <root>
Bisecting: 31 revisions left to test after this (roughly 5 steps)
$ git bisect run bash run_check.sh
...
bisect found first 'bad' commit
```

`git bisect log` 的完整决策序列（真实输出）：

```text
# bad: [16b75ac...] step 64: 累加到第 64 项 [FAIL]
# good: [847b6b6...] step 1: 累加到第 1 项 [OK]
# good: [76a4d3d...] step 32  → git bisect good 76a4d3d
# bad:  [fd658f6...] step 48  → git bisect bad fd658f6
# bad:  [8fe0739...] step 40  → git bisect bad 8fe0739
# good: [fb69aaa...] step 36  → git bisect good fb69aaa
# bad:  [ef2cc0d...] step 38  → git bisect bad ef2cc0d
# bad:  [388228b...] step 37  → git bisect bad 388228b
# first 'bad' commit: [388228b] step 37
```

三个实测数字：**只测了 6 个提交**（32/48/40/36/38/37），总耗时 **9.6 秒**（含 6 次编译 + 6 次 checkout），单次迭代约 1.6 秒。如果人工从 HEAD 往回一个个试，最坏 64 次构建 ≈ 100 秒，还得有人守着。

`git bisect run` 成立的前提只有一个：**存在一个返回码可信的自动化判定**。这个判定通常不是"测试"，而是任何会退出的脚本——编译失败返回 127 也算可信判定（bisect 会跳过无法构建的提交）。

### 真实事故：bisect 半路罢工，原因是仓库里有产物

第一次跑这个实验时它是这样失败的：

```text
running 'bash' 'run_check.sh'
total=528 expect=528 OK
error: Your local changes to the following files would be overwritten by checkout:
	check.exe
Please commit your changes or stash them before you switch branches.
Aborting
error: bisect run failed: 'git bisect good' exited with error code -1
```

根因：我把 `check.exe`（76652 字节的二进制）`git add -A` 进了仓库。bisect 每步要 checkout 不同提交，而脚本又会重新生成这个被跟踪的文件，于是 checkout 拒绝覆盖工作区。**加一行 `check.exe` 进 `.gitignore` 之后同一套脚本 9.6 秒跑完。** 产物进仓库的代价不只是体积，是**所有需要切换提交的操作**（bisect、worktree、老分支排查）都会变得危险。

bisect 的适用边界也要说清：它要求"每个提交都可构建可判定"。如果历史里有大量 merge，或中间有些提交根本编不过，二分的前提就塌了，此时更省事的是 `git log -S<可疑符号>` 直接定位引入点——本仓库那条 `-S"eng-git-basics"` 就是一次命中的例子。

## 三、cherry-pick：跳过的提交会以冲突的形式回来

临时仓库：`feature` 分支上是 `功能A → wip: 临时调试打印 → 功能B` 三个提交，现在只想要 A 和 B。

```text
$ git cherry-pick ef06691      # 功能 A
 1 file changed, 1 insertion(+)
$ git cherry-pick 98145b9      # 功能 B（它的父提交是那条 wip）
hint: You can instead skip this commit with "git cherry-pick --skip".
hint: run "git cherry-pick --abort".
```

冲突标记里的内容是真实输出：

```text
<<<<<<< HEAD
=======
DEBUG print
feature-B
>>>>>>> 98145b9 (feat: 功能 B)
```

**被跳过的那个提交的那一行 `DEBUG print`，作为上下文出现在冲突块里**。cherry-pick 不是"把改动搬过来"，是"把那次 3-way 合并重放一遍"，而合并需要父提交的上下文。跳过中间提交时，这个上下文永远对不上，冲突位置还常常落在无关行上。

实操结论：

| 需求 | 更稳的做法 |
| --- | --- |
| 只要某几个提交，且它们相互独立 | 直接 `cherry-pick`，一次一个 |
| 想要的提交依赖被跳过的提交 | 连父提交一起挑，或改用它所在分支的 merge |
| 只要某几行/某个文件的某个状态 | `git checkout <commit> -- <path>`，别硬用 cherry-pick |
| 挑完还要去掉某行（比如那条 DEBUG） | 挑完之后**再补一个提交**删掉，不要 amend 已共享的东西 |

冲突处理三兄弟的语义要背下来：`--skip` 放弃当前这个继续后面的、`--abort` 回到 cherry-pick 之前的状态、`--quit` 停在当前状态但不结束序列（留给手工修）。

## 四、整理历史：rebase 的边界与不用 `-i` 的 squash

规则只有一条：**只 rebase 自己的、还没共享的提交**。共享的判断标准不是"我推了没推"，而是"别人有没有基于它工作"。本仓库 `git branch -a` 只有 `main` 和 `origin/main`，历史线性，rebase 风险面接近 0；多人项目里要提前定：功能分支随便 rebase，主干永远 merge。

如果目标是"把 3 个碎提交压成 1 个"，在无法交互（`-i` 需要编辑器）的环境里，`reset --soft` 是等价且可脚本化的做法，实测：

```text
== rebase 前：4 个提交 ==
28ab8ee fix: 第三处 typo
cb381e5 fix: 又一处 typo
23fef38 fix: typo
2c28372 feat: 初版
== squash 之后 ==
150d6c9 feat: 三处拼写修正合并成一个
2c28372 feat: 初版
```

`git reset --soft HEAD~3` 之后一次 `git commit`，三个提交的改动留在暂存区，历史变成一条。代价是**这 3 个提交对象被丢弃**——这正是下一节 reflog 存在的意义。

## 五、reflog：唯一能救"被丢弃的提交"的东西

squash 之后立刻查 reflog（真实输出）：

```text
150d6c9 HEAD@{0}: commit: feat: 三处拼写修正合并成一个
2c28372 HEAD@{1}: reset: moving to 2c28372a...
28ab8ee HEAD@{2}: commit: fix: 第三处 typo
cb381e5 HEAD@{3}: commit: fix: 又一处 typo
23fef38 HEAD@{4}: commit: fix: typo
```

"被丢弃"的三个提交还在，而且能直接查：

```text
$ git show --stat --oneline 23fef38
23fef38 fix: typo
 app.txt | 1 +
 1 file changed, 1 insertion(+)
```

三条纪律：任何后悔操作先 `git reflog` 而不是先 `git status`（rebase/reset/commit 都在里面，默认保留 90 天）；reflog 是本地的，不推送不共享，所以别人误操作只能靠 `git revert` 救；别用 `HEAD@{5}` 这类相对位置做决定（它会随后续操作漂移），要么记下完整 SHA，要么立刻 `git branch rescue <sha>` 固化。

## 六、提交信息规范：44 条的实测分布

```text
feat 36   chore 3   docs 2   fix 1   init 1
```

`init:` 不在 Conventional Commits 的词表里——这是唯一一条违规，而且它是最早的那个提交（`df25077 init: Astro 内容集合博客 + GitHub Pages 部署流水线`），改它需要重写全部历史，所以它会在仓库里躺一辈子。教训不是"以后别写 init"，而是**规范要在第一个提交之前就定好**，因为历史无法廉价地修正。

规范本身该机械化检查，一行命令就能当门禁：

```text
git log --format='%s' | grep -vE '^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\(.+\))?: .+'
```

本仓库跑这条命令的输出只有 `init: ...` 那一行。标题格式的价值不在好看，在于**让历史可被检索**：`git log --grep='concurrency'`、按前缀生成变更日志、给 bisect 提供"哪些提交值得怀疑"的先验。

正文里要写的是"为什么"和"怎么验证的"，本仓库最好的样本还是那三行域名提交：`843d484 切到 wty-blog.abrdns.com` → `640d6d3 域名定为 wty.blogs.abrdns.com（DNS CNAME 已验证生效）`——第二个提交明确否证了第一个，括号里那句"已验证生效"是决策记录里最值钱的部分。

## 七、多人协作的分支策略：能简则简

| 策略 | 适用 | 代价 |
| --- | --- | --- |
| 主干开发（trunk-based） | 单人/小团队 + 有 CI 门禁 + 提交足够小 | 需要提交真的能拆小，否则主干常红 |
| Git Flow | 需要同时维护多个发布线（如桌面软件） | 分支数与合并冲突成本，本仓库这种规模是纯负担 |
| GitHub Flow（PR + 短寿分支） | 需要评审作为门禁 | 依赖平台；小改动会有等待成本 |

本仓库的事实是：44 个提交全在 `main` 上线性推进、0 个 tag、0 个长期分支、README 里那句"日常只需要 git add / git commit / git push"。**这不是偷懒，是正确选择**——因为它的发布是"推 main 即部署，33 秒可回滚"，没有需要并行维护的多条发布线。

需要升级分支策略的信号也很具体，出现任意一条就该上 PR/分支：第二个人开始提交；出现需要"合之前先跑完检查"的门禁；开始有 hotfix 与 feature 同时需要进主干；同一个功能要跨天开发且中途状态不能上线。

## 八、撤销的安全边界：revert 是唯一可共享的手段

同一批实验里对比两种撤销（临时仓库）：

```text
$ git revert --no-edit HEAD
[main fc17604] Revert "feat: 三处拼写修正合并成一个"
 1 file changed, 3 deletions(-)

fc17604 Revert "feat: 三处拼写合并成一个"
150d6c9 feat: 三处拼写合并成一个
2c28372 feat: 初版
```

`git reset --hard` 把历史抹掉，本地靠 reflog 还能捞；`git revert` **新增**一个反向提交，历史线性增长，因此可以推送、可以共享、可以在别人已经拉走的情况下使用。判断标准就一句：**改动已经离开你了吗？** 离开了只能用 revert（或补一个新提交），没离开才允许 amend/reset。

`revert` 的隐藏成本也要知道：被 revert 掉的那个提交**仍然在历史里**，将来想重做这个功能时不能直接合那条旧提交（Git 认为它已经合并过），要么 `git revert <revert-commit>`，要么重做。这是很多团队"同一个 bug 修了两次还复现"的根源。

## 九、小结

- 只读四件套（`log -1` / `blame -L` / `log -S` / `log -- <file>`）能回答绝大多数"这行谁写的、什么时候进来的"，本仓库全部实测命中。
- **bisect 实测：64 个提交、测 6 个、9.6 秒**；前提是有一个返回码可信的判定脚本，而且**构建产物必须在 `.gitignore` 里**——我第一遍就是这么失败的。
- cherry-pick 是重放合并，**跳过中间提交的代价会在冲突标记里现形**（`DEBUG print` 出现在冲突块里）。
- squash 用 `reset --soft` 可以完全脚本化；丢掉的提交用 **reflog** 能原样查出（`HEAD@{2..4}` 三个都在）。
- 提交规范要机械化检查：44 条里只有 1 条 `init:` 违规，而它改不掉——规范要在第一个提交前定。
- 分支策略按信号升级，本仓库单 `main`、0 tag、33 秒部署，trunk-based 是当前规模的正解。
- 已共享的改动只能 `git revert`（实测 `1 file changed, 3 deletions(-)`，历史线性）；revert 过的提交将来重做要再 revert 一次。
