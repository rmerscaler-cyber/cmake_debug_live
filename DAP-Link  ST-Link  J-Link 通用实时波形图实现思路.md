# DAP-Link / J-Link / ST-Link 通用实时波形图实现思路

> 2026-09-26 方案决定：按 **DAP-Link → J-Link → ST-Link** 逐个实现和验收，共用同一套 Plot UI 与样本格式。`0.1.11` 已加入 DAP-Link 首版代码，等待真实探针验收。下文的 HSS、RTT、SWO、批量直读内存是后续可选能力，不能写成首版已具备或保证达到的性能。

## 当前代码基线与第一步

`rm_debug` 当前已有 Live Watch：通过独立的 GDB 连接，在一次 `liveCacheRefresh` 后刷新所监控的变量树；界面显示目标和实际采样频率。DAP-Link 与 ST-Link 当前走 OpenOCD；J-Link 走独立的 J-Link GDB Server。SWO/RTT Grapher 已存在，但它接收的是 SWO/RTT 数据，不接收 Live Watch 变量。

**第一步只做 DAP-Link 的 Live Watch Plot**：在每轮 Live Watch 读取结束时，把已取得的数值变量连同实际采样时间推给绘图模块。Plot 不再额外执行一次 GDB `evaluate` 或另起采样定时器。当前实机最快约 5 Hz，应按实际样本间隔绘制和显示频率，不把 10/20/50 Hz 写成首版承诺。采样读不到、目标停止或断线时保留时间空档，不复制上一点伪造连续曲线。首版使用 F103 测试工程的 LED 频率及另一个变化的数值字段验收。

**后续顺序**：DAP-Link 验收后，让 J-Link 复用同一个 Live Watch Plot；再接 ST-Link。三种探针都跑通后，再用性能测量决定是否增加地址解析和批量内存读取。J-Link HSS、RTT/SWO、可改固件的无线 DAP-Link 采样属于独立的高速阶段。

## 1. 目标

希望在 VS Code + Cortex-Debug 环境中实现一套不依赖特定调试器的实时变量波形显示功能，使：

- DAP-Link / CMSIS-DAP
- J-Link
- ST-Link

都能够使用统一的 Plot UI。

核心原则不是为三种调试器分别写三套波形软件，而是建立统一的：

```
变量解析
    ↓
采样后端
    ↓
统一 Sample Stream
    ↓
Ring Buffer
    ↓
Plot
```

采样后端可以按探针和数据源扩展。初版直接接现有 Live Watch 数据流，不增加新的探针协议。

## 2. 总体架构

建议结构：

```
  DAP-Link（先）      J-Link（其次）      ST-Link（最后）
        │                  │                  │
   OpenOCD/GDB        J-Link GDB         OpenOCD/GDB
        └──────────────────┼──────────────────┘
                           ↓
                  Live Watch 变量树
                           ↓
                Sample Adapter（首版）
                           ↓
             SampleFrame（真实时间和值）
                           ↓
                      Ring Buffer
                           ↓
                       Live Plot
```

上层 Plot 完全不关心：

```
DAP-Link
ST-Link
J-Link
```

只接受统一格式的数据。

例如：

```
timestamp = 125.341 ms
channel   = motor.speed
value     = 153.42
```

## 3. 后续优化：变量解析

用户在 Watch 或源码中选择：

```
motor.speed
```

后续直读内存优化需要通过：

```
GDB
ELF
DWARF
```

获得：

```
Name:
motor.speed

Type:
float

Address:
0x240013A8

Size:
4 bytes
```

如果未来要绕开 GDB 的表达式解析，必须先验证变量确实有稳定的内存地址。首版直接复用 Live Watch 已经读取的结果；不能为了画图再执行一次：

```
GDB evaluate "motor.speed"
```

适合优化的变量可以在后续阶段记录：

```
Address = 0x240013A8
Type = float32
```

之后尝试直接读取目标地址。地址在重新烧录、复位、重新连接、指针变化或符号文件变化后可能失效；寄存器变量、优化掉的变量、位域、外设寄存器、不同大小端和非连续内存也不能一律按普通 SRAM 标量处理。

即：

```
符号解析并验证地址有效期
        ↓
之后直接读内存
```

这可能减少表达式解析开销，但需要用实际探针和变量数量测量。不能假定一次解析地址适用于所有表达式或一定更快。

## 4. 两种采样模式

整个系统建议分成两级。

### Mode A：Host-Side Sampling

适合所有调试器。

架构：

```
PC
 ↓
Cortex-Debug
 ↓
Debug Server
 ↓
Probe
 ↓
SWD
 ↓
MCU Memory
```

