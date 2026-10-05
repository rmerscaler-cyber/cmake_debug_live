# Cortex-Debug 增强调试插件开发需求文档

## 一、项目背景与总体目标

**插件定位与使用范围**：这是基于 Cortex-Debug 修改的个人插件，首要目标是在作者自己的 VS Code 中稳定安装和使用，不上架、不销售。必要时可以把源码或构建好的 VSIX 文件交给团队成员内部使用，因此项目必须保留上游的许可证、版权声明和必要的第三方声明；团队使用时也要一并提供这些文件。不要把“仅自己使用”当作删除上游声明或忽略许可证条件的理由。当前不要求公开上架或支持任意用户的全部环境，但应保留清晰的安装步骤、可复现的打包步骤和必要的配置说明，方便本人重装或团队成员按步骤安装。

我目前的 STM32 开发环境为 VS Code + CMake + Ninja + OpenOCD，主要使用 Cortex-Debug 完成程序烧录和调试，也会在部分场景下使用 SEGGER Ozone。当前开发环境已经能够满足代码编写、CMake 配置、Ninja 编译、OpenOCD 烧录、断点调试、单步执行、查看变量等基本需求，因此本项目不希望更换整套开发工具链，也不希望强制依赖 J-Link。

我目前同时会使用普通有线 CMSIS-DAP/DAP-Link 调试器以及可以无线连接的 DAP-Link 类调试器。无线调试对于机器人实机调试非常有价值，例如机器人在运动、云台旋转、底盘行驶或者机构执行动作时，不需要始终通过 USB 调试线连接电脑。因此，本项目必须优先保证 OpenOCD + CMSIS-DAP/DAP-Link + SWD 这一调试链路能够继续使用，不能为了实现高级调试功能而把整个插件改造成必须依赖 J-Link 或 SEGGER 软件才能工作。

本项目的核心目标，是在 Cortex-Debug 现有基础上开发一个增强版本，使 VS Code 中的 STM32 调试体验尽可能接近甚至部分超过 Keil 和 Ozone。这里所谓“接近 Keil”，重点并不是复制 Keil 的界面，而是解决目前 VS Code 嵌入式调试过程中最影响实际使用体验的几个问题：运行状态下结构体变量无法舒适地动态观察、刷新频率不可方便控制、变量缺乏实时曲线显示、函数指针和回调函数很难追踪，以及大型工程中跨文件符号、变量、函数的来源和使用关系不够直观。

此外，插件不仅要增强调试能力，还应该把日常开发中最频繁的“编译 → 烧录 → 调试”流程整合进插件本身：在插件界面内点击按钮即可启动构建、烧录和调试，不需要再手动切换到终端输入命令。编译和烧录按钮必须能调用用户当前 Windows 环境中的 Git Bash 命令，具体见第二章。

开发时应优先 Fork Cortex-Debug 并在现有代码基础上增加这些能力，不建议重新从零编写一个完全独立的调试器。必须尽可能复用 Cortex-Debug 已经存在的 Debug Adapter、GDB/MI、OpenOCD、Live Watch、Memory Viewer、RTT/SWO、SVD Peripheral Viewer 等基础设施，避免破坏现有成熟功能。每个阶段都要能在本机 VS Code 中验证；P0 先建立从源码运行和安装本地 VSIX 的路径，再开始增加工作流功能。

## 开发优先级与交付顺序

以下顺序是项目的统一优先级，后文若有旧描述与本节冲突，以本节为准。先保证本人能安装、能启动插件，再完成编译与烧录工作流和接收结构体动态监控。当前版本已经进入可用性完善阶段；下一项新增能力是基于 Live Watch 数据的低频实时波形。通用结构树和函数指针追踪仍有待补齐的边界，不应在进度表中误标为全部完成。

| 优先级 | 交付目标 | 完成标志 |
|---|---|---|
| P0 | 让作者能使用自己的插件 | 插件名为 `rm_debug`；能在 VS Code Extension Development Host 中运行；能构建并安装本地 VSIX；首次安装、更新和回退步骤写入文档；原 Cortex-Debug 的基本调试会话可用。 |
| P1（当天优先） | 插件内编译与烧录 | 插件按钮能在 Git Bash 中执行配置好的 CMake/Ninja 编译命令和 OpenOCD 烧录命令；完整日志可查看；所有可识别的错误和警告都能看到并跳转；成功或失败状态明确。 |
| P2 | 接收结构体动态指标与采样频率 | 用户能选取接收结构体并选择采样频率；结构体及嵌套成员的所有字段显示实时值；界面显示请求频率和实际频率；默认不暂停运行中的 MCU。 |
| P3 | 通用结构化 Live Watch | 支持展开/折叠结构体、类、数组、联合体和指针，能处理不可用值，并按需读取大型对象。 |
| P4 | 函数指针和 Callback 运行时追踪 | 显示当前目标函数、地址与源码位置，目标变化后能更新并跳转源码。 |
| P5（下一阶段） | Live Watch 实时波形 | 将 Live Watch 中选中的数值变量按采样时间绘制成曲线；支持多变量、暂停/继续、清空、时间窗口和 Y 轴缩放。按 DAP-Link → J-Link → ST-Link 逐个接入验收；首版使用已有 Live Watch 低频数据，不承诺高速控制环采样。具体方案见《DAP-Link  ST-Link  J-Link 通用实时波形图实现思路.md》。 |
| P6 | 全项目符号与调用追踪 | 利用语言服务器和 CMake 编译信息查找定义、引用、读写、赋值、调用点及可能的回调关系。 |
| P7 | 其他调试体验增强 | 安全修改变量、外设和内存动态查看、CSV、高速 RTT/SWO/UART Plot 等按实际使用价值继续排期。 |

### 当前实现进度（2026-09-26）

