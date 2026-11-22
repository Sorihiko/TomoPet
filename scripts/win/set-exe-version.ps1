# 改 exe 的版本信息（右键「属性 → 详细信息」、任务管理器「进程」里的「描述」看到的那些），
# 用 Windows 自带的 UpdateResource，不用另外装工具。
#   powershell -NoProfile -File set-exe-version.ps1 -Exe TomoPet.exe -Description TomoPet -Product TomoPet -Version 0.1.0 -Company TomoPet -Copyright "..."
#   powershell -NoProfile -File set-exe-version.ps1 -Exe TomoPet.exe -Inspect     （只读：读出现在的版本信息）
# 做法：照微软的 VS_VERSIONINFO 格式重新拼一份（固定信息 + 一张 040904B0 的字符串表 + Translation），
# 删掉 exe 原来的那份（同一个资源号、同一个语言），写新的。写完用 .NET 的 FileVersionInfo 读回来。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Description = '',
  [string]$Product = '',
  [string]$Version = '0.0.0',
  [string]$Company = '',
  [string]$Copyright = '',
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
using System.Text;

public static class TomoPetExeVersion {
  const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
  static readonly IntPtr RT_VERSION = (IntPtr)16;

  delegate bool EnumNameProc(IntPtr hModule, IntPtr type, IntPtr name, IntPtr param);
  delegate bool EnumLangProc(IntPtr hModule, IntPtr type, IntPtr name, ushort lang, IntPtr param);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc proc, IntPtr param);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc proc, IntPtr param);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool EndUpdateResource(IntPtr update, bool discard);

  // exe 里现有的版本信息资源：(资源号, 语言) 的列表。Electron 的是 (1, 1033)。
  static List<KeyValuePair<IntPtr, ushort>> Existing(string exe) {
    var list = new List<KeyValuePair<IntPtr, ushort>>();
    IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
    if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "打不开 exe：" + exe);
    try {
      EnumResourceNames(module, RT_VERSION, (m, t, n, p) => {
        if (((ulong)n.ToInt64() >> 16) != 0) return true; // 只认整数资源号
        EnumResourceLanguages(m, t, n, (m2, t2, n2, l, p2) => { list.Add(new KeyValuePair<IntPtr, ushort>(n2, l)); return true; }, IntPtr.Zero);
        return true;
      }, IntPtr.Zero);
    } finally { FreeLibrary(module); }
    return list;
  }

  // 一个版本信息块：wLength、wValueLength、wType、键名（UTF-16，带结尾 0），对齐到 4 字节，值，再对齐，子块（每个都对齐到 4 字节）。
  static byte[] Block(string key, byte[] value, ushort valueLength, ushort type, List<byte[]> children) {
    var ms = new MemoryStream();
    var w = new BinaryWriter(ms);
    w.Write((ushort)0); w.Write(valueLength); w.Write(type);
    w.Write(Encoding.Unicode.GetBytes(key + "\0"));
    Pad(ms);
    if (value != null && value.Length > 0) w.Write(value);
    if (children != null) {
      foreach (var child in children) { Pad(ms); w.Write(child); }
    }
    byte[] bytes = ms.ToArray();
    BitConverter.GetBytes((ushort)bytes.Length).CopyTo(bytes, 0);
    return bytes;
  }
  static void Pad(MemoryStream ms) { while (ms.Length % 4 != 0) ms.WriteByte(0); }

  static byte[] StringEntry(string key, string text) {
    byte[] value = Encoding.Unicode.GetBytes(text + "\0");
    return Block(key, value, (ushort)(text.Length + 1), 1, null); // wValueLength 是字数（含结尾 0）
  }

  static uint[] ParseVersion(string v) {
    var parts = (v ?? "0").Split('.');
    var n = new uint[4];
    for (int i = 0; i < 4; i++) { uint x = 0; if (i < parts.Length) uint.TryParse(parts[i], out x); n[i] = Math.Min(x, 65535u); }
    return n;
  }

  public static byte[] Build(string description, string product, string version, string company, string copyright, string fileName) {
    uint[] v = ParseVersion(version);
    string dotted = v[0] + "." + v[1] + "." + v[2] + "." + v[3];
    var fixedInfo = new MemoryStream();
    var f = new BinaryWriter(fixedInfo);
    f.Write(0xFEEF04BDu);                 // dwSignature
    f.Write(0x00010000u);                 // dwStrucVersion
    f.Write((v[0] << 16) | v[1]); f.Write((v[2] << 16) | v[3]); // 文件版本
    f.Write((v[0] << 16) | v[1]); f.Write((v[2] << 16) | v[3]); // 产品版本
    f.Write(0x3Fu); f.Write(0u);          // dwFileFlagsMask, dwFileFlags
    f.Write(0x00040004u);                 // VOS_NT_WINDOWS32
    f.Write(1u); f.Write(0u);             // VFT_APP, 子类型
    f.Write(0u); f.Write(0u);             // 日期
    byte[] fixedBytes = fixedInfo.ToArray(); // 52 字节

    var strings = new List<byte[]> {
      StringEntry("CompanyName", company),
      StringEntry("FileDescription", description),
      StringEntry("FileVersion", dotted),
      StringEntry("InternalName", fileName),
      StringEntry("LegalCopyright", copyright),
      StringEntry("OriginalFilename", fileName),
      StringEntry("ProductName", product),
      StringEntry("ProductVersion", dotted),
    };
    byte[] table = Block("040904B0", null, 0, 1, strings);          // 英语（美国）+ Unicode 代码页
    byte[] stringFileInfo = Block("StringFileInfo", null, 0, 1, new List<byte[]> { table });
    byte[] translation = Block("Translation", new byte[] { 0x09, 0x04, 0xB0, 0x04 }, 4, 0, null);
    byte[] varFileInfo = Block("VarFileInfo", null, 0, 1, new List<byte[]> { translation });
    return Block("VS_VERSION_INFO", fixedBytes, (ushort)fixedBytes.Length, 0, new List<byte[]> { stringFileInfo, varFileInfo });
  }

  public static void Apply(string exe, byte[] data) {
    var existing = Existing(exe);
    IntPtr name = existing.Count > 0 ? existing[0].Key : (IntPtr)1;
    ushort lang = existing.Count > 0 ? existing[0].Value : (ushort)1033;
    IntPtr update = BeginUpdateResource(exe, false);
    if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "改不了 exe（正在运行？）：" + exe);
    bool ok = false;
    try {
      foreach (var e in existing) {
        if (!UpdateResource(update, RT_VERSION, e.Key, e.Value, null, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "删旧的版本信息失败");
      }
      if (!UpdateResource(update, RT_VERSION, name, lang, data, (uint)data.Length)) throw new Win32Exception(Marshal.GetLastWin32Error(), "写版本信息失败");
      ok = true;
    } finally {
      if (!EndUpdateResource(update, !ok) && ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "保存 exe 失败");
    }
  }
}
'@

$exePath = (Resolve-Path -LiteralPath $Exe).Path
if (-not $Inspect) {
  $fileName = [System.IO.Path]::GetFileName($exePath)
  $data = [TomoPetExeVersion]::Build($Description, $Product, $Version, $Company, $Copyright, $fileName)
  [TomoPetExeVersion]::Apply($exePath, $data)
}
# 读回来（UTF-8 输出，一行一项，给 Node 解析）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)
Write-Output ("FileDescription=" + $info.FileDescription)
Write-Output ("ProductName=" + $info.ProductName)
Write-Output ("CompanyName=" + $info.CompanyName)
Write-Output ("FileVersion=" + $info.FileVersion)
Write-Output ("ProductVersion=" + $info.ProductVersion)
Write-Output ("OriginalFilename=" + $info.OriginalFilename)
Write-Output ("LegalCopyright=" + $info.LegalCopyright)
