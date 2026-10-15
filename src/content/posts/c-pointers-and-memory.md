---
title: 指针与内存模型
description: 指针算术的真实语义、const 的传递规则为什么只给警告、减法比较器怎么把 qsort 排错、释放后读为什么不崩反而更危险，以及返回栈地址在本机如何当场段错误。
date: 2026-10-15
tags: [C语言, 指针, 内存管理]
category: c-language
section: c-pointer
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**，`-std=c17 -Wall -Wextra -O0`。本节所有输出（包括一次段错误）都是实测。

## 一、指针算术：步进由指向的类型决定

```c
char c[4]; int i[4]; double d[4];
printf("char* +1 = %td，int* +1 = %td，double* +1 = %td 字节\n",
       (char *)(c + 1) - (char *)c, (char *)(i + 1) - (char *)i, (char *)(d + 1) - (char *)d);
```

```text
步进：char* +1 = 1，int* +1 = 4，double* +1 = 8 字节
sizeof(int*)=8 sizeof(int)=4 sizeof(ptrdiff_t)=8
指针差值 i+3 - i = 3（单位是元素，不是字节）
```

`p + n` 加的不是 `n` 字节，而是 `n * sizeof(*p)` 字节。两个方向都要记住：

- **指针减指针**得到的是 `ptrdiff_t`（有符号，本机 8 字节），单位是**元素个数**，不是字节。
- 想要字节数就自己乘：`(char *)p2 - (char *)p1` 先转成 `char *` 再减，这是唯一可靠的算法。

下标运算符的定义就是 `a[i] ≡ *(a + i)`，而加法可交换，于是这个也成立：

```text
下标只是指针语法糖：i[2] == 2[i] == *(i+2)：0 0 0
```

`2[i]` 合法且等价，但除了让人看出你懂定义之外没有任何好处，别写。

## 二、越界读为什么不报错

```c
int i[4] = {0};
printf("%d\n", i[10]);
```

```text
越界读 i[10] 得到 1500584378（UB，本机是栈上残留）
```

`i[10]` 编译期不检查、运行期也不检查，地址算得出来就读。读到的是数组之后那 24 字节处的内容——这里是栈上的残留值。**它今天读到一个垃圾数，明天可能读到另一个变量的值，后天编译器改了栈布局就读到别的东西**。这类 bug 的破坏力来自它的"安静"：程序不崩，只是答案不对。

## 三、`const` 与指针：位置决定语义，违规只给警告

```c
const int *pc;    /* 指向 int 的指针，不能通过它改值 */
int *const cp;    /* 指针本身是常量，不能改指向，可以改值 */
const int *const p;
```

读法：**从右往左**读，第一个 `const` 修饰左边那个东西。`int *const` 是"常量指针"，`const int *` 是"指向常量的指针"。

隐式转换的方向是单向的：

```c
int v = 1; const int cv = 2;
const int *to_const = &v;   /* int* → const int*：允许 */
int *from_const = &cv;      /* const int* → int*：只给警告 */
```

```text
warning: initialization discards 'const' qualifier from pointer target type [-Wdiscarded-qualifiers]
```

**注意是 warning 不是 error**——代码照样编译，`const` 的承诺被静默丢弃。反过来，通过 `const` 指针写值才是真正的错误：

```text
error: assignment of read-only location '*q'
```

工程含义：`const` 在 C 里是**编译期的单向隐式转换 + 一条可被忽略的警告**。想让它真正有约束力，必须 `-Werror=discarded-qualifiers`。

## 四、函数指针：声明读法与跳转表

```c
int (*fp)(int, int);                      /* fp 是函数指针 */
int (*table[2])(const void *, const void *);  /* table 是"函数指针数组" */
```

```text
函数指针 sizeof=8，table[1] 与 table[0] 地址差 8
指针数组 sizeof=16；数组指针 sizeof=8
```

`int (*fp)(int, int)` 的括号**不能省**：`int *fp(int, int)` 声明的是"返回 `int *` 的函数"。同理 `sizeof` 那行：两个函数指针的数组是 16 字节，而"指向该数组的指针"是 8 字节。

复杂声明的通用读法：**从标识符开始，先读右边再读左边，遇到括号折返。**

- `int *(*f)(void)` → f 是函数指针，返回 `int *`
- `int (*a[5])(int)` → a 是 5 个函数指针的数组，每个接受 `int` 返回 `int`
- `void (**p)(void)` → p 是指向函数指针的指针

函数指针数组就是 C 的跳转表，状态机和驱动接口都建在它上面：

```c
struct device_ops {
    int  (*open)(void *self);
    int  (*read)(void *self, void *buf, size_t n);
    void (*close)(void *self);
};
```

写错函数指针类型，本机给的是警告而非错误：

```text
warning: initialization of 'int (*)(int, int)' from incompatible pointer type
         'int (*)(const void *, const void *)' [-Wincompatible-pointer-types]
```

然后调用时按错误的约定取参数——**这是最容易造成"崩溃在离病因很远的位置"的一类错误**。同样要靠 `-Werror=incompatible-pointer-types` 拦住。

## 五、`qsort` 与比较器：减法写法能把数组排错

