---
title: 分支模型与历史整理：先把只读的路走稳
description: 实测一个 64 提交的回归引入点，`git bisect run` 只判定 6 个提交、9.5 秒定位——但它的前置条件比命令本身重要得多：产物入库会让整条路随机罢工。
date: 2026-10-15
tags: [工程实践, Git, 分支策略]
category: engineering
section: eng-git-advanced
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1；GCC 13.1.0 全路径 `D:/Qt/Tools/mingw1310_64/bin/g++.exe`。真实仓库 `C:\Users\wangt\data\blog` 以提交 **a3bd284** 为锚点：44 个提交、`git rev-list --merges --count a3bd284` = **0**（历史全线性）、`git tag` 数量为 **0**、`git branch -a` 只有 `main` 和 `origin/main`。所有写操作实验都在 `C:/Users/wangt/AppData/Local/Temp/agents/` 下新建的临时仓库里做，博客仓库只跑只读命令；本篇的 bisect、cherry-pick、squash、reflog、revert 五组实验都独立复跑过，引用的都是复跑那一次的原始输出。

## 一、先走稳只读的四条路

排查问题时的第一原则：**不改变仓库状态也能拿到 90% 的信息**。在本仓库真实跑一遍：

```text
$ git log -1 --format='%h %cI %s'
a3bd284 2026-10-15T18:07:36+08:00 feat(concurrency): 第三节 条件变量与等待通知

$ git blame -L 270,272 --date=iso -- src/data/categories.ts
04c0556 (wty 2026-10-15 11:11:33 +0800 270)     slug: 'engineering',
04c0556 (wty 2026-10-15 11:11:33 +0800 271)     title: '工程实践',
04c0556 (wty 2026-10-15 11:11:33 +0800 272)     en: 'Engineering',

$ git log --oneline -S"eng-git-basics" -- src/data/categories.ts
04c0556 feat: 14 个技术专栏的章节地图与占位页
```

四条命令对应四种问题："现在在哪"（`log -1`）、"这行谁写的"（`blame -L`）、"这个字符串何时出现"（`log -S`，pickaxe，本仓库一次命中，只有 04c0556 一个提交引入过 `eng-git-basics`）、"这个文件的决策怎么演变"（`log -- <file>`，`-- astro.config.mjs` 的输出就是第六节开头那三行域名提交）。再加两个：`git log --follow` 能跨过重命名（`git-daily-workflow.md` 只有 2 个提交、从未改名），`git diff -w` 能在评审时排除空白噪声——但排不掉格式化提交（「命名、格式与可读性」一节实测 28 行差异里 `-w` 只省 2 行）。

## 二、bisect：6 次判定换 9.5 秒

在临时仓库里造一个真回归：64 个提交，每次往 `calc.h` 里多累加一项，第 37 次把 `acc += 7` 写成 `acc -= 7`；判定脚本会重新编译再跑自检，返回码 0/1。

```text
$ cat run_check.sh                                # 判定的全部逻辑：重编 + 跑自检
D:/Qt/Tools/mingw1310_64/bin/g++.exe -std=c++17 -O2 check.cpp -o check.exe || exit 127
./check.exe

$ git bisect start HEAD $(git rev-list --max-parents=0 HEAD)
$ git bisect run bash run_check.sh
bisect found first 'bad' commit

$ git bisect log                                  # 完整决策序列
# bad: [0764675] step 64 [FAIL]   # good: [aa99d33] step 1 [OK]
# good: [6e62deb] step 32   → git bisect good     # bad: [7a3f422] step 48
# bad:  [19863e6] step 40          # good: [bd5432d] step 36
# bad:  [0a5f809] step 38          # bad:  [a72c669] step 37  ← 收敛点
```

三个实测数字：**只判定 6 个提交**（32/48/40/36/38/37，日志里另有起止两端），总耗时 **9.458 秒**（含 6 次编译 + 6 次 checkout），单次迭代约 1.6 秒；我复跑两次，分别是 9.4 秒和 9.6 秒，判定序列完全一致。人工从 HEAD 往回一个个试，最坏 64 次构建约 100 秒，而且得有人守着。`git bisect run` 成立的前提只有一个：**存在一个返回码可信的自动化判定**。这个判定通常不是"测试"，而是任何会退出的脚本——编译失败返回 127 也是可信判定，bisect 会跳过无法构建的提交。

### 真实事故：产物入库之后，这条路随机罢工

第一遍做这个实验时脚本里没有 `.gitignore`，`git add -A` 把 76652 字节的 `check.exe` 一起提交了，bisect 就停在这里：

```text
running 'bash' 'run_check.sh'
total=528 expect=528 OK
error: Your local changes to the following files would be overwritten by checkout:
	check.exe
Please commit your changes or stash them before you switch branches.
Aborting
error: bisect run failed: 'git bisect good' exited with error code -1
```

根因：bisect 每一步都要 checkout 不同提交，而判定脚本每一步都重新生成这个**被跟踪**的文件，工作区内容与目标提交不一致时 checkout 就拒绝覆盖。加一行 `check.exe` 进 `.gitignore` 之后，同一套脚本 9.458 秒跑完。

