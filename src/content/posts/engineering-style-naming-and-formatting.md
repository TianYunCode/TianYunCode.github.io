---
title: 代码风格：能让工具管的，就别用人管
description: 实测：同一份 72 行代码，无配置的 clang-format 改 120 行、带工程配置只改 28 行，编译出的机器码 162 条指令 sha256 完全相同；但一个格式化提交就把 86 行文件里 21 行的 blame 抢走，`git diff -w` 只能救回 2 行；-Wshadow 抓到的那个变量遮蔽让程序打印了 override 却仍解析默认输入。
date: 2026-10-16
tags: [工程实践, 代码风格, clang-format]
category: engineering
section: eng-style
---

> 环境：Windows 11 x64；clang-format 22.1.8；Git 2.56.0.windows.1；Node v22.19.0；Python 3.14.6；编译器 **D:/Qt/Tools/mingw1310_64/bin/g++.exe（GCC 13.1.0，x86_64-posix-seh）**——PATH 上排在前面的是 Strawberry 的 `C:/Strawberry/c/bin/g++.exe`（4.9.2，i686-posix-sjlj），只能用全路径。取证脚本与临时仓库都在 `C:/Users/wangt/AppData/Local/Temp/agents/engineering/`，被测代码样本 72 行；仓库体检对象是 `C:\Users\wangt\data\blog`（当时 44 个提交、78 个跟踪文件、43 篇文章）。

## 一、先解决"用哪个编译器"这件小事

写工程实践的文章却连命令都跑不通，是很常见的事故。本机 PATH 上同时存在两个 g++：

```text
$ g++ --version
g++.exe (i686-posix-sjlj, built by strawberryperl.com project) 4.9.2
$ D:/Qt/Tools/mingw1310_64/bin/g++.exe --version
g++.exe (x86_64-posix-seh-rev1, Built by MinGW-Builds project) 13.1.0

$ g++ -std=c++17 st.cpp -o st.exe
g++.exe: error: unrecognized command line option '-std=c++17'
```

4.9.2 不认识 `-std=c++17`，而且是 32 位 sjlj 运行时；13.1 是 64 位 posix 线程模型。**同一个 `g++` 名字背后是两套 ABI、两套可执行文件、两种失败方式**。脚本、CI、Makefile 里请写全路径，别赌"我机器上 g++ 是新的"。

顺带一个真实缺口：MinGW-w64 的 `<string.h>` 在 C++ 模式下不声明 `strndup`：

```text
parser_raw.cpp:28:22: error: 'strndup' was not declared in this scope; did you mean 'strdup'?
```

加 `-D_GNU_SOURCE` 一样报错。这种平台头文件的缺口不是靠风格能发现的，只能靠**每次都真的编译一遍**。

## 二、clang-format 给的是确定性，不是美观

样本是一段 72 行、2278 字节的 C++（含一个解析函数和两段重复的收尾逻辑）。三种处理：

| 处理方式 | 结果行数 | 结果字节 | 与原文的差异行 |
| --- | --- | --- | --- |
| 原文（手写，缩进混乱） | 72 | 2278 | — |
| `clang-format`（无配置，回退 LLVM 风格） | 90 | 2209 | 120 |
| `clang-format --style=file`（工程 `.clang-format`） | 86 | 2397 | 28 |

两个数字要放在一起看才有效：**没有配置文件时，工具改了 120 行；有 8 行配置文件时只改 28 行**。工程里那份配置是：

```text
BasedOnStyle: Google
ColumnLimit: 100
IndentWidth: 4
PointerAlignment: Left
SortIncludes: true
IncludeBlocks: Regroup
```

第二条要点：**格式化是幂等的**。对格式化后的文件再跑一次，输出逐字节相同（`diff -q` 无输出）。这条性质决定了它能进 CI 门禁——`clang-format --dry-run --Werror` 只可能报"你没跑"，不可能报"跑两遍结果不一样"。

第三条要点，也是最有说服力的一条：**格式化不改变代码含义**。把原文和格式化后的版本各编译一次，反汇编 `.text` 后逐条指令比对：

```text
instr lines raw/fmt: 162 162
sha raw 130bff1dee5c3e21
sha fmt 130bff1dee5c3e21
IDENTICAL MACHINE CODE: True
```

