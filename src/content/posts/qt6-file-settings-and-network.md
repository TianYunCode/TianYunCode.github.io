---
title: Qt 6 文件、设置与网络
description: >-
  实测：Qt 6.9 的 QtCore 已经没有 GBK/GB18030/Big5 这些编码器（QStringDecoder("GBK").isValid()=0），
  QTextStream 用 System 编码写"模型视图Qt"落盘 10 字节 C4 A3 D0 CD…（活动代码页 936），同一串 UTF-8 是 14 字节；
  同一个 CRLF 文件 raw 读回 9 字节 md5=8c8f2ff0…、Text 读回 6 字节 md5=40c53c58…；Text 模式下 readAll 会吞掉结尾孤立的一个 \r 而 readLine 留着；
  写 65536 字节未 flush 盘上立刻可见、写 4096 字节则盘上是 0；QSettings 的 ini 是 CRLF、组名里的斜杠写成 geometry\height、QDate 存成 @Variant 二进制；
  QNAM 发出的 GET 请求原文 161 字节且自带 accept-language: zh-CN,en,*；404/403/500 映射到 ContentNotFoundError(203)/ContentAccessDenied(201)/InternalServerError(401)，声明 gzip 给明文报 error=299；
  本机 QSslSocket::supportsSsl()=1，但编译基线是 OpenSSL 3.0.7、运行时加载的是 /ucrt64/bin 的 3.5.8；
  设一个连不上的 HttpProxy，127.0.0.1 目标照样成功、主机名目标才报 ProxyConnectionRefusedError(101)，走代理时请求行变成绝对 URL；
  QSQLITE 驱动 15 个特性位逐个可查、DATETIME 列读回来是 QString、QSqlQueryModel 的 flags=161 只读而 QSqlTableModel=163 可编辑。
date: 2026-10-16
tags: [Qt, 网络, 文件IO, QtSql, QSettings]
category: qt6
section: qt-io-network
---

> 环境同前面几节：**Qt 6.9.3 for MinGW**（`D:/Qt/6.9.3/mingw_64`）+ GCC 13.1.0 全路径（`D:/Qt/Tools/mingw1310_64/bin/g++.exe`，PATH 上那个 Strawberry Perl 4.9.2 32 位 g++ 会得出错误结论），`-O2 -DNDEBUG`，`QT_QPA_PLATFORM=offscreen`。**这一节几乎全是确定性证据**：字节数、十六进制、枚举数值、哈希串、HTTP 原文、报错原文，都不受本机负载影响，可逐条复核。网络部分**只打本机起的 `QTcpServer` 假 HTTP 服务**（把 Qt 发出的每个字节记下来），外部只读请求只有 `http://example.com/` 与 `https://example.com/` 各一次，不压测、不打写接口。**不截图**。探针与原始输出留在 `%TEMP%/agents/qt6f/io*.out`，Qt 6.9 的 API 删改是编译器真实报出来的错（第八节）；有四处我本想实测，结果函数在 6.9 里根本不存在，就退化成"报错原文 + 未实测"两条。

## 一、编码：QtCore 里已经没有中文编码了

Qt 5 时代用 `QTextCodec::codecForName("GBK")` 读老文件，Qt 6 把 QTextCodec 整个移出 QtCore（进可选的 Core5Compat）。6.9 的替代物是 `QStringConverter/QStringDecoder/QStringEncoder`，它**只认这几种名字**：

```text
  "UTF-8" / "utf8" / "UTF-16" / "UTF-16LE" / "latin1" / "ISO-8859-1"
        -> decoder.isValid=1 encoder.isValid=1
  "SYSTEM" / "GBK" / "GB18030" / "Big5" / "Shift-JIS" / "KOI8-R" / "Windows-1252" / ""
        -> decoder.isValid=0 encoder.isValid=0        // 全不支持
```

连 `System` 作为名字都不认（它是枚举值不是字符串）。**中文 Windows 上读 GBK 文件，Qt 6 官方路径只剩"自己转码"或"链 Core5Compat"**；`QStringConverter::availableEncodings()`/`systemEncoding()` 在 6.9 也不存在（第八节），你连"运行时到底有几种编码"都问不出来。

同一串 `模型视图Qt`（4 中文 + Qt）写到盘上：

| `setEncoding()` | 字节 | 前 6 字节 | 说明 |
| --- | --- | --- | --- |
| `Utf8` | **14** | `E6 A8 A1 E5 9E 8B` | 中文 3 字节/字 |
| `Utf16` / `Utf16LE` | **12** | `21 6A 8B 57` | 2 字节/字，**默认不写 BOM** |
| `Latin1` | **6** | `3F 3F 3F 3F 51 74` | 中文全变 `?`，静默丢数据 |
| `System` | **10** | `C4 A3 D0 CD CA D3` | 就是 **GBK**（代码页 936） |

`QString` 自己的三个转换与之一致：`toUtf8().size()=14`、`toLocal8Bit()` 10 字节 `C4 A3 D0 CD CA D3 CD BC 51 74`（和 System 编码**逐字节相同**）、`toLatin1()=6`。BOM 开关改名成 `setGenerateByteOrderMark(bool)`（Qt 5 的 `setGenerateHeader` 已不存在）：

```text
  Utf8+BOM   17 字节 first6=[EF BB BF E6 A8 A1]     关：14
  Utf16+BOM  14 字节 first6=[FF FE 21 6A 8B 57]     关：12
  Utf16LE+BOM 与 Utf16+BOM 完全一样 -> 默认端序就是 LE
```