必须说清的是：这个坑**不是每次都疼**。我把同一个仓库的 `.gitignore` 清空、重新提交产物后再跑一遍 bisect，这一遍它跑完了没报错——因为编译器输出恰好逐字节稳定，checkout 认为文件没被改过。也就是说产物入库把"切换提交"变成了一枚取决于构建可复现性的硬币：能编出一致产物时侥幸通过，遇到时间戳、链接顺序、随机化一次就整条 bisect/worktree/老分支排查全废。**产物入库的代价不是体积，是所有需要切换提交的操作都失去保证。**

bisect 的另一个适用边界：它要求"每个提交都可构建、可判定"。历史里大量 merge、或中间有些提交根本编不过时，二分的前提就塌了，此时更省事的是 `git log -S<可疑符号>` 直接定位引入点——第一节那条 `-S"eng-git-basics"` 一次命中就是例子。

## 三、cherry-pick：跳过的提交会以冲突的形式回来

临时仓库 `main` 上是 `init: 基线 → feat: 功能 A → wip: 临时调试打印 → feat: 功能 B`，现在从 `功能 A` 之后拉出 `release` 分支，只要 A 和 B，不要那条 DEBUG。

```text
$ git cherry-pick 66250f6      # 功能 A
[release 607b83e] feat: 功能 A
 1 file changed, 1 insertion(+)

$ git cherry-pick 5b544a3      # 功能 B：它的父提交是被跳过的 wip
$ cat app.txt
base
feature-A
<<<<<<< HEAD
=======
DEBUG print
feature-B
>>>>>>> 5b544a3 (feat: 功能 B)
```

`git status -sb` 此时是 `## release` + `UU app.txt`。

**被跳过的那个提交的那一行 `DEBUG print`，作为上下文出现在冲突块里**。cherry-pick 不是"把改动搬过来"，是"把那次 3-way 合并重放一遍"，而合并需要父提交的上下文；跳过中间提交时上下文永远对不上，冲突位置还常常落在无关行上。实操结论：

| 需求 | 更稳的做法 |
| --- | --- |
| 只要某几个提交，且它们相互独立 | 直接 `cherry-pick`，一次一个 |
| 想要的提交依赖被跳过的提交 | 连父提交一起挑，或改用它所在分支的 merge |
| 只要某几行/某个文件的某个状态 | `git checkout <commit> -- <path>`，别硬用 cherry-pick |
| 挑完还要去掉某行（比如那条 DEBUG） | 挑完之后**再补一个提交**删掉，不要 amend 已共享的东西 |

冲突处理三兄弟的语义要背下来，我实测过 `--abort`：执行后 `git log --oneline` 回到 `607b83e feat: 功能 A / 9bb889e init: 基线`，`git status --porcelain` 输出 0 行——`--skip` 是放弃当前这个继续后面的、`--abort` 是整条序列回到开始之前、`--quit` 停在当前状态但不结束序列（留给手工修）。

## 四、整理历史：rebase 的边界与不用 `-i` 的 squash

规则只有一条：**只 rebase 自己的、还没共享的提交**。共享的判断标准不是"我推了没推"，而是"别人有没有基于它工作"。本仓库 `git branch -a` 只有 `main` 和 `origin/main`，44 个提交里 0 个 merge，rebase 风险面接近 0；多人项目里要提前定：功能分支随便 rebase，主干永远 merge。

如果目标是"把 3 个碎提交压成 1 个"，在无法交互（`-i` 需要编辑器）的环境里，`reset --soft` 是等价且可脚本化的做法，实测：

```text
$ git log --oneline | head -4        # squash 前
3a0ae66 fix: typo 3   69193d1 fix: typo 2   aaac484 fix: typo 1   a372156 feat: 功能 B

$ git reset --soft HEAD~3 && git commit -qm "feat: 三处拼写修正合并成一个"

$ git log --oneline | head -2        # squash 之后
fe10204 feat: 三处拼写修正合并成一个
a372156 feat: 功能 B
```

三个提交的改动留在暂存区，历史变成一条。代价是**这 3 个提交对象被丢弃**——这正是下一节 reflog 存在的意义。

## 五、reflog：唯一能救"被丢弃的提交"的东西

squash 之后立刻查 reflog（真实输出）：

```text
$ git reflog
fe10204 HEAD@{0}: commit: feat: 三处拼写修正合并成一个
a372156 HEAD@{1}: reset: moving to HEAD~3
3a0ae66 HEAD@{2}: commit: fix: typo 3
69193d1 HEAD@{3}: commit: fix: typo 2
aaac484 HEAD@{4}: commit: fix: typo 1

$ git show --stat --oneline HEAD@{2}
3a0ae66 fix: typo 3
 app.txt | 1 +      1 file changed, 1 insertion(+)
```

"被丢弃"的三个提交还在，而且能直接查、直接 `git cherry-pick` 回来。三条纪律：任何后悔操作先 `git reflog` 而不是先 `git status`（rebase/reset/commit 都在里面，默认保留 90 天）；reflog 是本地的，不推送不共享，所以别人误操作只能靠 `git revert` 救；别用 `HEAD@{5}` 这类相对位置做长期决定（它会随后续操作漂移），要么记下完整 SHA，要么立刻 `git branch rescue <sha>` 固化。

