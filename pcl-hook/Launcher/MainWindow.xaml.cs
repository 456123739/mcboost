using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;

namespace McBoost.Launcher;

/// <summary>
/// 启动器。
///
/// 原理：设置 DOTNET_STARTUP_HOOKS 指向 PclHook.dll，再启动 PCL CE。
/// 运行时会在 PCL CE 的 Main() 之前加载钩子并执行 StartupHook.Initialize()。
///
/// 定位 PCL CE 的优先顺序：
///   1. 上次手动选择并保存的路径（最可靠）
///   2. 正在运行的 MultiMc 进程的真实路径
///   3. 与本程序同目录
///   4. 常见位置（桌面 / 下载 / 各盘根目录下一层）
/// 找不到时由用户点「浏览…」手动指定，选完记住。
/// </summary>
public partial class MainWindow : Window
{
    private const string HookDllName = "PclHook.dll";
    private const string LogFileName = "mcboost-hook.log";
    private const string ConfigFileName = "mcboost-launcher.json";

    /// <summary>候选进程名。PCL CE 的主程序是 MultiMc.exe。</summary>
    private static readonly string[] ProcessNames = { "MultiMc", "Plain Craft Launcher 2" };

    /// <summary>候选可执行文件名。</summary>
    private static readonly string[] ExeNames = { "MultiMc.exe", "Plain Craft Launcher 2.exe" };

    public MainWindow()
    {
        InitializeComponent();

        SliderConnections.ValueChanged += (_, _) =>
            TxtConnections.Text = ((int)SliderConnections.Value).ToString();

        Loaded += (_, _) =>
        {
            var found = LocateExe();
            if (found != null)
            {
                TxtExePath.Text = found.Path;
                Append($"已定位 PCL CE: {found.Path}");
                Append($"  （来源: {found.Source}）");
            }
            else
            {
                Append("未能自动找到 PCL CE。请点「浏览…」手动选择 MultiMc.exe。");
                TxtDetectHint.Text = "⚠ 未找到，请点「浏览…」手动指定 MultiMc.exe";
                TxtDetectHint.Foreground = System.Windows.Media.Brushes.Orange;
            }
        };
    }

    // ———————————————————————————————
    // 事件
    // ———————————————————————————————

    private void OnBrowse(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Title = "选择 PCL CE 主程序（MultiMc.exe）",
            Filter = "可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*",
            CheckFileExists = true,
        };

