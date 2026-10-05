# 独立 Trace、代码热点与覆盖率：给 Luna 的实施方案

> 状态：设计与分阶段实施说明。第一阶段 SWO PC 采样热点代码已实现并完成静态构建检查；录制流测试、实机链路验证和 ETM 精确覆盖率尚未完成。硬件行为仍需在实际板卡上确认。

## 0. 当前代码进度与刷新率保护

当前已加入一个独立 Trace 视图与首个统计采集切片：Trace 通过现有 `SWOCore` 旁路订阅 ITM hardware source 2 的 4 字节 PC 样本；1 字节 sleep 样本单独计数。Trace 不打开第二个 SWO 连接，不向 DAP/GDB 发起读取或内存请求，也不调用 Live Watch provider 或修改它的采样定时器。启动 Trace 前要求当前调试配置已启用 `swoConfig.enabled` 和 `swoConfig.profile`；Trace 不会为了开始采集而在运行中写 DWT 寄存器。

PC 接收路径只向固定容量的 `SharedArrayBuffer` 环形队列写入一个地址。符号查找、样本累计、热点排序均在独立 Node Worker 执行。队列满时丢弃新样本并在统计/报告里计数，不等待 Worker，不让队列无界增长。Trace 的视图最多每秒更新一次；Live Watch 的 DAP 读取循环不变。这个结构避免 Trace 与 Live Watch 争用 DAP 请求队列。探针/USB 的物理带宽和 VS Code 所在机器的总负载仍需实机测量，不能仅凭源码证明整机刷新频率绝无变化。

当前视图和 CSV/JSON 报告只给出函数热点及 PC 地址样本分布，并标记质量为 `sampled`。PC 样本没有命中的行/地址不能视为未执行，因此当前没有提供精确行覆盖率或指令覆盖率；视图和 JSON 会明确标注这一限制。确切覆盖率要等到后文的 ETM/完整指令流采集、解码和完整性验证完成后再启用。

## 1. 先明确产品边界

Trace 与 Live Watch 是 **并列功能**。Trace 的生命周期、采集数据、视图、设置、导出和诊断都独立于 Live Watch。两者可以在同一调试会话中同时使用，但关闭其中一个不能让另一个停止。SWO 采集源可以共享，不能由两个功能分别抢占探针或 TCP 端口。

本功能分为两种结果，界面和报告必须用不同名称：

| 数据源 | 可以做什么 | 不能声称什么 |
|---|---|---|
| DWT/ITM 经 SWO 发出的周期性 PC 样本 | 统计函数、源码行和指令地址的**样本命中数/占比**，显示热点；导出样本报告 | 样本没命中不代表代码没执行，不能叫“精确行覆盖率”“精确指令覆盖率”，也不能推算精确执行次数 |
| 连续且可完整解码的 ETM/其他**指令流 Trace** | 重建本次捕获窗口内执行过的指令；据此计算指令命中和映射后的行命中，生成覆盖率报告 | 若采集开始较晚、存在丢包或无法恢复的解码间隙，不能宣称整个程序或该窗口的完整覆盖率 |

首个交付优先 **DAPLink/CMSIS-DAP + OpenOCD + SWO PC 采样**，让作者当前链路先得到可用的统计热点。ST-Link 和 J-Link 复用同一套 PC 事件、分析器和视图，仅采集入口按探针配置。精确行/指令覆盖率列为下一阶段，只有真实 ETM/Trace 数据源可用并完成完整性验证时才启用。不要用 PC 样本填充精确覆盖率百分比。

“所有 Link 都生效”的可实现含义是：三种探针共用相同的产品入口与报告格式；每台探针启动时检测芯片、固件、连线和调试服务器的实际能力。支持 SWO 时启用统计分析，支持完整指令流 Trace 时启用精确覆盖率；不支持时明确显示原因和可选接线/工具方案。**不能仅凭探针品牌推断能力**。尤其无线 DAPLink 和仅有 SWDIO/SWCLK 的接线不保证 SWO 数据能到电脑。

## 2. 当前源码中已经有的基础

实现前先读这些文件，不要另造一个 SWO 客户端：