| 阶段 | 已实现 | 待现场验收 |
|---|---|---|
| P0 | 已确认这是 Cortex-Debug VS Code 扩展源码并改名为 `rm_debug`；当前源码版本为 `0.1.13`，VSIX 安装说明指向 VS Code 的 `stm32` Profile。 | 作者持续使用本地扩展；团队成员可按说明在各自 Profile 安装。 |
| P1 | 已提供 Configure、Build、Flash、Debug 入口；配置向导自动发现本机工具，并生成/合并项目 JSON。Git Bash 编译、诊断解析、烧录命令和探针选择已接入。作者确认 DAPLink 和 J-Link 调试链路可用。 | 继续记录不同工程/探针上的烧录耗时和失败诊断；ST-Link 尚需独立验收。 |
| P2 | 已实现接收结构体 Live Watch、全部字段模式、1–20 Hz 采样选择、目标/实际频率显示；`0.1.10` 增加 Live Watch 与相关视图统一的十进制/十六进制显示设置。 | 作者最新观察到当前探针最快约 5 Hz；不同结构体大小和无线探针的实际频率仍需验收。波形应显示实际时间戳/采样间隔，不能把目标频率当成实测频率。 |
| P3 | 已实现从调试变量订阅字段、普通数据指针按需展开、数组分段读取/加载更多及单项读取错误保留。 | 指针、结构体数组、无线探针负载、C++ 类/联合体和异常情况仍需覆盖。 |
| P4 | 已实现函数指针运行时地址到 ELF 函数符号的匹配和源码跳转；Live Watch 刷新时可更新目标。 | 实机地址与源码位置仍需验收；静态赋值/调用关系、Callback 图和断点增强尚未完成。 |
| P5 | `0.1.11` 加入 DAPLink Live Watch 低频波形；`0.1.12` 加入串口来源；`0.1.13` 改为串口通道自动发现、用户选择曲线和接收诊断，并修正 F103 示例时钟配置后的 SysTick。 | 串口链路和目标约 50 帧/秒仍需在作者板子上实测；DAPLink 直读波形仍需验收。任意结构体字段的固件端自动插桩、J-Link 和 ST-Link 直读入口继续排期。 |
| P6–P7 | 尚未完成。 | P6 为跨文件符号与调用追踪；P7 为其余调试体验增强。 |

这里的“已实现”表示功能代码、静态检查和打包已经完成；涉及硬件行为的结论必须等真实设备接入后再确认。打包文件和使用说明位于 `cortex-debug-master` 目录。

**P0 安装路径要求**：开发阶段提供 VS Code 的 Extension Development Host 启动方式；日常使用提供从仓库构建 `.vsix` 并通过 VS Code 的“Install from VSIX...”安装的步骤。安装后能在扩展列表中确认插件名称、版本和启用状态，并能从命令面板运行插件命令。升级时说明如何安装新 VSIX；出现问题时说明如何卸载本地增强版并恢复使用官方 Cortex-Debug。插件 ID、显示名称和打包文件名应与上游区分，避免 VS Code 将本插件误认为上游扩展或覆盖错误扩展。具体命令应在实现后根据仓库实际脚本填写，不得在脚本尚不存在时写成已验证步骤。

**团队内部使用要求**：提供源代码或 VSIX 时，随包保留上游和第三方许可证/声明；不要把个人机器上的绝对路径、令牌、私钥或具体设备序列号写入默认配置。团队成员的 Git Bash、工具链和工程目录可能不同，Git Bash 与 OpenOCD 路径应支持设置或从 PATH 查找。首个验收环境仍是作者当前 Windows + VS Code + Git Bash + CMake + Ninja + OpenOCD + CMSIS-DAP/DAP-Link + STM32 环境。

**首次配置与自动生成要求**：`rm_debug` 应提供“配置工程”入口。Git Bash、`arm-none-eabi-gcc.exe`、OpenOCD 可执行文件、OpenOCD scripts、CMake 和 Ninja 等每台电脑不同的路径由插件通过 Windows `where.exe`、Git Bash 等本机环境自动发现，并保存在该电脑的 VS Code 用户设置中；仅在自动发现失败时使用文件或目录选择器，不要求用户手输绝对路径。多份 OpenOCD 并存时，根据项目的 interface/target 配置文件核对 scripts 目录并选择可用的一套。CMake 工程目录、preset、ELF 相对路径、OpenOCD interface/target 配置等项目参数保存在工作区设置中。配置完成后，插件自动创建或合并 `.vscode/launch.json`、`.vscode/settings.json` 和需要时的 `.vscode/c_cpp_properties.json`，保留已有的其他调试配置和设置；生成的项目文件使用 `${workspaceFolder}` / `${config:...}` 等引用，避免写入个人电脑的绝对路径。`c_cpp_properties.json` 中原有的本机 `compilerPath` 应移到用户设置，项目文件只保留可共享的编译数据库位置。再次配置时允许修改或重新生成。

## 二、一键工作流：编译、烧录、调试

除了调试能力增强之外，本插件还应该像 Keil 一样，把日常开发中最频繁的三个动作整合到插件自己的界面里：编译、烧录、进入调试。目前编译依赖 VS Code 自带的构建任务，烧录需要在 Git Bash 中手动输入 OpenOCD 命令行，整个流程分散且不够连贯，本插件要解决这个问题。

**2.1 三个核心按钮**

插件界面（建议放在活动栏/侧边栏或命令面板入口，后续可增加状态栏入口）提供三个按钮或对应命令：

```
Build（编译）
Download / Flash（烧录）
Debug（调试）
```

分别对应 Keil 的 Build、Download、Debug 三个动作。三个按钮可以单独使用，也可以按"编译 → 烧录 → 调试"的顺序连续使用。

**2.2 编译按钮（Build）**

