using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Threading;

namespace McBoost.PclHook.Gui;

/// <summary>
/// 交互逻辑。
/// </summary>
public partial class MainWindow : Window
{
    private const string HookVersion = "1.0.0";
    private string? _baselineVersion;   // 首次成功注入时记录的 PCL CE 版本
    private string? _baselinePath;      // PCL CE 可执行文件路径（升级会变）
    private int _lastInjectedPid = -1;
    private readonly DispatcherTimer _watcher = new();
    private readonly object _logGate = new();

    public MainWindow()
    {
        InitializeComponent();

        SliderConnections.ValueChanged += (_, _) =>
            TxtConnections.Text = ((int)SliderConnections.Value).ToString();

        // 每 2 秒检查一次 PCL CE 是否启动/升级
        _watcher.Interval = TimeSpan.FromSeconds(2);
        _watcher.Tick += OnWatchTick;
        _watcher.Start();

        Loaded += (_, _) => { RefreshProcess(); StartIfAuto(); };
        StateChanged += (_, _) =>
        {
            if (WindowState == WindowState.Minimized && ChkStartMinimized.IsChecked == true)
                Hide();
        };
    }

    // ———————————————————————————————————————————————
    // 事件
    // ———————————————————————————————————————————————

    private void OnRefresh(object sender, RoutedEventArgs e) => RefreshProcess();

    private void OnInject(object sender, RoutedEventArgs e) => TryInject(manual: true);