| 文件 | 已有能力 | 需要修改的点 |
|---|---|---|
| `cortex-debug-master/src/common.ts` | `SWOConfiguration.profile`；`getGDBSWOInitCommands()` 在 `profile=true` 时调用 `EnablePCSample` | 新 Trace 配置应驱动该开关，且不破坏现有 `swoConfig` 用户配置 |
| `cortex-debug-master/support/gdbsupport.init` | `EnablePCSample`/`DisablePCSample` GDB 命令 | 核对寄存器设置和恢复时机，避免覆盖其他使用 DWT 的功能 |
| `cortex-debug-master/support/gdb-swo.init` | 初始化 TPIU、ITM、DWT 和 SWO | 当前直接写 DWT CTRL；修改时采用按位读改写并保留无关位，不要把某一板卡时钟写死 |
| `cortex-debug-master/src/frontend/extension.ts` | 根据 `swo-configure` 创建 SWO 数据源；按会话创建 `SWOCore` | 在同一会话中把 Trace 订阅接到现有源，连接失败要传回 Trace 状态 |
| `cortex-debug-master/src/frontend/swo/core.ts` | `ITMDecoder` 识别 hardware packet；`SWOCore.processPacket()` 已识别 `port === 2` 的 PC 样本并发给旧图窗 | 把已解码事件分发给独立 Trace 服务；处理睡眠样本、溢出和失步；保留现有 SWO 控制台/图形功能 |
| `cortex-debug-master/src/openocd.ts`、`src/stlink.ts`、`src/jlink.ts` | 三类服务端各自配置 SWO；J-Link 也调用 `EnablePCSample` | 按真实链路逐一接通、记录能力；不要依赖 Live Watch GDB 连接 |
| `cortex-debug-master/src/backend/symbols.ts`、`src/symbols.ts` | ELF 函数符号表与地址范围 | 提供 Trace 地址到函数映射；源码行还需 DWARF/`addr2line`，不能只靠函数表 |
| `cortex-debug-master/package.json` | 声明命令、侧栏视图和调试配置 schema | 注册独立 Trace 命令/视图及 `traceConfig`；把设置写进 Debug 配置 schema 后再让向导生成 |
| `cortex-debug-master/src/frontend/views/live-watch.ts` | Live Watch 独立 GDB 和采样定时器 | Trace **不能**绑到这里的定时器、订阅树或 `liveWatch.enabled` |

当前 `SWOCore` 对 PC 包只更新旧 Graph，并没有独立 Trace 报告。`ITMDecoder` 的 overflow 回调目前是空实现；1 字节的 sleep PC sample 与 4 字节 PC sample 也不能当成同一种 PC 地址处理。这些都是第一阶段的必要修正。

## 3. 硬件与软件能力门槛

### 3.1 SWO PC 采样门槛

启动时逐项检测并在 Trace 面板展示结果：

1. 当前芯片有 DWT/ITM/TPIU 和可用 PC sampling 功能；实际位/寄存器以 CMSIS 头文件与芯片文档为准。
2. ELF 含目标固件的符号和调试信息；至少有函数符号才能统计函数，DWARF 行表完整时才能映射源码行。
3. SWO 引脚已从 MCU 引出并连到支持接收的探针，或连接到单独的 SWO 串口接收器。STM32F103 示例工程不能只因为有 SWD 线就判定 SWO 已接通。
4. 当前 CMSIS-DAP、ST-Link 或 J-Link 型号/固件以及 OpenOCD/GDB Server 确实能交付连续 SWO 字节。某个品牌的部分型号可能不支持。
5. SWO 输入时钟、UART/Manchester 模式、目标时钟和探针可接受速率相符；Core Clock 改变后需重新配置或停止，并提示用户。
6. 无数据、同步失败、overflow 和源端 buffer overrun 分别显示，不要统称“没有热点”。

在当前插件中，配置可以沿用 `swoConfig.enabled=true`、`swoConfig.profile=true` 和现有 `cpuFrequency`/`swoFrequency`/`source` 字段。新增 `traceConfig` 只管理 Trace 产品行为，例如是否启用、分析模式、导出目录、最大缓存；不要让用户同时在两处填写两套相冲突的 SWO 波特率。若使用外部 SWO 接收器，复用现有 `swoConfig.source=serial` 路径，但在界面标明还需额外硬件。

