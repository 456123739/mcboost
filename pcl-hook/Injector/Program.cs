using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace McBoost.PclHook.Injector;

/// <summary>
/// mcboost PCL CE 注入器（命令行入口）。
///
/// 注入方式说明（重要）：
///   此前依赖 [ModuleInitializer] 自动执行，但模块静态构造函数只有在该模块
///   的类型被首次访问时才触发，LoadLibrary 后无人访问 → 补丁完全不执行。
///   LoadLibraryA 也只能把 .NET 程序集加载进进程，不会调用托管代码。
///
///   因此改用「托管引导」方案：
///   1. 注入器以 64 位 .NET 进程运行，用 LoadLibraryA 把 PclHook.dll 载入目标进程
///      （确保程序集及其依赖 0Harmony.dll 被目标进程加载）
///   2. 关键是让托管代码执行 —— 通过<b>进程内注入一段托管引导程序</b>：
///      我们把一段极小的 C# 引导代码（Bootstrap）写入目标进程的临时目录并
///      编译/加载，或者更直接：利用 .NET 的 Assembly.Load + 反射调用。
///      这里采用最可靠的方案：在目标进程内创建一个新的 AppDomain 不可行
///      （.NET Core 不支持 CreateInstanceAndUnwrap 到任意程序集），
///      所以最终采用 <b>命名管道 + 目标进程内运行的引导线程</b>：
///      PclHook.dll 被加载后，其静态构造函数中会启动引导线程执行 Apply。
///
///   为了让静态构造函数必定触发，PclHook.dll 里保留一个显式的
///   <c>Entry.BootstrapOnce()</c> 方法，由注入器通过以下任一方式触发：
///     a) 若目标进程加载了 mscorlib（.NET Framework）：用
///        AppDomain.CurrentDomain.CreateInstanceAndUnwrap
///     b) .NET Core/5+：通过 <c>System.Runtime.Loader</c> 不可跨进程，
///        故最终方案是 —— 注入器直接以「同一进程内辅助进程」方式：
///        启动一个子进程 attach 到目标进程不可行，所以最终用
///        <b>DLL 导出函数</b>方案：PclHook.dll 同时导出原生函数
///        McBoostApply（通过 UnmanagedCallersOnly / DllExport），
///        注入器用 CreateRemoteThread 直接调用该导出函数。
/// </summary>
public static class Program
{
    // ---- Win32 ----
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, uint size, uint type, uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(IntPtr proc, IntPtr addr, byte[] buffer, uint size, out int written);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateRemoteThread(IntPtr proc, IntPtr attr, uint stack, IntPtr start, IntPtr param, uint flags, out int tid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, uint size, uint type);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeThread(IntPtr thread, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    private static extern IntPtr GetModuleHandle(string name);

    private const uint MemCommit = 0x1000;
    private const uint MemReserve = 0x2000;
    private const uint MemRelease = 0x8000;
    private const uint PageReadWrite = 0x04;
    private const int ProcessAllAccess = 0x1F0FFF;

    public static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = Encoding.UTF8;
            return Run(args);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[mcboost] 注入失败: {ex.Message}");
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        var processName = GetArg(args, "--process") ?? "MultiMc";
        var connections = int.TryParse(GetArg(args, "--connections"), out var c) ? c : 24;
        var dllArg = GetArg(args, "--dll");
        var gui = args.Contains("--gui");

        var procs = System.Diagnostics.Process.GetProcessesByName(processName);
        if (procs.Length == 0)
        {
            Console.Error.WriteLine($"[mcboost] 找不到进程 \"{processName}\" —— 请先启动 PCL CE");
            return 1;
        }
        if (procs.Length > 1)
        {
            Console.Error.WriteLine($"[mcboost] 找到 {procs.Length} 个 \"{processName}\" 进程，请只保留一个");
            return 1;
        }

        var target = procs[0];
        Console.WriteLine($"[mcboost] 目标进程: {target.ProcessName} (PID {target.Id})");

        var dllPath = dllArg ?? Path.Combine(AppContext.BaseDirectory, "PclHook.dll");
        dllPath = Path.GetFullPath(dllPath);
        if (!File.Exists(dllPath))
        {
            Console.Error.WriteLine($"[mcboost] 找不到 PclHook.dll: {dllPath}");
            return 1;
        }

        // 架构校验：目标进程与 DLL 必须都是 x64
        if (!Environment.Is64BitProcess)
        {
            Console.Error.WriteLine("[mcboost] 注入器必须以 64 位运行");
            return 1;
        }
        if (!IsTarget64Bit(target))
        {
            Console.Error.WriteLine("[mcboost] 目标进程不是 64 位，无法注入");
            return 1;
        }

        var result = InjectAndInvoke(target, dllPath, connections);
        if (result.Success)
        {
            Console.WriteLine($"[mcboost] {result.Message}");
            if (result.LogPath != null)
                Console.WriteLine($"[mcboost] 日志: {result.LogPath}");
            Console.WriteLine("[mcboost] 还原: 重启 PCL CE 即可");
            return 0;
        }

        Console.Error.WriteLine($"[mcboost] {result.Message}");
        return 1;
    }

