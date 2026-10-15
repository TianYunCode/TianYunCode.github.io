---
title: 动态内存与对象生命周期
description: 栈、堆、静态区的真实地址分布，malloc 与 calloc 的差别值一次 memset，内存池比逐个分配快在哪，以及在没有 ASAN 的工具链上用一张账本抓泄漏。
date: 2026-10-15
tags: [C语言, 内存管理, 性能]
category: c-language
section: c-memory
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**，`-O2`。地址、耗时、倍数都是本机实测。

## 一、一个进程的内存是怎么分区的

把各类对象的地址打出来，布局一目了然：

```c
int global_int = 1;      /* .data */
int global_zero;         /* .bss  */
static int static_var;   /* .bss（=0 的静态变量不在 .data） */

int stack_var;                        /* 栈 */
int *heap_var = malloc(sizeof *heap_var);   /* 堆 */
```

```text
代码   main        00007ff716987bb0
.rodata 字面量     00007ff71698a03a
.data  已初始化全局 00007ff716989000
.bss   未初始化全局 00007ff71698d030
.bss   函数内 static 00007ff71698d034
堆     malloc      0000018d5dc32440
栈     局部变量     0000004ff05ff74c
堆与栈相差 1750 MB（堆在低地址、栈在高地址）
```

读这张表能得到五条实用结论：

1. **代码、只读数据、已初始化数据、BSS 挤在同一片高地址区**（`0x00007ff7...`），堆和栈各自在完全不同的地址段——跨区指针比较（`p < q`）结果没有意义，只有同一数组内部的指针比较才是标准规定的良定义行为。
2. **`static int x = 0` 落在 .bss 而不是 .data**（本机两个地址只差 4 字节，紧邻）。区别是文件里 .bss 不占实际字节，只记一个长度——所以一个 `static int table[1000000];` 不会让可执行文件变大 4MB。
3. **已初始化的全局在 .data，会让文件真实变大**；能推迟初始化的就别写 `= 0`。
4. 字符串字面量在 .rodata，与第一节"改字面量段错误"对应。
5. 堆与栈相距 1.7GB——**栈溢出不会"溢进"堆**，它撞到守护页直接崩。

### 栈的代价

第二节量过：一个只带 `int` 参数的递归函数，**每层约 64 字节**；本机 PE 头里 `SizeOfStackReserve = 0x200000`（2MB）。也就是说纯递归大约 3 万层见顶。嵌入式上栈常常只有 2–8KB，几百层就到头——**栈用量必须当成预算来算**，尤其是带大局部数组和递归的函数。

## 二、`malloc` / `calloc` / 未初始化的代价

```c
int *m = malloc(16 * sizeof *m);
int *c = calloc(16, sizeof *c);
```

```text
malloc 未初始化：16 个里有 16 个非 0
calloc 全 0：1
对齐：malloc % 16 = 0，calloc % 16 = 0
```

- `malloc` **不清零**，本机 16 个 int 全部是非 0 残留。任何"忘了初始化就用"的字段都是不可复现的 bug。
- `calloc(n, size)` 会清零，而且**能检测 `n * size` 溢出**（返回 NULL），`malloc(n * size)` 则可能先溢出成一个小值再分配成功——这是真实的漏洞模式。
- 两者都返回"适合任何基本类型"的对齐（本机 16 字节对齐），所以 `malloc` 的指针可以直接当 `double`/`long long` 用，不需要额外处理。要 SIMD 的 32/64 字节对齐才需要 `aligned_alloc`。

**什么时候该用 `calloc`**：结构体字段多、逻辑依赖"0 即空/假"（指针数组、哈希桶、位图）。什么时候 `malloc` + 手工初始化更好：大块内存且马上要全部写满——`calloc` 的清零是白付的一遍内存写。

## 三、free 之后发生了什么

```text
连续两次 malloc(1024)：0000018d5dc32440 与 0000018d5dc378e0，间隔 21584 字节
free 后再 malloc(1024) 拿回 0000018d5dc32440（与刚释放的是同一块：1）
```

两件事：

1. **相邻分配不等于相邻内存**。两次 1KB 分配之间隔了 21584 字节——分配器按段/池管理，还会插入自己的元数据。所以任何"假设堆上对象紧挨着"的代码（比如把两块 `malloc` 的区域当连续数组遍历）都是错的。
2. **`free` 只是把块交回分配器的空闲链表**，不擦除内容、通常也不立刻归还操作系统。紧接着的同尺寸 `malloc` 大概率拿回同一块地址——这就是第六节里 UAF "读得到旧数据"的原因，也是敏感数据必须自己 `memset_s`/`explicit_bzero` 清零的原因（`free` 不会帮你擦）。

## 四、内存池：什么时候值得做

一个 20 行的**bump allocator**（只分配、不单独释放）：

```c
typedef struct { char *base; size_t used, cap; } pool;
static void *pool_alloc(pool *p, size_t n) {
    n = (n + 15) & ~(size_t)15;              /* 16 字节对齐 */
    if (p->used + n > p->cap) return NULL;
    void *r = p->base + p->used;
    p->used += n;
    return r;
}
```

本机 300 万次 64 字节分配 + 全部释放：

