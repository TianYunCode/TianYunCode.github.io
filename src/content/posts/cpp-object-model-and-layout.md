---
title: 对象模型与内存布局
description: 两条反汇编指令看清虚函数调用的代价——mov (%rcx),%rax 加 jmp *(%rax)；多继承下同一个对象的两个基类指针地址不同；dynamic_cast 比 static_cast 慢 3.7 倍。
date: 2026-10-15
tags: [C++, 对象模型, 虚函数]
category: cpp
section: cpp-object-model
---

> 环境：**GCC 13.1.0**（x86_64，Itanium ABI），`g++ -std=c++17 -O2`。所有 `sizeof`、偏移、耗时和反汇编都是本机实测。不同编译器（MSVC）布局规则不同，但结论方向一致。

## 一、vptr：一个虚函数换来 8 字节

```cpp
struct NoVirt   { int x; void f() {} };
struct Virt     { int x; virtual void f() {} };
struct VirtDtor { virtual ~VirtDtor() = default; };
```

```text
NoVirt{int}=4   Virt{int,vf}=16   VirtDtor(无数据,虚析构)=8
```

- `NoVirt` 只有一个 `int` → 4 字节。
- `Virt` 有虚函数 → 对象开头多一个 **vptr（8 字节）**，加上 `int` 4 字节和 4 字节填充（要按 8 对齐）→ **16 字节**。
- `VirtDtor` **没有任何数据成员**，只写了虚析构 → 8 字节，全是 vptr。

**这条最实用**：一个本来 4 字节的对象，只要它有了第一个虚函数（包括虚析构），立刻翻倍到 8/16 字节。放 100 万个到 `vector` 里，就是 8–12MB 的差别。所以第二节说过的那条要再强调：**不需要多态的基类不要写虚析构**。

## 二、虚调用到底贵在哪：两条指令

```cpp
struct Base { virtual int get() const { return 1; } };
struct Leaf final : Base { int get() const override { return 2; } };

__attribute__((noinline)) int call_virtual(const Base *b) { return b->get(); }
__attribute__((noinline)) int call_static(const Leaf *l)  { return l->get(); }
```

`objdump -d` 的反汇编结果：

```asm
call_virtual(const Base*):
   0:  mov    (%rcx),%rax      ← 从对象里取出 vptr
   3:  rex.W jmp *(%rax)       ← 跳到虚表第 0 项（尾调用）

call_static(const Leaf*):
  10:  mov    $0x2,%eax        ← 调用整个消失了，直接给常量
  15:  ret
```

虚调用是**两次内存依赖的间接访问**：读对象的 vptr，再读虚表槽位。它的真实代价不是"多两条指令"，而是：

1. **无法内联**（编译期不知道跳去哪），优化链在这里断开。
2. **间接跳转难预测**，虚表项散在只读段里，容易分支预测失败。
3. 依赖加载 → 流水线停顿。

5000 万次调用的实测：

```text
经基类指针虚调用 102ms   具体类型直接调用 0ms   结果 100000000/100000000
```

`call_static` 那 0ms 不是测量失败——编译器知道 `Leaf` 是 `final`、对象就是 `Leaf`，于是**去虚化（devirtualization）**，把调用内联再折叠成常量。这正是 C++ 的性能逃生口：

- **叶子类标 `final`**，给编译器去虚化的依据。
- 能拿到具体类型就别绕基类指针。
- 热点虚函数考虑 CRTP（编译期多态，零 vptr）：

  ```cpp
  template <class Derived> struct Shape {
      double area() const { return static_cast<const Derived *>(this)->area_impl(); }
  };
  struct Circle : Shape<Circle> { double r; double area_impl() const { return 3.14159 * r * r; } };
  ```

## 三、多继承：同一个对象，两个不同的地址

```cpp
struct A { int a; virtual void fa() {} };
struct B { int b; virtual void fb() {} };
struct Both : A, B { int c; void fa() override {} void fb() override {} };
```

```text
A=16  B=16  Both(A+B+int)=32
&o=000000a771dff830  (A*)=000000a771dff830  (B*)=000000a771dff840
⇒ B 子对象偏移 16 字节
同一个对象两个基类指针不相等：1
```

布局是这样的：

```
Both 对象（32 字节）
偏移 0   ┌ A::vptr ┐ A::a ┐   ← A 子对象（16 字节）
偏移 16  ┌ B::vptr ┐ B::b ┐   ← B 子对象（16 字节）
偏移 32  ... 实际 Both 还有 int c，被塞进对齐空隙
```

关键结论：

