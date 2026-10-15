---
title: 受限环境与 volatile
description: volatile 到底保证什么——两条反汇编指令说清；忙等待为什么会被整个删掉、没有堆怎么分配内存、栈预算怎么量，以及 -Os 比 -O2 小在哪。
date: 2026-10-15
tags: [C语言, 嵌入式, volatile]
category: c-language
section: c-restricted-env
---

> 环境同前：Windows 11 x64，MinGW-w64 **GCC 13.1.0**。本节的两条反汇编和三项计时都是本机实测。

## 一、`volatile` 的准确定义：每次访问都必须发生

`volatile` 只承诺一件事：**不优化掉对该对象的访问**。它不保证原子性、不保证内存序、不保证可见性顺序。

### 证据一：两条反汇编

```c
uint8_t mmio_plain(uint8_t *p)        { return *p + *p; }
uint8_t mmio_vol(volatile uint8_t *r) { return *r + *r; }
```

`gcc -O2 -c` 后 `objdump -d`：

```asm
mmio_plain:
  50:  movzbl (%rdx),%eax     ← 只读一次
  53:  add    %eax,%eax
  55:  ret

mmio_vol:
  60:  movzbl (%rcx),%eax     ← 读两次
  63:  movzbl (%rcx),%edx
  66:  add    %edx,%eax
  68:  ret
```

普通指针：编译器认为两次读之间内存不会变，于是读一次、自己乘二。`volatile` 指针：**必须生成两条真实的读指令**。对内存映射外设（读一次就改变状态的寄存器、FIFO、清零中断标志），这个差别就是"能用"和"永远读错"。

### 证据二：忙等待会被删掉

```c
for (int i = 0; i < 20000000; i++) { }             /* 空循环 */
for (volatile int i = 0; i < 20000000; i++) { }    /* 每次 i 的读写都必须发生 */
```

```text
普通计数循环 2000 万次：0.000000 秒（被优化掉）
volatile 计数循环：0.007000 秒
```

普通版本在 `-O2` 下**整条循环消失**（副作用为零，标准允许删除）。写延时循环时忘了 `volatile`，得到的是一个空函数——这类"上板才发现延时不生效"的 bug 在嵌入式里非常常见。

### 该加 `volatile` 的三类对象

1. **内存映射寄存器**（MMIO）。
2. **信号处理函数里设置的标志**（标准明确要求这类变量是 `volatile sig_atomic_t`）。
3. **多线程共享的标志位**——注意：`volatile` **不能替代原子操作和锁**，它只保证"每次都真的读写"，不保证顺序与原子性。真正的并发要用 C11 `<stdatomic.h>`（下一节并发专栏细讲）。

不该滥用 `volatile` 的地方：普通局部变量、性能敏感的循环计数、以及"我以为它能防优化所以到处加"。

`const volatile` 是合法组合：外部可改（volatile）、本函数不许改（const），只读寄存器的标准写法。

## 二、栈预算：先量再改

递归 200 层、每层一个 `char buf[64]`，记录起始与最深栈指针：

```c
static uintptr_t sp_start, sp_lowest;
static uintptr_t current_sp(void) { volatile char slot; return (uintptr_t)&slot; }
static void deep(int n) {
    volatile char buf[64];
    uintptr_t sp = current_sp();
    if (sp < sp_lowest) sp_lowest = sp;
    if (n > 0) deep(n - 1);
}
```

```text
起始栈指针 0000000d047ff8cf，最深 0000000d047fb5bd
⇒ 递归 200 层实际占 17170 字节，每层约 85 字节
```

**每层 85 字节，而缓冲区只有 64**——多出来的 21 字节是返回地址、保存的寄存器和对齐。桌面上 2MB 栈无所谓，但 Cortex-M 常见的 2KB 任务栈只够 **24 层**。

三种量法，从粗到细：

1. **静态估**：看编译器的 `-fstack-usage`（GCC 会为每个函数生成 `.su` 文件，列出帧大小），递归取累加上界。
2. **动态量**：像上面这样记录最深栈指针，或用**高水位线**——启动时把栈区填成 `0xA5`，运行一段时间后扫描第一个非 `0xA5` 的位置，就是历史最大用量（FreeRTOS 的 `uxTaskGetStackHighWaterMark` 就是这个原理）。
3. **保护页**：栈底放一块不可写内存（MPU 区域），越界立刻异常，比"跑着跑着数据错"好查一万倍。

## 三、没有堆的时候：arena 与静态池

嵌入式常关掉 malloc（`--disable-newlib-supplied-syscalls`、或干脆没有 MMU/没有 `sbrk`）。替代方案是一个**单调递增的 arena**：

```c
typedef struct { uint8_t *base; size_t cap, used, peak; } arena;
static void *arena_alloc(arena *a, size_t n) {
    n = (n + 7u) & ~7u;                      /* 8 字节对齐 */
    if (a->used + n > a->cap) return NULL;
    void *p = a->base + a->used;
    a->used += n;
    if (a->used > a->peak) a->peak = a->used; /* 记录高水位 */
    return p;
}
```

```text
分配 100/33/4096 字节：第三个 返回 NULL，容量不足（8 字节对齐后 used=144 peak=144）
p1 与 p2 地址差 104 字节
```

`100 → 104`（对齐到 8），再加 `33 → 40`，`used = 144`；要 4096 时超出 4096 的容量（剩余 3952）所以返回 NULL。**没有碎片、没有 free、O(1) 分配、峰值可测**——这是阶段式分配（一帧、一次任务、一次请求）最合适的模型。

三种常见策略与适用场景：