- 点击后插件在 Windows 的 Git Bash 中执行当前工程配置的构建命令，默认流程为 CMake Configure（仅在需要时）+ Ninja Build。构建目录、构建配置、目标和命令参数应可配置；有现成的工程构建命令时，允许用户填写并复用，不要求所有工程采用完全相同的目录名。
- Git Bash 可通过用户设置指定 `bash.exe` 路径；未指定时尝试从 PATH 或常见安装位置查找。找不到 Git Bash 时显示如何设置路径的明确提示。命令参数应作为参数安全传递，工作目录应明确设为当前工作区或用户配置的工程目录。
- 编译过程在插件自己的输出面板中显示完整日志：CMake 输出、编译器输出、警告与错误。
- 编译器输出中的错误和警告不得只保留摘要：完整日志必须可查看；可识别的每一条 error/warning 均列出，显示级别、文件、行列号和原始消息，点击后跳转到对应位置。无法解析位置的诊断也要显示在列表或输出日志中，不能静默丢弃。
- 编译状态清晰可见：编译中（支持取消）、编译成功、编译失败。
- 若工程尚未配置（构建目录或 CMake 缓存不存在），插件先执行配置再构建；配置失败时停止后续构建并保留诊断。
- 编译失败时错误与警告仍可查看、复制和跳转；成功后明确显示构建目标和耗时。

**2.3 烧录按钮（Download / Flash）**

- 点击后插件在 Git Bash 中自动执行烧录命令，等价于用户当前手动输入的 OpenOCD 命令行，用户不再需要自己打开终端输入命令。首个实现以当前 OpenOCD + CMSIS-DAP/DAP-Link + SWD + STM32 命令为准。
- 烧录所需参数（OpenOCD 可执行文件路径、目标芯片型号、调试接口、接口配置文件 .cfg、要烧录的固件文件路径等）优先从当前工程配置与 launch.json 中自动提取；信息不足时给出明确、可操作的提示，而不是让用户自己去查文档。
- 烧录过程在插件输出面板中显示完整命令输出和进度；结束时给出明确结果：烧录成功（显示 OpenOCD 报告的校验结果）或失败（显示连接失败、目标芯片未识别、文件不存在等原始错误）。
- 烧录前自动检查编译产物是否存在；固件尚未编译时提示先编译，或提供"编译完成后自动烧录"的联动选项。

**2.4 调试按钮（Debug）**

- 点击后启动当前工作区选定的 `launch.json` 调试配置，效果等同于在 VS Code 调试面板按下启动按钮。调试按钮应优先调用 VS Code/Cortex-Debug 已有调试入口，不另造一套 GDB 会话。
- 进入调试后出现标准调试控制图标（继续、暂停、单步、跳出等），并加载本文档后续描述的全部增强能力（结构化 Live Watch、函数指针追踪、跨文件符号追踪、实时曲线等）。

**2.5 工作流联动与状态管理**

- 三个按钮既可独立使用，也支持一键串联模式：“编译 + 烧录 + 调试”。串联模式属于编译和烧录独立可用之后的交付；默认顺序执行，并在任一步失败时停止后续步骤。
- 按钮之间有状态联动：编译失败时不允许烧录；烧录失败时不允许进入调试（或给出明确警告）；调试会话进行中时，编译/烧录按钮应禁用或提示先停止调试。
- 整个流程有明确反馈：编译耗时、烧录耗时、每一步是否成功，用户一目了然。

**2.6 配置原则**

- 不要求用户为这个工作流单独维护一套复杂配置，优先复用工程已有信息：launch.json、CMake 工程文件、OpenOCD 配置等。
- 配置缺失或无法自动识别时，插件给出引导式提示，而不是报错后让用户自行研究。

## 三、动态指标与结构化 Live Watch

这是 P2 及后续阶段的核心调试能力，排在本机插件安装路径（P0）和编译/烧录按钮（P1）之后。第一项交付聚焦“选中接收结构体、按用户选择的频率持续显示其所有字段”，通用对象树、更多类型和高级交互在此基础上逐步补齐。

目前 Cortex-Debug 已经存在 Live Watch，但当前实际使用体验仍然不能完全满足要求。尤其是在机器人程序中，大量变量不是孤立的 `float`、`int`，而是存在于结构体、嵌套结构体、类对象、数组甚至包含函数指针的设备对象中。

例如程序可能存在：

```
typedef struct
{
    float target;
    float feedback;
    float error;
    float output;

    float kp;
    float ki;
    float kd;
} PID_t;

typedef struct
{
    float angle;
    float speed;
    float current;

    PID_t speed_pid;
    PID_t position_pid;
} Motor_t;

Motor_t yaw_motor;
```

我希望在 Live Watch 中只需要添加：

```
yaw_motor
```

就能够直接得到类似 Keil Watch 的树形结构：

```
yaw_motor
├─ angle
├─ speed
├─ current
├─ speed_pid
│  ├─ target
│  ├─ feedback
│  ├─ error
│  ├─ output
│  ├─ kp
│  ├─ ki
│  └─ kd
└─ position_pid
   ├─ target
   ├─ feedback
   ├─ error
   ├─ output
   ├─ kp
   ├─ ki
   └─ kd
```

其中每一个字段右侧都必须持续显示对应的实时数值。

重点是必须保留变量之间原本的层级关系，而不能简单把结构体内部成员全部平铺成几十个互不关联的变量。结构体、嵌套结构体、类、数组、联合体等都应该能够展开和折叠。

例如：

```
robot
 ├─ chassis
 │   ├─ vx
 │   ├─ vy
 │   └─ wz
 │
 ├─ gimbal
 │   ├─ yaw_motor
 │   │   ├─ speed
 │   │   └─ current
 │   └─ pitch_motor
 │
 └─ imu
     ├─ gyro
     │   ├─ x
     │   ├─ y
     │   └─ z
     └─ euler
         ├─ yaw
         ├─ pitch
         └─ roll
```

在 MCU 持续运行的情况下，这棵树应该保持展开状态，并持续更新每一个已经展开或者已经订阅的成员值。

