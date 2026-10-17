---
title: 音频与媒体播放
description: 实测：MCI 只有 5 个驱动、m4a 打开报 277；Media Foundation 解 60 秒 mp3 用 107.4 毫秒（559 倍实时）；winmm 读 100% 而 WASAPI 同刻读 -96 dB。
date: 2026-10-16
tags: [Win32, MCI, Media Foundation, XAudio2, WASAPI, winmm]
category: win32
section: win-audio-media
---

> 环境：Windows 11 x64（26200），**GCC/G++ 13.1.0（MinGW-w64，全路径 `D:/Qt/Tools/mingw1310_64/bin`）**。四条命令：
> `gcc -std=gnu11 -O2 -Wall a1b.c -o a1b.exe -lwinmm -ladvapi32`、`gcc ... rghi2.c -o rghi2.exe -ladvapi32`、
> `g++ -std=gnu++17 -O2 -Wall a2.cc -o a2.exe -lmfplat -lmfreadwrite -lmfuuid -lole32 -ladvapi32 -lpsapi`、
> `g++ -std=gnu++17 -O2 -Wall a3.cc -o a3.exe -lxaudio2_8 -lole32 -ladvapi32 -lpsapi -lwinmm`。
> 测试素材是 `D:/ffmpeg-4.3.1/ffmpeg` 现生成的：`tone3s.wav`（44100/16bit/双声道，529278 字节）、`tone60.mp3`（128 kbps 双声道，959145 字节）、`tone60_hi.mp3`（320 kbps 单声道 48000）、`tone60.m4a`（AAC 96 kbps，645588 字节）。
> **全程不发声**：所有 XAudio2 voice 只创建、只提交全零缓冲、**一次都没有 `Start()`**；WASAPI 只调 `Get*`/`IsFormatSupported`，没调 `Initialize`、没调任何 `Set*`；注册表只读（HKLM 的 MCI32/MCI Extensions/Drivers32）。绝对耗时取 2–5 轮中位并给区间，同期同机还有 4 个 agent 在抢核，**比值比绝对值可靠**。

## 一、MCI 的驱动表只有 5 行，这就是它"在某些机器上不可靠"的全部原因

MCI 不是"系统会放音的 API"，它是一张**注册表驱动表**加一层字符串命令转发。只读枚举（`rghi2.c`，`RegOpenKeyExW`+`RegEnumValueW`）：

```text
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\MCI32   值数=5
  AVIVideo = mciavi32.dll    CDAudio = mcicda.dll    MPEGVideo = mciqtz32.dll
  Sequencer = mciseq.dll     WaveAudio = mciwave.dll

HKLM\...\CurrentVersion\MCI Extensions                    值数=50
  Wav → WaveAudio     Mid/rmi → Sequencer     cda → CDAudio     avi → avivideo
  mp3 / m4a / aac / wma / asf / mp4 / mov / 3gp / ts / snd / aif … → MPEGVideo
```

三条结论直接从这张表读出来：

1. **没有 `mpeg3audio` 这一行**。所以 `open "x.mp3" type mpeg3audio` 必然失败——本机 3 轮复现，稳定 `rc=263`、文本"指定的设备未打开，或不被 MCI 所识别。"，失败得很快（**0.275–0.333 ms**）。网上大量老教程写着 `type mpeg3audio`，那是 Windows XP/7 时代 `MPEG3 Audio` 驱动还在表里时的产物。
2. **`mp3`/`m4a`/`aac` 全被映射到同一个 `MPEGVideo`（mciqtz32.dll）**，也就是老的 Quartz/WMF 转发驱动。它对本机 mp3 勉强能用（见下），对 m4a 就是失败：`open "tone60.m4a"`（按扩展名）三轮都 `rc=277`"初始化 MCI 时发生问题。"，而且**失败得很慢：53.288 / 54.404 / 86.321 ms**——一次点击音效的加载如果走 MCI 打开 m4a，最差要卡 86 ms，而错误码本身完全没告诉你原因。
3. 表里的键名大小写混着写（`Wav`、`Mid`、`mp3`），值名也混（`WaveAudio` vs `avivideo`），查询本身是大小写不敏感的，但**别按名字去猜驱动能力**——同一张表的"能打开"和"能正常工作"是两回事。