```text
逐个 malloc/free 3000000 次 64 字节：0.297 秒（malloc 0.170 + free 0.127）
内存池分配 3000000 次 + 一次释放：  0.002 秒
```

约 **150 倍**。差距来自通用分配器要做的额外工作：查找合适空闲块、写元数据、维护线程安全、处理合并与分裂；而池只是 `base + used` 一次加法。

代价也必须说清：

- **不能单独释放**，只能整池回收——适合"生命周期一致"的对象（一帧内的临时对象、一次请求内的节点、启动时创建的配置项）。
- 池大小要预估，超了就返回 NULL，得有兜底路径。
- 对象大小差异大时会有内部碎片，需要按大小分档（slab 思路）。

**先测量再优化**：通用 `malloc` 在现代平台上已经很快，绝大多数程序的瓶颈不在这里。嵌入式上（`_sbrk` 裸分配、无锁可用）内存池的价值远大于桌面端。

## 五、没有 ASAN 时怎么抓泄漏

前面量过本机 MinGW 构建不带 `libasan`/`libubsan`。但泄漏这件事可以用 20 行代码自己查——**用宏把 `__FILE__`/`__LINE__` 塞进每一次分配**：

```c
typedef struct node { void *ptr; const char *file; int line; struct node *next; } node;
static node *ledger;

static void *track_malloc(size_t n, const char *file, int line) {
    void *p = malloc(n);
    if (p) { node *e = malloc(sizeof *e); e->ptr = p; e->file = file; e->line = line;
             e->next = ledger; ledger = e; }
    return p;
}
static void track_free(void *p) {
    for (node **pp = &ledger; *pp; pp = &(*pp)->next)
        if ((*pp)->ptr == p) { node *d = *pp; *pp = d->next; free(d); free(p); return; }
    free(p);
}
#define MY_MALLOC(n) track_malloc((n), __FILE__, __LINE__)
```

分配两次、只释放一次，程序退出前打印账本：

```text
分配 2 次、释放 1 次，账本剩余：
  未释放：0000018d5dc378e0 来自 probeE.c:111
```

**直接指出是哪一行漏的。** 这套东西的局限也很明确：线性查找（分配多时慢）、只覆盖打了桩的分配、多线程要加锁。真要系统化解决，还是上带 sanitizer 的工具链或 Valgrind；但在不能换工具链的项目里（尤其嵌入式），一张账本 + 一个退出钩子就能覆盖 80% 的泄漏排查。

## 六、生命周期：C 只有三种"活法"

| 存储期 | 怎么申请 | 何时销毁 | 典型错误 |
| --- | --- | --- | --- |
| 自动（automatic） | 局部变量、VLA | 离开作用域 | 返回其地址；保存指针到别处 |
| 静态（static） | 全局/`static`、`thread_local` | 程序结束 | 多线程无同步地写 |
| 分配（allocated） | `malloc`/`calloc`/`realloc` | 显式 `free` | 忘记 free（泄漏）、free 后用（UAF）、free 两次 |

三条最常见的事故，前面的节里都实测过：

```c
int *bad(void) { int x = 42; return &x; }        /* 自动存储期逃逸 → 本机段错误 139 */
int *p = malloc(16); free(p); use(p);            /* 分配期已结束仍使用 → UAF */
free(p); free(p);                                /* 双释放 → 破坏分配器元数据 */
```

对应的工程习惯只有三条，但每条都要靠纪律维持：

1. **谁申请谁负责，所有权要能一句话说清**。函数接收指针时用注释或命名约定标明"借用的"还是"接管了"（`x_take` / `x_ref` 这类后缀就是干这个的）。
2. **`free(p)` 后紧跟 `p = NULL`**。悬空指针被置空后，误用会立刻崩在原地，比"读到旧数据"好排查十倍；而且 `free(NULL)` 是合法的，重复释放被自然吸收。
3. **出口统一释放**（第二节讲的 `goto cleanup`），别让 `free` 散落在各个分支里。

## 七、这一节的自查清单

- [ ] 不假设堆上对象相邻，不跨区比较指针
- [ ] 依赖"0 即空"的结构体用 `calloc`，其余用 `malloc` + 显式初始化
- [ ] 尺寸计算用 `calloc(n, size)` 或先判溢出，绝不写 `malloc(n * sizeof)` 而不检查 `n`
- [ ] 需要超 16 字节对齐时用 `aligned_alloc`，别自己偏移
- [ ] 敏感数据在 `free` 前手工清零（`free` 不擦内容）
- [ ] `free(p); p = NULL;` 写成一条肌肉记忆
- [ ] 生命周期一致的大量小对象，考虑内存池，但先测再说
- [ ] 没有 sanitizer 时，给分配打桩记 `__FILE__`/`__LINE__` 做账本
- [ ] 栈用量按"每帧字节 × 最深层数"估算，嵌入式尤其要算
- [ ] 每个 `malloc` 都能在同一个函数（或明确的拥有者）里找到对应的 `free`

下一节讲文件与流式 IO：文本模式与二进制模式的差异为什么在 Windows 上会咬人、缓冲与 `fflush`/`setvbuf` 的真实语义，以及行读取的正确写法。
