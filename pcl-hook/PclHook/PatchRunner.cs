using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using System.Threading;
using HarmonyLib;

namespace McBoost.PclHook
{
    /// <summary>
    /// 补丁执行器。
    ///
    /// 目标（PCL CE 2.15.1）：PCL.Network.FileDownloader.DownloadSingleAsync
    /// <code>
    /// var perFileThreadLimit = enableParallelChunks ? Math.Max(1, ModNet.NetTaskThreadLimit) : 1;
    /// var chunkCount = Math.Min(perFileThreadLimit, 4);   // ← 每文件最多 4 个分片
    /// </code>
    ///
    /// 两个必须记住的坑：
    ///
    /// 坑一：<b>DownloadSingleAsync 是 async 方法</b>。
    /// 方法体全在编译器生成的状态机（&lt;DownloadSingleAsync&gt;d__5）的 MoveNext() 里，
    /// DownloadSingleAsync 本身只是个"创建并启动状态机"的壳。
    /// 直接 patch 它对壳的 IL 动手，transpiler 永远看不到 Math.Min。
    /// 必须用 AsyncStateMachineAttribute 定位 MoveNext 再 patch。
    ///
    /// 坑二：<b>Harmony 的 transpiler 是 JIT 时才执行的</b>。
    /// harmony.Patch() 返回成功只代表"补丁登记成功"，不代表常量被替换了。
    /// 之前的版本据此就打 DONE，导致"提示成功但毫无效果"。
    /// 现在改为：patch 后强制 PrepareMethod 触发 JIT，再检查 transpiler 实际替换了几处，
    /// 只有 &gt; 0 才算成功 —— 否则明确报 FAIL。
    /// </summary>
    internal static class PatchRunner
    {
        /// <summary>目标每文件分片（连接）数。原版硬编码 4。</summary>
        internal static int TargetChunks =
            ReadIntFromEnv("MCBOOST_PCL_CHUNKS") ?? 8;

        private const int OriginalChunkCap = 4;
        private const int MaxWaitSeconds = 60;

        /// <summary>transpiler 实际替换的处数。用于诚实的成功判定。</summary>
        private static int _replaced;