对于没有展开的巨大结构体，不要求无条件读取全部内部数据。为了降低无线 DAP-Link、SWD 和 OpenOCD 的通信压力，可以采用“按需订阅”方式：用户展开哪个节点，就读取哪个节点涉及的数据；用户折叠后，可以降低该部分数据的读取优先级或者停止读取。

Live Watch 至少需要正确处理以下数据类型：

- `int8_t / uint8_t`
- `int16_t / uint16_t`
- `int32_t / uint32_t`
- `int64_t / uint64_t`
- `float`
- `double`
- `bool`
- `enum`
- 普通指针
- 函数指针
- 数组
- struct
- nested struct
- union
- C++ class
- class 内部成员
- 指针指向的结构体
- 结构体数组

对于指针变量，希望能够显示：

```
motor_ptr = 0x24001230 -> Motor_t
```

并允许继续展开：

```
motor_ptr
 └─ *
    ├─ speed
    ├─ current
    └─ ...
```

如果指针为 `nullptr`、地址非法、地址无法读取或者变量已经被编译优化掉，应明确显示：

```
nullptr
optimized out
unavailable
invalid address
```

而不能导致整个 Watch 面板异常或者卡死。

## 四、接收结构体动态指标与可选采样频率

这是 P2 的直接验收范围。机器人控制程序会通过遥控器、CAN、UART 等链路接收数据，并写入一个或多个接收结构体。用户应能从调试变量中选中目标接收结构体（例如 `remote_rx`、`can_rx`），启用“监控全部字段”后，插件自动枚举该结构体中的所有成员，递归显示嵌套结构体和数组中的字段，并持续显示每个字段的当前值。

要求如下：

- 用户可以选择一个或多个接收结构体；至少支持 C struct 和其中的嵌套 struct、基本类型成员、定长数组。
- “监控全部字段”会订阅所选结构体的全部可解析字段，不要求用户逐个添加叶子成员。树形界面仍可折叠以便浏览，但折叠状态不应意外取消“监控全部字段”订阅；资源不足时应显示明确状态和实际采样频率。
- 用户可选采样频率，至少提供 `1 / 2 / 5 / 10 / 20 Hz` 和自定义值。设置按所选目标生效，且调试期间可直接调整。
- 对每个字段显示字段名、当前值和不可用原因；对于大结构体，应采用批量读取、分组读取等方式控制请求数，并在必要时提示采样能力不足。
- 明确显示请求采样频率、实际采样频率和最近采样时间。用户选择的频率是目标值；目标探针无法达到时不应虚报，必须展示实测值。
- 默认不能通过周期性暂停 MCU 来制造动态效果。不能运行态读取时，应显示不支持原因并保持目标运行状态。

接收结构体动态指标优先做树形数值表。曲线绘制、CSV 导出和高速波形不属于 P2 的阻塞条件，按后续阶段处理。

## 五、Live Watch 必须支持独立的采样频率和界面刷新频率

动态调试不能只有“开启”和“关闭”两个状态。

我希望插件能够非常方便地控制数据采样频率，例如提供：

```
Live Watch Rate

○ 1 Hz
○ 2 Hz
○ 5 Hz
○ 10 Hz
○ 20 Hz
○ Custom
```

这里必须区分两个概念。

第一个是 MCU 数据采样频率，即插件通过 OpenOCD、GDB、SWD 等链路实际读取目标芯片内存的速度。

第二个是 VS Code GUI 刷新频率，也就是画面每秒更新多少次。

这两个参数不能强行绑定。

例如可以使用：

```
Data Sampling: 20 Hz
GUI Refresh:   10 Hz
```

底层已经获取了 20 Hz 数据，但界面只需要 10 Hz 更新，从而减轻 VS Code WebView 或 TreeView 的绘制压力。

希望在 Live Watch 面板顶部直接提供采样率切换，而不仅仅允许用户修改 `launch.json`。此设置也是接收结构体动态指标的主要交互。

同时保留配置文件方式，例如：

```
"liveWatch": {
    "enabled": true,
    "samplesPerSecond": 10
}
```

但 GUI 应该允许临时覆盖该值。

如果无线 DAP-Link 通信能力不足，应允许插件自动检测读取延迟，并给出类似：

```
Requested: 20 Hz
Actual:    13.4 Hz
Transport latency: 42 ms
```

的信息。

可以进一步设计一个 Auto 模式：

```
Sampling Rate: Auto
```

插件根据当前监控变量数量、SWD/OpenOCD 返回速度和通信延迟动态调整采样频率。

但 Auto 模式属于增强功能，不得阻塞最基础的手动频率选择功能。

## 六、所有 Live Watch 功能必须优先保证“不暂停 MCU”

这是整个项目非常重要的原则。

Live Watch 的价值就在于：

```
CPU RUNNING
```

时仍然能够查看变量。

不能为了假装“实时刷新”而不断执行：

```
halt
read
resume
halt
read
resume
```

这种实现会严重扰乱：

- 电机控制周期
- CAN 通信
- UART DMA
- PID
- LQR
- Kalman Filter
- RTOS 调度
- 编码器读取
- PWM
- IMU
- 状态机

因此默认模式下禁止通过周期性 Halt 实现 Live Watch。

应优先使用当前 Cortex-Debug/OpenOCD 已有的 Live Watch 机制，在 MCU 运行状态下通过调试访问端口读取内存。

如果某一个芯片、调试器或者 OpenOCD Target 不支持运行状态下读取某类内存，则应该明确提示：

```
Live access is not supported by current target/probe.
```

而不是悄悄暂停 MCU。

可以另外提供一个用户主动开启的：

```
Allow intrusive sampling
```

选项，但默认必须关闭。

## 七、实时曲线 Plot 功能（P5，下一阶段）

如果条件允许，希望直接在插件内部增加 Live Plot。

任何可以被 Live Watch 读取的数值变量，都可以右键：

```
Plot
```

然后打开实时曲线。

例如调 PID 时可以同时观察：

```
target
feedback
error
output
```

调 LQR 时可以观察：

```
theta
theta_dot
x
x_dot
u
```

