mcboost PCL CE 加速 v3.4
=======================

作用：把 PCL CE 的**全局下载连接上限**从默认 16 提升到 64。

  老版 PCL2 / PCL CE 的下载引擎里：
    PCL.Network.ModNet.NetTaskThreadLimit = 16   ← 所有文件共享这一个上限
  整合包一次下 100 多个文件时，全部挤在这 16 条连接里。
  补丁把这个上限抬到 64（可调 8~256）。

不修改下载源、不注入进程、不修改 PCL CE 任何文件。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用法
  1. 完全退出 PCL CE
  2. 运行 McBoostLauncher.exe
  3. 调整「全局下载连接数」（默认 64）
  4. 点「启动 PCL CE（已加速）」

  以后每次都用 McBoostLauncher.exe 启动。

找不到 PCL CE 怎么办
  点「浏览…」手动选 MultiMc.exe，选一次就记住了。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

文件（必须在同一目录）
  McBoostLauncher.exe                 启动器
  McBoostLauncher.dll
  McBoostLauncher.runtimeconfig.json  ← 缺它打不开
  McBoostLauncher.deps.json
  PclHook.dll                         补丁本体（.NET 启动钩子）
  0Harmony.dll                        Harmony 运行时（必需）
  README.txt

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

原理
  用 .NET 官方机制 DOTNET_STARTUP_HOOKS：
  设置该环境变量后，运行时会在 PCL CE 的 Main() 之前
  自动加载 PclHook.dll 并执行 StartupHook.Initialize()。

  补丁用 Harmony 给 ModNet.get_NetTaskThreadLimit() 挂 Postfix，
  让返回值不小于目标值。不改 IL、不依赖属性可写性。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

验证
  日志: %APPDATA%\PCL\mcboost-hook.log
  备用: %TEMP%\mcboost-hook.log

  成功会看到：
    patcher start (v3.4, 老引擎模式), target threads = 64
    原始 NetTaskThreadLimit = 16
    DONE: NetTaskThreadLimit 已从 16 提升到 64
    现在 PCL 的全局下载连接上限已提高，重新开始下载整合包即可生效。

  启动器也会自动读取日志并显示结果，不用自己翻文件。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

排错
  完全没有日志
      → 钩子没被加载，确认启动的是 MultiMc.exe。

  FAIL: 找不到 PCL.Network.ModNet
      → PCL CE 版本不同，请把日志里的诊断信息发到 issue。

  WARN: patch 后读取仍为 xx
      → 属性可能缓存了值，重启 PCL CE 后再试。

  速度没变化 / 反而变慢
      → 可能是 CDN 限流。把连接数调低（例如 32）再试。

还原
  直接双击原版 PCL CE 启动即可（不带环境变量就是原版行为）。
  不需要卸载、不改任何文件。