`swoConfig` 的硬件初始化发生在调试会话启动期间。若当前会话启动时没有配置 SWO，用户在 Trace 面板按“开始”不能凭空创建数据源，应提示补齐配置并重启调试。第一阶段的“开始/停止”控制 **Trace 记录与分析**；SWO 仍可供现有控制台使用。若将来要在运行中开关 DWT PC 采样，必须经过 Debug Adapter 安全写寄存器并验证该 GDB Server 在目标运行时不会隐式停机，不能由 Webview 直接写。

### 3.2 精确覆盖率门槛

必须同时有可用的指令 Trace 生成器（如适用的 ETM）、能捕获该数据流的实际硬件和连线、与该芯片 Trace 版本兼容的解码器、匹配的 ELF/反汇编，以及捕获完整性信号。普通 SWO PC sampling 只有稀疏样本，不满足这一条件。OpenOCD 有 ETM/TPIU 命令，但这不代表任意 DAPLink/ST-Link 都能捕获 ETM 数据；需要针对目标、探针、连接方式做一次实际 PoC，再写正式适配器。

当条件不满足时，Trace 面板仍可提供统计热点，但精确覆盖率页显示“当前链路无完整指令 Trace”，并列出缺少的硬件或采集路径。不能静默降级后继续展示精确百分比。

## 4. 软件结构：并列模块，共用 Trace 数据模型

建议在 `src/frontend/trace/` 新建模块；`resources/trace-*.html` 放视图资源。需要进 Debug Adapter 的采集控制放 `src/` 的后端请求实现，不要把硬件寄存器写入 Webview。模块边界：

```text
调试会话 / 探针 / OpenOCD 或 J-Link Server
             │
      现有 SWO source（单一所有者）或未来 ETM source
             │
    TraceTransportAdapter：原始字节 + 丢包/断连状态
             │
    TraceDecoder：PC sample / sleep / sync / overflow，或完整指令流
             │
    TraceSession：按 sessionId 管理开始、停止、暂停、统计、导出
             │
    Symbolizer：ELF + DWARF 地址映射与缓存
             │
    Trace 分析器 ── Trace 视图 / 源码热点标记 / 报告导出
```

建议的内部事件结构（字段可根据项目风格调整，但语义不能删）：

```ts
type TraceEvent =
    | { kind: 'pc-sample'; sessionId: string; coreId: number; rawPc: number;
        hostTimeMs: number; targetTime?: bigint; source: 'swo' | 'pcsr-poll' }
    | { kind: 'sleep-sample'; sessionId: string; coreId: number; hostTimeMs: number }
    | { kind: 'executed-instruction'; sessionId: string; coreId: number; pc: number;
        targetTime?: bigint; source: 'etm' }
    | { kind: 'capture-gap'; sessionId: string; reason: 'overflow' | 'lost-sync' |
        'disconnect' | 'decoder-error' | 'buffer-overrun'; atMs: number };
```

`TraceSession` 保存 `sessionId`、ELF 路径及 SHA-256、芯片/探针、实际传输类型、采集开始/结束时间、事件数、丢包/失步数、未映射地址数和 `quality`。`quality` 只能是 `sampled`、`complete-instruction-trace`、`incomplete-instruction-trace` 或 `unavailable`。数据源变了就新建捕获窗口，不把旧 ELF 的地址与新 ELF 混算。

前端注册 `rm-debug.trace.show`、`rm-debug.trace.start`、`rm-debug.trace.stop`、`rm-debug.trace.export` 等命令，以及与 Live Watch **同级**的 Trace 视图。VS Code 调试会话结束时停止采集并保留上一份报告供导出；窗口隐藏时仍按用户的“开始采集”状态工作，不能以 Webview 是否可见作为采集开关。

## 5. 第一阶段：DAPLink 优先的统计热点

### 5.1 采集

