---
title: 读汇编与编译器优化：调用约定、栈帧、向量化，以及让 GCC 自己交代为什么没向量化
description: >-
  实测：`int sixargs(int a,int b,int c,int d,int e,int f)` 在 MS x64 下前四个参数落在
  `ecx/edx/r8d/r9d`，第 5、6 个从 `0x28(%rsp)`、`0x30(%rsp)` 取——**偏移 0x20 就是那 32 字节 shadow space**；
  16 字节结构体按值传参编成 `mov (%rcx),%rax; add 0x8(%rcx),%rax`，即**隐式传指针**；
  `int leaf(int x){return x>0?x:-x;}` 编成 4 条无分支指令 `mov/cltd/xor/sub`，**没有 prologue 也没有 epilogue**。
  同一个整数求和循环：`-O2` 下**没有一条向量指令**（`movslq/add/cmp/jne` 的标量环），
  `-O3 -fopt-info-vec` 让 GCC 自己打印 `a1.c:10:23: optimized: loop vectorized using 16 byte vectors`，
  而另外三个循环的 missed 理由分别是 `couldn't vectorize loop`、`not vectorized: unsupported data-type`、
  `not vectorized: complicated access pattern.`；`-O3 -mavx2 -ftree-vectorize` 后该函数出现 19 条向量指令。
  `-fno-strict-aliasing` 在这个样本上指令数一模一样（13 条 vs 13 条）——**因为那个循环本来就没被向量化**。
date: 2026-10-16
tags: [调试, 汇编, x86-64, 调用约定, 自动向量化]
category: debug-perf
section: dbg-asm
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin/gcc.exe`）**，反汇编用同目录 `objdump -d --no-show-raw-insn`。目标格式 `pei-x86-64`，ABI 是 **Microsoft x64**（System V 的那套 `rdi/rsi/rdx/rcx/r8/r9` 规则在本机不适用，本机没有 Linux 可对照，见第七节）。本节所有指令串都是 `-O2`（除特别标注）下的原文，**与机器负载无关**。栈帧、段结构、`.pdata/.xdata` 已在编译与构建专栏第二节讲过，这里只补"怎么用它们读代码"。

## 一、调用约定不用背表，看前四个参数落在哪

```c
__attribute__((noinline)) int sixargs(int a,int b,int c,int d,int e,int f){
    return a+b+c+d+e+f;
}
```

```text
0000000000000000 <sixargs>:
   0:  add    %edx,%ecx          <- a(ecx) + b(edx)
   2:  add    %r8d,%ecx          <- + c(r8d)
   5:  lea    (%rcx,%r9,1),%eax  <- + d(r9d)
   9:  add    0x28(%rsp),%eax    <- + e（栈上）
   d:  add    0x30(%rsp),%eax    <- + f（栈上）
  11:  ret
```

**四个整型参数用寄存器：`ecx`、`edx`、`r8d`、`r9d`；第五、六个在栈上，偏移是 `0x28` 和 `0x30`。** 这两个偏移量本身就说明了 MS x64 的结构：被调用者一进来，`0x00(%rsp)` 是返回地址，`0x08`–`0x27` 是**调用者必须预留的 32 字节 shadow space**（给 `rcx/rdx/r8/r9` 四个寄存器参数留的家），所以栈参数从 `0x28` 开始排。

三条实用推论：

1. **看到函数开头有 `mov %ecx,-0x20(%rbp)` 这类四连写，那不是bug，是它把寄存器参数"倒"进 shadow space**——通常意味着它要转手调用别人，或者开了 `-O0`。
2. **参数超过 4 个的函数在 MS x64 下不划算**：多出来的每一个都要走内存。热路径上把 6 个参数打包成一个结构体指针（第 3 个寄存器 `r8`）反而更快。
3. 与 `cdecl` 32 位那套"全部压栈、调用者清栈"完全不同；**同一份 C 代码混用两种 ABI 的目标文件根本链不到一起**（编译与构建专栏第十节里 `undefined reference` 的另一个来源）。

## 二、叶子函数可以完全没有栈帧

```c
int leaf(int x){ return x > 0 ? x : -x; }
```

```text
00000000000000f0 <leaf>:
  f0:  mov    %ecx,%eax
  f2:  cltd
  f3:  xor    %edx,%eax
  f5:  sub    %edx,%eax
  f7:  ret
