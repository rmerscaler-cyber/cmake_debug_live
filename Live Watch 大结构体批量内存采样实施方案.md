# Live Watch 大结构体批量内存采样实施方案

> 交给 Luna Max 的实施说明。日期：2026-09-27。
> 本文件是方案。**实施状态（2026-09-27 深夜更新）**：批量内存采样已在 `0.1.20` 中实现，`0.1.21` 修复嵌套容器误入兼容与准备续跑；`0.1.22` 修复实机发现的关键问题——GDB `(unsigned long)&(...)` 随输出进制返回十进制地址，旧解析只认 `0x`，导致所有根地址失败、整棵树回退逐字段（实机表现为“批量 0 块/0 B · 回退 929”，比改造前更慢）；`0.1.23` 修复“反馈数值错乱/看似冻结”根因——GDB `ptype /o <typedef>` 会把指向结构体的 typedef 指针（`motor_handle_t`）展开成指向的结构体布局，解析器因此把 `steer_motor[4]` 当作内嵌结构体数组，电机字段偏移从**指针槽**开始累加，解码出的其实是指针槽地址与相邻 `power_k` 等静态数据；现先用 `whatis /r` 判定声明类型，指针保持指针。`0.1.24` 修复指针数组被当成单个指针（`motor_handle_t [4]` 现在判为数组并恢复 4 个元素），取消无线链路上的“块缩小下降螺旋”，默认块上限升到 2048 B、合并间隔 512 B。0.1.24 VSIX 已生成并安装。软件机制验证通过（`test-compile`、`lint`；纯函数 17 项、引擎 21 项、真实 H7 ELF 四类对象布局）。**真实无线 DAP 上的性能与数值一致性仍需按第 15.2 节实测**；若仍有异常，请提供标题栏与输出面板的“内存/兼容”统计以定位。
> 执行任务：在现有 rm_debug 扩展上完成下述采样引擎、验证并生成新版本 VSIX。不要把完成方案、只调整刷新定时器或只增加耗时显示当作实现完成。

## 1. 用户真正要解决的问题

用户正在通过 CMSIS-DAP / OpenOCD 调试 STM32H723 工程。用户实测：

| 监控内容 | 实际采样频率 |
|---|---:|
| 只监控 `rc_ctrl` | 约 16.2 Hz |
| 监控 `chassis_move`，并展开其中电机对象 | 约 0.6 Hz |

目标频率设置为 20 Hz，但增加结构体字段后，实际速度急剧下降。用户需要保留结构体树、指针展开、数组、全部字段模式及波形，并让字段增加带来的采样成本显著降低。

**推荐方案：先建立并缓存字段布局和指针依赖，再按对象地址成块读取内存，最后在电脑上解码全部订阅字段。稳态采样不得再次逐字段向 GDB 求值。**

这里的“受数量影响小”指减少每个字段带来的通信往返。不能承诺与数据量完全无关：总字节数、离散对象数量、指针深度及链路速度仍然影响耗时。

首版沿用现有独立 Live GDB、OpenOCD 和 SWD；用户不需要改固件、不需要增加串口上传、不需要换探针。不要把切换到串口方案当作本任务交付。

## 2. 工作目录和已经核实的事实

### 2.1 路径

```text
工作区：
C:\Users\lixiayao\Desktop\cortex_debug_rm

插件源码：
C:\Users\lixiayao\Desktop\cortex_debug_rm\cortex-debug-master

真实 H7 工程：
E:\code_for_rm\cmake_h7_duo

实际检查过的 ELF：
E:\code_for_rm\cmake_h7_duo\build\Debug\cmake_h7_duo.elf

本次找到的 GDB：
D:\arm-gnu-toolchain-12.3.rel1-mingw-w64-i686-arm-none-eabi\bin\arm-none-eabi-gdb.exe
```

这些路径供本机查证使用。实现中使用调试会话的配置和 ELF，不得写死上述个人路径或变量名。

源码位置：

- `app/chassis_application_internal.h`：`chassis_move_t`。
- `app/chassis_application.c`：全局 `chassis_move`。
- `device/comm/remote_control.h`：`RC_ctrl_t`。
- `device/comm/remote_control.c`：全局 `rc_ctrl`。
- `model/motor/motor_typedef.h`：`motor_base_t`、`motor_handle_t`。
- `model/algo/pid.h`：PID 状态与前馈参数。

H7 工程是参考与验收对象。本任务修改插件源码；不要为了让插件工作而修改 H7 业务结构体、内存布局或控制逻辑。

### 2.2 从真实 ELF 查出的数据

已用上述 GDB 离线加载 Debug ELF，执行 `ptype /o` 和 `sizeof`，得到：

| 对象/字段 | 实际大小或偏移 |
|---|---|
| `sizeof(rc_ctrl)` | 28 字节 |
| `sizeof(chassis_move)` | 404 字节 |
| `sizeof(motor_handle_t)` | 4 字节，实际类型是 `motor_base_t *` |
| `sizeof(motor_base_t)` | 348 字节 |
| `sizeof(chassis_move.chassis_mode)` | **1 字节** |
| `chassis_move.command` | 偏移 0，48 字节 |
| `chassis_move.wheel_motor[4]` | 偏移 52，16 字节 |
| `chassis_move.steer_motor[4]` | 偏移 68，16 字节 |
| `chassis_move.power_k[4][6]` | 偏移 88，96 字节 |
| `chassis_move.chassis_angle_pid` | 偏移 184，132 字节 |
| `motor_base_t.fb` | 偏移 12，40 字节 |
| 目标字节序 | 当前 ELF：little endian |

**这些数据证明有实际优化空间：一个 404 字节的对象可以按一小块或少数几块读取，没必要为里面每个数值分别付出远程访问成本。**

注意：上述布局只用于验收，不能硬编码到通用插件。重新编译后的 ELF 必须重新发现布局。

### 2.3 GDB Python 不可用

执行过：

```powershell
& 'D:\arm-gnu-toolchain-12.3.rel1-mingw-w64-i686-arm-none-eabi\bin\arm-none-eabi-gdb.exe' --batch -nx -ex 'python print("RM_PYTHON_OK")'
```

输出：

```text
Python scripting is not supported in this copy of GDB.
```

因此首版不得依赖 `gdb` Python 模块、Python 的 `gdb.Value(buffer, type)` 或换一个带 Python 的 GDB。推荐的实现只需要现有 GDB/MI、少量初始化期 CLI 类型查询和 Node.js Buffer。