`setAutoDetectUnicode(bool)` 的差别极大：UTF-16 带 BOM 的文件用 Utf8 流 + detect=true 能正确拿回原文；detect=false 得到 11 个字符、hex 里全是 `EF BF BD`（U+FFFD 替换符）；**UTF-16 不带 BOM 时 detect=true 也救不回来**。UTF-8 文件按 Latin1 读 → 14 个字符（原本 6 个），每字节一个字符。

`QTextStream` 的格式化（6.9 里 `Qt::fieldWidth/showpoint/setRealNumberPrecision` manipulator 都没了，只剩 setter + `qSetFieldWidth()`）：

```text
  42 | 3.14159 | fixed 3.141590 | precision(2) 3.14 | fieldWidth(6)+right "     7" | padChar('.') ".....7....."
  forcepoint 5.0 -> "5.00"    -0.0 -> "0.00"    1e20 -> "1e+20"   1/3 -> "0.333333"   0.1+0.2 -> "0.3"
  hex 255 -> ff ; showbase+hex -> 0xff ; uppercasebase -> 0Xff ; oct 8 -> 010 ; bin 5 -> 0B101
  bool true -> 1 / false -> 0（不是 "true"/"false"，写配置文件要小心）
  Qt::endl 在 QString 目标里只产生 1 个字符 0A —— QTextStream 不做换行转换，见第二节
```

## 二、换行、缓冲与错误原文

### 2.1 `QIODevice::Text` 到底转了什么

写 `"a\nb\nc\n"`（6 字节）：

```text
  WriteOnly（无 Text） : 盘上 6 字节 [61 0A 62 0A 63 0A]
  WriteOnly|Text       : 盘上 9 字节 [61 0D 0A 62 0D 0A 63 0D 0A]
  ReadWrite|Text       : 同上 9 字节
  写 "p\rq\n" 带 Text   : [70 0D 71 0D 0A]   <- 只把 \n 变 \r\n，孤立 \r 原样不动
```

读同一个 9 字节 CRLF 文件：

```text
  raw  : 9 字节含 3 个 \r  md5=8c8f2ff0bac61ccfb16c5bfc3a9b5c6a  sha256=a21249681e0ce224…f23328
  Text : 6 字节含 0 个 \r  md5=40c53c58fdafacc83cfff6ee3d2f6d69  sha256=880553fca8fcea94…e4d2
```

**同一个 `QCryptographicHash::addData(&file)`，打开模式差一个 `Text`，哈希值就不同**——做校验、增量同步、幂等导入时这是最隐蔽的 bug 源。而且 `readAll` 与 `readLine` 不一致（盘上 `"x\r\ny\nz\r"` 7 字节）：

```text
  Text readAll() : 5 字节 [78 0A 79 0A 7A]      <- 结尾那个孤立 \r 被整个吞掉
  raw  readAll() : 7 字节 [78 0D 0A 79 0A 7A 0D]
  Text readLine(): [2]78 0A  [2]79 0A  [2]7A 0D  <- 最后一行的 \r 还在
  raw  readLine(): [3]78 0D 0A  [2]79 0A  [2]7A 0D
```

Text 模式只在**遇到 `\n` 时**回溯吃掉前面的 `\r`；文件末尾没有 `\n` 的裸 `\r` 就说不清了。**别拿 Text 模式做行尾规范化**，自己 `replace("\r\n","\n")` 才确定。

### 2.2 写缓冲：什么时候才真落盘

用第二个 `QFileInfo` 读同一路径的 size 来观察"未 flush"状态：

```text
  写 65536 未 flush -> 盘上 65536   flush 后 -> 65536   再写 65536 未 flush -> 131072   close 后 -> 131072
  另一文件写 4096 未 flush -> 盘上 0     close 后 -> 4096
```

写缓冲 16384 字节，**超过就整块落盘**，小于一块的只在 `flush()`/`close()` 时可见。"日志文件是空的"就是这个原因。

### 2.3 QSaveFile 与错误原文

```text
  写入中：目标文件 exists=0（内容在临时文件里）  commit()=1 后：exists=1 size=5
  另开一个写 5 字节但不 commit 直接析构：目标仍是上次老值 hello（size=5）
  6.9 没有 QSaveFile::targetFileName()，只有 fileName()（返回临时名，别拿它判路径）
```

要么整体替换、要么完全不动——覆盖写配置就该用它。错误观察量：

```text
  文件不存在      : open=0 error()=5 errorString=[系统找不到指定的文件。]
  目录当文件读    : open=0 error()=5 errorString=[拒绝访问。]
  只读文件写      : open=0 error()=5 errorString=[拒绝访问。]
  System32/sam    : open=0 error()=5 errorString=[系统找不到指定的文件。]
  copy 源不存在   : bool=0 error()=0 errorString=[Unknown error]
  rename 目标已存在: bool=0 errorString=[Destination file exists]
```

三条：**① 四种失败 `error()` 全是同一个值 5，区分不了，只能读 `errorString()`；② `errorString()` 一半来自操作系统（跟随系统语言的中文），`Destination file exists` 这类是 Qt 自己造的英文——永远别拿它做程序判断；③ `QFile::copy()` 静态版失败后不会把 error 写回你的实例**。中文文件名没问题（`exists=1 size=5`），但 `canonicalFilePath()` 对不存在的路径返回空串。

## 三、路径 API 与 QStandardPaths