按扩展名打开 mp3 的确"成功"了：`rc=0`，`status x length` = **59947**（毫秒），`mode=playing`。这正是最坑的地方：MCI 报告一切正常。本机更早的 Qt 项目里，同一路径的实际表现是"调用成功但听不到声音"。**声音是否存在没法无头验证**（我不能往扬声器发东西再"听"），所以这里只报可复核的事实：位置确实在推进。

```text
play 提交耗时（真正调用过 play 的 4 轮）：
  wav/waveaudio  22.474 ms、8.594 ms
  mp3/按扩展名    29.038 ms、26.669 ms
位置推进（每次 Sleep(1000) 后读 position）：
  第 1 秒：0→970（0.9442×）、15→946（0.9043×）、0→973（0.9570×）、15→943（0.9038×）
  第 2 秒：970→1472（0.9994×）、946→1446（0.9995×）、973→1474（1.0002×）、943→1444（1.0010×）
```

两件事值得记下来：**`play` 不是廉价调用**（8.6–29.0 ms，够丢 1–2 帧），以及**位置的头 1 秒比实时慢 4%–10%**（驱动要先填缓冲），稳定后才是 0.999–1.001×。用 `position` 做进度条没问题，用头几毫秒的 `position` 做音画同步就会拿到错值。

顺手撞到的两个小坑：

- `mciSendStringW("list devices")` 和 `list capabilities` 在本机都返回 **261**"驱动程序无法识别指定的命令。"——想枚举 MCI 驱动只能回到上面那张注册表表。
- `mciGetErrorStringW` 的返回值是 **BOOL（TRUE=1）**，不是写入长度。我一开始把它当长度打印，于是所有错误文本都显示 `len=1`。
- 打开不存在的文件和"对没打开的别名 `play`"返回**同一个 263**，文本还是"指定的设备未打开，或不被 MCI 所识别。"——这条错误文本对"路径不存在"是误导。

另外，Win11 连 `C:\Windows\Media\chimes.wav` 都没有了（99 个条目里没这个文件名，我改用 `Alarm01.wav`，5572 ms 长）。拿"系统提示音文件"当测试素材的旧代码在新系统上会直接打开失败。

- 打开成本（`a1b` 那一轮，同一进程内依次 open）：wav 显式 `waveaudio` **23.123 ms**、wav 按扩展名 **29.332 ms**、**mp3 按扩展名 89.977 ms**、Alarm01.wav 32.481 ms；重复 open 同一 wav 5 次只要 0.024–0.035 ms。也就是说**第一次走 MPEGVideo 转发的那 90 ms 是冷启动**，做"点击即响"的音效绝不能在点击里现场 `open`。
- **同一轮我自己埋的坑值得说**：`a1b` 里我做完属性查询就直接读 `position`，**忘了发 `play`**，于是四条 open 成功的记录全部打印"position 0→0，速率=0.000 倍实时"。第一反应是"这驱动位置不推进"，直到我写了只干一件事的 `a1c`（open→play→定点读位置）才拿到真实的 0.90–1.00 倍。**"没有变化"要先证明变化能被检测到**——和上一节里 `memset` 被 `-O2` 删掉是同一类错误。

## 二、PlaySoundW：便宜、能叠，但没有混音

```text
PlaySoundW(内存 wav, SND_MEMORY|SND_ASYNC)   返回 rc=1，0.005–0.011 ms（连放两次也一样快）
PlaySoundW(NULL, SND_ASYNC|SND_PURGE)        0.000–0.001 ms
PlaySoundW("Alarm01.wav", SND_ASYNC)         0.286 ms
PlaySoundW(不存在.wav, SND_ASYNC)             rc=1 0.000 ms（不加 SND_NODEFAULT 就会去放默认提示音）
PlaySoundW(内存 wav, SND_SYNC)                rc=1，阻塞到播完（3.0 秒素材实测阻塞 ~3.0 s）
```

`SND_ASYNC` 的返回是常数级（0.01 ms 内），因为它只是把活儿丢给系统里的播放线程；`SND_SYNC` 会把调用线程按住整段时长——**UI 线程里绝对不能用**。这套 API 没有句柄、没有混音总线、没有音量参数（除了 ` SND_` 那几个 flag），连续快速触发时后一次会打断前一次；更早那个 Qt 项目里用户直接反馈"很卡"，就是这条路。要叠音/低延迟只能上 XAudio2（第四节）。

