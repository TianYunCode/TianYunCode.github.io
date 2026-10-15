---
title: 未定义行为与严格别名
description: 同一份代码在 -O0 给出 2、-O2 给出 1——严格别名规则怎么让编译器生成"错"代码，以及有符号溢出和判空被删背后的同一套逻辑：编译器按假设优化，而不是按你的意图。
date: 2026-10-15
tags: [C语言, 未定义行为, 优化]
category: c-language
section: c-ub-aliasing
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**。本节的核心实验是**同一份源码在三个编译选项下给出不同结果**。

## 一、先分清三个词

| 术语 | 含义 | 例子 | 你能做什么 |
| --- | --- | --- | --- |
| **实现定义** implementation-defined | 标准给了候选，每个编译器选一个，**必须文档化** | `char` 有无符号、`sizeof(long)` | 查手册、写可移植代码绕开 |
| **未指定** unspecified | 标准让编译器随便选，几种都合法 | 实参求值顺序、`|` `&` 的操作数顺序 | 别依赖，怎么写都对 |
| **未定义** undefined（UB） | 标准**不再约束**程序行为 | 越界、有符号溢出、空指针解引用、严格别名违规 | 必须消除，不是"避开雷区" |

UB 最容易被误解的地方在于：它**不是"程序会崩"**，而是"**标准对这段代码没有任何承诺**"。崩是最便宜的结果——更常见的是编译器的优化器基于"这不可能发生"删掉你的分支，然后程序安静地给出错误答案。

## 二、严格别名：一次可复现的"编译器生成错代码"

C 规定：**通过某种类型的指针访问对象时，该对象的实际类型必须与之兼容**（几条例外见下）。优化器据此推断"写 `long` 不可能改变 `short` 的值"。

```c
int alias_pun(long *lp, short *sp) {
    *sp = 1;
    *lp = 2;
    return *sp;
}
int main(void) {
    long storage = 0;
    printf("%d\n", alias_pun(&storage, (short *)&storage));   /* 故意让它们指向同一块内存 */
}
```

本机三个编译选项的结果：

```text
gcc -O0                          → 2      （逐条执行，内存里确实是 2）
gcc -O2                          → 1      ← 编译器假设 *lp 动不了 *sp，直接返回旧值
gcc -O2 -fno-strict-aliasing     → 2      （关掉假设，回到"看起来正确"）
```

**这不是"未优化版本正确、优化版本错误"的 bug 报告，而是标准赋予的权利**：`alias_pun` 本身就是未定义行为，`-O0` 下给出 2 只是巧合。真实项目里这个模式很常见——把缓冲区强转成另一种结构体指针、`(short *)` 去读写 `int` 数组、网络包里套不同宽度的字段。

### 三条合法例外

1. **`char *` 可以别名任何对象**（这也是 `memcpy`、序列化代码合法的原因）：

   ```c
   int x = 5;
   char *cp = (char *)&x;
   ```

   ```text
   char* 可以合法别名任何对象：按字节读 int 5 = 05 00 00 00
   ```

2. **`signed`/`unsigned` 同宽度同对齐视为兼容类型**（`int` 与 `unsigned int` 可以互看）。
3. **访问对象的"有效类型"（effective type）时合法**：用联合体或 `memcpy` 得到的对象，其有效类型就是最后写入的那个。

### 正确的类型双关写法

```c
float bits_to_float(uint32_t u) { float f; memcpy(&f, &u, sizeof f); return f; }

union pun { uint32_t u; float f; };
union pun p; p.u = 0x40490FDBu;   /* 读 p.f 合法：C 明确允许读最后写入之外的成员（值实现定义） */
```

```text
memcpy 把 0x3F800000 解释成 float = 1.0
union 把 0x40490FDB 解释成 float = 3.14159
```

两种都合法且都能被优化成零开销（`memcpy` 固定长度会被编译成一条 `mov`）。**默认用 `memcpy`**：它最不容易出错，也不依赖编译器扩展。C23 还加了 `[[may_alias]]` 属性，但工具链支持还不普遍。

如果项目里到处是 `(short *)ptr` 这种代码，可以整体退到 `-fno-strict-aliasing`（代价是失去一部分优化）——但这是**权宜之计**，不是修复。

## 三、有符号溢出：编译器假设它不会发生

```c
int always_true(int x) { return x + 1 > x; }
printf("%d\n", always_true(INT_MAX));
```

```text
always_true(INT_MAX) = 1 ← 数学上 INT_MAX+1 会回绕，应为 0
```

三个优化级别都给出 1。因为 `INT_MAX + 1` 是 UB，优化器有权假设 `x + 1 > x` **恒成立**，于是整个表达式被折叠成常量 1。同理这些也会被"优化掉"：

```c
if (x + 1 < x) { /* 死代码，被删 */ }
int abs(int x) { return x < 0 ? -x : x; }   /* INT_MIN 时 -x 是 UB */
for (int i = 0; i >= 0; i++) { }            /* 优化器认为永不溢出 → 真无限循环 */
```

