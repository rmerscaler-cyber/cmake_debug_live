# rm_debug：Keil 式 CMake 文件与头文件目录管理实现方案

## 1. 目标和参照工程

本方案是功能设计和验收基准。参考工程为 `E:\code_for_rm\cmake_h7_duo`，实现时只读取它作为样例，不自动修改它。当前工作已进入源码实现阶段，下面的验收表仍代表完整工程验收标准；尚未通过真实 CMake 工程编译验证的部分不能标记为完成。

用户希望在 `rm_debug` 的“工程”侧栏像 Keil 的 Project 窗口一样，自己决定哪些文件参与编译：

1. 浏览工程内现有 `.c` 文件，**逐个或多选**加入指定分组，使这些被选中的文件参加 CMake 编译。只把文件复制进文件夹、在编辑器打开文件，均不等于加入编译。
2. 选择 `.h` 文件或目录，使其所在目录成为编译器的头文件搜索路径。**头文件本身不是编译单元**，不能把 `.h` 当成 `.c` 加入 `target_sources`。
3. 新建一个带独立 `CMakeLists.txt` 的模块文件夹，并由上层 `CMakeLists.txt` 调用 `add_subdirectory()`。之后向此模块添加、移除 `.c` 和头文件目录。**模块文件夹就是本插件的 Keil 式分组**。
4. 不要求用户手写 CMake 命令；修改结果仍是清晰、可提交到 Git 的普通 CMake 文件，团队换电脑后可复用。