MinGW 侧：`playsoundapi.h` 里只有 `SND_SYNC/ASYNC/NODEFAULT/MEMORY/LOOP/NOSTOP/NOWAIT/ALIAS/ALIAS_ID/FILENAME/RESOURCE/PURGE/APPLICATION/SENTRY/RING/SYSTEM`，**MSDN 上常见的 `SND_WAV` 在这里不存在**（我照着记忆写了 `SND_MEMORY|SND_WAV`，直接编译失败：`'SND_WAV' undeclared`）。顺带，`SND_SYNC` 的值就是 `0x0000`，所以"忘了写 flag"等于同步播放。

## 三、Media Foundation：解码链路是真的快，但属性得用对地方

先量启动成本，注意**引用计数**：

```text
MFStartup#1 hr=0  2.499 ms    #2 hr=0 0.001 ms    #3 hr=0 0.000 ms
MFStartup(MF_VERSION|0x10000) → hr=0xC00D36E3（版本号检查，1 秒都不到就返回）
MFShutdown ×4 全 hr=0，0.000–0.510 ms；关掉后再启动 0.119 ms
```

`MFStartup` 只在**第一次**真干活（2.5 ms），后续调用只是加计数；所以库内多处各自 `MFStartup/MFShutdown` 是安全的，但"我 Shutdown 了一次，别人还在用"这种事会发生——它是进程级的。

### 3.1 建 reader 与首次代价

| 文件 | 同进程第 1 次 | 第 2 次 | 第 3 次 | 原生 sub-type | 属性 |
| --- | --- | --- | --- | --- | --- |
| tone3s.wav | **30.157 ms** | 1.735 ms | 1.200 ms | `MFAudioFormat_PCM` | ch=2 rate=44100 bits=16 blockAlign=4 172.3 KB/s |
| tone60.mp3 | 8.067 ms | 1.725 ms | 1.551 ms | `MFAudioFormat_MP3` | ch=2 rate=44100 **bits=0 bitrate=0** blockAlign=1 15.6 KB/s |
| tone60_hi.mp3 | 5.826 ms | 1.934 ms | — | `MFAudioFormat_MP3` | ch=1 rate=48000 bits=0 bitrate=0 16.8 KB/s |
| tone60.m4a | 7.313 ms | 1.594 ms | — | `MFAudioFormat_AAC` | ch=2 rate=44100 bitrate=84552 10.3 KB/s |
| Alarm01.wav | 1.490 ms | 1.674 ms | — | `MFAudioFormat_PCM` | ch=2 rate=**22050** 86.1 KB/s |

- **一进程里第一次建 reader 贵一个数量级**（30.2 ms vs 1.2–1.9 ms）：那是解码器 DLL、拓扑和对象缓存的冷启动。所以"预热一次、复用 reader"或干脆复用同一个 reader 才是对的；每次点击音效都新建一次，就是白送 8–30 ms。
- mp3 的原生类型里 **`MF_MT_AUDIO_BITS_PER_SAMPLE` 和 `MF_MT_AVG_BITRATE` 都是 0（属性不存在）**，只有 `MF_MT_AUDIO_AVG_BYTES_PER_SECOND`=15.6 KB/s 能反推出 128 kbps（15.6×8≈125 kbps）。AAC 那边 `MF_MT_AVG_BITRATE`=84552 是实数。**别拿位深去算 mp3 的时长**。
- **`MF_PD_DURATION` 挂在 audio 流的 media type 上取不到**：5 个文件全部 `hr=0xC00D36E6`（属性未找到）。时长要走源级（`MF_SOURCE_READER_MEDIASOURCE` 的 media type）或读样本时间戳累加。这属于"文档写了、位置猜错"的典型。

### 3.2 解码吞吐与缓冲粒度

`SetCurrentMediaType(16bit PCM)` 全部 `S_OK`，然后把整段解出来：

```text
tone3s.wav     30 缓冲  0.505 MB PCM(3.00 秒)  3.2 ms   932.2× 实时  每缓冲 17640 字节
tone60.mp3    122 缓冲 10.105 MB PCM(60.07 秒) 107.4 ms  559.4×       每缓冲 86855 字节
tone60_hi.mp3 120 缓冲  5.499 MB PCM(60.02 秒)  81.0 ms  403.8×       每缓冲 48049 字节
tone60.m4a   2585 缓冲 10.098 MB PCM(60.02 秒) 119.5 ms  502.4×       每缓冲  4096 字节
Alarm01.wav    56 缓冲  0.469 MB PCM( 2.79 秒)   1.0 ms 2662.6×       每缓冲  8776 字节
```