调云台时可以观察：

```
yaw_target
yaw_feedback
gyro_z
motor_output
```

曲线至少需要拥有：

- 暂停/继续
- 清空
- 自动缩放 Y 轴
- 固定 Y 轴范围
- 调整时间窗口
- 显示当前值
- 显示最大值
- 显示最小值
- 显示平均值
- 多变量同时显示
- 单独隐藏某一变量
- 导出 CSV

低频曲线可以直接使用 Live Watch 的数据。

例如：

```
5 Hz
10 Hz
20 Hz
```

这种曲线足够用于状态观察。

如果用户需要真正的高速波形，例如几百 Hz 或 1 kHz 控制环数据，则 Live Watch 不应该硬撑这个任务。应预留第二种高速数据源：

```
RTT
SWO
UART
```

并允许未来把这些高速数据源接入同一个 Plot 界面。

也就是说，最终设计最好是：

```
                   ┌─ Live Watch / SWD
Variable Plot  <───┼─ RTT
                   ├─ SWO
                   └─ Serial
```

Live Plot 初版只接入 Live Watch 数据即可，高速 Trace 可以作为后续版本。该功能现在排为 P5 下一阶段：可以先画普通数值变量，不必等待跨文件符号追踪、静态 Callback 图等独立能力完成。曲线时间轴必须使用实际采样时间；当探针、GDB 读取或字段数量使采样变慢时，界面应如实反映间隔，不能插值伪造高频数据。

**P5 首版范围**：从 Live Watch 变量上选择 `Plot`，把变量加入/移出同一图表；显示多条曲线；支持暂停/继续、清空、自动/固定 Y 轴和可调时间窗口；至少展示当前值与实测采样频率。先支持常见整数和浮点标量。最小验收使用 F103 LED 示例中的变化变量以及两个同时变化的数值字段，确认曲线连续、时间轴合理，暂停后停止追加，继续后恢复，清空后重新采集。最大值/最小值/平均值与 CSV 导出可在首版稳定后补齐；RTT、SWO、UART 高速数据接入后续阶段。

## 八、Live Watch 中允许安全修改变量

这个功能优先级低于实时读取，但非常有价值。

例如调 PID 时，希望可以直接双击：

```
speed_pid.kp = 8.0
```

把它修改成：

```
speed_pid.kp = 9.5
```

然后观察电机响应，而不需要：

```
修改源码
→ 编译
→ 烧录
→ 重新调试
```

希望支持：

```
Double Click -> Set Value
```

至少覆盖：

```
int
uint
float
double
bool
enum
```

对于危险写入必须进行限制。

例如：

```
const
Flash
代码段
只读寄存器
非法地址
```

不得直接写入。

对于 SVD 外设寄存器，应根据寄存器读写属性决定是否允许修改。

## 九、显示地址、类型和格式

Live Watch 每个变量除了值以外，最好允许显示：

```
Name
Value
Type
Address
```

例如：

```
yaw_motor.speed
153.4
float
0x240013A8
```

用户可以选择隐藏 Type 或 Address。

数值格式应至少支持：

```
Decimal
Hex
Binary
Float
```

对于整数：

```
100
0x64
0b01100100
```

之间可以快速切换。

对于 `enum`：

```
CONTROL_NORMAL (2)
```

而不是只显示：

```
2
```

## 十、函数指针调试能力必须重点增强

这是本项目另一个非常重要的功能。

在大型嵌入式项目中，经常会大量使用：

```
function pointer
callback
driver interface
device abstraction
pub/sub
middleware
RTOS callback
HAL callback
```

例如：

```
typedef void (*UpdateFunc)(Motor_t *);

typedef struct
{
    UpdateFunc update;
} MotorOps;

motor.ops.update = Motor_Update;
```

之后程序调用：

```
motor.ops.update(&motor);
```

普通调试过程中最大的问题是：

看到：

```
motor.ops.update
```

很难立刻知道：

```
现在这个指针到底指向哪个函数？
这个函数在哪里定义？
是谁把它赋值进去的？
在哪里注册？
哪里调用了这个函数指针？
这个 callback 最后什么时候被执行？
```

因此插件需要专门增强函数指针调试。

当 Live Watch 中存在函数指针时，不能只显示：

```
0x080124AC
```

而应该尽量解析成：

```
motor.ops.update
0x080124AC
→ Motor_Update()
→ motor.cpp:183
```

并允许点击：

```
Motor_Update()
```

直接跳转到函数定义。

如果当前函数指针值发生变化：

```
Motor_Update
↓
Motor_SafeUpdate
```

Live Watch 应实时更新对应的符号名称。

## 十一、函数指针应提供“追踪关系”

希望右键函数指针后增加：

```
Trace Function Pointer
```

打开专门面板。

例如：

```
motor.ops.update
```

应该尽可能分析：

```
Declaration
MotorOps::update
motor.hpp:42

Possible assignments
Motor_Update
motor.cpp:81

Motor_SafeUpdate
motor_safe.cpp:67

Registration
motor.ops.update = Motor_Update
motor_init.cpp:125

Indirect calls
motor.ops.update(&motor)
motor_task.cpp:213

Current runtime target
Motor_Update
0x080124AC
motor.cpp:183
```

也就是说，需要同时提供两种分析。

一种是静态分析：

```
它可能指向哪些函数？
在哪里被赋值？
在哪里被调用？
```

另一种是运行时分析：

```
它现在实际指向哪个函数？
```

静态分析得到多个 Candidate 时，不应该假装知道唯一答案。

例如：

```
Possible Targets:
Motor_Update
Motor_SafeUpdate
Motor_CalibrationUpdate
```

真正运行调试以后，再根据函数指针当前地址显示：

```
Current Target:
Motor_Update
```

## 十二、支持 Callback 注册追踪

很多嵌入式程序不是直接：

```
fp = func;
```

而是：

```
RegisterCallback(&motor, Motor_Update);
```

