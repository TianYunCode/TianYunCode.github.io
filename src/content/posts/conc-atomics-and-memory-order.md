---
title: 原子操作与内存序
description: 实测：relaxed 内存序下 120 万轮里过半出现违例，seq_cst 两次都是 0；seq_cst 存比 relaxed 贵 22 倍，16 字节 atomic 不加 -latomic 直接链不过。
date: 2026-10-15
tags: [并发, 原子操作, 内存序]
category: concurrency
section: conc-atomics
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64）**，`g++ -std=c++17 -O2 -Wall -Wextra -static`，CPU 是 6 物理核 / 12 逻辑处理器的 i5-11400H。指令序列用 `objdump -d` 直接取，违例率是每个配置跑满 80–120 万轮统计的。**litmus 的结论只在这台机器上有"必然性"，换 ARM 会更严重，不是更轻。**

## 一、什么尺寸真的无锁

```text
  is_always_lock_free: char=1 short=1 int=1 long=1 long long=1 指针=1
  sizeof: atomic<int>=4  atomic<long long>=8  atomic<pointer>=8  atomic<double>=8  atomic<TwoInt>=8
  16 字节 atomic<TwoLL>：不加 -latomic 链不过（4 条 undefined reference）
```

1、2、4、8 字节全都无锁，`std::atomic` 不额外占空间（`sizeof(atomic<T>) == sizeof(T)`，两个 int 的结构体也是 8 字节）。

**16 字节是断崖。** 单独试一个 `std::atomic<struct{long long a,b;}>`：

```text
ld.exe: undefined reference to `__atomic_store_16'
ld.exe: undefined reference to `__atomic_load_16'
```

加上 `-latomic` 才链得过，但运行结果是：

```text
  always_lock_free=0  运行期 is_lock_free=0  sizeof=16  align=16
  store{1,2} 之后 load 回来 a=1 b=2
  CAS{1,2}->{7,8} 成功，现在 a=7 b=8
```

**功能对，但不是无锁**：libatomic 在这个尺寸上用一把自旋/细粒度锁模拟，`is_lock_free()` 诚实返回 0。x86-64 的 `cmpxchg16b` 能实现真 16 字节 CAS，但 GCC 的 libatomic 在这个构建里没有走那条路。**所以"想要原子的一对值"要么自己打包进一个 8 字节（比如 32+32 位、或者指针+版本号的两种做法压不进 64 位时改用索引），要么接受它其实是把锁。**

顺带一个尺寸陷阱：`sizeof(std::atomic<long long>[8]) = 64` —— 8 个原子量**紧挨着**，正好一个缓存行。下一节的伪共享就是这么造的。

## 二、内存序在这台机器上花多少钱

单线程、30 万次、3 轮取最小值：

```text
  store relaxed    0.26 ns
  store release    0.37 ns（x86 上与 relaxed 等价）
  store seq_cst    5.71 ns（要全屏障）
  relaxed+fence    6.83 ns
  add  relaxed     5.47 ns
  add  acquire     5.43 ns
  add  acq_rel     6.08 ns
  add  seq_cst     5.67 ns
  CAS  seq_cst     5.77 ns
```

再看编译出来的指令（`objdump -d` 原文，去掉地址列）：

```asm
store relaxed : mov    %rcx,0x0(%rip)          ; 就是一次普通存
store release : mov    %rcx,0x0(%rip)          ; 与 relaxed 一模一样
store seq_cst : xchg   %rcx,0x0(%rip)          ; 隐式加锁的交换 → 全屏障
add  relaxed  : lock addq $0x1,-0x1(%rip)      ; RMW
add  seq_cst  : lock addq $0x1,-0x1(%rip)      ; 与 relaxed 一模一样
load  relaxed : mov    0x0(%rip),%rax
load acquire  : mov    0x0(%rip),%rax          ; 后面只补了几个 nop
```

数字和指令对上了，规则可以背下来：

1. **在 x86 上，只有"存"需要为 seq_cst 付钱**：`mov`(0.26ns) → `xchg`(5.71ns)，**22 倍**。因为 `xchg` 带隐式 lock 语义，会排空 store buffer。
2. **RMW（fetch_add、CAS）本来就是一条 `lock` 指令，指定任何内存序都是同一个价**（5.43–6.08ns，差异在噪声内）。所以"为了省内存序把 `fetch_add` 改成 relaxed"在这台机器上是**零收益**。
3. **load 无论 relaxed 还是 acquire 都是 `mov`**，不要为读侧付钱。
4. `atomic_thread_fence(seq_cst)`（6.83ns）比直接写 seq_cst 存（5.71ns）还贵一点——别指望"手动栅栏"能省钱。

