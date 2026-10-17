---
title: ASAN / UBSAN / TSAN
description: 本机实证：MinGW 工具链不带 sanitizer 运行时（asan/ubsan/tsan 全部链接失败）；本文讲清三个 sanitizer 各查什么，以及拿不到 sanitizer 时的替代手段。
date: 2026-10-16
tags: [调试, sanitizer, ASan, UBSan, TSan, 内存安全]
category: debug-perf
section: dbg-sanitizer
---

> 环境：Windows 11 x64，GCC 13.1.0（MinGW-w64，`D:/Qt/Tools/mingw1310_64/bin`）与 Strawberry 的 GCC 4.9.2（32 位，`C:/Strawberry/c/bin`）。探针 `%TEMP%/dbg3s_*`。**本文的性质必须先说清：本机两个工具链都不带 sanitizer 运行时**——`-fsanitize=address` 链接报 `cannot find -lasan`，`-fsanitize=undefined` 报 `cannot find -lubsan`，`-fsanitize=thread` 报 `cannot find -ltsan`（grep 工具链 lib 目录，三个运行时一个都不在）。所以**本文没有任何 sanitizer 实测输出**，第一至四节是原理与用法文档，第五节是本机替代方案的实测。

## 一、三个 sanitizer 的分工：先记住这张表

| 工具 | 编译参数 | 查什么 | 不查什么 |
| --- | --- | --- | --- |
| **ASan** | `-fsanitize=address` | 堆/栈/全局越界读写、use-after-free、double-free、栈溢出、部分容器溢出 | 数据竞争、逻辑错误、未初始化读（那是 MSan） |
| **UBSan** | `-fsanitize=undefined` | 未定义行为：有符号溢出、空指针解引用、错位访问、除零、`enum` 越界、违反严格别名等 | 内存安全（越界写不一定报）、竞争 |
| **TSan** | `-fsanitize=thread` | 数据竞争（两个线程无同步地读写同一地址）、锁顺序问题 | 内存错误本身（配合 ASan 用） |

分工的记住法：**ASan 管"内存别用错"，UBSan 管"代码别踩 UB"，TSan 管"线程别乱共享"**。三者互补，正式项目的 CI 里常见组合是 ASan+UBSan 一组跑、TSan 单独一组跑（TSan 的内存记账和 ASan 冲突，不能同开）。

## 二、ASan：影子内存的把戏

ASan 的原理是**影子内存（shadow memory）**：为每 8 字节的应用内存维护 1 字节影子，记录这 8 字节"哪些字节可访问"。编译器的每次 load/store 前插入检查代码，查影子的值。malloc/free 被替换成带红区（redzone）的版本：分配块前后填毒值，块与块之间插不可访问的红区——**越界写踩到红区、释放后的块标成已毒，use-after-free 一读就炸**。

它查的经典四类，每类对应一段最小复现：

```cpp
// 堆越界：ASan 报 heap-buffer-overflow，指出越界了几个字节
int* p = (int*)malloc(4 * sizeof(int)); p[4] = 42;

// use-after-free：ASan 报 heap-use-after-free，给出 free 的栈
int* p = (int*)malloc(sizeof(int)); free(p); *p;

// double-free：报 attempting double-free
free(p); free(p);

// 栈溢出：函数里 char buf[8]; strcpy(buf, "too long");
```

关键点：**报错带完整分配栈和释放栈**（`allocated by thread T0 here:` / `freed by thread T0 here:`），这是它比"段错误"值钱的地方——不是告诉你死了，是告诉你**谁埋的**。

## 三、UBSan：把"未定义行为"变成一条告警

C/C++ 标准里大量行为是"未定义"——编译出什么都不算错。UBSan 在编译期给可疑操作插运行时检查，命中时打印一行（默认不终止，可 `-fno-sanitize-recover` 改成终止）：

```
runtime error: signed integer overflow: 2000000000 + 2000000000 cannot be represented in type 'int'
```

它和 ASan 的分界常被搞混：**越界写堆内存，ASan 报，UBSan 一般不报**（那是内存错误不是 UB）；**有符号溢出、错位解引用、`*(int*)0` 的解引用尝试，UBSan 报，ASan 不一定报**（比如对空指针的读，ASan 只有当地址落在毒区才报）。实际用法：

