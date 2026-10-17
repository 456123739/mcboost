using System.IO;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using HarmonyLib;

namespace McBoost.PclHook;

/// <summary>
/// 模块初始化：DLL 被 LoadLibrary 加载后、任何代码访问前自动执行。
/// 这样注入器不需要再往目标进程里塞调用 stub —— DLL 一加载就完成补丁。
/// </summary>
internal static class ModuleInit
{
    [ModuleInitializer]
    internal static void Initialize()
    {
        try
        {
            Entry.AutoApply();
        }
        catch (Exception ex)
        {
            McBoostLog.Warn($"自动应用补丁失败: {ex.Message}");
        }
    }
}

/// <summary>
/// mcboost 针对 PCL CE 的连接数上限破解。
///
/// 背景（读 PCL-Community/PCL-CE 源码确认）：
/// <code>
/// // ModNet.cs
/// public const int NetTaskSingleFileConnectionLimitMax = 8;    // const → 编译期内联
/// public static int NetTaskSingleFileConnectionLimit { get; set; } = 8;
///
/// // AdaptiveRangeDownloader.DownloadAsync
/// var workerCount = Math.Min(segmentCount,
///     Math.Clamp(ModNet.NetTaskSingleFileConnectionLimit, 1,
///                ModNet.NetTaskSingleFileConnectionLimitMax));   // ← 内联成 ldc.i4.8
/// </code>
///
/// 因为 Max 是 const，读取处已被编译期内联为字面量 8，所以单纯改属性值无效，
/// Clamp 的上界永远是 8 —— 这就是 PCL CE 单文件最多 8 连接的硬顶。
///
/// 实测代价（同文件、同时刻、同网络）：
///   8 连接 = 2.7 MB/s，16 连接 = 14.3 MB/s，24 连接 = 18.3 MB/s，差距约 6.8 倍。
///
/// 做法：用 Harmony 的 Transpiler 精确改写 <c>DownloadAsync</c> 的 IL，
/// 只把 <c>Math.Clamp(prop, 1, 8)</c> 中作为上界传入的那个常量 8 改成目标值。
/// 其余 IL 一律不动 —— 包括同一方法里的 <c>bufferSize: 1</c>、
/// 以及 DownloadSession 内部的 <c>SlowCheckSeconds = 8</c> 等语义完全不同的常量。
/// </summary>
public static class Entry
{
    /// <summary>默认目标单文件连接数。</summary>
    public const int DefaultSingleFileConnections = 24;

    private static Harmony? _harmony;
    private static int _singleFileConnections = DefaultSingleFileConnections;
    private static bool _applied;

    /// <summary>是否已 patch 成功。</summary>
    public static bool IsApplied => _applied;

    /// <summary>当前生效的单文件连接数。</summary>
    public static int SingleFileConnections => _singleFileConnections;

    /// <summary>
    /// 供 <see cref="ModuleInit"/> 调用：自动应用补丁。
    ///
    /// 注入时机可能早于 PCL CE 的程序集加载，所以这里做有限重试，
    /// 每隔一段时间再试一次，直到找到目标类型。
    /// </summary>
    internal static void AutoApply()
    {
        var connections = ReadConnectionsFromEnvironment();

        for (var attempt = 0; attempt < 40 && !_applied; attempt++)
        {
            try
            {
                Apply(connections);
                return;
            }
            catch (InvalidOperationException)
            {
                // 目标类型还没加载，等一会儿再试
                Thread.Sleep(500);
            }
            catch (Exception ex)
            {
                McBoostLog.Warn($"应用补丁出错: {ex.Message}");
                return;
            }
        }

        if (!_applied)
            McBoostLog.Warn("重试 40 次后仍未找到 PCL CE 的下载类型，补丁未生效");
    }

    /// <summary>
    /// 从环境变量读取目标连接数，方便不重新编译就能调整。
    /// </summary>
    private static int? ReadConnectionsFromEnvironment()
    {
        var raw = Environment.GetEnvironmentVariable("MCBOOST_PCL_CONNECTIONS");
        return int.TryParse(raw, out var v) && v > 0 ? v : null;
    }