### 2.4 现有版本与截图

工作区 `package.json` 目前是 `0.1.19`，代码已有 `gdbVarName`、`applyCacheChanges`、字段增量更新和耗时显示。用户截图标题未显示新版的 `GDB ... ms / 字段 ... ms`，因此不能仅凭截图认定运行中的扩展确实是 0.1.19。

开始验收前核对实际启用版本、Profile 和调试适配器路径；保留这项检查，但继续完成真正的批量读取。即使用户运行的是 0.1.19，当前代码仍会调用 `var-update *`，字段数相关的目标读取成本依然存在。

## 3. 原因与当前实现中的关键问题

当前路径近似：

```text
前端定时器
  -> liveCacheRefresh
  -> VariablesHandler.refreshCachedChangeList()
  -> MI2.varUpdate('*', ..., 'simple')
  -> GDB 检查已创建的变量对象及其成员
  -> 返回值变化列表
  -> 前端更新树 / 波形
```

`--simple-values` 主要减少输出内容；一个 MI `var-update` 命令也不等于一次目标内存读取。源码和现象支持“字段越多，读取开销越大”的判断，但实际 RSP/SWD 请求数量还需要计数或日志验证。

上一版减少了前端逐层 DAP 请求，并清理删除监控项遗留的 GDB 对象；它没有将底层逐字段访问改成连续内存读。

另外必须修正一个与本问题直接相关的类型判断：

```c
typedef motor_base_t *motor_handle_t;
```

现有 `live-watch.ts` 用 `type.includes('*')` 判断指针。GDB 返回的类型名可能是 `motor_handle_t`，字符串中没有星号。全部字段模式因此可能把这类指针当作普通嵌套结构体自动展开，继续进入电机、控制器、配置等对象。用户截图的电机句柄下直接显示 `id/type/fb`，与这条风险一致；自动展开的具体触发仍需用测试确认。

**正确处理：解析 typedef 后的类型分类；全部字段模式递归内嵌成员和已加载数组，但只有用户明确展开或曲线订阅时才跟随数据指针。用户已经展开的电机对象必须继续正常采样。**

## 4. 技术选择与交付边界

采用“两阶段”的方式：

1. **准备阶段**：沿用 GDB 发现变量树；以每个唯一类型一次 `ptype /o` 为主取得布局，补充根地址、对象大小、标量类型、字节序和指针依赖，建立读取计划。只对布局无法可靠解析的少数节点查询字段地址或回退；缓存、可取消，并显示准备状态。
2. **采样阶段**：按计划读取少数内存块，批量解码，发布同一轮结果。固定结构、固定订阅、固定指针时，这一阶段不再查询每个字段的地址、类型或表达式值。

读取接口从开始就抽象为 `MemoryReader`，首版只实现基于独立 Live GDB 的 `GdbMemoryReader`（`-data-read-memory-bytes`）。根据实测再评估 OpenOCD Tcl 后端；本次不同时实现两套后端。

首版类型支持：

- 有确定存储地址的 C 整数、浮点数、bool、enum、普通指针和函数指针地址。
- struct/union 内嵌成员、packed 结构体、已订阅数组范围。
- 从全局/静态根对象显式展开的数据指针，包含 typedef 指针和有界的多级指针。
- 指针循环必须检测；未展开的指针只显示地址，不递归读取目标。

不能可靠确定布局的位域、动态 C++ 对象、特殊 pretty-printer、复杂表达式等保留旧读取能力并标明回退原因，不能猜类型或偏移。位域首版可回退，不能按普通整数直接读。

## 5. 修改位置和建议模块

以下为插件根目录内的路径。

| 文件 | 工作内容 |
|---|---|
| `src/live-watch-monitor.ts` | 整合准备、读取、发布；维护有效订阅、对象归属、缓存状态和回退 |
| `src/backend/mi2/mi2.ts` | 增加真实路径查询、正确的 MI 参数编码、完整内存块读取；保留单连接命令串行队列 |
| `src/backend/backend.ts` | 给 VariableObject 增加独立类型分类/布局元数据；不要把 UI tooltip 当原始类型 |
| `src/gdb.ts` | 接入订阅同步和批量刷新自定义请求；返回诊断字段与明确错误 |
| `src/frontend/views/live-watch.ts` | 生成有效订阅、维护 revision、处理新帧与失败、修正 typedef 指针展开 |
| `src/frontend/extension.ts` | 展开/折叠事件调用统一订阅更新入口；当前折叠只写 `expanded = false`，需要补同步 |
| 新建 `src/backend/live-memory-types.ts` | 标量类型解析与布局数据接口 |
| 新建 `src/backend/live-memory-plan.ts` | 对象、指针依赖、区间合并、分块与去重；尽量写成纯函数 |
| 新建 `src/backend/live-memory-reader.ts` | 定义 `MemoryReader`，实现 `GdbMemoryReader`；执行读取计划，处理部分返回、失败与字节统计 |
| 新建 `src/backend/live-memory-decode.ts` | Buffer 到数值/枚举/指针文本；保持整数精度 |
| `package.json`、`package-lock.json` | 功能配置、同步版本号 |
| `RM_DEBUG_使用说明.md` | 使用方法、准备时间、批量/兼容状态、性能验收和回退方法 |

可微调模块划分，但不应把全部逻辑继续塞进 `live-watch.ts`。

工作区已有很多未提交改动，包含用户固件和之前的插件功能。开始前读 `git diff`，保留已有改动，不做全局回滚、清理或重置。

## 6. 先定义订阅语义，避免后台读取无用字段

建立显式订阅快照。不能把 `variableHandlesReverse` 里历史创建过的所有对象都当作当前订阅。

订阅来源：

1. 普通模式：已展开树中需要显示的值，以及必要的父节点和指针地址。
2. 全部字段模式：该根对象内所有已纳入范围的内嵌成员；数组遵守 UI 明示的已加载范围。
3. 指针目标：明确展开或曲线引用时才订阅；typedef 指针遵守同一规则。
4. 曲线字段：即使树折叠，也保留该字段和到它的指针依赖。
5. 串口字段：沿用串口源，不进入此 GDB 内存读取计划。

补充规则：全部字段模式下，折叠普通内嵌结构体只是改变显示，不停止全字段采样；折叠指针目标可取消目标订阅，但保留曲线需要的目标。不要通过偷偷减少全字段模式的字段来“提高实际 Hz”。

