mcboost PCL CE 加速 v3.7
=======================

针对 PCL CE 2.15.x（你的版本：2.15.1 Beta 1）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
先说清楚这一版修的是什么
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

v3.5 / v3.6 会提示"已 patch 成功"，但**实际一处都没改到**。两个原因：

1. FileDownloader.DownloadSingleAsync 是 async 方法，
   方法体全在编译器生成的状态机 MoveNext() 里。
   之前 patch 的是外层那个壳，transpiler 根本看不到 Math.Min(?, 4)。

2. Harmony 的 transpiler 是 JIT 时才执行的。
   harmony.Patch() 返回成功只代表"登记成功"，不代表常量被替换。
   我之前据此就打 DONE —— 所以"提示成功"是假的。

v3.7 的修正：
  · 用 AsyncStateMachineAttribute 定位到 MoveNext() 再 patch
  · patch 后强制 PrepareMethod 触发 JIT，再检查 transpiler 实际替换了几处
  · 只有替换数 > 0 才输出 DONE，否则明确输出 FAIL

所以这次的日志是可信的：DONE 就真的改了，FAIL 就真的没改。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

作用
  把「每个文件的下载分片数」从硬编码的 4 提升到 8（可调 4~32）。

  PCL CE 2.15.1 源码 FileDownloader.cs：
    var perFileThreadLimit = Math.Max(1, ModNet.NetTaskThreadLimit);
    var chunkCount = Math.Min(perFileThreadLimit, 4);   ← 每文件最多 4 个分片
    new DownloadConfiguration { ChunkCount = chunkCount, ParallelCount = chunkCount, ... };

不修改下载源、不注入进程、不修改 PCL CE 任何文件。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用法
  1. 完全退出 PCL CE
  2. 运行 McBoostLauncher.exe
  3. 调「每文件分片数」（默认 8）
  4. 点「启动 PCL CE（已加速）」
  5. 正常去下载整合包，对比速度

找不到 PCL CE → 点「浏览…」手动选 MultiMc.exe，选一次就记住。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

日志位置
  %APPDATA%\PCL\mcboost-hook.log

成功时会看到（关键三行）：
    Harmony 程序集: 2.4.3.0 @ ...\net10.0\0Harmony.dll
    补丁目标: PCL.Network.FileDownloader+<DownloadSingleAsync>d__5.MoveNext()（async 状态机）
    transpiler: 已替换 1 处 Math.Min(?, 4) -> 8
    DONE: 已替换 1 处 Math.Min(?, 4) -> 8

失败时会看到：
    transpiler: 未找到 Math.Min(?, 4)
    FAIL: transpiler 执行了但替换 0 处 —— 该方法里没有 Math.Min(?, 4)
    这意味着本次补丁**没有生效**，下载速度不会变化。
    （后面还有 IL 长度、ldc.i4.4 出现次数、状态机字段列表）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

如果显示 DONE 但速度仍然没变
  那就不是分片数的问题了，可能是：
    · 带宽本身已经跑满
    · CDN 对单 IP 限流（把分片数调到 4 对比，若变快说明是限流）
    · 小于 1MB 的文件完全不分片（PCL 的 MinimumSizeOfChunking = 1MB），
      整合包里大量小 mod 吃不到多线程
  请把日志发我，我按实际情况改。

还原
  直接双击原版 PCL CE 即可（不带环境变量就是原版行为）。