或者：

```
HAL_UART_RegisterCallback(...)
```

或者：

```
device->ops->update = xxx;
```

希望插件未来可以提供：

```
Callback Flow
```

例如：

```
Motor_Update
     ↓
RegisterMotorCallback()
     ↓
motor.ops.update
     ↓
Motor_Task()
     ↓
motor.ops.update(&motor)
```

函数指针追踪的初始版本至少需要做到：

- 查找函数指针声明
- 查找赋值位置
- 查找可能的目标函数
- 查找函数指针调用位置
- 解析运行时实际目标函数
- 点击跳转源码

复杂的数据流分析和完整 Callback Graph 可以作为第二阶段。

## 十三、函数指针断点增强

如果函数指针当前指向：

```
Motor_Update
```

希望右键：

```
Break on Current Target
```

插件自动在：

```
Motor_Update()
```

设置断点。

如果静态分析发现三个可能目标：

```
Motor_Update
Motor_SafeUpdate
Motor_ErrorUpdate
```

可以提供：

```
Break on All Possible Targets
```

分别设置断点。

对于存放在 RAM 中的函数指针变量，如果硬件支持 Watchpoint，还可以提供：

```
Break When Pointer Changes
```

例如：

```
motor.ops.update
```

一旦这个地址里的函数指针值被修改，就触发数据断点。

需要注意 Cortex-M 硬件 Watchpoint 数量有限，因此 UI 中必须显示：

```
Hardware Watchpoints:
2 / 4 used
```

不要让用户在不知道硬件资源限制的情况下不断创建 Watchpoint。

## 十四、全项目跨文件符号追踪

目前另一个非常影响大型 STM32 工程调试的问题，是变量和函数的查找、引用和调用关系需要能够真正覆盖整个项目，而不是只围绕当前文件。

希望插件增加一个：

```
Project Symbol Trace
```

功能。

对于任何变量、函数、结构体成员、函数指针或者宏，右键后可以执行：

```
Find Definition
Find Declaration
Find All References
Find Reads
Find Writes
Find Assignments
Find Callers
Find Callees
Find Address Usage
Trace Symbol
```

结果必须覆盖整个 CMake 工程中的：

```
.c
.cpp
.h
.hpp
```

等文件，而不是当前文件。

例如：

```
chassis_cmd_vx
```

执行：

```
Trace Symbol
```

以后应该得到：

```
Definition
chassis.cpp

Writes
remote_control.cpp
navigation.cpp
autoaim.cpp

Reads
chassis_control.cpp
kinematics.cpp

Address passed to
control_interface.cpp
```

## 十五、跨文件搜索应利用 CMake 工程信息

由于当前项目本身使用 CMake，因此应优先利用：

```
compile_commands.json
```

理解真正参与编译的源码、Include Path、Macro、Compiler Option 和 Translation Unit。

如果项目没有生成：

```
compile_commands.json
```

可以提示：

```
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
```

不要把：

```
build/
third_party/
generated/
```

等无关目录全部暴力文本搜索。

项目级符号分析应优先利用 VS Code 当前 C/C++ Language Service、clangd、Language Server Provider 或 compile_commands 信息。

只有在语言服务器无法提供所需结果时，再考虑自行建立额外索引。

## 十六、增加 Symbol Inspector

希望鼠标悬停或者右键一个变量以后，能够打开：

```
Symbol Inspector
```

例如查看：

```
yaw_motor.speed
```

展示：

```
Symbol
yaw_motor.speed

Type
float

Parent
Motor_t yaw_motor

Address
0x240013A8

Defined
motor.cpp:52

Written by
Motor_UpdateFeedback()
CAN_MotorDecode()

Read by
Motor_Control()
Motor_Debug()

Live Value
153.42

Last Sample
18 ms ago
```

对于函数指针额外显示：

```
Runtime Target
Motor_Update()

Possible Targets
Motor_Update()
Motor_SafeUpdate()

Call Sites
3
```

Symbol Inspector 可以成为变量查找、Live Watch 和源码导航之间的核心入口。

## 十七、项目级调用关系

希望对于普通函数也提供更清晰的调用关系。

例如：

```
Motor_Control()
```

右键：

```
Show Call Hierarchy
```

得到：

```
Motor_Control
↑ called by
    Chassis_Control
        ↑
        Chassis_Task

    Gimbal_Control
        ↑
        Gimbal_Task
```

同时可以查看：

```
Motor_Control
↓ calls
    PID_Calculate
    Motor_SetCurrent
    CAN_Send
```

对于直接函数调用可以依赖语言服务器。

对于函数指针调用则使用前面设计的 Function Pointer Analyzer 进行补充。

最终效果是：

```
普通函数调用
+
函数指针间接调用
+
Callback 注册
```

能够尽可能组成完整调用关系。

## 十八、Live Peripheral

如果已经加载 STM32 对应 SVD 文件，希望外设寄存器窗口也能支持运行状态刷新。

例如：

```
TIM1
├─ CR1
├─ CNT
├─ PSC
├─ ARR
└─ CCR1
```

在 CPU Running 状态下更新。

可以分别设置：

```
Peripheral Refresh:
1 Hz
2 Hz
5 Hz
10 Hz
```

不要求和普通变量 Live Watch 使用相同刷新频率。

因为大量读取 Peripheral Register 有可能影响通信性能，因此默认频率应该较低。

## 十九、Memory Viewer 增强

希望 Memory Viewer 最终也支持：

```
Live Memory
```

例如：

```
0x24000000
```

在 MCU 运行过程中持续刷新。

当某个字节变化时，可以短暂高亮。

例如：

```
old: 24
new: 31
```

变化位置高亮 500 ms。

这个功能不属于 P0 至 P2 的交付范围，可以放在 Live Watch 和 Function Pointer 功能之后。

## 二十、性能优化原则

DAP-Link，尤其是无线 DAP-Link，通信带宽和延迟一定低于本地 J-Link，所以插件必须考虑读取效率。

