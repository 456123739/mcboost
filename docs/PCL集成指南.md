# 在 PCL CE / PCL2 里加速下载整合包

本文说明如何让 PCL CE（或官方 PCL2）下载整合包时走多连接分片加速。

> **关于 PCL CE 的重要更正**：PCL CE（`PCL-Community/PCL-CE`）是 **C# / .NET 10.0-windows** 写的，与官方 PCL2（VB.NET / .NET Framework 4.8）是**两套完全不同的代码库**。
> 本文的源码分析部分分别标注了适用对象，请按你实际使用的版本查看。

---

## 一、先说结论：PCL CE 为什么慢

读 `PCL-Community/PCL-CE` 源码（`ModNet.cs`、`AdaptiveRangeDownloader.cs`）确认：

### 单文件连接数被硬编码为 8

```csharp
// PCL.Core/... /Plain Craft Launcher 2/Modules/Network/Facade/ModNet.cs
public const int NetTaskSingleFileConnectionLimitMax = 8;   // ← const，不可配置
public static int NetTaskSingleFileConnectionLimit { get; set; } = 8;
```

CE 的下载器本身写得不错（`AdaptiveRangeDownloader`：8MB 目标分段、慢连接检测、Channel 工作队列、可扩展到 2048 段），**但单文件最多只能开 8 个连接**。

### 这 8 连接的代价（本机实测）

同一文件（Modrinth CDN，rotrBLOCKS 185.9MB）、同一时刻、同一网络：

| 配置 | 耗时 | 速度 |
|---|---|---|
| **PCL CE 上限**：8 连接 / 8MB 分段 | 68.4s | **2.7 MB/s** |
| mcboost：16 连接 / 512KB 分段 | 13.0s | 14.3 MB/s |
| mcboost：24 连接 / 512KB 分段 | 10.1s | **18.3 MB/s** |

**PCL CE 的硬编码上限让速度损失约 6.8 倍。**

另外两个次要因素：

- `SmallFileThreshold = 4MB`：小于 4MB 的文件走顺序下载，小文件拿不到分片加速。
- 全局连接上限 `NetTaskConnectionLimit = 64`，所有文件共享。

### 关于"改设置能不能解决"

不能。`NetTaskSingleFileConnectionLimitMax` 是 `const`，CE 的 UI 设置项最多让你在 1~8 之间选。**要突破 8，只能替换下载器本身。**

---

## 二、官方 PCL2 的情况（不同，别混淆）

如果你用的是官方 PCL2（VB.NET），瓶颈不一样：

- 下载引擎**也有分片**（`ModNet.vb` 的 `TryBeginThread`）。
- 但有一份**域名黑名单**：URL 含 `bmclapi`、`github.com`、`optifine.net`、`momot.rs`、`meloong.com`、`pcl2-server` 时**强制单线程**。
  → **在 PCL2 里配 BMCLAPI 这类国内镜像，反而会让所有模组退化成单连接。** 这是"明明开了镜像还慢"的隐形原因。
- 线程上限全局共享（`ToolDownloadThread + 1`）。

---

## 三、方案一：本地加速代理（已实现，推荐）

思路：mcboost 起一个本地 HTTP 服务，PCL 把文件下载源指向它。PCL 以为自己在做一次普通下载，实际上字节是 mcboost 用 16~24 连接拉下来再流式回传的。

**分片全部发生在代理内部，PCL 的连接数限制完全不起作用。**

### 启动

```bash
cd mcboost
node bin/mcboost.js proxy --port 8788 -x 24
```

### 三种 URL 形式

| 形式 | 示例 | 适用场景 |
|---|---|---|
| **编码形式** | `http://127.0.0.1:8788/d/<base64url 的目标 URL>` | 最稳妥，任意 URL 都能用 |
| **scheme 形式** | `http://127.0.0.1:8788/https/cdn.modrinth.com/data/x.jar` | 手工改写下载源 |
| **Host 头形式** | 请求 `/data/x.jar`，`Host: cdn.modrinth.com` | 配合 hosts 或代理设置 |

生成编码地址：

```bash
node -e "import('./src/proxy.js').then(m=>console.log(m.encodeTarget('https://cdn.modrinth.com/')))"
```

### 已验证的效果

本机实测（Modrinth CDN，191.7MB 单文件）：

| 项目 | 数据 |
|---|---|
| 代理下载耗时 | 9.4 秒（**20.4 MB/s**） |
| 首次字节延迟 | **1.6 秒**（边下边传，不触发 PCL 超时切换） |
| 小文件（<4MB） | 0.93MB 从 2.5s → **0.04s** |
| 缓存命中 | 300+ MB/s（本地读） |

### ⚠️ 这一步可能不生效

PCL CE / PCL2 的"下载源"设置项支持程度因版本而异，部分源类型不允许自定义。如果你改完发现没走代理，就改用下面的方案二。

---

## 四、方案二：独立安装（零风险，随时可用）

