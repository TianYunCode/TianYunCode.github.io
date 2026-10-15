---
title: 继承与多态
description: 构造函数里调虚函数会静默降级成基类版本、虚函数的默认参数按静态类型取、对象切片把 72 字节压成 8 字节——继承的规则一条条用输出验证。
date: 2026-10-15
tags: [C++, 继承, 多态]
category: cpp
section: cpp-inheritance
---

> 环境：**GCC 13.1.0**，`g++ -std=c++17 -Wall -Wextra -Wsuggest-override`。下面每一段输出都是本机运行结果。

## 一、构造与析构期间，虚函数不会派发到派生类

```cpp
struct Base {
    Base() { printf("Base() 里调虚函数 → "); virt(); }
    virtual ~Base() { printf("~Base() 里调虚函数 → "); virt(); }
    virtual void virt() const { printf("Base::virt\n"); }
};
struct Derived : Base {
    int data = 42;
    void virt() const override { printf("Derived::virt，data=%d\n", data); }
};

Derived d;
```

```text
Base() 里调虚函数 → Base::virt
构造完成后直接调 → Derived::virt，data=42
~Base() 里调虚函数 → Base::virt
```

**构造派生类时，先构造基类子对象，此刻 vptr 指向的是 `Base` 的虚表**——因为 `Derived::data` 还没初始化，如果允许派发到 `Derived::virt()`，它会读到未构造的成员。析构相反：进入 `~Base()` 时派生类部分已经销毁。

这是**语言层面的保护**，不是 bug。后果与对策：

- 想在基类构造时调用"子类行为"，标准做法是**两阶段初始化**：构造函数只做 trivial 赋值，再显式调用 `init()`（此时对象已完整）。
- 或者把那个函数设为**纯虚**，在基类构造里调用它 → 运行到 `__cxa_pure_virtual`，直接终止（比静默降级更容易发现）。
- 别指望 `-Wall` 会警告你这件事：**它不报**，只能靠设计。

## 二、`override` 与 `final`：把"我以为在重写"变成编译错误

```cpp
struct Base { virtual void over(int); void hidden(int); };
struct Derived : Base { void over(int) override; void hidden(double); };
```

```text
Derived::hidden(double) —— 把基类同名函数全隐藏了
```

`d.hidden(1)` 传的是 `int`，却调到了 `Derived::hidden(double)`——因为**只要派生类声明了同名函数，基类的全部同名重载就被隐藏**（不是被重载进来）。想保留就要 `using Base::hidden;`。

而 `override` 的作用就是让编译器检查三件事：基类确有同名同参的虚函数、签名完全一致、确实是虚函数。漏写 `override` 时 `-Wsuggest-override` 会提醒；写错签名（少个 `const`、参数类型不同）则**直接编译失败**。

`final` 有两处用途：

```cpp
struct Leaf final : Base { };          // 不可再派生
void f() override final;               // 不可再重写
```

配合上一节的实测：给叶子类标 `final` 后，编译器可以**去虚化**（5000 万次调用从 102ms 降到 0ms）。

## 三、虚函数的默认参数按静态类型取

```cpp
struct A2 { virtual void f(int x = 1) { printf("A2::f x=%d\n", x); } };
struct B2 : A2 { void f(int x = 99) override { printf("B2::f x=%d\n", x); } };

A2 *p = new B2();
p->f();
```

```text
B2::f x=1
```

**函数体来自派生类（动态绑定），默认参数却来自静态类型 `A2`（编译期决定）**——于是 `x=1` 而不是 99。这是 C++ 里最阴的坑之一，因为编译器**一声不吭**。

规矩：**虚函数永远不要写默认参数**。需要默认值就在基类里提供非虚的重载转发：

```cpp
struct Shape {
    virtual void draw(Flags f) = 0;              // 虚函数不带默认值
    void draw() { draw(Flags::Normal); }         // 非虚便捷重载
};
```

## 四、对象切片：72 字节被压成 8 字节

```cpp
struct Big : Base { int extra[16]; };
Big big;
Base byValue = big;      // 按值拷贝基类 ⇒ 切片
byValue.virt();
Base &byRef = big;       // 引用不切片
byRef.virt();
```

```text
sizeof(Big)=72 sizeof(Base)=8
Base::virt          ← 按值拷贝出来的对象只剩 Base 子对象
```

`sizeof` 从 72 掉到 8 就是切片的直接证据：**派生类的数据和 vptr 都没被拷过去**（`Big` 没有重写 `virt`，所以这里看不出行为差异；换成上一节那个 `Derived` 就会看到"本该是派生类行为，结果调了基类版本"）。引用和指针不会切片：

