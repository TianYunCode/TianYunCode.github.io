---
title: 模板与泛型
description: 完美转发到底省掉多少次拷贝（实测 100 次调用零拷贝）、函数模板为什么不能偏特化、以及一个反常识结论：concepts 的报错行数比无约束版更多，但它把错误停在了调用点。
date: 2026-10-15
tags: [C++, 模板, concepts]
category: cpp
section: cpp-template
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++17`（concepts 部分用 `-std=c++20`）。报错行数、拷贝计数都是本机实测。

## 一、模板错误的真相：行数不等于质量

同一个误用（给不支持 `+` 的类型调用 `add`），三种写法的报错：

| 写法 | 报错行数 | 错误停在哪里 |
| --- | --- | --- |
| 无约束 `template<class T>` | **5 行** | 模板体内部：`no match for 'operator+'` |
| SFINAE `enable_if_t<is_arithmetic_v<T>>` | 14 行 | 调用点：`no matching function` |
| C++20 `requires std::integral<T>` | **16 行** | 调用点 + 明确点名哪个约束、哪个表达式求值为 false |

无约束版：

```text
t_plain.cpp: In instantiation of 'T add(T, T) [with T = NoPlus]':
t_plain.cpp:4:45:   required from here
t_plain.cpp:2:47: error: no match for 'operator+' (operand types are 'NoPlus' and 'NoPlus')
```

concepts 版（节选）：

```text
error: no matching function for call to 'add(NoPlus&, NoPlus&)'
note: candidate: 'template<class T>  requires  integral<T> T add(T, T)'
note: constraints not satisfied
note: the expression 'is_integral_v<_Tp> [with _Tp = NoPlus]' evaluated to 'false'
```

**所以"concepts 能把二十行报错缩成一行"这个流行说法，在这个最小例子里是错的。** 真正的差别是两点：

1. **错误位置**：无约束版是"先接受任何类型、实例化之后才在模板体里炸"，你看到的是模板**内部**的错误，得反推"是谁用什么类型实例化了它"（`In instantiation of ... required from here` 这条链在嵌套调用里会拖很长）。concepts 在**重载决议阶段**就把候选排除，错误停在**你的调用点**。
2. **可解释性**：`constraints not satisfied` + `is_integral_v<NoPlus> evaluated to false` 是**声明级**的信息，不用读懂模板体就知道为什么不行。

在真实项目里（多层嵌套模板、STL 容器、递归实例化）无约束版的报错会膨胀到几十上百行，而约束版的长度基本恒定——**行数不随复杂度爆炸**才是它的价值。这个最小例子恰好相反，说明"看行数"不是正确的评估方式。

## 二、两阶段名字查找与 `typename` / `template`

模板定义时先做一次检查（不依赖 T 的部分），实例化时再做一次（依赖 T 的部分）。这就是为什么有些错误在定义期就报、有些要等到调用：

```cpp
template <class T>
void f(T c) {
    T::size_type x;              // ❌ 编译器默认把 :: 当"小于号"
    typename T::size_type x;     // ✅ 明确它是类型
    c.template get<int>();       // ✅ 依赖成员的模板调用要写 template
}
```

规则只有两条：**依赖 T 的类型名前面加 `typename`；依赖 T 的模板成员调用加 `template`**。写错时的报错通常是一句 `need 'typename' before ... because 'T' is dependent type`，很好认。

## 三、特化：类可以做，函数不行

```cpp
template <class T> struct Box { };         // 主模板
template <class T> struct Box<T*> { };     // ✅ 类模板偏特化
template <> struct Box<int> { };           // ✅ 类模板全特化

