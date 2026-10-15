---
title: 标准库常用设施
description: string.h 的长度语义、memcpy 与 memmove 在重叠时的真实差异、atoi 与 strtol 的分水岭、errno 什么时候能读，以及 RAND_MAX 只有 32767 这件事。
date: 2026-10-15
tags: [C语言, 标准库, 字符串]
category: c-language
section: c-stdlib
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**。本节包含一个 `-O2` 下 `memcpy` 与 `memmove` 结果真实不同的实测。

## 一、`string.h`：长度语义各不相同

### 拷贝类

```c
char buf[16];
strcpy(buf, "0123456789");
```

```text
strcpy 后 strlen=10 sizeof(buf)=16
```

`strcpy` 完全不看目标多大，源串多长就写多长（含 `\0`）。它的"安全版"`strncpy` 语义反而更别扭：

```c
char dst[8];
strncpy(dst, "1234567890", sizeof dst);
```

```text
strncpy 截断后 dst = [12345678] 最后一字节 = 56（'8'）→ 没有 \0
```

- 源串 ≥ n 时**不补 `\0`**（上一节实测过）；
- 源串 < n 时把剩余空间**全部填 0**，大缓冲区上是白白的开销；
- 编译器会警告：`[-Wstringop-truncation]`。

**统一改用 `snprintf`**：它保证截断安全且一定留 `\0`，返回值还能判断是否被截断：

```c
int need = snprintf(dst, sizeof dst, "%s", src);
if (need >= (int)sizeof dst) { /* 被截断了 */ }
```

### 追加类：`strncat` 的数字含义和你想的不一样

```c
char d2[8] = "ab";
strncat(d2, "XYZWVU", 4);
```

```text
strncat 第 3 个参数是"最多追加几个字符"而不是缓冲区大小，还会补 \0：d2=[abXYZW] 长度 6 占 7 字节
```

`strncat` 的 `n` 是**追加字符数**，而它还会再写一个 `\0`，所以实际最多写 `n + 1` 字节，且起点是已有字符串的末尾。缓冲区剩余空间必须按 `剩余 >= n + 1` 来算，否则溢出。这是 `strncpy`/`strncat` 混用时最常见的 off-by-one。

### `memcpy` 与 `memmove`：重叠时真的不一样

标准说 `memcpy` 在区域重叠时行为未定义。很多人以为"反正实现都是逐字节拷，重叠也没事"。`-O2` 下 60 字节自移位实测：

```c
memcpy(b, big, 64);
memmove(b + 1, b, 60);      /* 或 memcpy(b + 1, b, 60) */
```

```text
原始序列: ABCDEFGHIJKL
memmove: AABCDEFGHIJK      ← 正确：整体右移一位
memcpy : AABCDDFGHHJK      ← 错乱：SIMD 前向拷贝把源数据覆盖了
```

`memmove` 会判断方向（必要时从后往前拷），`memcpy` 在 `-O2` 下用向量化前向拷贝，重叠区域读到的是**刚被自己写坏的数据**。规则很干脆：**源和目标可能重叠，就必须用 `memmove`**；确认不重叠才用 `memcpy`（性能略好，且向量化更充分）。

### 查找类返回的是指针，不是下标

```c
const char *hay = "path/to/file.c";
printf("%s\n", strchr(hay, '/') + 1);        /* to/file.c */
printf("%td\n", strstr(hay, "file") - hay);  /* 8 */
```

```text
strchr 返回指针：to/file.c；两次出现间隔 7 字节
strstr("file") 命中偏移 8
```

要下标就自己减：`p - hay`（单位是元素，`ptrdiff_t`）。`strchr` 找字符、`strrchr` 找最后一次、`strstr` 找子串、`strpbrk` 找"任一字符"、`strtok` 分词。注意 `strchr(s, c)` 传的 `c` 是 `int`，但**它匹配的是 `\0` 当 c 为 0 时的终止符**，这个特例常被用来定位结尾。

## 二、`stdlib.h`：`atoi` 是陷阱，`strtol` 才是工具

```c
printf("%d %d %d\n", atoi("abc"), atoi("12x"), atoi("99999999999999999999"));
```

```text
atoi("abc")=0 atoi("12x")=12 atoi("99999999999999999999")=1661992959 ← 无法区分错误与 0
```

三个结果暴露 `atoi` 的全部问题：**非法输入返回 0**（你分不清是"0"还是"垃圾"）、**尾部垃圾被静默忽略**、**溢出返回一个错得离谱的数**（`1661992959`），而且它**不设置 errno**。解析用户输入或协议字段时，这三条任意一条都能变成安全缺陷。

正确姿势是 `strtol` + `endptr` + `errno`：

```c
errno = 0;
char *end;
long v = strtol("  -42abc", &end, 10);
```

```text
strtol("  -42abc") = -42，end 指向 "abc"，errno=0
超范围：返回 2147483647，errno=34（ERANGE=34）→ 检出溢出
非数字：返回 0，end 未被推进（end==起点 ⇒ 1）errno=0
```

一个可用的解析函数要检查三件事：