    /// <summary>
    /// 应用补丁。重复调用安全。
    /// </summary>
    /// <param name="singleFileConnections">单文件连接数目标值，默认 24</param>
    public static void Apply(int? singleFileConnections = null)
    {
        if (_applied) return;

        if (singleFileConnections is > 0)
            _singleFileConnections = singleFileConnections.Value;
        TranspilerHolder.SingleFileConnections = _singleFileConnections;

        _harmony = new Harmony("com.mcboost.pclhook");

        var downloaderType = FindType("PCL.Network.Downloader.AdaptiveRangeDownloader")
                             ?? FindType("AdaptiveRangeDownloader");
        if (downloaderType is null)
            throw new InvalidOperationException(
                "找不到 AdaptiveRangeDownloader —— PCL CE 版本可能不兼容，请反馈版本号");

        var downloadAsync = downloaderType.GetMethod("DownloadAsync",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (downloadAsync is null)
            throw new InvalidOperationException(
                "找不到 AdaptiveRangeDownloader.DownloadAsync —— PCL CE 版本可能不兼容");

        // 顺带把属性值抬高，这样即使某条路径没走到被 patch 的内联常量，
        // Clamp 的输入也是高值，行为依然更激进（不会更慢）。
        var modNetType = FindType("PCL.Network.ModNet");
        var prop = modNetType?.GetProperty("NetTaskSingleFileConnectionLimit",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        if (prop?.CanWrite == true)
        {
            try { prop.SetValue(null, _singleFileConnections); }
            catch { /* 版本不兼容时忽略，IL 补丁仍会生效 */ }
        }

        var transpiler = new HarmonyMethod(
            typeof(TranspilerHolder).GetMethod(
                nameof(TranspilerHolder.Transpile),
                BindingFlags.Public | BindingFlags.Static)!);

        _harmony.Patch(downloadAsync, transpiler: transpiler);
        _applied = true;
    }

    /// <summary>
    /// 撤销全部补丁，恢复 PCL CE 原版行为。
    /// </summary>
    public static void Revert()
    {
        if (!_applied || _harmony is null) return;
        _harmony.UnpatchAll(_harmony.Id);
        _applied = false;
    }

    /// <summary>
    /// 在运行时改变目标连接数。修改后需要重新 Apply 才能生效
    /// （因为目标值已被写进 IL）。
    /// </summary>
    public static void SetSingleFileConnections(int value)
    {
        if (value <= 0) throw new ArgumentOutOfRangeException(nameof(value));
        _singleFileConnections = value;
        TranspilerHolder.SingleFileConnections = value;
    }

    /// <summary>
    /// 在已加载的程序集中查找类型。PCL CE 主程序集名随构建变化，
    /// 所以逐个程序集查，并在精确全名匹配失败时退化为按短名匹配。
    /// </summary>
    private static Type? FindType(string fullName)
    {
        var direct = Type.GetType(fullName);
        if (direct is not null) return direct;

        var shortName = fullName.Split('.').Last();

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type[] types;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException) { continue; }

            var exact = types.FirstOrDefault(t => t.FullName == fullName);
            if (exact is not null) return exact;

            var byShort = types.FirstOrDefault(t => t.Name == shortName);
            if (byShort is not null) return byShort;
        }
        return null;
    }
}

/// <summary>
/// Harmony transpiler 宿主。Harmony 通过反射调用，所以类型和方法必须 public。
/// </summary>
public static class TranspilerHolder
{
    /// <summary>目标单文件连接数，会被写进 IL 替换原来的 8。</summary>
    public static int SingleFileConnections = Entry.DefaultSingleFileConnections;

