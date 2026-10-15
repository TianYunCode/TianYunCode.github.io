---
title: 智能指针与所有权
description: unique_ptr 真的是零开销吗、make_shared 省掉的那次分配是什么、循环引用怎么把对象留在内存里——用 sizeof 和 new 计数器实测。
date: 2026-10-15
tags: [C++, 智能指针, RAII]
category: cpp
section: cpp-smart-ptr
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++17`。本节所有数字来自重写的 `operator new` 计数器和 `sizeof` 实测。

## 一、先量大小：智能指针的开销到底在哪

```text
裸指针=8  unique_ptr=8  unique_ptr+函数指针删除器=16  shared_ptr=16  weak_ptr=16
```

| 类型 | 大小（本机） | 里面装了什么 |
| --- | --- | --- |
| `T*` | 8 | 只有地址 |
| `unique_ptr<T>` | 8 | 只有地址——**默认删除器是空类，被 EBO 优化掉了**（上一节讲过空基类优化） |
| `unique_ptr<T, void(*)(T*)>` | 16 | 地址 + 函数指针 |
| `shared_ptr<T>` | 16 | 对象指针 + 控制块指针 |
| `weak_ptr<T>` | 16 | 同上 |

结论很重要：**默认配置的 `unique_ptr` 与裸指针完全同宽、同速**，用它没有任何性能借口。而 `shared_ptr` 是两倍大小，还多一次间接寻址（访问控制块里的计数）。

删除器如果是**无状态类型**（函数指针以外的仿函数、lambda 捕获为空），大小不变；一旦捕获了数据，`unique_ptr` 就会变大——所以优先用"类型即删除器"的仿函数，而不是 `std::function`（后者还要额外堆分配）。

## 二、`unique_ptr`：独占所有权，不可拷贝

```cpp
auto a = std::make_unique<T>();
auto b = a;          // ❌
auto c = std::move(a);   // ✅ 转移所有权，a 变空
```

```text
error: use of deleted function 'std::unique_ptr<_Tp, _Dp>::unique_ptr(const std::unique_ptr<_Tp, _Dp>&)'
```

拷贝构造被 `= delete`，只能移动。这是**用类型系统表达"所有权"**：一个资源只有一个主人。三条实践：

1. **工厂函数返回 `unique_ptr`**，调用方决定留在本地（`unique_ptr`）还是转成共享（隐式转 `shared_ptr`）。
2. **函数参数**：只是"借用"就传 `T&` 或 `T*`（可空时用指针），**绝不要传 `const unique_ptr<T>&`**——那等于强迫调用方交出所有权模型。
3. `unique_ptr<T[]>` 才会调 `delete[]`，别用 `unique_ptr<T>` 管数组。

自定义删除器的真实用途是**非 new 的资源**：

```cpp
struct FileDeleter { void operator()(FILE *f) const { if (f) std::fclose(f); } };
std::unique_ptr<FILE, FileDeleter> fp(std::fopen(path, "r"));
```

实测一个细节：`fopen` 失败返回 `NULL` 时，`unique_ptr` **照样构造成功**，只是持有空指针：

```text
指针为空=1（fopen 失败，unique_ptr 仍持有 nullptr）
```

所以**接管可能返回空的资源后，仍然要判空**——`if (!fp) return err;`。智能指针管的是"释放"，不管"分配是否成功"。

## 三、`shared_ptr`：省不掉的那次分配

```cpp
g_new = 0; { auto a = std::shared_ptr<Payload>(new Payload(1)); auto b = a; }
g_new = 0; { auto a = std::make_shared<Payload>(1);           auto b = a; }
```

```text
shared_ptr(new T) : new 2 次, delete 2 次
make_shared<T>()  : new 1 次, delete 1 次
```

`shared_ptr(T*)` 要**两次堆分配**：一次给你的对象，一次给控制块（引用计数、弱计数、删除器、分配器）。`make_shared` 把两者合并成一块。所以：

- **默认用 `make_shared`**：少一次分配、异常安全（下面解释）、代码更短。
- 什么时候**不该**用：① 对象极大且存在 `weak_ptr` 长期存活时——合并分配意味着**只要还有 `weak_ptr`，对象的内存就不会归还**，即使对象已析构；② 需要自定义删除器（`make_shared` 不支持）；③ 类构造函数是 `private`（`make_shared` 无法访问）。

### 为什么 `f(shared_ptr<T>(new T), g())` 有泄漏风险

C++17 之前，参数求值顺序未定，编译器可能按 `new T` → `g()`（`g` 里抛异常）→ 构造 `shared_ptr` 的顺序执行，`new T` 就泄漏了。用 `make_shared` 则不存在这个窗口（分配与包装在同一表达式内完成）。C++17 收紧了规则，但**"用 make_*"仍是默认正确答案**。

## 四、引用计数与循环：实测泄漏

```cpp
struct Link : Counted { std::shared_ptr<Link> next; std::weak_ptr<Link> wnext; };
auto a = std::make_shared<Link>(), b = std::make_shared<Link>();
a->next = b;  b->next = a;      // 强引用成环
```

离开作用域后：

```text
成环后 alive=2
离开作用域后 alive=2 ← 泄漏（对象没被析构）
改用 weak_ptr 之后 alive=0 ← 正常归零
```

**引用计数永远处理不了环。** 规则：

- **拥有关系向下用 `shared_ptr`，回指用 `weak_ptr`**（父指子=强，子指父=弱；观察者指主题=弱）。
- `weak_ptr` 不增加强计数，但能通过 `expired()` 感知状态：

  ```text
  初始 use_count=1  拷贝一次后=2  改指别处后=1
  weak_ptr 不计数：use_count=1，但 expired=0
  ```

- `weak_ptr` 不能直接用，必须 `lock()` 提升成 `shared_ptr`（提升期间对象保证不被释放），或者 C++17 的 `std::enable_shared_from_this`（内部就是弱计数）。
- 注意 `use_count()` 的返回值只是**瞬时快照**，多线程下你读到 2、下一秒可能已经是 1；控制块里的计数本身是原子的，但"读计数然后据此决定行为"这个模式不安全。

## 五、`shared_ptr` 的线程安全边界

常被误解，说清楚：

| 操作 | 是否安全 |
| --- | --- |
| 多个线程读**不同** `shared_ptr` 实例（指向同一对象） | 安全（计数原子） |
| 一个线程改**同一个** `shared_ptr` 变量（reset/赋值），另一线程读它 | **不安全**，要加锁或用 `atomic_load/store`（C++20 起用 `std::atomic<std::shared_ptr<T>>`） |
| 通过共享指针访问**所指对象**的成员 | 与智能指针无关，对象自己需要保护 |

一句话：**`shared_ptr` 保证控制块线程安全，不保证你管的资源线程安全。**

## 六、`enable_shared_from_this`：什么时候会崩

```cpp
struct Session : std::enable_shared_from_this<Session> {
    std::shared_ptr<Session> self() { return shared_from_this(); }
};
Session s;                       // 栈上对象
auto p = s.self();               // ❌ std::bad_weak_ptr
```

`shared_from_this` 依赖控制块里那个弱引用，**只有当对象确实由 `shared_ptr` 托管时才有效**。栈对象、`unique_ptr` 管理的对象、构造函数里调用，都会抛 `bad_weak_ptr`（构造函数里是因为此刻所有权还没建立）。

对策：构造函数保持私有，提供 `static create()` 返回 `shared_ptr`，从设计上杜绝"没被托管"的情况。

## 七、选择顺序（决策树）

```
需要动态所有权吗？
├─ 不需要 → 直接用成员/栈对象/引用（大多数情况）
└─ 需要
   ├─ 单一所有者 → unique_ptr（默认）
   │   └─ 要转移所有权？用 std::move 传出；函数只是借用就收 T&/T*
   ├─ 共享所有权 → shared_ptr + make_shared
   │   └─ 有回指/观察者 → 那一侧改 weak_ptr
   └─ 需要引用语义 + 可空 + 不拥有 → 裸指针 T*（或 C++20 std::span / string_view）
