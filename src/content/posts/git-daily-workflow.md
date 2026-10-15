---
title: 我每天真的只用这几条 Git 命令
description: 抛开那些面试才用的招数，日常工作里 90% 的操作就五条命令，外加两个必须记住的救命招。
date: 2026-09-26
tags: [Git, 工程实践]
category: engineering
section: eng-git-basics
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1；`D:/Qt/Tools/mingw1310_64/bin/g++.exe`。真实仓库 `C:\Users\wangt\data\blog` 以提交 **2ef0bdd** 为锚点：58 个提交 / 102 个跟踪文件 / 65 篇文章 / `git rev-list --merges --count 2ef0bdd` = **0** / `git tag` = **0** / `git shortlog -sn HEAD` 只有 wty 一人 58。本篇所有写操作（commit / restore / reset / add -p / pull --rebase / fsck）都在 `C:/Users/wangt/AppData/Local/Temp/agents/engineering4/` 下新建的临时仓库里跑，博客仓库只执行只读命令；下面每段 ```text 都是那一次运行的原始输出。

工作里见过的 Git 教程，一半在讲怎么用 `git bisect` 定位引入 bug 的提交，另一半在讲 worktree。这些确实有用，但一天下来我真正敲的命令非常少。

## 一、每天用十几次的五条

```bash
git status                    # 任何时候不确定状态，先看这个
git add -p                    # 逐块暂存，比 git add . 靠谱
git commit -m "..."           # 只写「为什么」，不写「改了什么」
git pull --rebase             # 拉同事的提交，不产生 merge 节点
git push
```

`git add -p` 值得单独说一句。它会把改动切成块，逐块问你 `y/n`，于是你可以把「顺手改的格式化」和「真正的功能修改」拆成两个提交。审查别人代码时，这两种改动混在一起是最烦人的。它的真实能力边界在第三节，那里有它翻车的实测。

## 二、三区模型：status 的每一行都能对上一次状态转换

「工作区 → 索引 → 仓库」不是比喻，是三份可以互不相同的内容。造一个三者都不同的状态（库内 `two`、索引 `three`、工作树 `four`），短码把偏差的种类分得很干净：

| 短码 | 实测出处 | 含义 | 用它判断什么 |
| --- | --- | --- | --- |
| ` M` | ` M app.txt` | 工作树 ≠ 索引，索引 == HEAD | `commit -a` 会带走它 |
| `M ` | `M  f.txt`（`git restore` 之后） | 已 stage 未提交 | `git stash` 会一起卷走 |
| `MM` | `MM calc.c` | 索引和工作树改的不是同一份内容 | `commit -a` 之后还会剩脏 |
| `??` | `?? log.tmp` | 从没进过索引 | 新文件忘 add 就在这里看 |
| `UU` | `UU notes.txt` | 冲突未解决 | 此时别 `-a`，先解冲突 |

五条命令的成本（本机 5 次运行的中位数与区间）：`git status --porcelain` **94.9 ms**（94.3–136.6）、`git status --untracked-files=no` 82.3 ms（74.3–91.7）、`git log -1 --format=%h` 58.8 ms（55.2–69.8）、`git rev-parse HEAD` 57.9 ms（53.1–60.1）。

**Windows 上任何一条 git 命令的地板价约 55–58ms，那是进程启动，不是 git 干的活**；`status` 在 102 个跟踪文件的真实仓库上只比地板贵约 37ms。真正让它贵的是未跟踪文件的枚举：

```text
3000 个未跟踪文件，整个 build/ 目录无一被跟踪
  git status --porcelain  → ?? build/  1 行  78.2 ms（-uall 展开成 3000 行：78.6 ms）
20000 个未跟踪文件 + 一个被跟踪的 dist/.gitkeep → 20000 行  197.2 ms（139.3–307.8）
  .gitignore 加一行 dist/                        → 1 行      88.3 ms（80.4–96.2）
