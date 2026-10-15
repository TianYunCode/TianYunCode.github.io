---
title: 结构体、联合体与枚举
description: sizeof 为什么比你算的大、字段顺序值几字节、填充字节怎么让 memcmp 骗过你、位域和联合体的实现定义边界，以及柔性数组的正确用法。
date: 2026-10-15
tags: [C语言, 结构体, 内存布局]
category: c-language
section: c-struct-union
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**，`-std=c17 -Wall -Wextra -O0`。所有 `sizeof`、`offsetof` 和字节序列都是实测。

## 一、对齐：`sizeof` 为什么比你算的大

```c
struct bad  { char c; int i; char d; };   /* 1 + 4 + 1 = 6？ */
struct good { int  i; char c; char d; };  /* 4 + 1 + 1 = 6？ */
```

```text
struct bad  {char;int;char} sizeof=12 offsetof(c)=0 i=4 d=8
struct good {int;char;char} sizeof=8  offsetof(i)=0 c=4 d=5
```

两个都"应该是 6 字节"，实测一个是 12、一个是 8。规则是：

1. **每个成员有一个天然对齐要求**（基本类型通常是它自己的大小：`int` 要 4 字节对齐，`double` 要 8）。成员起始偏移必须是它的倍数，不够就插填充字节。
2. **整个结构体的大小必须是"最宽成员对齐值"的倍数**，所以尾部也可能补。

`struct bad` 的推导：`c` 在 0，`i` 必须落在 4 的倍数 → 跳过 1..3 三个填充字节；`d` 在 8；末尾 `9..11` 再补 3 字节让总长成为 4 的倍数 → **12**。把字段按宽度降序排成 `struct good`，就只剩尾部 2 字节填充 → **8**。

**字段顺序能省 33% 的空间**，还会影响缓存命中。协议结构体、要写盘的记录、数组元素很多时，这一条必须算。

### 强制紧凑：packed 的代价

```c
struct packed_1 { char c; int i; char d; } __attribute__((packed));
```

```text
packed 版同样字段 sizeof=6 offsetof(i)=1
```

`i` 现在落在偏移 1——**非 4 倍数**。代价是：x86 上未对齐访问只是慢一点，ARM/Cortex-M 上未对齐访问可能直接触发硬件异常。而且 `packed` 成员的地址不能安全地取出来当 `int *` 用（`&p->i` 是未对齐指针）。跨平台代码里更稳的做法是**手工按字节序列化**，而不是靠 `packed`。

## 二、填充字节是垃圾值：`memcmp` 比较结构体会骗你

结构体不是"字段的集合"，它是**一段内存**，而填充字节不属于任何字段，标准不要求初始化器把它们清零。实测：

```c
struct bad x; x.c = 1; x.i = 2; x.d = 3;      /* 不 memset，填充是栈上残留 */
struct bad y = {1, 2, 3};
printf("%d\n", memcmp(&x, &y, sizeof x));
```

```text
字段全相等，memcmp(&x,&y)=1
逐字节：x = 01 01 00 00 02 00 00 00 03 7f 00 00
        y = 01 00 00 00 02 00 00 00 03 23 ea 6f
```

每个字段都相等，`memcmp` 却返回非 0——差异全在填充位（`x` 的 1..3 是 `01 00 00`，`y` 是 `00 00 00`；尾部 9..11 两边都是垃圾）。这个 bug 在开发机上"偶尔对"，一旦你把结构体内存直接 `write()` 到文件或网络，还会**把栈上的残留字节泄漏出去**（这是真实的信息泄露漏洞类型）。

三条规矩：

- 比较结构体**逐字段比**，别用 `memcmp`。
- 要把结构体写进文件/网络，先 `memset(&x, 0, sizeof x)` 再赋字段，或者干脆手工序列化字段。
- 需要"清零"就用 `= {0}` 之后**再 memset 一次**，或者声明为 `static`（静态存储期保证全 0）。

顺带一个好消息：结构体可以整体赋值，是**逐字节复制**，包括填充：

```text
整体赋值后 memcmp = 0（同一份内存，含相同填充）
```

## 三、`offsetof`、匿名结构体与柔性数组

`offsetof(type, member)` 是 `stddef.h` 提供的编译期常量，用来验证布局：

```c
struct hdr { uint8_t t; uint32_t v; };
_Static_assert(offsetof(struct hdr, v) == 4, "v must be at 4");
```

### 匿名成员（C11）

```c
struct outer { int a; struct { int b; int c; }; } o = {1, {2, 3}};
printf("o.b=%d o.c=%d sizeof=%zu\n", o.b, o.c, sizeof o);
```

```text
可以省掉中间层直接访问：o.b=2 o.c=3，sizeof(outer)=12
```

省掉 `o.inner.b` 的中间层，但**布局不变**（`sizeof` 仍是 12，内部结构体的填充还在）。联合体同理，常用来给同一块内存起多个别名。

### 柔性数组成员（FAM）

```c
struct flex { size_t len; int data[]; };
printf("sizeof=%zu\n", sizeof(struct flex));
size_t need = offsetof(struct flex, data) + 4 * sizeof(int);
struct flex *f = malloc(need);
```

```text
sizeof(struct flex)=8（不含 data[]）
容纳 4 个 int 需要 malloc(24)
写入读回：0 1 4 9，f 与 f->data 地址差 8
```

要点：`sizeof` **不包含**柔性数组（是 8，不是 24）；分配时要自己按 `offsetof(...) + n * sizeof(元素)` 算；它必须是最后一个成员，且结构体不能只有它一个成员。相比 `int *data` 再单独 `malloc`，FAM 只要一次分配、一次释放，数据还连续——变长记录（网络包、消息队列条目）的标准写法。