例如：

```
DAP-Link
↓
OpenOCD
↓
SWD
↓
MEM-AP
↓
SRAM
```

周期读取变量地址。

当前首版基线：

```
DAP-Link 实测最快约 5 Hz（以作者当前工程和探针为准）
J-Link、ST-Link 逐个实测
```

具体能力根据探针、OpenOCD、SWD 时钟和变量数量决定。

优点：

- DAP-Link 支持
- ST-Link 支持
- J-Link 支持
- 不需要改 MCU 程序
- 不需要修改调试器固件
- 最容易实现

缺点：

- 采样率有限
- PC/USB/无线延迟会产生 jitter
- 不适合真正高速控制波形

因此 Mode A 应作为所有设备的基础兼容模式。首版只消费现有 Live Watch 采样结果；优化阶段再评估独立的内存读取后端及更高目标频率。

## 5. 批量读取

未来独立内存读取后端不能机械地采用：

```
read speed
read current
read angle
read output
```

四次独立请求。

在地址和内存区域均确认安全的前提下，可优先分析地址：

```
speed    0x24001000
current  0x24001004
angle    0x24001008
output   0x2400100C
```

然后执行：

```
ReadMemory
0x24001000
16 bytes
```

一次获取：

```
speed
current
angle
output
```

插件本地解析。

因此后续性能阶段可评估：

```
Address Collection
      ↓
Address Sorting
      ↓
Range Merge
      ↓
Batch Memory Read
      ↓
Local Decode
```

合并范围需有长度上限，只在同一可安全读取的内存区域内进行；不能跨越外设寄存器、无效地址或访问有副作用的区域。四次请求合成一次只是候选优化，性能与一致性均需实测。首版无需实现此步骤，也不能因此阻塞 J-Link、ST-Link 的基本绘图。

## 6. Mode B：Probe-Side Sampling

这是远期高级模式，依赖探针固件或厂商提供的采样接口。它不属于当前 `rm_debug` 的首版 Live Watch Plot。

Host 不再不停发送：

```
ReadMemory
ReadMemory
ReadMemory
```

而是一次告诉 Probe：

```
需要采样这些地址：

0x24001000 float
0x24001004 float
0x24001008 float

Sampling Rate = 1000 Hz
```

之后 Probe 自己：

```
Timer
 ↓
SWD Read
 ↓
MEM-AP
 ↓
Buffer
```

例如：

```
1 ms
读取全部变量

2 ms
读取全部变量

3 ms
读取全部变量
```

数据先进入调试器内部 Ring Buffer。

PC 每隔一段时间批量获取：

```
100 samples
```

而不是每一个 Sample 都进行一次 PC ↔ Probe 往返。

架构：

```
             MCU
              │
            SRAM
              ↑
           MEM-AP
              ↑
             SWD
              ↑
     ┌───────────────────┐
     │ Debug Probe       │
     │                   │
     │ Sample Timer      │
     │ Address Table     │
     │ Timestamp         │
     │ Ring Buffer       │
     └───────────────────┘
              ↑
        Batch Transfer
              ↑
             PC
```

## 7. J-Link 后端（DAP-Link 之后）

第二个交付阶段复用现有 J-Link GDB Server 的 Live Watch 结果：

```
J-Link GDB Server → 独立 Live Watch GDB → Sample Stream → 同一个 Plot
```

J-Link HSS 是 SEGGER J-Link SDK 提供的独立 API。现有 J-Link GDB Server 调试连接不等于已经获得 HSS 接口；若未来能合法取得并集成所需 SDK，再把 HSS 作为高级数据源评估。不能因检测到 J-Link 就自动宣称 HSS 可用。HSS 还要求目标支持运行状态下的背景内存访问。

远期可选架构：

```
Cortex-Debug
↓
J-Link Sampling Backend
↓
J-Link HSS
↓
SWD
↓
MEM-AP
```

RTT 需要目标程序写入 RTT 数据，不是任意变量读取失败后的透明降级。若 J-Link Live Watch 会话无法运行态读取，应明确报错并保留图形历史，不偷偷暂停目标，也不自动切换到未配置的 RTT。

## 8. ST-Link 后端（最后验收）

当前配置向导的 ST-Link 方案使用 OpenOCD。最后一个基础交付阶段先复用它的 Live Watch 结果：

```
ST-Link → OpenOCD → 独立 Live Watch GDB → Sample Stream → 同一个 Plot
```

后续性能阶段可以评估：

```
ST-LINK GDB Server
或
OpenOCD
```