**尺寸计算、计数器、时间差值**是溢出最常见的三个现场。防线：所有可能增长的量用无符号（回绕有定义）或更宽类型，并在边界处显式判断；`-ftrapv` 能让运行时捕获，但有明显开销，只适合调试构建。

## 四、空指针：判空放在解引用之后就是死代码

```c
int deref_then_check(int *p) {
    int v = p[0];        /* 已经解引用：编译器假设 p 非空 */
    if (!p) return -1;   /* 于是这个分支"不可能"执行 */
    return v;
}
```

本机传 `NULL`：

```text
Segmentation fault    退出码 = 139
```

崩在 `p[0]`，`return -1` 那条保护路径根本没机会执行——而且在 `-O2` 下它可能已经被删掉了。**"先用了再判空"不是防御，是自欺。** 判空必须放在第一次解引用之前。

## 五、UB 的常见清单（以及本机能不能抓到）

| 类别 | 典型写法 | 本机 `-Wall -Wextra` |
| --- | --- | --- |
| 越界 | `a[2]` 访问 `int a[2]` | **部分**：常量下标能报（`-Warray-bounds`），经指针/变量算出的报不出 |
| 有符号溢出 | `INT_MAX + 1` | 常量折叠时报 `-Woverflow`，运行期报不出 |
| 修改次序 | `i = i++ + 1` | 报 `-Wsequence-point` |
| 返回栈地址 | `return &local;` | 报 `-Wreturn-local-addr` |
| 释放后使用 | `free(p); *p;` | 同函数内能报 `-Wuse-after-free` |
| 严格别名 | `(short *)&long_obj` | **不报**（这是最危险的一类） |
| 未初始化读 | `int x; return x;` | 报 `-Wuninitialized`（需 `-O`） |
| 空指针解引用 | `p->m` 且 p 为 NULL | 只在能静态证明时 |
| 位移越界 | `1 << 32`（int 是 32 位） | 报 `-Wshift-count-overflow` |
| 格式符不匹配 | `%d` 配 `long` | 报 `-Wformat` |

结论：**编译器能抓的是"它看得见的子集"**。上一节那个越界写的例子（`a[3]=1` 再读回）本机三个警告开关全部沉默，而另一个越界读的例子却报了——同一个开关，行为不一致。所以"编译没警告"从来不能当作"没有 UB"的证据。

## 六、没有 sanitizer 时怎么办

本机 MinGW 构建不带 sanitizer 运行时（前面量过：`cannot find -lasan`、`-lubsan`）。可行的组合拳：

1. **警告全开并升级为错误**：
   ```bash
   gcc -std=c17 -Wall -Wextra -Wpedantic -Wshadow -Wconversion \
       -Wstrict-prototypes -Werror=implicit-function-declaration \
       -Werror=return-local-addr -Werror=incompatible-pointer-types \
       -Werror=discarded-qualifiers -fsanitize=undefined   # 后一项换工具链才有效
   ```
   不必一次全上，但 `-Werror=` 精准点名这几类最划算。
2. **CI 里加一个 Linux/WSL 任务**，用 GCC/Clang 的 `-fsanitize=address,undefined` 跑测试集。UBSan 会直接指出"有符号溢出发生在 file.c:42"，这是本机做不到的。
3. **静态分析**：`-fanalyzer`（GCC 10+）、`clang --analyze`、cppcheck。本机 `-fanalyzer` 对越界沉默，说明它不是万能网。
4. **代码规范兜底**：禁止裸类型双关（一律 `memcpy`）、禁止返回局部地址、数组访问必须带长度断言（`assert(i < n)`）。

## 七、这一节的自查清单

- [ ] 不用 `(T *)` 强转来"重新解释"内存，改用 `memcpy` 或联合体
- [ ] 需要指针混用不同宽度的场景，加 `-fno-strict-aliasing` 前先确认哪些代码受影响
- [ ] 所有可能增长的算术用无符号或更宽类型，并在边界显式判断
- [ ] 判空在第一次解引用**之前**
- [ ] 一个表达式内不重复修改同一对象，不 `i = i++ + 1`
- [ ] 位移量小于左操作数宽度（`1 << 31` 给 `int` 是 UB，用 `1u << 31`）
- [ ] 数组访问前用 `assert` 写下不变式，调试构建里让它炸在原地
- [ ] 把"编译器没警告"从"没有 UB"的证据列表里划掉
- [ ] CI 里挂一个带 `-fsanitize=address,undefined` 的任务，别只靠本机工具链

下一节讲受限环境下的 C 与 `volatile`：为什么优化器会把你的忙等待循环整个删掉、`volatile` 到底保证什么（以及不保证什么）、栈水位怎么量、以及没有堆的时候怎么分配内存。
