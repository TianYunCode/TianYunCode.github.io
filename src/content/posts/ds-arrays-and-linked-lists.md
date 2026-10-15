---
title: 线性表：数组与链表
description: 中间插入 10 万次 list 比 vector 快 216 倍，可反转整个表时 vector 又赢 18 倍，遍历差 33 倍——"数组好还是链表好"没有答案，只有工作负载的答案。
date: 2026-10-15
tags: [数据结构, 链表, 数组]
category: data-structures
section: ds-linear-list
---

> 环境：Windows 11 x64，**GCC 13.1.0**，`g++ -std=c++17 -O2`。所有毫秒、字节数都是本机实测；内存数字通过重写 `operator new` 统计得到。

## 一、两种"线性表"的根本差别

| | 数组 / `std::vector` | 链表 / `std::list` |
| --- | --- | --- |
| 内存 | 一段连续 | 节点分散，靠指针串起来 |
| 随机访问 | `a[i]` 一条地址计算，O(1) | 必须走 i 步，O(n) |
| 尾部插入 | 摊还 O(1) | O(1) |
| **已知位置的插入/删除** | O(n)（后面全搬） | **O(1)**（改两个指针） |
| 迭代器 | 指针，可随机跳 | 只能前/后走 |
| 每元素额外开销 | 摊还约 1.31 次搬移 + 余量 | **每节点 24 字节**（存 1 个 int） |
| 缓存 | 极好 | 极差 |

上一节那个 13 倍的行/列遍历差距说明：**"缓存"这一行不是补充说明，而是主导项。** 下面用实测把两句话都验证一遍。

## 二、链表的主场：它确实能快 200 倍

在 20 万元素的中间位置连续插入 10 万次（持有迭代器，每次插到同一位置之后）：

```cpp
auto it = v.begin() + N / 2;
for (int i = 0; i < 100000; i++) it = v.insert(it, i) + 1;      // vector
auto li = std::next(l.begin(), N / 2);
for (int i = 0; i < 100000; i++) li = l.insert(li, i), ++li;    // list
```

```text
vector.insert 中间  1294.96 ms | list.insert     5.99 ms
```

**216 倍。** 因为 `vector::insert` 每次要把后半部分整体后移（10 万次 × 平均搬 10 万个 int ≈ 400GB 的内存流量），而 `list::insert` 只改三个指针。

所以"vector 总是更好"这句话是错的。**只要满足两个条件，链表就是正解**：① 在序列中间频繁插入/删除；② 你**已经持有位置**（迭代器/指针/句柄），不需要每次从头找。

第 ② 点是关键：如果每次插入前都要先找位置，链表的 O(n) 查找会把 O(1) 插入的优势吃光。

## 三、同一批数据，反转时结果反过来

```cpp
std::reverse(v.begin(), v.end());   // 交换元素
l2.reverse();                       // 逐个改指针
```

```text
vector 交换元素 1.10 ms | list 重接指针 20.23 ms
```

**复杂度上 `list::reverse` 是 O(n) 次指针改写，`std::reverse` 也是 O(n) 次交换，但真实机器上 vector 快 18 倍。** 原因：交换 int 是顺序内存访问（预取友好、可向量化），改指针是**串行依赖的随机访问**，每一步都可能缓存 miss。

再对比遍历求和（500 万个 int）：

```text
vector    1.4 ms | list   45.9 ms | forward_list   46.5 ms
```

**33 倍。** 结论很直白：**链表的 O(1) 只对"已经在节点上"的操作成立，任何"从头部开始走"的操作在链表上都有巨大常数。**

## 四、内存账单（重写 `operator new` 实测）

存 10 万个 `int`（原始数据 400KB）：

```text
vector      : 分配 18 次 / 1048572 字节（含倍增余量）
list        : 分配 100000 次 / 2400000 字节 ⇒ 每节点约 24 字节
forward_list: 分配 100000 次 / 1600000 字节 ⇒ 每节点约 16 字节
```

- `vector`：**18 次分配**（倍增），总占用约 1MB（其中约 31% 是余量），数据连续。
- `std::list`（双向）：每节点 24 字节 = 前指针 8 + 后指针 8 + `int` 4，再按 8 字节对齐补到 24 → **是纯数据的 6 倍**，外加 **10 万次独立分配**（分配器锁竞争、内存碎片、每块还有自己的管理头，实际占用比 24 字节更多）。
- `std::forward_list`（单向）：每节点 16 字节 = 后指针 8 + `int` 4 对齐到 16，省掉一个指针。

**在嵌入式/无堆环境里，这 10 万次分配基本判了 `std::list` 死刑。** 替代方案见第七节。

## 五、手写单链表：三个必会操作

