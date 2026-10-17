using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using HarmonyLib;

namespace McBoost.PclHook;

/// <summary>
/// mcboost 针对 PCL CE 的连接数上限破解。
///
/// 为什么不用 [ModuleInitializer]：ModuleInitializer 生成的代码在模块的
/// .cctor 里，而模块静态构造函数只有在该模块的类型被首次访问时才触发。
/// 注入器用 LoadLibrary 加载 DLL 后，如果没有代码访问 PclHook 的任何类型，
/// .cctor 永远不执行 —— 实测表现为「注入成功但毫无反应，连日志都没有」。
/// 所以改为由注入器通过 ICLRRuntimeInfo::ExecuteInDefaultAppDomain
/// 主动调用 Entry.Apply。
/// </summary>
public static class Entry
{
    /// <summary>默认目标单文件连接数。</summary>
    public const int DefaultSingleFileConnections = 24;

    /// <summary>Hook DLL 版本，用于版本检测与自动还原。</summary>
    public const string HookVersion = "1.0.0";

    private static Harmony? _harmony;
    private static int _singleFileConnections = DefaultSingleFileConnections;
    private static bool _applied;

    /// <summary>是否已 patch 成功。</summary>
    public static bool IsApplied => _applied;

    /// <summary>当前生效的单文件连接数。</summary>
    public static int SingleFileConnections => _singleFileConnections;

    /// <summary>
    /// 应用补丁。由注入器通过 CLR 托管注入主动调用。幂等。
    /// </summary>
    public static bool Apply(int? singleFileConnections = null)
    {
        if (_applied) return true;

        if (singleFileConnections is > 0)
            _singleFileConnections = singleFileConnections.Value;
        TranspilerHolder.SingleFileConnections = _singleFileConnections;

        _harmony = new Harmony("com.mcboost.pclhook");

        var downloaderType = FindType("PCL.Network.Downloader.AdaptiveRangeDownloader")
                             ?? FindType("AdaptiveRangeDownloader");
        if (downloaderType is null)
        {
            McBoostLog.Warn("找不到 AdaptiveRangeDownloader —— PCL CE 版本可能不兼容");
            return false;
        }

        var downloadAsync = downloaderType.GetMethod("DownloadAsync",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (downloadAsync is null)
        {
            McBoostLog.Warn("找不到 AdaptiveRangeDownloader.DownloadAsync");
            return false;
        }

        // 顺带抬高属性值：即使某条路径没走到被 patch 的内联常量，
        // Clamp 的输入也是高值，行为只会更激进（不会更慢）。
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

        try
        {
            _harmony.Patch(downloadAsync, transpiler: transpiler);
        }
        catch (Exception ex)
        {
            McBoostLog.Warn($"Harmony patch 失败: {ex.Message}");
            return false;
        }

        _applied = true;
        McBoostLog.Info($"PCL CE Hook {HookVersion} 已就绪，目标单文件连接数 {_singleFileConnections}");
        return true;
    }

    /// <summary>
    /// 撤销全部补丁，恢复 PCL CE 原版行为。
    /// </summary>
    public static void Revert()
    {
        if (_harmony is null) return;
        try
        {
            _harmony.UnpatchAll(_harmony.Id);
            McBoostLog.Info("已还原 PCL CE 原版下载行为");
        }
        catch (Exception ex)
        {
            McBoostLog.Warn($"还原失败: {ex.Message}");
        }
        finally
        {
            _applied = false;
            _harmony = null;
        }
    }

    /// <summary>
    /// 在运行时改变目标连接数。修改后需重新 Apply 才会写进 IL。
    /// </summary>
    public static void SetSingleFileConnections(int value)
    {
        if (value <= 0) throw new ArgumentOutOfRangeException(nameof(value));
        _singleFileConnections = value;
        TranspilerHolder.SingleFileConnections = value;
    }

    /// <summary>
    /// 供注入器查询当前状态，返回 JSON 字符串。
    /// </summary>
    public static string GetStatus()
    {
        var applied = _applied ? "true" : "false";
        return $"{{\"applied\":{applied},\"connections\":{_singleFileConnections},\"version\":\"{HookVersion}\"}}";
    }

    /// <summary>
    /// 在已加载的程序集中查找类型。PCL CE 主程序集名随构建变化，
    /// 所以逐个程序集查，精确全名失败时退化为按短名匹配。
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
/// Harmony transpiler 宿主。Harmony 通过反射调用，类型和方法必须 public。
/// </summary>
public static class TranspilerHolder
{
    /// <summary>目标单文件连接数，会被写进 IL 替换原来的 8。</summary>
    public static int SingleFileConnections = Entry.DefaultSingleFileConnections;

    /// <summary>
    /// 精确替换 Math.Clamp(ModNet.NetTaskSingleFileConnectionLimit, 1, 8)
    /// 中作为上界的常量 8。以 Clamp 调用为锚点向前回溯，只处理
    /// Clamp(x, 1, 8) 这一种形态，且确认第一个参数读取的是连接数限制属性。
    /// </summary>
    public static IEnumerable<CodeInstruction> Transpile(IEnumerable<CodeInstruction> instructions)
    {
        var list = instructions.ToList();
        var replaced = 0;

        for (int i = 0; i < list.Count; i++)
        {
            if (!IsClampCall(list[i])) continue;
            if (i < 3) continue;

            var third = list[i - 1];   // Clamp 第三参数：上界
            var second = list[i - 2];  // Clamp 第二参数：下界
            var first = list[i - 3];   // Clamp 第一参数：被 clamp 的值

            if (!IsConst(second, 1)) continue;
            if (!IsConst(third, 8)) continue;
            if (!ReadsConnectionLimit(first)) continue;

            third.operand = SingleFileConnections;
            replaced++;
        }

        if (replaced == 0)
        {
            // 没匹配到：不修改任何 IL，保持原版行为，靠日志暴露问题，
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
            && (m.DeclaringType.FullName == "System.Math" || m.DeclaringType.Name == "Math");
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
/// 极简日志。写入 %APPDATA%\PCL\mcboost-hook.log，同时输出到调试器。
/// 不依赖 PCL CE 内部类型，避免版本耦合。
/// </summary>
internal static class McBoostLog
{
    private static readonly object Gate = new();
    private static string? _logPath;

    /// <summary>日志文件路径，供外部读取。</summary>
    internal static string LogPath
    {
        get
        {
            _logPath ??= Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "PCL", "mcboost-hook.log");
            return _logPath;
        }
    }

    internal static void Info(string message) => Write("INFO", message);
    internal static void Warn(string message) => Write("WARN", message);

    private static void Write(string level, string message)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{level}] [mcboost] {message}";
        System.Diagnostics.Debug.WriteLine(line);
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                File.AppendAllText(LogPath, line + Environment.NewLine);
            }
        }
        catch
        {
            // 日志失败绝不影响下载
        }
    }
}