Keil 官方文档中的关键行为是“把选定文件加入分组”“可以从当前 Target Build 排除单个文件”；分组本身只是组织方式。这里按用户要求把分组落成物理目录和 `CMakeLists.txt`，让最终 CMake 内容直接决定编译集合。参见 [Keil 添加文件](https://www.keil.com/support/man/docs/uv4/uv4_ca_sourcefiles.asp)、[分组说明](https://www.keil.com/support/man/docs/uv4/uv4_ca_projtargfilegr.asp)、[排除文件](https://www.keil.com/support/man/docs/uv4cl/uv4cl_dg_property.htm)。

**最重要的不变量：插件绝不以 `*.c`、`file(GLOB ...)`、递归扫描结果自动作为编译清单。只有用户明确勾选或添加的 `.c` 才能进入 `target_sources()`；同目录没选的 `.c` 保持不编译。** “扫描目录”仅用于显示候选文件，不写 CMake。

参考工程的真实结构如下，**不要把每个子文件夹误当成一个新静态库**：

| 文件 | 作用 |
|---|---|
| 根 `CMakeLists.txt` | 创建 `${CMAKE_PROJECT_NAME}` 可执行目标，定义 `h7_platform`，`add_subdirectory(bsp/device/model/app)`，最后链接四个层级库。 |
| `bsp/CMakeLists.txt` | 定义 `h7_bsp` 静态库，列出 BSP 源文件与公开头文件目录。 |
| `device/CMakeLists.txt` | 定义 `h7_device` 静态库，调用 `add_subdirectory(comm/driver/tasks)`。 |
| `model/CMakeLists.txt` | 定义 `h7_model` 静态库，调用 `add_subdirectory(motor/imu/...)`。 |
| `app/CMakeLists.txt` | 定义 `h7_app` 静态库。 |
| `model/motor/CMakeLists.txt` 等叶子文件 | 使用 `target_sources(h7_model PRIVATE ...)` 向**父层已经定义的目标**加源文件；通常不再 `add_library()`。 |

例如新建 `model/pid/`，插件应让其归属 `h7_model`，在 `model/CMakeLists.txt` 中加入 `add_subdirectory(pid)`，在 `model/pid/CMakeLists.txt` 中写 `target_sources(h7_model PRIVATE ...)`。不应自作主张创建 `h7_pid`、改动根目录 `--whole-archive` 链接顺序，或修改 CubeMX 生成的 `cmake/stm32cubemx/CMakeLists.txt`。

## 2. 首版范围

### 必须完成

- 侧栏增加 **CMake 工程分组树**。树中列出模块、已加入编译的 `.c`、未加入编译的候选 `.c`，以及头文件目录；状态明确显示“参与编译 / 未参与编译 / 由原有 CMake 管理 / 状态待确认”。
- 在树和命令面板提供 **添加已有 C 文件**、**新建 C 文件并加入编译**、**移出编译**、**添加头文件目录**、**移除头文件目录**、**新建 CMake 分组** 六个核心操作；另提供刷新、打开分组 CMake 文件和定位源文件声明。多选 `.c` 可批量添加或移除。每次操作由用户指定具体文件，不能默认把整个目录内所有 `.c` 加进来。
- 点击某个分组后添加文件，默认归属该分组。可以把不同物理目录的 `.c` 加入同一个分组，只要路径仍在工程内；分组树显示其完整相对路径，不复制文件。首版不提供“移动物理文件”。
- 支持工作区根目录就是工程，以及工作区根目录下只有一个或多个 CMake 工程；复用 `RmWorkflow.workspaceFolder()` / `projectDirectory()` 的现有选择逻辑。
- 支持参考工程这种“父层 `add_library()`、子文件夹 `target_sources()`”布局，也支持 `test_cortex` 这种单个可执行目标。
- 文件可以处于工程的子目录，路径写成相对于 CMake 文件的可移植路径。**不把 `E:\...` 或用户目录绝对路径写入项目 CMake 文件。**
- 重复执行同一操作是幂等的：同一源文件、同一 include 目录、同一 `add_subdirectory` 不重复添加。移出编译只删 CMake 引用，不删除磁盘上的源码。
- 只修改 CMake、用户明确要求新建的模块目录和空 `.c` 文件；不移动或改写已有 `.c/.h`，不自动烧录。

### 首版不自动做

- 不自动从新目录推断跨层链接关系；新建顶层独立静态库、调整 `h7_app → h7_model → h7_device → h7_bsp` 的依赖或根目录链接顺序，属于后续能力。
- 不支持把工程外部的绝对路径加入共享 CMake；提示先把文件放到当前 VS Code 工作区内。
- 不尝试修改或覆盖 CubeMX 生成的 `cmake/stm32cubemx/CMakeLists.txt`、`Drivers` 等生成目录中的管理文件。
- 不自动支持 `.cpp`；若未来开放，先确认工程启用了 `CXX` 语言及对应工具链。首版文件选择器只接收 `.c`。

## 3. 用户交互与结果

### 3.1 分组树与文件状态

树形结构示例：

```text
CMake 工程  cmake_h7_duo
  model  → h7_model
    motor  → h7_model
      ✓ dji_motor.c                     参与编译
      ✓ lk_motor.c                      参与编译
      ○ spare_motor.c                   未参与编译
      头文件路径: model/motor           PUBLIC
    pid  → h7_model
      ✓ pid.c                           参与编译
```

`○` 文件来自当前 CMake 分组目录的直接 `.c` 候选，绝不因显示在树中而进入编译；添加对话框允许从整个工程选择文件。`✓` 来自明确的 CMake 源项；`compile_commands.json` 只用于核对上一次配置的结果。若二者冲突，显示“配置待刷新”，并以 CMake 文本作为编辑依据，不把旧编译数据库当作最新状态。树节点右键提供“加入编译”“移出编译”“打开文件”“定位 CMake 声明”。文件夹右键提供“添加已有文件”“新建文件”“新建子分组”“添加头文件目录”。

### 3.2 添加已有 C 源文件

1. 用户先点分组（例如 `model/motor`），再点 **添加已有 C 文件**；文件选择器允许多选，只接受 `.c`。从命令面板直接启动而未选分组时，先让用户选择目标分组。
2. 选择器可以从整个工程挑文件，包括尚无独立 CMake 文件的目录。**最终写入的是用户选中的文件，不是所选目录中的全部文件。** 如果希望给该目录建立自己的分组，再单独执行“新建 CMake 分组”。
3. 当前分组决定 CMake 写入位置和归属目标；不是由源文件所在目录自动决定。`model/motor` 应识别 `h7_model`；`device/comm` 应识别 `h7_device`；`test_cortex` 应识别 `${CMAKE_PROJECT_NAME}`。存在多个合理目标时弹出目标列表，不猜测。
4. 预览待添加的文件清单和目标，例如“把 2 个文件加入 `h7_model` 的 `model/motor/CMakeLists.txt`”；用户确认后一次写入。写入后树节点变成“参与编译”，并给出 **打开 CMake 文件** 和 **立即编译**。只有点击“立即编译”才调用现有 `rm-debug.build`。

### 3.3 新建 C 文件并加入编译

在分组右键选择 **新建 C 文件并加入编译**，输入文件名，默认在该分组的物理目录创建空 `.c`；若文件已存在则停止，不覆盖。创建文件和修改 CMake 在同一次编辑计划中完成。创建后立即显示为“参与编译”。这是 Keil 的“Add New Item to Group”对应能力。

### 3.4 从编译中移除

对一个或多个已加入的 `.c` 选择 **移出编译**，只删除这些文件在对应目标中的 CMake 引用，文件仍留在磁盘与分组候选列表里。插件管理区域中的文件可直接移出。手写 `target_sources()` 内的文件，仅在解析到明确的单个字面量路径且能精确定位该参数时提供移出；复杂变量、生成表达式和 GLOB 项显示“由原有 CMake 管理”，打开 CMake 声明供手动处理，绝不能误删整个表达式。下次 Build 后才以编译数据库核对最终编译状态。

### 3.5 添加和移除头文件目录

1. 点击 **添加头文件目录**，允许选择一个目录，或选择一个 `.h` 文件并取其父目录。
2. 由用户所选分组确定 CMake 文件和目标，路径处理与添加 `.c` 相同。**只写 `target_include_directories`，绝不把 `.h` 写入 `target_sources`。**
3. 对静态库目标提供可见性选择：**PUBLIC（供依赖此库的模块使用）**和 **PRIVATE（只供本库使用）**。参考 H7 工程公开模块头文件时使用 `PUBLIC`；单个可执行目标只能使用 `PRIVATE`。首次选择建议 `PUBLIC`（静态库）/`PRIVATE`（可执行目标），用户可改。
4. 同一目标和同一目录已有等效 include 路径时，报告“已存在”，不再写入。**移除头文件目录**只删除目标中的 `target_include_directories()` 引用，不删除 `.h` 文件；若为手写复杂表达式，按与源文件相同的安全规则处理。

### 3.6 新建 CMake 分组

1. 点击 **新建 CMake 分组**，先选所属父目录（如 `model` 或 `device/driver`），再输入相对模块名（如 `pid`）；禁止空名、`..`、绝对路径、路径分隔符和非法 Windows 文件名。首版一次只建一层；嵌套模块可再从新模块内继续创建。
2. 确认目标：`model` 对应 `h7_model`；`device/driver` 从上层继承 `h7_device`。如果有多个目标，弹出选择。
3. 在父目录 `CMakeLists.txt` 的管理区域加入 `add_subdirectory(pid)`，创建 `model/pid/CMakeLists.txt`。新文件写明归属目标，并保留供后续添加源文件和头文件目录的管理区域；**新建分组本身不自动把该目录现有的任何 `.c` 加入编译，也不自动创建空 `.c/.h`**。
4. 新目录已经存在但尚无 `CMakeLists.txt` 时可以补建；已有 CMake 文件时不覆盖，改为打开已有文件并提示使用“添加源文件/头文件目录”。

## 4. CMake 写入格式

不要重排用户已有的 CMake 内容。首版分别在相关文件末尾维护源文件、头文件路径和子目录的插件区域，正常 CMake 指令仍可由用户阅读和手动调整：

```cmake
# rm_debug BEGIN managed sources
target_sources(h7_model PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}/pid.c"
)
# rm_debug END managed sources

# rm_debug BEGIN managed include directories
target_include_directories(h7_model PUBLIC
    "${CMAKE_CURRENT_LIST_DIR}"
)
# rm_debug END managed include directories
```

父文件示例：

```cmake
# rm_debug BEGIN managed subdirectories
add_subdirectory(pid)
# rm_debug END managed subdirectories
```

规则：

- 一个 CMake 文件只有一对对应标记。已有标记时在标记内更新并排序，不再追加第二组；不存在时在文件末尾插入，保留原文件换行风格（CRLF/LF）。
- `target_sources()` 内的文件路径用 `${CMAKE_CURRENT_LIST_DIR}/...`，include 路径亦然；统一正斜杠和双引号。父 `add_subdirectory()` 参数用相对于父 CMake 目录的路径。
- 对 `model/motor/motor.c` 等**原本已经写在用户手工 `target_sources` 中**的文件，不再写管理区域。其他 CMake 文件中已编译的源文件也不应重复加入。用户选择移出这类文件时，只有能精确定位单个字面量参数才编辑原语句。
- 管理区域只维护插件自己添加的行；用户手写区保持原样。如果用户删掉标记中的某一项，下次操作以当前文件内容为准。**不要写 `file(GLOB)`，不要写扫描目录自动收集源文件的 CMake 指令。**
- Windows 路径比较不区分大小写；展示与写入保留磁盘上的实际大小写。拒绝包含换行、`;`、引号、`$` 等会破坏 CMake 字面量的路径，给出明确错误。

## 5. 定位目标、判重与编辑算法

建议新建 `src/frontend/cmake-project-editor.ts`，由 `RmWorkflow` 调用。以下顺序不能省略：

1. **确定工程根目录**：调用现有 `projectDirectory()`，要求根目录有 `CMakeLists.txt`。
2. **校验路径**：对已存在的选择项取 `realpath`，验证仍在当前工作区内；对新建模块路径先 `path.resolve`，验证 `path.relative(workspaceRoot, result)` 不以 `..` 开头。拒绝符号链接逃逸、非法名字和生成目录。
3. **建立分组树**：从工程根 `CMakeLists.txt` 出发，只沿可解析的 `add_subdirectory()` 构造 CMake 分组层级，记录每个分组的 `CMakeLists.txt` 路径、物理目录、所属目标和上层分组。扫描物理目录中的 `.c` 仅用于显示未加入候选；排除构建目录、隐藏目录和 CubeMX 生成目录的无关候选。对于尚无 CMake 文件的普通目录，可显示“创建分组”入口，但它们不会自动成为已加入编译的分组。
4. **使用用户选择的分组**：添加文件时以用户点击的分组 CMake 作为写入位置，而不是从文件目录自动寻找最近 CMake。未从树选择分组时要求选一个；允许用相对路径引用工程内其他文件夹的 `.c`。新建分组时由父分组决定父 CMake，且父 `add_subdirectory()` 必须能从根工程实际执行到。
5. **解析候选目标**：优先读取所选分组 CMake 文件内的 `target_sources(<target> ...)`；其次读取该文件的 `add_library(<target> ...)` / `add_executable(<target> ...)`；仍没有则向父分组逐级寻找。忽略 `INTERFACE`/`IMPORTED`/`ALIAS` 等不能承接普通 `.c` 的目标。解析时跳过 `#` 注释，不把注释中的示例当作有效命令。候选不唯一时由用户选。`${CMAKE_PROJECT_NAME}` 可原样作为目标表达式写入。
6. **检查目标定义顺序**：新叶子会在父文件执行 `add_subdirectory()` 时调用 `target_sources()`；父目标必须在该语句之前已经由 `add_library`/`add_executable` 建立。参考 H7 的父层与 `test_cortex` 都满足。无法确认时停止自动写入，并说明需要调整目标定义顺序。
7. **源文件状态与判重**：解析同一目标的 `target_sources`、`add_executable`/`add_library` 字面量源项及插件管理区，识别普通相对路径和 `${CMAKE_CURRENT_SOURCE_DIR}` / `${CMAKE_CURRENT_LIST_DIR}` 路径，再用当前配置的 `compile_commands.json` 辅助核对（如果该文件存在）。编译数据库可能过期，不能单凭其决定写入。已在该目标中则跳过；已在另一目标中则告知用户目标与潜在重复链接，由用户决定是否继续。遇到 `file(GLOB...)`、复杂变量或生成表达式无法确认时标记“由原有 CMake 管理”，不能显示成明确“未编译”，也不能自动写入可能重复的引用。
8. **头文件目录判重**：检查同一目标的 `target_include_directories` 与插件管理区，规范化路径后比较。无法展开的 CMake 变量只提示可能重复；重复 include 本身不会导致重复编译。
9. **生成完整编辑计划**：先在内存中计算所有文件的修改和创建，不边选边写。可用 `WorkspaceEdit` 同时创建新 CMake 文件与修改父文件，避免只创建目录却忘记 `add_subdirectory`。CMake 文件正在编辑时基于 VS Code 文档内容计算，不用磁盘旧内容覆盖未保存的修改。添加多文件时只把确认清单中的文件放入计划；移出编译时只移除被选文件的源项。
10. **应用与反馈**：`vscode.workspace.applyEdit()` 成功后保存被编辑的 CMake 文档，刷新分组树，打开改动位置，并在 `rm_debug` 输出面板记录工程、目标、源文件/include 目录及结果。失败时报告具体文件，不声称成功；任何用户取消操作都不写入。

多选 `.c` 默认全部归入当前选中的一个分组；若用户分别对多个分组操作，则逐组得到编辑计划。同一 CMake 文件只写一次，防止后一次覆盖前一次。对不能安全解析的工程停止自动编辑并打开 CMake 文件，让用户手工处理，**不能猜目标后写一个可能破坏构建的配置**。

### 5.1 建议的数据结构与命令流程

实现者可按以下接口拆分，名称可以调整，但各状态必须能区分：

```ts
type SourceState = 'included' | 'excluded' | 'external-managed' | 'stale';

interface CMakeGroup {
  cmakeFile: vscode.Uri;
  directory: vscode.Uri;
  parent?: vscode.Uri;
  targetExpression: string; // 如 h7_model 或 ${CMAKE_PROJECT_NAME}
}

interface SourceEntry {
  file: vscode.Uri;
  group: CMakeGroup;
  state: SourceState;
  declaration?: { file: vscode.Uri; start: number; end: number; managed: boolean };
}
```

操作按 `读取当前 VS Code 文档 → 解析分组与目标 → 校验所选文件 → 判重或定位源项 → 生成预览 → 用户确认 → 构造单次 WorkspaceEdit → 保存文档 → 刷新树` 执行。解析 CMake 时至少要处理括号配对、双引号、转义和注释，不能用一个跨行正则直接修改 `target_sources(...)`；无法精确分离参数时将节点标成 `external-managed`，停止自动编辑。CMake 文本是待修改配置的依据，文件系统扫描只产生候选，编译数据库只用于核对上次配置。监听 `CMakeLists.txt` 和 `.c` 的创建、删除与保存后刷新对应节点，避免每次展开树都全工程递归扫描。

## 6. 需要改动的插件文件

| 文件 | 要做的修改 |
|---|---|
| `src/frontend/rm-workflow.ts` | 接入 CMake 管理器，并复用现有工程目录、Build preset 与编译数据库路径。 |
| `src/frontend/cmake-project.ts`（已新增） | 实现 CMake 解析、分组树、路径校验、源文件/include 管理、管理区域生成、文件监听及 `WorkspaceEdit`。 |
| `package.json` | 注册 CMake 命令、“CMake 工程”视图和树节点上下文菜单；版本更新时同步 `package-lock.json` 根版本。 |
| `RM_DEBUG_使用说明.md` | 说明按钮、`.h` 与 `.c` 的区别、模块目录、PUBLIC/PRIVATE、何时点击 Build、工程外路径限制。 |
| 主需求文档 | 将此功能放到 P7，链接本方案；只有完成对应验收后才更新为“已完成”。 |

实际命令 ID 为 `rm-debug.cmake.refresh`、`rm-debug.cmake.addSource`、`rm-debug.cmake.createSource`、`rm-debug.cmake.removeSource`、`rm-debug.cmake.addInclude`、`rm-debug.cmake.removeInclude`、`rm-debug.cmake.createGroup`、`rm-debug.cmake.openGroupCMake`、`rm-debug.cmake.openDeclaration`。树节点上下文菜单按 `viewItem` 区分分组、已加入源文件、未加入候选源文件、include 目录；命令面板同名可检索。新功能不应改变现有 Configure、Build、Flash、Debug 和两种波形数据源。

## 7. 用参考工程走通的验收情景

实现者应在**工作区内的样例副本**上检查以下场景，不直接拿 `E:\code_for_rm\cmake_h7_duo` 原件做写入实验：

| 情景 | 预期文件变化 |
|---|---|
| 选择已存在的 `model/motor/motor.c` | 检出它已在 `model/motor/CMakeLists.txt`，零修改。 |
| 选择新放入 `model/motor/new_motor.c` | 只在该子目录的 CMake 管理区域加入 `target_sources(h7_model PRIVATE ...)`；不改根目录链接。 |
| `model/motor` 目录有 `new_motor.c` 和 `spare_motor.c`，只选择前者 | 分组树两个文件都可见，但只把 `new_motor.c` 加入编译；`spare_motor.c` 在 CMake 与编译数据库中均不存在。 |
| 新建 `model/motor/extra.c` 并加入编译 | 创建一个空源文件，并只添加这一项 `target_sources`；同目录其他文件状态不变。 |
| 从编译中移出 `new_motor.c` | 只删这一项 CMake 引用；磁盘源文件仍在，树上变为“未参与编译”。 |
| 新建 `model/pid` 模块 | 新建 `model/pid/CMakeLists.txt`；在 `model/CMakeLists.txt` 加一次 `add_subdirectory(pid)`；归属 `h7_model`。 |
| 新建 `model/pid` 时里面已有三个 `.c` | 三个文件都保持“未参与编译”，直到用户逐个或多选加入。 |
| 在 `model/pid` 添加 `pid.c` 和 `pid.h` | `pid.c` 加到 `h7_model` 的 `target_sources`；`pid.h` 所在目录加到 `h7_model` 的 include 路径，按用户选择 PUBLIC/PRIVATE。 |
| 对同一文件、目录、模块再次点击 | 提示已存在；无重复行。 |
| 在 `test_cortex` 的自建 `User` 目录加 `foo.c` | 归属 `${CMAKE_PROJECT_NAME}`；如选择独立模块，则创建 `User/CMakeLists.txt` 并从根目录引入。 |
| 选择 CubeMX 已包含的 `Core/Src/main.c` | 通过 CMake 扫描或编译数据库判重，不重复编译。 |
| 选择工程外文件，或取消目标选择 | 不写任何文件，提示原因。 |

验收时再检查修改后的 `CMakeLists.txt` 易读、CMake configure 能成功、Build 能找到新增 `.c`，clangd/编译数据库在下一次 Configure/Build 后获得新增 include 路径。应在工程副本中验收，不直接对参考工程原件写入。

## 8. 实施顺序

1. 先实现纯逻辑：从 CMake 构造分组树、识别明确参与编译的源文件、路径安全、目标识别、管理区域生成和判重；用 `test_cortex` 与 H7 样例结构作为输入审查生成文本。
2. 接入“CMake 工程”视图和六个操作；先完成**用户选择指定 `.c` 后加入/移出编译**和头文件目录管理，再完成“新建分组 CMake + 父目录引入”。
3. 完成多选文件的一次性编辑、取消不写入、重复点击不重复添加；特别核对同一文件夹内未选择的 `.c` 始终不会由插件加入编译。
4. 更新使用说明和版本，生成 VSIX，按既定习惯安装到 `stm32` Profile。
5. 由用户在真实工程副本确认按钮体验与 CMake 编译结果，再考虑更复杂的“新建顶层静态库”“自动链接依赖”和 `.cpp` 支持。