- 数量级：**44.1 kHz/16bit/双声道 PCM = 172 KB/s**，本机 MF 能吐 94–448 MB/s，也就是 **400–2700 倍实时**。"解码跟不跟得上"根本不是瓶颈，**瓶颈在解码之后**（重采样、混音、设备缓冲）。
- **缓冲粒度由解码器决定**：同一个 reader API，MP3 给 86855 字节/块，AAC 只给 4096 字节/块——60 秒素材 AAC 要迭代 2585 次 `ReadSample`，MP3 只要 122 次。**在 UI 线程里循环 `ReadSample` 的话，AAC 的调用开销是 MP3 的 21 倍**（虽然单次都很便宜）。
- reader 的资源账：建的时候 wav 只 +5~7 个句柄，mp3 第一次 **+73 个句柄 / +1368 KB**，AAC +11 / +2296 KB；`Release()` 之后句柄和私有内存**都回不去原值**（例如 364→375 释放后 355，基线 282；Private 3648→5944→4752 KB）。MF 把解码器留在进程里，这是设计，不是泄漏——但拿句柄数当"reader 漏了"的证据之前要先看基线。

MinGW 头在这块的缺口（都真踩过）：

- `mfplat.dll` 里**没有 `MFCreateMFByteStreamOnStream`**，真实导出叫 `MFCreateMFByteStreamOnStreamEx`，头里连原型都没有，要自己 `extern "C" HRESULT WINAPI ...(ULONG_PTR, IMFByteStream**)`（第一个参数就是 `IStream*`）。
- 建 reader 的函数叫 `MFCreateSourceReaderFromByteStream`，不是 MS 文档里的 `CreateSourceReaderFromByteStream`。
- **`MFEnumDeviceSources` 根本按名字找不到**：`LoadLibrary("mfsrcsnk.dll")` 成功（0x7ffa…），`GetProcAddress("MFEnumDeviceSources")` 返回 **NULL**；`mfplat.dll` 同样返回 NULL。而且 MinGW 只有 `libmfplat/libmfreadwrite/libmfuuid`，没有 `libmfsrcsnk.a`。设备枚举换 WASAPI 的 `IMMDeviceEnumerator` 更省事（第四节）。
- 名字差异：`MF_DEVSOURCE_ATTRIBUTE_FRIENDLYNAME`（SDK/文档）在 MinGW 里叫 `MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME`；`PROCESS_MEMORY_COUNTERS_EX` 的成员是 `cb` 不是 `cbStruct`。GUID 一律要在最前面 `#define INITGUID`，并链 `-lmfplat -lmfreadwrite -lmfuuid -lole32`。

## 四、WASAPI：设备、格式、周期与"音量那两本账"

`IMMDeviceEnumerator` 是纯只读的枚举入口（`CoCreateInstance(CLSID_MMDeviceEnumerator)`，6.142 ms，句柄 135→163）：

```text
EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)   = 6 个   1.441 ms
EnumAudioEndpoints(eRender, DEVICE_STATEMASK_ALL)  = 18 个  1.469 ms
EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)  = 5 个   0.893 ms
EnumAudioEndpoints(eAll,     DEVICE_STATEMASK_ALL)  = 31 个  2.243 ms
（传 states=0 当"全部"→ hr=0x80070057 E_INVALIDARG，必须显式 DEVICE_STATEMASK_ALL=0xf）
默认渲染端点 id={0.0.0.00000000}.{233a5823-e959-434f-a4c2-f85c7d85be37}
```

本机活跃 6 个、全量 18 个（Realtek、Virtual Speakers、3 个 VoiceMeeter、DELL 显示器 USB 扬声器）——**用 ACTIVE 过滤会漏掉 12 个"存在但当前不可用"的端点**。做"插拔时刷新列表"的逻辑必须监视的是这些状态变化，而不是 ACTIVE 集合的差集。

`GetDefaultAudioEndpoint(eRender,eConsole)` 3.101 ms，`Activate(IAudioClient)` 2.078 ms（句柄 +19），然后是最有用的几个读数：

