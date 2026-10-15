---
title: 版本号、发布与回滚：兼容性的裁判是已编译的调用方，不是你的语义直觉
description: 实测：给结构体尾部加一个字段（语义化版本里的典型 MINOR 改动），已编译的调用方不崩、退出码 0，但它把邻居内存写成了 0x11223344；中间插字段则让调用方把 999 当成 c 读走；同一份源码用同一组参数编两次，84932 字节里有 2 个字节不同；`--force-with-lease` 在 fetch 之后照样把别人的提交抹掉。
date: 2026-10-16
tags: [工程实践, 版本号, 发布, 回滚, 符号归档]
category: engineering
section: eng-release
---

> 环境：Windows 11 x64；Git 2.56.0.windows.1；`D:/Qt/Tools/mingw1310_64/bin/gcc.exe|g++.exe`（13.1.0）+ 同目录 `mingw32-make.exe`/`ar.exe`/`nm.exe`/`objdump.exe`/`strip.exe`/`addr2line.exe`（PATH 上的 gcc 是 Strawberry 4.9.2，禁用；PATH 上没有 make）。真实仓库 `C:\Users\wangt\data\blog` 以提交 **1e37133** 为锚点（66 个提交、115 个跟踪文件、78 篇文章、**0 个 tag**、0 个 merge），对它只跑只读命令。所有需要 commit/tag/push 的实验都在 `C:/Users/wangt/AppData/Local/Temp/agents/engarch/` 下新建的 `rel-git`、`rel2` 两个临时仓库 + 一个本地 bare 远端 `rel2-origin` + 两个 clone 里做；ABI 与符号实验在 `abi/`、`sym/` 两个工程里做。**没有 GitHub Actions runner、没有私有 registry、没有流量入口**，所以"灰度分流"和"CI 上的部署/回滚按钮"这两块只有清单没有实测，末尾逐条列出。

## 一、语义化版本对二进制不成立：四种改法，四种实测后果

`abi/` 里 `app.exe` 只编译一次，它看到的布局永远是 v1：

```text
[app] sizeof(Config)=12  期望字段 a@0 b@4 c@8
```

然后**不重编 app**，只换它加载的 DLL（每个 DLL 都是 `fill()` 填结构体 + `compute(7)`）。我在结构体末尾准备的"邻居"是 `raw[12]=0xAB, raw[13]=0xCD`：

| 换上的 DLL | 改动内容 | app.exe 的实际读数 | 退出码 |
| --- | --- | --- | --- |
| `lib_v1.dll` | 基线 | `a=1 b=2 c=3 \| 偏移 12..16 = AB CD 00 00 00`，`compute(7)=71` | 0 |
| `lib_tail.dll` | **尾部加一个字段**（`int log_lines = 0x11223344`） | `a=1 b=2 c=3`，但 `偏移 12..16 = 44 33 22 11 00` | 0 |
| `lib_mid.dll` | **中间插一个字段**（`a,b,inserted=999,c`） | `a=1 b=2 `**`c=999`**，偏移 12 处是 `03 00 00 00` | 0 |
| `lib_sig.dll` | **函数加一个参数**（`compute(int,int)`，`extern "C"` 名字不变） | `compute(7) = 1763901510`，再跑两次是 `1309016134`、`1854668870` | 0 |
| `lib_cpp2.dll` | 同上但用 C++ 导出（名字修饰） | `GetProcAddress("_Z7computei") 失败 err=127` | 12 |

四行都有价值，逐条读：

