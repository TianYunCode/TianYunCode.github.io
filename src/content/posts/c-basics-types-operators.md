---
title: 语言骨架：变量、类型与运算符
description: C 的语法看着小，坑集中在三处：类型的真实宽度、混合运算的隐式转换、以及把"求值顺序"当成"优先级"。所有数字都在本机 MinGW GCC 13.1.0 上实测。
date: 2026-10-15
tags: [C语言, 类型系统, 基础]
category: c-language
section: c-basics
---

> 本文所有输出都是本机实测：Windows 11 x64，MinGW-w64 **GCC 13.1.0**，编译参数 `-std=c17 -Wall -Wextra -O0`。换平台或换编译器，宽度类结论要重新测一遍——这本身就是本节要讲的重点之一。

C 的语法总量不大，一个月就能写完所有语法的 demo。但真正让人写错代码的，是那些**编译器不会拦你**的地方：`int` 到底多宽、`char` 有没有符号、`-1 < 1u` 为什么是假、`a > b > c` 为什么不是数学意义上的"介于"。

这一节把这些底层约定一次性钉死。

## 一、类型的真实宽度：拿 limits.h 当尺子

先记住一条原则：**C 标准只规定"至少多宽"和"谁不比谁窄"，具体宽度由实现决定。** 标准原文的约束是这样的：

| 类型 | 标准保证 | 本机实测 |
| --- | --- | --- |
| `char` | 恰好 1 字节 | 1 |
| `short` | ≥ 16 位 | 2 |
| `int` | ≥ 16 位，通常等于机器自然字长 | 4 |
| `long` | ≥ 32 位，且 ≥ `int` | **4** |
| `long long` | ≥ 64 位 | 8 |
| `void *` | — | 8 |
| `size_t` | 无符号，能表示最大对象大小 | 8 |
| `float` / `double` | IEEE-754 单/双精度（常见实现） | 4 / 8 |

取值范围不要背，用编译器打印：

```c
printf("INT   [%d, %d]  UINT max %u\n", INT_MIN, INT_MAX, UINT_MAX);
printf("LONG  [%ld, %ld]  ULONG max %lu\n", LONG_MIN, LONG_MAX, ULONG_MAX);
printf("SIZE_MAX = %zu\n", SIZE_MAX);
printf("char 是否有符号: %s\n", CHAR_MIN == 0 ? "无符号" : "有符号");
```

```text
INT   [-2147483648, 2147483647]  UINT max 4294967295
LONG  [-2147483648, 2147483647]  ULONG max 4294967295
SIZE_MAX = 18446744073709551615
char 是否有符号: 有符号
```

三个必须记住的结论：

1. **`char` 的符号是实现定义的。** 本机（x86-64 Windows/Linux 上的 GCC）默认 `signed char`，所以 `(char)200` 打印出 `-56`；ARM 上很多工具链默认 `unsigned char`，同一行代码给出 `200`。凡是要装字节流、做位运算，写 `unsigned char` 或 `uint8_t`，别用裸 `char`。
2. **Windows x64 是 LLP64，`long` 只有 32 位。** Linux/macOS x64 是 LP64，`long` 是 64 位。这就是为什么 Windows API 用 `LONG`(32) / `LONGLONG`(64) 两套名字，也是跨平台代码必须用 `stdint.h` 的 `int32_t`/`int64_t` 而不是 `long` 的原因。
3. **`size_t` 是无符号类型**，`sizeof` 的返回类型就是它。所以 `for (size_t i = n - 1; ...)` 在 `n == 0` 时会先回绕成一个天文数字。

### 字面量的类型是"推"出来的，不是你写的那个

整数常量的类型由**值和后缀**共同决定：十进制字面量会依次尝试 `int → long → long long`（C17 规则），直到装得下为止。在本机 `long` 只有 32 位，于是：

```c
long big = 3000000000L;
printf("long 3000000000L 在本机 = %ld（sizeof(long)=%zu）\n", big, sizeof(long));
```

```text
long 3000000000L 在本机 = -1294967296（sizeof(long)=4）
```

