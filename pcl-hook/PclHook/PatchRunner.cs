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
    /// 补丁执行器 —— 针对 PCL CE 2.15.1 的实际下载实现。
    ///
    /// 依据：拉取 v2.15.1-beta.1 tag 源码确认，该版本**没有** AdaptiveRangeDownloader，
    /// 下载走 PCL.Network.FileDownloader + Downloader NuGet 包。关键代码：
    /// <code>
    /// // FileDownloader.DownloadSingleAsync
    /// var perFileThreadLimit = enableParallelChunks ? Math.Max(1, ModNet.NetTaskThreadLimit) : 1;
    /// var chunkCount = Math.Min(perFileThreadLimit, 4);   // ← 每文件最多 4 个分片
    /// var configuration = new DownloadConfiguration {
    ///     ChunkCount = chunkCount,
    ///     ParallelCount = chunkCount,
    ///     ParallelDownload = chunkCount > 1,
    ///     MinimumSizeOfChunking = 1024 * 1024L,          // 小于 1MB 不分片
    ///     ...
    /// };
    /// </code>
    ///
    /// 所以真正的瓶颈是那个写死的 <c>4</c>：无论把 NetTaskThreadLimit 调到多少，
    /// Math.Min 都会把它压回 4，**每个文件只有 4 条连接**。
    ///
    /// 本补丁做两件事：
    ///   1. 把 ModNet.NetTaskThreadLimit 直接设高（它是普通可写静态属性）
    ///      这样 Math.Min 的输入不会成为新的瓶颈
    ///   2. 用 Transpiler 把 DownloadSingleAsync 里 Math.Min(?, 4) 的 4 换成目标分片数
    ///      只改这一个常量，其余逻辑（分块、断点、进度、重试）全部沿用 PCL 自己的
    /// </summary>
    internal static class PatchRunner
    {
        /// <summary>目标每文件分片（连接）数。4 是原版上限。</summary>
        internal static int TargetChunks =
            ReadIntFromEnv("MCBOOST_PCL_CHUNKS") ?? 8;

        /// <summary>原版硬编码的分片上限。</summary>
        private const int OriginalChunkCap = 4;

        private const int MaxWaitSeconds = 60;

        internal static void RunUntilApplied()
        {
            Diag.Log($"patcher start (v3.5, 目标每文件 {TargetChunks} 分片)");

            var modNet = WaitForType("PCL.Network.ModNet");
            if (modNet != null) RaiseThreadLimit(modNet);
            else Diag.Log("WARN: 找不到 PCL.Network.ModNet（不影响分片补丁）");

            var downloader = WaitForType("PCL.Network.FileDownloader");
            if (downloader == null)
            {
                Diag.Log("FAIL: 找不到 PCL.Network.FileDownloader，无法定位分片上限");
                return;
            }

            var target = downloader.GetMethod("DownloadSingleAsync",
                BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);

            if (target == null)
            {
                Diag.Log("FAIL: 找不到 FileDownloader.DownloadSingleAsync");
                Diag.Log("现有方法: " + string.Join(", ",
                    downloader.GetMethods(BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)
                        .Select(m => m.Name).Distinct()));
                return;
            }

            var harmony = new Harmony("com.mcboost.pclhook");
            var transpiler = new HarmonyMethod(
                typeof(PatchRunner).GetMethod(nameof(Transpile),
                    BindingFlags.Static | BindingFlags.Public)!);

            try
            {
                harmony.Patch(target, transpiler: transpiler);
                Diag.Log($"DONE: 已 patch FileDownloader.DownloadSingleAsync，分片上限 {OriginalChunkCap} -> {TargetChunks}");
                Diag.Log("现在重新开始下载整合包即可生效（每个文件最多开 " + TargetChunks + " 条连接）。");
            }
            catch (Exception ex)
            {
                Diag.Log($"FAIL: patch 失败: {ex.GetType().Name}: {ex.Message}");
            }
        }

        /// <summary>
        /// 抬高 ModNet.NetTaskThreadLimit。
        /// v2.15.1 里它是 <c>public static int NetTaskThreadLimit { get; set; } = 16;</c>
        /// 普通可写属性，直接赋值即可。
        /// 设成 分片数 × 4，保证 Math.Min 的输入不成为新瓶颈。
        /// </summary>
        private static void RaiseThreadLimit(Type modNet)
        {
            try
            {
                var prop = modNet.GetProperty("NetTaskThreadLimit",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                if (prop == null)
                {
                    Diag.Log("WARN: ModNet 上没有 NetTaskThreadLimit");
                    return;
                }

                var before = prop.GetValue(null);
                var want = Math.Max(TargetChunks * 4, 64);
                prop.SetValue(null, want);
                var after = prop.GetValue(null);
                Diag.Log($"NetTaskThreadLimit: {before} -> {after}");
            }
            catch (Exception ex)
            {
                Diag.Log("WARN: 设置 NetTaskThreadLimit 失败: " + ex.Message);
            }
        }

        /// <summary>
        /// 把 <c>Math.Min(x, 4)</c> 的上界 4 换成目标值。
        ///
        /// 该写法位于 DownloadSingleAsync 中：
        ///   ldc.i4.4 ; call Math::Min(int32,int32)
        /// 只匹配「前一指令是常量 4、且当前是 Math.Min」这一处，
        /// 不会碰同方法里 MinimumSizeOfChunking 等其它常量。
        /// </summary>
        public static IEnumerable<CodeInstruction> Transpile(IEnumerable<CodeInstruction> instructions)
        {
            var list = instructions.ToList();
            var replaced = 0;

            for (var i = 1; i < list.Count; i++)
            {
                if (!IsMathCall(list[i], "Min")) continue;
                if (!IsConst(list[i - 1], OriginalChunkCap)) continue;

                SetConst(list[i - 1], TargetChunks);
                replaced++;
            }

            if (replaced > 0)
                Diag.Log($"transpiler: 已替换 {replaced} 处 Math.Min(?, {OriginalChunkCap}) -> {TargetChunks}");
            else
                Diag.Log("transpiler: 未匹配到 Math.Min(?, 4)，IL 结构可能变化");

            return list;
        }

        /// <summary>
        /// 判断是否为指定整数常量。
        ///
        /// 小常量用专用 opcode，没有 operand：
        ///   -1 → Ldc_I4_M1，0..8 → Ldc_I4_0 … Ldc_I4_8
        /// -128..127 用 Ldc_I4_S，operand 是 <b>sbyte</b>
        /// 其它用 Ldc_I4，operand 是 int
        /// </summary>
        private static bool IsConst(CodeInstruction ins, int value)
        {
            if (ins.opcode == OpCodes.Ldc_I4_M1) return value == -1;
            if (ins.opcode == OpCodes.Ldc_I4_0) return value == 0;
            if (ins.opcode == OpCodes.Ldc_I4_1) return value == 1;
            if (ins.opcode == OpCodes.Ldc_I4_2) return value == 2;
            if (ins.opcode == OpCodes.Ldc_I4_3) return value == 3;
            if (ins.opcode == OpCodes.Ldc_I4_4) return value == 4;
            if (ins.opcode == OpCodes.Ldc_I4_5) return value == 5;
            if (ins.opcode == OpCodes.Ldc_I4_6) return value == 6;
            if (ins.opcode == OpCodes.Ldc_I4_7) return value == 7;
            if (ins.opcode == OpCodes.Ldc_I4_8) return value == 8;
            if (ins.opcode == OpCodes.Ldc_I4_S) return ins.operand is sbyte sb && sb == value;
            if (ins.opcode == OpCodes.Ldc_I4) return ins.operand is int v && v == value;
            return false;
        }

        /// <summary>改写一条指令为指定整数常量（opcode 与 operand 一起改）。</summary>
        private static void SetConst(CodeInstruction ins, int value)
        {
            if (value >= -128 && value <= 127)
            {
                ins.opcode = OpCodes.Ldc_I4_S;
                ins.operand = (sbyte)value;
            }
            else
            {
                ins.opcode = OpCodes.Ldc_I4;
                ins.operand = value;
            }
        }

        private static bool IsMathCall(CodeInstruction ins, string methodName)
        {
            if (ins.opcode != OpCodes.Call && ins.opcode != OpCodes.Callvirt) return false;
            if (ins.operand is not MethodInfo m) return false;
            return m.Name == methodName && m.DeclaringType != null
                   && (m.DeclaringType.FullName == "System.Math" || m.DeclaringType.Name == "Math");
        }

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

        private static int? ReadIntFromEnv(string name)
        {
            var raw = Environment.GetEnvironmentVariable(name);
            return int.TryParse(raw, out var v) && v > 0 ? v : null;
        }
    }
}