```text
  QDir::separator() = [\]（ASCII 92）
  toNativeSeparators("C:/a/b") = C:\a\b     fromNativeSeparators("C:\a\b") = C:/a/b
  cleanPath("C:/a/./b/../c") = C:/a/c       cleanPath("C:/a//b///c") = C:/a/b/c
  isAbsolutePath: "C:/x"=1  "/x"=1  "\\srv\share"=1  "a/b"=0
  QDir("C:/a/b").relativeFilePath("C:/a/b/c/d") = c/d
  rootPath=C:/  homePath=C:/Users/wangt  tempPath=C:/Users/wangt/AppData/Local/Temp
  QDir::drives() 7 个 = [C:/,D:/,E:/,F:/,U:/,Y:/,Z:/]
```

`separator()` 返回原生 `\`，但 **Qt 的 API 入参/返回值一律用 `/`**。规则：内部字符串用 `/`，只在给人看或交给只认反斜杠的第三方程序时 `toNativeSeparators()`。UNC 路径被认成绝对路径，对共享盘部署很关键。

`QFileInfo` 在本机的几个反直觉读数：

```text
  C:/Windows/System32/kernel32.dll : size=844496 permissions=0x6666 isWritable=1 isExecutable=0
  isExecutable: .exe=1  .dll=0  .txt=0        <- 只看扩展名，不是 ACL
  windeployqt.exe 的 owner()/group() 都是空串；目录的 size()=0（永远）
  entryList() 默认结果含 "." 和 ".."（默认 filter 是 AllEntries，不带 NoDotAndDotDot）
```

kernel32.dll 明明写不进去，`isWritable()` 说 1；`.dll` 不算可执行。**这两个函数在 Windows 上是 `_access()`/扩展名启发式，不能当权限检查**，要判权限就试 `open(ReadWrite)` 看 `errorString()`。

`QStandardPaths` 真实落点（org=`Qt6ProbeOrg` app=`Qt6ProbeApp`）：

```text
  AppConfigLocation    = C:/Users/wangt/AppData/Local/Qt6ProbeOrg/Qt6ProbeApp（standardLocations 5 个）
  AppDataLocation      = C:/Users/wangt/AppData/Roaming/Qt6ProbeOrg/Qt6ProbeApp
  AppLocalDataLocation = 同 AppConfigLocation
  GenericConfig/GenericData = C:/Users/wangt/AppData/Local   GenericCacheLocation = .../Local/cache
  Desktop/Documents/Download = C:/Users/wangt/{Desktop,Documents,Downloads}
  RuntimeLocation      = C:/Users/wangt        <- Windows 没有 XDG_RUNTIME_DIR，退到家目录
  ApplicationsLocation = .../Roaming/Microsoft/Windows/Start Menu/Programs
```

Windows 上 `AppConfig` 落 `Local`、`AppData` 落 `Roaming`（域控环境会随用户漫游），Linux 上前者是 `~/.config/…`。**`writableLocation()` 返回的目录不保证存在**，得自己 `mkpath()`（实测 `mkpath=1 open=1 remove=1`）。顺带：`QLocale::system().name()=zh_CN`、`uiLanguages=[zh-Hans-CN,zh-CN,zh-Hans,zh,en-Latn-US,…]`（第五节那个 `accept-language` 就是它）；`QStorageInfo("C:")` 给 `fsType=NTFS total=550019002368 free=168803471360`，`mountedVolumes()=7`。

## 四、QSettings：ini 文件的字节级长相

`IniFormat` 写独立文件，12 个 setValue 后 **276 字节、`\r` 计数 16、CRLF**，原文：

```ini
[net]
host=127.0.0.1
port=8080

[ui]
geometry\height=600
maximized=true
list=a, b, 中

[General]
top=3.5
bytes=@ByteArray(ab\0\x1)
point=@Point(3 4)
size=@Size(10 20)
date=@Variant(\0\0\0\xe\0%\x8ds)
dt=@DateTime(\0\0\0\x10\0\0\0\0\0\0%\x8ds\0\xa8\x88\x88\0)
```

五件事：**① ini 也是 CRLF**；**② key 里的层级 `/` 被转成 `\`**（`ui/geometry/height` → 组 `[ui]` 键 `geometry\height`），手工编辑要写反斜杠；**③ 顶层 key 进 `[General]`**；**④ `QStringList` 用逗号+空格连接**（含逗号的值要靠转义，读回必须 `toStringList()`）；**⑤ `QDate`/`QDateTime` 不是人读的**——`@Variant(\0\0\0\xe…)` 是按 `QDataStream` 塞进去的 `QMetaType` id + Julian 天数。**给用户改的配置文件里存日期请存字符串**，否则用户手改一次就废。

读回与状态：

```text
  port=8080（metaType=int，不是字符串） maximized->toBool()=1 list=a/b/中 bytes 读回 hex=61620001（含 0x00 原样）
  allKeys 数=11 [bytes,date,dt,net/host,net/port,point,size,top,ui/geometry/height,ui/list,ui/maximized]
  childGroups=[net,ui]  childKeys()=[bytes,date,dt,point,size,top]     <- Qt6 的 childKeys 不收前缀参数
  value("ui/nope","DEF")=[DEF]   remove("net/port")+sync -> 276 变 265 字节
  clear()+sync() -> 文件字节数=0，但文件仍存在