这里 `3000000000L` 本身**已经**被推成 `long long`（`long` 装不下），把它赋给 `long` 变量时才被截断。也就是说 `L` 后缀并不保证你拿到 64 位——想要确定的宽度，只有两种办法：`int64_t` 配 `PRId64`，或者字面量后缀 `LL`。

同理，乘法溢出发生在**赋值之前**：

```c
printf("1000000000 * 10 = %d\n", 1000000000 * 10);
printf("1000000000LL * 10 = %lld\n", 1000000000LL * 10);
```

```text
1000000000 * 10 = 1410065408
1000000000LL * 10 = 10000000000
```

第一行是**有符号溢出，属于未定义行为**。GCC 在常量折叠阶段就会告诉你它崩成了什么：

```text
warning: integer overflow in expression of type 'int' results in '1410065408' [-Woverflow]
```

浮点字面量默认是 `double`：`sizeof(1.0)` 是 8，`sizeof(1.0f)` 才是 4。给 `float` 变量赋 `double` 常量、或者用 `1.0` 去做本意是单精度的运算，都是白付双精度的代价。

## 二、整型提升：小类型运算前会先"长大"

这是 C 最反直觉的规则之一：**比 `int` 窄的整数类型（`char`、`short`、`bool`、枚举）在参与运算前会被提升为 `int`**（如果 `int` 装不下它的全部值，则提升为 `unsigned int`）。

```c
char c1 = 100, c2 = 100;
printf("sizeof(c1+c2) = %zu, c1 + c2 = %d\n", sizeof(c1 + c2), c1 + c2);

short s1 = 30000, s2 = 30000;
printf("sizeof(s1+s2) = %zu, s1+s2 = %d\n", sizeof(s1 + s2), s1 + s2);

unsigned char u1 = 200, u2 = 100;
printf("unsigned char 200+100 = %d\n", u1 + u2);
```

```text
sizeof(c1+c2) = 4, c1 + c2 = 200
sizeof(s1+s2) = 4, s1+s2 = 60000
unsigned char 200+100 = 300
```

三个结果都值得停一下：

- `c1 + c2` 不是 `-56`（8 位回绕），而是 `200`——因为两个 `char` 先各自变成了 `int` 再相加。
- `s1 + s2 = 60000` 超出了 `short` 的范围却没有溢出，同样是提升在救你；可一旦把结果存回 `short`，就立刻变成 `-5536`。
- 提升是**运算时**的行为，**存储时**该窄还是窄。别把"中间结果正确"误当成"这段代码安全"。

顺带一条：C 里**字符常量 `'A'` 的类型是 `int`**，`sizeof('A')` 打印出 4。C++ 里它是 `char`，`sizeof` 为 1——这是两个语言少数实打实的差异之一。

###  usual arithmetic conversions：混合运算谁迁就谁

二元运算的两个操作数要先变成同一类型，规则从宽到窄地"向上提升"：

1. 任一为 `long double` / `double` / `float` → 另一个转成它；
2. 否则任一为 `unsigned long long` / `long long` → 对齐到它；
3. 否则若类型有符号性相同，取更宽的；
4. 否则若**无符号类型的等级 ≥ 有符号类型**，把有符号的转成无符号的；
5. 否则若有符号类型能表示无符号类型的全部值，把无符号的转成有符号的；反之两者一起升到无符号的更高一档。

第 4 条就是那个经典事故：

```c
int n = -1;
printf("-1 < 1u ? %d\n", n < 1u);
```

```text
-1 < 1u ? 0
```

`int` 和 `unsigned int` 同宽，于是 `-1` 被转成 `4294967295u`，一个负数"变成"了最大无符号数，比较结果自然为假。编译器会明确警告：

```text
warning: comparison of integer expressions of different signedness: 'int' and 'unsigned int' [-Wsign-compare]
```

这条警告在生产代码里应该当错误处理（`-Werror=sign-compare`）。最常见的触发场景是拿 `int` 循环变量和 `sizeof`/`strlen` 的结果比较，或者把 `-1` 当哨兵值传给一个 `size_t` 参数。

### 无符号回绕是有定义行为的

