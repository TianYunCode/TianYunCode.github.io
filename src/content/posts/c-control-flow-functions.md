---
title: 流程控制与函数
description: switch 的 fallthrough 是默认行为、空括号的函数声明不检查参数、尾递归优化在 C 里根本没有保证——这一节把流程控制和函数边界的规则一次说清，所有结论都有编译器和反汇编作证。
date: 2026-10-15
tags: [C语言, 函数, 流程控制]
category: c-language
section: c-control
---

> 环境同上一节：Windows 11 x64，MinGW-w64 **GCC 13.1.0**，`-std=c17 -Wall -Wextra -O0`（标注 `-O2`/`-std=c2x` 的除外）。

## 一、if / else：一个分号就能改掉语义

```c
if (x > 0);
    x = 0;          /* 这行永远执行，与条件无关 */
```

`if` 后面那个裸分号是一条**空语句**，语法完全合法，GCC 默认也不警告（`-Wempty-body` 只管函数）。代码评审时这是最容易漏过的一行。

更隐蔽的是悬垂 else。`else` 永远配**最近的未匹配 `if`**，而不是你缩进想表达的那个：

```c
int a = 1, b = 0, c = -1;
if (a)
    if (b)
        c = 1;
    else
        c = 2;      /* 这个 else 配的是 if (b)，不是 if (a) */
printf("%d\n", c);
```

```text
2
```

`a` 为真、`b` 为假，于是 `c` 被改成 2——很多人预期"什么都不发生"。加 `-Wdangling-else` 编译器会直接点出来：

```text
warning: suggest explicit braces to avoid ambiguous 'else' [-Wdangling-else]
```

规则很简单：**嵌套 `if` 一律写花括号**，别依赖缩进表达意图。

## 二、switch：不 break 才是 C 的默认行为

`case` 只是一个入口标签，匹配后**一路往下执行**直到 `break` 或分支结束：

```c
int f(int x) { int r = 0; switch (x) { case 1: r += 1; case 2: r += 2; } return r; }
printf("%d %d\n", f(1), f(2));
```

```text
3 2
```

`f(1)` 得到 3 而不是 1——它从 `case 1` 进去，加完 1 之后**没有停**，继续执行了 `case 2`。GCC 能识别这种"看起来像手误"的写法：

```text
warning: this statement may fall through [-Wimplicit-fallthrough=]
note: here
```

故意穿透时要显式声明意图，把警告压掉：

```c
case 1:
    r += 1;
    __attribute__((fallthrough));   /* GCC/Clang 扩展；C23 标准化为 [[fallthrough]] */
case 2:
    r += 2;
    break;
```

加了这行之后同一份代码编译**零警告**（实测 `exit=0` 且无输出）。

### case 标签要的是编译期常量表达式

```c
int g(int x) { switch (x) { case 1 + 2: return 1; case 2 * 3 % 4: return 2; case 'A': return 3; } return 0; }
```

上面这份代码编译通过——`case` 接受常量表达式，包括字符常量。但换成变量就不行：

```text
error: case label does not reduce to an integer constant
```

重复标签也是编译期错误，不是运行时行为：

```text
error: duplicate case value
note: previously used here
```

这两条错误值得记住，因为它们意味着 `switch` 的分支表在编译期就完全确定了——这也是 `switch` 通常比一长串 `if-else if` 快的原因（连续或接近连续的整数会编译成跳转表）。

### 用穿透做分类，是它最正当的用法

```c
static const char *classify(int code) {
    switch (code) {
    case 200: case 201: case 204:  return "success";
    case 301: case 302:             return "redirect";
    case 404:                       return "not found";
    default:                        return "other";
    }
}
```

```text
200/201/204 共用分支: success success success
```

多个 `case` 标签紧挨着写、中间没有语句，**不会触发穿透警告**——这是编译器有意区分的"空分支穿透"。

### Duff's device：能跑，但别写

把 `switch` 的穿透和 `do-while` 嵌套，就能得到一个从中间进入循环的拷贝函数：

