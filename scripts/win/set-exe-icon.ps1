# 把 .ico 写进 exe 当程序图标（资源管理器、任务栏、Alt+Tab 里看到的那个），用 Windows 自带的
# BeginUpdateResource / UpdateResource / EndUpdateResource，不用另外装 rcedit 之类的工具。
#   powershell -NoProfile -File set-exe-icon.ps1 -Exe osu-pet.exe -Ico logo.ico
#   powershell -NoProfile -File set-exe-icon.ps1 -Exe osu-pet.exe -Inspect     （只读：列出 exe 里的图标组和每张图的尺寸）
# 做法：找到 exe 里第一个图标组（RT_GROUP_ICON，Electron 的主图标），删掉它原来的那几张图（RT_ICON），
# 换成 .ico 里的每一张，再用同一个组名写一个新的图标组。语言沿用原来的。
# 注意：exe 原来的数字签名会失效（Electron 的签名本来就不是我们的）。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Ico = '',
  [switch]$Inspect
)
$ErrorActionPreference = 'Stop'
# 输出（包括报错）按 UTF-8：不然中文报错按 GBK 出去，Node 那边读成乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class OsuPetExeIcon {
  const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
  static readonly IntPtr RT_ICON = (IntPtr)3;
  static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;

  delegate bool EnumNameProc(IntPtr hModule, IntPtr type, IntPtr name, IntPtr param);
  delegate bool EnumLangProc(IntPtr hModule, IntPtr type, IntPtr name, ushort lang, IntPtr param);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc proc, IntPtr param);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc proc, IntPtr param);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort lang);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LoadResource(IntPtr module, IntPtr res);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LockResource(IntPtr data);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint SizeofResource(IntPtr module, IntPtr res);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool EndUpdateResource(IntPtr update, bool discard);

  // 资源名是整数 ID（高位为 0）还是字符串：这里只处理整数 ID（Electron 的图标组和图标都是整数 ID）。
  static bool IsIntResource(IntPtr name) { return ((ulong)name.ToInt64() >> 16) == 0; }

  class GroupInfo { public IntPtr Name; public ushort Lang; public byte[] Data; }

  static GroupInfo FirstGroup(IntPtr module) {
    GroupInfo found = null;
    EnumResourceNames(module, RT_GROUP_ICON, (m, t, n, p) => {
      if (!IsIntResource(n)) return true;
      ushort lang = 0; bool haveLang = false;
      EnumResourceLanguages(m, t, n, (m2, t2, n2, l, p2) => { lang = l; haveLang = true; return false; }, IntPtr.Zero);
      if (!haveLang) return true;
      IntPtr res = FindResourceEx(m, t, n, lang);
      if (res == IntPtr.Zero) return true;
      uint size = SizeofResource(m, res);
      byte[] data = new byte[size];
      Marshal.Copy(LockResource(LoadResource(m, res)), data, 0, (int)size);
      found = new GroupInfo { Name = n, Lang = lang, Data = data };
      return false;
    }, IntPtr.Zero);
    return found;
  }

  // 图标组的内容：GRPICONDIR（6 字节）+ 每张图一个 14 字节的 GRPICONDIRENTRY（最后 2 字节是 RT_ICON 的 ID）。
  static List<int[]> GroupEntries(byte[] g) {
    var list = new List<int[]>();
    int count = BitConverter.ToUInt16(g, 4);
    for (int i = 0; i < count; i++) {
      int o = 6 + i * 14;
      int w = g[o] == 0 ? 256 : g[o];
      int h = g[o + 1] == 0 ? 256 : g[o + 1];
      list.Add(new int[] { w, h, BitConverter.ToUInt16(g, o + 12), (int)BitConverter.ToUInt32(g, o + 8) });
    }
    return list;
  }

  public static string Inspect(string exe) {
    IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
    if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "打不开 exe：" + exe);
    try {
      GroupInfo g = FirstGroup(module);
      if (g == null) return "no-group";
      var parts = new List<string>();
      foreach (var e in GroupEntries(g.Data)) parts.Add(e[0] + "x" + e[1] + "#" + e[2] + ":" + e[3]);
      return "group=" + g.Name.ToInt64() + " lang=" + g.Lang + " icons=" + string.Join(",", parts);
    } finally { FreeLibrary(module); }
  }

  public static string Apply(string exe, string ico) {
    byte[] file = File.ReadAllBytes(ico);
    if (file.Length < 6 || BitConverter.ToUInt16(file, 0) != 0 || BitConverter.ToUInt16(file, 2) != 1) throw new InvalidDataException("不是 .ico 文件：" + ico);
    int count = BitConverter.ToUInt16(file, 4);
    if (count == 0) throw new InvalidDataException(".ico 里一张图都没有");

    // 1. 读原来的图标组（组名、语言、它用的图标 ID）——要先关掉 exe 才能写。
    IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
    if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "打不开 exe：" + exe);
    GroupInfo old;
    try { old = FirstGroup(module); } finally { FreeLibrary(module); }
    if (old == null) throw new InvalidDataException("exe 里没有图标组（RT_GROUP_ICON）");
    var oldEntries = GroupEntries(old.Data);
    int nextId = 1;
    foreach (var e in oldEntries) nextId = Math.Max(nextId, e[2] + 1);

    // 2. 写：删旧图标、写新图标、写新图标组（同一个组名、同一个语言）。
    IntPtr update = BeginUpdateResource(exe, false);
    if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "改不了 exe（正在运行？）：" + exe);
    bool ok = false;
    try {
      foreach (var e in oldEntries) {
        if (!UpdateResource(update, RT_ICON, (IntPtr)e[2], old.Lang, null, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "删旧图标失败");
      }
      byte[] group = new byte[6 + count * 14];
      Array.Copy(file, 0, group, 0, 6);
      for (int i = 0; i < count; i++) {
        int o = 6 + i * 16;
        uint bytes = BitConverter.ToUInt32(file, o + 8);
        uint offset = BitConverter.ToUInt32(file, o + 12);
        byte[] image = new byte[bytes];
        Array.Copy(file, (int)offset, image, 0, (int)bytes);
        int id = nextId + i;
        if (!UpdateResource(update, RT_ICON, (IntPtr)id, old.Lang, image, bytes)) throw new Win32Exception(Marshal.GetLastWin32Error(), "写图标失败");
        int g = 6 + i * 14;
        Array.Copy(file, o, group, g, 12);              // 宽、高、颜色数、保留、平面数、位数、字节数
        BitConverter.GetBytes((ushort)id).CopyTo(group, g + 12);
      }
      if (!UpdateResource(update, RT_GROUP_ICON, old.Name, old.Lang, group, (uint)group.Length)) throw new Win32Exception(Marshal.GetLastWin32Error(), "写图标组失败");
      ok = true;
    } finally {
      if (!EndUpdateResource(update, !ok) && ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "保存 exe 失败");
    }
    return Inspect(exe);
  }
}
'@

$exePath = (Resolve-Path -LiteralPath $Exe).Path
if ($Inspect) { Write-Output ([OsuPetExeIcon]::Inspect($exePath)); exit 0 }
if (-not $Ico) { throw '要给 -Ico（.ico 文件）或者 -Inspect' }
Write-Output ([OsuPetExeIcon]::Apply($exePath, (Resolve-Path -LiteralPath $Ico).Path))