和"有符号溢出是 UB"相对，无符号运算是**模 2ᴺ**，回绕完全有定义：

```c
unsigned u = UINT_MAX;
printf("UINT_MAX + 1u == 0 ? %d\n", u + 1u == 0);
printf("0u - 1u = %u\n", 0u - 1u);
printf("(unsigned)-1 = %u\n", (unsigned)-1);
```

```text
UINT_MAX + 1u == 0 ? 1
0u - 1u = 4294967295
(unsigned)-1 = 4294967295
```

所以 `while (n-- > 0)`、`i < end - start`（长度差用无符号）这类写法在边界上必须严格论证，否则一个 `-1` 就是 42 亿次循环。

## 三、运算符：优先级、结合性、求值顺序是三件事

优先级（谁先算）和结合性（同级从左还是从右）是**规定死的**；求值顺序（同一表达式里子表达式谁先算）在 C 里**大量是未规定的**。把三者混为一谈是绝大多数"我看代码和跑出来不一样"的来源。

### 优先级：只需要记住这几组易错关系

```c
int x = 5;
printf("x & 1 == 0 解析成 x & (1==0) => %d；正确写法给出 %d\n", x & 1 == 0, (x & 1) == 0);
printf("sizeof x + 1 => %d（先 sizeof x 得 %zu）\n", sizeof x + 1, sizeof x);
printf("1 ? 2 : 3 + 4 => %d\n", 1 ? 2 : 3 + 4);
```

```text
x & 1 == 0 解析成 x & (1==0) => 0；正确写法给出 1
sizeof x + 1 => 5（先 sizeof x 得 4）
1 ? 2 : 3 + 4 => 2
```

| 易错组合 | 实际解析 | 你的本意 |
| --- | --- | --- |
| `a & b == c` | `a & (b == c)` | `(a & b) == c` |
| `sizeof x + 1` | `(sizeof x) + 1` | `sizeof (x + 1)` |
| `p->member++` | `(p->member)++` | `p->(member++)`（非法） |
| `*p++` | `*(p++)` | `(*p)++` |
| `a = b == c` | `a = (b == c)` | 通常就是这个，但要写清 |
| `(1 ? 2 : 3) + 4` | 三元运算符优先级极低 | 冒号右侧吃到表达式末尾 |

位运算符的优先级低于 `==`/`<`，是 C 遗留的历史问题，**加括号是唯一可靠的办法**。

### 求值顺序：三种"未规定"和一种"未定义"

**（1）函数实参之间未规定顺序。** 这段代码的输出顺序就不是从左到右：

```c
static int counter_calls(void) {
    static int calls = 0;
    return ++calls;
}
printf("counter_calls() 连续三次: %d %d %d\n", counter_calls(), counter_calls(), counter_calls());
```

```text
counter_calls() 连续三次: 3 2 1
```

GCC 从右往左压栈，所以打印出 `3 2 1`。同一表达式里还顺便验证了 `static` 局部变量的存储期——它在调用之间保留。任何"实参之间有副作用依赖"的写法都不可移植。

**（2）`+ * && || ==` 等运算符的两个操作数求值顺序未规定。** `f() + g()` 谁先跑不知道。

**（3）赋值运算符的右侧先于左侧完成求值，但左侧求值（地址计算）与右侧副作用之间仍有限制**，别依赖它。

**（4）修改次序（sequence point）违规是 UB。** 同一个全表达式内，一个标量对象被修改两次、或修改与读取之间没有序列点：

```c
int a = 0;
int r = (a = 3) + (a = 4);          /* UB */
int j = 5;
j = j++ + 1;                          /* UB */
int i = 5;
i = i++ + i++;                        /* UB */
```

GCC 会直接点名：

```text
warning: operation on 'a' may be undefined [-Wsequence-point]
warning: operation on 'j' may be undefined [-Wsequence-point]
```

本机 `-O0` 下 `j = j++ + 1` 给出 6，`-O2` 或换编译器就可能不同——这正是 UB 的定义：**"可能不同"本身就是结果**。有符号溢出同理：

