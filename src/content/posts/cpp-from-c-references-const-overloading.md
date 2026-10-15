---
title: 从 C 到 C++：引用、const 与重载
description: 同一份源码在 gcc 和 g++ 下结果不同——字符常量的类型、const 的链接性、f() 的含义、指定初始化的顺序。这些差异不是风格问题，是编译期就分岔的语义。
date: 2026-10-15
tags: [C++, C++基础, 引用, 重载]
category: cpp
section: cpp-from-c
---

> 环境：Windows 11 x64，MinGW-w64 **GCC 13.1.0**，分别用 `gcc -std=c17` 与 `g++ -std=c++17` 编译，所有差异都是同一台机器上对比出来的。

## 一、先做一件事：同一份代码编译两遍

```c
#include <stdio.h>
const int gconf = 7;
static int counter(void) { static int n = 0; return ++n; }
int main(void) {
    printf("sizeof('A') = %d\n", (int)sizeof('A'));
    printf("counter() 三次 = %d%d%d\n", counter(), counter(), counter());
}
```

```text
gcc -std=c17    →  sizeof('A') = 4      counter() 三次 = 321
g++ -std=c++17  →  sizeof('A') = 1      （其余相同）
```

`'A'` 在 C 里是 **`int`**，在 C++ 里是 **`char`**。这一条本身无害，但它是"C++ 不是 C 的超集"的第一个信号——下面每一条都用同样的方法验证。

## 二、`f()` 在两种语言里意思完全不同

| 写法 | C17 | C++17 |
| --- | --- | --- |
| `int f()` | **不描述参数**，调用 `f(1,2)` 编译器不管 | 等价于 `int f(void)`，`f(1,2)` 直接报错 |
| `int f(void)` | 无参 | 无参 |

```cpp
int f() { return 1; }
int main() { return f(1, 2); }
```

```text
error: too many arguments to function 'int f()'
```

而 C 侧（第九节量过）同样的调用**编译通过、跑出垃圾值**。所以：

- C 代码迁到 C++，第一件事是把所有 `f()` 声明改成 `f(void)`，否则 C++ 会突然报一堆"参数过多"。
- 反过来不成立：C++ 里写 `f()` 是安全的（就是无参），C 里不安全。
- C 项目至少该开 `-Wstrict-prototypes`，把这类漏网之鱼抓出来。

## 三、`const` 的链接性：C++ 默认内部，C 默认外部

同一份"两个编译单元都定义 `const int shared`"的代码：

```c
/* a.c / d6.cpp */  const int shared = 1;
/* b.c / d6b.cpp */ const int shared = 2;
```

```text
gcc（C）  → ld.exe: multiple definition of `shared'      链接失败
g++（C++）→ 链接 exit=0                                   各自一份，互不干涉
```

C 标准规定文件作用域的 `const` 对象**仍是外部链接**；C++ 规定 `const` 全局默认**内部链接**（相当于隐式 `static`）。这意味着：

- 从 C++ 移植到 C 的公共头文件，`const int kMax = 10;` 会突然报重复定义 → 要么加 `static`，要么 `#define`/`enum`。
- 反过来，C++ 里想跨 TU 共享一个常量，必须 `extern const int kMax;` 声明 + 单一处定义，否则每个 `.cpp` 拿到的是自己的副本（值一样时看不出问题，取地址比较时才发现"为什么两个指针不相等"）。

## 四、枚举：C 的弱与 C++ 的强

```c
enum E { E0, E255 = 255 };                 /* C 风格 */
enum class EC : uint8_t { A, B };          /* C++11 作用域枚举，指定底层类型 */
```

```text
sizeof(E)=4   sizeof(EC)=1
```