- **尾部加字段（"这只该算 MINOR"）在二进制上是越界写。** 库按 16 字节写，宿主只分配了 12 字节，紧跟着的那 4 字节被 `0x11223344` 覆盖——它可能是另一个字段、可能是保存的栈帧、也可能刚好是填充位所以什么都没发生。`compute(7)=71` 仍然正确，程序仍然退出 0：**这种破坏是事后才以"莫名其妙的值"浮现的**。
- **中间插字段是静默错读。** `c` 读到 999，没有任何一次调用报错。这一条比越界写更常见，因为"在中间加字段"是很多人以为安全的操作（"我又没删东西"）。
- **改签名而 `extern "C"` 名字不变 = 传了一个不存在的参数。** 多出来的那个参数是调用方没准备的寄存器内容，所以**同一个二进制、同一行调用，三次跑出三个不同的返回值**。这是我在本机见过的对"为什么二进制的兼容性问题不会编译报错、只会算错数"最干净的演示。
- **C++ 的名字修饰意外充当了校验。** 加参数让修饰名从 `_Z7computei` 变成 `_Z7computeii`，于是查找老名字的宿主在加载期就失败（`err=127` = `ERROR_PROC_NOT_FOUND`），错误发生在**没有发生任何一次错读之前**。
- 五个 DLL 的字节数分别是 36283/36283/36283/36295/36296——**"文件大小差不多"不能当兼容性证据**，差异全在布局与签名里。

必须写清平台边界：本机是 MinGW-w64 的 PE（`pei-x86-64`），**没有 MSVC 那套 loader 侧的版本/清单校验，也没有 ELF 的符号版本脚本**。所以这里的结论是"Windows + MinGW 下二进制兼容性问题会静默通过"，不能外推到 Linux（glibc 符号版本会让部分情况在加载期失败）或 MSVC（清单/`/dependentscan` 行为不同）。我采用的兜底做法见第 8 节：接口头里放 `api` 与 `struct_size` 两个字段，**由插件自报、宿主比对**，实测能拦住那个 `api=99` 的插件（`拒绝加载：插件自报 api=99, 宿主编译期期望 api=2`，退出码 13）。

## 二、`git describe` 给出的版本号，有四种情况不是你想要的

`rel-git` 里的 tag 布局：`v1.0.0`/`v1.1.0`/`v1.10.0` 是附注 tag，`v1.9.0` 是**轻量 tag**，HEAD 在 `v1.10.0` 之后 2 个提交。

```text
$ git tag                        # 字典序
v1.0.0  v1.1.0  v1.10.0  v1.9.0
$ git tag --sort=version:refname
v1.0.0  v1.1.0  v1.9.0  v1.10.0
$ echo "git tag | tail -1 当最新版会拿到：$(git tag | tail -1)"
git tag | tail -1 当最新版会拿到：v1.9.0        ← 错，字典序把 v1.10.0 排在 v1.9.0 前面
$ git cat-file -t v1.9.0   → commit            ← 轻量 tag
$ git cat-file -t v1.10.0  → tag               ← 附注 tag
```

`describe` 侧的实测原文（同一个 HEAD）：

| 命令 | 输出 |
| --- | --- |
| `git describe` / `--long` | `v1.10.0-2-gb9dd639` |
| `git describe --tags` | `v1.10.0-2-gb9dd639`（这个布局下 `v1.9.0` 更远，没被选中） |
| `git describe --abbrev=0` | `v1.10.0` |
| `git describe --dirty`（改一个已跟踪文件后） | `v1.10.0-2-gb9dd639-dirty`，同时 `git status --porcelain` = ` M app.txt` |
| 在 HEAD 上补一个轻量 tag 后 `git describe` | `v1.10.0-2-gb9dd639`（**默认跳过轻量 tag**） |
| 同一状态下 `git describe --tags` | `lw-on-head` |
| 无任何 tag 的仓库 | `fatal: No names found, cannot describe anything.`，**rc=128**；加 `--always` 才降级成 `525699c` |
| 从 `v1.1.0` 拉的 hotfix 分支上 | `v1.1.0-1-gf0ea24d` —— 明明仓库里有 `v1.9.0`/`v1.10.0` |