不要对一个结构体里的 50 个成员无条件执行 50 次完全独立的低效率请求。

如果能够获取：

```
base address
member offset
member size
```

则应尽可能对连续地址进行批量读取。

例如：

```
motor.angle
motor.speed
motor.current
```

地址连续时，可以一次读：

```
12 bytes
```

然后在插件本地解析成三个 `float`。

这类优化可以逐步实现。

初版优先保证正确性，然后逐步实现：

```
Memory Read Batching
Request Coalescing
Duplicate Address Elimination
Adaptive Sampling
```

等优化。

## 二十一、不能破坏普通调试功能

所有新增能力都必须建立在一个原则上：

即使 Live Watch、Plot、Function Pointer Trace 等高级功能全部关闭，Cortex-Debug 原本的行为应该基本保持不变。

以下功能不能因为此次修改而退化：

```
Launch
Attach
Reset
Restart
Break
Continue
Step Into
Step Over
Step Out
Call Stack
Variables
Registers
Breakpoints
Watchpoints
Memory
OpenOCD
J-Link
ST-Link
RTT
SWO
RTOS View
Peripheral View
```

尤其不能为了实现 Live Watch 而破坏普通 GDB Debug Session。

## 二十二、硬件兼容原则

第一目标环境是：

```
VS Code
CMake
Ninja
Cortex-Debug
OpenOCD
CMSIS-DAP / DAP-Link
SWD
STM32
```

不能要求用户改成 Keil 工程。

不能要求使用 STM32CubeIDE。

不能强制 J-Link。

不能强制 Ozone。

J-Link、ST-Link、pyOCD 可以继续作为兼容目标，但是所有核心设计首先应验证：

```
OpenOCD + CMSIS-DAP
```

能够正常使用。

如果某个功能因为调试器硬件本身不支持而无法工作，应进行 Capability Detection。

例如：

```
Live memory access: Supported
SWO: Unsupported
RTT: Supported
Hardware watchpoint: 4
```

而不是让整个功能报错。

## 二十三、建议的软件架构

不要把所有逻辑写在一个巨大 TypeScript 文件中。

建议至少拆分为以下逻辑模块：

```
LiveWatchService
负责变量订阅、刷新、读取和状态管理。

LiveWatchTree
负责 struct/class/array/pointer 的树形 UI。

LiveSamplingService
负责采样频率、调度、延迟检测和自适应刷新。

SymbolResolver
负责地址和 ELF/DWARF/GDB symbol 之间的转换。

FunctionPointerAnalyzer
负责函数指针的运行时目标解析和静态关系分析。

ProjectIndexService
负责跨文件 Definition/Reference/Read/Write/Assignment 查询。

CallHierarchyService
负责普通函数和函数指针调用关系。

LivePlotService
负责变量时间序列缓存和实时绘图。

PeripheralLiveService
负责 SVD 外设实时读取。

DebugCapabilityService
负责检测 OpenOCD、Probe、Target 能力。
```

实际修改前应先阅读 Cortex-Debug 当前仓库结构，并尽可能复用已有模块，而不是严格按照上述名称重新创建一套平行系统。

## 二十四、实施路线与阶段验收

所有功能按 P0 至 P7 分阶段实施，每阶段都要先确认源码结构和现有 Cortex-Debug 能力，再做尽可能小的修改。一个阶段通过验收后再扩大范围；不能为了赶进度破坏已有调试能力。P0 至 P2 的主要实现已经进入实机使用和性能完善阶段；新增功能的下一阶段是 P5 Live Plot。P3/P4 仍有明确未完成项，和 Live Plot 可以并行排期，但不能在进度表里写成全部验收通过。

### P0：本机可开发、可安装、可回退

- 准备 Cortex-Debug 源码仓库，并确认上游版本、许可证文件、构建工具和扩展入口。
- 使用独立的扩展 ID、显示名称和输出目录，避免覆盖正在使用的官方 Cortex-Debug。
- 能在 Extension Development Host 中启动；能打包出 VSIX；能通过 VS Code 的“Install from VSIX...”安装并从扩展列表启用。
- 验证现有 `launch.json` 调试配置可以启动、暂停、继续、单步并查看变量。
- 写明仓库实际使用的依赖安装、编译、打包命令，以及 VSIX 安装、升级、卸载和回退操作。命令只有在真实仓库中跑通后才标记为已验证。
- 提供首次配置入口，按上文规则分别保存机器路径和项目参数，并生成/合并 `.vscode` JSON 文件。

**源码基线**：本工作目录中的 `cortex-debug-master` 已确认是 VS Code Cortex-Debug 扩展源码，包含 `package.json`、扩展入口、调试适配器和 OpenOCD/Live Watch 模块。作者的参考工程位于 `E:\code_for_rm\lyh_cmake_frame-master`，实际 CMake 工程在其 `cmake_test_f407` 子目录；该工程只用于首个环境验收，插件默认配置不能写死这些路径。

### P1（当天优先）：Git Bash 编译和 OpenOCD 烧录

- 实现 Build 和 Flash 两个独立命令/按钮；按第二章复用 Git Bash、CMake、Ninja 与 OpenOCD。
- 编译必须能查看完整日志，并列出所有已解析的错误与警告；诊断可跳转到文件和行。构建失败时仍保留警告和错误信息。
- 烧录必须调用当前工程配置的 OpenOCD 烧录命令，无需用户手动打开 Git Bash；检查 ELF/HEX/BIN 等目标文件存在，并明确显示连接、擦除、写入、校验和失败结果。
- Debug 入口启动当前 `launch.json` 配置，继续使用 Cortex-Debug 的标准调试流程。Build/Flash 完成前，串联式“编译 + 烧录 + 调试”可以后续迭代，不阻塞两个独立按钮的验收。
- 编译失败不启动烧录；烧录失败不启动调试；可取消运行中的命令；显示命令耗时和退出码。