```

key **不区分大小写**：写 `B/k`、`a/k`、`A/j` 之后 `allKeys=[A/j,B/k,a/k]`（文件里也确实写出 `[B] [a] [A]` 三段），而 `A/j`、`a/J`、`b/K` 读回来分别是 3、3、2——**写的时候大小写不同会产生两份，读的时候互相遮蔽**，这是"配置偶发丢失"的经典成因，键名请固定一种写法。

错误处理只剩 `status()`，而 6.9 的枚举**只有三个值**：

```text
  Status: NoError=0 AccessError=1 FormatError=2      （Qt5 的 WriteError/ReadError/UnreadableVersionError 全没了）
  往 C:/Windows/…/x.ini 写：sync -> status=1 isWritable=0，但 contains("a")=1  <- 内存里还在，落不了盘
  QSettings 没有 errorString()
```

**无法区分"文件读坏了"和"没权限"**；想确认写成功，只能 `sync()` 后自己 `QFile::exists()` + 比字节数。`NativeFormat` 在 Windows 就是注册表（**本节只读不写**）：默认构造 `format=0 scope=0 fileName=[\HKEY_CURRENT_USER\Software\Qt6ProbeOrg\Qt6ProbeApp] allKeys=0`；同一 org/app 换 `IniFormat+UserScope` → `C:/Users/wangt/AppData/Roaming/Qt6ProbeOrg/Qt6ProbeApp.ini`。**换 format 就换落点**，这就是"我的设置不见了"最常见的答案（注册表 32/64 位视图未实测，见第九节）。

## 五、QtNetwork：QNAM 到底发了什么、收回来什么

方法论：**自己起 `QTcpServer` 当假 HTTP 服务端**，把 Qt 发来的字节原样打印——这能拿到抓包工具给不了的"发送前"信息，且不依赖外网。一次 `nam.get()`（本机 9551 端口）：

```text
GET /plain HTTP/1.1
host: 127.0.0.1:9551
user-agent: qt6-io-probe/1.0
connection: Keep-Alive
accept-encoding: gzip, deflate
accept-language: zh-CN,en,*
<空行>
```

**整个请求 161 字节、服务端一次 `readyRead` 收完（分块尺寸=[161]）**。① Qt 默认声明 `accept-encoding: gzip, deflate` 并要求 Keep-Alive；② `accept-language` 由 `QLocale::system().uiLanguages()` 拼出，**跟操作系统语言走**；③ 响应头在 `rawHeaderList()` 里被小写化（`content-type`、`x-custom`），但 `rawHeader()` 查找不区分大小写，4 个响应头都能取到。

状态码 → `error()` 映射（每行都是独立请求）：

| 服务端返回 | `error()` | 原文 | body |
| --- | --- | --- | --- |
| `404 Not Found` | **203 ContentNotFoundError** | `Error transferring … - server replied: Not Found` | 4 `nope` |
| `403 Forbidden` | **201 ContentAccessDenied** | `… server replied: Forbidden` | 3 |
| `500 Oops` | **401 InternalServerError** | `… server replied: Oops` | 3 |
| `204 No Content` | 0 NoError | — | 0 |
| 声明 `Content-Encoding: gzip` 却给明文 | **299 UnknownContentError** | `Decompression failed: ` | 0 |
| 两个 `Content-Length: 3` / `9` | 0 NoError | — | **3**（取第一个） |
| 无 Content-Length + `Connection: close` | 0 NoError | — | 14（靠关闭定界） |
| `Transfer-Encoding: chunked`（hello+world） | 0 NoError | — | **10 `helloworld`**（Qt 拆块） |
| 连 127.0.0.1:1 | 1 ConnectionRefusedError | `Connection refused` | — |
| 不存在的 host `.invalid` | **499 UnknownServerError** | `… server replied: Bad Gateway` | — |

两行要点：**HTTP 状态码不是错误码**，`error()==NoError` 不代表成功（表里 203/201/401 是 Qt 给的，别按 HTTP 语义猜）；`.invalid` 那行为什么不是 `HostNotFoundError(3)`——**因为本机默认代理接管了它**（第六节），DNS 都没解析，是代理回的 502。

重定向（302 → `/final`）四种策略：

```text
  NoLessSafe : error=0 最终 url=/final body=[FINAL] RedirectionTarget 属性=[]（已跟完）
  SameOrigin : error=0 最终 url=/final body=[FINAL]
  Manual     : error=0 httpStatus=302 body=[] rawHeader(Location)=[/final]
  UserVerified: error=0 最终 url=/final body=[]（我没接 redirected()，等于谁也没批准）
  QNetworkReply::redirectCount() 在 6.9 不存在，跳了几次只能自己数
```

信号计数（4096 字节响应，一次 GET）：`metaDataChanged=1 downloadProgress=1(声明 4096) readyRead=1(累计可读 4096) finished=1`，**`started` 信号在 6.9 已删除**。这里必须承认一处失败：我改用裸 `QTcpSocket` + `waitForReadyRead()` 轮询数分块时读到 **0 块**（`waitForDisconnected` 也没等到断开，state 还停在 3）——**轮询函数与信号槽混用会得到不可信的形状**，"服务端分三次写出、客户端收到几块"我没有可靠数据，列进第九节。

POST 原文（body 15 字节 `a=1&b=%E4%B8%AD`）：`POST /postme HTTP/1.1` + `host / user-agent / content-type: application/x-www-form-urlencoded / x-my-header: abc / content-length: 15 / connection: Keep-Alive / accept-encoding / accept-language`。`setRawHeader("X-My-Header","abc")` 落地成小写头名，`content-length` 由 Qt 计算；**6.9 没有 `setCustomHeader()`**。

`QNetworkDiskCache`（`PreferCache`，同 URL 连打两次）：`cacheSize 0 -> 17198 字节`，两次 `SourceIsFromCacheAttribute` 都不是 true——**服务端没给 `Cache-Control`/`Expires` 的响应 Qt 不缓存**。枚举值钉死：

```text
  Attribute: HttpStatus=0 Reason=1 RedirectionTarget=2 ConnectionEncrypted=3 CacheLoadControl=4
             CacheSaveControl=5 SourceIsFromCache=6 Http2Allowed=20 RedirectPolicy=21 User=1000
  KnownHeader: ContentType=1 ContentLength=2 Location=4 UserAgent=12 Server=16 NumKnownHeaders=24
  RedirectPolicy: Manual=0 NoLessSafe=2 SameOrigin=3 UserVerified=4
  NetworkError: NoError=0 ConnRefused=1 HostNotFound=3 Timeout=4 Canceled=5 SslHandshakeFailed=6
                TooManyRedirects=10 ProxyRefused=101 ProxyNotFound=103 ProxyTimeout=104
                ContentNotFound=203 AuthRequired=204 ProtocolInvalid=302 InternalServerError=401