```

目录**整体**未跟踪时 git 不进去（折叠，省事）；可只要目录里躺着一个被跟踪的文件——真实的 `dist/` 里一个 `.gitkeep` 就够了——折叠失效，两万行全部展开。**一行 `.gitignore` 把 status 从 197ms 降到 88ms、从 20000 行降到 1 行**，这才是"status 慢"的真实来源。

## 三、`git add -p`：切块靠 `s`，但拆开的提交可能编不过

临时仓库一个 11 行的 `calc.c`，一次改了三件事：两个函数的花括号风格（纯格式化）、新增 `sub()`、`main()` 改调用 `sub()`。`git diff --stat` 是 `11 insertions(+), 5 deletions(-)`，而 `git diff | grep -c '^@@'` 在默认 `-U3` 下只有 **1**，`git diff -U0` 是 **3**。

**格式化把本来隔开的改动粘成了一个 hunk**（两处改动之间不足 6 行未改内容就会被合并）。这时"逐块问你 y/n"只有一块可问，得按 `s`：`(1/1) Stage this hunk [y,n,q,a,d,s,e,p,P,?]? Split into 3 hunks.`，块数正好等于 `-U0` 的结果。但第二块里 `mul()` 的格式化（前 3 行）和 `sub()` 的新增（后 4 行）是**相邻行**，中间没有未改行，`s` 切不开：

```text
@@ -3,7 +4,12 @@
-int mul(int a, int b) {
-    return a * b;
+int mul(int a, int b)
+{
+  return a * b;
+}
+
+int sub(int a, int b) {
+    return a - b;
 }
```

**先证明硬拆会翻车**：只 stage 第三块（`main()` 那行）并提交，再把该提交的文件取出来编译，`only_main/calc.c:10:12: error: 'sub' was not declared in this scope`。hunk 的边界是**文本相邻性，不是语义**，按 hunk 拆出的第一个提交引用了还没引入的函数，它编不过——`git bisect` 走到这种提交只能跳过（「分支模型与历史整理」里"每个提交都可构建"那条前提，就是在这里被破坏的）。

**正确的拆法是 `e`**：git 把这块写进临时文件交给 `$EDITOR`，底部就是操作说明 `To remove '-' lines, make them ' ' lines (context). To remove '+' lines, delete them.`。照它做——`mul` 的两行删除降回上下文、删掉 `mul` 的三行新增、保留 `sub` 的四行新增（原块里那个上下文 `}` 顺势成为 `sub` 的收尾），git 自己重算了块头：

```text
$ git diff --cached
@@ -6,6 +6,10 @@ int mul(int a, int b) {
     return a * b;
 }

+int sub(int a, int b) {
+    return a - b;
+}
+
 int main(void) {
     return add(2, 3);
 }
```

我第一版自己重排了整段（顺手删掉 `#` 注释行、收尾上下文也不够），被直接退回 `error: corrupt patch at <stdin>:23`——**按指引原地改、别动块的结构，才是稳的**。之后把 `main()` 那块 stage 上、`git commit --amend --no-edit` 并进同一个提交，剩下的纯格式化单独一笔：

```text
$ git log --oneline
573ff82 style: 统一大括号与缩进         → g++ 编译 OK
ac8b539 feat: 新增 sub 并在 main 里用    → g++ 编译 OK
dcaecf3 init: calc.c                    → g++ 编译 OK
```

拆提交的判据只有一条：**每个提交都能独立构建**；做不到就把两块并成一笔，比制造一个坏提交便宜得多。实测用过的按键只有 `y n q s e k j`（`k`/`j` 是拆块之后才出现在提示里的）；`a d p P g /` 我没验证过，别当结论用。

## 四、`git commit --amend`：只能碰最后一笔

**改完 commit message 但还没推送：**

```bash
git commit --amend
```

上一节我用它把 `main()` 那行补进 feat 提交，`1f1b40d` 变成 `ac8b539`——**这不是"修改"提交，是新建一个替换它**：父提交、时间、SHA 全变，`git reflog` 里两条都在。所以动手前先 `git log -1 --format='%h %s'` 确认 HEAD 就是你要改的那笔。

**已经推送了才发现提交信息写错**——不要 amend 之后 force push 共享分支，直接补一个新提交，或者用 `git revert`。

## 五、拉取与冲突：rebase 之后 ours/theirs 是反的

`git pull --rebase` 走完，本地那个提交被重放到远端提交之上，历史是直的（`git log --oneline --graph` 三行全在一列，`git status -sb` = `## main...origin/main [ahead 1]`）。冲突发生在重放"我的"提交时，`git status` 长格式会把话说全：`interactive rebase in progress; onto 3c60a26` / `You are currently rebasing branch 'main' on '3c60a26'` / `both modified: notes.txt`，而 `git status -sb` 此刻是 `## HEAD (no branch)` + `UU notes.txt`。文件里的标记是：

