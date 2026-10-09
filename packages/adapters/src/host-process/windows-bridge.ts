// 固定宿主桥接：创建挂起进程，先加入作业对象；收到持久派发后的 go 才恢复。
// 作业对象只管理常规子进程树，不隔离磁盘/网络，不阻止通过外部服务启动进程。
const SOURCE=String.raw`
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
public static class UmiNativeProcess {
  [StructLayout(LayoutKind.Sequential)] struct SA {public int size;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {public int size;public string reserved;public string desktop;public string title;public uint x,y,xSize,ySize,xCount,yCount,fill,flags;public short show,reservedSize;public IntPtr reservedPtr,input,output,error;}
  [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct BL {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct IO {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
  [StructLayout(LayoutKind.Sequential)] struct EL {public BL basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
  [StructLayout(LayoutKind.Sequential)] struct AC {public long user,kernel,periodUser,periodKernel;public uint faults,total,active,terminated;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EL info,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out AC info,int size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSa,IntPtr threadSa,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long birth,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  static readonly object outputLock=new object();static readonly JavaScriptSerializer serializer=new JavaScriptSerializer();
  static int captured=0;static long stdoutBytes=0,stderrBytes=0;static bool truncated=false;
  static void Emit(object value){lock(outputLock){Console.WriteLine(serializer.Serialize(value));Console.Out.Flush();}}
  static Dictionary<string,object> Obj(params object[] pairs){var d=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)d[(string)pairs[i]]=pairs[i+1];return d;}
  static long Birth(IntPtr handle){long b,e,k,u;if(!GetProcessTimes(handle,out b,out e,out k,out u))throw new Exception("PROCESS_IDENTITY_UNAVAILABLE");return b;}
  static void Check(bool ok){if(!ok)throw new Exception("NATIVE_ERROR_"+Marshal.GetLastWin32Error());}
  static Task Reader(IntPtr handle,string channel,int limit){return Task.Run(()=>{
    using(var stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,4096,false)){
      var bytes=new byte[4096];int n;while((n=stream.Read(bytes,0,bytes.Length))>0){lock(outputLock){
        if(channel=="stdout")stdoutBytes+=n;else stderrBytes+=n;
        int take=Math.Min(n,Math.Max(0,limit-captured));if(take<n)truncated=true;
        if(take>0){captured+=take;Emit(Obj("kind","data","channel",channel,"base64",Convert.ToBase64String(bytes,0,take)));}
      }}
    }
  });}
  static void Probe(Dictionary<string,object> a){
    uint pid=Convert.ToUInt32(a["pid"]);var handle=OpenProcess(0x100000|0x1000|(Convert.ToBoolean(a["terminate"])?1u:0u),false,pid);
    if(handle==IntPtr.Zero){int code=Marshal.GetLastWin32Error();Emit(Obj("kind","probe","state",code==87?"absent":"inaccessible"));return;}
    try{if(Birth(handle).ToString()!=(string)a["birth"]){Emit(Obj("kind","probe","state","different"));return;}
      if(WaitForSingleObject(handle,0)==0){Emit(Obj("kind","probe","state","absent"));return;}
      if(Convert.ToBoolean(a["terminate"])){Check(TerminateProcess(handle,137));Check(WaitForSingleObject(handle,5000)==0);Emit(Obj("kind","probe","state","terminated"));}
      else Emit(Obj("kind","probe","state","same"));
    }finally{CloseHandle(handle);}
  }
  public static void Run(string json){
    serializer.MaxJsonLength=3000000;var a=serializer.Deserialize<Dictionary<string,object>>(json);
    if((string)a["action"]=="probe"){Probe(a);return;}
    var owner=System.Diagnostics.Process.GetCurrentProcess();Emit(Obj("kind","owner","bridge",Obj("pid",owner.Id,"birth",Birth(owner.Handle).ToString())));
    var prepare=Task.Run(()=>Console.ReadLine());if(!prepare.Wait(10000)||prepare.Result!="prepare"){
      Emit(Obj("kind","exit","reason","not_started","exitCode",null,"jobInactive",true,"gateReleased",false,"stdoutBytes",0,"stderrBytes",0,"truncated",false));return;
    }
    IntPtr job=IntPtr.Zero,envPtr=IntPtr.Zero,outR=IntPtr.Zero,outW=IntPtr.Zero,errR=IntPtr.Zero,errW=IntPtr.Zero,inR=IntPtr.Zero,inW=IntPtr.Zero;PI pi=new PI();bool released=false;string reason="launch_failed";uint code=0;
    try{
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);var limits=new EL();limits.basic.flags=0x2000|8|0x200;limits.basic.active=64;limits.jobMemory=new UIntPtr(2147483648UL);Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EL))));
      var sa=new SA{size=Marshal.SizeOf(typeof(SA)),inherit=true};Check(CreatePipe(out outR,out outW,ref sa,0));Check(CreatePipe(out errR,out errW,ref sa,0));Check(CreatePipe(out inR,out inW,ref sa,0));
      Check(SetHandleInformation(outR,1,0));Check(SetHandleInformation(errR,1,0));Check(SetHandleInformation(inW,1,0));
      var vars=(Dictionary<string,object>)a["env"];var block=String.Join("\0",vars.OrderBy(x=>x.Key,StringComparer.OrdinalIgnoreCase).Select(x=>x.Key+"="+x.Value))+"\0\0";envPtr=Marshal.StringToHGlobalUni(block);
      var si=new SI{size=Marshal.SizeOf(typeof(SI)),flags=0x100,input=inR,output=outW,error=errW};
      Check(CreateProcess((string)a["program"],new StringBuilder((string)a["commandLine"]),IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x400|4,envPtr,(string)a["cwd"],ref si,out pi));
      Check(AssignProcessToJobObject(job,pi.process));CloseHandle(outW);outW=IntPtr.Zero;CloseHandle(errW);errW=IntPtr.Zero;CloseHandle(inR);inR=IntPtr.Zero;
      var me=System.Diagnostics.Process.GetCurrentProcess();Emit(Obj("kind","ready","bridge",Obj("pid",me.Id,"birth",Birth(me.Handle).ToString()),"child",Obj("pid",pi.pid,"birth",Birth(pi.process).ToString())));
      var gate=Task.Run(()=>Console.ReadLine());if(!gate.Wait(10000)||gate.Result!="go"){reason="not_started";}
      else {
        Check(ResumeThread(pi.thread)!=UInt32.MaxValue);released=true;Emit(Obj("kind","started"));
        int cap=Convert.ToInt32(a["maxOutputBytes"]);var t1=Reader(outR,"stdout",cap);outR=IntPtr.Zero;var t2=Reader(errR,"stderr",cap);errR=IntPtr.Zero;
        var inputHandle=inW;inW=IntPtr.Zero;var input=Task.Run(()=>{try{using(var s=new FileStream(new SafeFileHandle(inputHandle,true),FileAccess.Write,4096,false)){var b=Encoding.UTF8.GetBytes((string)a["stdin"]);s.Write(b,0,b.Length);}}catch{}});
        var stop=Task.Run(()=>Console.ReadLine());var clock=System.Diagnostics.Stopwatch.StartNew();reason="exited";
        while(WaitForSingleObject(pi.process,25)!=0){if(stop.IsCompleted){reason=stop.Result==null?"parent_closed":"stopped";break;}if(clock.ElapsedMilliseconds>=Convert.ToInt32(a["timeoutMs"])){reason="timeout";break;}}
        if(reason=="exited")Check(GetExitCodeProcess(pi.process,out code));
        Check(TerminateJobObject(job,137));bool drained=Task.WaitAll(new[]{t1,t2,input},5000);if(!drained)throw new Exception("PIPE_CLEANUP_UNCONFIRMED");
      }
      Check(TerminateJobObject(job,137));var deadline=DateTime.UtcNow.AddSeconds(5);AC accounting;bool inactive=false;
      do{Check(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(AC)),IntPtr.Zero));if(accounting.active==0){inactive=true;break;}Thread.Sleep(10);}while(DateTime.UtcNow<deadline);
      Emit(Obj("kind","exit","reason",reason,"exitCode",reason=="exited"?(object)(long)code:null,"jobInactive",inactive,"gateReleased",released,"stdoutBytes",stdoutBytes,"stderrBytes",stderrBytes,"truncated",truncated));
    }catch{Emit(Obj("kind","error","reason",reason,"gateReleased",released));}
    finally{
      if(pi.process!=IntPtr.Zero&&!released)TerminateProcess(pi.process,137);
      if(job!=IntPtr.Zero){TerminateJobObject(job,137);CloseHandle(job);}
      foreach(var h in new[]{pi.process,pi.thread,outR,outW,errR,errW,inR,inW})if(h!=IntPtr.Zero)CloseHandle(h);
      if(envPtr!=IntPtr.Zero)Marshal.FreeHGlobal(envPtr);
    }
  }
}`;
export const WINDOWS_BRIDGE=`$ErrorActionPreference='Stop'
$source=@'
${SOURCE}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Web.Extensions','System.Core'
[UmiNativeProcess]::Run([Console]::ReadLine())`;