```c
volatile int m = INT_MAX;
printf("INT_MAX + 1 = %d\n", m + 1);   /* UB，本机 -O0 给出 -2147483648 */
```

有确定序列点的只有这几个：`&&`、`||`、`?:`、逗号运算符 `,`，加上函数调用（所有实参求值先于进入函数）和语句边界。短路行为因此是有保证的：

```c
int called = 0, zero = 0;
if (zero && (called = 1)) { }
printf("0 && (called=1) 后 called = %d\n", called);   /* 0，右侧根本没求值 */
```

**（5）`sizeof` 的操作数不求值**（VLA 除外）：

```c
int v = 7;
printf("sizeof(v = 99) = %zu，v 仍然是 %d\n", sizeof(v = 99), v);
```

```text
sizeof(v = 99) = 4，v 仍然是 7
```

这也是 `sizeof arr / sizeof arr[0]` 安全的原因。但要注意它只在**数组本体**上成立，一旦退化成形参指针就只剩指针宽度——这是下一节指针部分的内容。

### 比较的结果是 int 的 0 或 1

```c
int a = 5, b = 3, c = 1;
printf("a > b > c = %d，a > b 本身 = %d\n", a > b > c, a > b);
```

```text
a > b > c = 0，a > b 本身 = 1
```

`a > b` 先算出 `1`，再和 `c`（值为 1）比较，`1 > 1` 为假。数学上的"介于"必须写成 `a > b && b > c`。编译器对此有专门的警告：

```text
warning: comparisons like 'X<=Y<=Z' do not have their mathematical meaning [-Wparentheses]
```

## 四、作用域、存储期、链接性：三套互相独立的坐标

新手把这三者混着说，结果就是看不懂 `static` 到底干了什么。它们分别回答三个不同的问题：

| 概念 | 回答的问题 | 可选值 |
| --- | --- | --- |
| 作用域 scope | 哪个范围的名字能看见它 | 块作用域 / 文件作用域 / 函数作用域(`goto`/`switch` 标签) / 原型作用域 |
| 存储期 storage duration | 它活多久 | 自动 / 静态 / 线程局部(`_Thread_local`) / 分配期(`malloc`) |
| 链接性 linkage | 别的 `.c` 能不能拿到它 | 无 / 内部(`static`) / 外部 |

组合起来看：

```c
static int file_scope = 10;        /* 文件作用域 + 静态存储期 + 内部链接 */
int global = 1;                    /* 文件作用域 + 静态存储期 + 外部链接 */

void f(void) {
    int automatic = 1;             /* 块作用域 + 自动存储期 + 无链接 */
    static int keeps = 0;          /* 块作用域 + 静态存储期 + 无链接 */
    register int hint = 2;         /* 只是建议放寄存器，作用域/存储期不变 */
}
```

`keeps` 只有块内能访问，但它在函数返回后不销毁——这就是上面 `counter_calls()` 能累加的原因。

### C 里 `const` 不改变链接性

这是从 C++ 转来的人必踩的一脚。C 标准规定：文件作用域的 `const` 限定对象，**默认仍是外部链接**（C++ 里默认内部链接）。两个编译单元各写一个同名 `const int`，链接期直接冲突：

```c
/* link_a.c */
const int shared = 1;
/* link_b.c */
const int shared = 2;
int main(void) { return shared; }
```

```text
ld.exe: link_b.c:(.rdata+0x0): multiple definition of `shared';
      link_a.c:(.rdata+0x0): first defined here
collect2.exe: error: ld returned 1 exit status
```

所以头文件里的常量要么写成 `static const int`（每个 `.c` 一份副本），要么写成 `#define`/`enum`，要么老老实实 `extern const int` 声明 + 单一处定义。想清楚"这个常量是给编译器看的还是给链接器看的"，就不会选错。

## 五、浮点：精度损失发生在赋值之前

```c
printf("0.1 + 0.2 == 0.3 ? %d\n", 0.1 + 0.2 == 0.3);
printf("0.1 + 0.2 = %.20g\n", 0.1 + 0.2);
printf("0.3       = %.20g\n", 0.3);
float f = 16777217.0f;
printf("float 存 16777217 => %.0f\n", f);
```