```

## 六、TLS 与代理

**先纠正任务书里的假设：本机 `supportsSsl()` 是 1，https 通。**但这恰恰是更值钱的部署证据：

```text
  sslLibraryBuildVersionString() = [OpenSSL 3.0.7 1 Nov 2022]    <- Qt 编译基线
  sslLibraryVersionString()      = [OpenSSL 3.5.8 25 Aug 2026]   <- 运行时真加载到的
  supportedProtocols() 数=14  isProtocolSupported(TlsV1_2)=1
  implementedClasses=[0..6]（Key/Certificate/Socket/DiffieHellman/EllipticCurve/Dtls/DtlsCookie 全在）
  supportedFeatures=[0..6]（CertificateVerification/ClientSideAlpn/ServerSideAlpn/Ocsp/Psk/SessionTicket/Alerts）
  QSslConfiguration(): protocol=0x4  caCertificates=0  supportedCiphers()=60
  QSslConfiguration::systemCaCertificates()=58（DigiCert Trusted Root G4 | Microsoft Root CA | Thawte…）
  https://example.com/ -> error=0 httpStatus=200 body=577 字节 ConnectionEncrypted=true
  http://example.com/  -> error=0 httpStatus=200 body=577 字节（对照）
```

那个 3.5.8 从哪来？`/ucrt64/bin/libcrypto-3-x64.dll`（5393052 字节）与 `libssl-3-x64.dll`（959132 字节）——**Git Bash/MSYS2 的目录**，Qt 自己的 `mingw_64/bin` 里一个 OpenSSL DLL 都没有。**换台机器、换个 shell（双击 exe、服务账户、CI runner）就没了**，这正是第 12 节 `windeployqt --force-openssl` / `--openssl-root` 的动机。另外：**默认 `QSslConfiguration` 的 `caCertificates()=0`**（不含任何 CA），要校验必须自己加（`addCaCertificates(QSslConfiguration::systemCaCertificates())`）。

代理部分最反直觉：**Qt 对 `127.0.0.1` 这类本地目标会绕过 `applicationProxy`**。

```text
  一次 setApplicationProxy 都没调时：applicationProxy() = type=3(HttpProxy) host=127.0.0.1 port=7890
  环境里没有任何 *_proxy 变量 -> 这是 Qt 从 Windows 系统代理设置里拿的
  systemProxyForQuery(默认构造)      = [type=3 host=127.0.0.1 port=7890]
  systemProxyForQuery(本机 http URL) = [type=2(NoProxy)]
  systemProxyForQuery(外部 http URL) = [type=3 host=127.0.0.1 port=7890]
  systemProxyForQuery(TcpSocket 27017)= [type=2]
```

设成必然连不上的 `HttpProxy(127.0.0.1:1)`，对本机服务发两次：

```text
  GET http://127.0.0.1:12063/localhost-target -> error=0 NoError body=[ok]  服务端收到连接=有
                                                请求行=[GET /localhost-target HTTP/1.1]
  GET http://Terminal:12063/named-target      -> error=101 ProxyConnectionRefusedError text=[Connection refused]
                                                服务端收到连接=没有
```

**同一进程、同一个坏代理：目标写 IP 就成功，写主机名就失败。**"我设了代理为什么没走"和"我故意断网做降级为什么还通"都在这。把假服务端真当代理用，请求行立刻变成绝对 URL：

```text
  走代理  : GET http://terminal:12063/proxied HTTP/1.1     <- 绝对 URL，代理该有的样子
  NoProxy : GET /noproxy-now HTTP/1.1
  ProxyType 枚举: Default=0 Socks5=1 NoProxy=2 Http=3 HttpCaching=4 FtpCaching=5
```

（主机名 `Terminal` 被 Qt 小写进 URL。）想给单个请求设代理在 6.9 不行：`QNetworkRequest::ProxyAttribute` 不存在，`QNetworkProxy::AuthenticationMethod`/`NoAuthentication` 也删了，连 `prefersAuthentication()` 都报"没有这个成员"（第八节）——**能用的只有应用级 `setApplicationProxy` 和 `QNetworkProxyFactory` 子类**（后者未实测）。

QLocalServer/QLocalSocket（跨进程单实例常用）：

```text
  listen("qt6io-probe-30792")=1  serverName()=[qt6io-probe-30792]  fullServerName=[\\.\pipe\qt6io-probe-30792]
  listen("a/b\c:d")=1（Windows 不报错，Linux 上会失败：'/' 被当路径）
  QLocalSocket::connectToServer + waitForConnected(2000)=1 state=3
