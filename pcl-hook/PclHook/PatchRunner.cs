using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Threading;
using HarmonyLib;

namespace McBoost.PclHook
{
    /// <summary>
    /// 实际的补丁逻辑。
    ///
    /// <para><b>关键点一：目标是 async 状态机</b></para>
    /// PCL CE 的 <c>AdaptiveRangeDownloader.DownloadAsync</c> 是 <c>private async Task</c>。
    /// C# 编译器会把真正的 IL 放进生成的嵌套类型（&lt;&gt;d__X）的
    /// <c>MoveNext()</c> 里，而 <c>DownloadAsync</c> 本身只是个壳。
    /// 所以必须用 Harmony 的 <c>MethodType.Async</c> 打到 MoveNext，
    /// 直接 patch DownloadAsync 永远匹配不到 Math.Clamp。
    ///
    /// <para><b>关键点二：等目标程序集加载</b></para>
    /// 启动钩子在 Main() 之前执行，此时 PCL CE 自己的程序集还没加载。
    /// 所以这里轮询等待，直到能找到 AdaptiveRangeDownloader 再 patch。
    ///
    /// <para><b>关键点三：只改一处常量</b></para>
    /// 要改的是 <c>Math.Clamp(NetTaskSingleFileConnectionLimit, 1, 8)</c>
    /// 里的上界 8。同一方法里还有 SlowCheckSeconds=8 等语义不同的常量，
    /// 所以以 Clamp 调用为锚点向前回溯精确匹配，绝不盲替换。
    /// </summary>
    internal static class PatchRunner
    {
        internal static int TargetConnections =
            ReadIntFromEnv("MCBOOST_PCL_CONNECTIONS") ?? 24;

        private const int MaxWaitSeconds = 120;

