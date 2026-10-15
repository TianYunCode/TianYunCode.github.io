---
title: 预处理与编译四阶段
description: 一行源码变成 1102 行、宏的括号为什么能决定成败、目标文件里的符号表怎么看、头文件守卫漏掉会报什么错——把"编译"拆成四步看清楚。
date: 2026-10-15
tags: [C语言, 预处理, 编译原理]
category: c-language
section: c-preprocess
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**。下面每个字节数、每条诊断都是本机实测。

## 一、四个阶段，四种产物

`gcc hello.c -o hello.exe` 其实是四件事：

| 阶段 | 做什么 | 产物 | 本机实测大小 |
| --- | --- | --- | --- |
| 预处理 | 展开头文件、执行 `#` 指令 | `stage1.i` | 43 行源码 → **1102 行 / 62458 字节** |
| 编译 | 语法分析、优化、生成汇编 | `stage2.s` | 6016 字节 |
| 汇编 | 助记符 → 机器码 + 重定位信息 | `stage3.o` | 2804 字节 |
| 链接 | 合并 `.o`、解析符号、写可执行文件 | `stage4.exe` | 77503 字节 |

一条命令就能逐步执行：

```bash
gcc -std=c17 -E probeB.c -o stage1.i   # 只预处理
gcc -std=c17 -S stage1.i -o stage2.s   # 只编译
gcc -std=c17 -c stage2.s -o stage3.o   # 只汇编
gcc stage3.o -o stage4.exe             # 只链接
```

**一个 43 行的文件预处理后变成 1102 行**——多出来的 1059 行全部来自 `#include <stdio.h>`。这解释了为什么改一个被广泛包含的头文件会引发全量重编译，也是编译时间的主要来源。

看中间产物是排查问题的第一手手段：

```bash
gcc -E file.c | less          # 宏到底展开成什么了？
gcc -S -O2 file.c            # 编译器真的内联了吗？
gcc -c file.c && nm file.o   # 这个符号到底是谁定义的？
```

## 二、预处理只做文本替换：宏的括号能决定成败

```c
#define SQUARE_BAD(x)  x *x
#define SQUARE_OK(x)   ((x) * (x))
printf("%d %d\n", SQUARE_BAD(1 + 2), SQUARE_OK(1 + 2));
```

```text
SQUARE_BAD(1+2)      = 5（展开成 1+2*1+2）
SQUARE_OK((1+2))     = 9
```

`1 + 2 * 1 + 2 = 5`，不是 `9`。预处理器不理解语法，它只把 `x` 换成**那段文本本身**。所以宏定义有两条铁律：**每个参数加括号，整个替换体再加一层括号**。

第三条同样重要：**不要把有副作用的表达式传给宏**。

```c
int i = 3;
printf("%d %d\n", SQUARE_BAD(i++), i);
```

```text
副作用：SQUARE_BAD(i++) 展开成 12，i 变成 5
```

`i++` 被替换了两次，一次表达式里两个自增、中间还没有序列点，编译器直接判定：

```text
warning: operation on 'i' may be undefined [-Wsequence-point]
note: in definition of macro 'SQUARE_BAD'
```

`12` 只是本机结果，这是**未定义行为**。注意 `note: in definition of macro` 这一行——诊断会指回宏定义处，这是排查"宏吃掉了什么"最直接的线索。

### 参数之外的三个宏技巧

```c
#define STR(x)        #x            /* 字符串化：STR(hello) → "hello" */
#define CONCAT(a, b)  a##b          /* 拼接：CONCAT(val,_1) → val_1 */
#define LOG(fmt, ...) fprintf(stderr, "[%s:%d] " fmt "\n", __FILE__, __LINE__, ##__VA_ARGS__)
```

`__VA_ARGS__` 展开可变参数，而 `##__VA_ARGS__`（**GCC 扩展**，C23 才用 `__VA_OPT__` 标准化）允许一个可变参数都不传时把前面的逗号消掉，否则 `fmt "", ` 后面多一个逗号会编译失败。

多语句宏必须包在 `do { ... } while (0)` 里，这样它在 `if (x) MACRO(); else ...` 中才表现得像一条语句：

```c
#define SWAP(a, b) do { typeof(a) _t = (a); (a) = (b); (b) = _t; } while (0)
```