| 特性 | C 的 `enum` | C++ 的 `enum class` |
| --- | --- | --- |
| 大小 | 恒为 `int` 大小（4），**与最大值无关** | 由你指定的底层类型决定（这里 1 字节） |
| 名字作用域 | 污染外层作用域（`E0` 直接可见） | 必须 `EC::A` |
| 隐式转 `int` | 可以 | **不可以** |
| 取值检查 | 无（第九节实测 `enum Color c = 42;` 合法） | 无，但转换必须显式 |

```cpp
enum class Color { Red, Green };
int x = Color::Red;
```

```text
error: cannot convert 'Color' to 'int' in initialization
```

需要数值时显式 `static_cast<int>(Color::Red)`。**新代码一律用 `enum class`**：它不污染命名空间、不会和整数混用、大小可控。唯一要注意的是它不能隐式当数组下标/位标志用，位标志就老老实实 `enum class Flags : uint32_t` 再重载 `operator|`。

顺带一组实测宽度（MinGW 走 MSVC ABI）：

```text
sizeof(std::nullptr_t)=8   sizeof(NULL)=8
wchar_t=2   char16_t=2   char32_t=4
```

`NULL` 在 C++ 里是 `0L`（`long`，8 字节），这也是为什么 `f(NULL)` 会选中 `f(long)` 而不是 `f(int*)` 重载——**C++ 里永远写 `nullptr`**。`nullptr` 的类型是 `std::nullptr_t`，只向指针隐式转换，不会和整数重载打架。

## 五、初始化：C++ 更严，且顺序有讲究

```cpp
int i{3.5};                              // 窄化
struct P { int x; int y; };
P p{ .y = 2, .x = 1 };                   // 乱序指定初始化
```

```text
error: narrowing conversion of '3.5e+0' from 'double' to 'int' [-Wnarrowing]
error: designator order for field 'P::x' does not match declaration order in 'P'
```

同一段乱序指定初始化在 C 里是**合法的**（第四节实测 `designated = 0 7 0 9`）。三条 C++ 规矩：

1. **花括号 `{}` 禁止窄化**，`=` 或 `()` 允许。这正是推荐统一用 `{}` 的理由——它把丢精度变成编译错误。
2. **指定初始化器（C++20 起）必须按声明顺序**，且不能混用新旧写法。所以别指望把 C 的配置表写法直接搬过来。
3. `int i;`（默认初始化）在函数内是**未初始化**，`int i{};` 才是零初始化。类成员同理，别忘了在初始化列表里给全。

## 六、引用：不是"常量指针的语法糖"

```cpp
int a = 1, b = 2;
auto &r = a;   r = b;              // 改的是 a，不是让 r 改绑
const int &cr = a + b;             // const 左值引用可绑临时量
int &&rr = a + b;                  // 右值引用
auto byval = a;  byval = 99;       // auto 推导丢弃引用
```

```text
a=2 r=2 cr=4 rr=4 sizeof(r)=4
改 byval 之后 a=2 byval=99
```

四条语义：

1. **引用不能改绑**：`r = b` 是"把 2 赋给 a"，所以 `a` 变成 2。想换目标只能用指针。
2. **`sizeof(r)` 是被引用对象的大小**（4），不是指针的 8——但底层实现通常就是个指针，这是"语义与实现分离"的典型。
3. **`const` 左值引用可以绑临时量，并且延长其生命周期**到引用的生命周期结束（`cr=4` 就是这么来的）。非 const 左值引用绑临时量是错误。这是 C++ 里少数真正"魔法"的规则，也是 `const T&` 参数能接受字面量的原因。
4. **`auto` 推导丢弃引用和 const**：`auto byval = a;` 得到的是副本。想要引用必须写 `auto &`；想要 const 引用写 `const auto &`。这条规则的著名受害者是 `std::vector<bool>`：

   ```cpp
   std::vector<bool> v(10);
   for (auto x : v) { }        // x 是 bool，每次拷贝代理对象——能跑但慢
   for (auto &x : v) { x = true; }   // 改的是代理，行为对但语义微妙
   ```
   `vector<bool>` 的元素不是 `bool&` 而是代理对象，`auto&` 绑的是**临时的代理**，生命周期只到这条语句结束。想写通用代码就用 `auto&&`。