```c
size_t count = (n + 7) / 8, rest = n % 8;
switch (rest) {
case 0: do { *dst++ = *src++;
case 7:      *dst++ = *src++;
case 6:      *dst++ = *src++;
case 5:      *dst++ = *src++;
case 4:      *dst++ = *src++;
case 3:      *dst++ = *src++;
case 2:      *dst++ = *src++;
case 1:      *dst++ = *src++;
          } while (--count > 0);
}
```

实测拷贝 20 字节后 `dst[0]=x dst[19]=x`，功能正确。但编译时它会老实告诉你：

```text
warning: this statement may fall through [-Wimplicit-fallthrough=]
```

因为 `case 0` 的循环体确实穿透进了 `case 7`。今天编译器、`memcpy` 和缓存行对齐都比这种手工展开更快，它的价值只剩"证明 C 的语法组合有多自由"。

## 三、循环：边界、退出与 goto 的正确位置

### 无符号减一是循环失控的头号原因

```c
unsigned n = 0;
for (unsigned i = 0; i < n - 1 && iters < 20u; i++) iters++;
```

`n - 1` 是 `4294967295`，这个循环本该跑 42 亿次——我在条件里加了 20 次上限才把它掐住，实测确实跑满 20 次就退出。**凡是长度可能为 0，就不要写 `i < n - 1`**，改成 `i + 1 < n`。

### `while (n--)` 结束时 n 是 -1

```c
int n = 3, hits = 0;
while (n--) hits++;
```

```text
int n=3; while(n--) 循环体执行 3 次，退出时 n = -1（不是 0）
```

条件用的是**后缀自减的旧值**：`n` 依次取 3、2、1 为真，取 0 为假，但每次比较之后 `n` 已经被减过，所以最后停在 -1。想在循环体里用"剩余次数"，这个 -1 很容易变成 bug。

### `break` / `continue` 只管一层

嵌套循环里 `break` 只跳出最内层，想跳出多层只有两条路：加标志位，或者用 `goto`。

### goto 的正当用法：统一出口清理

C 里没有析构函数、没有 `finally`，多层资源获取失败时要按**逆序**释放。`goto` 到函数末尾的清理链是这个场景的标准写法（Linux 内核里到处都是）：

```c
static int resource_pipeline(int fail_at) {
    int a = 0, b = 0, c = 0;
    if (fail_at <= 1) goto fail_a;
    a = 1;
    if (fail_at == 2) goto fail_b;
    b = 2;
    if (fail_at == 3) goto fail_c;
    c = 3;
    printf("  全部成功: a=%d b=%d c=%d\n", a, b, c);
    return 0;
fail_c:
    printf("  在 c 之前失败，释放 b=%d a=%d\n", b, a); b = 0;
fail_b:
    printf("  在 b 之前失败，释放 a=%d\n", a); a = 0;
fail_a:
    printf("  一开始就失败，无需释放\n");
    return -1;
}
```

实测 `fail_at` 取 0..3 的输出：

```text
fail_at=0:  一开始就失败，无需释放
fail_at=1:  一开始就失败，无需释放
fail_at=2:  在 b 之前失败，释放 a=1
            一开始就失败，无需释放
fail_at=3:  在 c 之前失败，释放 b=2 a=1
            在 b 之前失败，释放 a=1
            一开始就失败，无需释放
```

看清楚这个结构：**标签从上到下就是释放顺序，每个失败点跳到对应位置，然后继续往下穿透完成剩余清理。** 用嵌套 `if-else` 写同样的逻辑，代码量翻倍还容易漏。

`goto` 也有一条硬限制：**不能跳进变长数组的作用域**，因为 VLA 的长度要在声明处求值：

```c
goto label;
int vla[n];
label:
    printf("%d\n", (int)sizeof(vla));
```

```text
error: jump into scope of identifier with variably modified type
```

## 四、函数：声明、定义与"到底有没有原型"

### 空括号 `()` 不是"参数未定"，是"不做参数检查"

这是 C 和 C++ 差异最大、也最致命的一处。在 C 里：

```c
int add();                      /* 旧式声明：不携带任何参数信息 */
int main(void) {
    printf("%d %d\n", add(1, 2, 3, 4), add());
    return 0;
}
int add(int a, int b) { return a + b; }   /* 定义在调用之后 */
```