不写 `do-while(0)` 而直接写 `{ ... }`，遇到 `if (cond) SWAP(x, y); else ...;` 就会因为多出的分号而语法错误。

## 三、预定义宏：程序自带的编译信息

```c
printf("__STDC_VERSION__ = %ld\n", __STDC_VERSION__);
printf("__FILE__=%s __LINE__=%d __func__=%s\n", __FILE__, __LINE__, __func__);
printf("__DATE__=%s __TIME__=%s\n", __DATE__, __TIME__);
printf("__GNUC__=%d __GNUC_MINOR__=%d\n", __GNUC__, __GNUC_MINOR__);
```

```text
__STDC_VERSION__ = 201710
__FILE__=probeB.c __LINE__=19 __func__=main
__DATE__=Oct 15 2026 __TIME__=13:32:49
gcc 版本宏 __GNUC__=13 __GNUC_MINOR__=1
```

- `__STDC_VERSION__` 是**判断语言版本唯一可靠的方式**：`201710L` = C17，`201112L` = C11，`199901L` = C99。写可移植代码就靠它做条件编译。
- `__FILE__` / `__LINE__` / `__func__` 是日志系统的地基。上面 `LOG` 宏的输出：

  ```text
  [probeB.c:24 main] 只有格式串
  [probeB.c:25 main] 带参数 42 ok
  ```

  顺带一个真实坑：这两行在混合 stdout/stderr 时**顺序会错位**——stderr 无缓冲，stdout 重定向到文件时是全缓冲。调试并发或崩溃日志时，这个现象会让人误判"日志丢了"，必要时 `setvbuf(stdout, NULL, _IONBF, 0)`。
- `__DATE__` / `__TIME__` 让每次编译产物都不同，**破坏可复现构建**，别在生产二进制里用。

## 四、条件编译：容易写出"从来没被编译过"的代码

```c
#if defined(DEBUG) && DEBUG
    printf("DEBUG 分支\n");
#else
    printf("未定义 DEBUG，走 #else 分支\n");
#endif
#ifdef __x86_64__
    printf("__x86_64__ 已定义（64 位目标）\n");
#endif
#if __STDC_VERSION__ >= 201112L
    printf("编译器声明支持 C11 及以上\n");
#endif
```

```text
未定义 DEBUG，走 #else 分支
__x86_64__ 已定义（64 位目标）
编译器声明支持 C11 及以上
```

条件编译最大的风险不是写错语法，而是**没被选中的分支从来没进过编译器**，等哪天切到那个平台，才发现里面全是错误。对策只有两条：CI 里把每个平台/每个开关都真的编译一遍；或者用 `#if 0` 时明确它是临时注释。

`#if` 能算常量表达式，`#ifdef` 只能判断"有没有定义"。**判断宏的值一定要用 `#if`**，因为 `#ifdef FOO` 在 `#define FOO 0` 时也是真。

## 五、头文件：守卫、包含顺序与重复包含

```c
/* dup.h */
#ifndef DUP_H
#define DUP_H
struct guarded { int a; };
#endif
```

```c
#include "dup.h"
#include "dup.h"     /* 有守卫：无事发生 */
```

带守卫编译通过（`exit=0`）。把守卫去掉、让同一个定义被展开两次：

```text
error: redefinition of 'struct unguarded'
note: originally defined here
```

这就是"头文件必须有包含守卫"的直接后果。三条实践：

1. 守卫宏用 `项目_路径_文件` 全大写，别用裸 `FOO_H`（会和第三方库撞名）。
2. `#pragma once` 更短、编译器处理更快，但它不是标准语法，且对"同一文件通过不同路径（符号链接）被包含"的处理依赖实现。跨平台项目仍建议用 `#ifndef` 守卫。
3. **头文件里不要放定义**（除了 `static inline`、`static` 变量和类型定义）。函数定义放头文件会撞上上一节讲的 `inline` 链接规则，全局变量定义会 `multiple definition`。

`#include <stdio.h>` 找系统/工具链 include 路径，`#include "mine.h"` 先找当前文件目录再找 `-I` 路径。这个差别在同名文件时会决定你编译到的是哪一份——排查"改了头文件没生效"时先 `gcc -E -H file.c` 看它到底打开了哪个路径。