四条要背下来的：**(1)** 取"最新版"必须 `--sort=version:refname`，`git tag | tail -1` 在 1.9/1.10 交界处必然选错；**(2)** `describe` 只回溯**祖先**、不看版本号大小，所以长期维护分支打出来的包会顶着旧版本号出去（这是 hotfix 包"版本号比主线小却更新"的根因）；**(3)** `--tags` 会让任何一个轻量 tag（别人 `git tag v2.0` 随手一打）成为版本号来源；**(4)** 没有 tag 时 `describe` 是 rc=128 的**硬失败**，脚本里必须显式给 `--always`，否则 CI 的取版本步骤会以一种谁也看不懂的方式红。

本仓库的活样本（只读）：`package.json` 是 `"version": "1.0.0"` + `"private": true`，三个依赖全写成 `^5.0.0` / `^4.0.0` / `^3.0.0`，而 `package-lock.json`（lockfileVersion 3）里 astro 实际锁定在 **5.18.2**——`^5.0.0` 这个声明单方面允许了 18 个 minor。**范围声明是你对下游签的兼容承诺，锁文件才是真相**；发布产物要么带锁文件，要么带哈希。另外：本仓库 `git tag` 数量 **0**，也就是说这 66 个提交里没有任何一个点被钉成"发布"。

## 三、发布检查清单：先诚实标出哪些项现在没人做

`.github/workflows/deploy.yml` 里一共 **6 个步骤**（Checkout → Setup Node → `npm ci` → `npm run build` → `upload-pages-artifact` → `deploy-pages`）。我按这份 workflow 逐条对照，右列是本机能量到的：

| 检查项 | 本仓库实测状态 |
| --- | --- |
| 版本号来源 | `package.json` 恒为 1.0.0，构建不注入；**`dist` 全 334 个文件里 0 处版本标识**（`grep 1e37133 dist` 只命中 1 篇 HTML，而那篇是我写的正文里的锚点哈希，不是构建写的） |
| 依赖可复现 | `package-lock.json` 存在且被 `npm ci` 使用 ✅；`node_modules` 不在 Git 里 ✅ |
| 发布锚点 | **0 个 tag**——想回滚没有目标点 |
| 变更前记录 | `dist/sitemap-0.xml` 有 **325 个 `<url>`、0 个 `<lastmod>`**；RSS 里有 `<pubDate>Fri, 16 Oct 2026 00:00:00 GMT`（日期来自 frontmatter，不是构建时间） |
| 缓存穿透指纹 | `dist/_astro/` 只有 1 个文件，名字带内容哈希 `_slug_.BBKLxXcv.css` ✅ |
| 测试/静态检查门禁 | 第 5 节实测：CI 里 **0 条 test/lint/check 步骤**，唯一门禁是"能否构建" |
| 产物完整性 | 无校验和文件、无签名（本机没有签名工具链，未实测） |
| 冒烟验证 | 无——`deploy-pages` 只报告"步骤成功"；README 第 59 行写的是"推送后约 40 秒上线"，第 4 节实测确认可用是 **33 秒**，两者都是**人去看了一眼**才成立的 |

产物规模顺便记一下（当前 `dist/`）：**334 个文件 / 326 个 HTML / 5480 KB**。

这份清单的正确用法不是"打勾"，而是**每一项都要有一个能返回码的验证动作**，否则它就是第 7 节里那种"空转的检查"。比如"产物里有没有版本标识"这项，我这条 `grep` 命令跑出来的答案就是"没有"——那么修复动作是把 `git describe` 的结果写进构建（第 10 节里那条"CI 要验证产物而不是验证步骤退出码"讲的正是同一件事）。

## 四、回滚：git 层的四次真实操作与它们的边界

`rel2` 仓库：7 个提交，`v1.9.9` 打在"补边界"上，HEAD 在其后 1 个提交。回滚目标 `9ed2eb4 feat: 灰度开关` 动的是自己的文件 `f_keep.txt`。

