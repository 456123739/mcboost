using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace McBoost.PclHook.Injector;

/// <summary>
/// CLR 托管注入。
///
/// 为什么不能只用 LoadLibraryA：
///   LoadLibraryA 只会把 .NET Framework 程序集加载进进程，
///   **不会调用我们的任何托管代码**。此前依赖 [ModuleInitializer]
///   自动执行，但模块静态构造函数只有在该模块的类型被首次访问时才触发，
///   而加载后没有任何代码访问 PclHook 的类型，所以补丁根本不执行
///   （实测：注入成功、无日志、无任何效果）。
///
/// 正确做法：
///   1. OpenProcess 打开目标进程
///   2. 用 mscoree!CorBindToRuntimeEx / CLRCreateInstance 拿到 ICLRRuntimeInfo
///      —— 但这需要在目标进程内执行。实际采用经典方案：
///      a. VirtualAllocEx 写入 DLL 路径
///      b. CreateRemoteThread + LoadLibraryA 把 PclHook.dll 加载进去
///         （这一步让程序集进入目标进程的 AppDomain）
///      c. 关键是<b>让目标进程执行一段托管 stub</b>：
///         我们再写入一个原生 shim DLL 的调用，或直接利用
///         ICLRRuntimeHost::ExecuteInDefaultAppDomain 在目标进程里
///         调用 McBoost.PclHook.Entry.Apply。
///
///   这里采用最稳的方式：注入一个原生 loader DLL（PclHookLoader.dll），
///   它的 DllMain 里通过 CLR 托管调用执行 Apply。
/// </summary>
public static class ClrInjector
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
    private const uint Infinite = 0xFFFFFFFF;

    /// <summary>
    /// 注入结果。
    /// </summary>
    public sealed class InjectResult
    {
        public bool Success { get; init; }
        public string Message { get; init; } = "";
        public string? LogPath { get; init; }
    }

    /// <summary>
    /// 对指定进程执行托管注入。
    /// </summary>
    /// <param name="pid">目标进程 PID</param>
    /// <param name="hookDllPath">PclHook.dll 的绝对路径</param>
    /// <param name="loaderDllPath">PclHookLoader.dll（原生 shim）的绝对路径，可为 null</param>
    /// <param name="connections">目标连接数</param>
    public static InjectResult Inject(int pid, string hookDllPath, string? loaderDllPath, int connections)
    {
        hookDllPath = Path.GetFullPath(hookDllPath);
        if (!File.Exists(hookDllPath))
            return new InjectResult { Success = false, Message = $"找不到 PclHook.dll: {hookDllPath}" };

        var handle = OpenProcess(ProcessAllAccess, false, pid);
        if (handle == IntPtr.Zero)
            return new InjectResult
            {
                Success = false,
                Message = $"OpenProcess 失败 (错误 {Marshal.GetLastWin32Error()})，请以管理员身份运行注入器"
            };

        try
        {
            // 第一步：LoadLibrary 加载 Hook DLL，让程序集进入目标进程
            var dllBytes = Encoding.ASCII.GetBytes(hookDllPath + "\0");
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
                    Message = "LoadLibraryA 在目标进程中返回 0 —— 请检查：\n" +
                              "1. PclHook.dll 是否与 PCL CE 架构一致（都需 x64）\n" +
                              "2. 0Harmony.dll 是否与 PclHook.dll 在同一目录\n" +
                              "3. PclHook.deps.json 是否存在"
                };

            VirtualFreeEx(handle, alloc, 0, MemRelease);

            // 第二步：调用托管方法 Entry.Apply。
            // 有原生 shim 时通过 shim 的导出函数触发；否则提示用户。
            var logPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "PCL", "mcboost-hook.log");

            if (!string.IsNullOrEmpty(loaderDllPath) && File.Exists(loaderDllPath))
            {
                var loaderBytes = Encoding.ASCII.GetBytes(loaderDllPath + "\0");
                var alloc2 = VirtualAllocEx(handle, IntPtr.Zero, (uint)loaderBytes.Length,
                    MemCommit | MemReserve, PageReadWrite);
                if (alloc2 == IntPtr.Zero)
                    return new InjectResult { Success = false, Message = $"VirtualAllocEx(loader) 失败 ({Marshal.GetLastWin32Error()})" };

                WriteProcessMemory(handle, alloc2, loaderBytes, (uint)loaderBytes.Length, out _);
                var thread2 = CreateRemoteThread(handle, IntPtr.Zero, 0, loadLib, alloc2, 0, out _);
                if (thread2 != IntPtr.Zero)
                {
                    WaitForSingleObject(thread2, 60_000);
                    CloseHandle(thread2);
                }
                VirtualFreeEx(handle, alloc2, 0, MemRelease);
            }

            return new InjectResult
            {
                Success = true,
                Message = "DLL 已加载。请查看日志确认补丁是否生效。",
                LogPath = logPath
            };
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>
    /// 查找 PCL CE 进程。
    /// </summary>
    public static Process? FindPclCe()
    {
        // PCL CE 的可执行文件名：MultiMc.exe（主程序集 Plain Craft Launcher 2）
        var names = new[] { "MultiMc", "Plain Craft Launcher 2", "PCL CE" };
        foreach (var n in names)
        {
            var procs = Process.GetProcessesByName(n);
            if (procs.Length > 0) return procs[0];
        }
        return null;
    }

    /// <summary>
    /// 读取 PCL CE 的可执行文件版本号，用于版本检测。
    /// </summary>
    public static string? GetTargetVersion(Process proc)
    {
        try
        {
            var main = proc.MainModule?.FileName;
            if (main == null || !File.Exists(main)) return null;
            var info = FileVersionInfo.GetVersionInfo(main);
            return info.FileVersion ?? info.ProductVersion;
        }
        catch (Win32Exception)
        {
            return null; // 拒绝访问，可能需要管理员权限
        }
        catch (Exception)
        {
            return null;
        }
    }
}
