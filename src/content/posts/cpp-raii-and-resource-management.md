---
title: RAII 与资源管理实战
description: 构造中途抛异常时哪些资源会被释放、手写一个 20 行的 scope guard、非虚析构 delete 让派生类析构次数为 0，以及 rule of zero 到底怎么落地。
date: 2026-10-15
tags: [C++, RAII, 资源管理]
category: cpp
section: cpp-raii
---

> 环境：**GCC 13.1.0**，`g++ -std=c++20 -O2 -Wall`。上一节讲了移动与转发，这一节把"资源一定被释放"这件事做到底。

## 一、RAII 的核心承诺：构造成功 ⇒ 析构一定发生

```cpp
struct Part { int n; Part(int i) : n(i) { ++ctor_done; } ~Part() { ++dtor_done; } };
struct Half {
    Part a{1};
    Part b{2};
    Half() { throw std::runtime_error("构造失败"); }
};
try { Half h; } catch (...) { }
```

```text
成员构造 2 个，异常后析构 2 个
```

标准的规则是：**只有"已完整构造"的子对象会被析构**。所以：

- 基类子对象、已构造的成员 → 一定会析构，**这就是它们安全的原因**。
- 构造函数**函数体内**用裸 `new`/`fopen`/`CreateFile` 拿到的资源 → **不会**自动释放，抛异常就是泄漏。
- 半构造对象里被虚函数调用到 → 上一节说过，那时 vptr 还指向当前正在构造的那一层的虚表。

推论：**资源获取必须放进一个对象的构造里**（成员或局部 RAII 对象），不要"先 `new` 再存进成员"。写 `std::unique_ptr<T> p;` 然后在构造函数体里 `p = std::make_unique<T>()` 是错的顺序——`make_unique` 抛异常时 `p` 还没构造，但更常见的问题是"两个资源之间有抛出点"。正确做法是全部走成员初始化列表 + 智能指针/RAII 类型。

## 二、Rule of Zero：默认才是最优解

三法则/五法则（第二节讲过）的**真正结论是"尽量一个都别写"**：

```cpp
class Config {                       // ✅ rule of zero：0 个特殊函数
    std::string path;
    std::vector<int> values;
    std::unique_ptr<Logger> logger;  // 拥有
public:
    Config(std::string p) : path(std::move(p)) {}
    // 拷贝、移动、析构全部由编译器生成，且都正确
};
```

只要每个成员自己管好自己的资源，容器类的五个特殊函数就**不需要写**。要写它们，说明你的类里还有裸资源——那第一件事是把它换成 RAII 类型，而不是补拷贝构造。

**必须手写**的三种情况：① 封装平台句柄（`HANDLE`、`int fd`、`SDL_Window*`）；② 需要 Pimpl 隐藏编译依赖；③ 自定义内存池/映射。

## 三、句柄封装：一个模板搞定所有 C API

```cpp
template <class H, auto Close, H Invalid = nullptr>
class handle {
    H h_ = Invalid;
public:
    handle() = default;
    explicit handle(H h) : h_(h) {}
    ~handle() { if (h_ != Invalid) Close(h_); }

    handle(const handle &) = delete;             // 句柄不共享
    handle &operator=(const handle &) = delete;
    handle(handle &&o) noexcept : h_(std::exchange(o.h_, Invalid)) {}
    handle &operator=(handle &&o) noexcept {
        if (this != &o) { if (h_ != Invalid) Close(h_); h_ = std::exchange(o.h_, Invalid); }
        return *this;
    }

    H get() const { return h_; }
    explicit operator bool() const { return h_ != Invalid; }
    H release() { return std::exchange(h_, Invalid); }
    void reset() { if (h_ != Invalid) { Close(h_); h_ = Invalid; } }
};

using file_handle = handle<FILE *, std::fclose>;
using fd_handle   = handle<int, ::close, -1>;      // POSIX
```

四个细节都必要：

1. **`std::exchange` 取走并置无效**，保证移动后源对象析构时不重复关闭。
2. **移动赋值要自赋值检查**（`this != &o`），否则 `h = std::move(h)` 会先关掉自己再使用无效值。
3. `release()` 交出所有权（对应 `unique_ptr::release` 的语义）。
4. `operator bool` 是 `explicit`，避免 `if (h == true)` 之类的怪事。

Qt 里几乎用不上这个（`QObject` 树已经做了父子所有权），但**Win32 句柄、COM 指针、平台 API 资源**必须自己包，否则每个 `return` 都要记得 `CloseHandle`。

## 四、scope guard：把"退出时一定做某事"写成一行