## 六、`#define` 常量 vs `enum` vs `const`

```c
#define BUF_SIZE 64
enum { STACK_SIZE = 16 };
static const int HEAP_LIMIT = 1024;
```

```text
enum BUF_SIZE=64 有类型、受调试器可见；#define 只是文本替换
```

| 方式 | 有类型 | 调试器可见 | 能被 `-D` 覆盖 | 用于编译期数组长度 |
| --- | --- | --- | --- | --- |
| `#define` | 无（文本） | 常常看不到 | 是 | 是 |
| `enum` 常量 | `int` | 有名字有值 | 否 | 是 |
| `static const` | 有（可指定宽度） | 是 | 否 | 不是常量表达式（C 里！） |

关键差别在最后一列：**C 的 `const int n = 16;` 不是编译期常量**，不能拿来定义数组长度（那是 C++ 的行为，C 里只有 VLA 这条歧路）。要"编译期可用的整数常量"，用 `enum` 或 `#define`；要"带类型、只读、有地址"的常量，用 `static const`。

## 七、把布局钉死：`_Static_assert`

```c
struct hdr { uint8_t t; uint32_t v; };
_Static_assert(sizeof(struct hdr) == 8, "协议头必须是 8 字节");
_Static_assert(offsetof(struct hdr, v) == 4, "v 必须落在偏移 4");
```

断言成立时编译**完全静默**（`exit=0`，无输出）。改一个数字让它不成立：

```text
error: static assertion failed: "\37777777745\37777777615\37777777617\37777777750..."
```

**注意这个坑**：本机 GCC 13.1.0 会把诊断里的中文消息转义成八进制串，等于把你想给同事看的说明变成乱码。所以 `_Static_assert` 的**消息用英文写**，中文说明放在上面的注释里。这个细节不实测根本想不到。

`_Static_assert` 在 C11 起是关键字，C23 给了 `static_assert` 简写形式（在 C17 下要靠 `<assert.h>` 里的宏）。用它守护的东西值得列一列：协议结构体大小与字段偏移、枚举值的兼容性、数组长度与 `sizeof` 的一致性、跨平台类型宽度假设。

## 八、`inline` 到底内联了吗——用产物验证

```c
static inline int add2(int a, int b) { return a + b; }
int use(void) { return add2(1, 2); }
```

```text
-O2 下 inl.s 里 call 指令条数: 0
-O0 下 inl.s 里 call 指令条数: 1
```

`inline` 只是**建议**，真正决定是否内联的是优化器和优化级别。想知道有没有生效，别猜——`gcc -S -O2` 然后数 `call`。上一节讲过的 `static inline` 链接规则（C 里 `inline` 不产出外部符号）也是靠 `nm` 看符号表才看得明白的：

```text
                 U __imp___acrt_iob_func
                 U __main
                 U __mingw_vfprintf
0000000000000097 T main
0000000000000043 t printf
```

`T` = 已定义且外部可见，`t` = 已定义但局部（static），`U` = 未定义、等链接器解决。链接报 `undefined reference` 时，第一动作就是对每个 `.o` 跑一遍 `nm` 看谁该提供那个符号——这比瞎猜链接顺序快得多。

## 九、这一节的自查清单

- [ ] 宏参数和宏体**全部加括号**，多语句宏包 `do { } while (0)`
- [ ] 不把带副作用的表达式传给宏（`i++`、函数调用）
- [ ] 语言版本判断用 `__STDC_VERSION__`，不用编译器专有宏兜底
- [ ] 生产构建里不出现 `__DATE__` / `__TIME__`
- [ ] 每个条件编译分支都在 CI 里真的编译过一次
- [ ] 头文件有守卫，且里面只有声明、类型和 `static inline`
- [ ] 需要编译期常量用 `enum`/`#define`，别用 C 的 `const int`
- [ ] 关键内存布局用 `_Static_assert` 钉住，消息写英文
- [ ] 怀疑优化/内联/符号问题时，用 `-E`、`-S`、`-c`、`nm` 看中间产物，而不是猜

下一节进入指针与内存模型：指针算术的真实语义、`void *` 与类型擦除、多级指针与 `const` 的传递规则，以及函数指针表怎么写才不会踩到调用约定。