直接读取 SRAM 的能力与性能。两种 GDB Server 需要分别验证；首版不引入新的 ST-LINK GDB Server 配置。

基础模式：

```
ST-Link
↓
SWD
↓
MEM-AP
↓
RAM
```

可用频率必须用实际设备测量，不能预设为 10–100 Hz。

如果需要更高速率，可考虑：

```
SWO / ITM
```

即：

```
MCU
↓
ITM
↓
SWO
↓
ST-Link
↓
PC
```

这样采样由 MCU 控制，可以得到更稳定的高速数据流。

因此 ST-Link 的迭代顺序为：

```
已有 Live Watch 数据源
↓
经验证的批量背景内存读取
↓
需要目标芯片与探针支持的 SWO / ITM
```

## 9. DAP-Link / CMSIS-DAP 后端

基础模式使用：

```
CMSIS-DAP
↓
OpenOCD
↓
SWD
↓
MEM-AP
```

首版复用已有 Live Watch 读取的变量值，不增加新的 Memory Read。批量读取只作为后续优化候选。

第一阶段目标：

```
数值波形与 Live Watch 同步刷新
横轴使用实际时间戳
显示实测频率（当前环境最快约 5 Hz）
不因打开 Plot 显著增加 GDB 请求或拖慢已有刷新
```

确认有线 DAP-Link 可用后，再针对无线 DAP-Link 测量实际频率、延迟和丢样。

如果是无线 DAP-Link，应特别减少：

```
PC ↔ Probe request-response
```

次数。

后续高频阶段可以评估：

```
批量地址读取
+
批量 Sample 传输（须有固件/协议支持）
```

## 10. DAP-Link 高级模式

如果拥有并能修改 DAP-Link 固件源码，可以评估类似 HSS 的功能。这需要独立设计固件协议、时钟、缓存溢出处理和主机驱动，单靠 VS Code 扩展不能让普通 DAP-Link 自动获得探针端采样。

例如使用 CMSIS-DAP Vendor Command：

```
HSS_CONFIG
HSS_START
HSS_STOP
HSS_READ
```

配置：

```
address count
address list
sample size
sample rate
buffer size
```

Probe 内：

```
Hardware Timer
      ↓
Sampling Engine
      ↓
CMSIS-DAP SWD Access
      ↓
MEM-AP
      ↓
Ring Buffer
```

这对无线 Probe 特别重要。

因为无线最大的限制通常不是带宽，而是：

```
Latency
+
Jitter
```

Probe-Side Sampling 可以让无线链路只负责：

```
批量传输采样结果
```

而不参与每一次 Sample 的时序。

## 11. RTT 后端

为了获得更高速率，应设计统一 RTT 数据源。

MCU 控制环：

```
theta
theta_dot
output
current
```

周期写入：

```
RTT Ring Buffer
```

然后：

```
Probe
↓
读取 RTT
↓
PC
↓
Plot
```

优点：

```
采样时间由 MCU 控制
```

例如控制循环本身为：

```
1 kHz
```

则目标程序可以每次循环生成一个 Sample，理论生成速率为：

```
1 kHz Sample Stream（需要实测传输吞吐和丢样）
```

缺点是需要：

```
修改目标程序
```

因此建议：

```
普通 Watch
→ Background Memory

高速 Plot
→ RTT
```

## 12. SWO 后端

对于支持 SWO 的芯片和探针，可以增加：

```
ITM / SWO
```

数据源。

例如：

```
STM32
↓
ITM Port
↓
SWO
↓
ST-Link / J-Link
↓
Cortex-Debug
↓
Plot
```

适合：

```
高速整数
float
事件
状态变化
```

因此最终数据源可能为：

```
Memory Sampling
RTT
SWO
J-Link HSS
Custom DAP HSS
```

## 13. 统一数据接口

所有后端最终输出统一结构。首版每轮 Live Watch 完成后生成一帧；不能把一轮中先后读取的多个字段误称为硬件同时采样：

```
SampleFrame
{
    sessionId: string
    timestampMs: number       // 主机收到这一轮结果的实际时间
    values: {
        "motor.speed": 153.42,
        "motor.current": 2.1
    }
}
```

`channelId` 采用稳定的表达式或变量树路径；只收有限的整数/浮点标量。空指针、结构体、字符串、读取失败、NaN/Infinity 不画新点，并向界面标记缺样。暂停、重新烧录或重启调试会话后使用新的 `sessionId`，避免把不同会话的时间轴和变量地址串接起来。将来接入 RTT/SWO/HSS 时可扩展来源与源端时间戳字段。