```text
GetMixFormat: tag=0xFFFE(EXTENSIBLE) ch=2 rate=48000 bits=32(浮点) blockAlign=8 avg=384000 B/s cbSize=22 通道掩码=0x3
GetDevicePeriod → 默认 10.000 ms，最小 3.000 ms（100ns 单位 100000 / 30000），调用 1.262 ms
GetBufferSize(未 Initialize) → hr=0x88890001 AUDCLNT_E_NOT_INITIALIZED
GetService(IAudioClock, 未 Initialize) → 同一个 0x88890001
IsFormatSupported(SHARED, 44100/2/16) → S_FALSE，建议格式 = 48000/2/32bit float 掩码 0x3
IsFormatSupported(SHARED, 48000/2/16) → S_OK
IsFormatSupported(SHARED, 96000/2/16) → S_FALSE，建议同上
IsFormatSupported(SHARED, 44100/1/16) → S_FALSE，建议同上
IsFormatSupported(EXCLUSIVE, 44100/2/16) → S_OK
IsFormatSupported(SHARED, …, 第3参传 NULL) → 0x80004003 E_POINTER
```

四条规矩：

1. **共享模式的事实格式就是 `GetMixFormat` 那个**（本机 48000 Hz/双声道/32bit 浮点）。给它 16bit 整数它不会拒绝你，而是返回 `S_FALSE` 并告诉你"我建议用这个"——**`ppClosestFormat` 参数不能传 NULL**（传了直接 `E_POINTER`，我最初就是这么被卡的：同一格式带 out 参数是 `S_FALSE`，不带就 `E_POINTER`，看起来像参数校验 bug，其实是必填）。
2. `EXCLUSIVE` 模式在 `IsFormatSupported` 上答 `S_OK`，但**这只是"格式可以"**，能不能真占用设备取决于当时有没有别人在播（本机没测：见第六节）。
3. 周期数字：默认 10 ms、最小 3 ms。共享模式想压到 3 ms 以下基本是自我安慰；真正的低延迟要走独占模式 + 事件驱动。
4. `Initialize` 之前，任何和缓冲/时钟有关的调用都会给你 `AUDCLNT_E_NOT_INITIALIZED(0x88890001)`，而不是崩溃或 0 值——这是判断"我是不是漏了 Initialize"最便宜的信号。

**音量：两套账完全不通**。这是本机最漂亮的一组对照：

```text
winmm 侧   waveOutGetVolume(0..5)      → r=0, vol=0xFFFFFFFF（L=65535 R=65535，6 个设备全一样）
           mixer 主音量控件 量程[0,65535] 当前值 → 65535（100.0%），cDestinations=1
WASAPI 侧  GetMasterVolumeLevel        → -96.00 dB
           GetMasterVolumeLevelScalar  → 0.0000（3 次重复读：0.018/0.018/0.019 ms）
           GetVolumeRange              → [-96.0, 0.0] dB，步进 0.50 dB
           GetMute                     → 1（默认端点当前是静音的）
```

也就是说：**winmm 的"音量"永远读满格**，因为它读的是那条老 MME 通路上的设备虚拟音量，现代驱动把它固定成最大值；系统真正的端点音量/静音状态只有 `IAudioEndpointVolume` 知道。同一个进程的两次读数差了整整一个"静音 vs 满格"。另外我没能复现"应用独占音量导致 `E_NOT_SET`"：所有 4 次读取都是 `S_OK`（`E_NOT_SET=0x8007048B` 在 MinGW 头里也没定义，得自己 `_HRESULT_TYPEDEF_`）。

`Activate` 之后**不要**再缓存 `IAudioClient`：设备一变，旧接口所有调用变成 `AUDCLNT_E_DEVICE_INVALIDATED(0x88890004)`。本机没有热插拔条件，所以只测到"错误码存在、含义明确"，没实测到触发（见第六节）。

顺带 COM 的两个：`CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)` 4.281 / 4.892 ms；同线程再调 `COINIT_MULTITHREADED` → **`0x80010106` RPC_E_CHANGED_MODE**（不是"无效参数"，是模式已被定死）。这条对"UI 线程 STA + 工作线程 MTA"的划分很关键，而且**必须在工作线程里自己 `CoInitializeEx`**，否则 `CoCreateInstance(MMDeviceEnumerator)` 直接 `CO_E_NOTINITIALIZED`。

## 五、XAudio2：混音账、句柄账与队列上限