无线探针下给数组设置可配置的**初始加载页大小**（建议先 64，按需“加载更多”），但 UI 必须明确显示总长度、当前已加载/采样范围。已加载元素都要采样；用户选择加载全部后必须按全部范围计入帧耗时与完整率。当前代码的默认 256 元素只能在有明确分页语义后调整，不允许静默截断。

前端同步 DTO 至少包含：稳定节点 ID、`gdbVarName`、根节点 ID、父节点 ID、订阅标志、数组范围、解引用边界。合成的 `*` 节点即使在 GDB 中是独立 root varobj，也必须带上它依赖的原指针节点。

每次添加、删除、改名、展开、折叠、加载更多、切换全部字段、增删曲线，都推进 `subscriptionRevision`。一次性提交订阅，不为每片叶子逐个发送设置请求。

## 7. 准备阶段：从 GDB 获取可靠元数据

### 7.1 真实表达式

仅对根、解引用边界以及无法由类型布局映射的节点调用并缓存：

```text
-var-info-path-expression <gdbVarName>
```

使用返回的 `path_expr`。不能直接使用当前 `pVar.fullExp + '.' + child.exp` 来为全部字段生成地址表达式，因为它对透明指针、匿名字段等情况未必正确。

如果根或解引用边界无法取得合法路径，标记相关对象为兼容读取；普通成员优先由已验证的类型布局映射，不必逐字段请求路径。禁止拼出一个看似合理的表达式然后继续使用错误地址。

### 7.2 地址与大小

初始化期对根对象和每个唯一类型获取必要元数据；字段偏移的首选来源是该类型的 `ptype /o` 输出。根对象的固定地址和总大小可查询：

```text
-data-evaluate-expression "(unsigned long long)&(<path_expr>)"
-data-evaluate-expression "sizeof(<path_expr>)"
```

上面是 MI 示意，真正实现时统一编码 MI 的双引号、反斜杠和控制字符；使用 `sendCommand`，不要通过 shell 执行表达式。命令构造与 shell 转义是两回事。

只自动处理已确认无副作用的变量路径。不主动运行用户函数、赋值表达式或自增表达式。无法证明是普通可寻址路径时走兼容策略，不为获取元数据执行目标函数。

对于根结构体，获取根地址、总大小。对于数据指针，分别记录“保存指针值的位置”和“指针指向对象的基址”；两者不能混为一谈。记录 `sizeof(*pointer)`，不完整 pointee 类型回退。

**准备阶段也不得默认逐字段执行 `&expr` + `sizeof(expr)`。** 对每个唯一的、带作用域上下文的结构体/union 类型执行一次 `ptype /o <type>`，解析每个具名成员的字节偏移、存储大小、padding、位域标记与聚合大小；对嵌套类型递归查询并把偏移相加，对数组用元素 stride 和订阅下标生成偏移。相同类型的多个电机实例共用布局，不重复查询。根地址按根对象取得；指针目标基址由每轮父块的指针值决定，不为目标每个成员查地址。

`ptype /o` 的排版属于 GDB CLI 文本，必须针对真实输出写严格 parser 和 fixture；不能仅按源码声明顺序累加大小。`ptype /o` 不会自动把所有嵌套 typedef 结构体递归展开，也不能单独保证 enum 的存储宽度/符号性；这两者分别继续查询子类型、`sizeof` 和已验证的纯类型 signedness 表达式。位域、匿名成员、跨行/版本差异或不明语法无法准确映射时，对受影响的少数节点做一次无副作用地址/大小校验；若仍不可信就局部回退。每个解析出的布局必须与 GDB 报告的 aggregate `sizeof` 一致，抽样核对关键成员地址，未通过不得进入批量路径。准备过程按类型和对象增量缓存，支持取消与进度显示。

### 7.3 类型分类

优先利用 `whatis <类型名>` 解析 typedef，再用 `ptype <路径或类型>` 获取必要的底层标量描述。类型查询只在准备或失效时进行。

已验证的本机输出包括：

```text
whatis /r motor_handle_t
type = motor_base_t *

ptype fp32
type = float

ptype uint8_t
type = unsigned char

ptype chassis_mode_e
type = enum {CHASSIS_VECTOR_FOLLOW_GIMBAL_YAW, CHASSIS_VECTOR_NO_FOLLOW_YAW, CHASSIS_VECTOR_RAW, CHASSIS_SPIN}
```

不要期待 `whatis /r <变量表达式>` 自动展开所有 typedef；本机对 `chassis_move.steer_motor[0]` 仍返回 `motor_handle_t`。要区分查询类型名和查询变量表达式。

实现有限、严格的类型解析：

- 指针判断基于最终声明本身，不能因结构体正文某成员含 `*` 就把整个结构体认成指针。
- 正确区分数组、指向数组的指针、函数指针、struct/union、基础标量。
- 只支持明确识别的语法；复杂或有歧义的输出回退，不能用宽泛正则默认猜成 int。
- `ptype` 可能跨多行且带 warning；解析明确的类型输出，不把 warning 混入类型。
- 若用 CLI，现有 `MI2.sendCommand(..., swallowStdout=true)` 会把输出放入 `MINode.output`。使用这条有 token 归属的收集路径，不长期监听全局日志拼接响应。
- 缓存不能仅以短类型名为键；不同源文件可能有同名类型。至少结合会话、类型上下文和确认后的大小/描述；无法确认同型时不跨上下文复用。

发现树时先拿一层节点，确认节点类型 kind 后再决定是否自动递归；不要先沿所有 typedef 指针展开到底，再补做分类。协议新增独立的 `rawType`/`typeKind`，保留现有用于显示的 `type`；当前 `VariableObject.toProtocolVariable()` 可能把 tooltip 拼进 `type`，不能拿这个显示文本解析二进制布局。

### 7.4 整数、enum 和字节序

大小必须由 ELF/GDB 确认。尤其本工程的 `chassis_mode_e` 是 **1 字节**，按固定 4 字节枚举解码会读到相邻字段。

需要确认 signedness 时，本机 GDB 已验证支持以下纯类型表达式：

```text
p ((__typeof__(chassis_move.chassis_mode))-1) < 0
=> 0

p ((__typeof__(rc_ctrl.rc.ch[0]))-1) < 0
=> 1
```

实际实现通过 `-data-evaluate-expression` 获得结果，且仅用于标量整型/enum，不能对任意用户表达式套用。获取字段大小后，把相应的有/无符号解码方式写进 descriptor。