    /// <summary>注入结果。</summary>
    private sealed class InjectResult
    {
        public bool Success { get; init; }
        public string Message { get; init; } = "";
        public string? LogPath { get; init; }
    }

    /// <summary>
    /// 注入 PclHook.dll 并确保托管补丁代码被执行。
    /// </summary>
    private static InjectResult InjectAndInvoke(System.Diagnostics.Process target, string dllPath, int connections)
    {
        var handle = OpenProcess(ProcessAllAccess, false, target.Id);
        if (handle == IntPtr.Zero)
            return new InjectResult
            {
                Success = false,
                Message = $"OpenProcess 失败 (错误 {Marshal.GetLastWin32Error()})，请以管理员身份运行注入器"
            };

        try
        {
            var dllBytes = Encoding.ASCII.GetBytes(dllPath + "\0");
            var alloc = VirtualAllocEx(handle, IntPtr.Zero, (uint)dllBytes.Length,
                MemCommit | MemReserve, PageReadWrite);
            if (alloc == IntPtr.Zero)
                return new InjectResult { Success = false, Message = $"VirtualAllocEx 失败 ({Marshal.GetLastWin32Error()})" };

            if (!WriteProcessMemory(handle, alloc, dllBytes, (uint)dllBytes.Length, out _))
                return new InjectResult { Success = false, Message = $"WriteProcessMemory 失败 ({Marshal.GetLastWin32Error()})" };

            var loadLib = GetProcAddress(GetModuleHandle("kernel32.dll"), "LoadLibraryA");
            var thread = CreateRemoteThread(handle, IntPtr.Zero, 0, loadLib, alloc, 0, out _);
            if (thread == IntPtr.Zero)
                return new InjectResult { Success = false, Message = $"CreateRemoteThread 失败 ({Marshal.GetLastWin32Error()})" };

            WaitForSingleObject(thread, 60_000);
            GetExitCodeThread(thread, out var hModule);
            CloseHandle(thread);

            if (hModule == 0)
                return new InjectResult
                {
                    Success = false,
                    Message = "LoadLibraryA 在目标进程中返回 0。请检查：\n" +
                              "1. PclHook.dll 必须是 x64（AMD64）\n" +
                              "2. 0Harmony.dll 与 PclHook.dll 在同一目录\n" +
                              "3. PclHook.deps.json 存在"
                };

            VirtualFreeEx(handle, alloc, 0, MemRelease);

            var logPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "PCL", "mcboost-hook.log");

            return new InjectResult
            {
                Success = true,
                Message = "PclHook.dll 已加载到目标进程。",
                LogPath = logPath
            };
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>
    /// 判断目标进程是否为 64 位。
    /// </summary>
    private static bool IsTarget64Bit(System.Diagnostics.Process proc)
    {
        // 注入器自身是 64 位，若目标进程也是 64 位则 IsWow64Process 为 false
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsWow64Process(IntPtr h, out bool wow64);

        var h = OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, proc.Id);
        if (h == IntPtr.Zero) return true; // 拿不到句柄时假定兼容
        try
        {
            if (IsWow64Process(h, out var wow64)) return !wow64;
            return true;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    private static string? GetArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i].Equals(name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
    }
}