```cpp
Base &byRef = big;   // vptr 仍指向 Big，多态完整
```

切片发生在**任何按值传递/拷贝基类对象**的地方：`vector<Base>` 存派生类、函数参数 `void f(Base b)`、`Base arr[10]`。它的危险在于**编译通过、运行不崩、只是行为不对**。

现代对策（按优先级）：

1. **别用继承做多态容器**，改用 `std::variant<Circle, Square>` + `std::visit`（值语义、无堆分配、无切片、可 `constexpr`）。
2. 必须用基类容器时，存**智能指针**：`std::vector<std::unique_ptr<Shape>>`。
3. 需要"按值复制多态对象"就用 **Clone 惯用法**：`virtual std::unique_ptr<Shape> clone() const = 0;`（下一节的协变返回是它的基础）。
4. 设计基类时把拷贝构造/赋值 `= delete`，从根上禁止切片。

## 五、协变返回类型与接口基类

```cpp
struct Shape  { virtual Shape  *clone() { return new Shape; } };
struct Circle : Shape  {         Shape  *clone() override { return new Circle; } };
```

实测 `Circle::clone` 被正确调用。协变返回允许派生类返回**更派生**的指针/引用（`Circle*` 可以替代 `Shape*`），这让克隆接口既多态又保留具体类型（C++20 起还能协变智能指针）。

**纯虚析构 + 接口**：

```cpp
struct Iface { virtual ~Iface() = 0; };
Iface::~Iface() { printf("接口基类析构仍被调用\n"); }
struct Impl : Iface { ~Impl() override { printf("Impl 析构\n"); } };
```

```text
Impl 析构
接口基类析构仍被调用
```

要点：**纯虚析构必须有定义**，因为派生类析构一定会链式调用它。这个模式用来做"不能实例化的抽象接口"。

## 六、什么时候该用继承

判据只有一条：**是否存在"通过基类接口操作不同实现"的真实需求**（里氏替换：任何用 `Base&` 能成立的代码，换成 `Derived&` 也必须成立）。

| 你想做的事 | 正确工具 |
| --- | --- |
| 复用代码 | 组合 / 继承实现（private 继承）/ CRTP |
| 定义可替换的接口 | 公有继承纯虚基类 |
| 一组固定的类型分支 | `std::variant` + `visit` |
| 编译期多态（零开销） | 模板 / CRTP / concepts 约束 |
| 只是想要个名字空间 | 嵌套类或 `namespace` |

**"protected 成员 + 继承复用"几乎总是设计腐化的开始**：基类内部一改，所有派生类重测。Qt 里大量继承是框架要求（`QObject` 派生），但你自己写的业务类应当优先组合。

## 七、编译器能帮你到哪

实测这次只抓到一条：

```text
warning: deleting object of polymorphic class type 'A2' which has non-virtual
         destructor might cause undefined behavior [-Wdelete-non-virtual-dtor]
```

`delete` 一个有虚函数但没虚析构的基类指针，GCC 会明确警告——这条务必 `-Werror`。而**构造期虚调用**、**虚函数默认参数**、**名字隐藏**这三类，GCC 默认完全沉默。所以：

```bash
-Wall -Wextra -Wsuggest-override -Werror=suggest-override \
-Werror=delete-non-virtual-dtor -Wshadow -Wold-style-cast
```

`-Wold-style-cast` 在 C++ 项目里能逼出 `static_cast`/`dynamic_cast` 的显式意图，值得开。

## 八、这一节的自查清单

- [ ] 所有重写都写 `override`，叶子类写 `final`
- [ ] 虚函数不写默认参数
- [ ] 多态基类必须有 `virtual` 析构（或 `= delete` 析构禁止删除）
- [ ] 不在构造/析构函数里调用虚函数（需要就两阶段初始化）
- [ ] 容器不存基类值；用 `variant` 或 `unique_ptr` 基类
- [ ] 不想被切片就把基类拷贝操作 `= delete`
- [ ] 优先组合，继承只在真有替换需求时用
- [ ] 派生类里新增同名函数时记得 `using Base::name;` 以免意外隐藏
- [ ] 开 `-Wsuggest-override` 和 `-Wdelete-non-virtual-dtor` 并当错误处理

下一节讲移动语义与完美转发：值类别的判定、`std::move` 到底做了什么、为什么移动后对象必须可用，以及转发引用在哪些场景下反而更慢。