```

补充两条现代建议：

- **能用值就别用指针**：`std::vector<Widget>` 优于 `std::vector<std::unique_ptr<Widget>>`，后者只在需要多态、地址稳定或对象很大时才值得。
- `optional<T>` 常常替掉"可能为空的指针"，少一次分配也少一层所有权问题。

## 八、这一节的自查清单

- [ ] 项目里搜不到裸 `new`/`delete`（除了实现自定义容器/删除器的地方）
- [ ] 默认用 `make_unique`/`make_shared`，知道 `make_shared` 不适用的三种场景
- [ ] 只借用不拥有的参数写 `T&` / `T*`，不写 `const shared_ptr<T>&`
- [ ] 所有回指、观察者、缓存都用 `weak_ptr`，杜绝环
- [ ] 接管可能返回空的资源（`fopen`/`malloc`）后仍判空
- [ ] 无状态删除器优先，避免 `std::function` 带来的额外分配
- [ ] 跨线程读写同一个 `shared_ptr` 变量要加锁或用 atomic 版本
- [ ] `enable_shared_from_this` 的类把构造函数设私有的 + 提供 `create()`
- [ ] 需要多态时才付 `shared_ptr`/虚函数的代价，否则用值语义

下一节讲模板与泛型：推导规则、特化与 SFINAE、C++20 concepts 怎么把模板错误信息从二十行缩到一行。