```text
$ git revert --no-edit 9ed2eb4            rc=0
[main 5c08e37] Revert "feat: 灰度开关"
 1 file changed, 1 deletion(-)
 delete mode 100644 f_keep.txt
$ git tag -a v1.10.1 -m "回滚 灰度开关，不发新功能"
$ git describe            → v1.10.1        （干净地落在新 tag 上）
$ git rev-list --count v1.9.9..HEAD  → 2
$ git diff --stat v1.9.9 v1.10.1
  CHANGELOG.md | 1 +
  f_keep.txt   | 1 -
  2 files changed, 1 insertion(+), 1 deletion(-)
```

注意 `delete mode 100644`：**回滚一个"新增文件"的功能提交，动作是整个文件消失**，不是那一行被删。也注意 tag 名字——回滚包我打的是 `v1.10.1`（补丁位），而历史里已经存在 `v1.9.9`：**语义化版本的序号在回滚场景里必须由人决定，git 只会按字典序把它们排乱**（第二节那条）。

紧接着回滚"往 CHANGELOG 尾部追加"的那个提交，结果完全不同：

```text
$ git revert --no-edit 54e0414        rc=1
CONFLICT (content): Merge conflict in CHANGELOG.md
error: could not revert 54e0414... docs: CHANGELOG 记 v1.9.9
<<<<<<< HEAD
v1.9.9
v1.9.9-hotfix
=======
>>>>>>> parent of 54e0414 (docs: CHANGELOG 记 v1.9.9)
$ git status --porcelain  → UU CHANGELOG.md
$ git revert --abort      → CHANGELOG = v1.0.0 / v1.9.9 / v1.9.9-hotfix
```

**同一个文件尾部的相邻追加会让回滚变成冲突**——而 CHANGELOG、版本号文件、锁文件恰好都是"所有人往同一处追加"的东西。这就是为什么发布元数据要么按版本分文件（`changes/1.9.9.md`），要么承认"这一类提交不可单独回滚"。

第三步：把被回滚的功能重放回来（第 4 节埋过的那个坑，这里给完整数字）：

```text
$ git cherry-pick 9ed2eb4      rc=0
[main 69d79a4] feat: 灰度开关
 1 file changed, 1 insertion(+)
 create mode 100644 f_keep.txt
$ git diff --stat v1.10.1 HEAD  → f_keep.txt | 1 +
```

`cherry-pick` 能成（因为工作区里那行确实被 revert 掉了），但新提交是 **`69d79a4`，不是原来的 `9ed2eb4`**——哈希变了，任何按 commit 哈希建立的白名单/审计记录都会对不上。

第四步是发布分支最常见的事故：改写已推送的历史。两个 clone 指向同一个本地 bare 远端，B 抢先推了一笔，A 在不知道的情况下强推：

```text
$ git push --force-with-lease origin main          rc=1
 ! [rejected]        main -> main (stale info)

$ git push origin main                             rc=1
 ! [rejected]        main -> main (fetch first)
 hint: Updates were rejected because the remote contains work that you do not have locally.

$ git fetch -q origin && git push --force-with-lease origin main   rc=0
 + 2c54ca1...9e94509 main -> main (forced update)
$ git --git-dir=.../rel2-origin log --oneline main | grep -c 'B: 别人先推了一笔'   → 0
```

**`--force-with-lease` 的保护条件是"你没 fetch 过"。** 一旦你同步了远端（而 CI 脚本、IDE 后台自动抓取、`git pull --rebase` 都会同步），它就会安静地按你眼前看到的远端状态去覆盖——B 那笔提交从 origin 上消失了，`rc=0`，一句警告都没有。结论：发布分支和 tag 的保护**只能放在服务端**（GitHub 的 branch protection / tag protection / signed tags），本地开关都是可以被"善意地同步一次"绕过的。

## 五、回滚的正确单位是产物，不是源码

`sym/` 里同一份 `prog.cpp`、同一组参数（`-std=c++17 -O0 -g -static`）连编两次：