enum 保留名字映射；处理隐式连续值、显式赋值、负值及别名。解析失败时使用初始化期的常量求值或回退，不把符号名字全部默默丢弃。

初始化查询 `show endian` 并确认指针宽度。首版可以只启用已确认的 32 位 Cortex-M little endian 快路径；其他情况明确回退。不要只凭开发主机是 Windows/x64 决定 MCU 的字节序或字段宽度。

### 7.5 计划可信度检查

每个字段记录：

```ts
interface LiveFieldLayout {
    nodeId: string;
    gdbVarName: string;
    expression: string;        // GDB 返回的真实路径
    ownerObjectId: string;     // 最近的所属内存对象
    byteOffset: number;        // 相对所属对象，不一定相对顶层 root
    byteSize: number;
    kind: 'signed' | 'unsigned' | 'float' | 'bool' | 'enum' | 'pointer';
    enumValues?: Map<string, string>; // 整数十进制文本 -> 显示名称
    signed?: boolean;
    pointerTargetId?: string;
}
```

检查 offset 非负、范围在 owner 内、大小有效、支持该类型、不存在地址溢出。位域取地址失败时不能硬猜。

如果准备期间涉及指针，读取指针值前后做绑定一致性检查。地址查询时指针已变就丢弃那批 descriptor，有限次数重试或回退。不能在指针 A 的基址上使用通过指针 B 算出的 offset。

offset 的生成步骤：从最近 owner 的类型布局递归累加成员偏移、数组 stride 与下标，得到 `offset` 和字段大小 `N`，验证 `0 <= offset` 且 `offset + N <= owner.size`。只有 parser 无法可信映射的字段才用 owner 基址 `B` 与一次性字段地址 `A` 校验 `offset = A - B`，并检查同样的范围条件。pointer owner 的基址来自本轮父对象指针值；越过真实解引用时建立新 owner，不把目标成员的地址减去顶层 `chassis_move` 地址。类型布局缓存键至少包含会话、ELF/构建身份、作用域、类型描述和大小；重新启动或换 ELF 必须失效。

## 8. 建立对象边界和指针依赖图

用对象而非纯地址列表表达计划：

```ts
interface LiveObjectLayout {
    objectId: string;
    rootId: string;
    byteSize: number;
    base:
        | { kind: 'fixed'; address: bigint }
        | { kind: 'pointer'; sourceFieldId: string };
    fields: LiveFieldLayout[];
}
```

举例：

```text
对象 A：chassis_move，固定根地址，404 字节
  字段 steer_motor[0]：A + 68，4 字节的指针
    -> 对象 B：motor_base_t，基址来自本轮 steer_motor[0]，348 字节
       字段 fb.angle：B 内的偏移，元数据期确定
       字段 driver：B 内的指针；只有显式展开才产生对象 C
```

同一对象内的普通嵌套结构体和数组不增加指针依赖层。新的对象边界出现在实际解引用处。支持 union 字段重叠，共用同一份字节。

设定可配置的最大解引用深度与每轮字节预算；预算命中时将未采样分支标为部分帧并显示原因，不能把它算成完整帧。同一依赖层的多个电机目标在父块指针值全部确定后共同规划、去重、合并；只有跨依赖层的读取必须顺序等待。深度限制防止无界指针链，不能让默认值意外排除截图中的 `chassis_move → steer_motor[i]` 及已明确展开的一层目标。

指针是稳定关系但其值不是常量。不能只在首次展开时缓存解引用地址，然后一直读旧地址。

为了确保可实施，第一步优先覆盖全局/文件静态根变量以及其内部成员。对于独立添加的复杂根表达式，例如 `table[index_variable]->field`，若无法建立 `index_variable` 和每级指针的完整依赖，则该表达式兼容读取；不要宣称这类表达式也拥有固定地址。

固定地址局部变量功能沿用现有生存期提示，不将普通栈局部变量假设为永久全局变量。

## 9. 读取区间合并与完整响应校验

### 9.1 分块原则

建议初值：每个内存请求上限 1024 字节，支持在 256 字节到 8 KiB 间自适应；实际最大值还要受 GDB/远端分包能力、完整响应校验和实测时延约束。按同一探针的 `msPerCommand`、`bytesPerCommand`、失败率选择块上限，采用有限档位与滞回，避免每帧抖动。

- 同一个已知普通内存对象中，密集字段合并成对象范围或连续区间，允许包含确定属于对象的 padding。
- 例如全字段 `chassis_move` 可读 404 字节，单个展开的 `motor_base_t` 可读 348 字节。
- 很大的数组按当前订阅范围建立区间，不能因展开 64 个元素就读完整个巨大数组。
- **跨对象合并是本次实现范围**：同一指针依赖层、同一个已验证的普通 RAM region 内，对重叠、相邻或间隔不大于阈值（初值 256 字节，可配置）的对象区间合并；按最大块上限拆分。先合并多个电机/PID 等同层对象，再发命令，不能机械地“每对象一块”。区域边界、读副作用、总多读字节预算不允许时停止合并。
- 同一地址范围本轮只读一次；不同节点指向同一电机时共享原始字节，但各自保留自己的树节点、类型解释和订阅关系。
- 指针环按当前遍历路径检测；同址别名不是一定的循环，不能误删合法别名。限制依赖深度、订阅字段数和单轮总读取字节数，并显示达到限制的原因。

不能凭地址接近就跨空洞读取。先建立普通 RAM 白名单，再允许跨对象合并。每个拟读取区间（包括对象间空洞）必须**整体**落在同一个白名单 region；外设/MMIO、未知区域或边界交叉一律不跨对象合并，并将对象自身无法证明可读的部分送入兼容路径。不能把任意可读寄存器当普通 RAM，因为合并会引入额外读副作用。

白名单来源优先级：① 用户显式配置并确认的普通 RAM 区间或目标内存映射中明确标为 RAM 的区间；② 能可靠解析的链接脚本 `MEMORY` 声明与所用 ELF/固件对应的 RAM 区间；③ 已分配且可写的 ELF section 只证明**该 section 自身**，可用于保守地纳入确定的全局/静态对象。`maintenance info sections`/objdump section 是辅助校验，**`.data/.bss` 不覆盖堆和栈**，不能由 section 边界推断整段 RAM；若无完整 RAM map，堆/栈对象保留兼容读取或只读已验证的对象范围，不跨未知间隔合并。区域信息若冲突或来源不可信，取交集或回退。H7 链接脚本中的 DTCM、RAM_D1/D2/D3 仅作 fixture，通用插件不得硬编码 H723 地址。