```text
0.1 + 0.2 == 0.3 ? 0
0.1 + 0.2 = 0.30000000000000004441
0.3       = 0.2999999999999999889
float 存 16777217 => 16777216
```

`0.1` 在二进制里是无限循环小数，存进去就已经不是它了，所以**永远不要用 `==` 比较两个浮点计算结果**，要比较 `fabs(a - b) < eps` 或者干脆用定点整数。

精度上限查 `float.h`：

```text
FLT_MANT_DIG=24  DBL_MANT_DIG=53  FLT_DIG=6  DBL_DIG=15
```

- `FLT_MANT_DIG=24`：`float` 只有 24 位尾数（含 1 位隐含位），所以 2²⁴+1 = 16777217 存不进去，被舍成 16777216。
- `DBL_MANT_DIG=53`：`double` 能精确表示的整数上限是 2⁵³ ≈ 9.0×10¹⁵。**超过它就丢位**——把 64 位 ID 塞进 `double`、或者用 JS 传雪花 ID 出问题，都是这一条。
- `FLT_DIG=6` / `DBL_DIG=15` 是"十进制有效数字能保证不丢"的位数，打印金额、坐标时按它决定小数位。

混合类型比较时 `float` 会提升到 `double`：

```c
float f = 1.0f;
printf("1.0f == 1.0 ? %d\n", f == 1.0);          /* 1 */
printf("sizeof(f * 2) = %zu\n", sizeof(f * 2));   /* 4：int 2 被拉高到 float，不会反向升 double */
```

## 六、字符与字符串的几个固定事实

```c
const char *s = "ab" "cde";
printf("自动拼接 => %s, strlen=%zu\n", s, strlen(s));
printf("sizeof(\"abc\")=%zu, strlen(\"abc\")=%zu\n", sizeof("abc"), strlen("abc"));
printf("sizeof(\"\\n\")=%zu\n", sizeof("\n"));
printf("遇 NUL 截断: \"%s\" 长度 %zu\n", "ab\0cd", strlen("ab\0cd"));
```

```text
自动拼接 => abcde, strlen=5
sizeof("abc")=4, strlen("abc")=3
sizeof("\n")=2
遇 NUL 截断: "ab" 长度 2
```

- **相邻字符串字面量在翻译阶段就被拼接**，这是真的拼接（跨行写长文案、按条件分段拼），不是运行时行为。
- `sizeof` 算上结尾的 `\0`，`strlen` 不算。`sizeof("abc")` 是 4。
- 转义序列在**编译期**就变成一个字符，所以 `sizeof("\n")` 是 2（一个换行 + NUL），不是 3。
- 字符串里嵌 `\0` 会让所有基于 `strlen` 的函数提前收尾——处理二进制数据时长度必须显式传，别指望 NUL。
- **字符串字面量放在只读段**，`char *p = "abc"; p[0] = 'x';` 是 UB，本机通常直接崩。要改就写 `char p[] = "abc";`（数组副本，可写）。

## 七、这一节的自查清单

- [ ] 我用的宽度来自 `stdint.h`（`int32_t`/`uint64_t`），不是 `int`/`long` 的"想当然"
- [ ] 打印用配套宏：`PRId32`、`PRIu64`、`%zu` 配 `size_t`，并且开了 `-Wformat=2`
- [ ] `char` 只用来存字符；存字节用 `unsigned char` 或 `uint8_t`
- [ ] 任何 `int` 与 `unsigned` 的比较都有显式转换，`-Wsign-compare` 零告警
- [ ] 位运算、`sizeof`、三元的操作数都加了括号
- [ ] 一个表达式里只对同一个对象改一次，绝不出现 `i = i++ + 1`
- [ ] 浮点相等比较用容差，或者根本不用浮点存钱和 ID
- [ ] 编译命令里有 `-Wall -Wextra`，而且我把 warning 当 error 看

下一节讲流程控制与函数——`switch` 的 fallthrough、循环边界的 off-by-one、以及函数声明与定义不一致时编译器为什么会"同意"你的错误。