        internal static void RunUntilApplied()
        {
            Diag.Log($"patcher start, target connections = {TargetConnections}");

            Type? downloaderType = null;
            var deadline = DateTime.UtcNow.AddSeconds(MaxWaitSeconds);
            var spinner = 0;

            while (DateTime.UtcNow < deadline)
            {
                downloaderType = FindType("PCL.Network.Downloader.AdaptiveRangeDownloader");
                if (downloaderType != null) break;

                // 每 ~3 秒记一次，避免日志刷屏
                if (++spinner % 30 == 0)
                {
                    var asmCount = AppDomain.CurrentDomain.GetAssemblies().Length;
                    Diag.Log($"waiting for AdaptiveRangeDownloader... (assemblies={asmCount})");
                }
                Thread.Sleep(100);
            }

            if (downloaderType == null)
            {
                Diag.Log($"FAIL: AdaptiveRangeDownloader not found after {MaxWaitSeconds}s. " +
                         "已加载程序集: " + LoadedAssemblyNames());
                return;
            }

            Diag.Log($"found type: {downloaderType.FullName} in {downloaderType.Assembly.GetName().Name}");

            var downloadAsync = downloaderType.GetMethod(
                "DownloadAsync",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

            if (downloadAsync == null)
            {
                Diag.Log("FAIL: DownloadAsync not found. 方法列表: " +
                         string.Join(", ", downloaderType.GetMethods(
                             BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                             .Select(m => m.Name).Distinct()));
                return;
            }

            // 抬高属性值（兜底，不依赖 IL 改写也能改善部分路径）
            TryRaiseProperty();

            var harmony = new Harmony("com.mcboost.pclhook");
            var transpiler = new HarmonyMethod(
                typeof(PatchRunner).GetMethod(nameof(Transpile),
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!);

            var patched = false;

            // 依次尝试几种目标，全部失败才算失败
            foreach (var attempt in new[]
                     {
                         (name: "Async(MoveNext)", type: MethodType.Async),
                         (name: "Normal(DownloadAsync本体)", type: MethodType.Normal),
                     })
            {
                try
                {
                    harmony.Patch(downloadAsync, transpiler: transpiler, methodType: attempt.type);
                    patched = true;
                    Diag.Log($"OK: patch 已应用到 {attempt.name}");
                    break;
                }
                catch (Exception ex)
                {
                    Diag.Log($"patch 失败 [{attempt.name}]: {ex.GetType().Name}: {ex.Message}");
                }
            }

            if (!patched)
            {
                Diag.Log("FAIL: 所有 patch 方式均失败");
                return;
            }

            Diag.Log($"DONE: PCL CE 单文件连接上限已改为 {TargetConnections}（原为 8）");
        }

        /// <summary>
        /// 尝试直接把静态属性改成目标值。对 const 内联无效，但能覆盖其它代码路径。
        /// </summary>
        private static void TryRaiseProperty()
        {
            try
            {
                var modNet = FindType("PCL.Network.ModNet");
                if (modNet == null) { Diag.Log("ModNet 未找到（跳过属性设置）"); return; }

                var prop = modNet.GetProperty("NetTaskSingleFileConnectionLimit",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                if (prop?.CanWrite == true)
                {
                    prop.SetValue(null, TargetConnections);
                    Diag.Log($"ModNet.NetTaskSingleFileConnectionLimit 设为 {TargetConnections}");
                }
                else
                {
                    Diag.Log("NetTaskSingleFileConnectionLimit 不可写或不存在");
                }
            }
            catch (Exception ex)
            {
                Diag.Log("设置属性失败: " + ex.Message);
            }
        }

        /// <summary>
        /// Transpiler：把 <c>Math.Clamp(x, 1, 8)</c> 的上界 8 换成目标值。
        /// </summary>
        public static IEnumerable<CodeInstruction> Transpile(IEnumerable<CodeInstruction> instructions)
        {
            var list = instructions.ToList();
            var replaced = 0;

            for (var i = 0; i < list.Count; i++)
            {
                if (!IsClampCall(list[i])) continue;
                if (i < 3) continue;

                var third = list[i - 1];
                var second = list[i - 2];
                var first = list[i - 3];

                if (!IsConst(second, 1)) continue;
                if (!IsConst(third, 8)) continue;
                if (!ReadsConnectionLimit(first)) continue;

                third.operand = TargetConnections;
                replaced++;
            }

            if (replaced > 0)
                Diag.Log($"transpiler: 替换 {replaced} 处 Clamp 上界 -> {TargetConnections}");
            else
                Diag.Log("transpiler: 未匹配到 Clamp(x,1,8) 模式（IL 可能已变）");

            return list;
        }

        private static bool IsConst(CodeInstruction ins, int value)
        {
            if (ins.opcode != OpCodes.Ldc_I4 && ins.opcode != OpCodes.Ldc_I4_S) return false;
            return ins.operand is int v && v == value;
        }

        private static bool IsClampCall(CodeInstruction ins)
        {
            if (ins.opcode != OpCodes.Call && ins.opcode != OpCodes.Callvirt) return false;
            if (ins.operand is not MethodInfo m) return false;
            return m.Name == "Clamp"
                   && m.DeclaringType != null
                   && (m.DeclaringType.FullName == "System.Math" || m.DeclaringType.Name == "Math");
        }

        private static bool ReadsConnectionLimit(CodeInstruction ins)
        {
            if (ins.opcode != OpCodes.Call && ins.opcode != OpCodes.Callvirt && ins.opcode != OpCodes.Ldsfld)
                return false;
            if (ins.operand is not MemberInfo m) return false;
            return m.Name.Contains("NetTaskSingleFileConnectionLimit");
        }

        private static Type? FindType(string fullName)
        {
            var direct = Type.GetType(fullName);
            if (direct != null) return direct;

            var shortName = fullName.Split('.').Last();

            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException) { continue; }
                catch { continue; }

                var exact = types.FirstOrDefault(t => t.FullName == fullName);
                if (exact != null) return exact;

                var byShort = types.FirstOrDefault(t => t.Name == shortName);
                if (byShort != null) return byShort;
            }
            return null;
        }

        private static string LoadedAssemblyNames()
        {
            try
            {
                return string.Join(", ", AppDomain.CurrentDomain.GetAssemblies()
                    .Select(a => { try { return a.GetName().Name; } catch { return "?"; } })
                    .Distinct().Take(40));
            }
            catch { return "?"; }
        }

        private static int? ReadIntFromEnv(string name)
        {
            var raw = Environment.GetEnvironmentVariable(name);
            return int.TryParse(raw, out var v) && v > 0 ? v : null;
        }
    }
}