162 条指令、480 字节的 `.text`、sha256 一致。这就是"格式化提交不该被逐行评审"的技术依据：它按定义不可能引入逻辑改动，前提是**它只包含格式化**。

## 三、格式化提交的真正代价：blame 被劫持

在临时仓库里做了完整实验：提交 `feat: 字段解析器初版`，再提交 `style: clang-format 全量格式化`。

```text
== A. 这个 commit 的 --stat ==
 parser.cpp | 28 +++++++++++++++++++++-------
 1 file changed, 21 insertions(+), 7 deletions(-)
== B. git diff -w 之后还剩几行改动 ==
28        ← 默认
26        ← -w
26        ← --ignore-all-space --ignore-blank-lines
== C. blame 归属（默认）==
     21 a616544...  (格式化提交)
     65 da8fac6...  (功能提交)
== E. --ignore-rev ==
     86 da8fac6...
```

三个结论：

1. 一个 86 行的文件，格式化提交**抢走了 21 行（24.4%）的 blame 归属**。以后 `git blame` 查"这行为什么这么写"，答案是"格式化"。
2. **`git diff -w` 救不了你**：28 行差异里忽略空白后还剩 26 行。因为 clang-format 干的不是"补空格"，它还会折行、拆行、重排 include——这些都是真实的行变更。指望评审时加个 `-w` 就跳过格式化噪声，是不成立的。
3. 解法只有一个：**格式化提交单独成一次提交，然后进 `.git-blame-ignore-revs`**：

```text
git log --format='%H' --grep='clang-format' | cut -d' ' -f1 > .git-blame-ignore-revs
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

配置之后那 21 行全部回到功能提交（86 行全归 `da8fac6`）。把这个文件提交进仓库，团队里其他人 clone 后 `git blame` 自动正确。GitHub 也认这个文件（仓库设置里填路径即可）。

## 四、命名：一致性可以量化，意图不行

对本仓库 24 个 `.ts`/`.astro` 源文件（1344 行）做了统计，脚本见环境说明目录：

| 指标 | 实测值 |
| --- | --- |
| 声明出的标识符 | 125 个 |
| camelCase | 29 个 |
| snake_case | 2 个 |
| 长度 ≤ 2 的标识符 | 2 个（`id`、`no`） |
| 最长标识符 | `readingMinutes`、`getStaticPaths`、`postsInCategory`、`markdownHeadings` |
| 未解析的相对 import | 0 |

命名规范的第一价值不是"好看"，是**可预测**：125 个标识符里只有 2 个用下划线，新人写代码时猜得到该怎么拼。第二价值是"长度换作用域"：`i` 在 3 行循环里是合格的，`p` 在跨 5 个函数的地方就是灾难。本仓库 0 个单字母变量出现在函数签名里，这不是巧合，是 review 出来的。

反例来自同一份体检：整个仓库的裸数字字面量出现 97 次，其中 `0` 34 次、`1` 30 次（通常无害），但 `24`、`6`、`9` 这类散落的数字是有名字的概念（每页文章数、阅读分钟换算），命名之后才能被 grep 到、被改对。

## 五、函数长度：用测量代替"建议不超过 50 行"

本仓库 15 个函数的实测分布：

```text
函数总数: 15
函数长度: 中位数 7，均值 7.4，最长 17，<=10 行的占比 80%
   17 行  GET               src/pages/rss.xml.ts (参数 1 / return 1 / 分支 0)
   12 行  postsBySection    src/utils/post.ts (参数 1 / return 1 / 分支 4)
```

中位数 7 行、最长 17 行——**这就是"一个函数一个抽象层级"能被量化的样子**。对比另一侧：重构样本里那个 55 行的函数，括号嵌套最深 8 层、内含 19 个分支关键字，同一份逻辑拆成四个函数后主函数只剩 21 行、嵌套 3 层、7 个分支（详见「重构与小步安全改动」一节）。真正的判据不是行数，是**读的时候需要在脑子里装多少个状态**：55 行/8 层装不下，17 行/0 分支装得下。

## 六、告警是"写给机器的命名规范"

同一份 72 行样本，`-Wall -Wextra -Wshadow -Wconversion` 给出 2 条警告，其中一条直接对应一个运行时错误：

```text
parser_raw.cpp:60:21: warning: declaration of 'input' shadows a previous local [-Wshadow]
   60 |         const char* input = getenv("INPUT");
      |                     ^~~~~
