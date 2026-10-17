using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Threading;
using HarmonyLib;

namespace McBoost.PclHook
{
    /// <summary>
    /// 补丁执行器。
    ///
    /// 重要教训：不要依赖具体的类型名。
    /// 之前按 GitHub dev 分支源码写死了 PCL.Network.AdaptiveRangeDownloader，
    /// 但用户实际安装的 PCL CE 发布版里**根本没有这个类**（35924 个类型扫完都没命中）。
    /// 各版本之间下载器实现差异很大，写死类名必然失效。
    ///
    /// 现在的做法：**按 IL 特征匹配**。
    /// 不管类叫什么、在哪个程序集，只要某个方法里出现
    /// <code>Math.Clamp(?, 1, 8)</code>
    /// 这个指令序列，就认定它是「限流单文件连接数」的地方，把上界 8 改成目标值。
    ///
    /// 为什么这个特征可靠：
    ///   1. Clamp(x, 1, 8) 这种「下界 1、上界 8」的写法在下载器里几乎只用于连接数限制
    ///   2. 特征包含 ldc.i4.1 + ldc.i4.8 + call Clamp 三段，误伤概率极低
    ///   3. 扫描范围限定在名字含 Download/Net/Http 的类型里，进一步收窄
    /// </summary>
    internal static class PatchRunner
    {
        internal static int TargetConnections =
            ReadIntFromEnv("MCBOOST_PCL_CONNECTIONS") ?? 24;

        /// <summary>等待 PCL 主程序集加载的最长时间。</summary>
        private const int MaxWaitSeconds = 60;

        /// <summary>认为属于「网络/下载」的类型名关键字。</summary>
        private static readonly string[] NetishKeywords =
            { "Download", "Net", "Http", "Transfer", "Fetch", "Mirror" };

        internal static void RunUntilApplied()
        {
            Diag.Log($"patcher start, target = {TargetConnections}");

            if (!WaitForPclAssemblies())
            {
                Diag.Log("FAIL: PCL 主程序集未在 60 秒内加载");
                return;
            }

            var report = Discover();
            Diag.Log(report);

            var patched = PatchClampPatterns();
            if (patched > 0)
            {
                Diag.Log($"DONE: 已修改 {patched} 处连接数上限 -> {TargetConnections}");
            }
            else
            {
                Diag.Log("FAIL: 未找到任何 Clamp(?,1,8) 特征，无法确定连接数限制位置");
                Diag.Log("请把上面这段报告整个发到 issue，我能据此定位。");
            }
        }

        /// <summary>等待 PCL 自己的程序集加载出来。</summary>
        private static bool WaitForPclAssemblies()
        {
            var deadline = DateTime.UtcNow.AddSeconds(MaxWaitSeconds);
            while (DateTime.UtcNow < deadline)
            {
                if (PclAssemblies().Any()) return true;
                Thread.Sleep(200);
            }
            return false;
        }