1. 使用现有 `swoConfig.profile` 启用 DWT 周期性 PC 采样和现有 SWO source。初次配置向导可提供“启用 Trace PC 采样”选项，但不要强行覆盖用户已有 SWO/ITM 设置。
2. `SWOCore` 继续作为 SWO 字节流唯一接收者。给解码结果增加只读订阅者；原有 SWO console、binary、graph 仍收到同一份事件。不要再次连接同一个 SWO TCP 端口，也不要让 Trace 读取 Live Watch 样本。
3. 只把 **hardware source ID 2、4 字节 payload** 当成 PC 样本；1 字节 payload 是 sleep 类样本，单独计数。PC 按小端解码。其他 hardware packet、ITM 软件 port 2 的数据绝不能误判为 PC 样本。
4. 识别同步、失步、overflow、源端 buffer overrun 和连接中断；将其记录成捕获质量信息。出现溢出时，已有 PC 样本仍可用于统计，但报告标明“有数据丢失”。
5. 保留原始 PC，同时清除 Thumb 状态位后做符号查找；在 TypeScript 中用 `(rawPc & ~1) >>> 0` 保持无符号 32 位地址。PC 样本不能机械减 1（减 1 适用于部分返回地址/调用栈归属规则，不能套用到正在执行的 PC）。未知地址单独计数。
6. 每个事件记录 host 收到时间；只有解码出的目标 timestamp 才能用于精确目标时间。host 到达时间可能因 USB/TCP 批量传输而抖动，不要把它称为指令执行时间。
7. 采集队列设置字节/事件上限；超过上限时记录 gap 和丢弃数量，不得无界增长导致 VS Code 卡住。PC 接收回调只写固定容量共享环形缓冲区；符号查找和统计放到独立 Worker。Trace Webview 最多每秒更新一次，不能在 PC 包回调里排序、映射符号、写文件或推送 Webview。

现有 `EnablePCSample` 把 `DWT_CTRL` 的 PC 采样位打开；实现者必须核对 `DWT_CTRL.NOTRCPKT`、`PCSAMPLENA`、`CYCTAP`、`POSTINIT`、`POSTPRESET` 等位与芯片实际行为。修改 `gdb-swo.init` 时不要整寄存器覆盖 DWT 其他功能；启动后读回关键位验证，停止时只撤销本功能设置的位。SWO 时钟配置必须使用实际 HCLK/Trace Clock，不能默认所有 STM32 都是 72 MHz。

### 5.2 地址解析与统计

- 加载当前调试会话的 ELF，计算 SHA-256。函数归属复用项目符号表；源码文件、行号和内联调用链用 `arm-none-eabi-addr2line -f -C -i -e <ELF>` 或等价 DWARF 解析。对唯一 PC 批量解析并缓存，不能每收到一个样本启动一个进程。
- 分别统计 `totalPcSamples`、`sleepSamples`、`mappedSamples`、`unmappedSamples`、每函数/每源码行/每指令地址样本数。函数占比的分母只采用明确写在 UI 中的样本集合，例如“有效 PC 样本”；中断函数和异常处理函数应照常统计。
- 源码行热点可以高亮或按样本占比排序；没有 DWARF 行号时仍显示函数/地址统计，并解释为什么没有行视图。内联函数需要保存完整调用链，界面可显示最内层位置，不应把样本重复计入多个函数的总体百分比。
- 第一阶段报告标题写 **“PC 采样热点”**。可以显示“命中样本的行/指令地址”，但不要显示 `line coverage %` 或 `instruction coverage %`。样本数不等于执行次数或 CPU 周期数。

### 5.3 三种探针的接入顺序

1. **DAPLink/CMSIS-DAP + OpenOCD**：先在作者现有 F103 工程上做能力探测，确认实际探针固件和接线有 SWO。能收到 PC 包才标记成功。若当前无线 DAP 不承载 SWO，记录“探针没有 SWO 输入/转发”，允许接外部 SWO 串口接收器，不能虚构数据。
2. **ST-Link + OpenOCD/ST-LINK GDB Server**：复用已有 SWO source，验证当前 ST-Link 型号、服务器以及 SWO 引脚。不能只凭设置存在就判为可用。
3. **J-Link**：复用 `jlink.ts` 的 SWO 配置与 `EnablePCSample`；确认 SWD 模式和真实 SWO 数据输入。JTAG 模式下该插件当前会拒绝 probe SWO，显示对应能力原因。

