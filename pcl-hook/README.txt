mcboost PCL CE 加速 v3.5
=======================

针对 PCL CE 2.15.x（你的版本：2.15.1 Beta 1）

作用：把「每个文件的下载分片数」从硬编码的 4 提升到 8（可调 4~32）。

  为什么是这里 —— PCL CE 2.15.1 源码 FileDownloader.cs：
    var perFileThreadLimit = Math.Max(1, ModNet.NetTaskThreadLimit);
    var chunkCount = Math.Min(perFileThreadLimit, 4);   ← 每文件最多 4 个分片
    new DownloadConfiguration {
        ChunkCount = chunkCount,
        ParallelCount = chunkCount,
        ...
    }

  也就是说不管 NetTaskThreadLimit 调到多少，Math.Min 都会把它压回 4。
  每个文件只有 4 条连接 —— 这才是下载慢的真正原因。

不修改下载源、不注入进程、不修改 PCL CE 任何文件。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用法
  1. 完全退出 PCL CE
  2. 运行 McBoostLauncher.exe
  3. 调「每文件分片数」（默认 8）
  4. 点「启动 PCL CE（已加速）」

  以后每次都用 McBoostLauncher.exe 启动。

找不到 PCL CE
  点「浏览…」手动选 MultiMc.exe，选一次就记住。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

文件（必须在同一目录）
  McBoostLauncher.exe
  McBoostLauncher.dll
  McBoostLauncher.runtimeconfig.json  ← 缺它打不开
  McBoostLauncher.deps.json
  PclHook.dll                         补丁本体
  0Harmony.dll                        Harmony 运行时（必需）
  README.txt

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

原理
  用 .NET 官方机制 DOTNET_STARTUP_HOOKS：设置该环境变量后，
  运行时会在 PCL CE 的 Main() 之前加载 PclHook.dll 并执行
  StartupHook.Initialize()。

  补丁用 Harmony Transpiler 改写 FileDownloader.DownloadSingleAsync
  里的一个常量：把 Math.Min(?, 4) 的 4 换成目标分片数。
  分块、断点续传、进度、重试全部沿用 PCL 自己的实现。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

验证
  日志: %APPDATA%\PCL\mcboost-hook.log

  成功会看到：
    patcher start (v3.5, 目标每文件 8 分片)
    NetTaskThreadLimit: 16 -> 64
    transpiler: 已替换 1 处 Math.Min(?, 4) -> 8
    DONE: 已 patch FileDownloader.DownloadSingleAsync，分片上限 4 -> 8

  启动器会自动读日志并显示结果。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

排错
  没有日志        → 钩子没加载，确认启动的是 MultiMc.exe
  找不到 FileDownloader → 版本不同，把日志发到 issue
  未匹配到 Math.Min(?, 4) → IL 结构变化，把日志发到 issue
  速度没变化      → 可能被 CDN 限流，把分片数调到 6 或 4 再试
  速度反而变慢    → 同上，调低分片数

还原
  直接双击原版 PCL CE 即可（不带环境变量就是原版行为）。