## 四、位域：能省空间，但边界全是实现定义

```c
struct flags { unsigned a : 3; unsigned b : 5; signed c : 4; };
struct flags fl = {5, 30, -3};
struct overflow { unsigned a : 3; };
struct overflow ov = {9};
```

```text
struct flags sizeof=4（3+5+4=12 位，仍占 4 字节）
写入 a=5 b=30 c=-3 读回 a=5 b=30 c=-3
给 3 位域赋 9，读回 1（9%8=1，实现定义）
```

编译器还会为最后一条明确警告：

```text
warning: unsigned conversion from 'int' to 'unsigned char:3' changes value from '9' to '1' [-Woverflow]
```

位域的真实用途是**对齐硬件寄存器位段**，这时必须配合具体芯片文档。以下都**不由 C 标准规定**：位的分配方向（从低位还是高位开始）、跨存储单元如何排布、`signed` 位域的宽度语义。所以：**永远不要把位域结构体直接当二进制协议读写，也不要在乎它的 `sizeof`。** 手工用 `uint32_t` + 移位掩码才是可移植的做法。

## 五、联合体：同一块内存的多种解释

```c
union holder { uint32_t u; uint8_t b[4]; struct { uint8_t lo, m1, m2, hi; } f; };
printf("sizeof=%zu\n", sizeof(union holder));
union holder h; h.u = 0x01020304u;
printf("b[0]=%02x b[1]=%02x b[2]=%02x b[3]=%02x\n", h.b[0], h.b[1], h.b[2], h.b[3]);
```

```text
sizeof(union holder)=4（= 最大成员 4）
写 u=0x01020304 后按字节读：b[0]=04 b[1]=03 b[2]=02 b[3]=01
⇒ 本机小端（低位在低地址）；嵌套匿名结构体 f.lo=04 f.hi=01
```

三条规则：

1. `sizeof` 等于**最大成员**（可能再加对齐填充）。
2. **只有最后写入的那个成员是有效的读取对象**——读别的成员是"类型双关"，除了下面这一种情况都属于实现定义：

   ```text
   最后写入的成员才有效：读 b[0]=9 ⇒ u=9
   ```

3. 用来检查字节序（如上面 `04 03 02 01`）是合法且常见的用法；但**跨平台的字节序处理应该用显式的移位拼装**，而不是依赖联合体。

联合体在两个场景里确实是正解：**标签联合（tagged union）**——`struct { enum kind; union {...}; }`，标准明确允许读取与最后写入一致的成员；以及**手工对齐复用内存**（比如把 `double` 数组当 `uint64_t` 用）。

## 六、枚举在 C 里比想象中弱

```c
enum Color { RED, GREEN = 10, BLUE };
enum Color c2 = 42;
```

```text
sizeof(enum Color)=4  RED=0 GREEN=10 BLUE=11
把 42 赋给 enum Color，读回 42（C 不检查取值范围）
```

- 没写值就顺延：`RED=0`，显式写 `GREEN=10`，之后 `BLUE=11`。
- `sizeof(enum)` 是 `int` 大小（4），**不是**"能装下最大值的最小类型"。
- **C 的枚举不做取值检查**，`42` 照收。想要"只能传这三个值"的约束，C 里没有（C++ 的 `enum class` 才有）。
- 枚举常量可以当数组长度、可以参与编译期计算，这是它比 `#define` 好的地方：**有类型、调试器能看到名字**。

C23 引入了带基础类型的枚举和作用域枚举（`enum Color : uint8_t { ... }`、`enum { ... }` 带标签），但本机 GCC 13.1.0 的 `-std=c2x` 支持不完整，跨平台项目现在依赖它还不合适。

位标志要用**无符号整数 + 移位**，不要用枚举值当位号：

```c
enum { FLAG_READ = 1u << 0, FLAG_WRITE = 1u << 1, FLAG_EXEC = 1u << 2 };
#define HAS(f, bit)  (((f) & (bit)) != 0)
```

## 七、自引用与函数指针：结构体的两个必备件

```c
struct node { int v; struct node *next; };        /* 只能引用指针，不能内嵌自己 */
printf("sizeof(struct node)=%zu\n", sizeof(struct node));
```

```text
链表 n1->v=10 n1->next->v=20，sizeof(struct node)=16（int + 对齐 + 指针）
```

`struct node { struct node next; }` 是非法的——大小会无限递归；只有指针（大小固定，本机 8 字节）能自引用。`int v` 占 4、填 4、指针占 8 → 16。

结构体 + 函数指针 = C 的"虚表"，驱动框架、COM 风格的接口、状态机都靠它：

```c
struct device_ops {
    int  (*open)(void *self);
    int  (*read)(void *self, void *buf, size_t n);
    void (*close)(void *self);
};
```

第一个参数固定是 `void *self`，就是手工实现的 `this`。

## 八、这一节的自查清单

- [ ] 结构体字段按对齐宽度**从大到小**排，改完重新量 `sizeof`
- [ ] 比较结构体逐字段比，绝不用 `memcmp`
- [ ] 要写盘/发网络的结构体先 `memset` 清零，或改成手工序列化
- [ ] 用 `_Static_assert` + `offsetof` 把关键布局钉死，改坏了编译就报错
- [ ] 位域只用于对齐硬件寄存器，不当协议格式用
- [ ] 联合体只读"最后写入的成员"，字节序处理用显式移位
- [ ] 变长记录用柔性数组成员，一次分配一次释放
- [ ] 枚举不当位标志用，也不指望它检查取值

下一节讲预处理与编译四阶段：`#define` 的括号为什么能决定成败、`-E` 之后那 1000 多行从哪来、目标文件里的符号表怎么看，以及为什么"头文件重复包含"会报 `redefinition`。
