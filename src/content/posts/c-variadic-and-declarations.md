---
title: 可变参数与复杂声明
description: stdarg 的三条硬规则（类型靠约定、float 必按 double 读、va_copy 才能遍历两遍），复杂声明的读法口诀，以及 _Generic 为什么匹配不到 const char * 分支。
date: 2026-10-15
tags: [C语言, stdarg, 声明]
category: c-language
section: c-decl-variadic
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**。`_Generic` 那条"匹配不到 `const char *`"是本机实测出来的意外。

## 一、可变参数：编译器完全不参与类型检查

`printf` 那类函数的机制只有四个动作：

```c
static int sum_all(int count, ...) {
    va_list ap;
    va_start(ap, count);                 /* count 是最后一个具名参数 */
    int total = 0;
    for (int i = 0; i < count; i++) total += va_arg(ap, int);
    va_end(ap);
    return total;
}
```

```text
sum_all(4, 1,2,3,4) = 10
sizeof(va_list)=8
```

关键事实：**被传进来的参数的类型信息根本不存在于调用现场**。`va_arg(ap, T)` 只是"按 T 的大小和对齐从当前位置取一块内存"。取错类型不会报错，只会读到垃圾：

```text
传 int(42) 用 va_arg(int) 读 long：42（类型不匹配，读到的是未定义内容）
传 double(3.5) 用 va_arg(int) 读：0（同样未定义）
```

第一条尤其危险——**它"读对了"**。x86-64 上整数参数走寄存器，低 32 位恰好是 42，于是这个 bug 能在测试里存活几个月。类型不匹配是未定义行为，"这次对了"没有任何意义。

### 规则一：`float` 一律按 `double` 读

可变参数实参要经过**默认参数提升**：`float` → `double`，比 `int` 窄的整型 → `int`，数组/函数 → 指针。所以：

```text
传 float(3.5f) 用 va_arg(double) 读：3.5 ← 默认参数提升后必须按 double 读
```

写 `va_arg(ap, float)` 是错的，无论传的是 `float` 还是 `double`。

### 规则二：怎么知道参数结束

三种办法，可靠性递增：

| 方式 | 例子 | 风险 |
| --- | --- | --- |
| 靠**个数**参数 | `sum_all(4, ...)`、`memcpy` 风格 | 最安全，个数与被读次数必须一致 |
| 靠**格式串** | `printf(fmt, ...)` | 格式串来自外部输入时是漏洞（`printf(user_input)` = 任意内存读写） |
| 靠**哨兵值** | `execl(path, ARGV0, ..., (char*)NULL)` | 忘记写哨兵就一直读下去 |

**绝不要把用户输入直接当格式串传给 `printf`**，那是经典的格式化字符串漏洞。

### 规则三：同一个 `va_list` 走两遍必须 `va_copy`

`va_list` 可能是个结构体、可能指向栈帧、在某些平台上移动它就改变自身状态。要重复遍历必须复制：

```c
va_list ap, copy;
va_start(ap, count);
va_copy(copy, ap);
/* 用 ap 走一遍，用 copy 再走一遍 */
va_end(ap);
va_end(copy);        /* 每个 va_start/va_copy 都要配对 va_end */
```

```text
va_copy 两遍计数 = 303（前两位是第一遍，后两位是第二遍）
```

两遍都数到 3 个参数。少了 `va_copy` 而直接复用 `ap`，在某些平台上第二遍会读到 0 或崩溃。

### 转发给 `v` 系列函数

自己写的日志/格式化函数应该转交给标准库的 `v*` 版本，而不是自己解析：

```c
static void log_line(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}
```

```text
转发给 vfprintf: answer=42
```

对应关系：`printf`→`vprintf`、`fprintf`→`vfprintf`、`sprintf`→`vsprintf`、`snprintf`→`vsnprintf`（**优先用最后这个**，理由见第七节）。

零个可变参数是允许的：

```text
零个可变参数 sum(0) = 1000
```

## 二、复杂声明：从标识符往外读

先看实测的各类型大小：

```c
int   a[5];              /* 数组 */
int  *pa[5];             /* 指针数组：5 个 int* */
int (*parr)[5];          /* 数组指针：指向一个 int[5] */
int (*fp)(int, int);     /* 函数指针 */
int *(*fpv)(int);        /* 返回 int* 的函数指针 */
```

```text
int[5]=20  int*[5]=40  int(*)[5]=8  int(*)(int,int)=8  int*(*)(int)=8
```

`int *pa[5]` 是 40 字节（5 个指针），`int (*parr)[5]` 是 8 字节（一个指针）——**括号决定一切**。

