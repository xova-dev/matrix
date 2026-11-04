/** Windows supplies PowerShell/.NET; no downloaded helper or native addon. */
export const windowsJobScript = String.raw`
param([string]$PipeName)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public sealed class MatrixJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr Minimum, Maximum;
    public uint Active;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Limits Basic;
    public Counters IO;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint Pid, Tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup {
    public Startup Basic;
    public IntPtr Attributes;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref ExtendedStartup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job, root;
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public MatrixJob(string application, string command, string cwd) {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var limits = new Extended();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended))));
      var startup = new ExtendedStartup();
      startup.Basic.Size = (uint)Marshal.SizeOf(typeof(ExtendedStartup));
      startup.Basic.Flags = 0x100;
      startup.Basic.Input = GetStdHandle(-10); startup.Basic.Output = GetStdHandle(-11); startup.Basic.Error = GetStdHandle(-12);
      IntPtr size = IntPtr.Zero, jobs = IntPtr.Zero;
      bool initialized = false;
      try {
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        startup.Attributes = Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(startup.Attributes, 1, 0, ref size));
        initialized = true;
        jobs = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(jobs, job);
        // PROC_THREAD_ATTRIBUTE_JOB_LIST: ownership is established inside
        // CreateProcess, including if this supervisor dies immediately on return.
        Check(UpdateProcThreadAttribute(startup.Attributes, 0, (UIntPtr)0x2000D, jobs, (UIntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
        ProcessInfo process;
        // EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED.
        Check(CreateProcess(application, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x80004, IntPtr.Zero, cwd, ref startup, out process));
        root = process.Process;
        try {
          if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { CloseHandle(process.Thread); }
      } finally {
        if (initialized) DeleteProcThreadAttributeList(startup.Attributes);
        if (startup.Attributes != IntPtr.Zero) Marshal.FreeHGlobal(startup.Attributes);
        if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      }
    } catch { Dispose(); throw; }
  }
  public bool Exited() {
    uint state = WaitForSingleObject(root, 0);
    if (state == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
    return state == 0;
  }
  public uint ExitCode() { uint code; Check(GetExitCodeProcess(root, out code)); return code; }
  public void Drain() {
    Check(TerminateJobObject(job, 1));
    var deadline = DateTime.UtcNow.AddSeconds(10);
    while (true) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.ActiveProcesses == 0) return;
      if (DateTime.UtcNow >= deadline) throw new TimeoutException("Windows process job did not become empty");
      Thread.Sleep(10);
    }
  }
  public void Dispose() {
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (root != IntPtr.Zero) { CloseHandle(root); root = IntPtr.Zero; }
  }
}
'@
$pipe = $null
$job = $null
try {
  # The pending stop read must not block observation of root completion.
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  $pipe.Connect(10000)
  $reader = New-Object System.IO.StreamReader($pipe)
  $writer = New-Object System.IO.StreamWriter($pipe)
  $writer.AutoFlush = $true
  $request = $reader.ReadLine() | ConvertFrom-Json
  if ($null -eq $request) { exit 0 }
  if ($request.cancelled) { $writer.WriteLine('stopped'); exit 0 }
  $job = New-Object MatrixJob($request.application, $request.command, $request.cwd)
  $control = $reader.ReadLineAsync()
  $reported = $false
  while (-not $control.IsCompleted) {
    if (-not $reported -and $job.Exited()) {
      $writer.WriteLine("exit $($job.ExitCode())")
      $reported = $true
    }
    Start-Sleep -Milliseconds 10
  }
  # STOP or coordinator disconnect: descendants remain owned after root exit.
  $job.Drain()
  if ($pipe.IsConnected) { $writer.WriteLine('stopped') }
} catch {
  if ($null -ne $pipe -and $pipe.IsConnected) {
    try { $writer.WriteLine('error ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.ToString()))) } catch {}
  }
  exit 1
} finally {
  if ($null -ne $job) { $job.Dispose() }
  if ($null -ne $pipe) { $pipe.Dispose() }
}
`