Plot 不应该知道数据来自：

```
J-Link HSS
DAP-Link
ST-Link
RTT
SWO
```

它只处理：

```
SampleFrame
```

## 14. Timestamp

波形系统不能只保存：

```
value
```

必须保存：

```
timestamp
+
value
```

否则无线或者 USB 出现延迟后，波形时间轴会错误。

Host-Side Sampling 首版：

```
每轮 Live Watch 完成时记录主机时间
```

这个时间是“结果到达时间”，不是 MCU 的精确采样时刻。GDB 逐项读取的字段也不是原子快照；曲线应显示实际间隔，丢失的轮次应留空。可同时记录单调时钟用于间隔计算，避免系统时钟调整影响频率计算。

Probe-Side Sampling：

优先使用：

```
Probe Timestamp
```

RTT：

优先使用：

```
MCU Timestamp
```

例如：

```
DWT Cycle Counter
Hardware Timer
RTOS Tick
```

多个时间源混合显示时需要校准时钟基准；未经校准不能把不同来源的时间戳当作完全同步。

## 15. Ring Buffer

所有实时数据先进入有容量上限的 Ring Buffer：

```
Sample Backend
     ↓
Ring Buffer
     ↓
Plot Renderer
```

不要：

```
采一个点
↓
立刻重画一次 UI
```

低频首版例如：

```
实际 Sampling ≈ 5 Hz
UI Refresh ≤ 5 Hz
```

UI 可以按收到的帧重画，但不能靠每秒 30 次空绘制造更高采样率。后续若引入 1 kHz 数据源，再批量入缓冲并限制绘图帧率。按时间窗口或点数限制内存，隐藏 WebView 时也要避免无限积累。

## 16. Sample Rate 和 UI Rate 必须分开

必须明确区分：

```
Sampling Rate
```

和：

```
Plot Refresh Rate
```

例如首版：

```
Live Watch 请求 10 Hz
实际收到约 5 Hz
Plot UI 随收到的样本刷新，显示“实际约 5 Hz”
```

绘图设置不改变现有 Live Watch 采样频率；首版不能新增第二个定时器并重复读取 MCU。未来高速来源的采样率与 UI 刷新率仍应独立配置。

## 17. Plot UI

用户对 Live Watch 中可读取的数值标量右键：

```
Add to Live Plot
```

例如：

```
motor.target
motor.feedback
motor.output
```

出现：

```
Live Plot

target      ─────────────
feedback     ╭───────────
          ───╯
output
```

首版基本功能：

- Pause
- Resume
- Clear
- Auto Scale
- Fixed Scale
- Time Window
- Current Value
- 实际采样频率与最近更新时间
- Hide Channel
- Remove Channel

下一轮补齐 Cursor、Zoom、Min/Max/Average、Export CSV；不让这些界面功能拖延首版探针接入。

## 18. 后端选择与能力检测

首版后端是当前调试会话的 Live Watch 数据流。可从 `launch.json` 的 `servertype` 判断该会话为 OpenOCD 或 J-Link GDB Server，但探针型号本身不能证明 HSS、RTT、SWO 或运行态直读内存可用。没有成功接入的实际数据源时，不显示为“可用”。

以后增加高级来源时，先探测必需工具、接口、目标芯片能力和已配置的目标程序通道，再让用户明确选择。自动降级只在已验证、语义相同的数据源之间进行；RTT/SWO 需要目标端配合，不能替换任意变量的 GDB 读取。用户设定 1 kHz 但当前后端实测约 5 Hz 时，提示能力不足并显示实测值，不改变横轴比例。

## 19. Backend Priority

**交付顺序**：DAP-Link → J-Link → ST-Link，均先走同一套 Live Watch Plot。**运行时选择**：优先使用当前会话已成功工作的 Live Watch 数据源；未来经验证后，可由用户启用直读内存、RTT/SWO、J-Link HSS 或自定义 DAP 探针端采样。运行时优先级依据实际可用性、目标程序配置和实测稳定性决定，不用探针名称硬编码为“J-Link 必定 HSS”。

## 20. 非侵入原则

实时波形默认不得：

```
halt
read
resume
```

因为这会破坏：

```
PID
LQR
FOC
CAN
UART
RTOS
PWM
DMA
```

时序。

如果目标平台无法运行状态读取，应明确提示：

```
Non-intrusive sampling unavailable.
```

而不是偷偷暂停 CPU。

## 21. 推荐代码结构

首版只需要在现有 `src/frontend/views/live-watch.ts` 的刷新完成处发出样本事件，并增加少量独立模块：