合并块读取失败时，按有上限的二分拆解，定位失败小块；成功块继续解码，失败范围的字段标为不可用或局部兼容。不要每轮反复试探同一失败空洞；按 session/revision 缓存失败原因，地址/region/指针变动后再试。拆分产生的命令必须计入本轮统计。

### 9.2 读取接口

```text
-data-read-memory-bytes <本轮确定的地址> <长度>
```

现有 `MI2.examineMemory()` 的 `parseReadMemResults()` 仅拿 `memory[0].contents`。新接口必须解析全部返回片段，根据 `begin/end/offset` 校验覆盖范围，拒绝空洞、重叠冲突、非法 hex 或短数据。不能默认第一片就覆盖全部请求。

不强制修改所有旧调用方；可以新增严格的 `readMemoryRange` 供批量引擎使用。

现有 `src/frontend/memreadutils.ts` 的 `MemReadUtils` 是**前端**分块包装，调用 `session.customRequest('read-memory')`；`src/gdb.ts:1544` 的该请求使用主调试 `this.miDebugger`，不是独立 Live GDB，且复用现有只取首片段的解析器。其 `readMemoryChunks()` 还会在 `.catch()` 中吞掉单块异常，不能照搬失败处理。可借鉴其分块思路，但采样引擎不得直接以它作为后端；`GdbMemoryReader` 必须走 Live GDB 会话的 MI 连接，并完成多片段严格校验。

可在本机 GDB/远端上**实验** `set remote memory-read-packet-size`，记录设置前后的实际 MI 延迟、返回完整性和底层分包情况；设备不支持或变慢时恢复默认。此设置影响 GDB 到远端的请求大小，不等于一次 MI 命令必然对应一次 RSP/SWD 事务，也不应无条件写进用户主调试会话。

一次 MI 请求可能被 GDB/服务端拆成多个 RSP 包，不能把 MI 请求数当作 SWD 事务数。实际速度仍要在目标板上测量。

## 10. 稳态采样算法

```ts
async function sample(plan, generation) {
    // 同一会话最多有一个采样周期在途。
    const frame = createFrame(generation);

    for (const dependencyLevel of plan.levels) {
        // 当前层指针值来自本轮已完成的父对象读取。
        const ranges = resolveAndMergeRanges(dependencyLevel, frame);
    const blocks = await memoryReader.readRanges(ranges);
        decodeFieldsIntoFrame(blocks, frame);
    }

    await evaluateCompatibilityFieldsOnly(frame);
    if (!stillCurrent(generation)) { return; }
    updateVariableObjectCache(frame);
    publishFrameToPlotsAndUiQueue(frame);
}
```

必须满足：

1. 全部字段由块读取覆盖时，稳态周期不调用 `var-update *`。
2. 不为每个字段调用 `data-evaluate-expression`、`var-list-children`、`ptype`、`sizeof` 或地址查询。
3. 普通内嵌结构不增加采样轮数，只有真实指针依赖增加读取层次。
4. 本轮先拿到父对象中的指针值，再读取它指向的目标；不能先用上轮指针读目标，再把新指针值与旧目标数据拼在一起发布。
5. 若目标类型和大小不变，指针换址时复用字段相对偏移，只改变对象基址；无法证明仍适用才局部重建计划。
6. 同一 GDB/MI 连接保留现有串行命令队列。大量 `Promise.all` 不会让单条 SWD 链路自动并行，禁止把取消队列当成主要加速手段。
7. 对批量解码的数值同步更新适配器自己的值缓存，供 UI、复制值、后续展开和波形使用；不要继续依赖 GDB varobj 的旧缓存值。
8. 准备/展开时 GDB 返回的旧 varobj 值不能覆盖刚获得的新内存样本；新字段首次完成批量读取后才标记为新鲜数据。

`VariableObject` 值缓存、前端树值和曲线必须绑定同一 frame generation。批量读完成时先写适配器自己的缓存，再发布帧；需要 GDB 原生展开/复制/格式化的入口若会触发旧 `var-evaluate-expression`，应改为从新缓存读或明确执行新的一次读取，不能用旧 varobj 值覆盖它。回退字段也在同一个 generation 内合并。

这里提供的是顺序读取的采样帧，不保证 MCU 所有字段来自同一个控制周期。MCU 持续写内存时，跨块和大块都可能跨越固件更新；精确原子快照需要固件序号/双缓冲配合，本任务不修改固件来实现这一点。

## 11. 解码与数据正确性

- 用目标字节序解码 Buffer；禁止按宿主字节序读取。
- 支持 1/2/4/8 字节有符号和无符号整数。64 位使用 BigInt，再转文本，不能经 Number 造成精度丢失。
- 当前 TypeScript target 是 ES6，遵循仓库现有 `BigInt(...)` 写法，不直接引入无法通过现有配置的 bigint literal；地址只有通过安全范围检查后才能转成旧 MI2 接口使用的 Number。
- float/double 使用实际字节宽度。显示支持 NaN、Infinity、负零；波形不支持的非有限值输出空点。
- bool 根据存储值转 true/false。enum 按真实宽度与符号性解码，并通过枚举表保留名称。
- 指针显示十六进制；函数指针继续复用现有 ELF 符号匹配/源码跳转，不读取代码地址当作数据对象。
- 类型别名 `fp32`、`uint8_t`、`motor_handle_t` 必须经类型解析，不依赖名称猜测。
- `packed` 字段可以未对齐，使用 Buffer 的偏移读取，不自行补齐。
- 符合条件的 union 字段各自解码同一块重叠字节；不能把重叠误判为重复字段而删掉。
- 字符类型的文本显示可保持现有形式或统一数字显示，但其底层数值、进制切换、变化高亮必须正确。
- 分配/读取前校验字节范围和大小；任何布局不可信的字段回退，不把异常吞掉后显示 0。

## 12. 失败、回退和缓存失效

### 12.1 回退粒度

提供 `auto / legacy` 模式，默认 auto，便于同一硬件 A/B 对比和快速回退。

- auto：适合的对象/字段进入批量计划，其他进入兼容队列。
- legacy：明确使用原 GDB var-update 路径。
- 支持字段与不支持字段混合时，不要一边批量读，一边仍执行 `var-update *`，否则整个加速会失效。
- 首选只对回退字段执行已确认无副作用的 `data-evaluate-expression`，按稳定 nodeId 更新其值；不能对刚批量读完的所有字段再求值。
- 如果某种复杂对象只能使用整对象 legacy，就将该对象作为回退边界并统计成本。不能因单个位域让所有其他根对象退回旧模式。
- 对“var-evaluate-expression 是否会重新读取目标”的语义不能想当然；不要拿 GDB varobj 缓存当新采样。