        // 默认打开上次的目录
        var current = TxtExePath.Text?.Trim();
        if (!string.IsNullOrEmpty(current))
        {
            try
            {
                var dir = Path.GetDirectoryName(current);
                if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) dlg.InitialDirectory = dir;
            }
            catch { }
        }

        if (dlg.ShowDialog(this) != true) return;

        TxtExePath.Text = dlg.FileName;
        SaveConfig(dlg.FileName);
        Append($"已选择: {dlg.FileName}");
        TxtDetectHint.Text = "已保存，下次启动会自动使用这个路径";
        TxtDetectHint.Foreground = System.Windows.Media.Brushes.LightGreen;
    }

    private void OnAutoDetect(object sender, RoutedEventArgs e)
    {
        var found = LocateExe(forceRediscover: true);
        if (found == null)
        {
            Append("自动检测仍未找到。请点「浏览…」手动选择。");
            TxtDetectHint.Text = "⚠ 自动检测失败，请手动选择";
            TxtDetectHint.Foreground = System.Windows.Media.Brushes.Orange;
            return;
        }
        TxtExePath.Text = found.Path;
        SaveConfig(found.Path);
        Append($"自动检测到: {found.Path}（来源: {found.Source}）");
        TxtDetectHint.Text = "已保存";
        TxtDetectHint.Foreground = System.Windows.Media.Brushes.LightGreen;
    }

    private void OnLaunch(object sender, RoutedEventArgs e)
    {
        var running = FindRunningProcess();
        if (running != null)
        {
            Append($"PCL CE 已在运行 (PID {running.Id})，请先完全退出它再启动");
            return;
        }

        var exe = TxtExePath.Text?.Trim();
        if (string.IsNullOrEmpty(exe) || !File.Exists(exe))
        {
            // 最后再尝试一次自动定位
            var found = LocateExe(forceRediscover: true);
            if (found == null)
            {
                Append("请先选择 PCL CE 主程序（点「浏览…」）");
                return;
            }
            exe = found.Path;
            TxtExePath.Text = exe;
            SaveConfig(exe);
        }

        var hook = HookPath;
        if (!File.Exists(hook))
        {
            Append($"找不到 {HookDllName}，应在 {Path.GetDirectoryName(hook)}");
            return;
        }
        if (!File.Exists(Path.Combine(AppContext.BaseDirectory, "0Harmony.dll")))
        {
            Append("找不到 0Harmony.dll（必须与 PclHook.dll 同目录）");
            return;
        }

        // 清掉上次日志，让本次结果一目了然
        try { if (File.Exists(LogPath)) File.Delete(LogPath); } catch { }
        TxtLog.Text = "";

        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
        };
        psi.Environment["DOTNET_STARTUP_HOOKS"] = hook;
        psi.Environment["MCBOOST_PCL_THREADS"] = ((int)SliderConnections.Value).ToString();

        try
        {
            Process.Start(psi);
            Append($"已带钩子启动: {Path.GetFileName(exe)}");
            Append($"  DOTNET_STARTUP_HOOKS = {hook}");
            Append($"  目标全局连接数 = {(int)SliderConnections.Value}");
            Append("");
            Append("等 PCL CE 主界面出来后，会自动检测结果…");
            TxtStatus.Text = "已启动，等待钩子生效…";
            BtnLaunch.IsEnabled = false;
            _ = WatchHookAsync();
        }
        catch (Exception ex)
        {
            Append("启动失败: " + ex.Message);
            Append("提示：如果 PCL CE 需要管理员权限，请右键本程序「以管理员身份运行」。");
        }
    }

    /// <summary>启动后轮询日志确认钩子执行。</summary>
    private async Task WatchHookAsync()
    {
        for (var i = 0; i < 40; i++)
        {
            await Task.Delay(1000);
            var content = SafeReadLog();
            if (content != null && content.Contains("startup hook"))
            {
                Dispatcher.Invoke(() => ShowHookResult(content));
                return;
            }
        }
        Dispatcher.Invoke(() =>
        {
            Append("✗ 40 秒内没有检测到钩子日志。");
            Append("  逐项排查：");
            Append("  1. 确认启动的确实是 PCL CE 主程序（MultiMc.exe）");
            Append("  2. PCL CE 是否真的启动了？有没有启动失败提示？");
            Append("  3. 如果 PCL CE 是自包含部署（不是框架依赖），启动钩子不生效");
            Append("  4. 日志第二个位置: " + Path.Combine(Path.GetTempPath(), LogFileName));
            TxtStatus.Text = "未检测到钩子";
            BtnLaunch.IsEnabled = true;
        });
    }

    private void ShowHookResult(string content)
    {
        Append("— 钩子日志 —");
        Append(content);
        BtnLaunch.IsEnabled = true;

        if (content.Contains("DONE:"))
        {
            TxtStatus.Text = "✓ 加速已生效";
            TxtStatus.Foreground = System.Windows.Media.Brushes.LightGreen;
        }
        else if (content.Contains("FAIL"))
        {
            TxtStatus.Text = "✗ 钩子已加载但补丁失败（见日志）";
            TxtStatus.Foreground = System.Windows.Media.Brushes.Orange;
        }
        else
        {
            TxtStatus.Text = "钩子已加载，处理中…";
            TxtStatus.Foreground = System.Windows.Media.Brushes.LightYellow;
        }
    }

    private void OnCheck(object sender, RoutedEventArgs e)
    {
        var content = SafeReadLog();
        if (content == null)
        {
            Append("日志不存在 —— 说明还没用本程序启动过 PCL CE，或钩子未加载");
            return;
        }
        ShowHookResult(content);
    }

    private void OnOpenLog(object sender, RoutedEventArgs e)
    {
        if (File.Exists(LogPath)) Process.Start(new ProcessStartInfo(LogPath) { UseShellExecute = true });
        else if (File.Exists(Path.Combine(Path.GetTempPath(), LogFileName)))
            Process.Start(new ProcessStartInfo(Path.Combine(Path.GetTempPath(), LogFileName)) { UseShellExecute = true });
        else Append("日志还不存在");
    }

    // ———————————————————————————————
    // 定位 PCL CE
    // ———————————————————————————————

    private LocatedExe? LocateExe(bool forceRediscover = false)
    {
        // 1. 已保存的路径
        if (!forceRediscover)
        {
            var saved = LoadConfig();
            if (saved != null && File.Exists(saved)) return new LocatedExe(saved, "上次选择的路径");
        }

        // 2. 正在运行的进程 —— 最可靠
        var proc = FindRunningProcess();
        if (proc != null)
        {
            var p = SafeMainModulePath(proc);
            if (p != null && File.Exists(p)) return new LocatedExe(p, "运行中的进程");
        }

        // 3. 与本程序同目录
        foreach (var n in ExeNames)
        {
            var c = Path.Combine(AppContext.BaseDirectory, n);
            if (File.Exists(c)) return new LocatedExe(c, "程序所在目录");
        }

        // 4. 常见位置
        var candidates = new System.Collections.Generic.List<string>();
        void AddDir(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return;
            try
            {
                if (!Directory.Exists(dir)) return;
                foreach (var n in ExeNames)
                {
                    var f = Path.Combine(dir, n);
                    if (File.Exists(f)) candidates.Add(f);
                }
            }
            catch { }
        }

        AddDir(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        AddDir(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) is { } up
            ? Path.Combine(up, "Downloads") : null);
        AddDir(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop"));

        // 各盘根目录及其一层的常见目录
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                var root = drive.RootDirectory.FullName;
                foreach (var n in ExeNames)
                {
                    var f = Path.Combine(root, n);
                    if (File.Exists(f)) candidates.Add(f);
                }
                foreach (var sub in new[] { "PCL", "pcl", "MC", "Minecraft", "Games", "Game", "Launcher" })
                {
                    AddDir(Path.Combine(root, sub));
                }
            }
            catch { }
        }

        var hit = candidates.FirstOrDefault(File.Exists);
        if (hit != null)
        {
            SaveConfig(hit);
            return new LocatedExe(hit, "常见位置扫描");
        }

        return null;
    }

    private static Process? FindRunningProcess()
    {
        foreach (var n in ProcessNames)
        {
            try
            {
                var p = Process.GetProcessesByName(n).FirstOrDefault();
                if (p != null) return p;
            }
            catch { }
        }
        return null;
    }

    private static string? SafeMainModulePath(Process p)
    {
        try { return p.MainModule?.FileName; }
        catch { return null; } // 权限不足时拿不到
    }

    // ———————————————————————————————
    // 配置读写
    // ———————————————————————————————

    private static string ConfigPath =>
        Path.Combine(AppContext.BaseDirectory, ConfigFileName);

    private static void SaveConfig(string exePath)
    {
        try
        {
            var json = $"{{\"pclPath\":\"{exePath.Replace("\\", "\\\\")}\"}}";
            File.WriteAllText(ConfigPath, json, Encoding.UTF8);
        }
        catch { /* 配置保存失败不影响使用 */ }
    }

    private static string? LoadConfig()
    {
        try
        {
            if (!File.Exists(ConfigPath)) return null;
            var text = File.ReadAllText(ConfigPath);
            var i = text.IndexOf("\"pclPath\":\"", StringComparison.Ordinal);
            if (i < 0) return null;
            i += 11;
            var j = text.IndexOf('"', i);
            if (j < 0) return null;
            return text.Substring(i, j - i).Replace("\\\\", "\\");
        }
        catch { return null; }
    }

    // ———————————————————————————————

    private static string HookPath => Path.Combine(AppContext.BaseDirectory, HookDllName);

    private static string LogPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PCL", LogFileName);

    private static string? SafeReadLog()
    {
        foreach (var p in new[] { LogPath, Path.Combine(Path.GetTempPath(), LogFileName) })
        {
            try { if (File.Exists(p)) return File.ReadAllText(p); } catch { }
        }
        return null;
    }

    private void Append(string line)
    {
        TxtLog.Text += $"[{DateTime.Now:HH:mm:ss}] {line}\n";
    }

    /// <summary>定位结果。</summary>
    private sealed record LocatedExe(string Path, string Source);
}