| 策略 | 释放 | 碎片 | 适用 |
| --- | --- | --- | --- |
| arena / bump | 只能整体重置 | 无 | 生命周期一致的一批对象 |
| 固定块池（slab） | 单个可释放 | 无（块等大） | 定长节点：报文、连接、任务 |
| 通用堆（`malloc`） | 任意 | 有 | 桌面/服务器，或确实需要不定长 |

**关键纪律**：arena 的容量要按最坏情况静态确定，并留 `peak` 高水位上报；固定块池要在初始化时把块全挂回空闲链表，运行期不再分配。

## 四、定点数：省 FPU，但位宽要预算

没有 FPU 的 MCU 上，`float` 乘法是软件模拟，几十到上百个周期。Q15 定点（1 符号位 + 15 小数位）用整数乘加移位就够了：

```c
static int16_t q15_mul(int16_t a, int16_t b) { return (int16_t)(((int32_t)a * b) >> 15); }
```

```text
0.75 * 0.5 → Q15 结果 0.3750，float 结果 0.3750
累加 1000 次 40：acc = -25536，期望 40000 → 溢出
```

第一行说明精度够用（0.375 两边一致）。第二行是定点的代价：**`int16_t` 最大 32767，累加 40000 直接回绕成 -25536**。用定点必须做位宽预算：

- 中间量一律升到更宽类型（`int32_t` 累加，最后再 `>> 15` 落回 `int16_t`）。
- 明确饱和还是回绕：饱和运算要手写判断（或用 `__SSAT` 之类的厂商 intrinsic）。
- 定标因子（Q15/Q31）写进类型名或注释，绝不让两种定标的数据混在一起乘。

## 五、体积：`-Os` 常常真的比 `-O2` 小

同一份源码编译成目标文件后，把可分配段加起来：

```text
-O0  可分配段合计 416 字节
-Os  可分配段合计 240 字节
-O2  可分配段合计 288 字节
-O3  可分配段合计 288 字节
```

`-Os` 比 `-O2` 小 17%（Flash 紧张时是实打实的收益），而 `-O3` 相对 `-O2` 只有内联和向量化的取舍、这份代码里没变大。经验规则：

- **Flash 紧、速度够**：`-Os`（或 ARM 上的 `-Oz`/`-O s` 系列）。
- **热点函数要快**：整体 `-Os`，个别函数标 `__attribute__((optimize("O3")))` 或单独文件开 `-O2`。
- **调试期**：`-Og`（GCC 专为"保留可调试性的优化"设计），比 `-O0` 快且变量不会被优化没。
- 别忘了 `-ffunction-sections -fdata-sections` + 链接期 `--gc-sections`，未引用的函数会被整体丢掉，这往往比换优化级别省得更多。
- 关掉不需要的库特性（newlib 的 `--specs=nano.specs`、`-fno-asynchronous-unwind-tables`）通常比调优化更见效。

## 六、MISRA 与"能被机器检查的规矩"

受限环境（车规、医疗、工业）通常要过 MISRA C。不必背规则号，抓这几类高频项：

- **禁止隐式窄化**：赋值和传参时不隐式丢位（`-Wconversion`/`-Wsign-conversion` 就是它的机器版；本机 `-Wall -Wextra` 实测能报出 `unsigned conversion from 'int' to 'unsigned char:3' changes value from '9' to '1' [-Woverflow]`）。
- **每个 `switch` 必须有 `default`，每个分支必须显式结束**。
- **禁止递归与动态内存**（栈深度不可静态确定）。
- **循环边界必须可证明终止**，禁止 `while(1)` 里没有明确出口。
- **类型显式**：用 `uint32_t` 而不是 `unsigned long`（LLP64/LP64 宽度不同，见第一节专栏）。
- **位运算与逻辑运算不混在一个表达式**，全部加括号。

把能自动化的一部分交给编译器开关，比指望评审有效：

```bash
-Wall -Wextra -Wconversion -Wsign-conversion -Wshadow -Wundef \
-Wstrict-prototypes -Wmissing-prototypes -Wold-style-definition \
-Wpointer-arith -Wcast-qual -Wwrite-strings -Wvla -Wframe-larger-than=256
```

`-Wvla` 禁变长数组（栈不可预测），`-Wframe-larger-than=256` 直接给每个超过 256 字节的栈帧报警——这两条在嵌入式项目里几乎可以直接 `-Werror`。

## 七、这一节的自查清单

- [ ] MMIO 寄存器指针类型带 `volatile`，读次数用反汇编核对过
- [ ] 延时/忙等循环里的变量是 `volatile`，并确认它没被优化掉
- [ ] 不用 `volatile` 当同步手段，跨线程用 `_Atomic` 或锁
- [ ] 每个任务的栈用量实测过高水位，递归有深度上限
- [ ] 关掉堆或改用 arena/slab，容量按最坏情况静态确定并上报 peak
- [ ] 定点运算的中间量升宽、饱和策略明确、定标写在名字里
- [ ] 体积敏感模块用 `-Os` + `--gc-sections`，热点函数单独提级
- [ ] 调试构建用 `-Og`，别用 `-O0` 之后又抱怨"太慢不像发布版"
- [ ] 编译器警告按上面那套开，能 `-Werror` 的都 `-Werror`
- [ ] 关键假设（寄存器位段、结构体布局、栈余量）用 `_Static_assert` 钉住

**C 语言专栏到此完结（12 节）。** 下一大类是 C++：从"从 C 到 C++ 的引用、const 与重载"开始，重点放在 C++ 独有的语义差异（字符常量类型、`const` 链接性、`inline` 规则、`new` 与析构顺序），同样每个结论都实测。
