export type Level = '基础' | '进阶' | '高级';

export type Section = {
  id: string;
  title: string;
  level: Level;
  points: string[];
};

export type Category = {
  slug: string;
  title: string;
  en: string;
  summary: string;
  sections: Section[];
};

export const CATEGORIES: Category[] = [
  {
    slug: 'c-language',
    title: 'C 语言',
    en: 'C',
    summary: '从语法骨架到内存模型、未定义行为与受限环境写法，把 C 真正当成一门需要精确理解的语言。',
    sections: [
      { id: 'c-basics', title: '语言骨架：变量、类型与运算符', level: '基础', points: ['关键字、标识符与作用域', '整型/浮点/字符的取值范围与精度损失', '运算符优先级、结合性与求值顺序', '隐式提升与显式转换的坑'] },
      { id: 'c-control', title: '流程控制与函数', level: '基础', points: ['if/switch 的常见陷阱与 fallthrough', '循环边界与 break/continue/goto', '函数声明、定义与前置声明', '递归、栈帧与尾递归'] },
      { id: 'c-array-string', title: '数组与字符串', level: '基础', points: ['一维/多维数组的内存布局', '数组名退化（decay）与指针的区别', '字符数组与 \0 终止符', '越界访问为什么"看起来能用"'] },
      { id: 'c-struct-union', title: '结构体、联合体与枚举', level: '基础', points: ['结构体定义、嵌套与自引用', '点/箭头运算符与成员访问', '联合体的类型双关与字节序', '枚举做常量组与状态机'] },
      { id: 'c-preprocess', title: '预处理与编译四阶段', level: '基础', points: ['预处理→编译→汇编→链接各做什么', '#define 宏的参数括号与副作用', '条件编译与平台分支', '头文件守卫、包含顺序与循环包含'] },
      { id: 'c-pointer', title: '指针与内存模型', level: '进阶', points: ['指针算术与数组等价关系', '多级指针与指针的指针', 'void* 与类型擦除的回调设计', '函数指针、回调表与跳转表'] },
      { id: 'c-stdlib', title: '标准库常用设施', level: '进阶', points: ['string.h 全表与长度语义', 'snprintf 安全格式化与解析', 'stdlib 的转换、伪随机与搜索排序', 'errno 的正确用法与线程安全'] },
      { id: 'c-memory', title: '动态内存与对象生命周期', level: '进阶', points: ['malloc/calloc/realloc/free 与失败处理', '栈/堆/静态区/常量区分布', '内存池与分代分配', '泄漏、双释放、use-after-free 的成因'] },
      { id: 'c-file-io', title: '文件与流式 IO', level: '进阶', points: ['FILE 流、缓冲模式与 fflush', '文本与二进制模式的差异', '格式化读写与配置文件解析', '行读取的正确写法与getline 陷阱'] },
      { id: 'c-decl-variadic', title: '复杂声明与可变参数', level: '进阶', points: ['阅读复杂声明（函数指针数组等）', 'stdarg 实现可变参数', '柔性数组与变长结构', '位域、对齐与 sizeof 的真实含义'] },
      { id: 'c-ub-aliasing', title: '未定义行为与严格别名', level: '高级', points: ['UB 清单：序列点、溢出、空指针解引用', '严格别名规则与 -fstrict-aliasing', '为什么优化会"吃掉"你的代码', '用 UBSAN 与编译器告警把 UB 抓出来'] },
      { id: 'c-restricted-env', title: '受限环境与 volatile', level: '高级', points: ['volatile 与 MMIO/中断共享变量', 'MISRA C 高频规则', '无堆策略与栈用量估算', '定点数、查表法与常量折叠'] },
    ],
  },
  {
    slug: 'cpp',
    title: 'C++ 语言',
    en: 'C++',
    summary: '面向对象只是起点；资源管理、模板、对象模型和版本演进才是 C++ 的主战场。',
    sections: [
      { id: 'cpp-from-c', title: '从 C 到 C++：引用、const 与重载', level: '基础', points: ['引用与指针的取舍', 'const 的正确摆放位置', '函数重载与默认参数的陷阱', '命名空间、inline 与链接性'] },
      { id: 'cpp-class', title: '类与封装', level: '基础', points: ['构造/析构顺序与初始化列表', '拷贝构造、赋值与自赋值', 'static 成员与类常量', 'explicit、delete 与构造约束'] },
      { id: 'cpp-inheritance', title: '继承与多态', level: '基础', points: ['虚函数、override 与 final', '抽象类与接口式写法', '名字隐藏与重载的区别', '虚析构为什么必须有'] },
      { id: 'cpp-common-lib', title: '常用标准库入门', level: '基础', points: ['string/vector/map 的复杂度', '范围 for 与迭代器失效', 'algorithm 常用件（sort/find/copy）', '结构化绑定与 auto 的边界'] },
      { id: 'cpp-raii', title: 'RAII 与Rule of 0/3/5', level: '进阶', points: ['用对象生命周期管资源', '三法则/五法则/零法则', 'swap 与强异常保证', '自定义 deleter 与句柄封装'] },
      { id: 'cpp-move', title: '移动语义与完美转发', level: '进阶', points: ['左值/右值/将亡值分类', 'std::move 到底做了什么', '移动构造的合法状态', '万能引用与 std::forward'] },
      { id: 'cpp-smart-ptr', title: '智能指针与所有权', level: '进阶', points: ['unique_ptr 的独占语义', 'shared_ptr 引用计数与控制块', '循环引用与 weak_ptr', '什么时候该继续用裸指针'] },
      { id: 'cpp-template', title: '模板与泛型', level: '进阶', points: ['函数模板与类模板', '特化、偏特化与重载决议', 'SFINAE 与 enable_if', 'concepts 约束模板参数'] },
      { id: 'cpp-stl', title: 'STL 容器与迭代器体系', level: '进阶', points: ['六大容器族与选择依据', '迭代器类别与性能含义', '分配器与容器扩展点', 'emplace 与就地构造'] },
      { id: 'cpp-modern-versions', title: 'C++11→23 特性时间线', level: '高级', points: ['每个版本解决了什么问题', 'constexpr 与 consteval 演进', 'ranges、coroutines、modules', '用特性测试宏做兼容'] },
      { id: 'cpp-object-model', title: '对象模型与内存布局', level: '高级', points: ['虚表、虚指针与调用开销', '多继承与虚继承的对象布局', '空类优化与成员对齐', '从汇编看一次虚函数调用'] },
      { id: 'cpp-error-strategy', title: '异常与错误处理策略', level: '高级', points: ['异常安全等级', 'noexcept 与栈展开代价', '错误码/expected/异常怎么选', '禁用异常的项目如何设计'] },
    ],
  },
  {
    slug: 'data-structures',
    title: '数据结构与算法',
    en: 'Data Structures',
    summary: '以 C/C++ 手写实现为主，关注真实内存布局与代价，而不是纸上复杂度。',
    sections: [
      { id: 'ds-complexity', title: '复杂度分析与大 O', level: '基础', points: ['渐进记号与常数被忽略的代价', '最好/最坏/摊还分析', '空间与时间的互换', '用实测验证复杂度'] },
      { id: 'ds-linear-list', title: '线性表：数组与链表', level: '基础', points: ['顺序表与动态扩容策略', '单链表/双链表/循环链表实现', '删除与查找的指针操作', '什么时候链表其实更慢'] },
      { id: 'ds-stack-queue', title: '栈与队列', level: '基础', points: ['数组栈与链表栈', '循环队列与双端队列', '单调栈/单调队列', '表达式求值与括号匹配'] },
      { id: 'ds-string', title: '串与模式匹配', level: '基础', points: ['字符串存储与比较代价', 'KMP 与 next 数组推导', 'Rabin-Karp 滚动哈希', '多模式匹配概览'] },
      { id: 'ds-tree', title: '树：二叉树、BST 与平衡', level: '进阶', points: ['三种遍历与递归/非递归', 'BST 的退化与旋转', 'AVL 与红黑树取舍', 'B 树/B+ 树与磁盘结构'] },
      { id: 'ds-heap', title: '堆与优先队列', level: '进阶', points: ['数组实现二叉堆', '建堆为何是 O(n)', 'Top-K 与合并 K 路', '配对堆/二项堆概览'] },
      { id: 'ds-hash', title: '哈希表', level: '进阶', points: ['哈希函数与分布质量', '开放寻址与链地址法', '负载因子与再哈希', '布隆过滤器'] },
      { id: 'ds-graph-traverse', title: '图的存储与遍历', level: '进阶', points: ['邻接矩阵/邻接表/前向星', 'BFS 与 DFS 的非递归写法', '拓扑排序与环检测', '连通分量与二分图判定'] },
      { id: 'ds-sort', title: '排序算法全族', level: '进阶', points: ['插入/希尔/选择/冒泡的适用边界', '归并与快排：稳定性与最坏情况', '堆排序与原地 O(1) 空间', '基数/计数排序与内省排序'] },
      { id: 'ds-dp', title: '动态规划', level: '高级', points: ['状态定义与转移推导', '背包、区间、树形 DP', '滚动数组与状态压缩', '记忆化与递推互换'] },
      { id: 'ds-greedy-backtrack', title: '贪心、分治与回溯', level: '高级', points: ['贪心正确性如何证明', '分治与主定理', '回溯剪枝与全排列类问题', '双向搜索与迭代加深'] },
      { id: 'ds-advanced', title: '进阶结构专题', level: '高级', points: ['并查集与路径压缩', '字典树与后缀数组', '树状数组与线段树', '跳表与 LRU 缓存'] },
    ],
  },
  {
    slug: 'concurrency',
    title: '并发编程',
    en: 'Concurrency',
    summary: '锁只是入门，内存序、数据布局和正确的等待方式才是并发的分水岭。',
    sections: [
      { id: 'conc-model', title: '线程与进程模型', level: '基础', points: ['并发的三种动机', '线程共享什么、隔离什么', '上下文切换的真实代价', '并发、并行与异步的区别'] },
      { id: 'conc-mutex', title: '互斥锁与临界区', level: '基础', points: ['数据竞争的准确定义', 'mutex/recursive/try_lock', '锁粒度与临界区最小化', '死锁四条件与破坏顺序'] },
      { id: 'conc-condvar', title: '条件变量与等待通知', level: '基础', points: ['为什么必须配谓词循环', '虚假唤醒与丢失唤醒', 'wait_for 与超时', '生产者消费者的第一个正确实现'] },
      { id: 'conc-sync-tools', title: '同步工具族', level: '进阶', points: ['读写锁与适用负载', '信号量与计数资源', '屏障、once 与 call_once', '自旋锁与忙等什么时候划算'] },
      { id: 'conc-api', title: 'pthread 与 std::thread 对照', level: '进阶', points: ['两套 API 的等价与差异', 'detach/join 与生命周期', 'thread_local 与 TLS', '线程命名、优先级与亲和性'] },
      { id: 'conc-task-queue', title: '任务队列与线程池', level: '进阶', points: ['无界队列为什么危险', '线程池参数如何定', '任务窃取与负载均衡', '优雅关闭与在途任务'] },
      { id: 'conc-async-patterns', title: '并发设计模式', level: '进阶', points: ['future/promise 与异步结果', 'actor 模型与消息传递', '双检锁与惰性初始化', '读写数据快照'] },
      { id: 'conc-atomics', title: '原子操作与内存序', level: '高级', points: ['atomic 与 lock-free 判定', 'relaxed/acquire/release/seq_cst', 'happens-before 与可见性', 'seq_cst 的代价与必要性'] },
      { id: 'conc-lockfree', title: '无锁结构', level: '高级', points: ['CAS 循环与 ABA 问题', '无锁栈与队列实现', 'RCU 与读多写少', '无锁的内存回收难题'] },
      { id: 'conc-coroutine', title: '协程与异步模型', level: '高级', points: ['Reactor/Proactor 模型', 'epoll 与 io_uring 概览', 'C++20 协程机制', '有栈协程与无栈协程取舍'] },
    ],
  },
  {
    slug: 'qt6',
    title: 'Qt 6',
    en: 'Qt',
    summary: '信号槽、事件循环、模型视图和绘制性能——把 Qt 用成生产力工具而不是控件堆。',
    sections: [
      { id: 'qt-overview', title: '框架总览与工程搭建', level: '基础', points: ['Qt 模块划分与版本策略', 'CMake 集成 Qt6 与 Qt Creator', 'moc 在构建里做什么', '第一个窗口从 main 到事件循环'] },
      { id: 'qt-signal-slot', title: '信号槽与元对象系统', level: '基础', points: ['connect 的五种写法与生命周期', '队列连接与直接连接', '属性系统与 Q_PROPERTY', '元对象遍历与反射能力'] },
      { id: 'qt-event', title: '事件循环与事件处理', level: '基础', points: ['QEvent 类型与派发路径', 'event/事件过滤器/槽的区别', '定时器与事件循环阻塞', 'processEvents 为什么是坑'] },
      { id: 'qt-widget-layout', title: '控件与布局', level: '基础', points: ['常用控件与信号语义', '布局嵌套、伸缩因子与最小尺寸', 'sizeHint 与控件尺寸失控', '焦点顺序与键盘导航'] },
      { id: 'qt-mainwindow-dialog', title: '主窗口体系与对话框', level: '进阶', points: ['QMainWindow 的五大区域', '模态/非模态与父子关系', 'QDialog  accept/reject 与按钮', '设置持久化 QSettings'] },
      { id: 'qt-model-view', title: '模型/视图与委托', level: '进阶', points: ['为什么不用 QTableWidget 硬堆', 'QAbstractItemModel 的索引语义', '自定义 delegate 绘制与编辑器', 'QSortFilterProxyModel 与大数据量'] },
      { id: 'qt-painting', title: '绘图体系', level: '进阶', points: ['QPainter 与坐标/变换', 'QGraphicsView 框架与场景', '离屏绘制与 QPixmap/QImage', '抗锯齿、字体度量与高 DPI'] },
      { id: 'qt-io-network', title: '文件、设置与网络', level: '进阶', points: ['QFile/QTextStream 与编码', 'QtNetwork 与 QNAM 请求', 'SSL 证书与代理配置', 'QtSql 与数据库层'] },
      { id: 'qt-thread', title: 'Qt 多线程', level: '进阶', points: ['QThread 的正确用法与对象亲和', 'QtConcurrent 与线程池', '跨线程信号槽与数据竞争', 'moveToThread 与工作对象模式'] },
      { id: 'qt-performance', title: '性能与卡顿诊断', level: '高级', points: ['UI 卡顿的定位方法', '重绘风暴与 update/repaint', '大数据量列表的虚拟化', '启动时间与 DLL 加载'] },
      { id: 'qt-qml', title: 'QML/Quick 与 C++ 混合', level: '高级', points: ['QML 语法与绑定机制', '注册 C++ 类型给 QML', '属性暴露与线程边界', '什么时候该用 Widgets 而不是 QML'] },
      { id: 'qt-cross-platform', title: '跨平台与部署', level: '高级', points: ['windeployqt 与插件缺失排查', 'MinGW 与 MSVC 构建差异', '平台路径、字体与换行差异', '高 DPI、缩放与远程桌面'] },
    ],
  },
  {
    slug: 'win32',
    title: 'Windows / Win32 编程',
    en: 'Win32',
    summary: '句柄、消息、资源和两套工具链的差异——Windows 桌面开发里绕不开的底层。',
    sections: [
      { id: 'win-handle-message', title: '句柄、消息与窗口过程', level: '基础', points: ['句柄表与内核对象', 'WndProc、消息队列与派发', '同步消息与 Post/Send 差异', 'Unicode 与 ANSI 两套 API'] },
      { id: 'win-gdi', title: 'GDI 绘图与双缓冲', level: '基础', points: ['DC、GDI 对象与泄漏', 'BitBlt/StretchBlt 与透明合成', '双缓冲消除闪烁', '分层窗口与逐像素 Alpha'] },
      { id: 'win-resource', title: '资源脚本与图标', level: '基础', points: ['.rc 与资源 ID 语义', '图标、光标、位图与多尺寸', '字符串资源与本地化', 'MAKEINTRESOURCE 与按名加载'] },
      { id: 'win-thread-sync', title: '线程与同步', level: '进阶', points: ['CreateThread 与线程局部存储', '事件/互斥/临界区/信号量选择', 'WaitForMultipleObjects 与消息等待', 'UI 线程与工作线程通信'] },
      { id: 'win-audio-media', title: '音频与媒体播放', level: '进阶', points: ['MCI 为什么在某些机器上不可靠', 'Media Foundation 解码链路', 'XAudio2 低延迟混音', '音量、设备枚举与热插拔'] },
      { id: 'win-dialog-control', title: '对话框与公共控件', level: '进阶', points: ['模态对话框与消息循环嵌套', '默认按钮与回车键归属', 'ListView/TreeView 与 owner-draw', '控件子类化与消息拦截'] },
      { id: 'win-registry-config', title: '注册表与配置存储', level: '进阶', points: ['HKCU/HKLM 与重定向', '读写 API 与权限失败', '配置目录与 AppData 规范', '开机自启与文件关联'] },
      { id: 'win-msvc-mingw', title: 'MSVC 与 MinGW 工具链差异', level: '高级', points: ['头文件与声明缺失怎么办', '调用约定、名字修饰与 ABI', 'CRT 版本与混用风险', '资源编译、manifest 与子系统标志'] },
      { id: 'win-com-shell', title: 'COM 与 Shell 集成', level: '高级', points: ['COM 接口与智能指针', '已知文件夹与 Shell API', '拖放、剪贴板与格式协商', '任务栏、通知区域与跳列表'] },
      { id: 'win-debug-perf', title: 'Windows 侧调试与性能', level: '高级', points: ['WinDbg 基础与符号', 'ETW 与 xperf 看卡顿', 'GDI 对象与句柄泄漏计数', '任务管理器指标的正确读法'] },
    ],
  },
  {
    slug: 'linux',
    title: 'Linux 系统编程',
    en: 'Linux',
    summary: '一切皆文件描述符：从 syscall 到 epoll、动态库与可观测性。',
    sections: [
      { id: 'linux-fd', title: '文件描述符与 IO 系统调用', level: '基础', points: ['fd 表、偏移与 dup', 'open/read/write/close 语义', '阻塞与非阻塞标志', 'fcntl 与文件锁'] },
      { id: 'linux-process', title: '进程创建与执行', level: '基础', points: ['fork 的写时复制', 'exec 族与参数环境', '等待、僵尸进程与退出码', '进程组、会话与控制终端'] },
      { id: 'linux-shell-tools', title: '命令行与工具链', level: '基础', points: ['管道、重定向与通配', 'grep/sed/awk 实用组合', 'bash 脚本与引号展开', 'systemctl/journalctl 常用操作'] },
      { id: 'linux-permission', title: '权限与用户', level: '基础', points: ['rwx 与 umask', 'setuid/setgid/sticky', '能力（capability）与最小权限', 'ACL 与文件属性'] },
      { id: 'linux-signal', title: '信号与异步安全', level: '进阶', points: ['信号传递与默认处置', 'sigaction 与可靠信号', '异步信号安全函数清单', 'self-pipe 与信号转事件'] },
      { id: 'linux-pthread', title: '多线程与同步', level: '进阶', points: ['pthread 创建与分离', '互斥/条件/读写锁属性', '信号量与线程取消', '线程命名与栈大小调整'] },
      { id: 'linux-ipc', title: '进程间通信', level: '进阶', points: ['匿名/命名管道与 FIFO', '共享内存与映射文件', 'System V 消息队列与信号量', 'Unix 域套接字与传描述符'] },
      { id: 'linux-io-multiplex', title: 'IO 多路复用', level: '进阶', points: ['select 的限制与 fd_set', 'poll 与 epoll LT/ET', '一个 epoll 服务器的骨架', 'eventfd/timerfd/signalfd 统一事件源'] },
      { id: 'linux-daemon', title: '守护进程与服务化', level: '进阶', points: ['双 fork、setsid 与脱终端', 'pid 文件与幂等启动', 'systemd unit 与日志接入', '优雅退出与热加载配置'] },
      { id: 'linux-elf', title: '动态库、ELF 与装载', level: '高级', points: ['ELF 段、符号表与重定位', '动态链接与搜索路径', 'LD_PRELOAD 与符号插桩', '可见性属性与体积优化'] },
      { id: 'linux-observe', title: '性能观测与调优', level: '高级', points: ['/proc 与 /sys 关键指标', 'top/vmstat/iostat/sar 组合读法', 'perf 与火焰图', '延迟、吞吐与饱和度的判断'] },
      { id: 'linux-ns', title: 'namespace、cgroup 与容器', level: '高级', points: ['六类 namespace 与隔离边界', 'cgroup v2 资源限制', '容器镜像与 rootfs', '容器里的信号与 PID 1 问题'] },
    ],
  },
  {
    slug: 'os',
    title: '操作系统原理',
    en: 'Operating Systems',
    summary: '把上层行为归因到调度、分页、缓存和中断，而不只是记住概念。',
    sections: [
      { id: 'os-intro', title: '操作系统在做什么', level: '基础', points: ['抽象、隔离与复用', '内核态与用户态切换', '系统调用路径与开销', '宏内核/微内核与实时内核'] },
      { id: 'os-process-thread', title: '进程、线程与上下文切换', level: '基础', points: ['地址空间与 PCB', '线程实现：1:1、N:1、M:N', '切换保存了什么', '协程与用户态调度'] },
      { id: 'os-memory-basic', title: '内存分层与地址空间', level: '基础', points: ['栈、堆、映射区布局', '局部性与分层缓存', '碎片：内部与外部', '内存分配器在做什么'] },
      { id: 'os-schedule', title: '调度算法与实时性', level: '进阶', points: ['FCFS/SJF/RR 与公平性', 'CFS 与权重、虚拟运行时间', '优先级反转与继承', '实时策略与调度延迟'] },
      { id: 'os-virtual-memory', title: '虚拟内存、分页与 TLB', level: '进阶', points: ['页表、多级与反向页表', 'TLB 命中与刷新', '缺页中断与请求分页', 'COW、交换与 OOM'] },
      { id: 'os-file-system', title: '文件系统与 VFS', level: '进阶', points: ['inode、目录项与硬/软链接', '日志结构与崩溃一致性', 'ext4/FAT/tmpfs 的差异', '挂载、命名空间与文件句柄'] },
      { id: 'os-io-stack', title: 'IO 栈、页缓存与异步 IO', level: '进阶', points: ['从 write 到磁盘的路径', '页缓存、回写与脏页', 'O_DIRECT、mmap 与 mmap 陷阱', 'aio 与 io_uring 模型'] },
      { id: 'os-sync-deadlock', title: '同步原语的底层实现', level: '高级', points: ['关中断、原子指令与自旋', '锁的排队与公平性', '死锁检测与恢复', '无锁结构的内存回收'] },
      { id: 'os-interrupt', title: '中断、异常与设备模型', level: '高级', points: ['中断上下半部', '软中断与任务队列', '驱动分层与设备树', '中断亲和与风暴'] },
      { id: 'os-virtualization', title: '虚拟化与容器原理', level: '高级', points: ['特权指令与陷入模拟', 'EPT/影子页表', '虚拟机逃逸防护与隔离', '容器与虚拟机的边界'] },
    ],
  },
  {
    slug: 'network',
    title: '计算机网络',
    en: 'Network',
    summary: '以抓包和 socket 为准绳，把 TCP 的行为和故障定位讲实。',
    sections: [
      { id: 'net-model', title: '分层模型与抓包入门', level: '基础', points: ['五层模型与各层职责', '封装与解封装', 'Wireshark/tcpdump 抓包', '读第一份 pcap'] },
      { id: 'net-link', title: '以太网、ARP 与交换机', level: '基础', points: ['MAC 帧与 MTU', 'ARP 缓存与欺骗', '交换机学习与广播域', 'VLAN 与 trunk'] },
      { id: 'net-ip-routing', title: 'IP、子网与路由', level: '基础', points: ['IPv4 地址与 CIDR', '子网划分与掩码计算', '路由表、默认路由与最长匹配', 'ICMP 与 traceroute 原理'] },
      { id: 'net-tcp-conn', title: 'TCP 连接管理', level: '进阶', points: ['三次握手与状态机', '四次挥手与 TIME_WAIT', '半连接队列与 SYN 攻击', '连接复用与保活'] },
      { id: 'net-tcp-flow', title: '滑动窗口与拥塞控制', level: '进阶', points: ['流量控制与接收窗口', '快重传、快恢复与 SACK', 'cubic/bbr 差异', 'Nagle 与延迟确认的相互作用'] },
      { id: 'net-udp', title: 'UDP 与 QUIC', level: '进阶', points: ['UDP 的适用场景', '自定义可靠协议要素', 'QUIC 与 0-RTT', '组播与广播'] },
      { id: 'net-dns-http', title: 'DNS、HTTP 与常见应用层', level: '进阶', points: ['DNS 解析链与记录类型', 'HTTP/1.1、keep-alive 与管线', 'HTTP/2 多路复用与头压缩', 'CDN 与就近调度'] },
      { id: 'net-socket', title: 'socket 编程基础', level: '进阶', points: ['TCP 服务端/客户端骨架', '地址绑定与端口复用', '阻塞读写与超时', '字节序与粘包处理'] },
      { id: 'net-tls', title: 'TLS 与证书链', level: '高级', points: ['握手与密钥协商', '证书链、SNI 与校验失败', '会话恢复与 1-RTT', '常见证书部署错误'] },
      { id: 'net-highperf', title: '高并发 IO 模型', level: '高级', points: ['Reactor 与 Proactor', '多线程 accept 与 SO_REUSEPORT', '连接数与内存预算', '零拷贝与 sendfile'] },
      { id: 'net-debug', title: '网络故障定位', level: '高级', points: ['延迟分解：DNS/连接/TLS/首字节', '重传、丢包与 RTO 观测', '防火墙、NAT 与 MTU 黑洞', '跨网段与代理链路排查'] },
      { id: 'net-protocol-design', title: '应用层协议设计', level: '高级', points: ['帧格式、版本与兼容', '心跳、重连与幂等', 'MQTT 与物联网协议栈', '协议文档与测试向量'] },
    ],
  },
  {
    slug: 'embedded',
    title: '嵌入式开发',
    en: 'Embedded',
    summary: '从点灯到 RTOS、低功耗与 OTA，围绕真实设备的约束写代码。',
    sections: [
      { id: 'emb-mcu', title: 'MCU 与体系结构', level: '基础', points: ['Cortex-M 寄存器与异常模型', '存储映射与外设地址', 'RISC-V 基础与生态差异', '看数据手册的方法'] },
      { id: 'emb-startup', title: '启动流程与链接脚本', level: '基础', points: ['Reset_Handler 到 main 之间', '向量表与栈初始化', '链接脚本段布局', '数据拷贝与 BSS 清零'] },
      { id: 'emb-devtools', title: '开发板、调试器与烧录', level: '基础', points: ['SWD/JTAG 与调试探针', 'IDE、命令行与 Makefile 三条路', '固件格式与烧录工具', '串口日志与最小可观测性'] },
      { id: 'emb-gpio-timer', title: 'GPIO、定时器与中断', level: '进阶', points: ['推挽/开漏与上下拉', '按键消抖与状态机', '定时器计数、PWM 与捕获', '中断优先级与嵌套'] },
      { id: 'emb-bus', title: 'UART、SPI 与 I2C', level: '进阶', points: ['串口参数与 DMA 收发', 'SPI 四种模式与片选时序', 'I2C 地址、时钟拉伸与仲裁', '总线冲突与调试手段'] },
      { id: 'emb-adc-sensor', title: 'ADC 与传感器驱动', level: '进阶', points: ['采样率、分辨率与参考电压', 'DMA 采集与滑动平均', '传感器时序与初始化状态机', '驱动分层与 HAL 取舍'] },
      { id: 'emb-rtos-basics', title: 'RTOS 基础', level: '进阶', points: ['为什么需要 RTOS', '任务、优先级与栈分配', '调度器与时间片', 'FreeRTOS/RT-Thread 对照'] },
      { id: 'emb-rtos-comm', title: '任务间通信与资源', level: '进阶', points: ['队列、信号量、事件组、互斥', '优先级反转与互斥继承', '内存池与静态分配', '中断与任务上下文边界'] },
      { id: 'emb-lowpower', title: '低功耗与电源管理', level: '高级', points: ['睡眠模式与唤醒源', '电流测量与功耗预算', '外设时钟与关断策略', '电池管理与续航估算'] },
      { id: 'emb-bootloader-ota', title: 'Bootloader 与 OTA', level: '高级', points: ['分区表与双 Bank', '镜像校验与回滚', '升级通道与断点续传', '安全启动基础'] },
      { id: 'emb-fieldbus', title: 'Modbus、CAN 与工业协议', level: '高级', points: ['Modbus RTU/TCP 帧与从站实现', 'CAN 仲裁、报文与DBC', '错误帧与总线关闭恢复', '网关与协议转换架构'] },
      { id: 'emb-reliability', title: '可靠性与故障恢复', level: '高级', points: ['看门狗分层设计', '故障注入与压力测试', '数据持久化与掉电安全', '日志与现场取证'] },
    ],
  },
  {
    slug: 'database',
    title: '数据库',
    en: 'Database',
    summary: 'SQL 只是入口；索引、事务、锁和执行计划决定了程序的真实表现。',
    sections: [
      { id: 'db-model', title: '关系模型与 SQL 入门', level: '基础', points: ['表、主键、外键与约束', '范式与反范式取舍', 'ER 设计与命名规范', '客户端工具与建库流程'] },
      { id: 'db-query', title: '查询：JOIN、子查询与聚合', level: '基础', points: ['四种 JOIN 的语义与结果', 'GROUP BY 与 HAVING', '子查询与 EXISTS', 'NULL 与三值逻辑陷阱'] },
      { id: 'db-ddl-dml', title: '数据定义与变更', level: '基础', points: ['类型选择与字符集', 'ALTER 与在线变更风险', '事务内的 DML 与回滚', '数据迁移与校验'] },
      { id: 'db-advanced-sql', title: '窗口函数与 CTE', level: '基础', points: ['ROW_NUMBER/RANK 与分区', '滑动窗口与累计和', '递归 CTE 与树形查询', '用 SQL 替代应用层循环'] },
      { id: 'db-index', title: '索引原理与失效场景', level: '进阶', points: ['B+ 树与页结构', '联合索引最左前缀', '覆盖索引与回表', '索引失效的常见写法'] },
      { id: 'db-transaction', title: '事务与隔离级别', level: '进阶', points: ['ACID 的真实含义', '脏读/不可重复读/幻读', '四种隔离级别与默认值', '自动提交与事务边界设计'] },
      { id: 'db-mysql-arch', title: 'MySQL 架构与 InnoDB', level: '进阶', points: ['连接器、优化器与存储引擎', 'redo/undo/双写缓冲', '关键参数与缓冲区池', 'binlog 与归档策略'] },
      { id: 'db-sqlite', title: 'SQLite 与嵌入式集成', level: '进阶', points: ['为什么选 SQLite', 'WAL 模式与并发读写', 'busy_timeout 与锁等待', '打包、迁移与性能调优'] },
      { id: 'db-optimize', title: '执行计划与慢查询优化', level: '高级', points: ['EXPLAIN 逐字段解读', '索引选择与统计信息', '深分页与批量写优化', '慢查询日志与基准测试'] },
      { id: 'db-lock-mvcc', title: '锁与 MVCC', level: '高级', points: ['行锁、间隙锁与 next-key', '死锁日志与规避', '快照读与当前读', '高并发更新热点拆分'] },
      { id: 'db-replica', title: '主从、备份与扩展', level: '高级', points: ['复制原理与延迟', '备份恢复演练', '读写分离与分库分表', '容量规划与数据归档'] },
      { id: 'db-cache', title: 'Redis 与缓存一致性', level: '高级', points: ['五大数据结构与场景', '持久化 RDB/AOF', '缓存穿透、击穿、雪崩', '失效策略与一致性方案'] },
    ],
  },
  {
    slug: 'build',
    title: '编译与构建',
    en: 'Build',
    summary: '链接错误不是玄学：懂符号表和 target 模型，问题就一半解决了。',
    sections: [
      { id: 'build-four-stage', title: '预处理、编译、汇编、链接', level: '基础', points: ['每阶段的输入输出', 'gcc/clang 常用命令与 -o/-c/-S', '优化级别与调试信息', '看中间产物定位问题'] },
      { id: 'build-object', title: '目标文件、段与符号表', level: '基础', points: ['ELF/PE 结构概览', 'text/data/bss/rodata 段', '强符号与弱符号', 'nm/objdump/readelf 实战'] },
      { id: 'build-make', title: 'Makefile 基础', level: '基础', points: ['规则、目标与依赖图', '自动变量与模式规则', '伪目标与增量构建', '变量、函数与常见错误'] },
      { id: 'build-library', title: '静态库、动态库与链接顺序', level: '进阶', points: ['归档库与链接器扫描规则', '动态库、导入库与运行时查找', '链接顺序导致的未定义符号', '符号冲突与版本脚本'] },
      { id: 'build-cmake', title: 'CMake 现代用法', level: '进阶', points: ['target 模型与属性', 'find_package 与依赖发现', '项目结构与可复用模块', '生成器、构建目录与缓存变量'] },
      { id: 'build-cross', title: '交叉编译工具链', level: '进阶', points: ['triplet 与前缀含义', 'sysroot 与查找路径', 'CMake 工具链文件', '目标平台与主机工具混用'] },
      { id: 'build-options', title: '构建配置与编译选项', level: '进阶', points: ['警告集与 -Werror 策略', 'Debug/Release/RelWithDebInfo', '位置无关代码与链接选项', 'ABI 兼容与标准版本'] },
      { id: 'build-package', title: '依赖管理：vcpkg 与 Conan', level: '高级', points: ['第三方库的三种集成方式', 'manifest 模式与版本锁定', '预编译二进制缓存', '离线与内网构建'] },
      { id: 'build-ci', title: 'CI 构建与缓存', level: '高级', points: ['矩阵构建多平台', 'ccache 与依赖缓存', '构建产物与测试报告', '失败可复现的排查习惯'] },
      { id: 'build-troubleshoot', title: '链接与符号问题诊断', level: '高级', points: ['undefined reference 定位路径', '重复定义与 ODR 违规', '运行时缺 DLL/.so 的排查', '崩溃在 main 之前的原因'] },
    ],
  },
  {
    slug: 'debug-perf',
    title: '调试与性能优化',
    en: 'Debug & Perf',
    summary: '先测量再优化：工具链、现场保留和数据布局，比"经验直觉"可靠。',
    sections: [
      { id: 'dbg-gdb', title: 'GDB / LLDB 实战', level: '基础', points: ['断点、条件与观察点', '栈帧、变量与打印格式', '多线程调试与线程切换', '反向调试与脚本化'] },
      { id: 'dbg-log', title: '日志与可定位性设计', level: '基础', points: ['日志级别与上下文信息', '结构化日志与采样', '崩溃可回溯：日志刷盘策略', '生产环境的日志成本'] },
      { id: 'dbg-crash', title: '崩溃现场与 core dump', level: '基础', points: ['信号与 core 文件生成', '栈溢出与破坏现场识别', '符号表缺失怎么办', '远程与嵌入式上的崩溃收集'] },
      { id: 'dbg-sanitizer', title: 'ASAN / UBSAN / TSAN', level: '进阶', points: ['地址越界与 use-after-free', '未定义行为检查项', '数据竞争检测原理与代价', '与覆盖率、模糊测试配合'] },
      { id: 'dbg-memory', title: '内存泄漏与碎片', level: '进阶', points: ['Valgrind 与 massif', '分配器统计与峰值', '泄漏、碎片与"内存不降"区别', '对象池与生命周期审计'] },
      { id: 'dbg-profiling', title: 'perf、火焰图与系统观测', level: '进阶', points: ['采样与插桩的区别', '火焰图怎么读', 'off-CPU 与延迟分析', '系统级：CPU、IO、网络、锁'] },
      { id: 'dbg-asm', title: '读汇编与编译器优化', level: '进阶', points: ['调用约定与栈帧', '把 C 代码编译成汇编对照', '自动向量化与限制', '内联、循环展开的判定'] },
      { id: 'dbg-data-layout', title: '缓存友好与数据布局', level: '高级', points: ['行、局部性与预取', 'AoS 与 SoA', '伪共享与对齐填充', '分支预测与数据依赖'] },
      { id: 'dbg-benchmark', title: '基准测试方法论', level: '高级', points: ['消除死代码与测量偏差', '统计显著性与噪声', '微基准与端到端基准', '回归门禁与可视化'] },
      { id: 'dbg-bottleneck', title: '瓶颈定位与优化次序', level: '高级', points: ['先量化再优化的判据', 'IO、CPU、锁三类的特征', '算法与数据结构优先', '优化的可读性代价'] },
    ],
  },
  {
    slug: 'engineering',
    title: '工程实践',
    en: 'Engineering',
    summary: '让代码可协作：版本控制、测试、评审与发布流程。',
    sections: [
      { id: 'eng-git-basics', title: 'Git 日常工作流', level: '基础', points: ['三区模型与状态查看', '逐块暂存与提交拆分', '拉取与冲突解决', '日志查看与撤销的安全边界'] },
      { id: 'eng-style', title: '命名、格式与可读性', level: '基础', points: ['命名传递意图', '函数长度与抽象层级', 'clang-format 与统一风格', '注释该写什么'] },
      { id: 'eng-doc', title: '文档与 README', level: '基础', points: ['最小可运行文档结构', '接口文档与示例代码', '变更记录与决策记录', '让新人一天内跑起来'] },
      { id: 'eng-git-advanced', title: '分支模型与历史整理', level: '进阶', points: ['rebase 的适用边界', 'cherry-pick、bisect 与 reflog', '提交信息规范', '多人协作的分支策略'] },
      { id: 'eng-test', title: '单元测试与 mock', level: '进阶', points: ['GoogleTest/Catch2 用法', '可测试性设计与依赖注入', '测试替身与打桩', '覆盖率的意义与局限'] },
      { id: 'eng-review', title: 'Code Review', level: '进阶', points: ['评审的优先级排序', '如何提建设性意见', '小步提交让评审可行', '自动化风格与静态检查'] },
      { id: 'eng-refactor', title: '重构与小步安全改动', level: '进阶', points: ['识别坏味道', '先加测试再改结构', '行为保持的验证方法', '大规模改动的拆分策略'] },
      { id: 'eng-arch', title: '模块划分与依赖管理', level: '高级', points: ['分层与依赖方向', '接口与实现分离', '插件化架构', '循环依赖的识别与破除'] },
      { id: 'eng-release', title: '版本号、发布与回滚', level: '高级', points: ['语义化版本与兼容性', '发布检查清单', '灰度与回滚方案', '二进制产物与符号归档'] },
      { id: 'eng-automation', title: 'CI/CD 与脚本化', level: '高级', points: ['构建、测试、打包流水线', '静态检查与门禁', '自动化发布与人工确认边界', '失败通知与可观测'] },
    ],
  },
];

export const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.slug, c]));

export const SECTION_INDEX = new Map<string, { category: Category; section: Section }>();
for (const category of CATEGORIES) {
  for (const section of category.sections) {
    SECTION_INDEX.set(section.id, { category, section });
  }
}

export const LEVELS: Level[] = ['基础', '进阶', '高级'];

export const categoryPath = (slug: string) => `/categories/${slug}/`;
export const sectionAnchor = (slug: string, sectionId: string) => `/categories/${slug}/#${sectionId}`;