```text
第1次 XAudio2Create  hr=0 7.311 ms   句柄 197  Private=1732 KB
第2次 XAudio2Create  hr=0 0.029 ms   （同一进程第二个引擎几乎免费）
另一轮（跑过一次之后）第1次 XAudio2Create 0.112 ms ← 冷/热的差别在这里
CreateMasteringVoice(默认设备) hr=0 26.831 ms / 29.703 ms，句柄 200→278、206→284（+78）
  master: CreationFlags=131072 ActiveFlags=131072 InputChannels=2 InputSampleRate=48000
  master->GetVolume = 1.000（只读）
CreateMasteringVoice(DeviceId=L"1", …) → 0x88960001 XAUDIO2_E_INVALID_CALL，0.001 ms
```

- **`CreateMasteringVoice` 才是那笔贵账**（26.8–29.7 ms，+78 个内核句柄）：它要打开设备、建音频会话、起混音线程。所以"点一次音效建一个引擎+master"是错的——引擎和 master 进程级各建一次，用完不拆；音效只建 source voice。
- `DeviceId` 要传 `IMMDevice::GetId` 的那种 `{0.0.0.00000000}.{GUID}` 字符串，传 `"1"`（当成索引）立刻 `XAUDIO2_E_INVALID_CALL`。MinGW 头里参数名还叫 `UINT32 DeviceIndex` 的版本是 2.7/2.8 遗留接口，最新的 `IXAudio2` 参数是 `LPCWSTR DeviceId`，而且**头里少了最后一个参数 `AUDIO_STREAM_CATEGORY`**——调用时第 7 个实参（x64 走 r9）是垃圾值，它只是会话类别提示，本节不播声音所以看不出影响，但在 2.9 上这是个已知 ABI 坑。
- source voice 的量级（**全程不 `Start()`，一次都没发声**）：

```text
CreateSourceVoice 单价：首个 35.7–59.7 µs，之后平均 4.017 µs（400 个那轮）/ 5.535 µs（200 个那轮），末个 3.7–4.2 µs
创建 200 个 → 句柄 279（+1）、Private 4940 KB；创建 400 个 → 句柄 285、Private 5876 KB
未 Start 就 SubmitSourceBuffer(1 秒全零) → S_OK，GetState: BuffersQueued=1 SamplesPlayed=0
提交 1024 / 65536 / 1048576 / 20971520 / 104857600 字节 → 全部 S_OK，0.000–0.001 ms
同一 voice 连续提交 4096 字节：第 59 次（400 voice 那轮）/ 第 63 次（200 voice 那轮）失败 0x88960001
GetPerformanceData：MemoryUsageInBytes = 1239622（200 个）/ 2126128（400 个）字节
                     CurrentLatencyInSamples = 2848–2903（≈59–60 ms @48k）
                     GlitchesSinceEngineStarted = 0，ActiveSourceVoiceCount=0，TotalSourceVoiceCount=200/400
                     MinCyclesPerQuantum 900–1065，MaxCyclesPerQuantum 2165–9407
DestroyVoice ×200/400 → 句柄 279→285（没降）、Private 4940→6056 KB（反而升）
master DestroyVoice 8.800 ms；engine Release 0.518 ms 后 句柄 233、Private 2312 KB
```

读数解释：

1. **每个 source voice 只花 4–6 µs、约 5–6 KB 内存**（1.19 MB / 200 ≈ 6.0 KB；2.03 MB / 400 ≈ 5.2 KB），**且不占内核句柄**（+200 个 voice 句柄数只涨 1）。这与上一节"每个线程恰好 +1 个句柄、每个 GDI 对象 +1 个槽位"形成对照：XAudio2 的对象是**用户态**的。想要"同时放 32 个音"就建 32 个 voice，成本可以忽略。
2. **提交端不校验大小、只校验条数**：100 MB 缓冲一次性 `S_OK`（它只记指针），但队列里最多 59–63 个缓冲就返回 `XAUDIO2_E_INVALID_CALL`——`XAUDIO2_MAX_QUEUED_BUFFERS=64` 是上限，实测在 59–63 之间触发，说明驱动自己还要留 1–5 个余量。**同一个错误码 `0x88960001` 有两种成因**（非法调用 vs 队列满），拿错误文本判断不了，只能按上下文。
3. `CurrentLatencyInSamples≈2850–2900` 是**当前管线里已经排队的样本数**，@48 kHz 约 59–60 ms——这是"我的声音要多久后才出来"的下界估计，比 `GetDevicePeriod` 的 10 ms 大得多，因为里面还叠了缓冲策略。**Glitches=0** 说明没 Start 就没混音压力。
4. 释放 voice 之后私有内存反而上升、句柄不降：XAudio2 的内存池挂在引擎上，**要回收得 Release 引擎**（Release 后 2312 KB，接近基线 1732 KB）。所以"每次播放建/销引擎"除了慢还会抖动内存。
5. 冷热差别值得单独记：**同一轮里 `XAudio2Create` 第 1 次 7.311 ms、第 2 次 0.029 ms；跨轮重跑时第 1 次只花 0.112 ms**——第一次的成本主要是把 `XAudio2_8.dll` 和音频设备打开摊掉。两次数字都写在这是本节的规矩，不是我的修辞：**别只挑那个 0.112 ms 说"引擎创建很便宜"。**