```c
int parse_int(const char *s, int *out) {
    errno = 0;
    char *end;
    long v = strtol(s, &end, 10);
    if (end == s)      return -1;   /* 一个数字都没吃到 */
    if (*end != '\0')  return -2;   /* 尾部有非法字符 */
    if (errno == ERANGE) return -3; /* 溢出，v 被钳到 LONG_MAX/MIN */
    if (v < INT_MIN || v > INT_MAX) return -4;
    *out = (int)v;
    return 0;
}
```

注意**调用前必须 `errno = 0`**（见第四节），以及 `strtol` 溢出时返回的是钳位值而不是错误值。进制参数固定写 `10`，写 `0` 会让 `"010"` 变成 8——解析配置文件时这是个真实 bug 源。

### `sscanf` 的返回值是"成功转换的项数"

```c
int a = 0, b = 0;
int n = sscanf("7 8", "%d %d", &a, &b);
int m = sscanf("7",   "%d %d", &a, &b);
```

```text
sscanf 返回成功转换的项数 2，a=7 b=8
输入不足时返回 1（≠ 期望的 2）← 必须检查返回值
```

不检查返回值的 `sscanf` 会在输入不足时**留下未初始化的变量**继续用。`sscanf` 解析文本很顺手，但它对"整行必须完全匹配"没有表达能力，严格的协议解析还是手写状态机更可靠。

## 三、`rand()`：`RAND_MAX` 只有 32767

```text
RAND_MAX = 32767
srand(42) 两次取三个值：175 400 17869 / 175 400 17869 → 完全相同 1
rand() % 100 三个样本：75 0 69
```

三个结论：

1. **本机 `RAND_MAX` 是 32767（15 位）**，不是 21 亿。要 32 位随机数得拼两次；要密码学强度必须用平台 CSPRNG（Windows `BCryptGenRandom`、Linux `getrandom`），`rand()` 永远不行。
2. **同种子必然同序列**——这是特性不是 bug，测试里正好用它做可复现随机。
3. `rand() % N` 有**模偏差**（`RAND_MAX+1` 不是 `N` 的倍数时，小数字出现概率略高）。要均匀分布就用**拒绝采样**：先算出能被 `N` 整除的最大阈值，抽到超阈值的值就丢弃重抽。

## 四、`errno`：只能在失败之后读

```text
fopen 失败返回 0000000000000000，errno=22，strerror="Invalid argument"
成功调用不会清 errno（手动设 12345 后仍读到 12345）→ 只能在失败后看
```

标准规定：**库函数成功时不会把 errno 清零**（只有失败时才设）。所以 `printf("errno=%d\n", errno)` 这种"顺便看看"的写法读到的往往是上一次失败的残留值。正确模式固定三步：

```c
errno = 0;                      /* 1. 调用前清零 */
FILE *f = fopen(path, "rb");    /* 2. 用返回值判断成败 */
if (!f) {                       /* 3. 只有失败时才读 errno */
    fprintf(stderr, "打开失败: %s\n", strerror(errno));
}
```

两个补充：

- `strerror` 的返回值指向静态缓冲区，**多线程下不安全**（POSIX 有 `strerror_r`）。日志里直接用也行，但别跨线程传。
- 少数函数（如 `read`/`recv`）用 errno 区分"可重试"，`EINTR` 必须写重试循环，否则信号一来系统调用就"莫名失败"。

## 五、`ctype.h`：参数必须是 `unsigned char` 或 EOF

```text
isdigit('7')=1 isdigit(0x37)=1；但 isdigit(200) 传 int 越界是 UB（应先转 unsigned char）
```

`isalpha`/`isdigit` 这些函数的参数类型是 `int`，但合法取值只有 `unsigned char` 的 0–255 和 `EOF`。`char` 在本机是有符号的，`*p` 读到 0xC8 会传成 `-56`，越界索引查表 → UB（常见表现是崩溃）。**从 `char` 取值一律先转**：

```c
while (*p) { if (isdigit((unsigned char)*p)) count++; p++; }
```

另外这些函数的结果依赖 locale，`setlocale(LC_ALL, "")` 之后行为可能变。要 ASCII 语义就自己写 `(c >= '0' && c <= '9')`。

## 六、这一节的自查清单

- [ ] 全项目搜不到 `strcpy`/`strcat`/裸 `sprintf`，统一 `snprintf`
- [ ] 不依赖 `strncpy` 补终止符；用 `snprintf` 或手工 `memcpy` + 显式 `\0`
- [ ] 算 `strncat` 的剩余空间时按 `n + 1` 算
- [ ] 区域可能重叠就用 `memmove`
- [ ] 查找函数返回指针，转下标用减法，判空再用
- [ ] 数字解析一律 `strtol`/`strtod` + `endptr` + `errno`，进制写死 10
- [ ] `sscanf` 的返回值必须等于期望项数
- [ ] 随机数：可复现测试用 `srand`，生产用平台 CSPRNG，注意 `RAND_MAX` 只有 32767
- [ ] `errno` 只在函数明确失败后读，调用前置 0
- [ ] `ctype` 函数参数先转 `unsigned char`

下一节讲动态内存与对象生命周期：栈/堆/静态区各放什么、内存池什么时候值得做、碎片是怎么形成的，以及怎么用 `-fsanitize=address` 之外的手段在没有 sanitizer 的工具链上定位泄漏。