```text
84932 b1.exe     ff2077dfad6e5ae1…
84932 b2.exe     99e22e66c0f19943…
$ cmp -l b1.exe b2.exe
137 145 151
217  76 102          ← 一共只有 2 个字节不同
$ objdump -x b1.exe | grep -i 'time/date' → Fri Oct 16 01:16:21 2026
$ objdump -x b2.exe | grep -i 'time/date' → Fri Oct 16 01:16:25 2026
```

**尺寸逐字节相同，内容差 2 个字节**：偏移 137 是 PE 头 `Time/Date` 的最低字节（两次构建相隔 4 秒，值从 `0x65` 变 `0x69`），偏移 217 是 `0x3E→0x66`（我没进一步归因）。这条对发布的意义很直接：**"回滚到旧 tag 重新构建一次"拿不回当时那个包**——它连一个字节级的证明都给不出，你无法向别人（也无法向三个月后的自己）确认"线上跑的就是 v1.9.9 的产物"。所以顺序必须是：**先归档产物 + 哈希，回滚时把归档里的那份拿回来**；重编只作为"归档丢失"时的应急，而且此时要承认"这是一个新版本，只是内容来自旧提交"，该给它一个新的构建号。（固定时间戳的方案 `SOURCE_DATE_EPOCH` / `-Wl,--no-insert-timestamp` 我**没有实测**，见末尾清单。）

## 六、二进制产物与符号归档：一次完整的可回溯链路

`prog.cpp` 是三个 `__attribute__((noinline))` 的嵌套函数加一个打印模块基址的 `main`。三种形态：

| 产物 | 字节数 | `nm` 符号数 | 段数（`objdump -h`） | `.text` 大小 |
| --- | --- | --- | --- | --- |
| `prog_sym.exe`（`-g`，发布归档用） | **84932** | 1003 | 18 | `00006c68` |
| `prog_stripdebug.exe`（`strip --strip-debug`） | 67451 | 947 | — | `00006c68` |
| `prog_stripped.exe`（`strip --strip-all`，部署用） | **38912** | `nm: no symbols` | 10 | `00006c68` |

- 部署版比带符号版小 **46020 字节（−54.2%）**，但 **`.text` 两边都是 `0x6c68`（27752 字节）完全一致**：脱符号没有动一行代码，这是能放心给线上发瘦身产物的证据。
- 46020 字节里，`.debug_*` 各段合计 **9291 字节**（`objdump -h` 求和），其余是符号表 + 字符串表（1003 个符号）。两个数对不齐的部分是段对齐填充，我没有逐项拆开归因。
- `--strip-debug` 是个中间档：84932 → 67451，**仍留 947 个符号**。它能给出函数名但给不出行号，所以别把它当"符号归档"。

崩溃回溯链路（真实跑的三步）：

```text
$ ./prog_stripped.exe        ← 线上产物
BASE=00007ff69e070000 ADDR deep1=00007ff69e071492 deep2=00007ff69e071474 deep3=00007ff69e071450

RVA = 0x7ff69e071492 - 0x7ff69e070000 = 0x1492
VMA = 0x1492 + 0x140000000（PE 首选基址） = 0x140001492

$ addr2line -e prog_stripped.exe -f 0x140001492   →  ?? ??:0            ← 线上产物解不出来
$ addr2line -e prog_sym.exe      -f 0x140001492   →  deep1  …/prog.cpp:13 ← 归档副本解得出来
  deep2 0x140001474 → deep2  …/prog.cpp:9
  deep3 0x140001450 → deep3  …/prog.cpp:4
```

这里踩到的两个坑都属于"会被误诊成符号丢了"的那类：**(1)** Windows 上 ASLR 每次可能换基址，把运行时地址直接喂给 `addr2line` 得到的是 `??:0`（我实测 `0x7ff69e071492` 原值喂进去就是这个结果）；必须先减模块基址再加首选基址，所以**日志里必须同时打基址和地址**，只有绝对地址的崩溃日志是无法还原的。**(2)** 同一个进程里 RVA 是稳定的（`deep1` 的低 16 位恒为 `0x1492`），但**不同构建之间 RVA 会变**——归档的 key 必须是"版本号 + 产物哈希"，而不是函数名。

