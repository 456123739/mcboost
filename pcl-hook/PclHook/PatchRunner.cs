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
                downloaderType = FindType("PCL.Network.AdaptiveRangeDownloader");
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

            MethodInfo? downloadAsync;
            try
            {
                downloadAsync = downloaderType.GetMethod(
                    "DownloadAsync",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            }
            catch (AmbiguousMatchException)
            {
                // 有重载时挑参数最多的那个
                downloadAsync = downloaderType
                    .GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .Where(m => m.Name == "DownloadAsync")
                    .OrderByDescending(m => m.GetParameters().Length)
                    .FirstOrDefault();
                Diag.Log("DownloadAsync 存在重载，已选参数最多的一个");
            }

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

            // async 方法的真实 IL 在编译器生成的状态机 MoveNext() 里。
            // 直接 patch DownloadAsync 只会打到创建状态机的壳上，永远匹配不到 Math.Clamp。
            // 这里用 AsyncStateMachineAttribute 精确定位 MoveNext，
            // 不依赖 Harmony 的 MethodType 枚举，版本兼容性更好。
            var targets = new List<(string name, MethodBase method)>();

            var attr = downloadAsync.GetCustomAttribute<AsyncStateMachineAttribute>();
            if (attr?.StateMachineType != null)
            {
                var moveNext = attr.StateMachineType.GetMethod("MoveNext",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (moveNext != null)
                {
                    Diag.Log($"async 状态机: {attr.StateMachineType.FullName}.MoveNext");
                    targets.Add(("MoveNext(状态机)", moveNext));
                }
                else
                {
                    Diag.Log("状态机类型存在但找不到 MoveNext");
                }
            }
            else
            {
                Diag.Log("DownloadAsync 不是 async 方法（无状态机），直接 patch 本体");
            }

            // 兜底：本体也试一次
            targets.Add(("DownloadAsync(本体)", downloadAsync));

            var patched = false;
            foreach (var (name, method) in targets)
            {
                try
                {
                    harmony.Patch(method, transpiler: transpiler);
                    patched = true;
                    Diag.Log($"OK: patch 已应用到 {name}");
                    break;
                }
                catch (Exception ex)
                {
                    Diag.Log($"patch 失败 [{name}]: {ex.GetType().Name}: {ex.Message}");
                }
            }

            if (!patched)
            {
                Diag.Log("FAIL: 所有 patch 目标均失败");
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

                SetConst(third, TargetConnections);
                replaced++;
            }

            if (replaced > 0)
            {
                Diag.Log($"transpiler: 替换 {replaced} 处 Clamp 上界 -> {TargetConnections}");
            }
            else
            {
                Diag.Log("transpiler: 未匹配到 Clamp(x,1,8) 模式，转储实际 IL 以便排查");
                DumpClampContext(list);
            }

            return list;
        }

        /// <summary>
        /// 把 Clamp 调用附近的 IL 打到日志里。
        /// transpiler 没匹配上时用 —— 这样不必再靠猜，能直接看到真实指令序列。
        /// </summary>
        private static void DumpClampContext(List<CodeInstruction> list)
        {
            try
            {
                var found = 0;
                for (var i = 0; i < list.Count && found < 3; i++)
                {
                    if (!IsClampCall(list[i])) continue;
                    found++;

                    var from = Math.Max(0, i - 6);
                    var to = Math.Min(list.Count - 1, i + 1);
                    var sb = new System.Text.StringBuilder();
                    sb.Append($"Clamp@{i}: ");
                    for (var k = from; k <= to; k++)
                    {
                        var ins = list[k];
                        var operand = ins.operand == null ? "" : $" {ins.operand}";
                        sb.Append($"[{k}]{(k == i ? "*" : "")}{ins.opcode.Name}{operand}  ");
                    }
                    Diag.Log(sb.ToString());
                }
                if (found == 0) Diag.Log("未在该方法中找到任何 Math.Clamp 调用");
            }
            catch (Exception ex)
            {
                Diag.Log("dump IL 失败: " + ex.Message);
            }
        }

        /// <summary>
        /// 判断指令是否为指定整数常量。
        ///
        /// 必须处理三种编码方式，否则永远匹配不到：
        ///   · -1..8 用专用指令 <c>Ldc_I4_M1</c> / <c>Ldc_I4_0</c> … <c>Ldc_I4_8</c>，
        ///     **没有 operand**（C# 编译 1 和 8 就属于这种）
        ///   · -128..127 用 <c>Ldc_I4_S</c>，operand 是 <b>sbyte</b> 而非 int
        ///   · 其它用 <c>Ldc_I4</c>，operand 是 int
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

        /// <summary>
        /// 把一条指令改写为指定整数常量（opcode 与 operand 一起改）。
        /// </summary>
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

        /// <summary>
        /// 在所有已加载程序集中按全名或短名查找类型。
        ///
        /// 关键点：<c>Assembly.GetTypes()</c> 只要有一个类型加载失败就会抛
        /// <see cref="ReflectionTypeLoadException"/>，但异常的 <c>Types</c> 属性里
        /// **保留了成功加载的部分**。早期版本遇到异常直接跳过整个程序集，
        /// 而 PCL CE 主程序集恰恰会因为缺少可选依赖而抛异常 ——
        /// 结果就是永远找不到目标类型。这里必须用部分结果继续找。
        /// </summary>
        private static Type? FindType(string fullName)
        {
            var direct = Type.GetType(fullName);
            if (direct != null) return direct;

            var shortName = fullName.Split('.').Last();
            var failedAssemblies = new List<string>();
            var totalTypes = 0;

            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type?[] types;
                try
                {
                    types = asm.GetTypes();
                }
                catch (ReflectionTypeLoadException ex)
                {
                    // 保留能加载的那部分
                    types = ex.Types;
                    failedAssemblies.Add(asm.GetName().Name ?? "?");
                }
                catch (Exception)
                {
                    failedAssemblies.Add(asm.GetName().Name ?? "?");
                    continue;
                }

                totalTypes += types.Length;

                var exact = types.FirstOrDefault(t => t != null && t.FullName == fullName);
                if (exact != null) return exact;

                var byShort = types.FirstOrDefault(t => t != null && t.Name == shortName);
                if (byShort != null)
                {
                    Diag.Log($"按短名命中: {byShort.FullName}（在 {asm.GetName().Name}）");
                    return byShort;
                }
            }

            Diag.Log($"FindType({fullName}) 未命中。扫描 {totalTypes} 个类型，" +
                     $"部分加载失败的程序集({failedAssemblies.Count}): " +
                     string.Join(", ", failedAssemblies.Take(8)));

            // 最后兜底：按关键字模糊找，便于诊断真实类型名
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type?[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types; }
                catch { continue; }

                var near = types.Where(t => t != null &&
                        (t.Name.Contains("AdaptiveRange") || t.Name.Contains("RangeDownload")))
                    .Select(t => t!.FullName).Take(5).ToList();
                if (near.Count > 0)
                {
                    Diag.Log("相近类型: " + string.Join(", ", near));
                    break;
                }
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