parser_raw.cpp:57:17: note: shadowed declaration is here
   57 |     const char* input = argc > 1 ? argv[1] : "a=1;b=2;c=3;a=9";
      |                 ^~~~~
parser_raw.cpp:27:22: warning: conversion from 'long long int' to 'int' may change value [-Wconversion]
   27 |         int len = eq - p;
```

跑起来是什么样：

```text
$ ./raw.exe
parsed=4 total=4
a->1
b->2
c->3

$ INPUT="x=42;y=7" ./raw.exe
override=x=42;y=7
parsed=4 total=4
a->1
b->2
c->3
```

程序打印了 `override=`，然后**继续解析默认字符串**。作者想表达的是"环境变量覆盖输入"，代码实际写的是"在 if 块里造一个同名新变量并打印它"。这类 bug 人眼极难发现（两行代码各自都合理），而 `-Wshadow` 一行命中。

所以风格工具的分界线很清楚：

| 交给工具 | 留给人 |
| --- | --- |
| 缩进、换行、include 顺序、指针贴边 | 变量名承载的意图 |
| 空白、末行换行、CRLF | 函数该在哪切一刀 |
| 未使用/遮蔽/隐式窄化（编译器） | 命名是否和邻居一致 |

本仓库的体检顺便证明工具能管的部分有多干净：78 个跟踪文件、16368 行文本，**0 个 CRLF、0 行行尾空格、0 个缺末行换行、0 个 BOM**，唯一例外是一个文件里有一处制表符对齐。这类问题一次 `.editorconfig` + pre-commit 就永久消失，不值得任何一行评审注意力。

## 七、注释：0.4% 的注释率不是病

本仓库 `.ts`/`.astro` 里非空代码 1231 行，注释 5 行，**注释占比 0.4%**。这个数字低得可疑，但它是自洽的：函数中位数 7 行、最长 17 行、无嵌套深坑、命名一致。这个代码库不需要注释解释"这段在干什么"，因为函数名和 7 行的体量已经把"在干什么"说完了。

反过来，样本里那段 55 行/8 层嵌套的函数，我在它头上写了一行注释：

```c
// 解析 "k1=v1;k2=v2" 形式；返回解析出的字段数
```

这行注释承担了函数名承担不了的东西：**返回值的含义和边界**（返回字段数而不是成功与否，`-1` 未出现但截断静默发生）。这就是注释该写的位置——写"契约"和"为什么"，不写"这一行在赋值"。

该写注释的三处，按性价比排序：**不变量**（`dedup_sorted` 要求输入已排序，不排序时结果是"部分去重"而不是报错）、**决定而不是代码**（为什么这里不分配内存）、**坑的现场**（`// MinGW-w64 的 <string.h> 在 C++ 模式下不声明 strndup，自己写一个`，这条省下后来人半小时）。

不该写的：复述代码（`i++ // i 加一`）、和代码争夺维护权的过期说明。README 里"14 个大类、156 个章节"就属于后者——数出来确实是 14 和 156，但**每次增删章节都要有人记得改**。更好的写法是让它可校验，或者由 `categories.ts` 渲染出来（详见「文档与 README」一节）。

## 八、小结

- 工具链先钉死：全路径编译器，`g++` 这个名字在 PATH 上是 4.9.2/32 位，不认识 `-std=c++17`。
- clang-format 的价值排序是**幂等 > 有工程配置 > 风格好看**：无配置改 120 行，有配置改 28 行；格式化后机器码 162 条指令 sha256 不变，所以它值得被机器管、被跳过人工评审。
- 格式化提交必须独立成一次，并登记进 `.git-blame-ignore-revs`：实测一个格式化提交劫持了 86 行文件里 21 行的 blame，而 `git diff -w` 只能救回 2 行。
- 命名的可量化部分是**一致性**（125:2 的 camelCase 比例、0 个未解析 import），不可量化的部分是意图，意图靠"函数装得下"来保证：中位 7 行、最长 17 行。
- 编译器告警是零成本的评审员：`-Wshadow` 抓到"打印了 override 却仍用默认输入"的真 bug，`-Wconversion` 抓到 `long long → int` 的窄化。
- 注释写契约、写决定、写坑；本仓库 0.4% 注释率能活，是因为结构本身在承担说明责任。