于是归档策略只需要三条：**线上发 `--strip-all` 的产物；`-g` 的副本按 `版本号+sha256` 命名归档（放对象存储，不进 Git）；崩溃日志必须带模块基址**。本仓库没有二进制产物，对应关系是把 `dist/` 整个作为 artifact 上传（`upload-pages-artifact`）——但 `dist` 里没有版本标识（第三节实测 0 处），所以 Pages 这种"只保留最新一份"的部署一旦回滚，只能去 Actions 的运行记录里找旧 artifact，而**旧 artifact 有没有过期我无法验证（本机没有 runner 权限）**。

## 小结

- **语义化版本管不了二进制**：尾部加字段（MINOR 直觉）实测把调用方的邻居字节写成 `44 33 22 11`；中间插字段让 `c` 静默读到 999；`extern "C"` 下加参数让 `compute(7)` 三次跑出 1763901510 / 1309016134 / 1854668870——四种情况退出码全是 0。C++ 修饰名反而给了免费校验（`err=127`，rc=12）。平台边界：MinGW/PE 无 MSVC 式 loader 校验。
- **版本号取法四个坑**（全部实测原文）：`git tag | tail -1` 在 `v1.10.0`/`v1.9.0` 之间拿回 `v1.9.0`；`describe` 只回溯祖先，hotfix 分支上是 `v1.1.0-1-gf0ea24d`；轻量 tag 被默认忽略、被 `--tags` 采信；无 tag 时 `describe` rc=128 硬失败。本仓库活样本：`^5.0.0` 声明 vs 锁文件里的 **5.18.2**，外加 **0 个 tag**。
- **回滚的边界是"改动是否相邻"**：隔离文件的提交 revert rc=0 并干净落在 `v1.10.1`；CHANGELOG 那种尾部追加文件的 revert rc=1 并把冲突块留在同一处；`cherry-pick` 重放能成但哈希从 `9ed2eb4` 变 `69d79a4`；`--force-with-lease` 只在**没 fetch** 时挡人（`! [rejected] main -> main (stale info)`），fetch 之后照样 `+ 2c54ca1...9e94509 (forced update)` 并抹掉协作者的提交。
- **回滚单位是产物**：同一份源码两次构建，84932 字节只差 2 个字节（偏移 137 = PE `Time/Date` 低字节，4 秒之差；偏移 217 未归因）。所以"重编一次旧 tag"给不出"这就是当时那个包"的证明。
- **strip 的量与链路**：84932 →（`--strip-debug`）67451 →（`--strip-all`）38912，−54.2%，而 `.text` 恒为 `0x6c68`；`--strip-all` 版 `nm` 报 `no symbols`、`addr2line` 只能给 `??:0`，同一批地址用归档的 `-g` 副本还原成 `deep1 …:13 / deep2 …:9 / deep3 …:4`。ASLR 下日志必须带模块基址，归档 key 必须是版本号 + 产物哈希。
- **未实测清单**：(1) `SOURCE_DATE_EPOCH` / `-Wl,--no-insert-timestamp` 能否让 MinGW 产物逐字节可复现——我没跑这组对照；(2) MSVC 工具链下的 loader 校验行为差异，本机无 MSVC；(3) GitHub Actions 上的部署/回滚按钮、artifact 保留期、Pages deployment 回退，本机无 runner；(4) 按比例/按用户灰度的分流与观测，本机没有流量入口，本文只覆盖"发布点怎么钉、回滚单位选哪个"；(5) 产物签名与校验和工具链（`cosign`/`sigstore`）；(6) Astro `npm run build` 的重复构建是否逐字节一致（博客仓库不许我跑 npm）；(7) 偏移 217 那 1 个字节差异的具体来源。
