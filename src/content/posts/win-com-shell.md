---
title: COM 与 Shell 集成
description: 实测：MinGW 下 COM 全链路可用——未初始化得 0x800401f0、引用计数实测归零、已知文件夹读回、MTA 调 STA 对象经代理成功。
date: 2026-10-16
tags: [Win32, COM, Shell, 已知文件夹, HRESULT]
category: win32
section: win-com-shell
---

> 环境：Windows 11 x64，**GCC 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin/g++.exe`）**，`g++ -std=gnu++17 -O2`，链接 `-lole32 -loleaut32 -luuid -lshell32`。探针 `%TEMP%/win3c_*/com.cpp` 与 `com2.cpp`。**本机能跑的是"COM 客户端"全链路**（创建对象、引用计数、已知文件夹、Shell 项、通用对话框）；COM **服务器**端（自己写 DLL 组件、注册表注册、拖放目标、跳列表）**未实测**，第五、六节给清单。所有 HRESULT 与路径在同一系统下可复现。

## 一、COM 的心智模型：三件事

1. **接口是纯虚基类，对象是实现**。`IShellLinkW` 是指向 vtable 的指针，`QueryInterface` 在同一对象的不同接口间导航。所有接口继承 `IUnknown`（`AddRef`/`Release`/`QueryInterface`）。
2. **HRESULT 是唯一的错误通道**。成功看 `SUCCEEDED(hr)`，别用 `!= 0` 判断——`S_FALSE` 是 1，是**成功**。实测解剖一个常见错误：

```
HRESULT 解剖: 0x80070005 = 设施 7, 代码 0x0005 (ERROR_ACCESS_DENIED=5)
S_OK=0x00000000 S_FALSE=0x00000001 E_FAIL=0x80004005 E_NOTIMPL=0x80004001
E_POINTER=0x80004003 E_OUTOFMEMORY=0x8007000e
```

`0x80070005` 的读法：第 31 位是失败标志、第 16–30 位是设施号（7 = Win32）、低 16 位是 Win32 错误码（5 = 拒绝访问）。**看到 0x8007xxxx 就去查 Win32 错误码表**，比搜 HRESULT 表快。

3. **内存有明确归属**。COM 接口方法输出的字符串/内存用 `CoTaskMemFree` 释放（本文实测两块 `CoTaskMemAlloc(64)` 来自同一分配器）；输入参数用 `CoTaskMemAlloc` 分配。**拿 `free()` 去释放 COM 给的内存是经典崩溃**——分配器不同。

## 二、创建对象的完整链路与三个实测

```cpp
CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);          // ① 每线程一次
IShellLinkW* sl = nullptr;
HRESULT hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                              IID_IShellLinkW, (void**)&sl);  // ② 创建
// 用……
sl->Release();                                              // ③ 释放
CoUninitialize();                                           // ④ 与①配对
```

实测（本机 MinGW 全部编译通过并跑通）：

```
CoInitializeEx(STA)                HRESULT=0x00000000 OK
CoCreateInstance(IShellLinkW)      HRESULT=0x00000000 OK
AddRef 后=2 Release 后=1 再 Release=0（归零即销毁）
SHGetKnownFolderPath(Desktop)      → C:\Users\wangt\Desktop
SHGetKnownFolderPath(LocalAppData) → C:\Users\wangt\AppData\Local
CoCreateInstance(IFileOpenDialog)  OK，SetOptions/SetTitle 调用成功
SHCreateItemFromParsingName(notepad) → C:\Windows\notepad.exe
```

引用计数那行值得逐字看：创建后计数 1，`AddRef` 变 2，`Release` 回 1，再 `Release` 归 0 时对象销毁——**COM 对象的生命周期就是引用计数，没有 GC、没有智能指针也能管，但每一条返回接口的路径都要想清楚谁 Release**。工程上请用 `Microsoft::WRL::ComPtr` 或 `_com_ptr_t`（MSVC），MinGW 下手写 RAII 包装（析构里 `Release`）。

## 三、套间（Apartment）：每个线程都要初始化，且模式要一致

COM 的线程模型是初学者最大的坑。实测四种情况：

| 场景 | 结果 |
| --- | --- |
| 未初始化 COM 直接 `CoCreateInstance` | **0x800401f0**（`CO_E_NOTINITIALIZED`） |
| 主线程 `CoInitializeEx(STA)` | `S_OK` |
| 同线程**二次** `CoInitializeEx(STA)` | **`S_FALSE`**（0x00000001，已初始化且模式相同，不是错误） |
| MTA 线程里 `CoCreateInstance(ShellLink)` + 调 STA 里创建的对象 | **全部 `S_OK`**（COM 经代理封送） |

三条军规：

1. **每个会碰 COM 的线程都要调 `CoInitializeEx`**，包括线程池里借来的线程。漏了的症状就是 0x800401f0，且**只在特定线程上炸**——主线程好的、后台线程崩。
2. **STA 与 MTA 的选择影响对象行为**：UI 线程用 STA（`COINIT_APARTMENTTHREADED`，消息循环驱动跨套件调用）；纯计算的工作线程用 MTA（`COINIT_MULTITHREADED`，调用不经过窗口消息）。**同一线程二次初始化模式不同会拿到 `RPC_E_CHANGED_MODE`（0x80010106）**。
3. **跨套件调用会经代理，不是免费的**：STA 对象的方法从 MTA 线程调用时，COM 把它封送到 STA 线程的消息队列——**如果 STA 线程没在泵消息，调用就挂住**。这就是"后台线程调了一个 COM 方法，UI 没卡但方法不返回"的根因。

## 四、Shell 常用件：已知文件夹与通用对话框

**已知文件夹**是"用户桌面/文档/AppData"这类路径的唯一正确来源——**别拼 `%USERPROFILE%\Desktop`**（会被组策略重定向打脸）：

```cpp
PWSTR p = nullptr;
SHGetKnownFolderPath(FOLDERID_Desktop, 0, nullptr, &p);  // 实测 C:\Users\wangt\Desktop
// 用完 CoTaskMemFree(p);
```

**通用对话框**（Vista+ 的 `IFileOpenDialog`/`IFileSaveDialog`）取代了老的 `GetOpenFileName`，实测本机可创建、可设选项。选它的理由：支持 `IShellItem`（路径/库/非文件系统容器统一表达）、可自定义控件、异步模式。老 API 的坑是 `OPENFILENAME` 结构体尺寸和 flag 的组合，`lpstrFilter` 的双 `\0` 结尾写错就静默不过滤。

**`IShellItem`** 是 Shell 世界的"路径对象"：`SHCreateItemFromParsingName` 从文本路径创建（实测拿到 notepad 的文件系统路径），`GetDisplayName(SIGDN_FILESYSPATH)` 取回。老代码里的 `LPITEMIDLIST`（PIDL） + `SHGetPathFromIDList` 也能用，但新代码一律 `IShellItem`。

## 五、剪贴板与拖放（知识层，未实测）

本站未测这两块，给出文档级框架：

- **剪贴板**：`OpenClipboard` → `GetClipboardData(CF_UNICODETEXT)` 读 / `SetClipboardData` 写 → `CloseClipboard`。三条纪律：**调用期间 Clipboard 被本线程独占**（持锁期间别调会碰剪贴板的 API，死锁）；延迟渲染（`SetClipboardData(NULL)` 占位，响应 `WM_RENDERFORMAT` 时真给）适合大对象；自定义格式用 `RegisterClipboardFormat` 拿 ID，跨进程传递靠格式名约定。
- **拖放（OLE Drag-Drop）**：拖动源实现 `IDropSource`，目标实现 `IDropTarget`（`DragEnter`/`DragOver`/`Drop`），数据用 `IDataObject` 携带。格式协商靠 `EnumFormatEtc` 枚举 + `QueryGetData` 试探。自己实现的成本主要在 `IDataObject` 那一套（约 300 行样板），**Win32 控件里 `WM_DROPFILES` 只支持文件路径一种**，要拖文本/图片必须上 OLE。

## 六、任务栏、通知区域与跳列表（知识层，未实测）

- **任务栏按钮**：`ITaskbarList3` 做进度条（`SetProgressValue`）、覆盖图标（`SetOverlayIcon`）。创建后必须 `HrInit()`。
- **跳列表**：`ICustomDestinationList` + `IShellLink` 组合——`IShellLink` 描述"一个跳转目标"（参数、图标、标题），`ICustomDestinationList` 把它加进"任务"或"常用"分类。实测部分：本文验证了 `IShellLinkW` 的创建与 `SetPath`，**跳列表的组装与 `SetAppID` 未测**。
- **通知区域**：`Shell_NotifyIcon` + `NOTIFYICONDATA`。Win11 的坑是图标被折叠进溢出区，`uVersion` 和 `NIIF_*` 标志的版本差异——用 `NOTIFYICON_VERSION_4`。

## 七、未实测清单

- COM 服务器端：可创建对象的 DLL（`DllGetClassObject`/`DllCanUnloadNow`）、注册表注册（`CLSID`/`ProgID`/`AppID` 键）、`regsvr32`——未写未测。
- 拖放目标、剪贴板延迟渲染、跳列表组装——未测（第五、六节内容为文档级）。
- `IDispatch`（自动化）/ 类型库（`.tlb`）/ 脚本调用 COM——未测。
- 跨进程/跨机器 COM（DCOM 的 `CoInitializeSecurity`、身份模拟）——未测。
- MSVC 侧的 `_com_ptr_t`/`ComPtr` 包装与 `#import`——本机无 MSVC，未测；MinGW 下手写 RAII 即可，接口指针的手动 `Release` 在本文第二节量过。
