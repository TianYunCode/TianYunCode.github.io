---
title: 类与封装
description: 空类为什么占 1 字节、成员按声明顺序构造而不是初始化列表顺序、移动构造少写一个 noexcept 就让 vector 扩容多拷一千次——类的骨架规则一次讲清。
date: 2026-10-15
tags: [C++, 类, RAII]
category: cpp
section: cpp-class
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++17 -Wall -Wextra`。本节所有大小、次序和拷贝/移动次数都是实测。

## 一、对象到底占多大

```cpp
struct Empty {};
struct OneInt { int x; };
struct DerivedFromEmpty : Empty { int x; };
struct Base { virtual ~Base() {} };
```

```text
sizeof(Empty)=1  sizeof(OneInt)=4  sizeof(DerivedFromEmpty)=4
sizeof(Base)=8（有虚函数 ⇒ 多一个虚表指针）
```

四条结论：

1. **空类是 1 字节**，不是 0。因为标准规定"两个同类型对象必须有不同地址"，大小为 0 会破坏这条。这 1 字节是纯占位，不承载数据。
2. **空基类优化（EBO）真实存在**：`DerivedFromEmpty` 是 4 而不是 5——空的基类子对象被塞进尾部填充里了。这就是为什么 `std::vector` 的分配器、`std::function` 的捕获对象都设计成可继承的空结构体。
3. **一旦有虚函数，每个对象多 8 字节**（虚表指针，本机 64 位）。`sizeof(Base)=8` 而它没有任何数据成员。想省这 8 字节就别用虚函数，用 CRTP 或 `std::variant`（后面模板一节讲）。
4. 有虚函数的类，成员对齐会按指针宽度抬高，字段顺序依然影响总大小（第四节讲过 C 的规则，C++ 完全一样）。

## 二、构造与析构次序：声明顺序说了算

```cpp
struct Base { Base() { print("Base() "); } virtual ~Base() { print("~Base() "); } };
struct Member1 { Member1() { print("M1() "); } ~Member1() { print("~M1() "); } };
struct Member2 { Member2() { print("M2() "); } ~Member2() { print("~M2() "); } };

struct Derived : Base {
    Member2 m2;                 /* 声明顺序：m2 在前 */
    Member1 m1;
    int v;
    Derived() : v(1), m1(), m2() { print("Derived()\n"); }   /* 列表写的是 v, m1, m2 */
    ~Derived() override { print("~Derived() "); }
};
```

```text
Base()
M2()  M1()  Derived()
~Derived()  ~M1()  ~M2()  ~Base()
```

**初始化列表的书写顺序完全不起作用**，成员一律按**类内声明顺序**构造，析构严格相反。上面的代码 GCC 直接警告：

```text
warning: 'Derived::v' will be initialized after [-Wreorder]
warning:   'Member1 Derived::m1' [-Wreorder]
warning:   when initialized here [-Wreorder]
```

这不是洁癖问题。如果 `a` 的初始化用到了 `b`，而 `b` 声明在 `a` 之后，你就在读一个尚未构造的成员——**代码看起来对，运行结果是垃圾**。规则：

- 基类 → 成员（按声明序）→ 派生类构造函数体；析构完全相反。
- 初始化列表**照着声明顺序写**，让 `-Wreorder` 永远闭嘴。
- 静态对象的构造顺序跨编译单元是**未定义**的，别依赖。需要就换成"首次使用时构造"的函数内 static。

## 三、封装：`class` 与 `struct` 只差一个默认值

| | `struct` | `class` |
| --- | --- | --- |
| 默认成员访问 | `public` | `private` |
| 默认继承方式 | `public` | `private` |
| 其他 | 完全相同 | 完全相同 |

```cpp
struct P { int x; };            // x 公开
class  Q { int x; };            // x 私有
class  R : P {};                // 私有继承！R 的 P 部分外部不可见
struct S : P {};                // 公有继承
```

习惯用法：**被动数据用 `struct`（POD、点、配置），有不变式和行为的用 `class`**。继承时永远显式写 `public`，别依赖默认值。

`private`/`protected` 是**类级**而非对象级：同一个类的任意成员函数可以访问任意实例的私有成员，这是实现 `operator==`、拷贝构造、比较排序的前提。

## 四、拷贝控制：三法则、五法则、零法则

一旦你自己写了下面任意一个，就要考虑全部：

- **三法则（C++98）**：析构函数、拷贝构造、拷贝赋值。
- **五法则（C++11）**：再加**移动构造**、**移动赋值**。
- **零法则**：最好一个都不写，用现成的 RAII 成员（智能指针、容器、`std::string`）把资源管起来。

```cpp
struct Buffer {
    int *p = nullptr;
    Buffer(size_t n) : p(new int[n]) {}
    ~Buffer() { delete[] p; }
    Buffer(const Buffer &o) : p(new int[o.size]) {}   /* 深拷贝 */
    Buffer &operator=(Buffer o) { swap(p, o.p); return *p; }  /* copy-and-swap */
    Buffer(Buffer &&o) noexcept : p(o.p) { o.p = nullptr; }   /* ← noexcept 不能省 */
};
```

**只要写了析构函数，编译器就不会再隐式生成移动构造**（会退化成拷贝）。这是"五法则"存在的核心理由：你管了资源，就得把移动也写对，否则放进 `std::vector` 时悄悄全走拷贝路径。

`Buffer(Buffer &&)` 缺 `noexcept` 的后果，实测最直观（下一节）。

## 五、一个 `noexcept` 值一千次拷贝

```cpp
struct Tracked    { Tracked(Tracked &&) noexcept;  ... };   /* 移动构造标了 noexcept */
struct TrackedBad { TrackedBad(TrackedBad &&);               /* 只少了 noexcept */ ... };