    /// <summary>
    /// 精确替换 <c>Math.Clamp(ModNet.NetTaskSingleFileConnectionLimit, 1, 8)</c>
    /// 中作为上界的常量 8。
    ///
    /// 匹配策略：**以 Clamp 调用为锚点向前回溯**，而不是"把所有值为 8 的常量都换掉"。
    /// 预期 IL 形态：
    /// <code>
    ///   call/getstatic  ModNet.get_NetTaskSingleFileConnectionLimit   ← 参数1
    ///   ldc.i4.1                                                      ← 参数2（下界）
    ///   ldc.i4.8                                                      ← 参数3（上界，要改的就是它）
    ///   call          Math.Clamp
    /// </code>
    ///
    /// 这样做的好处：
    ///  - 同一方法里其它语义完全不同的常量 8（例如 DownloadSession 里的
    ///    <c>SlowCheckSeconds = 8</c>、以及任何 <c>bufferSize: 8</c>）不会被动到；
    ///  - 即使编译器在不同版本下生成了略有差异的指令前缀，只要 Clamp 的三个参数
    ///    顺序不变就能正确匹配。
    /// </summary>
    public static IEnumerable<CodeInstruction> Transpile(IEnumerable<CodeInstruction> instructions)
    {
        var list = instructions.ToList();
        var replaced = 0;

        for (int i = 0; i < list.Count; i++)
        {
            if (!IsClampCall(list[i])) continue;

            // 向前回溯三个参数（参数是逆序入栈的，所以越靠前越是最后一个参数）
            if (i < 3) continue;

            var third = list[i - 1];   // Clamp 的第三个参数：上界
            var second = list[i - 2];  // Clamp 的第二个参数：下界
            var first = list[i - 3];   // Clamp 的第一个参数：被 clamp 的值

            // 只处理 Clamp(x, 1, 8) 这一种确切形态
            if (!IsConst(second, 1)) continue;
            if (!IsConst(third, 8)) continue;
            if (!ReadsConnectionLimit(first)) continue;

            third.operand = SingleFileConnections;
            replaced++;
        }

        if (replaced == 0)
        {
            // 没找到预期模式：可能是 PCL CE 改过了实现。
            // 此时不修改任何 IL（保持原版行为），由日志暴露问题，
            // 而不是悄悄破坏下载逻辑。
            McBoostLog.Warn("未找到连接数上限的 IL 模式，补丁未生效（PCL CE 版本可能已变更）");
        }
        else
        {
            McBoostLog.Info($"已提升单文件连接上限至 {SingleFileConnections}（原为 8）");
        }

        return list;
    }

    private static bool IsConst(CodeInstruction ins, int value)
    {
        if (ins.opcode != OpCodes.Ldc_I4 && ins.opcode != OpCodes.Ldc_I4_S)
            return false;
        return ins.operand is int v && v == value;
    }

    private static bool IsClampCall(CodeInstruction ins)
    {
        if (ins.opcode != OpCodes.Call && ins.opcode != OpCodes.Callvirt)
            return false;
        if (ins.operand is not MethodInfo m) return false;
        return m.Name == "Clamp" && m.DeclaringType != null
            && (m.DeclaringType.FullName == "System.Math"
                || m.DeclaringType.Name == "Math");
    }

    /// <summary>
    /// 判断该指令是否读取 ModNet.NetTaskSingleFileConnectionLimit。
    /// </summary>
    private static bool ReadsConnectionLimit(CodeInstruction ins)
    {
        if (ins.opcode != OpCodes.Call && ins.opcode != OpCodes.Callvirt
            && ins.opcode != OpCodes.Ldsfld)
            return false;
        if (ins.operand is not MemberInfo m) return false;
        return m.Name.Contains("NetTaskSingleFileConnectionLimit");
    }
}

/// <summary>
/// 极简日志：写入 PCL CE 的日志目录，同时输出到调试器。
/// 不依赖 PCL CE 内部类型，避免版本耦合。
/// </summary>
internal static class McBoostLog
{
    private static readonly object Gate = new();
    private static string? _logPath;

    internal static void Info(string message) => Write("INFO", message);
    internal static void Warn(string message) => Write("WARN", message);

    private static void Write(string level, string message)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{level}] [mcboost] {message}";
        System.Diagnostics.Debug.WriteLine(line);
        try
        {
            lock (Gate)
            {
                _logPath ??= Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "PCL", "mcboost-hook.log");
                Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!);
                File.AppendAllText(_logPath, line + Environment.NewLine);
            }
        }
        catch
        {
            // 日志失败绝不影响下载
        }
    }
}
