using System;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Threading;

// 注意：本文件**故意不使用 namespace**。
// .NET 运行时用 Assembly.GetType("StartupHook") 查找钩子类型，
// 该调用只在全局命名空间里找 —— 一旦放进命名空间，
// 类型全名变成 Xxx.StartupHook，运行时找不到，钩子会静默不执行。

/// <summary>
/// .NET 启动钩子入口。
///
/// 由运行时通过环境变量 DOTNET_STARTUP_HOOKS 自动加载并调用，
/// 时机在目标程序 Main() 之前 —— 不需要注入、不需要管理员权限。
///
/// 契约（必须严格遵守，否则钩子静默不执行）：
///   1. 类型名必须恰好是 StartupHook，且位于**全局命名空间**
///   2. 必须有 public static void Initialize()，无参数、无返回值
///   3. 本方法体内**不能直接引用 Harmony 类型** —— 否则 JIT 本方法时
///      就要解析 Harmony，而那时依赖解析器还没注册，会抛
///      FileNotFoundException 导致钩子失效。
///      所以真正的补丁逻辑放在 NoInlining 的方法里，
///      在解析器注册完成后由新线程 JIT 并执行。
/// </summary>
public static class StartupHook
{
    /// <summary>钩子版本。</summary>
    public const string HookVersion = "3.0.0";

    /// <summary>运行时自动调用的入口。第一行就写日志，确保能证明钩子被加载过。</summary>
    public static void Initialize()
    {
        try
        {
            McBoost.PclHook.Diag.Log($"startup hook v{HookVersion} loaded, pid={Environment.ProcessId}");
            McBoost.PclHook.Diag.Log($"process: {SafeProcessName()}");

            RegisterDependencyResolver();

            var t = new Thread(RunOnThread)
            {
                IsBackground = true,
                Name = "mcboost-patcher",
            };
            t.Start();
        }
        catch (Exception ex)
        {
            // 钩子绝不能把 PCL CE 带崩
            try { McBoost.PclHook.Diag.Log("FATAL in Initialize: " + ex); } catch { }
        }
    }

    /// <summary>独立线程入口。NoInlining 保证其 JIT 发生在解析器注册之后。</summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunOnThread()
    {
        try
        {
            McBoost.PclHook.PatchRunner.RunUntilApplied();
        }
        catch (Exception ex)
        {
            try { McBoost.PclHook.Diag.Log("FATAL in patch thread: " + ex); } catch { }
        }
    }

    /// <summary>
    /// 注册依赖解析器：从钩子所在目录加载 0Harmony.dll。
    /// 启动钩子的依赖不会自动去目标程序目录找，必须自己定位。
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RegisterDependencyResolver()
    {
        var hookDir = Path.GetDirectoryName(typeof(StartupHook).Assembly.Location);
        if (string.IsNullOrEmpty(hookDir))
        {
            McBoost.PclHook.Diag.Log("cannot determine hook directory");
            return;
        }
        McBoost.PclHook.Diag.Log("hook dir: " + hookDir);

        AssemblyLoadContext.Default.Resolving += (ctx, name) =>
        {
            try
            {
                var candidate = Path.Combine(hookDir, name.Name + ".dll");
                if (File.Exists(candidate))
                {
                    McBoost.PclHook.Diag.Log("resolving assembly: " + name.Name);
                    return ctx.LoadFromAssemblyPath(candidate);
                }
            }
            catch (Exception ex)
            {
                McBoost.PclHook.Diag.Log("resolver error for " + name.Name + ": " + ex.Message);
            }
            return null;
        };
    }

    private static string SafeProcessName()
    {
        try { return System.Diagnostics.Process.GetCurrentProcess().ProcessName; }
        catch { return "?"; }
    }
}