```

`fullServerName()` 直接给命名管道全名，排查"单实例没生效"时去 `\\.\pipe\` 找同名管道即可；"同一个名字在一个平台成功、另一个平台失败"是第 12 节平台差异清单的一项。

## 七、QtSql：只讲 Qt 这一层

SQL 本身在 `db-*` 那一栏实测过，这里只看封装层给了什么、藏了什么。

```text
  QSqlDatabase::drivers() = QIBASE, QMIMER, QOCI, QODBC, QPSQL, QSQLITE（6 个），isDriverAvailable 全部 =1
  逐个 open()：QIBASE/QMIMER/QOCI/QPSQL -> open=0 type=1 text=[Driver not loaded Driver not loaded]
               QODBC -> open=0 native=[0] text=[[Microsoft][ODBC 驱动程序管理器] 未发现数据源名称并且未指定默认驱动程序, IM002 QODBC: Unable to connect]
               QSQLITE -> open=1 type=0 text=[]
```

**`isDriverAvailable()` 返回 1 而 `open()` 失败是常态**（缺 `libpq.dll`/`oci.dll`），`Driver not loaded` 打印两遍是 Qt 原样拼的（`driverText + " " + text`）。要提前发现只能真 `addDatabase + open` 一次读 `lastError().text()`。QODBC 那条说明**插件已加载成功、错误来自 ODBC 管理器**——"加载"和"连上"是两个阶段。

QSQLITE 的 15 个特性位（括号是 `DriverFeature` 枚举值）：

```text
  Transactions(0)=1 QuerySize(1)=0 BLOB(2)=1 Unicode(3)=1 PreparedQueries(4)=1
  NamedPlaceholders(5)=1 PositionalPlaceholders(6)=1 LastInsertId(7)=1 BatchOperations(8)=0
  SimpleLocking(9)=1 LowPrecisionNumbers(10)=1 EventNotifications(11)=1 FinishQuery(12)=1
  MultipleResultSets(13)=0 CancelQuery(14)=0
```

**`QuerySize=0` 意味着 `QSqlQuery::size()` 不可信**（实测普通 SELECT `size()=-1`，`forwardOnly` 遍历 5 行后也是 -1）；`BatchOperations=0` 意味着 `execBatch()` 是驱动层循环模拟（实测返回 1 但 `numRowsAffected()=-1`）。`setConnectOptions("QSQLITE_BUSY_TIMEOUT=1000")` 可设可回读；schema 版本只能自己 `PRAGMA user_version`（设 7 读回 7），因为 **Qt 6.9 的 `QSqlDatabase` 没有 `version()/setVersion()`**。Qt 内嵌 SQLite 是 3.50.4，细节看数据库栏。

类型映射（`INTEGER PRIMARY KEY / TEXT / REAL / VARCHAR(16) / DATETIME / BLOB / INTEGER`）：

```text
  id->int  name->QString  score->double  tag(VARCHAR16)->QString(length=-1)
  when_added(DATETIME)->QString   blob_col->QByteArray   nullcol(INTEGER)->int
  NULL 列的 QVariant：isValid=1 isNull(列)=1 metaType=QString toString=[] toInt=0 toDouble=0
  precisionPolicy：HighPrecision / LowPrecisionInt32=1 LowPrecisionInt64=2 LowPrecisionDouble=4（没有裸 LowPrecision）
```

**DATETIME 在 QtSql 层就是 QString**（要 `QDateTime` 得自己解析）；`VARCHAR(n)` 的 n 不参与校验；**NULL 是 `isValid()=1` 且 `isNull()=1`**——委托里要判 `isNull()`，不是 `!isValid()`。

`QSqlQueryModel` 与第 6 节的接缝：

```text
  rowCount=5 columnCount=3  headerData(0,H,Display)=[id]（SQL 列名）  headerData(1,V,Display)=[2]（行号从 1）
  index(0,0).data()=[1] type=qlonglong      <- INTEGER 在 data() 里是 qlonglong，与 record 报的 int 不同
  flags(index)=161[Selectable|Enabled|NeverHasChildren]   setData() 返回 0（只读）
  rowCount(index(0,0))=0；parent()/hasChildren() 是 private；index(999,0).isValid=0 越界不崩
  record(1).count=3 value(name)=[名字2]     canFetchMore(root)=0  <- SQLite 没有增量取
  setQueryBehavior/QuerySkipResult 在 6.9 不存在；setQuery(QSqlQuery) 只能整条换
```

**flags=161 不含 `Editable`**，所以视图里双击毫无反应（和第 6 节 4.4 的 `edit()` 静默失败同机制）；`QSqlTableModel` 是 **163**（多 `Editable=2`），而且**主键列也是 163**（id 照样可编辑，要禁得自己重写 `flags()`）。表头文本直接来自列名：`id | name | score | tag | when_added | blob_col | nullcol`。

三种 `EditStrategy`（用另一个 `QSqlQuery` 直读 DB 真值）：

| 操作 | 模型缓存 | DB 真值 |
| --- | --- | --- |
| `OnManualSubmit` + `setData` | 新值，`isDirty(index)=1 isDirty()=1` | 旧值 |
| `OnManualSubmit` + `submit()` | 新值 | **仍旧值**（`submit()` 返回 1 但没落库） |
| `OnManualSubmit` + `submitAll()` | 新值 | **新值**（提交测试），`isDirty()=0` |
| `OnFieldChange` + `setData` | 新值 | **立刻新值**（即时改） |
| `OnRowChange` + `setData`（不切行） | 新值 | 旧值（名字4） |

**`OnManualSubmit` 下 `submit()` ≠ `submitAll()`**，这条最容易搞错。`editStrategy()`/`filter()`/`tableName()` 能读回，但 **`sortColumn()/sortOrder()` 在 6.9 没有 getter**（`setSort()` 只有 setter；和第 6 节 `QHeaderView::resizeMode` 同家族）。其余：`setFilter("id > 2")+select()` 行数 5→3、清空回 5；`setSort(0,Desc)+select()` 后第 0 行 id=5；`selectRow(1)=0`、`fieldIndex("score")=2`、`t.record()` 是 7 字段的空模板。

`QSqlRelationalTableModel`（`dept(id,dname)` + `emp(id,ename,dept)`）：

```text
  rowCount=2 colCount=3  第 0 行第 2 列：Display=[测试部] Edit=[10]
  relationModel(2) -> QSqlTableModel rowCount=2 第(0,1)=[研发部]
  relation(2): table=[dept] indexCol=[id] displayCol=[dname]；未设关系的列 relation(1).isValid=0
  关系列 flags=163，普通列 flags=163