如果 DAPLink 只有 SWD、没有 SWO，可在第二阶段做 **实验性 PCSR 轮询**：借现有独立 GDB 连接尝试读取 DWT PCSR（CMSIS 地址 `0xE000101C`），但必须先在目标运行时验证服务器允许无停机读取，而且不会频繁暂停或扰乱 Live Watch。成功也只能标记为 `pcsr-poll` 的统计样本；失败时自动禁用，并记录错误。该路径不能作为“所有 DAPLink 都支持”的默认承诺。

## 6. 第二阶段：精确指令流与覆盖率

### 6.1 先完成硬件 PoC

选一个明确支持 ETM、Trace 引脚已引出、配有可捕获 Trace 的探针/适配器的芯片与板卡。先从实际采集工具拿到一份**可重复解码**的原始流或执行地址序列；记录目标芯片、ETM 版本、时钟、Trace 端口宽度、探针型号、服务器版本、解码器版本与是否出现 overflow。未做成这个 PoC 前，精确覆盖率 UI 保持不可用。

适配器要么输出经过验证的 `executed-instruction` 地址序列和 gap 状态，要么把原始流交给与该 ETM 版本匹配的专用解码器。不要把 OpenOCD 的旧 `etm dump`、SWO PC 样本或任意 byte stream 直接当作“完整指令流”。OpenOCD 文档中的 ETM 操作能力取决于 trace port driver 和采集硬件；工程本身目前也没有 ETM 指令流解码器。

### 6.2 覆盖率定义

- **范围**：只对本次采集窗口、当前 ELF 中选择的可执行代码区域和核计算。多核、bootloader、动态加载代码或外部 ROM 需分别关联对应 ELF；未知区域不计入分母，并在报告中列出。
- **指令分母**：由当前 ELF 的可执行段和可信反汇编建立地址集合；应避免把 `.text` 中的内嵌数据误判为指令。反汇编无法可靠确定边界时，标为部分覆盖率，不给完整百分比。
- **行分母**：将上述指令地址映射到 DWARF 有效源码行，去重成可执行行。无行号、人工汇编或源码缺失要列为未映射，不把它们算成“未覆盖行”。
- **命中**：只由成功解码并确认实际执行过的指令产生。一个源码行的任一有效指令被执行，该行才算命中；行内部分指令命中可另列“部分命中”，不能忽略这一层差异。
- **完整性**：仅当解码器从可确定的同步点重建该捕获区间、无不可恢复 gap、ELF 匹配、捕获开始/结束边界明确时，标记 `complete-instruction-trace`。任何 overflow、失步、断线或译码错误都把该窗口标成 `incomplete-instruction-trace`；仍可保留已确认的命中下界，但不能显示可信的完整覆盖率百分比。
- **性能分析**：精确指令 Trace 可以统计观察到的指令/函数执行次数；只有 Trace 中有可靠周期/时间信息时才给出耗时和 CPU 占比。单凭指令条数不能推出执行时间。

### 6.3 报告导出

第一阶段：导出 UTF-8 CSV 和 JSON。包含 session/ELF SHA-256、目标、探针、采集模式、起止时间、PC 样本总数、sleep/未知/丢包数、函数/行/地址样本数；CSV 文件名及表头明确写 `pc_samples`、`sample_count`，不写 `coverage`。

第二阶段：在 `quality=complete-instruction-trace` 时，额外导出 `instruction_coverage.csv`、`line_coverage.csv` 和可选 LCOV（`DA`/`LF`/`LH`），并保留解码器版本、ELF 哈希和采集窗口。质量不完整时可导出 `observed_hits.csv/json`，但报告首页显著写明“不完整 Trace；仅确认已观察到的命中，未命中不能当作未执行”。同名文件不得静默覆盖；目标目录由用户选择。

## 7. UI 与状态规则

