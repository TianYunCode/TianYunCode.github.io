---
title: 移动语义与完美转发
description: std::move 一个字节都不搬、被移动对象必须处于"有效但未定"状态、return std::move(local) 会让复制消除退化成一次移动——全部用计数器实测。
date: 2026-10-15
tags: [C++, 移动语义, 完美转发]
category: cpp
section: cpp-move
---

> 环境：**GCC 13.1.0**，`g++ -std=c++17 -O2 -Wall`。下面每个计数都是给类型加上带计数器的拷贝/移动构造后实测出来的。

## 一、值类别：先学会问"它是谁"

值类别不是类型的属性，而是**表达式**的属性。判定只看两点：能不能取地址、能不能被延续使用。

```cpp
int x = 1;
std::is_lvalue_reference_v<decltype(x)>          // 0
std::is_lvalue_reference_v<decltype((x))>        // 1
std::is_lvalue_reference_v<decltype(std::move(x))>  // 0
```

```text
is_lvalue_ref<decltype(x)>=0  is_lvalue_ref<decltype((x))>=1  is_lvalue_ref<decltype(std::move(x))>=0
is_rvalue_ref<int&&>=1
```

三条要背下来的规则：

1. **具名变量永远是左值**，哪怕它的类型是 `int&&`（`void f(int &&rr)` 里的 `rr` 是左值！这就是转发存在的理由）。
2. **加一层括号就变左值**：`decltype(x)` 是 `int`，但 `decltype((x))` 是 `int&`。宏和模板里踩这个坑非常多。
3. `std::move(x)` 的结果是**右值引用**（xvalue），不是"移动后的 x"。

## 二、`std::move` 一个字节都不搬

它的定义本质上就是：

```cpp
template <class T> constexpr typename std::remove_reference<T>::type &&move(T &&v) noexcept {
    return static_cast<typename std::remove_reference<T>::type &&>(v);
}
```

**只是一个 `static_cast`。** 真正搬东西的是移动构造函数，而移动构造只有在重载决议选中它时才会被调用。对没有移动构造的类型：

```cpp
NoMove a;                       // 只有拷贝构造
NoMove b = std::move(a);        // 看起来是移动
```

```text
对没有移动构造的类型 std::move：拷贝 1 次
```

**照样拷贝**。`std::move` 只是把实参标成右值去"尝试"匹配移动重载，匹配不上就退回拷贝。所以：

- 看到 `std::move` 不等于没有拷贝，要用 `-ftime-report`、计数器或 `static_assert` 验证。
- 给自己管理的类**必须真的写移动构造**，否则所有 `std::move` 都是空操作（而且写了析构函数还会隐式抑制移动生成——上一节的五法则）。

## 三、被移动后的对象：有效但未定

```cpp
std::string s(200, 'x');
std::string t = std::move(s);
s += "abc";                     // 合法
std::vector<int> v1(100), v2 = std::move(v1);
v1.push_back(7);                // 合法
```

```text
源 string size=3（+= 之后）
源 vector size=1，v2 size=100
```

标准的要求是：**移动之后源对象必须处于"有效但未指定"的状态**——可以析构、可以重新赋值、可以 `push_back`，但**它的值不能假设**。libstdc++ 的实现是把源置空（size=0），这是实现细节，不是承诺。

所以：

- **不要读 moved-from 对象的值**（`s.size()`、`s[0]` 都是自找 bug）。
- 允许对它做的：析构、赋值、调用"对任意状态都成立"的操作（`clear()`、`push_back()`）。
- 复用 moved-from 对象前**先重新赋值**，别指望它是"空串"。

（顺带一个彩蛋：上面那行 `printf` 我写成 `printf("%zu ... %zu", s.size(), (s += "abc", s.size()))`，本机两列都打印 3——因为**函数实参求值顺序未规定**，GCC 从右往左算，先执行了 `+=`。这正是 C 专栏第一节那条规则的现场复现。）

## 四、转发引用与 `std::forward`：值类别的保真传输

```cpp
void sink(const Counted &) { /* 左值路径 */ }
void sink(Counted &&)      { /* 右值路径 */ }

template <class T> void forwarder(T &&v) { sink(std::forward<T>(v)); }   // ✅
template <class T> void bad_fwd(T v)     { sink(v); }                    // ❌ 忘了转发
```

各调 1000 次：

```text
forwarder(左值)  ：绑定 const& 1000 次，绑定 && 0 次
forwarder(右值)  ：绑定 const& 0 次，绑定 && 1000 次
bad_fwd(右值)    ：绑定 const& 1000 次，绑定 && 0 次 ← 值类别丢失
```