        /// <summary>
        /// 找出属于 PCL 的程序集。
        /// 依据：程序集名含 PCL / Plain Craft / MultiMc，或与入口程序集相同。
        /// </summary>
        private static List<Assembly> PclAssemblies()
        {
            var result = new List<Assembly>();
            var entry = Assembly.GetEntryAssembly();

            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    var name = asm.GetName().Name ?? "";
                    if (name.Contains("PCL") || name.Contains("Plain Craft")
                        || name.Equals("MultiMc", StringComparison.OrdinalIgnoreCase))
                    {
                        result.Add(asm);
                    }
                    else if (entry != null && asm == entry)
                    {
                        result.Add(asm);
                    }
                }
                catch { /* 忽略取不到名字的程序集 */ }
            }
            return result.Distinct().ToList();
        }

        /// <summary>
        /// 安全地取出一个程序集的全部类型（含部分加载成功的）。
        /// </summary>
        private static Type[] SafeGetTypes(Assembly asm)
        {
            try { return asm.GetTypes(); }
            catch (ReflectionTypeLoadException ex) { return ex.Types.Where(t => t != null).Select(t => t!).ToArray(); }
            catch { return Array.Empty<Type>(); }
        }

        /// <summary>
        /// 生成一次性诊断报告：PCL 程序集里与网络/下载相关的类型清单。
        /// 一次跑完写进日志，避免反复刷屏。
        /// </summary>
        private static string Discover()
        {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine("===== 诊断报告 =====");

            var asms = PclAssemblies();
            sb.AppendLine($"PCL 程序集 ({asms.Count}): " +
                          string.Join(", ", asms.Select(a => { try { return a.GetName().Name; } catch { return "?"; } })));

            var allTypes = asms.SelectMany(SafeGetTypes).ToArray();
            sb.AppendLine($"类型总数: {allTypes.Length}");

            // 1. 名字像下载器的类型
            var netish = allTypes
                .Where(t => NetishKeywords.Any(k =>
                    (t.Name ?? "").IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0))
                .Select(t => t.FullName)
                .Where(n => n != null)
                .Take(60)
                .ToList();
            sb.AppendLine($"含 Download/Net/Http 关键字的类型 ({netish.Count} 个，最多列 60): " +
                          string.Join(", ", netish));

            // 2. 任何叫 DownloadAsync 的方法（各版本可能在不同类里）
            var dlAsync = allTypes
                .SelectMany(t =>
                {
                    try
                    {
                        return t.GetMethods(BindingFlags.Instance | BindingFlags.Static
                                            | BindingFlags.Public | BindingFlags.NonPublic)
                            .Where(m => m.Name.Contains("Download", StringComparison.OrdinalIgnoreCase))
                            .Select(m => $"{t.FullName}.{m.Name}");
                    }
                    catch { return Enumerable.Empty<string>(); }
                })
                .Distinct()
                .Take(40)
                .ToList();
            sb.AppendLine($"名字含 Download 的方法 ({dlAsync.Count} 个，最多列 40): " +
                          string.Join(", ", dlAsync));

            // 3. ModNet 这类「连接数限制」的类型是否存在，静态属性当前值
            foreach (var t in allTypes.Where(t => t.Name is "ModNet" or "NetManager" or "DlManager"))
            {
                sb.AppendLine($"--- {t.FullName} 的静态属性 ---");
                try
                {
                    foreach (var p in t.GetProperties(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                    {
                        string val;
                        try { val = p.CanRead ? (p.GetValue(null)?.ToString() ?? "null") : "(不可读)"; }
                        catch { val = "(读取失败)"; }
                        sb.AppendLine($"    {p.Name} = {val}");
                    }
                }
                catch (Exception ex) { sb.AppendLine("    读取失败: " + ex.Message); }
            }

            sb.AppendLine("====================");
            return sb.ToString();
        }

        /// <summary>
        /// 扫描并修补所有 Clamp(?, 1, 8) 特征。
        /// @returns 命中的方法数
        /// </summary>
        private static int PatchClampPatterns()
        {
            var harmony = new Harmony("com.mcboost.pclhook");
            var transpiler = new HarmonyMethod(
                typeof(PatchRunner).GetMethod(nameof(Transpile),
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!);

            var candidates = new List<MethodBase>();
            var asms = PclAssemblies();
            var allTypes = asms.SelectMany(SafeGetTypes);

            foreach (var t in allTypes)
            {
                // 只在「像网络/下载」的类型里找，避免全量扫描太慢
                if (!NetishKeywords.Any(k =>
                        (t.Name ?? "").IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0))
                    continue;

                MethodBase[] methods;
                try
                {
                    methods = t.GetMethods(BindingFlags.Instance | BindingFlags.Static
                                           | BindingFlags.Public | BindingFlags.NonPublic
                                           | BindingFlags.DeclaredOnly);
                }
                catch { continue; }

                foreach (var m in methods)
                {
                    if (m.IsAbstract || m.ContainsGenericParameters) continue;
                    if (HasClamp18Pattern(m)) candidates.Add(m);
                }
            }

            if (candidates.Count == 0)
            {
                Diag.Log("未在 Download/Net 类型中找到 Clamp(?,1,8)。");
                return 0;
            }

            Diag.Log($"找到 {candidates.Count} 个含 Clamp(?,1,8) 的方法: " +
                     string.Join(", ", candidates.Select(c => $"{c.DeclaringType?.FullName}.{c.Name}")));

            var patched = 0;
            foreach (var m in candidates)
            {
                try
                {
                    harmony.Patch(m, transpiler: transpiler);
                    patched++;
                }
                catch (Exception ex)
                {
                    Diag.Log($"patch 失败 {m.DeclaringType?.Name}.{m.Name}: {ex.Message}");
                }
            }

            // 顺带抬高属性值（若存在）
            TryRaiseConnectionProperty(allTypes);

            return patched;
        }

        /// <summary>
        /// 判断方法 IL 里是否含 ldc.i4.1 ; ldc.i4.8 ; call Math.Clamp 序列。
        /// </summary>
        private static bool HasClamp18Pattern(MethodBase m)
        {
            try
            {
                var body = m.GetMethodBody();
                if (body == null) return false;
                var il = body.GetILAsByteArray();
                if (il == null || il.Length < 6) return false;

                // 逐字节粗扫：ldc.i4.1 = 0x17，ldc.i4.8 = 0x1D
                for (var i = 0; i + 3 < il.Length; i++)
                {
                    if (il[i] != 0x17) continue;      // ldc.i4.1
                    if (il[i + 1] != 0x1D) continue;  // ldc.i4.8
                    // 下一条应是 call(0x28)/callvirt(0x6F)，紧跟着 4 字节 metadata token
                    if (il[i + 2] != 0x28 && il[i + 2] != 0x6F) continue;
                    return true;
                }
            }
            catch { /* 动态方法 / 无 IL 体 */ }
            return false;
        }

        /// <summary>
        /// 尝试把所有名字含 ConnectionLimit 的静态属性改成目标值。
        /// 对 const 内联无效，但能覆盖走属性读的路径。
        /// </summary>
        private static void TryRaiseConnectionProperty(IEnumerable<Type> allTypes)
        {
            foreach (var t in allTypes)
            {
                PropertyInfo[] props;
                try
                {
                    props = t.GetProperties(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                }
                catch { continue; }

                foreach (var p in props)
                {
                    if (!p.Name.Contains("Connection", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!p.CanWrite) continue;
                    try
                    {
                        p.SetValue(null, TargetConnections);
                        Diag.Log($"已设置 {t.Name}.{p.Name} = {TargetConnections}");
                    }
                    catch { /* 类型不匹配或只读，忽略 */ }
                }
            }
        }

        /// <summary>
        /// Transpiler：把 Clamp(?, 1, 8) 的上界 8 换成目标值。
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

                if (!IsConst(second, 1)) continue;
                if (!IsConst(third, 8)) continue;

                SetConst(third, TargetConnections);
                replaced++;
            }

            if (replaced > 0)
                Diag.Log($"transpiler: 替换 {replaced} 处 -> {TargetConnections}");
            else
                Diag.Log("transpiler: 该方法中未匹配到 Clamp(?,1,8)");

            return list;
        }

        /// <summary>
        /// 判断是否为指定整数常量。
        ///
        /// 必须处理三种编码，否则永远匹配不到：
        ///   · -1..8 用专用指令 Ldc_I4_M1 / Ldc_I4_0 … Ldc_I4_8，**无 operand**
        ///   · -128..127 用 Ldc_I4_S，operand 是 <b>sbyte</b> 而非 int
        ///   · 其它用 Ldc_I4，operand 是 int
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

        /// <summary>把一条指令改写为指定整数常量（opcode 与 operand 一起改）。</summary>
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
            return m.Name == "Clamp" && m.DeclaringType != null
                   && (m.DeclaringType.FullName == "System.Math" || m.DeclaringType.Name == "Math");
        }

        private static int? ReadIntFromEnv(string name)
        {
            var raw = Environment.GetEnvironmentVariable(name);
            return int.TryParse(raw, out var v) && v > 0 ? v : null;
        }
    }
}