- 左侧 `rm_debug` 下新增与 **Cortex Live Watch** 同级的 **Trace** 入口。Trace 面板顶部显示：`未配置 / 检测中 / 正在采集 / 暂停 / 已停止 / 不支持 / 错误`，以及模式、实际 PC 样本速率、丢包数和 ELF 名称。
- 分页为 **热点（函数/行/指令地址）**、**覆盖率（仅完整指令 Trace）**、**采集诊断**。Trace 的开始/停止/清空/导出按钮独立于 Live Watch。点击行可跳到源码或反汇编。
- 源码装饰器显示“PC 样本热点”或“指令 Trace 已执行”；颜色和 tooltip 必须标注数据来源。未观察到的行不能涂成“未覆盖”，除非存在完整覆盖率证据。
- 会话结束或 ELF 变更时停止采集。暂时没有样本时写“等待 SWO PC 数据”，并显示探针/接线/时钟的检查入口；不能只显示 `not available`。
- 采集诊断显示原始数据字节数、解析包数、PC/sleep/其他包数、同步/overflow/断连次数、未映射样本数和最近错误。Trace 质量变化时在输出面板 `rm_debug Trace` 写一条简短日志。

## 8. 实施顺序与验收门槛

1. **已实现：拆出独立 Trace 状态**：新增独立视图、开始/停止/清空/导出命令和会话状态；没有调用 Live Watch provider，也没有修改 `liveWatch.enabled` 或 Live Watch 的采样定时器。
2. **代码已接入，尚未用录制流验收：复用 SWO PC 包**：现有 ITM decoder 只把 hardware source 2 的 4 字节包识别为 PC，把 1 字节包作为 sleep；overflow、失步和断连会记 gap。老 SWO console/graph 继续共用原始包。接收队列是固定容量并在满载时记丢样。仍需用录制流验证跨 chunk 分包、同步、失步和溢出场景。
3. **待实机验收：DAPLink 优先**：以 `test_cortex` 的当前 ELF、明确的 SWO 接线与探针能力为准；能持续收到 PC 样本、显示热点、停止后导出 CSV/JSON。若探针没有 SWO，则给出明确“不支持及原因”，不算统计成功。
4. **待实机验收：ST-Link/J-Link**：同一份录制流经各自 transport adapter 后得到一致的 PC 事件；实机确认可用型号和限制。当前统计器复用统一的现有 SWO source，探针能力仍需逐台确认。
5. **待实现：ETM PoC 与精确覆盖率**：在 Trace 硬件上验证原始流、解码器、同步及丢包信号；然后才接入 coverage UI/LCOV。只做出样本热点不得宣称完成本项。
6. **待回归**：与 Live Watch 同时开启、关闭任一功能、SWO console 共存、重复连接/断线、目标复位、芯片时钟变化、ELF 更新、无 DWARF、采集溢出和多窗口会话。任何失败都不得把上一份报告错配到新 ELF。

本项目无法在没有实际 SWO/ETM 硬件和目标板数据的情况下证明三种探针都能采集。源码静态检查和录制流测试只证明解析逻辑；硬件能力表必须由实机验证填写。

## 9. 实施者可查的原始资料

- [Armv7-M Architecture Reference Manual](https://documentation-service.arm.com/static/5f8fedcbf86e16515cdbf30f)：附录 D4 的硬件源 ID 2、4 字节 PC 样本和 1 字节 sleep 样本格式；当前 STM32F103 是 Cortex-M3，应优先按这一版核对。
- [Arm CMSIS Cortex-M3 寄存器定义](https://github.com/ARM-software/CMSIS_5/blob/develop/CMSIS/Core/Include/core_cm3.h)：DWT/ITM/DEMCR 位定义和 PCSR。
- [ST AN4989 STM32 调试工具箱](https://www.st.com/resource/en/application_note/an4989-stm32-microcontroller-debug-toolbox-stmicroelectronics.pdf)：SWV/PC sampling、SWO 引脚和目标配置。
- [OpenOCD TPIU/SWO 与 ETM 文档](https://openocd.org/doc/html/Architecture-and-Core-Commands.html)：SWO 输出方式及 ETM 对 trace port driver 的依赖。
- [ARMmbed DAPLink CMSIS-DAP SWO 接口](https://github.com/ARMmbed/DAPLink/blob/main/source/daplink/cmsis-dap/DAP.h)：SWO 模式、状态、overflow 与 buffer 能力；具体探针固件仍需检测。
- [SEGGER Ozone Trace 功能边界](https://www.segger.com/products/development-tools/ozone-j-link-debugger/technology/trace-features/)：指令 Trace、Timeline、profiling 与 coverage 所需的目标和 Trace 探针条件。
