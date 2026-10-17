using System;
using System.IO;
using System.Text;

namespace McBoost.PclHook
{
    /// <summary>
    /// 诊断日志。
    ///
    /// 设计要点：**必须保证第一条日志一定能写出去**。
    /// 之前失败的核心症状就是"什么都没发生、连日志都没有"，
    /// 无法判断钩子到底有没有被加载。所以这里多路径写入：
    ///   1. %APPDATA%\PCL\mcboost-hook.log（主路径）
    ///   2. %TEMP%\mcboost-hook.log（备用路径，防止 AppData 无权限）
    ///   3. stderr（如果被重定向能看到）
    /// 任一成功即可。
    /// </summary>
    internal static class Diag
    {
        private static readonly object Gate = new();
        private static bool _initialized;

        internal static string PrimaryLogPath
        {
            get
            {
                var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                return Path.Combine(appData, "PCL", "mcboost-hook.log");
            }
        }

        internal static string FallbackLogPath =>
            Path.Combine(Path.GetTempPath(), "mcboost-hook.log");

        internal static void Log(string message)
        {
            var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [mcboost] {message}";
            if (!_initialized)
            {
                _initialized = true;
                line = Environment.NewLine +
                       "========== mcboost hook session " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ==========" + Environment.NewLine +
                       line;
            }

            lock (Gate)
            {
                var wrote = false;
                try
                {
                    var dir = Path.GetDirectoryName(PrimaryLogPath);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    File.AppendAllText(PrimaryLogPath, line + Environment.NewLine, Encoding.UTF8);
                    wrote = true;
                }
                catch { /* 主路径失败，走备用 */ }

                if (!wrote)
                {
                    try
                    {
                        File.AppendAllText(FallbackLogPath, line + Environment.NewLine, Encoding.UTF8);
                        wrote = true;
                    }
                    catch { /* 忽略 */ }
                }

                try { Console.Error.WriteLine(line); } catch { }
            }
        }
    }
}