`bad_fwd(T v)` 的问题：参数 `v` 是**具名变量**，所以永远是左值，即使调用方传的是右值——多出来的那次绑定就是"本该移动却变成按 const& 处理"。

`std::forward<T>(v)` 做的事：`T` 推导为 `Counted&` 时产生左值，`T` 推导为 `Counted` 时产生右值。**"完美"指的是值类别保真**。

### 什么时候按值 + `std::move` 反而更好

```cpp
template <class T> void byval(T v) { sink(std::move(v)); }
```

```text
byval(左值)：绑定 && 1000 次（外加按值传参自身的一次构造）
```

按值传参会**无条件多一次构造**，所以默认还是用 `T&&` + `forward`。只有"参数一定要存下来一份"（setter、`push_back` 包装）时，按值 + move 才更简单。

### 转发引用的四个失效场景

1. **花括号初始化列表**推不出 `T`：`f({1,2,3})` 直接编译失败。
2. **`nullptr` / 裸数组字面量**：`T` 推导结果可能不是你要的类型。
3. **位域**不能绑到 `T&&`（取不了引用）。
4. **只有一处使用**却写成模板：白白把实现暴露到头文件里。能用 `const T&` / `T*` 解决的别上转发引用。

## 五、返回值：`std::move(local)` 是负优化

```cpp
NRVO make_good() { NRVO local; return local; }
NRVO make_bad()  { NRVO local; return std::move(local); }
```

```text
return local;        拷贝 0 移动 0
return std::move(x); 拷贝 0 移动 1 ← 挡住了复制消除
```

直接 `return local` 时，编译器做 **NRVO（具名返回值优化）**，对象原地构造，**一次构造都没有**。而 `std::move(local)` 强制表达式变右值，反而**禁止**了复制消除，退化成一次移动构造。

编译器还会直接骂你：

```text
warning: moving a local object in a return statement prevents copy elision [-Wpessimizing-move]
```

规则：

- **返回局部对象：直接 `return x;`**，永远不要 `std::move`。
- 返回**成员**、**函数内 static**、**基类子对象**时不能 NRVO，这时才写 `return std::move(member);`。
- 返回**按值类型的形参**：`return std::move(param);` 是对的（形参不是调用方的对象）。
- C++17 的**保证复制消除**只针对 prvalue（`return T{}`），不针对具名变量，别混淆。

把 `-Wpessimizing-move` 和 `-Wuse-after-move` 加进构建，这两类错误基本能一网打尽。

## 六、移动该不该做：判据

移动只在**拷贝确实贵**时才有意义。实测下来：

| 类型 | 拷贝成本 | 移动收益 |
| --- | --- | --- |
| `int`、`double`、指针、小 `struct` | 一条 `mov` | **没有**，反而多一次"置空源"的操作 |
| `std::string`（≤15 字符，SSO） | 一次栈内 memcpy | 很小，且移动要处理"缓冲在对象内"的复杂情况 |
| `std::string`（长） / `vector` / `unique_ptr` | 堆分配 + 全量复制 | **巨大**，就是指针交换 |
| 大数组成员的结构体 | memcpy 几 KB | 巨大 |

所以：

- 小对象**按值传**，别写 `std::move`（`void f(Point p)` 比 `void f(Point &&p)` 更好）。
- 容器元素是小的平凡类型时，`std::vector` 的扩容搬移本来就用 `memmove`，不需要你操心。
- 判断"值不值得移动"的机器化写法：`if constexpr (std::is_trivially_copyable_v<T>)` 走按值，否则走移动。

## 七、这一节的自查清单

- [ ] 记住"具名即左值"，转发前问自己 `T` 推导成了什么
- [ ] 自定义类要真的写移动构造/赋值，并标 `noexcept`
- [ ] 不读 moved-from 对象的值，用前先重新赋值
- [ ] 转发一律 `std::forward<T>(x)`，不用 `std::move(x)`
- [ ] 返回局部对象写 `return x;`，不写 `std::move`
- [ ] 开 `-Wpessimizing-move` 与 `-Wuse-after-move`
- [ ] 小平凡类型按值传，别为了"看起来现代"加移动
- [ ] 用计数器或 `static_assert` 验证移动真的发生了
- [ ] 模板实现放手文件时，考虑用 `if constexpr` 替代部分 SFINAE

下一节讲 RAII 与资源管理三法则：为什么"构造函数成功后资源就一定被释放"是 C++ 唯一可靠的所有权模型，以及 `std::scoped_lock`、`gsl::finally`、退出回调这些把 RAII 用到极致的写法。