本机编译**零警告零错误**，运行结果：

```text
3 -849665087
```

传 4 个参数、传 0 个参数都被放行，第二个调用读到的是寄存器里的垃圾值。而只要把声明写成 `int add(void);`，同样的调用立刻被拦下：

```text
error: too many arguments to function 'has_proto'
```

C23 已经取消这种旧式声明，GCC 13 换到 `-std=c2x` 后，上面那份"能跑"的代码直接变成错误：

```text
error: too many arguments to function 'add'
```

**规则：无参函数永远写 `(void)`，函数一律带完整原型。** 顺手加 `-Wstrict-prototypes`，它专门抓漏掉的 `void`。

### 隐式声明：编译器放你过关，链接器拦你

```c
int main(void) { int r = add(1, 2); printf("%d\n", r); return 0; }
```

```text
warning: implicit declaration of function 'add' [-Wimplicit-function-declaration]
ld.exe: undefined reference to `add'
```

C89 允许"遇到没声明的函数就按 `int f()` 隐式声明"，于是拼错函数名、忘 `#include` 都能编译过，直到链接期才炸——而且报的是 `undefined reference`，看不出真正原因是拼写。**C23 彻底移除了隐式函数声明。**

### 声明与定义不一致是编译期错误

```c
void f(int);
void f(long x) { (void)x; }
```

```text
error: conflicting types for 'f'; have 'void(long int)'
note: previous declaration of 'f' with type 'void(int)'
```

参数个数不一致同理：

```text
error: conflicting types for 'add'; have 'int(int)'
note: previous definition of 'add' with type 'int(int, int)'
```

顺带一提，K&R 风格的定义（参数名写在括号里、类型写在外面）现在只剩警告，但新代码没有任何理由写它：

```text
warning: old-style function definition [-Wold-style-definition]
```

### 数组作参数就退化成指针，`sizeof` 当场失效

```c
static void array_param(int arr[5]) {      /* 这里的 [5] 只是注释 */
    printf("sizeof(arr)=%zu ⇒ \"元素个数\"=%zu\n", sizeof arr, sizeof arr / sizeof arr[0]);
}
int main(void) { int arr[5]; array_param(arr); }
```

```text
main 里 sizeof(arr)/sizeof(arr[0]) = 5
函数内 sizeof(arr)=8 sizeof(arr[0])=4 ⇒ 算出的"元素个数"=2
```

`int arr[5]` 这种形参写法**不会**保留长度，编译器直接警告：

```text
warning: 'sizeof' on array function parameter 'arr' will return size of 'int *' [-Wsizeof-array-argument]
```

结论：数组进函数必须**同时传长度**，一个都别信 `sizeof`。

### C 的 `inline` 和 C++ 完全不是一回事

C 里 `inline` 定义**不产生外部符号**，所以把它放头文件里给多个 `.c` 用，链接期会找不到函数：

```c
/* hdr_inline.h */
inline int shared_fn(void) { return 42; }
/* a.c 和 b.c 都 #include 它 */
```

```text
ld.exe: undefined reference to `shared_fn'
ld.exe: undefined reference to `shared_fn'
```

三种写法的实测结果：

| 头文件里怎么写 | 结果 |
| --- | --- |
| `inline int f(void) {...}`，各 TU 直接用 | **链接失败**：undefined reference |
| `static inline int f(void) {...}` | 正常，每个 TU 一份内部链接副本（**日常首选**） |
| `inline` + 恰好一个 TU 里写 `extern inline int f(void);` | 正常，那个 TU 负责产出外部定义 |
| `inline` + **两个** TU 都写 `extern inline` | **链接失败**：multiple definition of `shared_fn2'` |

`extern inline` 那两条实测分别是"链接通过、返回 7"和"multiple definition"——**有且只有一个**编译单元能写它。记不住就一律 `static inline`。

### 函数指针表比 if 链更可维护

```c
static const struct { int code; const char *name; int (*handler)(void); } table[] = {
    { 200, "ok",   handle_ok   },
    { 404, "miss", handle_miss },
};
```

跳转表、状态机、插件回调都建立在这上面，下一节讲指针时会展开它的完整用法。