读法口诀：**从标识符开始，先读右边再读左边，遇到括号折返。**

| 声明 | 逐段读 | 含义 |
| --- | --- | --- |
| `int *p[5]` | p 是数组[5] → 元素是 `int*` | 指针数组 |
| `int (*p)[5]` | p 是 `(...)` → 指针 → 指向 `int[5]` | 数组指针 |
| `int (*p)(int,int)` | p 是指针 → 指向函数(int,int) → 返回 int | 函数指针 |
| `int *p(int,int)` | p 是函数(int,int) → 返回 `int*` | 返回指针的函数 |
| `int (*p[3])(int)` | p 是数组[3] → 元素是指针 → 指向函数(int) | 函数指针数组 |
| `char **p` | p 是指针 → 指向 `char*` → 指向 char | 二级指针 |

写复杂声明时用 `typedef` 拆层，可读性立刻不同：

```c
typedef int (*op2)(int, int);
op2 table[2] = { add, sub };        /* 而不是 int (*table[2])(int,int); */
```

```text
函数指针数组 table[2] 与 table[1]：13 7，sizeof=16
```

`table[0](10,3)` = 13（add），`table[1](10,3)` = 7（sub）——`op2` 一行就把跳转表写清楚了。

## 三、位域之外的"变长结构"：柔性数组的正确封装

第四节讲过 `struct { size_t len; unsigned char body[]; }`。这里给一个可直接抄的封装：

```c
typedef struct { msg_kind kind; size_t len; unsigned char body[]; } msg;

static msg *msg_new(msg_kind kind, const void *data, size_t len) {
    msg *m = malloc(offsetof(msg, body) + len);      /* 用 offsetof，别用 sizeof */
    if (!m) return NULL;
    m->kind = kind;
    m->len = len;
    memcpy(m->body, data, len);
    return m;
}
```

```text
sizeof(msg)=16，实际分配 22 字节，body 偏移 16，内容 1 3 6
```

要点：`sizeof(msg)` 是 16（**不含**柔性数组），分配大小必须用 `offsetof(msg, body) + len`；一次分配、一次 `free`；`m->body` 与 `m` 之间没有任何指针跳转，缓存友好。协议帧、消息队列、变长记录都用这个模式。

## 四、`_Generic`：编译期的"按类型分派"

C11 引入的 `_Generic` 让你写一个宏，按实参的**类型**选择展开成哪个表达式：

```c
#define TO_STR(x) _Generic((x), \
    int: "%d", double: "%f", const char *: "%s", default: "%p")

printf("%s %s %s\n", TO_STR(5), TO_STR(2.5), TO_STR("x"));
```

```text
TO_STR(5)=%d TO_STR(2.5)=%f TO_STR("x")=%p
```

**注意最后一项**：`"x"` 本该匹配 `const char *` 分支，结果落到了 `default`。原因是 `_Generic` 按**精确类型**匹配：字符串字面量 `"x"` 的类型是 `char[2]`，在 `_Generic` 的控制表达式里退化（decay）为 **`char *`**，而 `char *` 和 `const char *` 是两个不同的类型，不算匹配。

修正方法是把两种都列出来：

```c
#define TO_STR(x) _Generic((x), \
    int: "%d", double: "%f", \
    char *: "%s", const char *: "%s", \
    default: "%p")
```

这条规则适用于所有 `_Generic` 用法：**数组类型会先退化，`const`/`volatile` 限定符不忽略**。它是 C 里最接近"重载"的机制，常用来给 `assert`/数学库做 `float`/`double`/`long double` 分流（标准库的 `tgmath.h` 就是这么实现的）。

## 五、这一节的自查清单

- [ ] 可变参数优先用"个数参数"，其次哨兵，绝不把外部输入当格式串
- [ ] `va_arg` 读 `float` 位置的实参一律写 `double`
- [ ] 窄类型（`char`/`short`）实参一律按 `int` 读
- [ ] 需要二次遍历就 `va_copy`，且每个 `va_start`/`va_copy` 都配 `va_end`
- [ ] 自定义格式化函数转发给 `vsnprintf`，不自己解析
- [ ] 复杂声明用 `typedef` 拆层，函数指针表用 `typedef` 命名
- [ ] 变长结构用柔性数组 + `offsetof(...) + len` 分配
- [ ] `_Generic` 的分支同时列出 `T*` 与 `const T*`，别指望限定符被忽略
- [ ] 类型不匹配的 `va_arg` "读对了"不算对，那是 UB

下一节进入 C 专栏的高级部分：未定义行为与严格别名——为什么 `*(int*)&float_var` 会让编译器生成错误代码，以及 `-fstrict-aliasing` 到底在假设什么。