        internal static void RunUntilApplied()
        {
            Diag.Log($"patcher start (v3.7, 目标每文件 {TargetChunks} 分片)");
            LogHarmonyInfo();

            var modNet = WaitForType("PCL.Network.ModNet");
            if (modNet != null) RaiseThreadLimit(modNet);

            var downloader = WaitForType("PCL.Network.FileDownloader");
            if (downloader == null)
            {
                Diag.Log("FAIL: 找不到 PCL.Network.FileDownloader");
                return;
            }

            var stub = downloader.GetMethod("DownloadSingleAsync",
                BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            if (stub == null)
            {
                Diag.Log("FAIL: 找不到 FileDownloader.DownloadSingleAsync");
                Diag.Log("现有方法: " + string.Join(", ",
                    downloader.GetMethods(BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)
                        .Select(m => m.Name).Distinct()));
                return;
            }

            // —— 关键：定位真正的 IL 宿主 ——
            var patchTarget = ResolveIlHost(stub, out var where);
            Diag.Log($"补丁目标: {where}");

            var harmony = new Harmony("com.mcboost.pclhook");
            var transpiler = new HarmonyMethod(
                typeof(PatchRunner).GetMethod(nameof(Transpile),
                    BindingFlags.Static | BindingFlags.Public)!);

            _replaced = 0;
            try
            {
                harmony.Patch(patchTarget, transpiler: transpiler);
            }
            catch (Exception ex)
            {
                Diag.Log("FAIL: Harmony patch 调用失败：");
                Diag.Log(DescribeException(ex));
                return;
            }

            // —— 强制 JIT，让 transpiler 立即执行，才能验证是否真的改到了 ——
            var jitted = TryPrepareMethod(patchTarget);
            Thread.Sleep(120);

            if (_replaced > 0)
            {
                Diag.Log($"DONE: 已替换 {_replaced} 处 Math.Min(?, {OriginalChunkCap}) -> {TargetChunks}");
                Diag.Log($"每文件下载分片数上限 {OriginalChunkCap} -> {TargetChunks}，重新开始下载即可生效。");
            }
            else
            {
                Diag.Log(jitted
                    ? $"FAIL: transpiler 执行了但替换 0 处 —— 该方法里没有 Math.Min(?, {OriginalChunkCap})"
                    : "FAIL: 无法强制 JIT，无法确认 transpiler 结果（方法可能尚未被调用）");
                Diag.Log("这意味着本次补丁**没有生效**，下载速度不会变化。");
                DumpIlHints(patchTarget);
            }
        }

        /// <summary>
        /// 找到真正承载 IL 的方法。
        /// async 方法的逻辑在状态机的 MoveNext() 里，必须通过
        /// AsyncStateMachineAttribute 拿过去；否则只改到壳。
        /// </summary>
        private static MethodBase ResolveIlHost(MethodInfo stub, out string description)
        {
            try
            {
                var attr = stub.GetCustomAttribute<AsyncStateMachineAttribute>();
                if (attr?.StateMachineType != null)
                {
                    var moveNext = attr.StateMachineType.GetMethod("MoveNext",
                        BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    if (moveNext != null)
                    {
                        description = $"{attr.StateMachineType.FullName}.MoveNext()（async 状态机）";
                        return moveNext;
                    }
                    description = $"{stub.DeclaringType?.Name}.{stub.Name}（状态机存在但找不到 MoveNext）";
                    return stub;
                }
            }
            catch (Exception ex)
            {
                Diag.Log("解析状态机失败: " + ex.Message);
            }

            description = $"{stub.DeclaringType?.Name}.{stub.Name}（非 async，直接 patch 本体）";
            return stub;
        }

        /// <summary>
        /// 强制目标方法完成 JIT —— 这样 Harmony 的 transpiler 会立刻执行，
        /// 我们才能在 patch 之后马上检查它到底改到了没有。
        /// </summary>
        private static bool TryPrepareMethod(MethodBase method)
        {
            try
            {
                var handle = method.MethodHandle;
                if (handle == IntPtr.Zero) return false;
                RuntimeHelpers.PrepareMethod(handle);
                return true;
            }
            catch (Exception ex)
            {
                Diag.Log("PrepareMethod 失败: " + ex.Message);
                return false;
            }
        }

        /// <summary>
        /// 替换 0 处时，把目标方法里所有 Math.Min 调用及其前置常量打进日志，
        /// 便于判断 IL 结构究竟长什么样（不用再猜）。
        /// </summary>
        private static void DumpIlHints(MethodBase method)
        {
            try
            {
                var il = method.GetMethodBody()?.GetILAsByteArray();
                Diag.Log($"目标方法 IL 长度: {il?.Length ?? 0} 字节");
                if (il == null) return;

                // 粗扫 ldc.i4.4(0x1A) 出现次数，帮助判断常量是否被内联在别处
                var cnt4 = il.Count(b => b == 0x1A);
                var cntCall = il.Count(b => b == 0x28 || b == 0x6F);
                Diag.Log($"IL 中 ldc.i4.4 字节出现 {cnt4} 次（含误报），call 指令约 {cntCall} 次");

                var props = method.DeclaringType?
                    .GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .Select(f => f.Name).Take(20).ToArray();
                if (props != null && props.Length > 0)
                    Diag.Log("状态机字段: " + string.Join(", ", props));
            }
            catch (Exception ex)
            {
                Diag.Log("转储 IL 失败: " + ex.Message);
            }
        }

        private static void LogHarmonyInfo()
        {
            try
            {
                var ha = typeof(Harmony).Assembly;
                Diag.Log($"Harmony 程序集: {ha.GetName().Version} @ {ha.Location}");
            }
            catch (Exception ex)
            {
                Diag.Log("读取 Harmony 信息失败: " + ex.Message);
            }
        }

        /// <summary>
        /// 抬高 ModNet.NetTaskThreadLimit（v2.15.1 里是普通可写静态属性）。
        /// 它是 Math.Min 的输入，设高避免成为新瓶颈。
        /// </summary>
        private static void RaiseThreadLimit(Type modNet)
        {
            try
            {
                var prop = modNet.GetProperty("NetTaskThreadLimit",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                if (prop == null) { Diag.Log("WARN: 没有 NetTaskThreadLimit 属性"); return; }
                var before = prop.GetValue(null);
                prop.SetValue(null, Math.Max(TargetChunks * 4, 64));
                Diag.Log($"NetTaskThreadLimit: {before} -> {prop.GetValue(null)}");
            }
            catch (Exception ex)
            {
                Diag.Log("WARN: 设置 NetTaskThreadLimit 失败: " + ex.Message);
            }
        }

        /// <summary>
        /// Transpiler：把 Math.Min(x, 4) 的上界 4 换成目标值。
        /// 命中数写入 _replaced，由调用方据此判定是否真的成功。
        /// </summary>
        public static IEnumerable<CodeInstruction> Transpile(IEnumerable<CodeInstruction> instructions)
        {
            var list = instructions.ToList();
            var local = 0;

            for (var i = 1; i < list.Count; i++)
            {
                if (!IsMathCall(list[i], "Min")) continue;
                if (!IsConst(list[i - 1], OriginalChunkCap)) continue;

                SetConst(list[i - 1], TargetChunks);
                local++;
            }

            _replaced = local;
            Diag.Log(local > 0
                ? $"transpiler: 已替换 {local} 处 Math.Min(?, {OriginalChunkCap}) -> {TargetChunks}"
                : $"transpiler: 未找到 Math.Min(?, {OriginalChunkCap})");

            return list;
        }

        /// <summary>
        /// 判断是否为指定整数常量。必须覆盖三种编码：
        ///   -1..8 用专用 opcode（Ldc_I4_M1 / Ldc_I4_0 … Ldc_I4_8），无 operand
        ///   -128..127 用 Ldc_I4_S，operand 是 sbyte
        ///   其它用 Ldc_I4，operand 是 int
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

        private static bool IsMathCall(CodeInstruction ins, string name)
        {
            if (ins.opcode != OpCodes.Call && ins.opcode != OpCodes.Callvirt) return false;
            if (ins.operand is not MethodInfo m) return false;
            return m.Name == name && m.DeclaringType != null
                   && (m.DeclaringType.FullName == "System.Math" || m.DeclaringType.Name == "Math");
        }

        private static string DescribeException(Exception ex)
        {
            var sb = new System.Text.StringBuilder();
            var level = 0;
            for (Exception? e = ex; e != null && level < 6; e = e.InnerException, level++)
            {
                sb.AppendLine($"  [{level}] {e.GetType().FullName}: {e.Message}");
                if (level == 0 && e is TypeInitializationException tie && tie.TypeName != null)
                    sb.AppendLine($"      初始化失败的类型: {tie.TypeName}");
                if (level == 0 && !string.IsNullOrEmpty(e.StackTrace))
                    foreach (var l in e.StackTrace!.Split('\n').Take(5))
                        sb.AppendLine("      " + l.Trim());
            }
            return sb.ToString().TrimEnd();
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