于是选择内存序的正确思考方式是：**在 x86 上你几乎免费拿到 release/acquire；真正要判断的是"这个存需不需要全局序"。** 反过来，这些差异在 ARM/RISC-V 上会大得多（那里 load 也可能需要 `ldar`，store 需要 `stlr`），所以**代码里该写的序还是要写**，不能拿 x86 的价格当理由去省。

## 三、StoreLoad 是真的会翻车：同一个 harness，54% 与 0%

这是本节的核心实验。**SB（store buffer）litmus**：两个线程各自"先写自己的变量，再读对方的变量"，违例结局是 `r1 == 0 && r2 == 0`——两边的存都被自己的读"看漏"了。这个结局在**任何顺序交错下都不可能发生**（若 A 先跑完，B 必然读到 X=1；若 B 先跑完，A 必然读到 Y=1），所以一旦出现，就只能是硬件把"存"和"之后的读"换了位。

```cpp
// 线程 A：  P1 = my;            ← 预热存，把 store buffer 压满
//            X.store(1, ORD);   ra = Y.load(ORD);
// 线程 B：  P2 = my+7;          ← 同样的预热
//            Y.store(1, ORD);   rb = X.load(ORD);
```

主线程只负责"清零 X/Y → 放行 round → 等两边汇报"，两个工作线程被放行时都在自旋，是**真并发**。

`ORD = relaxed`，120 万轮，跑三次：

```text
  SB（relaxed + 预热存）：1200000 轮里 r1==0 && r2==0 的轮数 = 649571（54.1309%）
  SB（relaxed + 预热存）：1200000 轮里 r1==0 && r2==0 的轮数 = 693599（57.7999%）
  SB（relaxed + 预热存）：1200000 轮里 r1==0 && r2==0 的轮数 = 751547（62.6289%）
```

**超过一半的轮次里，x86 把 Store 之后的 Load 提前执行了。** 这不是理论，是每次跑都能撞上的东西。

然后——**完全相同的代码，只把那两个 store/load 的内存序换成 `seq_cst`**（用 sed 精确替换，其他一字未动，连那行输出的标签都没改），再跑两次：

```text
  SB（relaxed + 预热存）：1200000 轮里 r1==0 && r2==0 的轮数 = 0（0.0000%）   ← 这是 seq_cst 版，标签忘了改
  SB（relaxed + 预热存）：1200000 轮里 r1==0 && r2==0 的轮数 = 0（0.0000%）
```

240 万轮，0 违例。原因就是本篇第二小节那条 `xchg`：seq_cst 存自带排空 store buffer 的效果，读不可能跑在存前面。

**这就是 `seq_cst` 的存在意义**：它是唯一保证"所有线程看到一个一致的全局顺序"的模式，代价 22 倍。经典的 Dijkstra 式双标记算法（两个线程各设自己的标志再读对方的）必须用 `seq_cst`（或一个 `mfence`），用 relaxed/acquire 就是上面那 54%。

## 四、消息传递（MP）为什么在 x86 上"看起来安全"

另一个常见模式：写者先写数据、再写标志；读者先看标志、再读数据。

```text
  release/acquire 配对：跑 3000000 轮，看到 flag=1 却读到旧 data 的次数 = 0（读总数 3000000）
  relaxed 标志 + 普通 data：跑 3000000 轮，读到旧 data 的次数 = 0（读总数 3000000）
```

300 万轮，两次都是 0——**连 relaxed 都"没出错"**。这不是因为 relaxed 安全，而是因为 **x86-TSO 本来就保 StoreStore 和 LoadLoad 顺序**：写者的 `data; flag` 不会互换，读者的 `flag; data` 也不会互换。这条链上唯一可能出问题是编译器重排，而 GCC 13 在这个代码形状下没有重排。

结论分两半，都要记住：

- **在 x86 上，MP 用 release/acquire 是"零成本的保险"**（本篇第二小节：acquire 读就是 `mov`，release 存就是 `mov`）。既然免费，没有任何理由不写。**写了它，同一份代码在 ARM 上也才对。**
- **0 违例不代表 relaxed 合法。** 它是数据竞争（UB），今天 0、明天换个编译器版本或加个 `-fstrict-aliasing` 变化就可能不是 0。本篇第三小节的 SB 实验就是活证据：大家都以为"x86 很保守"，结果一半以上轮次翻车——**只有你测到的那类模式才会翻**，而你未必测到它。

