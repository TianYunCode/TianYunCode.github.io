---
title: 堆与优先队列
description: 手写堆的两个比较方向都写反了、30 万次随机操作对拍才抓出来；双堆求流式中位数比每次重算快 3862 倍；k 路归并理论更优却比"拼接再排序"慢 43%。
date: 2026-10-15
tags: [数据结构, 堆, 优先队列]
category: data-structures
section: ds-heap
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++17 -O2`。本节所有实现都做了交叉验证，包括**我自己写错的两处**。

## 一、手写二叉堆：30 行，但两个方向都容易反

```cpp
template <class T>
struct min_heap {
    std::vector<T> a;

    void push(T v) {                                   /* 上浮 */
        a.push_back(std::move(v));
        size_t i = a.size() - 1;
        while (i > 0) {
            size_t p = (i - 1) / 2;
            if (!(a[i] < a[p])) break;                 /* 孩子不小于父亲 → 停 */
            std::swap(a[i], a[p]); i = p;
        }
    }
    T pop() {                                          /* 下沉 */
        T top = a[0];
        a[0] = std::move(a.back()); a.pop_back();
        size_t i = 0, n = a.size();
        while (true) {
            size_t l = 2*i+1, r = 2*i+2, b = i;
            if (l < n && a[l] < a[b]) b = l;           /* 选更小的孩子 */
            if (r < n && a[r] < a[b]) b = r;
            if (b == i) break;
            std::swap(a[i], a[b]); i = b;
        }
        return top;
    }
    bool valid() const { for (size_t i = 1; i < a.size(); i++) if (a[(i-1)/2] > a[i]) return false; return true; }
};
```

### 我把它写错了两次，小样本还测不出来

第一版我用模板比较器 `Cmp`（默认 `std::greater<int>`），结果：

- **上浮写成 `!Cmp()(a[i], a[p])`** → 实际是"孩子 > 父亲才交换"，方向反了。
- **下沉写成 `Cmp()(a[l], a[best])`** → 变成"选较大的孩子"，也反了。

**两处都反，在小规模测试里互相抵消**——我拿 `{5,3,8,1,9,2,7}` 手工跑 4 次弹出，结果和 `std::priority_queue` 完全一致，`valid()` 也全过。看起来"没问题"。

真正的对拍才抓出来：

```text
第 6 次弹出就不一致：手写 884431548 vs 标准 -1198440400，弹出前手写堆大小 4
```

修正两处方向后：

```text
手写小顶堆 vs std::priority_queue（30 万次随机操作）
  弹出序列与不变式全部一致=1，剩余元素数 100132 vs 100132
```

**教训：堆的正确性不能靠"几个数手工验证"。** 必须做两件事：① 每次操作后断言不变式 `valid()`；② 与权威实现（`std::priority_queue`）在**随机操作序列**上比对弹出序列。少了任何一条，两个反向 bug 就能藏住。

## 二、`std::priority_queue` 的三个陷阱

### 陷阱 1：默认是**大顶堆**

```cpp
std::priority_queue<int> a;                        /* 默认 less → 堆顶最大 */
std::priority_queue<int, std::vector<int>, std::greater<int>> b;   /* 小顶堆 */
```

比较器的语义是"**父节点不应排在子节点之后**"，`less` 表示"父 < 子 违规"→ 大顶。这个反直觉命名坑了几乎所有人。**要小顶堆就写 `std::greater<>`**，或者干脆自己封装一个 `using MinHeap = priority_queue<T, vector<T>, greater<T>>`。

### 陷阱 2：没有 `decrease_key`

Dijkstra、Prim、A* 都需要"降低某个元素的优先级"，`priority_queue` 不提供。两种标准对策：

```cpp
/* 方案 A：惰性删除 —— 直接 push 新值，弹出时跳过过期条目 */
if (du > d[u]) continue;