```

这就是"下拉选外键"的实现：视图用 `DisplayRole` 显示名字、编辑用 `EditRole` 的 id，`relationModel(column)` 直接给委托当数据源。**6.9 的函数是 `relationModel(int column)`**，Qt 5 的 `relatedModel(tableName, index)` 已删。另有两处"返回成功但 DB 未变"（空结果集 `insertRow+setData+submit` 后再 select 行数 0；关系列 `submitAll()=1` 而外键仍是旧值 20）我只观察到一次，**没能定位稳定复现条件，不下结论**（第九节）。

## 八、Qt 6.9 的删改：本节报错原文

`g++ -std=c++17` 真实报出来的（一条一行）：

```text
  QTextCodec::codecForName("GBK")        error: 'QTextCodec' was not declared in this scope（需 Core5Compat）
  QStringConverter::availableEncodings() error: is not a member of 'QStringConverter'
  QStringConverter::systemEncoding()     error: is not a member of 'QStringConverter'
  QLibraryInfo::buildAbi()/buildKey()    error: is not a member of 'QLibraryInfo'  → build()/version()
  QTextStream::setGenerateHeader(bool)   error: has no member named 'setGenerateHeader' → setGenerateByteOrderMark()
  Qt::fieldWidth / Qt::showpoint / Qt::setRealNumberPrecision   error: is not a member of 'Qt'
  QSaveFile::targetFileName()            error: has no member named 'targetFileName'; did you mean 'setFileName'?
  QFileInfo::drive()/errorString()/isSystem()/accessTime()      error: has no member named … → lastRead()
  QSettings::childKeys("ui")             error: no matching function for call to 'QSettings::childKeys(const char [4])'
  QSettings::isValidKey(x)               error: has no member named 'isValidKey'
  QSettings::WriteError/ReadError/UnreadableVersionError        Status 只剩 NoError=0 AccessError=1 FormatError=2
  QStorageInfo::volumes()                error: is not a member of 'QStorageInfo' → mountedVolumes()
  QStandardPaths::displayName(…)         warning: deprecated
  QHostAddress::Localhost                error: is not a member of 'QHostAddress' → LocalHost（多一个 b）
  QNetworkRequest::setRedirectPolicy(p)  error: has no member named 'setRedirectPolicy' → RedirectPolicyAttribute
  QNetworkRequest::ProxyAttribute / NoCacheLoadAttribute / IfModifiedSinceAttribute / LastModifiedAttribute /
      MaximumRedirectsAttribute / RedirectionFromAttribute / RedirectionHistoryAttribute /
      MaximumRedirectsFollowedAttribute / CacheResponseTimeAttribute / CacheSavedTimeAttribute
                                         error: is not a member of 'QNetworkRequest'
  QNetworkRequest::isValid() / setCustomHeader(a,b)   error: has no member named … → setRawHeader()
  QNetworkRequest::UserVerifiedRedirects / NoRedirectsPolicy / InsecureRedirectPolicy
                                         error: is not a member（Qt5 的策略名换了一批）
  QNetworkReply::started                 error: is not a member of 'QNetworkReply'
  QNetworkReply::redirectCount()         error: has no member named 'redirectCount'; did you mean 'redirected'?
  QNetworkReply::SslInternalError / SslInvalidUserDataError     error: is not a member
  QNetworkReply::sslErrors()             error: no matching function（候选是信号 void sslErrors(const QList<QSslError>&)）
  QNetworkReply::sessionTicket() / sslPeerCertificate()         error: has no member named …
  QNetworkProxy::ConnectingHttpProxy / NoAuthentication / authenticationMethod() / prefersAuthentication()
                                         error: is not a member of 'QNetworkProxy'
  QNetworkProxyFactory::systemProxyForQuery(QNetworkRequest)    error: cannot convert 'QNetworkRequest' to 'const QNetworkProxyQuery&'
  QSslSocket::sslLibrariesLoadFailed     error: is not a member（6.8+ 新后端不再发这个信号）
  QSslSocket::errors()                   error: has no member named 'errors'; did you mean 'error'?
  QSslSocket::systemCaCertificates() / defaultConfiguration()   error: is not a member → QSslConfiguration:: / 实例 sslConfiguration()
  QSslConfiguration::supportedVersions()/tlsOptions()/allowedProtocols()/pkcs12Engines()/state()/maximumCertificateChainDepth()
                                         error: has no member named …
  QSsl::SslOptionDisableTlsV1_0          error: is not a member of 'QSsl'（SslOption 只剩 8 个 Disable*）
  QTcpServer::serverName() / QTcpSocket::isConnected() / socketDescription() / bytesWritten()
                                         error: has no member named …（最后一个现在是信号）
  QSqlDatabase::version()/setVersion()   error: has no member named 'version'
  QSqlDriver::Prepare / LastInsertedId / LowMemoryResultFetch / SQLComments
                                         error: is not a member → PreparedQueries / LastInsertId /（后两个直接没了）
  QSqlQuery::isPrepared() / shape() / cacheSize() / setAt() / isValueChangeable()   error: has no member named …
  QSqlQuery::bindValues(":i", QVariantList)                     error: has no member named 'bindValues'
  QSqlField::sqlType()/isRequired()/validation()；type() 警告 deprecated → metaType()/requiredStatus()
  QSqlRecord::clarity()                  error: has no member named 'clarity'
  QSqlQueryModel::cacheSize() / QuerySkipResult / QueryNoBehavior  error: has no member / is not a member
  QSqlTableModel::canResetModel()/rowIsDirty()/hasQuerySelect()/sortColumn()/sortOrder()/primaryKeyValues()/whereClause()
                                         error: has no member named … 或 is protected within this context
  QSqlRelationalTableModel::relatedModel("dept", index)         error: has no member; did you mean 'relationModel'?
  QSqlRelation::indexColumnNames()/displayColumnNames()         error: has no member（只剩单数）
  QSqlResult::at()/isSelect()/isActive()/bindingSyntax()        error: is protected within this context
  model->parent(index)/hasChildren(index)  error: 'virtual QModelIndex QAbstractTableModel::parent(...)' is private within this context
  Qt::ItemIsNeverHasChildren             error: is not a member; did you mean 'ItemNeverHasChildren'?