template <class T> int f(T);               // 主模板
template <class T> int f<T*>(T *);         // ❌ 函数模板不允许偏特化
```

```text
error: non-class, non-variable partial specialization 'f<T*>' is not allowed
```

函数只能**全特化**，不能偏特化。替代方案有两个，优先级也写在下面：

1. **加重载**（首选）：`int f(int*)` 就是一个普通重载，重载决议会正确处理。
2. **委托给类**：`template<class T> struct impl;` 做偏特化，函数模板只调用 `impl<T>::go()`。这是标准库里到处用的技巧。

一个坑：**函数模板的特化会改变重载决议结果**，而且特化必须在调用点之前可见，否则调用绑定到主模板。这就是"`std::swap` 不要特化、要重载"这条建议的由来。

## 四、万能引用与完美转发：省掉的是全部拷贝

```cpp
template <class T> void sink_bad(T v)  { }     // 按值
template <class T> void sink_fwd(T &&v) { }    // 万能引用（转发引用）
C c;
for (int i = 0; i < 100; i++) sink_bad(c);     // 左值
for (int i = 0; i < 100; i++) sink_fwd(c);
for (int i = 0; i < 100; i++) sink_fwd(C{});   // 右值
```

```text
sink_bad(T v)    100 次调用：拷贝 100 移动 0
sink_fwd(T &&v)  100 次调用：拷贝   0 移动 0
sink_fwd(临时量) 100 次调用：拷贝   0 移动 0
```

机制：`T &&v` 在**推导**场景下是转发引用，传左值时 `T` 推导为 `C&`，`C& &&` 折叠成 `C&` —— 参数直接绑到原对象，一次拷贝都不产生。按值传参则必须构造一个副本。

转发到另一个函数时要用 `std::forward`：

```cpp
template <class... Args>
auto make(Args &&...args) { return T(std::forward<Args>(args)...); }
```

`std::move` 是"无条件变右值"，`std::forward` 是"保持原来的值类别"——**转发必须用 forward，用 move 会把本该按引用传的左值强行变成右值**，导致下游意外窃取。

### 转发引用的四个陷阱

1. **只出现在 `T &&` 且 T 正在被推导的位置**。`void f(std::vector<T> &&)`、`void f(S &&)`（S 是已确定的类成员）都不是转发引用。
2. **布尔参数会毁掉接口的可读性**：`f(true)` 到底传的是什么？转发之外一律用具名类型。
3. **`{1,2,3}` 推不出来**：花括号初始化列表不能推导 `T`，遇到就编译失败。
4. **`unique_ptr`/右值字面量当实参**要写 `std::forward<T>(x)` 而不是 `T(x)`，否则可能复制（`unique_ptr` 又不可复制，直接编译错误）。

## 五、`if constexpr`：编译期分支，不实例化另一支

```cpp
template <class T> auto describe(T v) {
    if constexpr (std::is_integral_v<T>)      return v * 2;
    else if constexpr (std::is_floating_point_v<T>) return v + 0.5;
    else { static_assert(sizeof(T) == 0, "不支持的类型"); return v; }
}
describe(3);        // OK
describe(1.0);      // OK
describe(Bad{});    // 触发 static_assert
```

```text
error: static assertion failed: 不支持的类型
```

`if constexpr` 的分支**不满足条件时根本不实例化**，所以浮点类型走不到 `v * 2` 也不会报错（普通 `if` 会）。这是替代 SFINAE 和标签转发（tag dispatch）最省脑子的写法。注意 `static_assert(sizeof(T) == 0)` 这个惯用法：直接写 `false` 会在定义期就炸，必须绑到 T 上才延迟到实例化。

## 六、CTAD：C++17 的类模板实参推导

```cpp
template <class T> struct Box { T value; explicit Box(T v) : value(v) {} };
Box b1(42);        // Box<int>
Box b2{3.5};       // Box<double>
auto v = std::vector{1, 2, 3};       // vector<int>
auto p = std::make_unique<int>(7);
Box b3("abc");
```

```text
b1=42 b2=3.5 v.size=3 *p=7
Box("abc") 推导出的类型大小=8
```

推导规则和 `auto` 完全一致，包括那条容易忽略的：**数组到指针的退化**——`Box b3("abc")` 里的 `value` 是 `const char *`（8 字节），不是 `char[4]`。想保留数组语义得自己写推导指引（`template <class T, size_t N> Box(T(&)[N]) -> Box<std::array<T,N>>`）。

没有显式推导指引时，编译器从构造函数隐式生成。所以**构造函数模板化的类**（如 `std::pair`、`std::tuple`）CTAD 行为可能反直觉，必要时手写指引。

## 七、变量模板与内联静态成员

```cpp
template <class T> constexpr T pi = T(3.1415926535897932385);   // C++14 变量模板
float  r = pi<float>;      // 3.14159f
double d = pi<double>;     // 更高精度，同一个模板
```

C++17 起类内 `static` 成员可以写 `inline static int count = 0;`，不用再在 `.cpp` 里补一份定义——这是模板类和单例实现里最常见的样板消除。

## 八、这一节的自查清单

- [ ] 公共模板接口用 `concepts` 约束，理由不是"报错短"，而是"错误停在调用点且可解释"
- [ ] 依赖类型加 `typename`，依赖模板成员加 `template`
- [ ] 函数模板要"按类型分派"就加重载或委托类，不要试图偏特化
- [ ] 转发用 `std::forward`，不用 `std::move`
- [ ] 转发引用参数后面紧跟 `T` 的使用点，别在中间转成值类型
- [ ] 编译期分支用 `if constexpr`，`static_assert` 的条件要依赖模板参数
- [ ] CTAD 注意数组退化和花括号推不出来这两点
- [ ] 模板定义放头文件（否则实例化看不到定义会链接失败）
- [ ] 拿不准推导结果时用 `static_assert(std::is_same_v<decltype(x), Expected>)` 或 `typeid` + `__cxa_demangle` 打印真实类型

下一节讲 STL 容器与迭代器：各容器的复杂度保证、迭代器失效规则表（哪些操作让哪些迭代器失效）、`vector` 的扩容策略实测，以及为什么 `std::list` 在真实机器上通常比理论慢。