MinGW 侧关于这个头的实话：`xaudio2.h` 里 `XAUDIO2_DEVICE_DETAILS`（DeviceID/DisplayName/Role/OutputFormat）这个结构体还在，但 `IXAudio2` **没有 `GetDeviceCount`/`GetDeviceDetails`**——那是 XAudio 2.8 之前删掉的接口，2.9 起设备枚举必须走 WASAPI。`XAUDIO2_VOICE_STATE` 也没有 `IsStopped` 位域（只有 `pCurrentBufferContext`/`BuffersQueued`/`SamplesPlayed`），方法名是 `SubmitSourceBuffer`（不是新版文档的 `SubmitBuffer`），链 `libxaudio2_8.a`（本机 `C:\Windows\System32\XAudio2_0..9.dll` 全在，所以运行时不缺）。`E_NOT_SET`、`AUDCLNT_E_*` 这些在 `audioclient.h` 里没有的定义，我都自己 `_HRESULT_TYPEDEF_` 补了一遍——**打印错误码时最好把十六进制原值也打出来**，否则只能靠猜。

## 六、本节未在本机实测的东西

- **是否真的出声**：无头验证做不到（我不能截图也不能"听"）。MCI 那条"打开成功、mode=playing、position 在推进"的 mp3 路径，本机早期 Qt 项目的实测结论是"成功但无声"；这里只补充可复核的部分：驱动是 `MPEGVideo`（mciqtz32.dll），而它的 `status` 属性集和 waveaudio **完全一样**——我本来想用"哪个驱动认哪个属性"来反推拿到的是哪个驱动，结果是否定结论：

  ```text
  status 属性探测（open 成功但未 play 时）
    wav 显式 waveaudio : mode=ok(stopped) length=ok(3000) position=ok(0) samples/frame/percentplayed/
                         numberofbackgroundtracks/overlap/cuesheet 全 ERR
    wav 按扩展名       : 同上，完全一致
    mp3 按扩展名(MPEGVideo): mode=ok length=ok(59947) position=ok(0) 其余 6 项同样全 ERR
    Alarm01.wav        : mode=ok length=ok(5572) position=ok(0) 其余全 ERR
  ```
  **想靠 MCI 命令支持面区分驱动是行不通的**，四个案例的 ERR/ok 集合一字不差。要区分只能回到注册表那张表，或者用只有 waveaudio 才认的 `record`/`save`（我没做，那要录音设备）。
- **热插拔**：`IMMDeviceNotificationClient::OnDefaultDeviceChanged/OnDeviceStateChanged` 没跑——需要真的拔掉/插入设备，本机没有可安全操作的物理设备，也不允许改系统音频设置。能实测到的只有：`DEVICE_STATE` 位（本机全是 0x1=ACTIVE）、`MASK_ALL` 与 `ACTIVE` 的数量差（6 vs 18）。
- **独占模式与真实低延迟**：没调 `IAudioClient::Initialize`（会建立真实音频会话并抢占设备，可能影响他人），所以只测到 `IsFormatSupported(EXCLUSIVE)=S_OK`，没测 `AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED(0x88890023)`、`AUDCLNT_E_DEVICE_IN_USE(0x8889000A)` 的触发条件，也没测事件驱动（`AUDCLNT_STREAMFLAGS_EVENTCALLBACK`）下的实际延迟分布。
- **XAudio2 播放中的混音质量**：所有 voice 都没 `Start()`（故意，避免向设备发任何东西），因此 `Glitches`、`AvgCycleCount`、变调/重采样计数（`ActiveResamplerCount`、`ActiveMatrixMixCount` 都是 0）只反映空闲状态；`SetVolume`/`SetChannelVolumes`/`SetOutputMatrix`/XAPO 效果链均未测。
- **MF 的视频/音频捕获设备数量**：`MFEnumDeviceSources` 按名字取不到（见第三节），所以捕获设备计数没测；WASAPI 的 `eCapture` 计数（5 个活跃）测到了。
- **Media Foundation 播放管线**（`IMFMediaEngine`/`EVRMixer`）、**DirectSound**、**MIDI (`midiOut*`：本机 `midiOutGetNumDevs()` 有返回，但没弹过一个音符)**、**蓝牙/空间音频**：都没做。
- **需要管理员的**：`IAudioEndpointVolume` 只测了读（`SetMute`/`SetMasterVolumeLevel*` 一律没碰，那是改系统状态）；系统级"通讯活动时自动降音量"（`IPartcalibrator`/Communications default device）未测。