```

三个重灾区：**`QNetworkRequest` 的 attribute 表被大改**（重定向上限、缓存时间、If-Modified-Since 属性全没，只剩 `RedirectPolicyAttribute` + `setTransferTimeout`）；**`QSslConfiguration` 被新 TLS 后端架构重做**（`supportedVersions/tlsOptions/allowedProtocols` 换 `protocol()` + `setSslOption()` + `QSslSocket::supportedProtocols()`）；**QtSql 的"读回型 getter"删了一批**（`sortColumn/sortOrder/rowIsDirty/clarity/cacheSize`），和第 6 节 `QHeaderView::resizeMode` 同一类——**只有 setter 的 API 让你没法在测试里断言状态**。

## 九、本节未在本机实测的内容

- **`supportsSsl()` 为 0 的场景**：本机因 PATH 上有 `/ucrt64/bin/libssl-3-x64.dll` 而能跑 https。干净机器上（Qt 目录确实没带 OpenSSL）`supportsSsl()` 返回什么、https 报错原文、`--force-openssl`/`--openssl-root` 部署后的差别——留给第 12 节在独立部署目录里实测；`sslLibrariesLoadFailed` 在 6.9 已不存在，"加载失败回调"这条老路也无从验证。
- **SChannel 后端**：`windeployqt --list` 的插件清单里有 `tls: qcertonlybackend / qopensslbackend / qschannelbackend`，但"只留 qschannelbackend 时 https 是否仍通"、`QT_TLS_BACKEND` 环境变量都未验证。
- **证书校验失败路径**：`QSslError` 的产生、`ignoreSslErrors()` 的放行效果、自签证书、主机名不匹配——本机没有可信的 HTTPS 自签服务端（`QSslKey` 不能生成新私钥），一条都没测；只测到默认配置 `caCertificates()=0`、系统 CA 58 张。
- **HTTP/2、认证、Cookie**：`Http2AllowedAttribute` 只打了枚举值，没验证是否协商 h2；`AuthenticationRequiredError(204)` 没用需要 Basic 认证的服务端验证；`QNetworkCookieJar` 完全未测。
- **`QNetworkDiskCache` 命中**：只测"无 Cache-Control → 两次都不命中、缓存目录写 17198 字节"。带 `max-age` 的第二次是否 `SourceIsFromCacheAttribute=true`、`PreferNetwork/AlwaysCache`、`expire()/clear()` 未测。
- **服务端分次写出的粘包形状**：第五节那条失败记录（轮询读到 0 块）。多块写出、跨 16KB 边界的形状未测；"4096 字节一次到位"只有信号版一个数据点。
- **真实代理服务器**：`127.0.0.1:7890` 是从系统设置读到的，未用它验证 HTTPS CONNECT 隧道、`ProxyAuthenticationRequiredError`、PAC 脚本；`QNetworkProxyFactory` 子类定制未测。
- **`QSettings` 注册表细节**：只做了只写盘以外的只读观察。**32/64 位视图（WOW6432Node）、`setPath()` 改根目录、`Fallbacks` 组合、读老版本 ini** 未验证（写注册表属于改机器状态，我没做）。
- **QtSql 其他驱动与可疑写回**：`QPSQL/QOCI/QIBASE/QMIMER` 只到"插件加载失败"，`QODBC` 拿到原生 IM002 但无真实 DSN；**空结果集 `insertRow()+submit()` 与关系列 `submitAll()` 那两处"返回成功但 DB 未变"没有稳定复现条件**，本节不下结论。
- **大文件与并发 IO**：文件只测到 131072 字节（`resize()` 扩大后补 0 已确认，尾部 7 字节 `00 00 00 00 00 00 00`）。吞吐、`QSaveFile` 在文件被占用/断电下的行为、跨线程 IO 未测（多线程归第 9 节）。
