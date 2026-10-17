using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using HarmonyLib;

namespace McBoost.PclHook
{
    /// <summary>
    /// 补丁执行器（针对老版 PCL2 / PCL CE 下载引擎）。
    ///
    /// 依据用户实测诊断报告确定：
    ///   PCL.Network.ModNet 的静态属性 NetTaskThreadLimit = 16
    ///   且存在 PCL.ModSetup.ToolDownloadThread（对应旧版设置项）
    ///   → 这是老版 PCL2 的下载引擎，没有 AdaptiveRangeDownloader
    ///
    /// 老引擎的关键限制（来自官方 PCL2 的 ModNet.vb）：
    /// <code>
    /// Public ReadOnly Property NetTaskThreadLimit As Integer
    ///     Get
    ///         Return Settings.Get(Of Integer)("ToolDownloadThread") + 1
    ///     End Get
    /// End Property
    ///
    /// ' TryBeginThread 里：
    /// If NetTaskThreadCount >= NetTaskThreadLimit ... Then Return Nothing
    /// </code>
    /// NetTaskThreadCount 是模块级字段 —— 也就是说这是**全局**连接上限，
    /// 整合包一次下 100 多个文件时，全部挤在这十几条连接里。
    ///
    /// 补法：给 getter 挂 Postfix，把返回值抬到目标值。
    /// 不依赖 IL 结构、不依赖是否可写，最稳。
    /// </summary>
    internal static class PatchRunner
    {
        /// <summary>目标全局连接上限。</summary>
        internal static int TargetThreads =
            ReadIntFromEnv("MCBOOST_PCL_THREADS") ?? 64;

        /// <summary>原始值（补丁前读到的），仅用于日志对比。</summary>
        private static int _originalLimit = -1;

        private const int MaxWaitSeconds = 60;

        internal static void RunUntilApplied()
        {
            Diag.Log($"patcher start (v3.4, 老引擎模式), target threads = {TargetThreads}");

            var modNet = WaitForType("PCL.Network.ModNet");
            if (modNet == null)
            {
                Diag.Log("FAIL: 找不到 PCL.Network.ModNet，无法定位连接上限");
                return;
            }

            var prop = modNet.GetProperty("NetTaskThreadLimit",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);

            if (prop == null)
            {
                Diag.Log("FAIL: ModNet 上找不到 NetTaskThreadLimit 属性");
                DumpModNetMembers(modNet);
                return;
            }

            // 记录原始值
            try { _originalLimit = Convert.ToInt32(prop.GetValue(null)); }
            catch { _originalLimit = -1; }
            Diag.Log($"原始 NetTaskThreadLimit = {_originalLimit}");

            // 1. 若可写，直接设一次（覆盖走字段的路径）
            if (prop.CanWrite)
            {
                try
                {
                    prop.SetValue(null, TargetThreads);
                    Diag.Log($"已直接设置 NetTaskThreadLimit = {TargetThreads}");
                }
                catch (Exception ex)
                {
                    Diag.Log($"直接设置失败（预期，可能是只读计算属性）: {ex.Message}");
                }
            }

            // 2. 关键：给 getter 挂 Postfix
            //    只读计算属性每次都重新读设置项，所以必须改 getter 返回值。
            var getter = prop.GetGetMethod(nonPublic: true);
            if (getter == null)
            {
                Diag.Log("FAIL: 取不到 NetTaskThreadLimit 的 getter");
                return;
            }

            var harmony = new Harmony("com.mcboost.pclhook");
            var postfix = new HarmonyMethod(
                typeof(PatchRunner).GetMethod(nameof(ThreadLimitPostfix),
                    BindingFlags.Static | BindingFlags.Public)!);

            try
            {
                harmony.Patch(getter, postfix: postfix);
                // 验证
                var now = Convert.ToInt32(prop.GetValue(null));
                if (now >= TargetThreads)
                {
                    Diag.Log($"DONE: NetTaskThreadLimit 已从 {_originalLimit} 提升到 {now}");
                    Diag.Log("现在 PCL 的全局下载连接上限已提高，重新开始下载整合包即可生效。");
                }
                else
                {
                    Diag.Log($"WARN: patch 后读取仍为 {now}（期望 >= {TargetThreads}），可能属性缓存了值");
                }
            }
            catch (Exception ex)
            {
                Diag.Log($"FAIL: patch getter 失败: {ex.GetType().Name}: {ex.Message}");
                DumpModNetMembers(modNet);
            }
        }

        /// <summary>
        /// 把 NetTaskThreadLimit 的返回值抬到目标值。
        /// 取 max(原值, 目标值)，绝不降低原有配置。
        /// </summary>
        public static void ThreadLimitPostfix(ref int __result)
        {
            if (__result < TargetThreads)
            {
                __result = TargetThreads;
            }
        }

        /// <summary>等待某个类型出现（PCL 程序集可能晚于钩子加载）。</summary>
        private static Type? WaitForType(string fullName)
        {
            var deadline = DateTime.UtcNow.AddSeconds(MaxWaitSeconds);
            while (DateTime.UtcNow < deadline)
            {
                var t = FindType(fullName);
                if (t != null) return t;
                Thread.Sleep(200);
            }
            return null;
        }

        /// <summary>
        /// 在所有已加载程序集里找类型。
        /// 必须用 ReflectionTypeLoadException.Types 的部分结果 ——
        /// PCL 主程序集常因缺可选依赖抛这个异常，直接 skip 会漏掉目标类型。
        /// </summary>
        private static Type? FindType(string fullName)
        {
            var direct = Type.GetType(fullName);
            if (direct != null) return direct;

            var shortName = fullName.Split('.').Last();

            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type?[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types; }
                catch { continue; }

                var exact = types.FirstOrDefault(t => t != null && t.FullName == fullName);
                if (exact != null) return exact;

                var byShort = types.FirstOrDefault(t => t != null && t.Name == shortName);
                if (byShort != null) return byShort;
            }
            return null;
        }

        /// <summary>属性找不到时，把 ModNet 的成员列进日志，便于定位。</summary>
        private static void DumpModNetMembers(Type modNet)
        {
            try
            {
                Diag.Log("--- ModNet 成员 ---");
                foreach (var p in modNet.GetProperties(BindingFlags.Static
                             | BindingFlags.Public | BindingFlags.NonPublic))
                {
                    Diag.Log($"  prop {p.Name} : {p.PropertyType.Name} (writable={p.CanWrite})");
                }
                foreach (var f in modNet.GetFields(BindingFlags.Static
                             | BindingFlags.Public | BindingFlags.NonPublic))
                {
                    Diag.Log($"  field {f.Name} : {f.FieldType.Name}");
                }
                Diag.Log("-------------------");
            }
            catch (Exception ex)
            {
                Diag.Log("列成员失败: " + ex.Message);
            }
        }

        private static int? ReadIntFromEnv(string name)
        {
            var raw = Environment.GetEnvironmentVariable(name);
            return int.TryParse(raw, out var v) && v > 0 ? v : null;
        }
    }
}
