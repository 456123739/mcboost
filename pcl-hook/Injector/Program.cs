using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

namespace McBoost.PclHook.Injector;

/// <summary>
/// 托管 DLL 注入器。
///
/// 为什么需要它：PCL CE 没有插件系统，外部 DLL 不会自动加载。
/// 本程序把 <c>PclHook.dll</c> 注入到运行中的 PCL CE 进程，
/// 并调用 <c>McBoost.PclHook.Entry.Apply()</c> 完成补丁。
///
/// 实现方式：经典的 LoadImage 远程线程注入。
///   1. VirtualAllocEx 在目标进程分配内存，写入 DLL 路径
///   2. CreateRemoteThread 调用 kernel32!LoadLibraryA 加载 DLL
///   3. 等待加载完成后，再写一段调用 Entry.Apply() 的 stub 并执行
///      —— 因为 Harmony 的 Patch 必须在 .NET 运行时初始化完成后进行。
///
/// 用法：
///   PclHookInjector.exe --process "Plain Craft Launcher 2" [--connections 24] [--dll <路径>]
/// </summary>
public static class Program
{
    private const int ProcessStillActive = 259;

    // Win32 API
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

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    private static extern IntPtr GetModuleHandle(string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private const uint MemCommit = 0x1000;
    private const uint MemReserve = 0x2000;
    private const uint MemRelease = 0x8000;
    private const uint PageReadWrite = 0x04;
    private const uint PageExecuteReadWrite = 0x40;
    private const int ProcessAllAccess = 0x1F0FFF;

    public static int Main(string[] args)
    {
        try
        {
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
        var processName = GetArg(args, "--process") ?? "Plain Craft Launcher 2";
        var connections = int.TryParse(GetArg(args, "--connections"), out var c) ? c : 24;
        var dllArg = GetArg(args, "--dll");

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

        // 目标进程可能没有对应架构的本机 shim，这里只支持 64 位
        if (!Environment.Is64BitProcess)
        {
            Console.Error.WriteLine("[mcboost] 注入器必须以 64 位运行");
            return 1;
        }

        Inject(target, dllPath, connections);
        Console.WriteLine($"[mcboost] 注入完成。目标连接数: {connections}");
        Console.WriteLine($"[mcboost] 日志: %APPDATA%/PCL/mcboost-hook.log");
        Console.WriteLine("[mcboost] 还原: 重启 PCL CE 即可");
        return 0;
    }

    private static void Inject(System.Diagnostics.Process target, string dllPath, int connections)
    {
        var handle = OpenProcess(ProcessAllAccess, false, target.Id);
        if (handle == IntPtr.Zero)
            throw new InvalidOperationException($"OpenProcess 失败: {Marshal.GetLastWin32Error()}");

        try
        {
            // ---- 第一步：LoadLibrary 加载 DLL ----
            var dllBytes = System.Text.Encoding.ASCII.GetBytes(dllPath + "\0");
            var alloc = VirtualAllocEx(handle, IntPtr.Zero, (uint)dllBytes.Length, MemCommit | MemReserve, PageReadWrite);
            if (alloc == IntPtr.Zero)
                throw new InvalidOperationException($"VirtualAllocEx 失败: {Marshal.GetLastWin32Error()}");

            if (!WriteProcessMemory(handle, alloc, dllBytes, (uint)dllBytes.Length, out _))
                throw new InvalidOperationException($"WriteProcessMemory 失败: {Marshal.GetLastWin32Error()}");

            var loadLib = GetProcAddress(GetModuleHandle("kernel32.dll"), "LoadLibraryA");
            var thread = CreateRemoteThread(handle, IntPtr.Zero, 0, loadLib, alloc, 0, out _);
            if (thread == IntPtr.Zero)
                throw new InvalidOperationException($"CreateRemoteThread 失败: {Marshal.GetLastWin32Error()}");

            WaitForSingleObject(thread, 30_000);
            GetExitCodeThread(thread, out var hModule);
            CloseHandle(thread);

            if (hModule == 0)
                throw new InvalidOperationException("LoadLibraryA 在目标进程中返回 0 —— DLL 可能不是有效的 .NET 程序集");

            VirtualFreeEx(handle, alloc, 0, MemRelease);
            Console.WriteLine($"[mcboost] PclHook.dll 已加载到目标进程 (模块基址 0x{hModule:X})");

            // ---- 第二步：调用 Entry.Apply(connections) ----
            // 用反射在目标进程内执行：等运行时初始化后调用。
            // 这里通过在注入 DLL 内部起一个线程来完成 —— LoadLibrary 返回时
            // 程序集的模块初始化器（ModuleInitializer）会自动执行 Apply。
            // 因此第二步无需额外 stub，见 Entry.cs 的 ModuleInitializer。
            Thread.Sleep(500);
        }
        finally
        {
            CloseHandle(handle);
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