```

**没有 `push %rbp`、没有 `sub $n,%rsp`、没有 `ret` 前的 `leave`**——叶子函数（不调用任何人）不需要栈帧。第二行到第五行是 GCC 把三目运算符编成**无分支绝对值**：`cltd` 把 `eax` 的符号扩展进 `edx`（负数→`edx=-1`，正数→`0`），`xor` 再 `sub` 完成"取反加一"的分支less 写法。

这给出两个读码动作：

- **数一下函数开头有没有 `push`/`sub %rsp`，就能判断它是不是叶子、要不要 spill 寄存器**，比猜优化效果快得多。
- **想验证"分支有没有被消掉"，就搜 `jmp`/`je`**。这里一条跳转都没有（除了循环外的边界判断），说明 `-O2` 已经把它变成条件运算。反过来，如果你在热路径的汇编里看到 `je`，**分支预测成本就真的存在**（第八节《缓存友好与数据布局》讲这个）。

## 三、结构体按值传参：16 字节是"隐式传指针"

```c
struct P16 { long long x, y; };
__attribute__((noinline)) long long use16(struct P16 p){ return p.x + p.y; }
```

```text
0000000000000020 <use16>:
  20:  mov    (%rcx),%rax
  23:  add    0x8(%rcx),%rax
  27:  ret
```

**`(%rcx)` 是间接寻址**：调用者把结构体放在自己的栈上，把它的地址塞进第一个整数参数寄存器 `rcx`。也就是说，**签名写着"按值传 16 字节"，机器上跑的其实是"传一个指针"**——MS x64 的规则是：只有 1/2/4/8 字节的纯整数结构体能塞进寄存器，`>8` 字节一律隐式传指针；含浮点/混合成员的同尺寸结构体也走指针（本机未逐一穷举，见第七节）。

对读码的实际影响：**凡是函数体里出现 `mov (%rcx),...`、`mov 0x8(%rcx),...`，第一反应该是"这其实是个按值传的大结构体或局部对象地址"，而不是"参数是指针"**。写 API 时这条也决定成本：传 16 字节结构体按值和按指针，**生成的代码几乎一样**，不用担心"按值传会不会拷贝两次"。

## 四、向量化与否，让编译器自己交代理由

同一个整数求和循环：

```c
__attribute__((noinline)) long long sum_i(int *v, int n){
    long long s = 0;
    for (int i = 0; i < n; i++) s += v[i];
    return s;
}
```

`-O2` 的产物里**一条向量指令都没有**：

```text
  40:  movslq (%rcx),%rdx
  43:  add    $0x4,%rcx
  47:  add    %rdx,%rax
  4a:  cmp    %r8,%rcx
  4d:  jne    40 <sum_i+0x10>
```

（对照 `-O3 -mavx2 -ftree-vectorize` 之后，同一函数体里出现 **19 条**向量类指令。）

**别猜，用 GCC 的自述开关**：

```text
$ gcc -O3 -fopt-info-vec -fopt-info-vec-missed -c a1.c -o a6.o
a1.c:10:23: optimized: loop vectorized using 16 byte vectors
a1.c:17:23: missed: couldn't vectorize loop
a1.c:17:23: missed: not vectorized: unsupported data-type
a1.c:23:23: missed: couldn't vectorize loop
a1.c:25:14: missed: not vectorized: complicated access pattern.
```

每一行都带 `文件:行:列`，直接指向源码位置。这四条本机实测的判定分别对应四种"能不能向量化"的真实边界：

| 循环 | 判定 | 为什么 |
| --- | --- | --- |
| `sum_i`（整数累加） | **optimized**（`-O3` 下） | 单位步长读取 + 可归约的加法；16 字节 = SSE 寄存器宽度 |
| `callhelper`（循环体里调 `helper`） | `couldn't vectorize loop` + `unsupported data-type` | 循环体是函数调用（两侧都标了 `noinline`，**调用不能被复制进向量 lane**） |
| `aliasing`（写 `a[i]`、读 `b[i]` 与 `a[i]`） | `couldn't vectorize loop` | 指针可能重叠，编译器无法证明 `a` 与 `b` 不别名 |

第三条是**最贵的一类**：它意味着"两个 `int*` 参数如果指向同一块内存，行为必须按重叠来保守处理"。GCC 靠**严格别名假设**（`-fstrict-aliasing`，`-O2` 默认开）来放行这类循环，代价是"用 `char*`/`int*` 混读写同一块内存"就成了 UB——**第三节那两条 `missed` 就是这个保守性的账单**。

## 五、`-fno-strict-aliasing` 在本机没让代码变长——因为它先没被向量化

想演示"关掉严格别名会让循环变慢"，实测结果却是否定的：

```text
-O2                     <aliasing>  指令数 13
-O2 -fno-strict-aliasing <aliasing>  指令数 13
```

**一模一样。**原因就在第四节：那个循环在 `-O2` 下**根本没被向量化**，所以"为保守处理重叠而插入的额外 load/store"没有出现的场合。这是一个很有价值的失败样本——**"某个 flag 会拖慢代码"这类说法，必须先看它影响的那条优化是否真的启用了**；否则你复现的是文档，不是编译器。

