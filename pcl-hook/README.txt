mcboost PCL CE 加速 v3.1
=======================

作用：把 PCL CE 的单文件下载连接上限从 8 提升到 24（可调）。
      实测同文件同时刻：8 连接 = 2.7 MB/s，24 连接 = 18.3 MB/s，约 6.8 倍。

不修改下载源、不注入进程、不修改 PCL CE 任何文件。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用法
  1. 完全退出 PCL CE
  2. 运行 McBoostLauncher.exe
  3. 点「启动 PCL CE（已加速）」

  以后每次都用 McBoostLauncher.exe 启动 PCL CE。

找不到 PCL CE 怎么办
  程序会自动在下面这些地方找 MultiMc.exe：
    · 上次手动选择的路径（会记住）
    · 正在运行的 PCL CE 进程
    · 本程序所在目录
    · 桌面 / 下载 / 各硬盘根目录
  都找不到时 —— 点「浏览…」手动选 MultiMc.exe 即可，选一次就记住了。

  PCL CE 主程序文件名通常是 MultiMc.exe。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

文件（必须在同一目录）
  McBoostLauncher.exe             启动器
  McBoostLauncher.dll             启动器代码
  McBoostLauncher.runtimeconfig.json   .NET 运行时配置（缺它打不开）
  McBoostLauncher.deps.json       依赖描述
  PclHook.dll                     补丁本体（.NET 启动钩子）
  0Harmony.dll                    Harmony 运行时（必需）
  README.txt                      本文件

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

原理
  .NET 有官方机制 DOTNET_STARTUP_HOOKS：
  设置该环境变量后，运行时会在目标程序 Main() 之前
  自动加载指定 DLL 并执行 StartupHook.Initialize()。

  启动器做的就是把该变量设为 PclHook.dll 的路径，
  然后启动 PCL CE。

  所以不需要注入、不需要管理员权限、不会有架构不匹配问题。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

验证
  日志: %APPDATA%\PCL\mcboost-hook.log
  备用: %TEMP%\mcboost-hook.log

  成功会看到：
    startup hook v3.0.0 loaded, pid=xxxx
    found type: PCL.Network.Downloader.AdaptiveRangeDownloader
    OK: patch 已应用到 MoveNext(状态机)
    transpiler: 替换 1 处 Clamp 上界 -> 24
    DONE: PCL CE 单文件连接上限已改为 24（原为 8）

  启动器会自动读取日志并显示结果，不用自己翻文件。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

排错
  完全没有日志
      → 钩子没被加载。确认启动的确实是 MultiMc.exe；
        若 PCL CE 是自包含部署（非框架依赖），启动钩子不生效。

  waiting for AdaptiveRangeDownloader... 然后 FAIL
      → 目标类型名变了。日志含已加载程序集列表，请附上。

  transpiler: 未匹配到 Clamp(x,1,8) 模式
      → PCL CE 改了下载器实现。此时不修改任何 IL，保持原版行为。

  启动失败 / 需要管理员
      → 右键 McBoostLauncher.exe「以管理员身份运行」。

还原
  直接双击原版 PCL CE 启动即可（不带环境变量就是原版行为）。
  不需要卸载、不改任何文件、不需要清理。