```text
<<<<<<< HEAD
theirs line A          ← 同事（上游）的内容
shared line 2
=======
mine line 1            ← 这才是你的
mine line 2
>>>>>>> f1caf26 (local: 我改了 1-2 行)
```

**`HEAD` 那一侧是上游**，因为 rebase 是"先站到上游再重放你的提交"。实测挑边结果：`git checkout --ours -- notes.txt` 给出 `theirs line A / shared line 2 / shared line 3`（同事的），`git checkout --theirs` 给出 `mine line 1 / mine line 2 / shared line 3`（你的）。merge 时 `--ours` 是自己，rebase 时 `--ours` 是上游——这是最容易反向的一步。想少踩就换带基线的样式：`git checkout --conflict=zdiff3 -- notes.txt` 之后多出 `||||||| base` 段，里面写着共同祖先的 `shared line 1`，**没有 base 就无法判断某行到底是谁改的**；建议 `git config --global merge.conflictstyle zdiff3` 设成默认。解完 `git add` + `git rebase --continue` 实测输出 `Successfully rebased and updated refs/heads/main.`；反悔则 `git rebase --abort`，实测回到 pull 之前：HEAD 从 detached 变回 `a463b01`，`git status --porcelain` 只剩一个未跟踪文件，工作树逐字恢复。

两种"没干净"区别很大（同一仓库实测）：

| 当时的 `git status --porcelain` | `git pull --rebase` 实测行为 |
| --- | --- |
| `?? temp.txt`（只有未跟踪文件） | 照常开始重放，然后撞上冲突 |
| ` M notes.txt`（已跟踪文件有未暂存改动） | `error: cannot pull with rebase: You have unstaged changes.` / `error: Please commit or stash them.`，之后 HEAD 和内容都没动 |

未跟踪文件不挡 rebase，已跟踪文件的未暂存改动会挡住整个 pull（而且什么都没发生，这是好事）。顺带一个反直觉的配置事实：这台机器 `pull.rebase` = **false**，`git config --show-origin` 显示它来自系统级 `file:D:/Git/etc/gitconfig`（安装器写的），用户层和仓库层都没覆盖——裸 `git pull` 在这台机器上是 merge 语义，线性历史必须显式写 `--rebase` 换。

## 六、rebase 还是 merge

| 场景 | 选择 | 原因 |
| --- | --- | --- |
| 本地分支同步主干最新提交 | `rebase` | 历史是一条直线，好读 |
| 功能分支合入主干 | `merge --no-ff` | 保留「这个功能是一组提交」的信息 |
| 已经推到远端且别人在用 | `merge` | rebase 会重写别人已经在用的提交 |

一句话规则：**只 rebase 你自己的、还没共享的提交。**

## 七、撤销的安全边界：三区各有一条命令，越界就丢东西

状态分三区，撤销也分三层。同一个初始状态（HEAD=`two`、索引=`three`、工作树=`four`）分别跑五条命令，实测每层动了什么：

```text
命令                                          HEAD   索引    工作树   之后 status
git restore -- f.txt                          two    three   three    M  f.txt
git restore --staged -- f.txt                 two    two     four      M f.txt
git restore --source=HEAD --staged --worktree two    two     two       (空)
git reset -- f.txt                            two    two     four      M f.txt
git reset --hard HEAD                         two    two     two       (空)
```

退工作树用 `git restore <file>`，它从**索引**取内容，所以 stage 过的东西不会被它带走；退索引用 `git restore --staged`，等价于 `git reset -- <file>`（后者多打一行 `Unstaged changes after reset`），两者都不碰工作树——上表里工作树一直是 `four`。只有 `git reset` 才动 HEAD，`--hard` 是唯一会销毁内容的。能不能救回来取决于内容当时在哪一层：`git reset --hard HEAD` 之后 `git status --porcelain` 是 0 行，但 `git fsck --lost-found` 报出 `dangling blob 2bdf67ab…`，`git cat-file -p 2bdf67ab` 原样打印出 `three`；而只在磁盘上存在过的 `four` **没有任何对象**，永久丢失。此时 `git reflog` 全是同一个 `0784fa4: reset: moving to HEAD`——**reflog 只记 HEAD 移动，救不了未提交的改动**。所以 `--hard` 之前先 `git stash` 或往临时分支上随便 commit 一笔。