## 六、提交信息规范：44 条的实测分布

以 a3bd284 为界：

```text
feat 37   chore 3   docs 2   fix 1   init 1        ← 合计 44
```

`init:` 不在 Conventional Commits 的词表里——这是唯一一条违规，而且它是最早的那个提交（`df25077 init: Astro 内容集合博客 + GitHub Pages 部署流水线`），改它需要重写全部历史，所以它会在仓库里躺一辈子。教训不是"以后别写 init"，而是**规范要在第一个提交之前就定好**，因为历史无法廉价地修正。

规范本身该机械化检查，一行命令就能当门禁：

```text
git log --format='%s' | grep -vE '^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\(.+\))?: .+'
```

本仓库跑这条命令的输出只有 `init: ...` 那一行。标题格式的价值不在好看，在于**让历史可被检索**：`git log --grep='concurrency'`、按前缀生成变更日志、给 bisect 提供"哪些提交值得怀疑"的先验。正文里要写的是"为什么"和"怎么验证的"，本仓库最好的样本还是那三行域名提交：`843d484 切到 wty-blog.abrdns.com` → `640d6d3 域名定为 wty.blogs.abrdns.com（DNS CNAME 已验证生效）`——第二个提交明确否证了第一个，括号里那句"已验证生效"是决策记录里最值钱的部分。

## 七、多人协作的分支策略：能简则简

| 策略 | 适用 | 代价 |
| --- | --- | --- |
| 主干开发（trunk-based） | 单人/小团队 + 有 CI 门禁 + 提交足够小 | 需要提交真的能拆小，否则主干常红 |
| Git Flow | 需要同时维护多个发布线（如桌面软件） | 分支数与合并冲突成本，本仓库这种规模是纯负担 |
| GitHub Flow（PR + 短寿分支） | 需要评审作为门禁 | 依赖平台；小改动会有等待成本 |

本仓库的事实是：44 个提交、0 个 merge、0 个 tag、0 个长期分支，全在 `main` 上线性推进；README 里那句"日常只需要"下面跟的就是 `git add .` / `git commit` / `git push`。**这不是偷懒，是正确选择**——它的发布是"推 main 即部署，33 秒可确认，回滚就是再推一次"，没有需要并行维护的多条发布线。

需要升级分支策略的信号也很具体，出现任意一条就该上 PR/分支：第二个人开始提交；出现需要"合之前先跑完检查"的门禁；hotfix 与 feature 同时要进主干；同一个功能跨天开发且中途状态不能上线。

## 八、撤销的安全边界：revert 是唯一可共享的手段

同一批实验里对比两种撤销（临时仓库，紧接第四节的 squash 之后）：

```text
$ git revert --no-edit HEAD
[main 1ddd2ea] Revert "feat: 三处拼写修正合并成一个"
 1 file changed, 3 deletions(-)

$ git log --oneline | head -3
1ddd2ea Revert "feat: 三处拼写修正合并成一个"   fe10204 feat: 三处拼写修正合并成一个   a372156 feat: 功能 B
```

`git reset --hard` 把历史抹掉，本地靠 reflog 还能捞；`git revert` **新增**一个反向提交，历史线性增长，因此可以推送、可以共享、可以在别人已经拉走的情况下使用。判断标准就一句：**改动已经离开你了吗？** 离开了只能用 revert（或补一个新提交），没离开才允许 amend/reset。

`revert` 的隐藏成本也要知道：被 revert 掉的那个提交**仍然在历史里**，将来想重做这个功能时不能直接合那条旧提交（Git 认为它已经合并过），要么 `git revert <revert-commit>`，要么重做。这是很多团队"同一个 bug 修了两次还复现"的根源。

## 九、小结

- 只读四件套（`log -1` / `blame -L` / `log -S` / `log -- <file>`）能回答绝大多数"这行谁写的、什么时候进来的"，本仓库全部实测命中，且不需要动仓库状态。
- **bisect 实测：64 个提交、判定 6 个、9.458 秒**，两次复跑判定序列一致；前提是判定脚本返回码可信，而且**产物必须在 `.gitignore` 里**——这个坑取决于构建是否逐字节可复现，所以它是随机发作的。
- cherry-pick 是重放合并：**跳过中间提交的代价会在冲突标记里现形**（`DEBUG print` 就躺在 `<<<<<<<` 与 `>>>>>>>` 中间）。
- squash 用 `reset --soft` 可以完全脚本化；被丢弃的提交用 **reflog** 原样查得到（`HEAD@{2}` 那次 `git show --stat` 直接返回 `1 file changed, 1 insertion(+)`）。
- 提交规范要机械化检查：44 条里只有 1 条 `init:` 违规，而它改不掉——规范要在第一个提交之前定；分支策略按信号升级，本仓库 0 merge、0 tag、33 秒部署，trunk-based 是当前规模的正解。
- 已共享的改动只能 `git revert`（实测 `1 file changed, 3 deletions(-)`）；revert 过的提交将来重做还得再 revert 一次。
