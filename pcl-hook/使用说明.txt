mcboost PCL CE 加速 v3.0
=======================

作用：把 PCL CE 的单文件下载连接上限从 8 提升到 24（可调）。
      实测同文件同时刻：8 连接 = 2.7 MB/s，24 连接 = 18.3 MB/s，约 6.8 倍。

不修改下载源、不注入进程、不修改 PCL CE 任何文件。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用法（只有三步）
  1. 完全退出 PCL CE
  2. 运行 McBoostLauncher.exe
  3. 点「启动 PCL CE（已加速）」

  等 PCL CE 主界面出来后，程序会自动检查并显示
  「✓ 加速已生效」或「✗ 未检测到钩子」。

  以后每次都用 McBoostLauncher.exe 启动 PCL CE 即可。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

文件
  McBoostLauncher.exe    启动器（带 GUI）
  PclHook.dll            补丁本体（.NET 启动钩子）
  0Harmony.dll           Harmony 运行时（必需）
  使用说明.txt

这 4 个文件**必须在同一目录**。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

原理
  .NET 有一个官方机制 DOTNET_STARTUP_HOOKS：
  设置这个环境变量后，运行时会自动加载指定 DLL，
  并在目标程序 Main() 之前执行 StartupHook.Initialize()。

  启动器做的就是：
    设置 DOTNET_STARTUP_HOOKS = PclHook.dll 的路径
    然后启动 PCL CE

  所以不需要注入、不需要管理员权限、不会有架构不匹配问题。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

验证
  日志: %APPDATA%\PCL\mcboost-hook.log
  备用: %TEMP%\mcboost-hook.log

  成功会看到：
    startup hook v3.0.0 loaded, pid=xxxx
    found type: PCL.Network.Downloader.AdaptiveRangeDownloader
    OK: patch 已应用到 Async(MoveNext)
    transpiler: 替换 1 处 Clamp 上界 -> 24
    DONE: PCL CE 单文件连接上限已改为 24（原为 8）

  失败时日志也会明确写出卡在哪一步。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

排错
  日志完全没有 / 只有「日志还不存在」
      → 钩子没被加载。PCL CE 可能不是框架依赖的 .NET 应用。
        把 %APPDATA%\PCL\mcboost-hook.log 和 PCL CE 版本号发到 issue。

  「waiting for AdaptiveRangeDownloader...」然后 FAIL
      → 目标类型名变了。日志里有已加载程序集列表，请附上。

  「transpiler: 未匹配到 Clamp(x,1,8) 模式」
      → PCL CE 改了下载器实现。此时不修改任何 IL，保持原版行为。

  「找不到 PCL CE 主程序」
      → 把 McBoostLauncher.exe 放到 PCL CE 目录下，或手动用
        环境变量方式启动（见下）。

  手动启动方式（备用）
      在 CMD 里执行：
        set DOTNET_STARTUP_HOOKS=<本目录>\PclHook.dll
        set MCBOOST_PCL_CONNECTIONS=24
        <PCL CE 路径>\MultiMc.exe

还原
  直接双击原版 PCL CE 启动即可（不含环境变量就是原版行为）。
  不需要卸载、不需要改任何文件。