## 八、排查思路："我的改动没生效"

「我的改动没生效」通常是这三种情况之一：分支不对、没重新构建、缓存没清。所以顺序应该是：

1. `git log --oneline -5` 确认 HEAD 在预期的提交上
2. `git status` 确认工作区干净
3. 再去看构建和部署日志

要补第四种：**工作树的字节和库里的字节不一致，而 status 显示干净**。本仓库实测（锚点 2ef0bdd，102 个跟踪文件）：

```text
$ git ls-files --eol | awk '{print $1" "$2}' | sort | uniq -c
     98 i/lf w/lf
      3 i/lf w/crlf
      1 i/-text w/-text
$ git show HEAD:src/content.config.ts > /tmp/b.txt && cmp /tmp/b.txt src/content.config.ts
Files /tmp/b.txt and src/content.config.ts differ     # 工作树 2177 / 库内 2126 字节
```

102 个跟踪文件里 3 个 `i/lf w/crlf`：`src/content.config.ts` 加两篇文章；`i/-text` 那个是 `public/og.png`（二进制，正常）。这 3 个文件的 `git status --porcelain -- <路径>` 都是 **0 行**（"干净"），但字节不同。`content.config.ts` 差 51 字节恰好等于它的行数 51（每个 LF 多一个 CR）；`engineering-unit-test-and-mock.md` 同理，13781 vs 13583，差 198 = 行数。反过来的情形也真实存在——把工作树文件改成纯 CRLF：

```text
$ git status --porcelain
 M e.txt                          ← 报脏
$ git diff --stat                 ← 空输出
$ git add e.txt                   ← LF will be replaced by CRLF the next time Git touches it
$ git status --porcelain          ← 空：暂存之后"改动"蒸发
```

**status 说改了、diff 说没改、add 完消失**，就是行尾在作怪，不是你记错了。根因：`core.autocrlf=true` 同样来自 `D:/Git/etc/gitconfig`（用户层和仓库层都没设），而本仓库**没有 `.gitattributes`**。所以在第 2、3 步之间插两条只读命令：`git ls-files --eol | grep -v 'i/lf *w/lf' | grep -v -- '-text'`（谁的工作树和库里不一致）和 `git config --show-origin --get core.autocrlf`（归一化规则来自哪一层）。

> 出问题时先确认「现在到底在哪个提交」，再怀疑逻辑。跳过这一步debug 出来的结论大概率是错的。

## 小结

- 要理解的是**三区**：` M`/`M `/`MM`/`??`/`UU` 五个短码覆盖日常全部状态；`status` 在 102 个跟踪文件的仓库上 94.9ms，其中约 55–58ms 是 Windows 进程启动地板价，贵出来的那部分是未跟踪文件枚举（2 万行展开 197.2ms，`.gitignore` 加一行降到 88.3ms）。
- `git add -p`：11 增 5 删的混合改动在默认 `-U3` 下只有 **1 个 hunk**，`s` 拆成 **3 个**；`s` 切不开相邻的格式化与功能改动，得用 `e` 按 git 给的指引原地剪。**硬按 hunk 拆的第一笔编译失败**（`'sub' was not declared in this scope`），剪好后三笔全部编译通过——判据是"每笔可构建"，不是"块越多越好"。
- `--amend` 是替换不是修改（`1f1b40d` → `ac8b539`），只允许用在没共享的最后一笔；已共享只能补新提交或 `git revert`。
- rebase 冲突里 **`--ours` 是上游、`--theirs` 才是你**（两遍实测），设 `merge.conflictstyle zdiff3` 才看得到 base；未暂存的已跟踪改动会让 `pull --rebase` 完全不发生，只有未跟踪文件时它照跑。本仓库 58 提交 0 merge，但系统配置里 `pull.rebase=false`——线性历史是显式 `--rebase` 换来的。
- 撤销按层给命令：`reset --hard` 之后进过索引的能靠 `git fsck --lost-found` 捞出（实测捞出 `three`），只在磁盘上存在过的（`four`）永久丢失，reflog 无能为力；「改动没生效」还要多查一条——本机 `core.autocrlf=true` 来自 `D:/Git/etc/gitconfig`，本仓库 3 个文件工作树 CRLF 而库内 LF 且 `git status` 干净，先 `git ls-files --eol` 再怀疑代码。