## 五、递归：栈帧代价与"尾递归优化"的真相

### 每层递归到底吃多少栈

把每层的局部变量地址打出来，就能量出帧大小：

```c
static void recurse(int depth) {
    uintptr_t here = (uintptr_t)&depth;
    if (depth == 1) top_addr = here;
    if (depth >= 1000) { deep_addr = here; return; }
    recurse(depth + 1);
    sink += depth;
}
```

```text
栈向低地址增长：第 1 帧 00000045afbff670，第 1000 帧 00000045afbefcb0
999 层共占 63936 字节 ⇒ 每层约 64 字节
```

两个结论：**栈地址递减**（递归越深地址越小），以及这个只带一个 `int` 参数的函数每层仍要花 64 字节——远大于 4 字节，因为还有返回地址、寄存器保存和 16 字节对齐。

本机生成的 PE 头里写着：

```text
SizeOfStackReserve  0000000000200000
SizeOfStackCommit   0000000000001000
```

即**预留 2 MB**、初始提交 4 KB（按需增长）。拿实测的 64 字节/层估算，这个函数大约能递归 3 万层；帧更大或者在嵌入式上（栈常常只有 2–8 KB），预算要按同样方法重新量。

### 尾递归在 C 里没有任何保证

先看两个函数：

```c
long long fact_plain(long long n) { return n <= 1 ? 1 : n * fact_plain(n - 1); }
long long fact_tail(long long n, long long acc) { return n <= 1 ? acc : fact_tail(n - 1, acc * n); }
```

`-O0` 反汇编里，**两个函数各有一条 `call`**——都是真递归。`-O2` 再反汇编，两个函数里的 `call` **都变成了 0 条**，全被优化成了循环，而且 `fact_tail` 还被顺手做了 2 倍展开：

```asm
a0:	imul   %rcx,%rax
a4:	lea    -0x1(%rcx),%rdx
a8:	sub    $0x2,%rcx          ← 一次迭代算两个乘数
ac:	imul   %rdx,%rax
b0:	cmp    $0x1,%rcx
b4:	jne    a0 <fact_tail+0x20>
```

这直接推翻了"C++/C 里尾递归会被优化成循环、普通递归不会"的常见说法。真相是：

1. **C 标准不承诺尾调用优化**——这一点和 Scheme/Racket 有明确要求不同，C 里就是没有保证。
2. 能不能变成循环，取决于**优化器和具体函数**，而不是你写成什么形式。这里连 `fact_plain` 都被变成了循环。
3. `-O0`、调试构建、跨编译单元、带析构或异常的场景（C++）都可能让优化失效。

所以：**不要把尾递归当栈安全的保障。** 需要确定性的深迭代，就手写 `while` 循环。

### 顺便看看整数增长有多快

`long long` 装阶乘的极限是 20：

```text
19! =  121645100408832000
20! = 2432902008176640000
21! = 14197454024290336768 <-- 超过 int64 上限
```

（21! 那一行是用 `unsigned long long` 打印的，已经回绕。）递归实现阶乘之前，先确认 `n` 的范围——多数"递归算阶乘"的示例代码在 n=21 就开始静默出错。

## 六、这一节的自查清单

- [ ] 嵌套 `if` 全部带花括号，`else` 归属没有歧义
- [ ] `switch` 每个分支要么 `break`/`return`，要么显式标注 fallthrough，警告清零
- [ ] 长度可能为 0 时不写 `i < n - 1`
- [ ] 多层资源清理用 `goto` 统一出口，而不是嵌套 `if-else`
- [ ] 所有函数都有完整原型；无参写 `(void)`；开了 `-Wstrict-prototypes`
- [ ] 数组进函数一律"指针 + 长度"成对传，不依赖形参里的 `[N]`
- [ ] 头文件里的内部小函数写 `static inline`
- [ ] 深迭代用循环，不指望尾递归优化
- [ ] 递归前按"每帧字节 × 层数"估一遍栈，嵌入式上尤其要量

下一节进入数组与字符串：`sizeof` 与 `strlen` 的分工、多维数组的真实布局、数组名退化成指针的三种例外，以及越界访问为什么"大多数时候看起来是对的"。