配套的读法：
- 想知道别名假设有没有被使用，先看 `-fopt-info-vec` 是否报 `optimized`；
- 想知道某 flag 的真实影响，比较**同一个函数的指令数**（`objdump -d | sed -n '/<fn>:/,/^$/p' | grep -cE '^ +[0-9a-f]+:'`），而不是比较总文件体积——第四节讲过 `.text` 大小与优化档位不是单调关系。

## 六、`noinline` 是读汇编的开关，不是性能开关

上面所有函数都加了 `__attribute__((noinline))`，为的是让每个函数在反汇编里**独立可见**。实测它的效果：

```text
$ objdump -d a1.o | sed -n '/<callhelper>:/,/^$/p'
  7e:  lea    (%rcx,%rdx,4),%r9      <- 数组尾指针
  8b:  add    $0x4,%r8
  8f:  call   60 <helper>            <- 真的发生调用，没被内联
  94:  add    %eax,%edx
```

`helper` 是一个 5 行的 `x*3+1`，在 `-O2` 下**本该被内联**（GCC 的内联预算默认会吃掉它），加上 `noinline` 后 `call` 保住了。这带来两个用途：

1. **调试场景**：给想断点的函数加 `noinline`，否则断点会落到调用者身上（第一节《GDB 实战》里"断点停在不认识的行"就是这个原因）。
2. **对照场景**：想看"内联到底值不值"，必须能生成两份可对比的代码——`noinline` 与 `always_inline` 就是这对开关。

反过来，`static` 的小函数在 `-O2` 下几乎总被吃掉；判据同样是**指令数与有没有 `call`**。

## 七、本节未在本机实测

- **System V AMD64 ABI 对照**（Linux 下前六个整型参数用 `rdi/rsi/rdx/rcx/r8/r9`、无 shadow space、结构体可拆两个寄存器）：本机没有 Linux/WSL，**只写了 MS x64 一侧的实测**。不要把本节的 `0x28(%rsp)` 当通用结论。
- **浮点与 `__vectorcall`/`thiscall`/`stdcall` 等修饰**：MS x64 下浮点参数一律走 `xmm0–3`，本节没做样本；32 位（`-m32`）在本机也不能链接（编译与构建专栏第六节实测过 `--print-multi-lib` 只有一档）。
- **结构体传参的完整尺寸矩阵**（1/2/4/8 字节纯整数、含浮点、含嵌套、>16 字节）只测了 16 字节纯整数这一档。
- **AVX-512 与 `-march=native` 的向量化上限**：本机 CPU 支持到哪一档没查（`cpuid` 未采集），只测到 `-mavx2` 下 256 位向量出现。
- **`-fopt-info-vec-optimized` 与 perf 计数器的联动**（证明向量化真的更快）：本机无 `perf`，**本节只证明了"代码形状变了"，没有证明"变快了多少"**——耗时属于第九节《基准测试方法论》的口径。
- **手工内联汇编与 intrinsics（`__builtin_ia32_*`）的可移植性**。

## 八、小结

- **调用约定看三条指令就知道**：MS x64 下前四个整型参数在 `ecx/edx/r8d/r9d`，第五、六个在 `0x28(%rsp)`、`0x30(%rsp)`——**这两个偏移量正好暴露了 32 字节 shadow space 的位置**（返回地址 `0x00`，`0x08–0x27` 是影子区）。
- **有没有栈帧是信息**：叶子函数可以没有 `push/sub rsp/leave`；`int leaf(int x){return x>0?x:-x;}` 编成 `mov/cltd/xor/sub` **四条、零分支**。搜 `jmp/je` 能判断分支有没有被消掉。
- **16 字节结构体按值传 = 隐式传指针**：`mov (%rcx),%rax; add 0x8(%rcx),%rax` 的间接寻址就是证据；写 API 时按值与按指针生成的代码几乎一样。
- **向量化不要猜，问编译器**：`-O3 -fopt-info-vec -fopt-info-vec-missed` 会逐行打印 `optimized: loop vectorized using 16 byte vectors` 与 missed 的具体理由（`couldn't vectorize loop`、`unsupported data-type`、`complicated access pattern.`）。同一循环 `-O2` 下**零条向量指令**，`-O3 -mavx2 -ftree-vectorize` 下 19 条。
- **flag 的影响要看它作用的那条优化是否启用**：`-fno-strict-aliasing` 在本机让 `<aliasing>` 指令数 13→13 不变，因为那个循环本来没被向量化——**复现"某 flag 会拖慢"之前，先确认对应的优化真的开了**。
- **`noinline` 是观察工具**：它让 `helper` 在 `callhelper` 里保留成真正的 `call`，既是断点可用的前提，也是内联收益对照的开关。