std::vector<T> v;
for (int i = 0; i < 1000; i++) v.push_back(T{});            /* 反复触发扩容 */
```

```text
1000 次 push_back：拷贝   0 次，移动 2023 次（is_nothrow_move=1）
1000 次 push_back：拷贝 1023 次，移动 1000 次（is_nothrow_move=0）
```

原因：`vector` 扩容要把旧元素搬到新缓冲区，而**搬一半时如果构造抛异常，原数组已经处于半移动状态、无法回滚**。标准要求 `vector` 提供强异常保证，所以它只有在 `is_nothrow_move_constructible<T>` 为真时才敢用移动，否则退回拷贝。

后果：一个几 MB 的对象数组，每次扩容都完整复制一遍——**总代价是 O(n) 次深拷贝**，实测 1000 个元素就产生了 1023 次拷贝。

**规矩：移动构造和移动赋值一律标 `noexcept`**（不标就别写移动）。写不出来 `noexcept` 的移动，说明它不安全，那就干脆别提供移动。

## 六、`explicit` 拦的是什么

```cpp
struct Wrapper { Wrapper(int x); };          /* 没有 explicit */
struct Strict  { explicit Strict(int x); };

void take(Wrapper w);
take(42);                    // ✅ 隐式 int → Wrapper
Strict s1(7);                // ✅ 直接初始化
Strict s2 = 7;               // ❌ 复制初始化被 explicit 拦下
```

```text
error: conversion from 'int' to non-scalar type 'Strict' requested
    Strict s2 = 7;
```

`explicit` 防的是**单参数构造函数造成的隐式转换**。它带来的价值在重载场景里尤其大：没有 `explicit` 时，`f(Wrapper)` 和 `f(int)` 会因为隐式转换而产生歧义或"意外选中"。

规则很简单：

- **单参数构造函数一律 `explicit`**，除非"隐式转换正是你要的语义"（比如 `std::string s = "abc"`）。
- C++11 后还有 `explicit` 的多参数版本（`std::array` 场景）和转换运算符的 `explicit operator bool()`（防止 `if (x < y)` 里流控制误用）。
- 注意 `explicit` 不拦 `Strict s1(7)` 和 `Strict{7}`，只拦复制初始化 `= 7` 和函数实参的隐式转换。

## 七、自赋值与 `copy-and-swap`

```cpp
Buffer &operator=(const Buffer &o) {          /* 朴素写法 */
    delete[] p;
    p = new int[o.n];                          /* ← o 就是 *this 时，p 已被 delete */
    return *this;
}
```

自赋值 `a = a;` 会先释放再读已释放的内存。两种正确写法：

```cpp
/* 1. 先检查 */
if (this == &o) return *this;

/* 2. copy-and-swap（推荐：天然异常安全，自赋值自动正确） */
Buffer &operator=(Buffer o) {        /* 按值传：拷贝在这里发生 */
    swap(p, o.p);                    /* noexcept 交换 */
    return *this;                    /* o 析构，带走旧资源 */
}
```

代价是按值传参会多一次移动（有 `noexcept` 的话很便宜）。现代写法通常分别写左值/右值两个重载，把移动路径省掉——但**先写对再写快**。

## 八、这一节的自查清单

- [ ] 成员初始化列表按**声明顺序**书写，开 `-Wreorder`
- [ ] 需要多态的基类有 `virtual` 析构；不需要的不要加虚函数（省 8 字节）
- [ ] 写了析构函数，就检查是否还需要拷贝/移动（五法则），或直接做到零法则
- [ ] 移动构造、移动赋值都标 `noexcept`
- [ ] 单参数构造函数默认 `explicit`
- [ ] 继承永远显式写 `public`
- [ ] 拷贝赋值考虑自赋值，优先 copy-and-swap
- [ ] 空类占 1 字节但可被 EBO 优化，把无状态策略做成基类成员
- [ ] 静态对象不依赖跨 TU 的构造顺序，改用函数内 `static`
- [ ] 关心对象大小时用 `sizeof` 实测，别按字段和猜

下一节讲 RAII 与资源管理：为什么"构造函数不抛异常就别写裸指针"、`unique_ptr` 的删除器怎么定制、循环引用怎么破，以及 `shared_ptr` 的控制块到底分配了几次内存。