**P1 验收**：用作者当前 STM32 工程点击 Build 能完成构建；人为制造一个编译错误和一个警告，二者都出现在输出日志与诊断列表中且可跳转；点击 Flash 能调用实际 Git Bash/OpenOCD 命令成功烧录并校验；断开探针或使用错误配置时显示失败原因；VS Code 调试入口仍能正常工作。

### P2：接收结构体全部字段的动态指标

- 准备至少一个真实或最小 STM32 测试工程，包含持续变化的遥控器/CAN 接收结构体、嵌套结构体和数组。
- 能选中接收结构体并启用“监控全部字段”；自动列出所有可解析字段，不需要逐项添加。
- 可选 `1 / 2 / 5 / 10 / 20 Hz` 或自定义频率；运行时可调整。显示请求频率、实测频率、最近更新时间和字段读取错误。
- 在 MCU 持续运行时验证数值更新；默认不周期性 halt/resume。当前调试链路不支持运行态读取时明确提示能力限制，不伪造实时数据。
- 对结构体、数组读取采用可控的批量/合并策略；读取过慢时显示真实采样频率或降级状态。

**P2 验收样例**：程序运行时连续更新 `remote_rx.channel[]`、开关量、鼠标/键盘字段和一个嵌套控制结构体。添加整个 `remote_rx` 后能看到所有字段的值；切换 1、5、10、20 Hz 后实测频率随设置改变或准确显示链路达不到的频率；整个过程中 MCU 不因插件采样而暂停。

### P3：通用结构化 Live Watch 和稳定性

扩展 P2 到任意 struct/class、嵌套结构、联合体、指针和结构体数组；支持展开/折叠、空指针和优化掉变量的状态提示、类型/地址/数值格式显示，以及按需订阅大型对象。保持已通过的接收结构体监控行为。

**验收**：使用 `Motor_t`、`PID_t`、数组和函数指针测试结构层级和值；制造 nullptr、不可用变量和非法地址情况时只报告该项错误，不导致整个 Watch 崩溃或卡住。MCU 保持 Running 时不进行隐式周期暂停。

### P4：函数指针和 Callback 运行时追踪

先解析函数指针运行时地址到符号名和源码位置；再加入声明、可能赋值、间接调用和 Callback 注册的静态关系；最后考虑目标变化监测和便捷断点。

**验收**：`motor.update` 从 `Motor_Update` 切换为 `Motor_SafeUpdate` 后，运行时目标名称和地址同步改变；点击目标可跳转源码；静态候选目标标为可能项，不冒充运行时结论。

### P5：Live Watch 实时波形（下一阶段）

首版直接复用 Live Watch 已采集的标量值和实际采样时间，不新建另一套 MCU 轮询。用户能从 Live Watch 变量添加/移除曲线；支持多变量、暂停/继续、清空、时间窗口、自动/固定 Y 轴，并能看到当前值及实际采样频率。先支持常见整数和浮点标量，避免在首版同时引入复杂对象解码和高速传输。探针接入顺序为 DAP-Link、J-Link、ST-Link；每一种通过实机验收后再推进下一种。

**P5 验收**：使用 F103 LED 测试工程中的变化指标，以及至少两个同步变化的数值字段；曲线数值与 Live Watch 一致，横轴按实测时间推进；暂停时不再新增点，继续时恢复，清空后重新绘制。探针读取变慢时显示较低的实际频率，不得按用户设置频率伪造点。完成后再添加统计量、CSV 和 RTT/SWO/UART 高速来源。

### P6：全项目符号、引用与调用追踪

基于 compile_commands、语言服务器或 clangd 建立项目范围的 Definition、References、Reads、Writes、Assignments、Call Hierarchy。只有现有语言服务无法提供所需结果时才建立额外索引；明确显示索引覆盖范围和无法解析的结果。

**验收**：跨多个 C/C++ 文件定义、写入、读取同一变量，执行 Trace Symbol 后能返回整个工程中的相应位置；不能只返回当前文件结果。

### P7：后续体验增强

按实际使用价值分批评估 Live Variable Editing、Live Peripheral、Live Memory、CSV Logging、Advanced Callback Graph 和 RTT/SWO/UART 高速 Plot。每项先定义性能与硬件限制，再实现；不得破坏已有编译、烧录、调试和 Live Watch 行为。

新增一项独立的 CMake 工程管理工作：在 `rm_debug` 侧栏按 Keil 式分组**手动选择**哪些 `.c` 参与编译，管理头文件搜索路径，并允许一个模块文件夹对应一个 `CMakeLists.txt`。不能因为文件位于某目录就自动把该目录全部 `.c` 加入构建。具体交互、CMake 写入规则和验收情景见 [CMake 模块管理实现方案](cortex-debug-master/RM_DEBUG_CMAKE_模块管理实现方案.md)。源码、lint、生产构建和 `0.1.14` VSIX 已完成；仍需在工程副本中验证按钮写出的 CMake 能配置和编译，验收后才标记为完成。

## 二十五、完成定义与长期目标

最终使用体验是：本人能在 Windows VS Code 安装和更新自己的增强版扩展；在插件界面运行 Git Bash 编译与烧录命令；启动原有 Cortex-Debug 调试流程；选中接收结构体后按自选频率查看所有字段的动态值，并把数值变量绘制成低频实时曲线。之后逐步补齐通用结构体边界、函数指针静态关系、跨文件符号追踪和高速波形能力。

插件应保留 VS Code + CMake + Ninja + OpenOCD + CMSIS-DAP/DAP-Link + SWD 这一主要工作环境，不强制迁移到 Keil、STM32CubeIDE、J-Link 或 Ozone。每个阶段都要保持普通 Cortex-Debug 的 Launch、Attach、断点、单步、变量、寄存器和现有探针支持可用。团队内部分享时提供可复现安装说明与所需许可证/声明文件，并允许成员分别配置本机 Git Bash、OpenOCD 和工程路径。