```cpp
struct Node { int v; Node *next; };

Node *push_front(Node *h, int v) { return new Node{v, h}; }

Node *reverse_iter(Node *h) {                       // 三指针反转，O(n) 时间 O(1) 空间
    Node *prev = nullptr;
    while (h) { Node *next = h->next; h->next = prev; prev = h; h = next; }
    return prev;
}
Node *reverse_rec(Node *h) {                        // 递归版：O(n) 栈空间
    if (!h || !h->next) return h;
    Node *rest = reverse_rec(h->next);
    h->next->next = h;
    h->next = nullptr;
    return rest;
}
```

实测输出：

```text
原表：1 2 3 4 5
迭代反转：5 4 3 2 1
递归反转回去：1 2 3 4 5
```

面试和实战都常考的四件事：

1. **反转**（上面的三指针，注意必须先存 `next` 再改链）。
2. **快慢指针**：找中点、判环（Floyd 判圈）、找环入口、删倒数第 k 个。
3. **有序链表合并**：就是归并排序的 merge 步骤，O(n) 且不需要额外数组。
4. **删除节点只给指针**（单链表做不到真正删除，可以用"复制下一个 + 删下一个"伪装，尾节点例外）。

递归反转要清楚它的**栈代价**：n 个节点就是 n 层栈，上一节算过每帧几十字节，链表长过万就可能崩。生产代码用迭代版。

## 六、约瑟夫环：线性表问题的"先算再写"

n 个人围一圈，每数到 k 出列，求最后幸存者。用链表模拟是 O(nk)，但递推是 **O(n) 时间 O(1) 空间**：

```cpp
int josephus(int n, int k) {
    int pos = 0;
    for (int i = 2; i <= n; i++) pos = (pos + k) % i;   // f(i) = (f(i-1) + k) % i
    return pos + 1;
}
```

```text
约瑟夫环 n=41 k=3 → 幸存者是第 31 号
```

（41 人、数到 3 是约瑟夫原问题的经典实例，答案 31 与文献一致。）

教训：**看到"链表"别急着建链表。** 很多线性表问题有纯数学解或数组解，快几个数量级。

## 七、无堆环境下的链表：用数组当指针

嵌入式里既想要 O(1) 中间插入、又不能动态分配，标准做法是**索引式链表**（array-based linked list）：

```c
#define MAX_N   1024
typedef struct { int val; int next; } slot;           /* next = 数组下标，-1 表示结束 */
static slot pool[MAX_N];
static int free_head;                                  /* 空闲链表的头 */

int alloc_slot(void) { int i = free_head; if (i < 0) return -1; free_head = pool[i].next; return i; }
void free_slot(int i) { pool[i].next = free_head; free_head = i; }
```

好处：

- **零动态分配**，全部内存静态预留，碎片问题不存在。
- 节点在数组里，遍历时比 `malloc` 出来的节点**局部性更好**（分配器通常也会连续分配，但索引式可以主动按访问顺序排布）。
- 可以整体 `memcpy` 到 Flash/EEPROM 做持久化，指针换成下标后**跨进程/跨重启依然有效**（真指针会失效）。
- 中断里也能安全操作（没有堆锁问题）。

代价：容量固定、删除后要维护空闲链、没有 STL 的迭代器便利。这是 FreeRTOS/LwIP/许多驱动框架里最常见的结构。

## 八、`std::list` 独有的能力（决定要不要用它）

```cpp
l.splice(pos, other);          // O(1) 把另一条链整体接过来，不复制元素
l.splice(pos, l, it);          // 移动单个节点，迭代器不失效
l.remove_if(pred);             // 成员版，比 erase-remove 更适合链表
l.merge(other); l.sort(cmp);   // 链表版归并/堆排序，O(n log n)，不需要随机访问
l.unique();                    // 相邻去重
```

**`splice` 是 `list` 无可替代的能力**：元素地址和迭代器在移动后依然有效。LRU 缓存（`std::list` + `std::unordered_map<key, iterator>`）、侵入式链表的任务队列、需要"把对象在两个容器间搬移且不失效"的场景，只有它能干净做到。

反过来，`vector` 的元素一搬移所有迭代器/指针全失效——这是设计差异，不是实现缺陷。

## 九、这一节的自查清单

- [ ] 先问"位置从哪来"：有现成迭代器/句柄才考虑链表
- [ ] 主要操作是遍历/查找 → `vector`（实测快 33 倍）
- [ ] 中间频繁插入且持有位置 → `list`（实测快 216 倍）
- [ ] 需要元素地址稳定 + 节点搬移 → `list` + `splice`
- [ ] 内存紧张或无堆 → 索引式链表或固定块池
- [ ] 线性表问题先找数学解/数组解，再考虑建链表
- [ ] 手写链表必测：空表、单节点、头删、尾删、重复反转
- [ ] 反转用迭代版，递归版只在深度有界时用
- [ ] 别把 `std::list` 当"链表"教条：它每节点 24 字节 + 一次独立分配

下一节讲栈与队列：数组栈与链表栈、循环队列的"少用一个位置"技巧、单调栈/单调队列、以及用 `deque` 实现滑动窗口最大值。