## 小结

- **MCI 的全部命运写在一张 5 行的注册表里**（`MCI32`）：`waveaudio`=mciwave.dll、`MPEGVideo`=mciqtz32.dll（mp3/m4a/aac/wma/asf 都归它）、`Sequencer`=mciseq.dll、`CDAudio`、`AVIVideo`。`type mpeg3audio` 稳定 rc=263（0.275–0.333 ms 失败），m4a 按扩展名稳定 rc=277 但要 53.3–86.3 ms；`play` 提交 8.6–29.0 ms；position 头 1 秒慢 4–10%，稳态 0.999–1.001×；`list devices` 不支持（261）、`mciGetErrorStringW` 返回 BOOL 不是长度、"路径不存在"和"没打开就 play"共用 263。
- **PlaySoundW 便宜但不能混音**：`SND_ASYNC` 0.01 ms 返回、`SND_SYNC` 阻塞整段（3 秒素材就按住 3 秒），`SND_WAV` 在 MinGW 头里不存在。
- **MF 是快的那条路**：`MFStartup` 只有首次 2.5 ms 干活（版本错 → 0xC00D36E3）；首建 reader 30.2 ms、复用 1.2–1.9 ms；解码 400–2700 倍实时（60 秒 mp3→10.1 MB PCM 用 107.4 ms）；**缓冲粒度由解码器给**（MP3 86855 字节/块 vs AAC 4096 字节/块，迭代次数差 21 倍）；mp3 拿不到位深/比特率属性，`MF_PD_DURATION` 挂在音频流 media type 上取不到（0xC00D36E6）。
- **WASAPI 才是设备与格式的真账本**：活跃 6 / 全量 18 个渲染端点；`GetMixFormat`=48000/2ch/32bit float/掩码 0x3；`GetDevicePeriod`=10.000/3.000 ms；`IsFormatSupported` 共享模式对 44100/16bit 给 `S_FALSE`+建议格式，且 `ppClosestFormat` **不能传 NULL**（否则 `E_POINTER`）；`Initialize` 之前一律 `AUDCLNT_E_NOT_INITIALIZED`。
- **音量有两本账**：winmm 读 0xFFFFFFFF/65535（100%），WASAPI 读 −96.00 dB、scalar 0.0000、`GetMute=1`。想做"跟随系统音量"只能走 `IAudioEndpointVolume`（量程 [−96,0] dB、步进 0.5 dB）。
- **XAudio2 的成本几乎全在 master voice**（26.8–29.7 ms、+78 个内核句柄），source voice 只要 4–6 µs、约 5–6 KB、不占句柄，可以随便建几百个；提交不校验字节数（100 MB 也 `S_OK`）只校验条数（第 59–63 次撞 `XAUDIO2_E_INVALID_CALL`，上限 `XAUDIO2_MAX_QUEUED_BUFFERS=64`）；`CurrentLatencyInSamples≈2850–2900`（≈60 ms @48k）是空闲管线的真实延迟底；DestroyVoice 不归还内存，Release 引擎才归还。
- **给工程的一句话**：音效用 MF 解码到 PCM + 一个常驻 XAudio2 引擎 + 每次播放一个 source voice；设备/音量/热插拔用 WASAPI 端点 API；`MCI` 和 `PlaySound` 只留给"随便放个 wav 就行"的脚本，别指望它的错误码。