```
LiveWatchTreeProvider
    ↓  一轮真实读取完成后发 SampleFrame
SampleBuffer（时间窗口和点数上限）
    ↓
LivePlotPanel（WebView 中的曲线）
```

Plot 按变量树路径订阅已读取的数值；被绘图的字段在父节点折叠后仍沿订阅路径于现有采样轮次内更新，移除曲线后释放该订阅。它可能使原本折叠后不再读取的字段继续占用少量 GDB 通信，因此界面应显示订阅数量和实测频率。绘图模块不得建立额外采样定时器，也不得为同一数值另发一轮 `liveEvaluate`。后续若性能测量证明需要新来源，再定义 `SamplingBackend` 接口并分别增加内存读取、RTT/SWO、HSS 模块；先不创建一整套空的探针专属文件。

## 22. 开发阶段建议

### Phase 1：DAP-Link（现在先做）

- 复用现有 DAP-Link/OpenOCD Live Watch 样本，不增加一轮 GDB 读取。
- 支持从已读取的整数/浮点变量添加曲线，多个变量共用一张图；提供暂停/继续、清空、时间窗口、Y 轴自动/固定范围、隐藏/移除变量、当前值和实际频率。
- 样本带真实主机时间，按时间窗口限制缓存；读取失败或会话停止时出现空档，不能把设定的 10 Hz 画成 10 个点。
- 用 F103 LED 工程与至少两个变化变量验收。以当前约 5 Hz 为初始性能基线，在相同变量订阅和探针条件下各观察约 30 秒，记录 Plot 开关前后的实际刷新频率和 GDB 请求数；若绘图使刷新明显变慢，先修复再推进 J-Link。

### Phase 2：J-Link

复用同一个 Plot 和 SampleFrame，从现有 J-Link GDB Server 的 Live Watch 数据取得数值。验收变量值、实测频率、暂停/继续、断开连接与切换调试会话。J-Link HSS 不在本阶段范围。

### Phase 3：ST-Link（最后）

用当前配置向导的 OpenOCD + ST-Link 路径接入同一个 Plot。按 Phase 1 的标准实测，不能直接沿用 DAP-Link 或 J-Link 的频率结论。ST-LINK GDB Server 是日后单独评估的替代配置。

### Phase 4：性能优化

在三种基础链路可用后，先测量 `liveCacheRefresh`、变量树刷新、WebView 绘图各自耗时。只对适合直接读的稳定 SRAM 标量验证地址解析、内存范围合并、批量读取和类型解码；出现失败时回到已验证的 Live Watch 路径。目标频率按每种探针的实测结果决定，不预先承诺 50、100 或 200 Hz。补齐 Cursor、Zoom、统计值、CSV。

### Phase 5：可选高速数据源

按真实使用需求分别评估 RTT、SWO、J-Link HSS 及可修改固件的无线 DAP-Link 探针端采样。RTT/SWO 需要目标程序或硬件配合；J-Link HSS 需要确认 J-Link SDK 接入条件；自定义无线 DAP 需要另做探针固件和主机协议。kHz 级采样只在对应后端完成并实测后列为能力。

## 23. 最终设计目标

基础绘图体验由同一套界面提供。用户操作为：

```
右键变量
↓
Add to Live Plot
```

基础数据源按实际调试会话连接：

```
DAP-Link
→ OpenOCD Live Watch

J-Link
→ J-Link GDB Server Live Watch

ST-Link
→ OpenOCD Live Watch
```

高级来源经单独配置和验收后，仍输出相同的 SampleFrame，再进入同一个 Plot。

```
DAP-Link（先）  J-Link（其次）  ST-Link（最后）
        \           |           /
          Live Watch SampleFrame
                   ↓
             Ring Buffer
                   ↓
               Live Plot
```

设计原则：**统一上层体验，逐个验收探针，使用真实采样时间与实测频率；高级后端按能力和配置明确启用。**

## 参考依据

- [OpenOCD：使用 GDB 在运行态查看内存](https://openocd.org/doc-release/html/GDB-and-OpenOCD.html#Using-GDB-as-a-non_002dintrusive-memory-inspector)：运行态背景读取依赖目标能力；多 GDB 连接需要谨慎处理。
- [SEGGER：J-Link High-Speed Sampling](https://kb.segger.com/HSS)：HSS 是 J-Link SDK 的 API，不能把普通 J-Link GDB Server 会话等同于 HSS。
- [OpenOCD：read_memory 命令](https://www.openocd.org/doc/html/General-Commands.html)：存在批量读接口，但可用范围和运行态行为仍要在实际目标上验证。
