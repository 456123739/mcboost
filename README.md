# mcboost — 我的世界整合包下载加速器

专治「整合包下得特别慢」。多连接分片、并发文件队列、镜像自动测速选源、断点续传、失败换源，全部零依赖（纯 Node.js 标准库，`npm install` 都不需要）。

**给 PCL2 / PCL CE 用户**：见 [docs/PCL集成指南.md](docs/PCL集成指南.md) —— 可以让 PCL 的整合包下载走本地加速代理。

```bash
# 搜索整合包
node bin/mcboost.js search 红石

# 下载安装（本地文件 / URL / Modrinth 项目名都行）
node bin/mcboost.js pack rso -o ~/mc

# 给 PCL 用的本地加速代理
node bin/mcboost.js proxy --port 8788

# 网页版
node bin/mcboost.js web
```

---

## 它到底快在哪

加速来自三件互不重叠的事。

### 1. 单文件多连接分片（对境外 CDN 效果最大）

单条 TCP 连接跑不满带宽是常态 —— 丢包、RTT、服务端限速都会卡住单连接。切成 N 段并发拉取可以成倍提速。**本机实测 Mojang 官方源下载 23MB 客户端 jar**：

| 连接数 | 吞吐 | 耗时（12MB） |
|---|---|---|
| 1 连接 | 308 KB/s | 39.9s |
| 4 连接 | 2.9 MB/s | 4.2s |
| 8 连接 | 3.2 MB/s | 3.7s |
| **16 连接** | **4.0 MB/s** | **3.0s** |

**提速 13.4 倍。** 复现：`node bin/mcboost.js bench <URL>`

#### 关键细节：必须用「小分片 + 动态队列」，不能静态分段

这不是理论，是实测踩出来的。最初给每条连接静态分配一大段（200MB 文件切 8 段、每段 24MB），结果抓到的每段字节分布是：

```
[0/0/0/0/0/24/0/0]   ← 只有 1 条连接拿到带宽，其余 7 条被 CDN 饿死
```

CDN 会饿死大部分并发连接。静态分段下，被饿死那条连接负责的 24MB **永远下不完**，拿到带宽的连接干完自己的活也只能闲着 —— 整个下载被拖死。同一文件、同样 8 连接，**aria2c 能跑 21 MB/s，静态分段只有 7.7 MB/s**。

改成小分片（默认 2MB）+ 共享待办队列后，被饿死的连接由看门狗判定停滞、把分片退回队列、转去领下一片；健康的连接干完一片立刻领下一片。**同一测试内置引擎从 7.7 MB/s 提升到 33.8 MB/s（4.4 倍）**，单轮甚至 4.4 秒拉完整个 191.7MB 文件。

看门狗必须**在发起请求前就装上**：有些被饿死的连接是"连接建立了但永远不返回响应头"，只在收数据阶段看守门狗的话，这种情况要等满整个 timeout 才放弃。

### 2. 并发文件队列（大文件优先 + 连接让渡）

整合包不是一个大文件，是几百个小文件。单线程逐个下会反复吃满"建立连接 → 慢启动 → 传输 → 关闭"的固定开销。

但"同时并发 N 个文件"也不够 —— 实测整包 675MB 用 32 文件 × 16 连接，总耗时 19 秒，而逐个文件单独测：

```
rotrBLOCKS 185.9MB  单独下 4.6 秒，整包里却花了 17.4 秒（慢 3.8 倍）
ViaFabricPlus 9.9MB 单独下 0.7 秒，整包里却花了 12.4 秒（慢 17 倍）
```

原因是**小文件先下完就退出，却不会把连接数让出来**：大文件一直只能拿固定的连接去和 125 个小文件抢带宽。所以队列做三件事：**大文件优先启动**（墙钟由最慢的文件决定）、**连接数按大小加权**、**空闲额度让渡**给仍在下载的大文件。

**实测**：Modrinth 整合包《红石生电优化》126 文件 / 675 MB，从 19 秒降到 **15 秒（45.6 MB/s）**。

### 3. 镜像自动测速选源

内置国内镜像规则（BMCLAPI 等），但**不假设镜像一定更快** —— 每个「源组合」实测一次真实吞吐，谁快用谁：

```bash
node bin/mcboost.js sources "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
```

实测中确实观察到过 BMCLAPI 在某条路径上**比官方慢 20 倍且会返回 429 限流**的情况。所以策略是：镜像只是**候选**，选源永远靠实测。这带来一个重要性质 —— **镜像规则写错了也不会导致下载失败**，因为官方源始终在候选列表里，测速和失败回退都会兜住。

---

## 支持哪些整合包

| 格式 | 支持情况 | 说明 |
|---|---|---|
| **Modrinth `.mrpack`** | ✅ 完整支持 | 包内 `modrinth.index.json` 自带每个文件的直链+哈希，**无需任何 API key**，还能校验 SHA1/SHA512 |
| **CurseForge 整合包 zip** | ✅ 支持 | 见下方说明 |
| `mcboost modrinth <项目名>` | ✅ | 自动查最新版、下载、解析、装好 |
| 任意文件 URL | ✅ `mcboost get <URL>` | 多连接分片 + 镜像 |

