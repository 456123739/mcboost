using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;

namespace McBoost.Launcher;

/// <summary>
/// 启动器。
///
/// 原理：设置环境变量 DOTNET_STARTUP_HOOKS 指向 PclHook.dll，
/// 然后启动 PCL CE。.NET 运行时会在 Main() 之前自动加载该 DLL
/// 并执行 StartupHook.Initialize()，补丁随之生效。
///
/// 不需要注入、不需要管理员权限、不修改 PCL CE 任何文件。
/// </summary>
public partial class MainWindow : Window
{
    private const string HookDllName = "PclHook.dll";
    private const string LogFileName = "mcboost-hook.log";

    public MainWindow()
    {
        InitializeComponent();
        SliderConnections.ValueChanged += (_, _) =>
            TxtConnections.Text = ((int)SliderConnections.Value).ToString();
        Loaded += (_, _) => RefreshEnvironment();
    }

    private void RefreshEnvironment()
    {
        var pcl = FindPclCe();
        if (pcl != null)
        {
            Append($"检测到 PCL CE 已在运行: {pcl}（补丁需重启 PCL CE 才生效）");
            TxtStatus.Text = "PCL CE 正在运行 —— 请先关闭它再点启动";
            BtnLaunch.IsEnabled = false;
        }
        else
        {
            TxtStatus.Text = pcl == null ? "就绪，点「启动 PCL CE」" : TxtStatus.Text;
        }

        var hook = HookPath;
        Append(File.Exists(hook) ? $"钩子: {hook}" : $"缺少钩子文件: {hook}");
    }

    private void OnLaunch(object sender, RoutedEventArgs e)
    {
        if (FindPclCe() != null)
        {
            Append("PCL CE 已在运行，请先完全关闭它");
            return;
        }

        var hook = HookPath;
        if (!File.Exists(hook))
        {
            Append($"找不到 {HookDllName}（应在 {Path.GetDirectoryName(hook)}）");
            return;
        }

        // 清掉上次的日志，让这次的结果一目了然
        try { if (File.Exists(LogPath)) File.Delete(LogPath); } catch { }
        TxtLog.Text = "";

        var exe = FindPclCeExe();
        if (exe == null)
        {
            Append("找不到 PCL CE 主程序。请用「选择 PCL CE 程序」指定，或手动启动。");
            return;
        }

        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
        };
        psi.Environment["DOTNET_STARTUP_HOOKS"] = hook;
        psi.Environment["MCBOOST_PCL_CONNECTIONS"] = ((int)SliderConnections.Value).ToString();

        try
        {
            Process.Start(psi);
            Append($"已带钩子启动: {Path.GetFileName(exe)}");
            Append($"  DOTNET_STARTUP_HOOKS = {hook}");
            Append($"  目标连接数 = {(int)SliderConnections.Value}");
            Append("");
            Append("等 PCL CE 主界面出来后，点「检查钩子状态」确认。");
            TxtStatus.Text = "已启动，等待钩子生效…";
            BtnLaunch.IsEnabled = false;
            _ = WatchHookAsync();
        }
        catch (Exception ex)
        {
            Append("启动失败: " + ex.Message);
        }
    }

    /// <summary>
    /// 启动后轮询日志，确认钩子真的执行了。
    /// </summary>
    private async Task WatchHookAsync()
    {
        for (var i = 0; i < 60; i++)
        {
            await Task.Delay(1000);
            var content = SafeReadLog();
            if (content != null && content.Contains("startup hook"))
            {
                Dispatcher.Invoke(() =>
                {
                    Append("✓ 钩子已注入进程（见下方日志）");
                    Append(content);
                    TxtStatus.Text = content.Contains("DONE:")
                        ? "✓ 加速已生效"
                        : content.Contains("FAIL")
                            ? "✗ 钩子执行了但补丁失败，请看日志"
                            : "钩子已加载，处理中…";
                });
                return;
            }
        }
        Dispatcher.Invoke(() =>
        {
            Append("✗ 30 秒内没有检测到钩子日志。");
            Append("  可能原因：");
            Append("  1. PCL CE 不是框架依赖的 .NET 应用（启动钩子不生效）");
            Append("  2. 启动的是别的 exe，不是真正加载游戏的那个");
            Append("  3. 环境变量被父进程覆盖");
            TxtStatus.Text = "未检测到钩子";
        });
    }

    private void OnCheck(object sender, RoutedEventArgs e)
    {
        var content = SafeReadLog();
        if (content == null)
        {
            Append("日志不存在 —— 钩子尚未执行过");
            return;
        }
        Append("— 日志内容 —");
        Append(content);
        TxtStatus.Text = content.Contains("DONE:") ? "✓ 加速已生效" : "见日志";
    }

    private void OnOpenLog(object sender, RoutedEventArgs e)
    {
        if (File.Exists(LogPath))
            Process.Start(new ProcessStartInfo(LogPath) { UseShellExecute = true });
        else
            Append("日志还不存在");
    }

    // ———————————————————————————————

    private static string HookPath =>
        Path.Combine(AppContext.BaseDirectory, HookDllName);

    private static string LogPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "PCL", LogFileName);

    private static string? SafeReadLog()
    {
        for (var i = 0; i < 2; i++)
        {
            var p = i == 0
                ? LogPath
                : Path.Combine(Path.GetTempPath(), LogFileName);
            try
            {
                if (File.Exists(p)) return File.ReadAllText(p);
            }
            catch { }
        }
        return null;
    }

    /// <summary>查找正在运行的 PCL CE。</summary>
    private static string? FindPclCe()
    {
        foreach (var n in new[] { "MultiMc", "Plain Craft Launcher 2" })
        {
            try
            {
                var p = Process.GetProcessesByName(n).FirstOrDefault();
                if (p != null) return $"{n}.exe (PID {p.Id})";
            }
            catch { }
        }
        return null;
    }

    /// <summary>
    /// 定位 PCL CE 可执行文件。
    /// 优先用与本程序同目录的 MultiMc.exe，其次常见安装路径。
    /// </summary>
    private static string? FindPclCeExe()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "MultiMc.exe");
        if (File.Exists(local)) return local;

        foreach (var n in new[] { "MultiMc.exe", "Plain Craft Launcher 2.exe" })
        {
            var candidates = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "..", n),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), n),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", n),
            };
            foreach (var c in candidates)
            {
                try { if (File.Exists(c)) return Path.GetFullPath(c); } catch { }
            }
        }
        return null;
    }

    private void Append(string line)
    {
        TxtLog.Text += $"[{DateTime.Now:HH:mm:ss}] {line}\n";
    }
}