    private void OnOpenLog(object sender, RoutedEventArgs e)
    {
        var logPath = LogFilePath;
        if (File.Exists(logPath))
            Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true });
        else
            AppendLog("日志文件还不存在（尚未成功注入）");
    }

    private void OnExit(object sender, RoutedEventArgs e)
    {
        // 退出注入器不影响 PCL CE —— 补丁在 PCL CE 进程内，重启 PCL CE 即还原
        Application.Current.Shutdown();
    }

    /// <summary>
    /// 定时检查：PCL CE 是否启动、是否升级。
    /// </summary>
    private void OnWatchTick(object? sender, EventArgs e)
    {
        var proc = FindPclCe();

        if (proc == null)
        {
            TxtProcess.Text = "未检测到 PCL CE";
            TxtProcess.Foreground = System.Windows.Media.Brushes.Gray;
            if (_lastInjectedPid != -1)
            {
                AppendLog("PCL CE 已退出，补丁随之失效（内存补丁，无需手动还原）");
                _lastInjectedPid = -1;
            }
            return;
        }

        TxtProcess.Text = $"{proc.ProcessName}.exe (PID {proc.Id})";
        TxtProcess.Foreground = System.Windows.Media.Brushes.LightGreen;

        // 版本变化检测：可执行文件路径或版本号变了，说明升级过
        if (_baselineVersion != null && ChkAutoRevert.IsChecked == true)
        {
            var currentPath = SafeMainModulePath(proc);
            var currentVersion = SafeFileVersion(proc);

            if (currentPath != null && _baselinePath != null && !currentPath.Equals(_baselinePath, StringComparison.OrdinalIgnoreCase))
            {
                AppendLog($"检测到 PCL CE 可执行文件变化：{_baselinePath} → {currentPath}");
                RevertAndStop("PCL CE 已更新/迁移");
                return;
            }
            if (currentVersion != null && !currentVersion.Equals(_baselineVersion, StringComparison.OrdinalIgnoreCase))
            {
                AppendLog($"检测到 PCL CE 版本变化：{_baselineVersion} → {currentVersion}");
                RevertAndStop("PCL CE 已升级");
                return;
            }
        }

        // 自动注入：新启动的 PCL CE
        if (ChkAuto.IsChecked == true && proc.Id != _lastInjectedPid)
        {
            AppendLog($"检测到 PCL CE 启动 (PID {proc.Id})，自动注入…");
            TryInject(manual: false);
        }
    }

    // ———————————————————————————————————————————————
    // 逻辑
    // ———————————————————————————————————————————————

    private void RefreshProcess()
    {
        var proc = FindPclCe();
        if (proc == null)
        {
            TxtProcess.Text = "未检测到 PCL CE";
            TxtProcess.Foreground = System.Windows.Media.Brushes.Gray;
            TxtStatus.Text = "请先启动 PCL CE";
            return;
        }

        TxtProcess.Text = $"{proc.ProcessName}.exe (PID {proc.Id})";
        TxtProcess.Foreground = System.Windows.Media.Brushes.LightGreen;

        var v = SafeFileVersion(proc);
        TxtStatus.Text = v != null ? $"PCL CE 版本 {v}" : "PCL CE 运行中";

        if (_baselineVersion == null)
        {
            _baselineVersion = v;
            _baselinePath = SafeMainModulePath(proc);
        }
    }

    private void TryInject(bool manual)
    {
        var proc = FindPclCe();
        if (proc == null)
        {
            AppendLog("注入失败：未找到 PCL CE 进程");
            return;
        }

        var dllPath = Path.Combine(AppContext.BaseDirectory, "PclHook.dll");
        if (!File.Exists(dllPath))
        {
            AppendLog($"注入失败：找不到 {dllPath}");
            return;
        }
        if (!File.Exists(Path.Combine(AppContext.BaseDirectory, "0Harmony.dll")))
        {
            AppendLog("注入失败：0Harmony.dll 不在同一目录（PclHook.dll 依赖它）");
            return;
        }

        var connections = (int)SliderConnections.Value;
        TxtStatus.Text = "正在注入…";

        try
        {
            var result = Injector.ClrInjector.Inject(proc.Id, dllPath, null, connections);
            if (result.Success)
            {
                _lastInjectedPid = proc.Id;
                _baselineVersion = SafeFileVersion(proc) ?? _baselineVersion;
                _baselinePath = SafeMainModulePath(proc) ?? _baselinePath;
                AppendLog($"✓ 注入成功 (PID {proc.Id})，目标连接数 {connections}");
                if (result.LogPath != null) AppendLog($"  日志: {result.LogPath}");
                TxtStatus.Text = "已注入，PCL CE 重启后自动失效";
            }
            else
            {
                AppendLog($"✗ 注入失败: {result.Message}");
                TxtStatus.Text = "注入失败，详见日志";
            }
        }
        catch (Exception ex)
        {
            AppendLog($"✗ 注入异常: {ex.Message}");
            TxtStatus.Text = "注入异常";
        }
    }

    /// <summary>
    /// 检测到升级时：停止自动注入并还原。
    /// 由于补丁在 PCL CE 进程内且其已升级（进程会重启），
    /// 新进程天然不带补丁；这里额外清理记录并停止自动注入，
    /// 避免对新版本反复注入导致不稳定。
    /// </summary>
    private void RevertAndStop(string reason)
    {
        AppendLog($"{reason} → 已停止自动注入并还原为原版行为");
        ChkAuto.IsChecked = false;
        _lastInjectedPid = -1;
        _baselineVersion = null;
        _baselinePath = null;
        TxtStatus.Text = $"{reason}，已还原（可手动重新开启自动注入）";
    }

    private void StartIfAuto()
    {
        if (ChkStartMinimized.IsChecked == true)
        {
            WindowState = WindowState.Minimized;
            Hide();
        }
    }

    private static Process? FindPclCe()
    {
        foreach (var n in new[] { "MultiMc", "Plain Craft Launcher 2" })
        {
            var procs = Process.GetProcessesByName(n);
            if (procs.Length > 0) return procs[0];
        }
        return null;
    }

    private static string? SafeMainModulePath(Process p)
    {
        try { return p.MainModule?.FileName; }
        catch { return null; }
    }

    private static string? SafeFileVersion(Process p)
    {
        try
        {
            var path = p.MainModule?.FileName;
            if (path == null || !File.Exists(path)) return null;
            return FileVersionInfo.GetVersionInfo(path).FileVersion;
        }
        catch { return null; }
    }

    private static string LogFilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "PCL", "mcboost-hook.log");

    private void AppendLog(string line)
    {
        Dispatcher.Invoke(() =>
        {
            lock (_logGate)
            {
                TxtLog.Text += $"[{DateTime.Now:HH:mm:ss}] {line}\n";
            }
        });
    }
}