## 七、重载决议：优先级不是你想的那样

```cpp
void f(int);  void f(long);  void f(unsigned);
void g(double); void g(float);
short s = 1;
f(s);        f(1u);      f(1L);      g(1.0f);
```

```text
int   unsigned long  float
```

- `f(s)`（`short`）→ **`int`**：整型提升的优先级**高于**任何转换，`short → int` 是提升，`short → long` 是转换，所以选 `int`。
- `f(1u)` → `unsigned`（精确匹配）；`f(1L)` → `long`（精确匹配）；`g(1.0f)` → `float`（精确匹配）。

匹配等级从高到低：**精确匹配 → 提升 → 转换 → 省略号匹配**。同一等级里出现两个候选，就是**歧义，编译错误**：

```cpp
void f(long);  void f(float);  void f(unsigned long long);
f(1u);
```

```text
error: call of overloaded 'f(unsigned int)' is ambiguous
note: candidate: 'void f(long int)'
```

`unsigned int` 到 `long`、`float`、`unsigned long long` 全都是"转换"，没有谁更优。同理这两个也会歧义：

```text
f(1.0)  在 {long, float, unsigned long long} 中 → 歧义
g(1)    在 {double, float} 中                   → 歧义
```

**实用结论**：给函数加一个"看起来更精确"的重载，可能让原本能编译的调用点突然全部歧义。接口演进时优先用 `static_assert` + 明确类型，或者干脆改名（`_ex`、`_2`），别乱加重载。

## 八、构造与析构：顺序写死在标准里

```cpp
struct Base    { Base()    { printf("Base() ");    } virtual ~Base() { printf("~Base() "); } };
struct Derived : Base      { Derived()  { printf("Derived() ");  } ~Derived() override { printf("~Derived() "); } };

Derived d;                    // 栈对象
Base *p = new Derived();      // 通过基类指针删除
delete p;
```

```text
Base() Derived() Base() Derived() ~Derived() ~Base() ~Derived() ~Base()
```

三条铁律：

1. **构造：基类先于派生类**；成员按**声明顺序**构造（不是初始化列表的书写顺序——这条最容易踩，成员初始化列表写反顺序时 GCC 会警告 `-Wreorder`）。
2. **析构：派生类先于基类**，正好相反。
3. **通过基类指针 `delete` 时，基类析构必须是 `virtual`**，否则派生类析构不执行（未定义行为）。上面 `~Derived()` 能打印出来，正是因为 `Base::~Base()` 加了 `virtual`。

代价是每个多态对象都要带一个虚表指针（本机 8 字节）。所以：**不需要多态的基类不要写虚析构**，需要多态的必须写。

## 九、这一节的自查清单

- [ ] 迁移 C 代码到 C++ 时，先把所有 `f()` 声明改成 `f(void)`
- [ ] 跨 TU 共享的常量显式写 `extern const`，否则默认内部链接
- [ ] 新枚举一律 `enum class`，需要时指定底层类型
- [ ] 一律用 `{}` 初始化，让窄化变成编译错误
- [ ] 永不使用 `NULL`，只用 `nullptr`
- [ ] 理解 `auto` 丢弃引用/const，需要引用写 `auto&` 或 `auto&&`
- [ ] 不往既有接口上加同等级重载，避免制造歧义
- [ ] 多态基类必须有 `virtual` 析构；非多态类不要加
- [ ] 成员初始化列表按声明顺序写，开 `-Wreorder`
- [ ] 记住 `'A'` 在 C++ 里是 `char`（1 字节），在 C 里是 `int`

下一节讲类与封装：构造/析构的完整次序、拷贝控制的三法则与五法则、`explicit` 到底防什么，以及为什么"空的派生类"也要占 8 字节。