### 12.2 读取失败

- 一个对象块读取失败只影响覆盖它的字段，其他对象仍可更新。
- 失败字段标记 unavailable/stale，曲线写入 null；不能继续把上次值算作本轮成功。
- 可对块大小/失败区间进行有上限的拆分尝试，避免每轮无限拆分和重试。
- 重复失败进入有退避的对象级兼容状态；新会话、订阅变更或明确重试时恢复检测。不要每个 50 ms 周期都重新解析整个类型树。
- 空指针不读目标地址 0；无效指针只使其目标分支失效，父对象和其他电机继续刷新。

### 12.3 失效规则

| 事件 | 处理 |
|---|---|
| 新会话、会话结束、换 ELF/重新加载符号 | 清空对应计划、地址和类型上下文缓存；丢弃旧回调 |
| 增删订阅、展开/折叠、数组加载更多 | 更新 revision；只准备有变化的部分 |
| 指针值变化 | 使用本轮指针基址，失效旧目标数据，必要时局部重建 |
| 普通字段值变化 | 只更新数值，**不重建布局** |
| 类型/大小/动态对象形状变化 | 对受影响对象退出快路径并重新发现 |
| 运行/暂停切换 | 统一调度，暂停状态不叠加后台周期；按现有行为允许一次同步刷新 |
| 删除或改名监控 | 删除实际 GDB root varobj 及依赖、同步撤销计划，不留下隐藏采样负载 |

当前 `findOrCreateVariable` 在 name 已存在时可能复用旧 handle，却没有替换里面的旧对象。涉及重建时必须核查值、类型、children/rangeChildren 和布局元数据是否同步，不能让新 UI 节点与旧 backend 对象分离。

## 13. 调度与前端集成

### 13.1 防止重入

现有前端手动刷新、定时刷新、展开、删除清理可能重叠。此次引入统一调度：

```text
Idle -> Preparing -> Sampling -> Waiting
                 \-> Cancelled / Compatibility
```

同一会话最多一个准备/采样/清理操作在关键执行区。手动操作合并为下一次 revision，不能在读取途中重置 Handles 后让旧请求继续写入。

用 `sessionId + subscriptionRevision + generation` 校验结果；这三者不匹配就丢弃。原生请求不能立即取消时，等它结束再换计划，但不得发布过期数据。

按目标周期扣除实际采样耗时；采样超时不叠加更多请求，不每轮输出 overflow 日志。准备阶段单独计时，不纳入成功采样 Hz。

### 13.2 采样与树重绘解耦

现有 `src/frontend/views/live-watch.ts` 的 `refresh()` 在 `fieldRefresh.finally` 中更新树、收集曲线并重新启动采样定时器，UI 工作会拉长采样周期。改成接收完整 frame 后立刻更新数据缓存和曲线，再按采样器完成时间安排下一轮；树事件节流到约 100–200 ms（可按 UI 负载调节），同一时间窗口内合并节点变更。后端仍只允许一个读取周期在途，前端不得因 UI 合并丢弃曲线帧。标题的“完整帧实际 Hz”以**采样完成时间及完整覆盖**计算，另计 UI 重绘次数/耗时，不能靠减少树事件或漏采字段抬高 Hz。会话关闭、revision 改变时清理排队的旧 UI 更新。

### 13.3 推荐响应

扩展 `liveCacheRefresh` 或新增 `liveMemorySample` 均可，但在全项目保持一种清晰协议。示例：

```ts
interface LiveMemoryFrame {
    sessionId: string;
    revision: number;
    generation: number;
    mode: 'bulk' | 'mixed' | 'legacy';
    values: Array<{
        nodeId: string;
        gdbVarName?: string;
        value?: string;
        status: 'ok' | 'unavailable';
        error?: string;
    }>;
    startedAtMs: number;
    completedAtMs: number;
    stats: {
        requestedBytes: number;
        receivedBytes: number;
        blockCount: number;
        memoryReadCommands: number;
        msPerCommand: number;      // 本轮各内存命令实测平均值，另保留分布/最大值
        bytesPerCommand: number;   // 实收字节 / 内存命令数
        commandLatenciesMs: number[];
        mergedGapBytes: number;
        uiRedrawMs?: number;       // 前端另报，不计入采样 frame 耗时
        fallbackFieldCount: number;
        subscribedFieldCount: number;
        successfulFieldCount: number;
        prepareMs: number;
        readMs: number;
        decodeMs: number;
        totalMs: number;
    };
}
```

所有成功/失败字段必须能在当前 frame 中区分。完整帧才计入“完整采样实际 Hz”；部分成功仍可更新 UI，但单独显示覆盖率/部分状态，不通过省略慢字段来抬高完整采样 Hz。

标题保持简洁，例如：

```text
20 Hz → 12.4 Hz · 批量 3 块 / 1100 B
```

详细准备耗时、MI 请求数、每命令延迟/字节、合并空洞字节、兼容字段和错误放在状态说明/输出面板；字段树仍显示业务变量。波形使用同一轮结果，不启动第二条读取循环。必须分别记录 `memoryReadCommands` 与实际 RSP 包数（仅在可观测时），不能混称“探针事务”。

首次准备可能比一次普通刷新慢，明确显示“准备采样布局，已处理 X/Y 字段”；不能把这个阶段卡住的界面误表现成 0 Hz。

## 14. 按顺序完成的实施步骤

### 步骤 A：建立基线与测试数据

1. 阅读现有需求文档、本方案和上面列出的代码。
2. 记录工作区已有改动和当前版本，核对运行版本。
3. 为 `rc_ctrl`、`chassis_move`、`motor_base_t` 保存本地 ELF 的 `ptype /o`、嵌套 typedef、enum、类型/大小输出作为 fixture；先确认匿名成员和位域能否映射，不硬编码到生产逻辑。
4. 用本机 GDB/MI 验证根地址、`ptype /o` 偏移、sizeof、类型分类、signedness、字节序查询的真实输出格式；将静态布局与关键地址抽样核对。
5. 为新引擎记录每类 MI 命令次数、准备和稳态耗时；不要先更改探针速度或固件来掩盖差异。