```bash
# 搜索整合包（中文可用）
node bin/mcboost.js search 红石

# 下载并安装到 PCL 认识的目录
node bin/mcboost.js pack rso -o ~/.minecraft/versions
```

装完后 PCL 的版本列表里直接出现该项，点启动即可。完全不碰 PCL 内部。

---

## 五、方案三：DLL 注入突破连接上限（已构建，实验性）

### 下载

GitHub Actions 自动构建，产物在 [Actions 页面](https://github.com/456123739/mcboost/actions) 的 Artifacts 里（`PclHook`）。
本仓库 `pcl-hook/dist/` 也保留了一份快照。

```
PclHookInjector.exe   注入器
PclHook.dll           补丁本体
0Harmony.dll          Harmony 运行时（必需，目标进程里没有）
```

### 用法

```bash
# 1. 先启动 PCL CE，等它完全加载完
# 2. 注入（连接数可改）
PclHookInjector.exe --process "Plain Craft Launcher 2" --connections 24
```

验证：看 `%APPDATA%\PCL\mcboost-hook.log`，出现「已提升单文件连接上限至 24（原为 8）」即成功。

### 实现原理

`ModNet.cs` 里：

```csharp
public const int NetTaskSingleFileConnectionLimitMax = 8;   // const → 编译期内联
public static int NetTaskSingleFileConnectionLimit { get; set; } = 8;
```

`Max` 是 `const`，读取处已被编译期内联成字面量 `8`，所以**单纯改属性值无效**。
`AdaptiveRangeDownloader.DownloadAsync` 里：

```csharp
var workerCount = Math.Min(segmentCount,
    Math.Clamp(ModNet.NetTaskSingleFileConnectionLimit, 1,
               ModNet.NetTaskSingleFileConnectionLimitMax));   // ← 内联成 ldc.i4.8
```

补丁用 Harmony 的 **Transpiler 精确改写这一处 IL**：以 `Math.Clamp` 调用为锚点向前回溯，只替换 `Clamp(x, 1, 8)` 中作为上界的那个常量 8。

**为什么不"把所有值为 8 的常量都换掉"** —— 那样会误伤同一方法里语义完全不同的常量（如 `DownloadSession` 的 `SlowCheckSeconds = 8`），破坏慢连接恢复逻辑。锚点回溯保证只动目标那一个。

其余逻辑（分段、慢连接恢复、进度上报、失败重试）**全部沿用 PCL CE 自己的实现**，行为最接近原版。

另外：
- DLL 一加载就自动执行补丁（`[ModuleInitializer]`），注入器不需要再往目标进程塞调用 stub
- 找不到目标类型时会重试 40 次（注入可能早于 PCL CE 程序集加载），仍失败则写日志而非静默
- 没匹配到 IL 模式时**不修改任何 IL**，保持原版行为，靠日志暴露问题

### 风险（必须清楚）

- PCL CE 每次更新都可能失效（IL 结构变化），届时会写「未找到连接数上限的 IL 模式」日志
- 崩溃风险高于方案一/二；**崩溃后重启 PCL CE 即可完全恢复**（纯内存补丁，不改文件）
- 注入器与 PCL CE 都必须 64 位

> 关于 PCL CE 的 `PCL.Core/IO/Download/` 下那层 `IDlConnection` / `IDlWriter` / `NDlFactory` 抽象接口：看起来像扩展点，但**仓库里没有任何类实现它们** —— 是预留设计，不是活的插件系统。所以不能靠"实现接口"接进去，必须注入。

---

## 六、加速代理的实现要点

`src/proxy.js` 里几处值得说明的设计：

**1. 为什么不能"下完再传"**
PCL 的单文件超时是 10~30 秒。一个 200MB 的文件如果先完整下载再回传，客户端会连续几十秒收不到字节，PCL 会判定卡死并切换下载源。所以代理是「后台多连接下载 + 按偏移顺序读回传」的管道。

**2. 乱序写入 vs 顺序读出**
分片下载是乱序写 `.part` 的（谁先连上谁先写），但 HTTP 响应必须按 0..N 顺序发。读取端轮询 `.part` 的已写长度，只读出连续的、确定已就绪的部分。

**3. `.part` 消失不等于下载失败**
下载完成时 `.part` 会被 rename 成最终文件。读取端必须区分「暂时没有新数据」和「已经改名收尾」—— 只看文件大小会把下载中途误判为已结束，导致回传中断。（这个 bug 在开发中真实踩到过。）

**4. 稀疏文件**
分片按偏移写入会产生稀疏文件：`stat()` 看到的 size 可能远大于实际已写入的字节。所以进度必须以下载引擎的字节计数器为准，不能看文件长度。

**5. 小文件不走分片管道**
分片管道的启动开销（探测 + 起后台下载 + 等 `.part` 出现）要几百毫秒，对 1MB 以下的文件是净亏。所以小于 4MB（与 PCL CE 的 `SmallFileThreshold` 一致）直接转发。