`qsort` 的接口是 C 类型系统最弱的一面：`void *` + 函数指针 + 手工传元素大小，编译器无法检查比较器的类型。

```c
static int cmp_point_desc(const void *a, const void *b) {
    const struct point *pa = a, *pb = b;
    return (pb->x > pa->x) - (pb->x < pa->x);   /* 只返回 -1/0/1 */
}
qsort(pts, 4, sizeof pts[0], cmp_point_desc);
```

```text
qsort 降序：50 30 20 10
```

而流传很广的减法写法在边界值上会溢出：

```c
static int cmp_bad(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }
int big[3] = {2147483647, -2147483647 - 1, 0};
qsort(big, 3, sizeof big[0], cmp_bad);
```

```text
用 a-b 做比较器排 {2147483647, -2147483648, 0} → 0 2147483647 -2147483648 ← 溢出导致顺序错乱
```

`INT_MAX - INT_MIN` 超出 `int` 范围，是有符号溢出（UB），返回值符号翻转，比较器于是**不再传递有序**（`a<b` 且 `b<c` 却 `a>c`）。`qsort` 对这种不一致的比较器没有任何防御，结果不是崩溃而是**悄悄排错**。

更糟的是它还会污染下游：

```text
在未排序数组上 bsearch：找不到（前提被破坏）
```

`bsearch` 要求数组已按同一比较器升序排列，前一步排错，这里就查不到——一个 bug 变成两个现象。

**规矩：比较器只返回 `-1 / 0 / 1`**，用 `(x > y) - (x < y)`，绝不返回差值。浮点也一样（`NaN` 会让差值比较彻底失去意义）。

## 六、堆内存：分配、扩容与三种典型错误

```c
int *p = malloc(4 * sizeof *p);      /* 用 *p 而不是写死类型名 */
```

`sizeof *p` 的写法在改类型时不会失配——比 `malloc(4 * sizeof(int))` 稳。

### `malloc(0)` 返回什么

```text
malloc(0) 返回 00000209a7c42440（非 NULL，实现定义），free 后不再使用
```

标准允许返回 `NULL` 或一个"已分配但不可访问"的指针，本机是后者。所以**不要用 `malloc(0)` 的成功与否来判断逻辑**，长度为 0 就在调用前处理掉。

### `realloc` 必须先接住返回值

```c
int *q = realloc(p, 8 * sizeof *p);
if (q) p = q;                 /* 正确 */
```

写成 `p = realloc(p, n)` 时，一旦返回 `NULL`，原来的 `p` 就被覆盖丢失——**内存泄漏且无法释放**。这是 C 里最常见的 `realloc` 错误。

### 释放后读（UAF）：不崩才危险

```c
int *dangling = malloc(4 * sizeof *dangling);
free(dangling);
printf("%d\n", dangling[0]);
```

```text
释放后再读 dangling[0] = -1480300416 ← 不报错、不崩溃，只是本机运气好
```

释放后的内存大概率还在原地、还能读，只是内容已被分配器接管。这就是 UAF 成为头号安全漏洞成因的原因：**它通常不崩，读到的是"看起来像数据"的垃圾**，或者更糟——那块内存已经被重新分配给别人，你在读别人的对象。

好消息是编译器能抓一部分：

```text
warning: pointer 'dangling' used after 'free' [-Wuse-after-free]
note: call to 'free' here
```

GCC 13 在 `-Wall` 下就报出了这一处（同一函数内的直接用法）。但它只覆盖静态可判定的情形，跨函数、跨线程的 UAF 只能靠 sanitizer 或 ASAN 版工具链。

### 返回栈地址：本机直接段错误

```c
static int *bad_return(void) { int local = 42; return &local; }
int *d = bad_return();
printf("%d\n", *d);
```

编译时：

```text
warning: function returns address of local variable [-Wreturn-local-addr]
```

运行时，本机没有"侥幸读到 42"：

```text
Segmentation fault    退出码 = 139
```

函数返回后那块栈内存随时会被后续调用覆盖，本机 `printf` 自己就用掉了那段——直接踩到不可访问区域。**这条 `-Wreturn-local-addr` 必须当错误处理**，它是少数"编译器完全确定你错了"的情况之一。

## 七、这一节的自查清单

- [ ] 指针算术永远记得单位是元素；要字节数就转 `char *`
- [ ] 不越界读写；长度和指针成对传
- [ ] `const` 转换方向只允许"加 const"，并开 `-Werror=discarded-qualifiers`
- [ ] 函数指针类型逐字核对，开 `-Werror=incompatible-pointer-types`
- [ ] 比较器返回 `-1/0/1`，绝不返回差值
- [ ] `qsort` 之后如果要 `bsearch`，必须用同一个升序比较器
- [ ] `malloc(n * sizeof *p)`；`realloc` 用另一个指针接返回值
- [ ] `free(p)` 紧跟 `p = NULL`，避免双释放与 UAF
- [ ] 函数绝不返回局部变量地址（`-Werror=return-local-addr`）
- [ ] 释放后不再使用该指针，包括"只读一下看看"

下一节讲标准库常用设施：`string.h` 各函数的长度语义、`snprintf` 的返回值为什么是"本该写入的长度"、`strtok` 的线程安全问题，以及 `errno` 的正确读法。