### CurseForge 是怎么解决的

CurseForge 整合包里的 `manifest.json` **只有 `(projectID, fileID)`，没有文件名，也没有直链**。而官方 API `api.curseforge.com` 无 key 直接返回 403（Cloudflare 也会拦截网页端接口）。

本项目的做法是两级策略：

1. **没配 key（默认）** —— 通过公开接口拿到文件名和大小，再用 CurseForge CDN 的**确定性路径规则**拼出直链：
   ```
   https://mediafilez.forgecdn.net/files/{⌊fileID/1000⌋}/{fileID%1000}/{文件名}
   ```
   这条规则实测验证过（返回 206 + 正确的 ZIP 魔数 `504b0304`）。局限：公开接口只收录较新的文件版本，**很老的整合包可能解析不到**。

2. **配了 key** —— 走官方 API，能解析全部文件：
   ```bash
   node bin/mcboost.js config set curseforgeApiKey <你的key>
   ```
   免费申请：https://console.curseforge.com/

解析不到的文件不会被静默忽略，而是汇总写入 `<实例目录>/待手动下载.txt`，附上 CurseForge 页面链接。

---

## 安装

需要 **Node.js ≥ 18**（推荐 20+）。没有任何 npm 依赖。

```bash
cd mcboost
node bin/mcboost.js doctor     # 检查环境 + 网络连通性
npm link                        # 可选：把 mcboost 装成全局命令
```

想更稳可以装 aria2c（可选，装了会自动优先使用它的下载内核）：

```bash
sudo apt install aria2     # Debian/Ubuntu
brew install aria2         # macOS
```

没有 aria2c 也完全可用 —— 内置引擎是完整实现，实测吞吐与 aria2c 同一量级。

---

## 常用命令

```bash
# 下载整合包（本地文件 / URL / Modrinth 项目名都行）
mcboost pack fabulously-optimized -o ~/mc
mcboost pack ~/Downloads/Pack.zip --dry-run        # 只看计划不下载
mcboost pack rso --include "^mods/"                 # 只下 mods 目录
mcboost pack rso --side server                      # 装服务端

# 搜索整合包
mcboost search 红石 --limit 20

# 加速下载任意文件
mcboost get https://example.com/big.zip -o ~/dl

# 诊断：为什么慢？该走哪条源？
mcboost bench <URL>            # 实测单连接 vs 多连接的提速倍率
mcboost sources <URL>          # 列出所有候选源并实测各自吞吐
mcboost mirrors test           # 实测所有镜像规则是否可用
mcboost doctor                 # 环境 + 网络连通性体检

# 看看整合包里有什么（不下载）
mcboost info rso

# 网页版 / 加速代理
mcboost web --port 8787
mcboost proxy --port 8788      # 给 PCL2 / PCL CE 用，见 docs/PCL集成指南.md
```

### 常用参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `-o, --out <目录>` | 输出目录 | 当前目录 |
| `-j, --concurrency <N>` | 同时下载几个文件 | 6 |
| `-x, --connections <N>` | 单个文件几个连接 | 8 |
| `-e, --engine <引擎>` | `auto` / `aria2` / `builtin` | auto |
| `--side <端>` | `client` / `server` | client |
| `--include <正则>` | 只下匹配的文件 | — |
| `--no-mirror` | 不用镜像，直连官方 | — |
| `--dry-run` | 只显示计划 | — |

---

## 给 PCL CE / PCL2 加速

完整说明见 **[docs/PCL集成指南.md](docs/PCL集成指南.md)**。

PCL CE（`PCL-Community/PCL-CE`）是 **C# / .NET 10**，与官方 PCL2（VB.NET / .NET Framework 4.8）是两套不同代码库，瓶颈也不同：

- **PCL CE**：单文件连接数被硬编码为 8（`ModNet.cs` 的 `const int NetTaskSingleFileConnectionLimitMax = 8`）。实测同一文件下这是 **2.7 MB/s**，而 16~24 连接能到 **14~18 MB/s** —— **差约 6.8 倍**。改设置解决不了，`const` 不可配。
- **官方 PCL2**：有分片能力，但有一份域名黑名单（URL 含 `bmclapi`、`github.com` 等时强制单线程）—— **在 PCL2 里配国内镜像反而会让模组全部退化成单连接**。

mcboost 的做法是起一个本地加速代理，PCL 把下载源指向它。分片全部发生在代理内部，对 PCL 而言只是一次普通 GET，上述限制都不起作用。实测 191.7MB 单文件 **9.4 秒（20.4 MB/s）**，且 1.6 秒就开始向客户端送字节（不会触发 PCL 的超时切换）。

---

## 可靠性设计