### 步骤 B：实现类型与订阅

1. 增加独立的类型 kind 信息，修正 typedef 指针自动展开。
2. 实现带 revision 的订阅快照和 owner/pointer 关系。
3. 确保数组分页、曲线折叠订阅、全部字段模式的语义明确。
4. 实现按唯一类型缓存的 `ptype /o` 布局解析和必要的真实路径/根地址发现；对不支持的路径返回结构化原因。先以 H7 的 `chassis_move` 和 `motor_base_t` fixture 跑通嵌套、typedef、union/位域边界，再进入读取引擎。

### 步骤 C：先打通纯对象批量读

1. 实现普通 RAM 白名单、严格内存响应解析、跨对象区间合并、`MemoryReader`/`GdbMemoryReader` 和解码。
2. 让 `rc_ctrl` 和不跟随指针的 `chassis_move` 在稳定采样时走批量路径。
3. 验证全字段已覆盖、没有 `var-update *` 和逐字段求值混入热路径。
4. 做一个“同一块字节从 10 个订阅字段增加到 100 个”的测试，证明内存请求数保持相同。

### 步骤 D：完成用户截图中的指针场景

1. 接入 `chassis_move.steer_motor[0]` 等显式展开的电机对象。
2. 从父块读取指针值后再安排目标块；处理换址、null、无效地址、多级依赖和共享目标。
3. 保留每个展开电机的 fb、ctrl 等已订阅字段，不能只读一两个反馈值来替代完整需求。
4. 通过指针变化与循环测试后才能认为截图场景完成。

### 步骤 E：集成故障恢复、调度和 UI

1. 将准备、采样、清理串行调度；处理 session/revision 过期响应。
2. 接入字段失败状态、曲线空点、真实成功 Hz、兼容说明。
3. 保留旧模式开关，用于同样订阅条件下对比；将采样与树重绘解耦，并记录每命令延迟、字节数及 UI 重绘耗时。
4. 用户删除监控、收起指针或关闭图窗后，确认后台请求确实减少。

### 步骤 F：检查、打包、更新文档

1. 运行本次新增模块的必要测试、TypeScript 编译和 lint。
2. 构建生产产物，按工作区最新版本递增 patch，生成新的 VSIX。
3. 检查 VSIX manifest 版本、最新 adapter/frontend bundle、串口/USB 原生依赖和许可证。
4. 更新使用说明与本方案实施状态，报告实测结果；没有硬件时明确尚未实测。
5. 交付可安装 VSIX 路径、验证记录和剩余限制。安装到用户正在使用的 Profile 按会话已有授权执行；不要擅自启动会使运行中的机器人停机或复位的硬件会话。

## 15. 必须覆盖的验证

本次涉及数值解码和地址绑定，测试有必要，不能只以编译通过作为完成依据。

### 15.1 纯函数和模拟读取测试

| 用例 | 验收点 |
|---|---|
| 正负整数、uint 最大值、64 位 > 2^53 | 数值准确，无 Number 精度损失 |
| 1 字节 enum、带显式值和负值的 enum | 宽度/符号/名字正确 |
| float/double、NaN/Inf、负零 | 解码与显示/曲线策略正确 |
| packed `rc_ctrl`、未对齐字段 | 不按宿主对齐规则错位 |
| union 重叠字段 | 共用字节，分别解码 |
| 多段 memory 返回、短读、空洞、无效 hex | 不制造“成功”的错误值 |
| 10/100/500 字段位于同一已知对象块 | 增加字段不增加每字段远程请求 |
| 大数组只加载 64 个元素 | 请求范围受订阅控制 |
| 全部字段数组从初始页加载更多至全部 | UI 明示范围；所有已加载元素被采样；完整帧 Hz 不因隐藏字段虚高 |
| 多个同层电机对象位于同一普通 RAM region 且间隔小于阈值 | 合并后命令数低于对象数，数据准确 |
| 对象之间有未知内存或 MMIO | 不跨区间合并、不扩大副作用读取 |
| 合并块局部失败 | 有限二分，成功子块继续更新，失败子块回退并计入命令数 |
| 1 个失败块 + 2 个成功块 | 成功对象继续更新，失败字段为空/不可用 |
| typedef 指针未展开 | 不意外递归进入 motor 对象 |
| typedef 指针显式展开 | 父块 + 目标块正确读取 |
| 指针 A -> B、A -> null、非法地址 | 不发布旧对象字段作为新指针目标 |
| 两节点共享目标、指针环 | 同址读取去重，环不无限展开 |
| 采样中删除/改名/加载更多/结束会话 | 过期结果丢弃，不覆盖新状态 |
| bulk 与 legacy 混合 | 快对象不被 `var-update *` 重新遍历 |
| 值完全没变 | 有真实成功读取，仍计算有效采样轮次 |

模拟 transport 可增加固定每次调用延时来验证减少往返确实降低模型耗时，但只能称“模拟结果”，不能写成探针实测速度。使用命令记录断言热路径，而不只断言函数输出。

### 15.2 实机对比表

在同一探针、同一 SWD 速度、同一 ELF、同一订阅范围、相同日志设置下测试 legacy 与 auto。准备完成后预热 10 秒，再测至少 30 秒；记录失败率和完整采样数。

| 场景 | legacy 实际 Hz / 周期 | auto 实际 Hz / 周期 | 块数/字节数 | 回退字段数 | 数值一致性 |
|---|---|---|---|---|---|
| `rc_ctrl` 全字段 | 待测 | 待测 | 待测 | 待测 | 待测 |
| `chassis_move` 内嵌全字段，指针不展开 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 加一个显式展开电机 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 多个显式展开电机 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 同内存范围 10 个 / 100 个字段 | 待测 | 待测 | 应相同或近似 | 待测 | 待测 |
| 曲线打开 / 关闭 | 待测 | 待测 | 不应产生第二轮采样 | 待测 | 待测 |
| 树 100–200 ms 节流 / 不节流 | 待测 | 待测 | 采样帧和曲线帧数量一致 | 待测 | 待测 |
| 删除大对象后只剩 `rc_ctrl` | 待测 | 待测 | 应降回小对象规模 | 待测 | 待测 |

性能验收先看机制是否成立，再看硬件速度：