```cpp
template <class F> struct Final {
    F f;
    explicit Final(F fn) : f(std::move(fn)) {}
    ~Final() { f(); }
};
template <class F> Final(F) -> Final<F>;      // C++17 CTAD 推导指引
```

用法：

```cpp
{
    Handle h(1);
    Final guard([&] { h.close(); });
    ...                                      // 无论正常退出、return 还是抛异常
}
```

```text
离开作用域自动释放：acquired=1 released=1
```

`Final(F) -> Final<F>` 是**推导指引**，没有它就得写 `Final<decltype(fn)>`。这个模式等价于 `gsl::finally`、`boost::scope_exit`，也等价于 Rust 的 `Drop`。

典型用途：解锁、回滚事务、释放临时文件、恢复全局状态、错误路径统一清理——比 `goto cleanup` 更适合 C++（因为有异常路径）。

**注意**：guard 里的 lambda **默认不应抛异常**（析构里抛 = terminate，上一节实测）。要记录失败就先捕获、写日志，别往外抛。

## 五、锁也是资源

```cpp
std::mutex m;
m.lock();                 // ❌ 中途 return/抛异常就永久死锁
do_work();
m.unlock();

std::lock_guard lk(m);    // ✅ 作用域结束自动解锁
std::scoped_lock l2(m1, m2);   // ✅ 多锁，内部用避免死锁的算法
{
    std::lock_guard lk2(m);
    cv.wait(lk2, pred);   // wait 内部临时解锁再重新加锁
}
```

三条：

- **永远不要裸 `lock()`/`unlock()`**，除非你在实现 RAII 类型本身。
- 多把锁一律 `std::scoped_lock`（C++17），它用 `std::lock` 的退避算法避免死锁顺序问题。
- `std::unique_lock` 比 `lock_guard` 灵活（可延迟加锁、可转移、可配合条件变量），代价是多一个 bool 状态。默认用 `lock_guard`，需要灵活性再换。
- C++20 还有 `std::scoped_lock` 的 `std::adopt_lock`/`defer_lock` 变体，以及 `std::jthread`（析构自动 `request_stop` + `join`，解决 `std::thread` 析构不 join 就 terminate 的坑）。

## 六、非虚析构 + `delete` 基类指针：派生类析构次数为 0

```cpp
struct PBaseNoVirt { ~PBaseNoVirt() { ++base_dtor; } };
struct PDer : PBaseNoVirt { ~PDer() { ++derived_dtor; } };

delete static_cast<PBaseNoVirt *>(new PDer());
```

```text
基类析构 1 次，派生类析构 0 次 ← 派生类没被调用（UB）
```

派生类的资源**完全没释放**，而且这是未定义行为（不是"只漏一点"）。编译器只在**有虚函数但析构非虚**时警告：

```text
warning: deleting object of polymorphic class type 'A2' which has non-virtual
         destructor might cause undefined behavior [-Wdelete-non-virtual-dtor]
```

注意这条警告的盲区：**基类完全没有虚函数时它不报**（因为静态类型上 `delete` 派生指针是合法的）。所以规矩只能是：

- 打算被继承并多态使用 → `virtual ~Base() = default;`
- 不打算被多态删除 → 把析构设为 `protected`（或 `= delete`），从设计上禁止 `delete basePtr`：

  ```cpp
  struct Base {
  protected:
      ~Base() = default;      // 只能作为成员/栈对象/被派生类自己析构
  };
  ```

## 七、这一节的自查清单

- [ ] 每个类先争取做到 rule of zero，写不出来说明还有裸资源没被封装
- [ ] 资源获取放进成员/RAII 对象的构造，构造函数体内不留"两个获取之间的抛出点"
- [ ] 句柄类：删除拷贝、移动用 `std::exchange` 置无效、移动赋值检查自赋值
- [ ] 退出清理用 scope guard（`Final{[&]{...}}`），别写一堆重复的 `cleanup()`
- [ ] 锁一律 `lock_guard`/`scoped_lock`，多锁必 `scoped_lock`
- [ ] 线程用 `std::jthread`，或确保所有路径都 `join`/`detach`
- [ ] 多态基类虚析构；不想被多态删除的基类把析构设 `protected`
- [ ] 开 `-Wdelete-non-virtual-dtor` 并当错误
- [ ] guard/析构里绝不抛异常

下一节讲常用标准库入门：容器与算法的实测性能对照、`operator[]` 与 `find` 的差别、`ranges` 管道为什么不该怕，以及 `std::string`/`string_view`/`span` 的边界。