1. **每个带虚函数的基类子对象都有自己的 vptr**，所以 `Both` 有两个虚表指针。
2. **`B*` 的值不等于 `A*` 的值**——编译器在转换时自动加偏移。所以：
   - 把对象以 `A*` 存进容器，再 `static_cast<B*>` 拿出来是**错的**（ unrelated 类型，编译器会直接拒绝；实测报 `invalid static_cast`）。
   - 跨基类转换必须 `dynamic_cast`，或者先回到 `Both*`。
3. 因为地址会变，**多继承 + 虚函数 + 类型擦除**（比如把 `void*` 存进回调）是踩坑重灾区。这也是很多团队规定"禁止实现继承，只允许单继承 + 组合"的底层原因。

## 四、虚继承：为菱形付出的代价

```cpp
struct VB { int v; virtual void vf() {} };
struct Diamond : virtual VB { int d; };
```

```text
Diamond=32
```

`VB` 本身 16 字节，`Diamond` 若按普通继承只要 16+4 对齐到 24；虚继承后是 **32**——多了一个**虚基类指针（vbase ptr）**，因为虚基类子对象的位置要到运行期才确定（放在最终派生类对象的末尾）。

代价还有：访问虚基类的成员要经过 vbase 指针间接寻址；构造顺序变成"虚基类由**最终派生类**负责构造"（这是虚继承唯一的用途：解决菱形继承的重复构造）。

实用建议：**用接口式纯虚基类（无数据）来代替虚继承**，Qt 里也基本不出现虚继承（除了 `QVirtualKeyboard` 之类的少数场景）。真需要"共享一份基类"时，用组合 + 指针。

## 五、成员指针为什么是 16 字节

```text
int A::* = 8   void(A::*)() = 16   void(*)() = 8
```

- 数据成员指针 = 偏移量（8 字节）。
- **成员函数指针 = 16 字节**：因为它要同时记录①函数地址或虚表索引，②`this` 需要调整的偏移（多继承场景），③"这是虚函数还是普通函数"的标志。所以调用成员函数指针比普通函数指针多几步。
- 这也是 `std::function` 存成员函数时开销更大的原因。

**成员函数指针不能当普通函数指针用**（`typedef void(*F)()` 接不住 `&A::f`），回调设计里要么用静态函数 + `void* userData`（C 风格，Qt 的信号槽底层也是这个思路），要么用 `std::function`/lambda 捕获。

## 六、`dynamic_cast` 有多贵

1000 万次 `dynamic_cast<PDerived*>` vs `static_cast`：

```text
dynamic_cast 59ms   static_cast 16ms   命中 10000000/10000000
```

扣掉循环本身的 16ms，`dynamic_cast` 净成本约 **43ms / 1000 万次 ≈ 4ns 一次**，比 `static_cast`（编译期算完，运行期近乎零）慢一个数量级。它在运行期要沿 RTTI 结构比对类型名、遍历继承图。

三条规则：

- **热路径不用 `dynamic_cast`**。需要"知道具体类型"时，给基类加一个 `virtual Kind kind() const`（枚举标签），比 RTTI 快得多且可控。
- 对引用做 `dynamic_cast` 失败会抛 `std::bad_cast`；对指针做则返回 `nullptr`——**两种语义不同，别忘**。
- 关掉 RTTI（`-fno-rtti`）后 `dynamic_cast` 和 `typeid` 都不可用。嵌入式和某些游戏引擎会这么干省空间，此时必须用标签法。

## 七、这一节的自查清单

- [ ] 知道"第一个虚函数（含虚析构）让对象至少变成 8 字节"，不为非多态类加虚函数
- [ ] 叶子类标 `final`，给编译器去虚化的机会
- [ ] 热点虚接口考虑 CRTP 或 `std::variant` + `visit`（编译期多态）
- [ ] 不用多继承携带数据；接口继承用无数据纯虚基类
- [ ] 记住多继承下不同基类指针地址不同，跨兄弟基类转换必须经过派生类或 `dynamic_cast`
- [ ] 避免虚继承，除非确实在解决菱形数据重复
- [ ] 成员函数指针不当普通函数指针用，回调优先 lambda + `std::function`
- [ ] 热路径不用 `dynamic_cast`，用 `kind()` 标签替代
- [ ] 关 RTTI 前确认代码里没有 `dynamic_cast`/`typeid`
- [ ] 布局敏感的对象（要序列化、要和 C 交互）用 `static_assert(std::is_standard_layout_v<T>)` 检查

下一节讲异常与错误处理策略：`noexcept` 到底改变了什么、栈展开的代价、错误码 / `expected` / 异常三种方案怎么选，以及 Qt 里"槽函数抛异常"会发生什么。