/* 方案 B：用 std::set，先 erase 旧值再 insert 新值 */
s.erase({ d[v], v }); d[v] = nd; s.insert({ d[v], v });
```

方案 A 更常用（代码短、常数小），代价是堆里会有重复条目，内存上界 O(边数)。

### 陷阱 3：`top()` 返回常量引用，`pop()` 不返回元素

```cpp
auto &x = pq.top();    // 拿到的是 const T&
pq.pop();              // x 现在悬空了！pop 会销毁那个元素
```

**必须先拷贝再 pop**：`auto x = pq.top(); pq.pop();`。写成引用是真实的 use-after-free（`std::vector` 尾部元素被析构）。

## 三、`make_heap` 是 O(n)，但只比逐个插入快 1.2 倍

上一节实测：300 万个数，`make_heap` 37.7ms vs 逐个 `push_heap` 45.1ms。

理论上 O(n) vs O(n log n)，为什么只差 1.2 倍？因为 **O(n log n) 是上界，实际增量插入的 sift-up 平均距离是常数**：新元素落在数组末尾，一半情况下它比父亲大（不用动），四分之三情况下最多动一层……期望上浮层数收敛到常数。

`make_heap` 的向下 sift-down 同理：`sum(⌈log₂k⌉/k)` 收敛到 O(n)。

**结论：两者都是线性时间，只差常数。别为了"O(n) 建堆"去改写代码**，除非你的建堆真的在热点上。

## 四、双堆求数据流中位数：实测快 3862 倍

维护一个大顶堆装较小一半、一个小顶堆装较大一半，保持大小差不超过 1，中位数就在两个堆顶：

```cpp
priority_queue<int> lo;                                             /* 较小一半，大顶 */
priority_queue<int, vector<int>, greater<int>> hi;                  /* 较大一半，小顶 */
if (lo.empty() || x <= lo.top()) lo.push(x); else hi.push(x);
if (lo.size() > hi.size() + 1) { hi.push(lo.top()); lo.pop(); }
if (hi.size() > lo.size())     { lo.push(hi.top()); hi.pop(); }
double med = lo.size() > hi.size() ? lo.top() : (lo.top() + hi.top()) / 2.0;
```

20 万个数逐个插入并求中位数，对照"每次用 `nth_element` 现算"：

```text
双堆 10.1 ms | 每次 nth_element 39011.5 ms（中位数之和 100125037334 vs 100125037334）
```

**3862 倍，且两万个中位数之和逐位相同。** 这个"和相同"是关键——它证明两种实现算的是同一个东西（我第一版把朴素实现写成了"取下中位数"，两边定义不同，和自然对不上，改齐定义后才一致）。

复杂度：双堆每次 O(log n)、总 O(n log n)；朴素每次 O(n)、总 O(n²)。

## 五、Dijkstra：三种实现的耗时与一致性

1200 个节点、每点 12 条出边的随机图：

```text
优先队列+惰性删除 0.4 ms | std::set 做 decrease-key 0.8 ms | O(V^2) 线性扫描 1.1 ms
三者距离完全一致=1（源点到各点距离之和 782951）
```

- 稀疏图（E ≈ 12V）用堆：O(E log V)。
- **稠密图用 O(V²) 线性扫描反而更简单**，且当 E ≈ V² 时两者同阶、扫描常数更小。
- 三种实现结果必须一致——**这是唯一能证明你写对了的方式**（`O(V²)` 版几乎不可能写错方向，可以当参照实现）。

判据：`E > V²/log V` 就用扫描版，否则用堆版。

## 六、k 路归并：理论更优，实测更慢

合并 500 个已排序的 2000 元素序列（共 100 万个）：

```text
k 路归并（堆）66.7 ms | 拼接后整体排序 46.5 ms | 结果一致=1（1000000 个元素）
```

**堆做 k 路归并是 O(N log k) = 100万 × 9，整体排序是 O(N log N) = 100万 × 20——理论上一半的比较次数，实测却慢 43%。**

原因：

1. 堆的每次操作都是**随机访问 + 分支不可预测**，而 `std::sort` 是顺序访问、可向量化。
2. 堆里存的是 `tuple<value, list_idx, elem_idx>`，比单个 `int` 大，缓存效率差。
3. 拼接后的数组虽然"看起来无序"，但它是 500 段各自有序的片段，`introsort` 的分区阶段仍比堆的串行弹出友好。

**什么时候 k 路归并才是对的**：① 数据是**流式**的，装不进内存（外部排序的多路归并阶段）；② 各序列来自不同来源（多路数据库游标、多文件合并），必须惰性产出；③ 只要前 M 个结果（M ≪ N），堆可以提前停止。

能全量装进内存时，还有更好的选择：`std::inplace_merge` 两两合并、或 C++23 的 `std::ranges::fold_left`/第三方 `flat_merge`。

## 七、这一节的自查清单

- [ ] 手写堆必须做**随机操作对拍** + 每步断言不变式，手工小样本会骗人
- [ ] 小顶堆写 `std::greater<>`，或者封装成具名类型避免记反
- [ ] `top()` 不要存引用，先拷贝再 `pop()`
- [ ] 需要 decrease-key 就用惰性删除（记得 `if (du > d[u]) continue;`）
- [ ] 稠密图 Dijkstra 用 O(V²) 扫描版，稀疏图用堆版
- [ ] 多种实现之间必须比对结果，不能只测一个
- [ ] 别为了 `make_heap` 的 O(n) 改写代码（实测只差 1.2 倍）
- [ ] 流式/内存受限才用 k 路归并，能全量载入就直接排序
- [ ] 比较"理论更优"的实现时，一定要实测——缓存和分支预测经常翻盘

下一节讲图的存储与遍历：邻接矩阵/邻接表/前向星的空间与速度实测、BFS 与 DFS 的非递归写法、拓扑排序与环检测。