- 404 字节 `chassis_move` 在 1024 字节块上限下，且无不支持字段时，应只需一个对象内存读请求；不能仍有几十/上百次逐字段请求。跨对象同层合并成立时，多电机请求数可低于对象数。
- 一个额外 348 字节电机对象通常只增加一个对象块及必要的依赖阶段，不应按其成员数成倍增加 MI 请求。底层 RSP 分包数量另行记录。
- 对相同对象范围增加显示字段，稳态远程请求数应基本不变。
- 在同一 RAM 块中从 10 个增至 100 个字段时，MI 内存命令数应相同，完整帧时长主要随总字节和指针层数变化；记录 `msPerCommand`、`bytesPerCommand`、失败拆分命令数。布局准备命令数应主要随唯一类型数变化，而非实例字段数变化。
- 若仍约 0.6 Hz，必须根据 readMs、fallback 请求和实际命令记录继续定位，不能只交付新版并要求用户“再试试看”。
- 目标是大幅改善大结构体退化，不预先保证 20 Hz 或某个倍数。任何提速数字必须来自上述同条件测试。

`rc_ctrl` 当前约 16.2 Hz 是现有路径的测量值，不可把约 60 ms 当成新路径的硬件下限，也不能预告 `chassis_move` 必然达到 10–16 Hz。先验证“同块字段数增加时远程命令数/帧时基本稳定”和同条件真实提速，再按链路下限优化。

进行逐值一致性比对时，可由用户在合适时机暂停 MCU；在持续运行的控制变量上，两次顺序读取本来就可能不同，不能把时间差误判为解码错误，也不能直接跳过正确性验证。

## 16. 构建与现有环境注意事项

现有脚本：

```powershell
npm run test-compile  # 实际执行 tsc -p ./，是编译检查
npm run lint
npm run package
```

`package` 会触发生产构建和 `scripts/prepare-package.js`。后者总是对 `binary_modules` 执行 `npm ci --omit=dev`，再复制到 `dist/node_modules`。

上一轮在 npm 用户缓存处遇到 EPERM，生产构建/lint 已通过，最终使用已有且未变更的 `dist/node_modules` 完成了 0.1.19 打包。不要把该失败说成业务代码错误，也不要未经检查一直重试同一命令。

优先在项目内使用 `.npm-cache` 并遵守执行环境的网络/文件权限。若复用现有原生依赖，先验证其版本与 lockfile 及 Windows 预编译绑定一致，记录打包方式。不能交付缺少 serialport/usb native binding 的 VSIX。

目前有 rm_debug 与上游 Cortex-Debug 共用调试类型的历史。验收时确认活动扩展为本次构建；不要为了测试随意卸载用户其他 Profile 的扩展。

## 17. 不要把这些动作当作问题已经解决

- 只把 300 ms UI 刷新间隔改小。
- 只提高目标 Hz 或删除延时。
- 只把前端请求改为 Promise.all。
- 批量读之后仍调用 `var-update *`。
- 每一轮重新查询所有地址、sizeof 和类型。
- 通过减少“全部字段”真实采样覆盖率来提高标题里的 Hz。
- 仅按 C 源码声明顺序累加 sizeof，忽略 padding、packed、union 或短枚举。
- 只读 `chassis_move` 自身 404 字节，就声称已经读到了 `steer_motor[0]` 指向的 348 字节对象。
- 缓存指针目标地址却不处理换址。
- 默认按 32 位 enum 解码，或通过 Number 保存 uint64。
- 把 GDB Python 当作本机可用前提。
- 首轮初始化很慢后每次重建都再跑同样全量流程。
- 用 ELF `.data/.bss` 的边界冒充整段堆/栈 RAM，或跨未经证明的空洞合并。
- 将一个 MI 命令数直接当作一次 RSP 包或 SWD 访问数。
- 只报告编译通过，不说明读取命令数、覆盖率和未实测项。

## 18. 完成定义与交付说明模板

只有以下条件满足，才将本任务标记为实现完成：

1. 实际热路径已使用对象块读取和本地解码；类型/地址元数据不会每轮重新查询。
2. 支持真实 ELF 中的短枚举、packed `rc_ctrl`、普通 `chassis_move`，以及截图里的显式电机指针展开。
3. 指针、数组、失败、回退、会话切换和并发修改均有对应测试或可复核证据。
4. 全字段覆盖与旧功能语义保留，未把少读字段伪装成提速。
5. 生成新 VSIX，并记录运行版本、验证命令与结果。
6. 实机可访问且已获测试授权时完成同条件对比；若没有硬件访问条件，明确区分“软件机制验证完成”和“真实探针性能未验证”，给出可复现验收步骤，不填造频率。

向用户报告时，按以下顺序说明：实际改动后的读取方式；字段/对象覆盖；真实测得的请求数与速度；新 VSIX 路径；仍有限制的场景。不要反复要求用户确认已经授权的源码实现工作。

## 19. 后续可选：OpenOCD Tcl 直读后端

仅当 GDB 批量路径完成并由真实命令延迟证明 GDB/MI 固定开销仍是瓶颈时实施。保持第 4 节定义的 `MemoryReader` 接口，新增 `TclMemoryReader`，通过 OpenOCD 已启用的 Tcl RPC 在一个请求中读取同层多个安全区间，再按相同的完整性校验、白名单、revision 与 frame 规则发布。核对 OpenOCD 版本、Tcl 端口、`read_memory` 命令行为、回包大小和运行态读限制；不要假定所有探针/配置都开放 RPC，也不要与 GDB 采样并行争用同一目标。比较相同订阅、相同块计划下两后端的真实延迟，只有 Tcl 路径确实更快且正确时才开放选项。该后端不是本次首版完成门槛。

## 20. 参考依据

以下官方文档用于核对命令语义，具体兼容性以本机 GDB 输出和测试为准：

- [GDB/MI Variable Objects](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Variable-Objects.html)：变量对象与真实路径查询。
- [GDB/MI Data Manipulation](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Data-Manipulation.html)：表达式求值及内存读取响应。
- [GDB Symbols](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Symbols.html)：`ptype`、`whatis` 和布局输出。
- [GDB Remote Configuration](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/Remote-Configuration.html)：内存读分包配置。
- [OpenOCD Tcl Scripting API](https://openocd.org/doc/html/Tcl-Scripting-API.html)：可选 Tcl RPC 的接口行为。
- [OpenOCD General Commands](https://openocd.org/doc/html/General-Commands.html)：`read_memory` 命令。

本文中的对象大小、typedef 和 GDB Python 不支持结论来自本地工具与真实 ELF 的实际查询。性能目标与模块设计属于实施方案，不代表已经取得相应实测结果。