- **断点续传** —— 分片级记录已完成字节数（`<文件>.part` + `<文件>.mcboost` 状态文件），中断后重跑只补缺失部分，不重头下。
- **失败换源** —— 一个源失败自动试下一个，全部失败才判失败并写入待手动下载清单。
- **智能回退** —— 服务器不支持 Range 时自动退化为单连接；探测失败也会退化为单连接而不是直接报错。
- **限流退避** —— 429/5xx 按 `Retry-After` 指数退避重试（带抖动，避免并发重试打爆）。
- **哈希校验** —— `.mrpack` 自带 SHA1/SHA512 时会校验；校验失败自动删除坏文件并换源重下。
- **安全解压** —— 防路径穿越（`../../etc/passwd` 这类条目会被拒绝）。
- **稀疏文件安全** —— 完整性以字节计数器为准，不看文件长度（分片按偏移写会产生稀疏文件，`stat` 看到的 size 可能远大于实际已写字节）。

---

## 架构

```
bin/mcboost.js          CLI 入口（命令分发、参数解析）
src/
  pipeline.js           主流程编排：识别 → 解析 → 下载 → 释放 overrides → 汇总
  mirrors.js            镜像规则、候选源生成、配置、镜像实测
  progress.js           终端进度条（TTY 多行实时 / 非 TTY 降级）
  proxy.js              本地加速代理（供 PCL2 / PCL CE 使用）
  util.js               工具函数
  net/http.js           HTTP 封装：重定向、超时、退避重试、Range 探测
  engine/
    segment.js          多连接分片下载引擎（小分片 + 动态队列 + 停滞看门狗）
    aria.js             aria2c 后端适配（含进度行解析）
    probe.js            按时间盒测速 + SourceRanker 选源缓存
    download.js         任务级：选源 → 下载 → 校验 → 换源重试
    queue.js            大文件优先 + 连接数加权 + 让渡的并发队列
    verify.js           SHA1/SHA512 校验
  packs/
    zip.js              零依赖 ZIP 读取/解压（含 ZIP64）
    modrinth.js         .mrpack 解析、任务构建、overrides 释放
    curseforge.js       manifest 解析 + 两级文件地址解析
    search.js           整合包搜索（Modrinth 官方 API + CurseForge 公开接口）
  ui/
    server.js           网页版 HTTP 服务 + SSE
    index.html          单页界面
test/                   44 个测试
docs/PCL集成指南.md      PCL2 / PCL CE 集成说明
```

### 四个值得一提的实现细节

**分片调度必须动态**：见上文「小分片 + 动态队列」。静态分段在真实 CDN 上会被"饿死连接"拖死，这是本项目性能提升最大的一处修改（4.4×）。

**进度不能靠轮询文件大小**：aria2 和分片引擎都用稀疏文件写盘，落盘 size 会在第一秒就跳到接近文件总长（实测 191MB 的文件，实际只传了 28MB 时 `stat` 已经是 168MB）。所以进度必须来自**字节计数器**（内置引擎）或 **aria2 自己输出的进度行**（aria2 后端），否则进度条会瞬间假死到 100%。

**测速必须按时间而不是按字节**：最初用固定 256KB 探测，结果测出来全是 TCP 慢启动和握手延迟 —— 同一条源，256KB 探针得出 0.16 MB/s，连续下载 12MB 时是 3.9 MB/s，**差 24 倍**，选源完全失准。现在每条流至少跑 2 秒（`probeMinMs`），并且对大文件直接用多流探测。

**ZIP 读取器**：Node 没有内置 zip 支持，而整合包都是 zip 容器。`src/packs/zip.js` 直接解析中央目录 + `zlib.inflateRawSync`，支持 stored/deflate 和 ZIP64 基本情形，中文文件名也正常。所以只读一个 `manifest.json` 时不需要解压整个包。

---

## 测试

```bash
npm test        # 44 个测试
```

包含用本地 HTTP 服务器构造的确定性场景：分片覆盖无缝性、不支持 Range 的回退、**中断后续传的正确性**（验证偏移没错位）、**连接被饿死时由其它连接接手完成**、稀疏文件不能骗过完整性校验、5xx 重试、429 退避、选源缓存、哈希失败删文件、主源 404 时换源、代理 URL 编解码与黑名单识别。

---

## 已知限制

- CurseForge 老整合包在**没有 API key** 时可能解析不全 —— 配一个免费 key 即可解决，或用 `待手动下载.txt` 手动补齐。
- Fabric maven（`maven.fabricmc.net`）目前没有可用的国内镜像，Fabric 模组只能走官方源。
- 给 PCL 用的加速代理需要 PCL 支持自定义下载源；部分版本的 PCL 对某些源类型不支持自定义，此时请用"独立安装"方式（`mcboost pack ... -o ~/.minecraft/versions`）。
- **DLL 注入替换 PCL CE 下载器的方案尚未实现** —— PCL CE 没有公开插件 API（`PCL.Core/IO/Download/` 下虽有一层 `IDlConnection`/`NDlFactory` 抽象，但仓库里没有任何类实现它，是预留设计而非活的扩展点）。建议先用代理方案验证加速效果。

## License

MIT
