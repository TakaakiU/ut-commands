# ut-archive-win.ps1 - Windows-specific read-only probes for ut-archive.mjs.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a .ps1 without a BOM in the ANSI code page,
# so non-ASCII text (comments included) breaks the parser.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ut-archive-win.ps1 -In <request.json> -Out <result.jsonl>
#
# Request (JSON, UTF-8):
#   { "mode": "scan", "root": "<absolute path>" }    enumerate everything under root
#   { "mode": "syncroots" }                          OneDrive account folders and registered Cloud Files sync roots
#   { "mode": "syncroot", "path": "<absolute path>" } CfGetSyncRootInfoByPath result (HRESULT) for the path
# Result (JSON Lines, UTF-8): the first line is {"type":"header"} and the last line is {"type":"end","count":N},
# so a run that died midway can be told apart from a complete one.
#
# Read only. File contents are never opened: handles are opened with FILE_READ_ATTRIBUTES and
# FILE_FLAG_OPEN_REPARSE_POINT, so cloud-only files are not recalled (downloaded). Paths are not taken
# from the command line (to avoid argument parsing differences).
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$cs = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class UtArchiveWin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct WIN32_FIND_DATAW {
    public uint dwFileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
    public uint nFileSizeHigh;
    public uint nFileSizeLow;
    public uint dwReserved0;
    public uint dwReserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BY_HANDLE_FILE_INFORMATION {
    public uint dwFileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    public uint dwVolumeSerialNumber, nFileSizeHigh, nFileSizeLow, nNumberOfLinks, nFileIndexHigh, nFileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct FILE_STANDARD_INFO { public long AllocationSize; public long EndOfFile; public uint NumberOfLinks; public byte DeletePending; public byte Directory; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WIN32_FIND_STREAM_DATA { public long StreamSize; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)] public string cStreamName; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr FindFirstFileExW(string name, int infoLevel, out WIN32_FIND_DATAW data, int searchOp, IntPtr filter, int flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool FindNextFileW(IntPtr h, out WIN32_FIND_DATAW data);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FindClose(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int cls, out FILE_STANDARD_INFO info, uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr FindFirstStreamW(string name, int level, out WIN32_FIND_STREAM_DATA data, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool FindNextStreamW(IntPtr h, out WIN32_FIND_STREAM_DATA data);
  [DllImport("cldapi.dll")]
  static extern uint CfGetPlaceholderStateFromFindData(ref WIN32_FIND_DATAW data);
  [DllImport("cldapi.dll", CharSet = CharSet.Unicode)]
  static extern int CfGetSyncRootInfoByPath(string path, int infoClass, IntPtr buf, uint len, out uint ret);

  static readonly IntPtr INVALID = new IntPtr(-1);
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const uint FILE_READ_ATTRIBUTES = 0x80, SHARE_ALL = 7, OPEN_EXISTING = 3;
  const uint FLAG_OPEN_REPARSE = 0x00200000, FLAG_BACKUP = 0x02000000;

  // Cloud Files (OneDrive) reparse tags have the form 0x9000x01A (x = 0..F)
  public static bool IsCloudTag(uint tag) { return (tag & 0xFFFF0FFF) == 0x9000001A; }

  static string Long(string p) { return p.StartsWith(@"\\?\") ? p : @"\\?\" + p; }
  static long Ft(System.Runtime.InteropServices.ComTypes.FILETIME f) { return ((long)(uint)f.dwHighDateTime << 32) | (uint)f.dwLowDateTime; }

  // JSON string. Surrogates and control characters are always escaped (NTFS names may hold unpaired surrogates)
  public static string Js(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 0x20 || char.IsSurrogate(c) || c == 0x2028 || c == 0x2029) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static string Detail(string full) {
    var parts = new List<string>();
    // Handle-based facts. A failure here must not skip the stream check below: each axis is reported
    // on its own (detailError / allocError / streamsError), so "could not read" is never counted as "none"
    using (var h = CreateFileW(Long(full), FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FLAG_OPEN_REPARSE | FLAG_BACKUP, IntPtr.Zero)) {
      BY_HANDLE_FILE_INFORMATION bi;
      // When the handle or the basic information cannot be read, the allocation size is unknown too: say so explicitly
      if (h.IsInvalid) { int e = Marshal.GetLastWin32Error(); parts.Add("\"detailError\":" + e); parts.Add("\"allocError\":" + e); }
      else if (!GetFileInformationByHandle(h, out bi)) { int e = Marshal.GetLastWin32Error(); parts.Add("\"detailError\":" + e); parts.Add("\"allocError\":" + e); }
      else {
        parts.Add("\"vol\":\"" + bi.dwVolumeSerialNumber.ToString("x8") + "\"");
        parts.Add("\"fileId\":\"" + bi.nFileIndexHigh.ToString("x8") + bi.nFileIndexLow.ToString("x8") + "\"");
        parts.Add("\"links\":" + bi.nNumberOfLinks);
        FILE_STANDARD_INFO si;
        if (GetFileInformationByHandleEx(h, 1, out si, (uint)Marshal.SizeOf(typeof(FILE_STANDARD_INFO)))) parts.Add("\"alloc\":" + si.AllocationSize);
        else parts.Add("\"allocError\":" + Marshal.GetLastWin32Error());
      }
    }
    // Alternate data streams: count every stream other than the main one (::$DATA)
    WIN32_FIND_STREAM_DATA sd;
    IntPtr sh = FindFirstStreamW(Long(full), 0, out sd, 0);
    if (sh == INVALID) {
      int e = Marshal.GetLastWin32Error();
      if (e == 38) parts.Add("\"streams\":0");          // ERROR_HANDLE_EOF: no streams at all
      else parts.Add("\"streamsError\":" + e);
    } else {
      int n = 0;
      int last;
      try {
        do { if (sd.cStreamName != "::$DATA") n++; } while (FindNextStreamW(sh, out sd));
        last = Marshal.GetLastWin32Error();
      } finally { FindClose(sh); }
      // The loop must end with ERROR_HANDLE_EOF. Any other error means the count is incomplete:
      // report it as unknown instead of returning a partial count (a missed ADS would be lost silently)
      if (last == 38) parts.Add("\"streams\":" + n);
      else parts.Add("\"streamsError\":" + last);
    }
    return "," + string.Join(",", parts.ToArray());
  }

  // One entry line (the same shape for scan and files)
  static string Entry(string full, string rel, ref WIN32_FIND_DATAW d, out string kind) {
    uint a = d.dwFileAttributes;
    bool isDir = (a & FILE_ATTRIBUTE_DIRECTORY) != 0;
    bool isReparse = (a & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    uint tag = isReparse ? d.dwReserved0 : 0;
    bool link = isReparse && !IsCloudTag(tag);
    uint ph = CfGetPlaceholderStateFromFindData(ref d);
    long size = ((long)d.nFileSizeHigh << 32) | d.nFileSizeLow;
    kind = link ? "link" : (isDir ? "dir" : "file");
    var sb = new StringBuilder();
    sb.Append("{\"type\":\"entry\",\"rel\":").Append(Js(rel))
      .Append(",\"kind\":\"").Append(kind).Append('"')
      .Append(",\"attrs\":").Append(a)
      .Append(",\"tag\":").Append(tag)
      .Append(",\"ph\":").Append(ph)
      .Append(",\"size\":").Append(size)
      .Append(",\"mtime\":\"").Append(Ft(d.ftLastWriteTime)).Append('"');
    if (kind == "file") sb.Append(Detail(full));
    sb.Append('}');
    return sb.ToString();
  }

  // The given files, one entry each (rel is the full path as given). A missing path is an error line
  public static int Files(string[] paths, StreamWriter w) {
    foreach (string p in paths) {
      WIN32_FIND_DATAW d;
      IntPtr h = FindFirstFileExW(Long(p), 1, out d, 0, IntPtr.Zero, 0);
      if (h == INVALID) { w.WriteLine("{\"type\":\"error\",\"rel\":" + Js(p) + ",\"error\":" + Marshal.GetLastWin32Error() + "}"); continue; }
      FindClose(h);
      string kind;
      w.WriteLine(Entry(p, p, ref d, out kind));
    }
    return paths.Length;
  }

  // Enumerate under root. Reparse points other than Cloud Files (junctions, symlinks) are recorded but not followed
  public static int Scan(string root, StreamWriter w) {
    int count = 0;
    var stack = new Stack<string>();
    stack.Push("");
    while (stack.Count > 0) {
      string rel = stack.Pop();
      string dir = rel.Length == 0 ? root : Path.Combine(root, rel);
      WIN32_FIND_DATAW d;
      IntPtr h = FindFirstFileExW(Long(Path.Combine(dir, "*")), 1, out d, 0, IntPtr.Zero, 2);
      if (h == INVALID) {
        w.WriteLine("{\"type\":\"error\",\"rel\":" + Js(rel) + ",\"error\":" + Marshal.GetLastWin32Error() + "}");
        count++;
        continue;
      }
      try {
        do {
          if (d.cFileName == "." || d.cFileName == "..") continue;
          string r = rel.Length == 0 ? d.cFileName : rel + "\\" + d.cFileName;
          string kind;
          w.WriteLine(Entry(Path.Combine(root, r), r, ref d, out kind));
          count++;
          if (kind == "dir") stack.Push(r);
        } while (FindNextFileW(h, out d));
        int last = Marshal.GetLastWin32Error();
        if (last != 18) {   // stopped for a reason other than ERROR_NO_MORE_FILES: the listing was cut short
          w.WriteLine("{\"type\":\"error\",\"rel\":" + Js(rel) + ",\"error\":" + last + "}");
          count++;
        }
      } finally { FindClose(h); }
    }
    return count;
  }

  // One path (no wildcard): the same fields as a scan entry, without the per-file detail
  public static string Stat(string full) {
    WIN32_FIND_DATAW d;
    IntPtr h = FindFirstFileExW(Long(full), 1, out d, 0, IntPtr.Zero, 0);
    if (h == INVALID) return "{\"type\":\"stat\",\"path\":" + Js(full) + ",\"error\":" + Marshal.GetLastWin32Error() + "}";
    FindClose(h);
    uint a = d.dwFileAttributes;
    uint tag = (a & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ? d.dwReserved0 : 0;
    return "{\"type\":\"stat\",\"path\":" + Js(full) + ",\"attrs\":" + a + ",\"tag\":" + tag + ",\"ph\":" + CfGetPlaceholderStateFromFindData(ref d) + "}";
  }

  // 0 when the path is under a Cloud Files sync root, otherwise the HRESULT
  public static int SyncRootHr(string path) {
    IntPtr buf = Marshal.AllocHGlobal(4096);
    try { uint ret; return CfGetSyncRootInfoByPath(path, 0, buf, 4096, out ret); } finally { Marshal.FreeHGlobal(buf); }
  }
}
'@

$utf8 = New-Object System.Text.UTF8Encoding($false)
$req = [System.IO.File]::ReadAllText($In, $utf8) | ConvertFrom-Json
Add-Type -TypeDefinition $cs -Language CSharp
$w = New-Object System.IO.StreamWriter($Out, $false, $utf8)
try {
  $w.WriteLine('{"type":"header","version":1,"mode":' + [UtArchiveWin]::Js([string]$req.mode) + '}')
  $n = 0
  switch ([string]$req.mode) {
    'scan' {
      $root = [string]$req.root
      if (-not [System.IO.Path]::IsPathRooted($root)) { throw 'root is not an absolute path' }
      $root = $root.TrimEnd('\')
      # Keep the separator of a drive root: "C:" alone is drive-relative, not the root of the drive
      if ($root -match '^[A-Za-z]:$') { $root = $root + '\' }
      $n = [UtArchiveWin]::Scan($root, $w)
    }
    'stat' {
      foreach ($p in @($req.paths)) { $w.WriteLine([UtArchiveWin]::Stat([string]$p)); $n++ }
    }
    'files' {
      $n = [UtArchiveWin]::Files([string[]]@($req.paths), $w)
    }
    'proc' {
      # Start time of a process (to tell a live lock owner from a reused PID). Not found means not alive
      $pr = Get-Process -Id ([int]$req.pid) -ErrorAction SilentlyContinue
      if ($pr) { $w.WriteLine('{"type":"proc","pid":' + [int]$req.pid + ',"alive":true,"start":' + $pr.StartTime.ToUniversalTime().Ticks + '}') }
      else { $w.WriteLine('{"type":"proc","pid":' + [int]$req.pid + ',"alive":false}') }
      $n = 1
    }
    'mkprivate' {
      # Create a new directory that only the current user can access (inheritance removed). Fails if it exists
      $p = [string]$req.path
      if (Test-Path -LiteralPath $p) { throw 'mkprivate: the path already exists' }
      $sec = New-Object System.Security.AccessControl.DirectorySecurity
      $sec.SetAccessRuleProtection($true, $false)
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $sec.AddAccessRule($rule)
      [void][System.IO.Directory]::CreateDirectory($p, $sec)
      $w.WriteLine('{"type":"mkprivate","path":' + [UtArchiveWin]::Js($p) + '}')
      $n = 1
    }
    'syncroot' {
      $hr = [UtArchiveWin]::SyncRootHr([string]$req.path)
      $w.WriteLine('{"type":"syncroot","hr":' + $hr + '}')
      $n = 1
    }
    'syncroots' {
      # OneDrive account folders (UserFolder) and the sync roots registered with Cloud Files (UserSyncRoots).
      # A key that does not exist is normal (no OneDrive). Any other read failure is reported as an error line,
      # so that "could not read" is never mistaken for "nothing registered"
      $acc = 'HKCU:\Software\Microsoft\OneDrive\Accounts'
      if (Test-Path -LiteralPath $acc) {
        try {
          foreach ($k in (Get-ChildItem -LiteralPath $acc -ErrorAction Stop)) {
            $props = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction Stop
            if ($props.PSObject.Properties.Name -contains 'UserFolder' -and $props.UserFolder) { $w.WriteLine('{"type":"account","name":' + [UtArchiveWin]::Js($k.PSChildName) + ',"folder":' + [UtArchiveWin]::Js([string]$props.UserFolder) + '}'); $n++ }
          }
        } catch { $w.WriteLine('{"type":"error","where":"accounts","message":' + [UtArchiveWin]::Js($_.Exception.Message) + '}'); $n++ }
      }
      $srm = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager'
      if (Test-Path -LiteralPath $srm) {
        try {
          foreach ($k in (Get-ChildItem -LiteralPath $srm -ErrorAction Stop)) {
            $u = Join-Path $k.PSPath 'UserSyncRoots'
            if (Test-Path -LiteralPath $u) {
              $p = Get-ItemProperty -LiteralPath $u -ErrorAction Stop
              foreach ($prop in $p.PSObject.Properties) {
                if ($prop.Name -like 'PS*') { continue }
                $w.WriteLine('{"type":"registered","id":' + [UtArchiveWin]::Js($k.PSChildName) + ',"sid":' + [UtArchiveWin]::Js($prop.Name) + ',"folder":' + [UtArchiveWin]::Js([string]$prop.Value) + '}'); $n++
              }
            }
          }
        } catch { $w.WriteLine('{"type":"error","where":"syncrootmanager","message":' + [UtArchiveWin]::Js($_.Exception.Message) + '}'); $n++ }
      }
    }
    'knownfolders' {
      # Known folders (Documents, Desktop, Downloads) from User Shell Folders, with environment variables expanded.
      # A value that cannot be read is reported as an error line (never silently skipped)
      $usf = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
      $names = @(@('Documents', 'Personal'), @('Desktop', 'Desktop'), @('Downloads', '{374DE290-123F-4565-9164-39C4925E467B}'))
      $props = $null
      try { $props = Get-ItemProperty -LiteralPath $usf -ErrorAction Stop } catch { $w.WriteLine('{"type":"error","where":"knownfolders","message":' + [UtArchiveWin]::Js($_.Exception.Message) + '}'); $n++ }
      if ($props) {
        foreach ($pair in $names) {
          $v = $props.PSObject.Properties[$pair[1]]
          if ($v -and $v.Value) { $w.WriteLine('{"type":"known","name":"' + $pair[0] + '","path":' + [UtArchiveWin]::Js([Environment]::ExpandEnvironmentVariables([string]$v.Value)) + '}') }
          else { $w.WriteLine('{"type":"error","where":"knownfolder:' + $pair[0] + '","message":"value not found"}') }
          $n++
        }
      }
    }
    default { throw ('unknown mode: ' + [string]$req.mode) }
  }
  $w.WriteLine('{"type":"end","count":' + $n + '}')
} finally {
  $w.Close()
}