## 五、伪共享：一个和内存序长得很像的坑

8 个线程各自只碰自己的计数器（无数据竞争，值必然正确），区别只在布局：

```text
  第 1 轮：挤同一缓存行 1.46 ms | 各占一行 0.45 ms ⇒ 伪共享慢 3.21x（两份和相等=是）
  第 2 轮：挤同一缓存行 1.24 ms | 各占一行 0.47 ms ⇒ 伪共享慢 2.62x
  第 3 轮：挤同一缓存行 1.32 ms | 各占一行 0.50 ms ⇒ 伪共享慢 2.67x
  第 4 轮：挤同一缓存行 1.40 ms | 各占一行 1.02 ms ⇒ 伪共享慢 1.38x
```

**同一行时慢 1.4–3.2 倍（中位 2.6x）**，而两种布局的**结果完全相同**（每轮都打印"两份和相等=是"，值 160000800000）——所以这不是正确性 bug，调试器什么都不会告诉你，只有计时能发现。原理：8 个线程写的是同一行里的 8 个不同 8 字节，MESI 会把整行在不同核之间来回夺所有权，每次夺行是几十到上百周期。

修法（本节实测的就是第一种）：

```cpp
struct alignas(64) Counter { long long v; };        // 或者补位
struct Counter { long long v; char pad[56]; };      // sizeof(Padded)=64，实测一致
```

什么时候**不要**这么干：如果你希望线程间共享的计数器**本来就要合并**（比如全局统计），把它做成 8 个独占行的分片反而更慢——分片只在"写者多且不需要即时全局值"时划算；需要总和时，一次 `+=` 到同一个位置反而只有一行要夺。第六节线程池里的分片合并就是这个思路。

## 六、把结论拧成能用的规则

1. **默认 `seq_cst`，只在热点上降级**。本篇第二小节显示：RMW 的内存序**在这台机器上不花钱**（5.43–6.08ns 全同），只有"存"贵 22 倍。所以降级内存序的收益只出现在**高频纯写**的地方（例如统计计数 `store(relaxed)`）。
2. **锁/同步的发布点必须 release，接收点必须 acquire**。这是"数据可见"的下限，且在 x86 上免费。SB 那 54% 说明：**别拿"我测过没问题"当证据**。
3. 需要"两边都写了且都看见对方写的东西"时（双标志、终止检测、Dekker 型），**必须 seq_cst 或显式 `atomic_thread_fence(seq_cst)`**——实测这是 0% 与 54% 的区别。
4. `is_lock_free()` 要**当断言用**：16 字节的 atomic 在这套工具链上其实是把锁（`always_lock_free=0`、`is_lock_free=0`）。想无锁就得把状态塞进 8 字节，或者用索引/句柄间接一层。
5. **分片计数器的数组要按缓存行对齐**（`alignas(64)`），否则 1.4–3.2 倍白丢，而且结果是对的、没有任何报错。
6. 需要跨平台时记住：**x86 的宽松是硬件给的，不是代码写的**。ARM/POWER 上 TSO 的保证不存在，MP 的 relaxed 版本就会真炸。写正确的序，成本是 0。

## 七、小结

- 无锁尺寸上限：本机 8 字节全锁免费（`sizeof(atomic<T>) == sizeof(T)`）；16 字节**必须 `-latomic`**，而且 libatomic 是**带锁模拟**（`is_lock_free=0`）。
- 价格：`store relaxed 0.26ns = mov`、`release 0.37ns = mov`、**`seq_cst 5.71ns = xchg`（22 倍）**；`fetch_add` 无论 relaxed/acq_rel/seq_cst 都是 `lock addq`，5.4–6.1ns；`load` 无论 relaxed/acquire 都是 `mov`。
- **SB litmus 实测**：同一份 harness，relaxed 三次跑 120 万轮分别有 **54.13% / 57.80% / 62.63%** 的违例；换成 seq_cst 两次都是 **0/1200000**。x86 的 StoreLoad 重排不是传说。
- MP（写数据→写标志 / 读标志→读数据）本机 300 万轮 0 违例，连 relaxed 都是 0——**因为 x86-TSO 保 StoreStore/LoadLoad**，不代表 relaxed 合法；在弱序机器上这条链会断。
- 伪共享：8 个独占计数器挤同一行比各占一行慢 **1.4–3.2 倍**，且结果完全正确，只有计时能发现。