- **开发期全开**：`-fsanitize=undefined -fno-sanitize-recover=all`，把 UB 当错误。
- **挑着开**：某些检查误报多或代价大（如 `alignment`、`object-size`），可以 `-fno-sanitize=alignment` 单独关。
- **和 `-fsanitize=bounds` 配合**：数组下标越界（C 的 `a[i]`）走 bounds 检查，和 ASan 的堆检查互补。

一个常见误解："`-O2` 下 UB 被优化吃掉"和"UBSan 能抓住"不矛盾——UBSan 就是在优化**之前**插桩，所以它反而常用来**证明**"这段代码踩了 UB，所以 `-O2` 的行为不算数"（dbg-benchmark 那节的"死代码消除"现象就是 UB 被优化的例子）。

## 四、TSan： happens-before 的运行时验证

TSan 维护每个内存地址的"最后访问记录"（哪个线程、什么操作、当时的向量时钟），每次访问检查：两个访问之间有没有 happens-before 关系（同一线程的程序顺序、加锁/解锁、信号量、线程创建/汇入）。**没关系的冲突访问 = 数据竞争**，报告两个线程的栈。

它抓的是 conc-mutex 那节量过的"70.7% 更新丢失"类 bug 的**无竞争版本**（有锁保护就不报）。三个使用要点：

1. **代价最大**：记账让程序慢 5–15 倍、内存涨 5–10 倍，只在小测试用例上跑，别上生产。
2. **误报来自"忘了标记的同步"**：用了自定义自旋锁但没接 TSan 的接口（`__tsan_mutex` 系列注解），TSan 不认为那是同步——看起来像竞争的良性代码会报。标准库和 pthread 的同步它都认识。
3. **和 ASan 不能同开**：两者都要管内存布局，冲突。CI 里分两个 job。

## 五、拿不到 sanitizer 时的替代方案（本机可做）

本机链接不了任何 sanitizer（证据在开头）。替代手段按有效性排序：

1. **编译器警告**：`-Wall -Wextra` 抓的是另一类问题（未使用、类型不匹配），但 `-Wmaybe-uninitialized`、`-Wstringop-overflow` 这类**静态分析**确实能抓一部分越界模式——build-configuration 那节量过"同一份源码默认零警告、`-Wall` 报 1 条、`-Wall -Wextra` 2 条"。
2. **valgrind**：Linux 侧的正规军，本机无 Linux 环境（dbg-memory 那节同款限制），未测。
3. **Dr. Memory**（Windows 的 valgrind 替代）：文档级了解，本机未装未测。
4. **手动插桩**：把探针写成"自己记账"——申请/释放记链表，退出时对账（"申请数==释放数"）；访问前后写哨兵字节，退出时检查。笨，但在没有 sanitizer 的机器上**这是唯一能自动化的**，dbg-memory 那节的探针就是这个路子。
5. **代码评审 + 断言**：`assert` 检查前置条件，RAII 管生命周期（cpp-raii 那节）——sanitizer 抓的是"已经发生"的，这两个防的是"将要发生"的。

## 六、与覆盖率、模糊测试的配合

sanitizer 的最后一个价值点是**它让其他工具的输出变得可信**：

- **覆盖率**（`--coverage` + gcov/lcov）告诉你"哪些行没跑到"，**不告诉你跑到的行对不对**。sanitizer 开着跑覆盖率测试，未覆盖的行从此变成唯一的怀疑对象——两者是"查哪儿"和"查得对不对"的分工。
- **模糊测试**（libFuzzer/AFL）是"自动生成输入喂边界"，**没有 sanitizer 的模糊测试只会找崩溃**；配上 ASan/UBSan，它能把"静默的越界写"也变成一次可发现的失败。Windows 上可用的组合是 WinAFL + ASan（Linux 的 libFuzzer 生态更全），本文未部署。
- 本站实测过的相关数字：dbg-benchmark 量过 `-O2` 把"结果丢弃的循环"优化成一条 `ret`——**没有 sanitizer 或 volatile 阻断，微基准连被测代码都没执行**；这类"测试本身失效"的问题，比被测代码的 bug 更隐蔽。

## 七、未实测清单

- 本机全部 sanitizer 输出（无运行时，链接即失败）——见开头。
- sanitizer 的性能开销数字（常见文档值：ASan 约 2 倍慢、TSan 5–15 倍）——本机无法测，未给本站数字。
- Dr. Memory、WinAFL——未部署。
- MSan（未初始化读检测）——连 MSVC 都没有公开对应物，本文未展开。
