# rm_debug 队伍使用教程：从安装到 STM32 调试

`rm_debug` 是队内使用的 VS Code 插件，基于 Cortex-Debug，集成 CMake 编译、探针烧录、源码调试、Live Watch、波形图和 Trace 函数热点分析。扩展名称为 **rm_debug**，标识为 **`rm-local.rm-debug`**；`launch.json` 的调试类型仍是 **`cortex-debug`**。

本文面向第一次搭环境的队员，也适用于已有 STM32 工程的队员。**不要求创建新 Profile**：直接使用现有配置或单独创建 `stm32` Profile 都可以。本文按当前源码版本 **0.1.54** 说明；安装时以队内实际分发的 VSIX、操作系统和架构为准。

> **先记住两条限制：**
> 1. **通过 OpenOCD 烧录必须使用 0.12.0 及以上版本**，并配套使用同一套安装中的 scripts。不要只升级 exe、继续引用旧 scripts，也不要以为系统默认安装的版本一定满足要求。J-Link 的独立烧录流程使用 SEGGER 工具。
> 2. **包含大量矩阵、大数组的结构体可能让 Live Watch 卡死。** 不要直接对整套算法状态、滤波器或控制器结构体启用“全部字段”，优先监控几个标量和需要的矩阵元素。批量读取与数组分页并不能保证超大对象不卡死，恢复方法见第 7 节。

## 目录

- [1. 下载与安装准备](#1-下载与安装准备)
- [Windows 下载与安装](#11-windows下载与安装)
- [Ubuntu 下载与安装](#12-ubuntu下载与安装)
- [2. 安装插件：现有配置与独立 Profile](#2-安装插件现有配置与独立-profile)
- [3. 工具路径与首次工程配置](#3-工具路径与首次工程配置)
- [4. CMakeLists 与 CMake 工程树](#4-cmakelists-与-cmake-工程树)
- [5. 编译与烧录](#5-编译与烧录)
- [6. 基础 Debug 操作](#6-基础-debug-操作)
- [7. Live Watch：运行中看变量](#7-live-watch运行中看变量)
- [8. 波形图：Live Plot 与串口上传](#8-波形图live-plot-与串口上传)
- [9. Trace：找函数热点](#9-trace找函数热点)
- [10. 桌面 C/C++ 混编补充](#10-桌面-cc-混编补充)
- [11. 故障判断：什么时候才考虑插件问题](#11-故障判断什么时候才考虑插件问题)
- [12. 队内反馈与维护](#12-队内反馈与维护)

## 1. 下载与安装准备

先按自己的操作系统完成下面一条流程，再进入第 2 节安装插件。**插件安装包（VSIX）和固件工程是两样东西**：普通队员拿队内分发的 VSIX 即可，不需要安装 Node.js，也不需要自己编译插件。下载或克隆这个源码仓库，不等于已经取得可安装的 VSIX；仓库默认不收录生成的安装包。

队伍已有统一工具包时优先使用队伍版本，避免不同编译器/标准库造成差异。已经装好的工具不必重复安装，但要核对路径与版本。

**当前 Linux x64 安装包（含 Live Watch 临时调参、矩阵刷新、角度反馈首次采样修复及按需展开）：**`rm-debug-0.1.54-linux-x64.vsix`。同一个包可复制给其他 Linux x64 电脑使用，安装目录可以任意选择。Windows 和 Linux ARM64 分别需要对应平台的安装包；本次构建的目标平台为 `linux-x64`。

**VS Code 至少使用 1.92。** 包中的串口模块要求扩展宿主 Node.js 20 及以上；[VS Code 1.92 自带 Node.js 20.14](https://code.visualstudio.com/updates/v1_92#_electron-30-update)。普通安装用户不需要另外安装 Node.js。GCC、GDB、OpenOCD 等工具仍按本机环境准备，首次使用时运行配置向导。

维护者提供 VSIX 下载直链后，Ubuntu 用户可在任意保存目录下载并安装：

```bash
read -r -p '粘贴队内 VSIX 下载直链：' RM_DEBUG_VSIX_URL
curl --fail --location --output ./rm-debug-0.1.54-linux-x64.vsix "$RM_DEBUG_VSIX_URL"
code --install-extension ./rm-debug-0.1.54-linux-x64.vsix --force
```

本次构建尚未发布固定的公网下载地址，请使用维护者实际提供的直链。若通过队内聊天或文件共享收到 VSIX，直接在文件所在目录执行最后一条安装命令即可。自定义 Profile 需给安装命令加上 `--profile "自己的名称"`；安装后执行 **Developer: Reload Window**。这些命令使用收到的文件名，不依赖维护者的用户名、源码目录或磁盘路径。

### 1.1 Windows：下载与安装

**插件包：**取得队内分发的 **Windows VSIX**，例如 `rm-debug-0.1.54.vsix`（仅示例，文件名以实际分发为准）。不要下载或安装带 `linux-x64` / `linux-arm64` 的包。

**开发工具按以下顺序准备：**

1. 从 [VS Code 下载页](https://code.visualstudio.com/download) 安装对应 Windows 架构的版本。
2. 从 [Git for Windows](https://git-scm.com/install/windows) 安装 Git，确认安装目录中存在 `bin/bash.exe`；插件在 Windows 上使用 **Git Bash** 执行构建和烧录命令。
3. 从 [Arm GNU Toolchain](https://developer.arm.com/Tools%20and%20Software/GNU%20Toolchain) 选择适用于 **Windows 主机、目标为 `arm-none-eabi`** 的裸机工具链。安装或解压到固定目录，检查 `bin` 下的 `arm-none-eabi-gcc.exe`、`arm-none-eabi-g++.exe` 与 `arm-none-eabi-gdb.exe`，不要误选 Linux 主机包或 Linux 目标工具链。
4. 从 [CMake 下载页](https://cmake.org/download/) 安装满足工程最低版本的 Windows 版；本仓库 `test_cortex` 要求至少 **3.22**。安装时可加入 PATH，或稍后在向导指定 `cmake.exe`。
5. 从 [Ninja 发布页](https://github.com/ninja-build/ninja/releases) 下载 Windows 包，解压得到 `ninja.exe`，放到固定工具目录。
6. 使用 **DAPLink / ST-Link** 时，安装或解压 **OpenOCD 0.12.0 及以上**的完整 Windows 包，例如 [xPack OpenOCD 发布包](https://github.com/xpack-dev-tools/openocd-xpack/releases)。保留完整目录结构，核对 `bin/openocd.exe` 与配套 scripts；不要只复制一个 exe。用该 exe 的完整路径加 `--version` 确认版本。
7. 使用 **J-Link** 时，安装 [SEGGER J-Link 软件包](https://www.segger.com/downloads/jlink)，保留 `JLink.exe`、`JLinkGDBServerCL.exe` 及设备驱动。USB 探针无法识别时，按厂商说明检查驱动。
8. 安装结束后重启 VS Code，让它获得新环境。按第 2 节选择现有 Profile 或独立 Profile 安装 **Windows VSIX**，再按第 3.3 节填写本机工具路径。

Windows 工具路径通常指向 `.exe` 文件，OpenOCD scripts 则指向目录。下面 Ubuntu 的 `apt` 命令和 `/usr/bin/...` 路径不用于 Windows 本地安装。

### 1.2 Ubuntu：下载与安装

**插件包：**Ubuntu x64 使用队内分发的 Linux x64 VSIX，例如 `rm-debug-0.1.54-linux-x64.vsix`。不要安装 Windows 包。ARM64 机器需取得对应 `linux-arm64` 包；目前软件验证基于 Ubuntu 22.04 x64，Ubuntu 24.04 和 Linux ARM64 尚未实测，具体范围见 [Ubuntu 安装与验证说明](cortex-debug-master/UBUNTU.md)。

**开发工具按以下顺序准备：**

1. 从 [VS Code 下载页](https://code.visualstudio.com/download) 选择适合 Ubuntu 和机器架构的 Linux 安装包；常见 x64 Ubuntu 使用 `.deb`。
2. 打开 Ubuntu 终端安装构建与调试依赖。Ubuntu 使用系统 **Bash**，不需要安装 Git Bash：

   ```bash
   sudo apt update
   sudo apt install git cmake ninja-build gcc-arm-none-eabi binutils-arm-none-eabi \
       libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib gdb-multiarch openocd
   ```

3. 核对实际工具版本；CMake 至少满足工程要求，**烧录用的 OpenOCD 必须为 0.12.0 及以上**：

   ```bash
   cmake --version
   ninja --version
   arm-none-eabi-gcc --version
   gdb-multiarch --version
   openocd --version
   ```

   系统包不保证满足 OpenOCD 版本要求。若低于 0.12.0，换用符合要求的 Linux 安装，例如 [xPack OpenOCD 发布包](https://github.com/xpack-dev-tools/openocd-xpack/releases)，再同步设置新可执行文件与**同一套 scripts**。如果本机有多个安装，还要用插件实际选中的完整路径检查版本。
4. 工程指定了 ARM GCC 版本，或使用系统工具链不支持的 C++20 库特性时，下载对应的 [Arm GNU Toolchain](https://developer.arm.com/Tools%20and%20Software/GNU%20Toolchain) **Linux 主机、`arm-none-eabi` 目标**包。GCC/binutils 与 GDB 可在不同目录；插件支持 Ubuntu 的 `gdb-multiarch`。
5. 使用 **J-Link** 时，另安装 [SEGGER J-Link Linux 软件包](https://www.segger.com/downloads/jlink)。Linux 工具名通常为 `JLinkExe` 与 `JLinkGDBServerCLExe` / `JLinkGDBServerCL` / `JLinkGDBServer`，不是 Windows 的 `.exe`。
6. 使用 USB 探针前检查 OpenOCD 或 SEGGER 提供的 **udev 规则**；串口波形用户还需串口权限。常见串口权限设置如下，完成后注销并重新登录：

   ```bash
   sudo usermod -aG dialout "$USER"
   ```

   USB 规则检查、探针重插和 `/dev/ttyACM*` / `/dev/ttyUSB*` 端口说明见 [Ubuntu 权限说明](cortex-debug-master/UBUNTU.md)。
7. 按第 2 节选择现有 Profile 或独立 Profile 安装 **Linux VSIX**，再按第 3.4 节填写 Ubuntu 工具路径。配置完成后再连接板子进行 Build、Flash 和 Debug。

### 1.3 两个平台都要核对的工具

| 工具 | 用途 | 安装后要确认什么 |
|---|---|---|
| VS Code | 编辑器与插件运行环境 | 可以打开工程文件夹、安装与操作系统匹配的 VSIX |
| ARM GNU 工具链 | 编译 STM32 固件、提供 ELF 分析工具 | 有 `arm-none-eabi-gcc`；混编还需 `arm-none-eabi-g++`；保留配套 `nm`、`objdump`、`addr2line` |
| ARM GDB | 与调试服务器通信、解析变量 | Windows 一般用 `arm-none-eabi-gdb.exe`；Ubuntu 也支持 `gdb-multiarch` |
| CMake | 生成与管理构建 | 版本满足工程 `cmake_minimum_required(...)` |
| Ninja | 执行 Ninja 构建 | 有 `ninja`，且与工程 generator 对应 |
| Bash | 执行插件的编译/烧录命令 | Windows 使用 Git Bash 的 `bash.exe`；Ubuntu 使用 `/bin/bash` |
| OpenOCD | DAPLink / ST-Link 的烧录和 GDB Server | **0.12.0 及以上**，包含配套的 `interface`、`target` scripts |
| SEGGER J-Link 软件（使用 J-Link 时） | J-Link 烧录和 GDB Server | 同时有 Commander 和 GDB Server；只选其中一个不能完成所有流程 |

工具可以安装到不同目录，不必强行放在某个队员的磁盘路径。插件会自动发现工具，发现失败再手动指定。每台电脑、每个 Profile 都要核对自己的有效路径。

### 1.4 探针与接线

关断目标板电源后按板卡与探针说明接线，再上电。SWD 调试至少需要正确连接 **SWDIO、SWCLK、GND**；探针需要参考电压时还要接 VTref，必要时接 NRST。确认板子有稳定供电，不要把参考电压脚当成所有探针都支持的供电脚。

| 探针 | 本插件向导使用的服务 | 配置项 |
|---|---|---|
| DAPLink / CMSIS-DAP | OpenOCD | `interface/cmsis-dap.cfg` + 对应芯片 target |
| ST-Link | OpenOCD | `interface/stlink.cfg` + 对应芯片 target |
| J-Link | SEGGER J-Link GDB Server | SEGGER 支持的具体 device 名称，例如 `STM32F103C8` |

target 必须按真实芯片选择，例如 F1 常见 `target/stm32f1x.cfg`，F4 常见 `target/stm32f4x.cfg`，H7 常见 `target/stm32h7x.cfg`；不要把示例里的 F103 配置照搬给其他板子。SWO Trace 还需额外的 SWO 接线与支持，串口图还需 UART 接线，后文分别说明。

## 2. 安装插件：现有配置与独立 Profile

Profile 是 VS Code 保存扩展和设置的配置集合。建新 Profile 方便把 STM32 环境与其他开发环境分开，但**两种安装方式的插件功能完全相同**。工作区与 Profile 可关联，之后重新打开工程时要看当前窗口实际使用的 Profile。[VS Code Profile 官方说明](https://code.visualstudio.com/docs/configure/profiles)。

### 2.1 方式 A：继续使用现有配置，不创建 Profile

1. 打开平时使用的 VS Code 窗口，确认当前 Profile（通常是 Default，也可能是已有的其他 Profile）。
2. 打开扩展视图 `Ctrl+Shift+X`。如果当前环境已启用官方 **Cortex-Debug**（`marus25.cortex-debug`），先在当前 Profile 禁用它；想保留其他项目的官方版时，不必全局卸载。
3. 扩展视图右上角 `…` → **Install from VSIX... / 从 VSIX 安装**，选择队内分发的安装包。
4. `Ctrl+Shift+P` 打开命令面板，运行 **Developer: Reload Window / 开发人员: 重新加载窗口**。
5. 扩展列表中确认 `rm_debug` 已安装且已启用，再打开固件工程文件夹。

不清楚命令行会操作哪个 Profile 时，直接使用以上图形界面流程。使用默认 Profile 的队员也可以在 VSIX 所在目录运行：

```powershell
# 下面的文件名只是示例，换成实际收到的 Windows 安装包。
code --install-extension ".\rm-debug-0.1.54.vsix" --force
code --list-extensions --show-versions
```

Ubuntu 默认 Profile 的队员在 Linux VSIX 所在目录运行：

```bash
code --install-extension ./rm-debug-0.1.54-linux-x64.vsix --force
code --list-extensions --show-versions
```

命令不带 `--profile` 时使用默认 Profile；**已有自定义 Profile 的队员应使用图形界面，或给命令明确加上自己的 `--profile "名称"`**。列表中应包含 `rm-local.rm-debug`。

### 2.2 方式 B：新建或使用独立 `stm32` Profile

1. 通过 VS Code 的 **Profiles / 配置文件** 页面创建名为 `stm32` 的 Profile。可以从空配置创建，也可以复制已有配置。
2. 切到 `stm32` 后安装 VSIX；若复制了旧配置，检查官方 Cortex-Debug 是否也被复制过来，并在这个 Profile 禁用它。
3. 安装必要的配套扩展、重载窗口，并在这个窗口打开固件工程。
4. 以后打开工程时使用同一个 Profile，工具路径也在这里配置。

命令行可以明确指定 Profile（不存在时 VS Code 会创建它）。在 VSIX 所在目录执行：

```powershell
code --profile "stm32" --install-extension ".\rm-debug-0.1.54.vsix" --force
code --profile "stm32" --list-extensions --show-versions
code --profile "stm32" "D:\Team\firmware"
```

Ubuntu x64 安装包示例：

```bash
code --profile "stm32" --install-extension ./rm-debug-0.1.54-linux-x64.vsix --force
code --profile "stm32" --list-extensions --show-versions
code --profile "stm32" /path/to/firmware
```

`stm32` 只是约定名称，可以换成自己的名称；所有命令都要使用一致的名称。不要把 Windows 与 Linux 的安装包混用。`--profile` 与 VSIX 安装参数见 [VS Code CLI 官方说明](https://code.visualstudio.com/docs/configure/command-line)。

已有 `cmake_debug` Profile 的队员可直接使用它。在收到的 VSIX 所在目录执行：

```bash
code --profile "cmake_debug" --install-extension ./rm-debug-0.1.54-linux-x64.vsix --force
code --profile "cmake_debug" --list-extensions --show-versions
code --profile "cmake_debug" /path/to/firmware
```

列表应显示 `rm-local.rm-debug@0.1.54`。在 `cmake_debug` 窗口执行 **Developer: Reload Window**，然后重新启动调试会话，使首次采样修复和默认收起行为生效。Windows 使用对应平台的 VSIX 替换文件名；其他 Profile 替换名称即可。

### 2.3 配套扩展与升级

插件依赖以下四个扩展，VS Code 通常会自动安装；离线安装或缺依赖时，在**使用插件的同一个 Profile** 补齐：

- `mcu-debug.debug-tracker-vscode`
- `mcu-debug.memory-view`
- `mcu-debug.rtos-views`
- `mcu-debug.peripheral-viewer`

代码补全可以使用 Microsoft C/C++（`ms-vscode.cpptools`）或 clangd，按队伍工程选择。桌面 C/C++ 调试还需要 Microsoft C/C++ 扩展。

**不要同时启用官方 Cortex-Debug 和 rm_debug**：两者注册相同的 `cortex-debug` 类型，可能出现命令冲突或启动到错误插件。看到“安装 cortex-debug 扩展”提示时，先检查 rm_debug 的启用状态、Profile 和依赖，不要直接把官方版装回来。

升级时在同一 Profile 安装新 VSIX，再重载窗口；同版本不同构建包可用 `--force` 覆盖。需要回退时安装队内保存的旧包并重载。若 `code` 命令找不到，先用图形界面安装，之后再处理 VS Code 的 PATH。

## 3. 工具路径与首次工程配置

### 3.1 先分清三类路径

| 路径/参数 | 存放位置 | 应该怎么填 |
|---|---|---|
| GCC、GDB、CMake、Ninja、OpenOCD、J-Link、Bash | 当前 Profile 的 VS Code **用户设置** | 本机真实路径，不照抄其他队员的磁盘位置 |
| CMake 工程目录、preset、ELF、探针、芯片配置 | 工作区 `.vscode/settings.json` | 尽量用工程内相对路径，便于队伍共享 |
| 调试器启动参数 | 工作区 `.vscode/launch.json` | 工具引用用户设置，ELF 与工程要对应 |

在命令面板运行 **Preferences: Open User Settings (JSON)** 可编辑用户设置；工作区设置另选 **Preferences: Open Workspace Settings (JSON)**。已有 JSON 要合并键值，不要整段覆盖其他设置。

### 3.2 运行配置向导

1. 用 **File → Open Folder / 文件 → 打开文件夹** 打开固件工程根目录，最好能直接看到 `CMakeLists.txt`。也可以打开其上一级，由向导选择工程。
2. 点击左侧 **rm_debug** 图标，在“编译 · 烧录 · 调试”里点击 **配置工程和工具路径**；或运行 **rm_debug: Configure Workspace**。
3. 选择 CMake 工程与 preset，初次源码调试优先选 `Debug`。
4. 填写相对于 **CMake 工程目录** 的 ELF 路径，例如 `build/Debug/firmware.elf`。这是示例，文件名取决于工程 target；不确定时先 Build，再看真实输出。
5. 选择 ST-Link / J-Link / DAPLink。OpenOCD 方式核对 target；J-Link 方式核对 device，即使向导从 `.ioc` 自动推测，也要确认。
6. 自动发现失败时，选择对应工具的**可执行文件**；OpenOCD scripts 则选择包含 `interface/` 和 `target/` 的**目录**。
7. 在“输出”面板选择 **rm_debug**，核对自动发现的工具。尤其检查实际选中的 OpenOCD 版本，防止发现了旧安装。
8. 配置完成后检查 `.vscode/settings.json`、`.vscode/launch.json`。向导会生成当前探针配置并保留其他非生成的调试配置，同时生成/更新 C/C++ 与 clangd 的代码检查配置。

**重新运行向导会重新生成它管理的调试配置**。手动加过 SWO、Trace、SVD、入口断点等参数时，重配后检查并重新合并；改配置前可用 Git 保存差异。

### 3.3 Windows 用户工具路径示例

下面只展示格式，**目录都要换成自己电脑上的安装位置**。GCC/GDB/CMake/Ninja/OpenOCD 选到 exe；scripts 选目录。JSON 使用 `/` 可避免反斜杠转义错误。

```json
{
    "rm-debug.gitBashPath": "C:/Program Files/Git/bin/bash.exe",
    "rm-debug.armGccPath": "D:/Tools/arm-gnu/bin/arm-none-eabi-gcc.exe",
    "rm-debug.armGdbPath": "D:/Tools/arm-gnu/bin/arm-none-eabi-gdb.exe",
    "rm-debug.cmakePath": "D:/Tools/cmake/bin/cmake.exe",
    "rm-debug.ninjaPath": "D:/Tools/ninja/ninja.exe",
    "rm-debug.openocdPath": "D:/Tools/openocd/bin/openocd.exe",
    "rm-debug.openocdScriptsPath": "D:/Tools/openocd/share/openocd/scripts",
    "rm-debug.jlinkGdbServerPath": "C:/Program Files/SEGGER/JLink/JLinkGDBServerCL.exe",
    "rm-debug.jlinkCommanderPath": "C:/Program Files/SEGGER/JLink/JLink.exe"
}
```

只用一种探针时，另一种探针的工具路径可省略。不同 OpenOCD 安装的 scripts 布局可能不同，关键是目录里有对应配置，且与 exe 属于同一套安装。

用 PowerShell **完整路径** 验证工具，下面同样需要换路径：

```powershell
& "D:/Tools/arm-gnu/bin/arm-none-eabi-gcc.exe" --version
& "D:/Tools/arm-gnu/bin/arm-none-eabi-gdb.exe" --version
& "D:/Tools/cmake/bin/cmake.exe" --version
& "D:/Tools/ninja/ninja.exe" --version
& "D:/Tools/openocd/bin/openocd.exe" --version
```

最后一条必须显示 **0.12.0 或更高**。只运行 PATH 中的 `openocd --version` 不能证明插件选中的那个 exe 是新版本；以用户设置和 rm_debug 输出里的路径为准。[OpenOCD 官方发布说明](https://openocd.org/)列出了 0.12.0 对 CMSIS-DAP SWO 等功能的支持改进。

### 3.4 Ubuntu 工具路径示例

```json
{
    "rm-debug.bashPath": "/bin/bash",
    "rm-debug.armGccPath": "/usr/bin/arm-none-eabi-gcc",
    "rm-debug.armGdbPath": "/usr/bin/gdb-multiarch",
    "rm-debug.cmakePath": "/usr/bin/cmake",
    "rm-debug.ninjaPath": "/usr/bin/ninja",
    "rm-debug.openocdPath": "/usr/bin/openocd",
    "rm-debug.openocdScriptsPath": "/usr/share/openocd/scripts"
}
```

这是格式示例，**只有 `/usr/bin/openocd` 确实达到 0.12.0 时才这样配置**。自装版本要同时更换 exe 和 scripts 路径。Linux J-Link 通常使用 `JLinkExe` 与 `JLinkGDBServerCLExe` / `JLinkGDBServerCL` / `JLinkGDBServer`，以本机文件为准。USB 权限与 `dialout` 组配置见 Ubuntu 专项文档。

### 3.5 工作区设置示例

假设 VS Code 直接打开固件根目录、构建输出为 `build/Debug/firmware.elf`，DAPLink + F4 的示例为：

```json
{
    "rm-debug.target": "embedded",
    "rm-debug.projectDirectory": "",
    "rm-debug.buildPreset": "Debug",
    "rm-debug.firmwarePath": "build/Debug/firmware.elf",
    "rm-debug.probeType": "daplink",
    "rm-debug.interfaceConfig": "interface/cmsis-dap.cfg",
    "rm-debug.targetConfig": "target/stm32f4x.cfg"
}
```

如果打开的是上级目录，`projectDirectory` 可为 `firmware`，但 `firmwarePath` 仍相对于该 CMake 工程目录。改变探针或芯片后重跑向导，使 settings 与 launch 一致。不要仅改一处而让烧录和 Debug 指向不同固件或 target。

## 4. CMakeLists 与 CMake 工程树

### 4.1 工程要先具备可编译的 CMake 配置

插件负责调用已有构建规则。STM32 工程必须有正确的 ARM toolchain、启动文件、链接脚本、芯片宏和库依赖；仅把 `.c` 文件丢进文件夹不会自动成为固件。

有 `CMakePresets.json` 时，默认 Build 使用：

```bash
cmake --preset Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build --preset Debug
```

这里 `Debug` 是向导选择的名称。当前默认工作流要求 configure preset 与 build preset 都能用这个名称；build preset 应指向正确的 configure preset。没有 presets 时默认使用 `cmake -S . -B build -G Ninja ...` 和 `cmake --build build`，**仍需自己保证 ARM toolchain 生效，并把 ELF 路径改成实际产物位置**。复杂构建可配置 `rm-debug.configureCommand`、`rm-debug.buildCommand`。

### 4.2 工程树怎么用

左侧 **rm_debug → CMake 工程** 展示 CMake 分组、源文件和头文件搜索目录。这个树看的是**参与构建的关系**；VS Code 文件资源管理器看的是磁盘文件，两者用途不同。

| 要做的事 | 操作 | 结果与注意点 |
|---|---|---|
| 查看/更新树 | 点击“刷新 CMake 工程树” | 手动改 CMakeLists 后先保存，再刷新 |
| 加入已有源码 | 右键工程/分组 → “添加已有 C/C++ 文件到编译分组” | 选择正确 target；源文件存在不代表已加入编译 |
| 创建源码 | 右键 → “新建 C/C++ 文件并加入编译” | 支持 `.c`、`.cpp`、`.cc`、`.cxx` |
| 移出源码 | 右键文件 → “从编译中移出 C/C++ 文件” | 修改支持的源文件声明；**磁盘上的源文件保留** |
| 新建模块 | “新建 CMake 编译分组” | 创建实际目录和子 `CMakeLists.txt`，并在父配置加入 `add_subdirectory(...)` |
| 添加头文件目录 | “添加头文件搜索目录” | 修改 include 搜索路径；只放入 `.h` 不会自动配置 include 路径 |
| 移除头文件目录 | “移除头文件搜索目录” | 插件管理区内的目录可自动移除，其他声明需人工核对 |
| 检查构建声明 | “打开分组 CMakeLists.txt” / “定位 CMake 源文件声明” | 确认文件加在哪个 target、由哪份 CMakeLists 管理 |

插件修改的常见管理区形如：

```cmake
# rm_debug BEGIN managed sources
target_sources(firmware PRIVATE
    control.c
    estimator.cpp
)
# rm_debug END managed sources
```

target 名称应换成工程实际名字。修改后查看 Git diff、保存 CMake 文件、再 Build；**刷新树不会重新编译固件**。复杂宏、生成表达式、动态清单、`GLOB` 或不支持的声明可能无法自动解析或移除，按提示打开 CMakeLists 人工修改。不要把“未识别”直接理解为文件已从构建删除。

### 4.3 C 为主的 C/C++ 混编

同一个 target 可以一起编译 `.c` 与 `.cpp`，`.c` 保持 C 语言规则，无需全部改名。加入 C++ 时，插件会补齐可识别工程的 CXX 配置与 **C++20**，要求标准不能静默降级。ARM 工具链必须包含 `arm-none-eabi-g++`，所用标准库也必须支持代码里的特性。

共享头文件里的 C 接口可写成：

```c
#ifdef __cplusplus
extern "C" {
#endif

void control_init(void);
void control_step(void);

#ifdef __cplusplus
}
#endif
```

C++ 类与实现留在 `.cpp` 中，由 C 接口供 C 主程序调用。使用全局 C++ 对象还要确认启动代码执行了构造初始化；本仓库 `test_cortex` 的特殊启动示例不能直接当作所有 C++ 工程的模板。可参考 [C 主程序调用 C++ 模块示例](test_cpp/README.md)。

### 4.4 换电脑、改工程目录、使用 Git worktree

**CMake 工程树不是 Git worktree。** Git worktree 是另一份源码检出目录，每份目录应有自己的 build 缓存与 ELF，避免一边改代码、另一边拿旧固件调试。

复制工程、从 Windows 迁到 Ubuntu，或换 worktree 后，重跑配置向导并 Build。默认构建会检测路径迁移的旧缓存，将 `CMakeCache.txt` 与 `CMakeFiles` 备份到构建目录内的 `.rm-debug-cmake-cache-*` 后重新配置。自定义 configure 命令的缓存需要自行处理；若换了工具链或 generator，必要时使用新的构建目录。不要直接复用队友整个 `build` 文件夹。

## 5. 编译与烧录

### 5.1 Build：先确保编译成功

1. 停止当前嵌入式调试会话，保存源文件与 CMakeLists。
2. 在 rm_debug 侧栏点击 **编译 Build**，或运行 **rm_debug: Build**。
3. 打开 **View → Output / 查看 → 输出**，选择 **rm_debug**，查看 configure 和 build 的完整输出。
4. 编译错误与警告会进入 **问题**面板（`Ctrl+Shift+M`），点击文件/行号跳转源码。问题面板若启用了“仅当前文件”过滤，切换范围才能看到全工程诊断。
5. 确认显示编译成功，找到实际生成的 `.elf`，核对设置里的 ELF 路径与更新时间，然后再烧录。

排查编译时看**第一条实际报错**，不要只看最后的 `ninja: build stopped`。成功但有警告时也应查看问题面板。默认 Build 会先 configure 再 build，后者通常是增量构建。

### 5.2 Flash：把当前 ELF 写入目标板

> **DAPLink / ST-Link 烧录前必须确认插件实际调用的 OpenOCD 为 0.12.0 及以上，exe 与 scripts 配套。** 安装了新版但插件仍指向旧版，不满足要求。

1. 确认板子上电、SWD 接线正确，其他下载器和调试会话已退出。
2. 先 Build 成功；Flash 不会自动替你重新编译。
3. 点击 **烧录 Flash**，或运行 **rm_debug: Flash**。
4. 查看 rm_debug 输出中的工具、ELF、interface/target 与结果。
5. OpenOCD 流程执行写入、校验、复位和退出；J-Link 流程调用 Commander，通过 SWD 加载 ELF、复位并运行。确认成功后再观察板子的实际行为。

上次 Build 失败、没有 ELF 或调试尚未结束时，插件会阻止烧录。Flash 成功说明下载流程完成，**不代表程序逻辑、外设初始化或任务调度正确**。板子没反应时继续调试程序入口与初始化过程。

特殊工程可用 `rm-debug.flashCommand` 覆盖烧录命令，支持 `${firmware}` 和 `${workspaceFolder}` 占位符。这会绕过默认烧录流程，要自己保证命令确实写入正确固件并返回可靠的退出码。自定义命令按 Bash 语法执行，Windows 也不是 PowerShell 语法。

## 6. 基础 Debug 操作

### 6.1 第一次启动

1. 先 Build 成功，并确认调试 ELF 就是当前构建产物。
2. 打开 **Run and Debug / 运行和调试**（`Ctrl+Shift+D`），选择向导生成的 **rm_debug: DAPLink / ST-Link / J-Link**。
3. 点击 rm_debug 的 **调试 Debug** 或按 `F5`。默认 `request: "launch"` 流程通常会加载固件；是否加载也受手动配置影响。**嵌入式 Debug 按钮本身不会先 Build**，修改代码后必须主动编译。
4. 想从入口停住，可在生成的配置中加入 `"runToEntryPoint": "main"`；也可在已编入 ELF 的源码可执行行设置断点。
5. 启动失败时查看 **Debug Console / 调试控制台**、GDB Server 终端及 rm_debug 输出；调试期间不要再打开第二个烧录工具占用探针。

基础 `launch.json` 的关键字段示例（这是单个 configuration，放在 `configurations` 数组里；路径与 target 要改成实际值）：

```json
{
    "name": "rm_debug: DAPLink",
    "type": "cortex-debug",
    "request": "launch",
    "servertype": "openocd",
    "cwd": "${workspaceFolder}",
    "executable": "${workspaceFolder}/build/Debug/firmware.elf",
    "serverpath": "${config:rm-debug.openocdPath}",
    "gdbPath": "${config:rm-debug.armGdbPath}",
    "configFiles": ["interface/cmsis-dap.cfg", "target/stm32f4x.cfg"],
    "searchDir": ["${config:rm-debug.openocdScriptsPath}"],
    "runToEntryPoint": "main",
    "liveWatch": { "enabled": true, "samplesPerSecond": 4 }
}
```

优先使用向导生成的配置，再合并需要的选项；向导可能为特定目标生成兼容参数，不要整份替换为这个示例。

### 6.2 断点、单步与普通变量

| 操作/视图 | 怎么用 |
|---|---|
| 继续 `F5` | 让 MCU 继续运行到下一个断点 |
| 暂停 | 查看程序此刻停在哪个函数、哪个任务 |
| 单步跳过 `F10` | 执行当前行，通常不进入调用的函数 |
| 单步进入 `F11` | 进入有调试信息的被调用函数 |
| 单步跳出 `Shift+F11` | 执行到当前函数返回 |
| 停止 `Shift+F5` | 结束当前调试会话，释放探针 |
| Variables / 变量 | 暂停时查看局部变量、全局/static 作用域和寄存器 |
| Watch / 监视 | 暂停时求值表达式，与运行中的 Live Watch 区分 |
| Call Stack / 调用堆栈 | 查看调用链，选择正确栈帧后查看该帧局部变量 |
| Debug Console | 查看启动/GDB 信息，必要时手动求值或读取地址 |

断点变灰或位置跳动时，先检查文件是否参与构建、ELF 是否对应源码、是否开启调试信息、是否被优化。`Debug` preset 的名字不保证编译参数正确，最终看编译命令里的 `-g` 与优化选项。Release 下局部变量可能被优化掉，单步也可能跨行。

暂停会改变实时系统的运行条件，电机控制、通信超时和看门狗等可能因此表现不同；先在合适的测试状态下调试。RTOS 任务与调用栈识别依赖对应 GDB Server/RTOS 配置；调度器启动前的单步表现也要结合服务器限制判断。

### 6.3 内存、外设与输出

配套视图可查看内存、寄存器、SVD 外设和 RTOS 状态，但要具备正确目标配置与 SVD/RTOS 支持。SWO 可输出 ITM 文本/数据，RTT 需要固件提供 RTT 通道，半主机输出也需要服务器与固件配合。**安装了视图不等于固件已经产生相应数据**。高级调试字段见 [调试配置属性](cortex-debug-master/debug_attributes.md)；Trace 使用 SWO PC 采样，按第 9 节单独开启。

## 7. Live Watch：运行中看变量

Live Watch 在 **Cortex Live Watch** 视图中周期性读取目标内存，用于观察慢变化的全局/static 变量和结构体。它不会为每次采样主动暂停 MCU，但实际运行中能否读取、速度如何，取决于 GDB Server、探针和芯片。

### 7.1 从少量变量开始

1. 启动嵌入式 Debug，确保当前配置含 `"liveWatch": { "enabled": true, "samplesPerSecond": 4 }`。
2. 让 MCU 继续运行。打开调试侧栏的 **Cortex Live Watch**，找不到时运行 **rm_debug: 显示 Live Watch**。
3. 点击添加表达式按钮（**Add expression to Live Watch window**），输入 ELF 中真实存在的表达式，例如 `control_speed`、`rc_ctrl.rc.ch[0]`、`controller.output`。这些是形式示例，换成自己的变量。
4. 每次开始调试默认收起所有监控项，并关闭上次会话的“全部字段”。手动逐层展开需要的结构体、数组、指针、`*` 或矩阵；先确认少量值能刷新，再增加监控范围。
5. 用 **Set Live Watch Frequency** 选择目标频率 **1–20 Hz**，默认生成配置为 4 Hz。看界面上的**实际频率**判断性能；设为 20 Hz 不代表链路能达到 20 Hz。

普通 Watch 主要用于暂停时检查；Live Watch 用于运行中趋势。看不到变量时先在暂停状态用 Debug Console 验证，见第 11 节。

**0.1.54 更新：**修复兼容采样模式下反馈字段一直显示“等待首次采样”的问题。即使数值尚未变化，也会显示首次读到的值；字段树刷新时保留有效采样结果。折叠分支后停止该分支的不必要读取，已加入波形的字段或显式开启的“全部字段”仍继续采样。矩阵识别和切换显示方式不会自动展开。

例如工程中存在 `arm_application.joint_motor` 时，可按 `arm_application → joint_motor → 0 → * → fb` 展开，再查看角度字段。实际字段名以固件为准；读到 `0` 也是有效采样值。升级后若仍没有数据，先确认程序已运行、指针非空，再在暂停状态对照 GDB 值。

### 7.2 结构体、数组、指针与特殊变量

| 需求 | 操作与边界 |
|---|---|
| 监控接收结构体 | **Monitor Receive Struct**，输入结构体变量；适合遥控器接收等较小状态对象 |
| 递归看成员 | 顶层右键 **Toggle All Fields**；暂停时 Variables 右键 **Monitor All Fields in Live Watch** 也可加入 |
| 查看数组 | 展开后默认每页加载 64 个元素；点“加载更多数组元素…”继续，加载越多采样负担越大 |
| 查看数据指针目标 | 默认手动展开指针与 `*` 节点；显式开启“全部字段”可跟随第一层数据指针，后续指针需手动展开或选为波形字段；空指针没有可读对象 |
| 文件内 static | 打开对应 `.c` 文件，运行 **Monitor File Static Variable**，从候选符号中选择 |
| 固定地址局部变量 | 在断点暂停时，Variables 右键 **Monitor Local Variable at Fixed Address** |
| 函数指针 | 匹配当前 ELF 符号后显示函数名，点击可跳到源码；不等于记录了所有调用历史 |
| 串口通道 | **Monitor Serial Variable in Live Watch**，选择已被固件上报的通道；值来自串口，不额外发起 GDB 读取 |

固定地址局部变量**只对当前会话且该对象仍然存活时有意义**：函数返回、栈复用后，同一地址可能已经变成别的数据。普通函数局部变量没有长期稳定地址，不能直接当全局变量监控。函数指针跳转还需要保留符号和行号信息。

右键行可复制值、加入波形；顶层还可编辑、移除或上下排序。**Set Number Format (Decimal / Hexadecimal)** 可切整数显示进制；指针仍显示十六进制，浮点保持数值格式，变化值会高亮。

**本次调试临时修改值**：在 Live Watch 中双击整数、浮点、布尔或枚举值，或选中行后按 **F2**；右键的“修改值（本次调试）”也可进入编辑。按 **Enter** 写入，按 **Esc** 或离开输入框取消。编辑期间其他字段继续采样，刷新不会覆盖尚未提交的输入。

修改通过当前 Live GDB 连接单次写入字段的目标 RAM，运行中的程序会使用新值；插件回读并继续显示真实采样结果。数值不会写回源码、ELF、Flash 或监控配置，也不会在下一次调试重放。复位并执行正常初始化后恢复固件初值；单纯断开连接不主动恢复板上仍在运行的 RAM。若固件自己保存参数到非易失存储，这属于固件行为。

可编辑范围为 ELF 可写数据段中的有效标量字段，包括结构体、嵌套结构体和数组中的标量成员。`const`、只读区、外设寄存器、结构体/数组整体、指针地址、固定地址局部变量和串口通道不提供值编辑；仅为采样配置的额外 RAM 区域不会自动获得写权限。输入支持十进制、十六进制整数、有限浮点数、布尔值或合法枚举名，拒绝超出类型范围的数值和带副作用的表达式。

采用 [Keil Watch 的运行时修改方式](https://www.keil.com/support/man/docs/uv4/uv4_db_dbg_watchwin.asp)：插件不按名字猜测 PID 或反馈字段。PID 参数未被程序重复赋值时可持续影响本次运行；反馈字段可能被下一次控制循环、中断或 DMA 更新覆盖。若提交后回读已变化，会提示“已写入，但回读时值已被程序更新”，不会持续强制该值。Keil 对[变化较快的变量也说明了这个限制](https://www.keil.com/appnotes/files/apnt_286_v2.1.pdf)。

### 7.3 批量采样设置

默认 `rm-debug.liveMemorySampling: "auto"` 根据可解析类型布局成块读内存，再在电脑上解码；不能可靠处理的字段走兼容路径。普通 RAM 默认由 ELF 的可写 ALLOC 段识别，外设寄存器/MMIO 不当作普通 RAM 批量读取。

| 设置 | 默认值 | 调整含义 |
|---|---|---|
| `rm-debug.liveMemorySampling` | `auto` | `legacy` 使用旧采样路径，可做同条件对照 |
| `rm-debug.liveMemoryMaxBlockBytes` | `2048` | 单个批量读请求的最大字节数 |
| `rm-debug.liveMemoryMergeGapBytes` | `512` | 同一确认 RAM 区域内允许合并的地址间隔 |
| `rm-debug.liveMemoryMaxDepth` | `8` | 指针解引用依赖深度限制 |
| `rm-debug.liveMemoryArrayPageSize` | `64` | 数组首次加载元素数，可减小以控制监控范围 |
| `rm-debug.liveMemoryRamRanges` | `[]` | 堆/栈等额外普通 RAM 的白名单，仅按实际芯片内存图填写 |

不知道内存图时保留 RAM 白名单默认值，不要把外设区域加入。调参数后重新启动会话验证。在输出面板选择 **rm_debug Live Watch**，查看布局准备、对象基址、批量块/字节数、兼容回退原因、读取耗时等。**能批量读不代表一次读到的整个结构体是同一 MCU 时刻的快照**；固件可能在读取过程中更新成员，需要一致性时由固件提供快照或版本号。

### 7.4 已知问题：大量矩阵的结构体可能卡死

**滤波器、状态估计、控制算法中包含大量矩阵/多维数组的结构体，开启“全部字段”或不断加载数组元素，可能让 Live Watch 长时间不刷新、界面卡住，甚至使调试操作明显变慢。** 这是需要规避并反馈的插件能力限制，不应仅凭这个现象判断 MCU 程序死循环。

建议这样使用：

1. 只添加关键标量、状态码和需要的矩阵元素，如 `filter.output`、`filter.covariance[0][0]`，不要一开始添加整个大对象。
2. 关闭大对象的全部字段监控，移除不需要的表达式和波形订阅；**仅折叠界面不一定减少全部字段或已订阅曲线的读取**。
3. 将目标频率降到 1–4 Hz，必要时减小 `liveMemoryArrayPageSize`，不要持续加载所有数组元素。
4. 确需大量数据时，用固件整理成少量诊断量或串口遥测；串口图同样不适合无限量上传整个矩阵。

已经卡住时，先尝试停止调试；界面无响应则执行 **Developer: Reload Window**。恢复后移除大对象或关闭全部字段，再用少量标量重启。若旧监控项导致一连接就再次卡住，可暂时把当前 launch 配置的 `liveWatch.enabled` 改为 `false`，重启窗口后清理监控项，再恢复启用。记录触发的结构体规模与日志，按第 12 节反馈。

## 8. 波形图：Live Plot 与串口上传

运行 **rm_debug: Show Plot (Choose Data Source)**，或点击 Live Watch 标题栏波形按钮，选择数据来源。**两种波形来源的前提和频率不同**：

| 数据来源 | 需要改固件吗 | 当前适用范围 | 时间/频率 |
|---|---|---|---|
| 调试接口直接读取（Live Plot） | 不需要额外串口上报 | **当前首版只开放 DAPLink / CMSIS-DAP + OpenOCD** 的 Live Watch 会话 | Live Watch 实际采样率，时间为主机收到该轮数据的时间 |
| 串口上传出图（Serial Plot） | 需要固件按 RM2 协议主动发送 | 可独立于调试会话使用，与使用哪种 SWD 探针无直接关系 | 固件毫秒时间戳与实际收到的帧率 |

### 8.1 Live Plot 操作

1. 启动 **rm_debug: DAPLink** 调试配置，让 MCU 运行，确认 Live Watch 数值正常。
2. 对一个整数/浮点标量或结构体数值字段右键 → **Add to Live Plot**。
3. 重复添加其他字段，可在一张图里显示多条曲线；整块结构体或矩阵不能直接当一条标量曲线。
4. 面板里可暂停/继续绘图、清空历史、选择 10/30/60/120 秒窗口、设置 Y 轴自动/固定范围、隐藏或移除曲线，并查看当前值与实际频率。
5. 用完关闭面板，释放绘图订阅。

暂停波形只影响绘图，**不会暂停 MCU**。曲线复用 Live Watch 样本，折叠正在绘图的字段仍会读取；采样失败、暂停或断开会留下空档。不要把主机接收时间当成精确控制周期，也不要用低频曲线推断高速 PWM/中断的瞬时波形。已有探针示例曾约 5 Hz，这不是所有设备的保证值。

**0.1.53 波形采样修复：**添加已经在 Live Watch 中采样的普通数值字段时，直接复用当前内存帧，不再重建后台采样计划或重新映射字段。关闭“全部字段”并折叠父节点后，仅保留所选曲线需要的字段路径，不会因一条曲线把无关的同级字段和矩阵一起加入采样。曲线值按通道收集，节点映射仅在树或订阅变化时更新。

升级后的对照步骤：

1. 用同一块板、同一固件、同一探针设置启动 DAPLink 调试，采样模式保持 `auto`，目标频率设置为 20 Hz。先只监控少量普通数值字段，让 MCU 持续运行。
2. 不打开波形，等待至少 15 秒，记录 Live Watch 的“实际采样 Hz”；输出面板选择 **rm_debug Live Watch**，记录内存读取次数/字节数、兼容回退字段数和 GDB 刷新耗时。
3. 将已经采样的一个字段加入 Live Plot，保持监控范围和运行状态不变，再等待至少 15 秒后对比。实际 Hz 使用最近约 10 秒的样本统计，应等统计窗口稳定后判断；这一步不应因添加曲线而增加后台读取范围。
4. 关闭“全部字段”，折叠父节点，确认所选曲线继续更新。移除曲线或关闭图窗后，其额外订阅应释放；重新展开节点会恢复界面所需的采样范围。
5. 若仍持续出现例如约 18 Hz 降至 5.5 Hz，按第 12 节提供添加前后的上述日志、表达式、类型及展开/全部字段状态。软件回归已覆盖订阅行为；具体硬件的实际速率仍需这组对照验证，不能把示例 Hz 当成设备保证值。

**ST-Link / J-Link 能做基础调试与相应 Live Watch，不代表本版的 Live Plot 已开放。** 使用它们打开直接读取波形时的限制提示属于当前功能范围；需要曲线可用下面的串口方式。

### 8.2 Serial Plot 接线与固件协议

当前串口入口使用 **115200、8N1**，不是任意波特率自动识别。将目标板 **UART TX 接串口适配器 RX、GND 接 GND**，使用匹配的电平。DAPLink 虚拟串口也需要真实接到目标 UART，仅连接 SWD 不会自动接通串口。先关闭占用同一端口的其他串口助手。

固件每行发送一帧，推荐格式为：

```text
RM2,1234,controller.speed=120.5,controller.output=-0.25,rc_ctrl.rc.ch[0]=660
```

实际数据必须以 `\n` 结尾，也接受 `\r\n`。`1234` 表示 MCU 开机后毫秒数；后面为逗号分隔的 `变量名=数值`。变量名支持点成员与数字数组索引；数值使用十进制整数/小数，可为负数，当前解析器不支持科学计数法、`NaN`、`Inf`、十六进制或任意 JSON。不要混入调试文字和额外空格。旧 `RM` 示例帧仍兼容，新代码优先使用 RM2。

插件**只会发现固件真实发送的通道**。想画新变量，要在上报函数里加入该字段并重新 Build、Flash；在 UI 输入名称不会让 MCU 自动上报它。

### 8.3 Serial Plot 操作与排查

1. 运行 **Show Plot (Choose Data Source)** → **串口上传出图**，选择对应 COM 口或 `/dev/ttyACM*` / `/dev/ttyUSB*`。
2. 让固件运行；收到帧后从列表多选通道，之后用图窗的 **选择串口变量** 修改选择。
3. 也可运行 **Show Serial Plot (MCU Telemetry)**，或在 Live Watch 字段上 **Add to Serial Plot**；该字段必须已经被固件上报。
4. 查看端口、字节数、有效帧/无效行与实际帧率。图窗批量绘制的频率与固件采样/发送频率是不同指标。
5. 关闭串口图会关闭端口。通过 **Monitor Serial Variable in Live Watch** 可把发现的通道加入实时数值表。

串口图不要求先启动 Debug，也可以与 SWD 调试并用。**0 字节**先检查固件运行、TX/RX、共地、端口与权限；**有字节但 0 有效帧**先检查 115200/8N1、换行、字段格式和实际原始数据。若 MCU 在断点暂停，串口停止发送很正常。

本仓库 `test_cortex` 的 LED 演示位于 `Core/Src/rm_debug_demo.c`，USART1 的 PA9 发送 RM2，约每 20 ms 一帧；可用 `g_led_debug.blink_frequency_hz`、`g_led_debug.led_on` 等通道练习。约 50 帧/秒是遥测上报率，不是灯的闪烁频率；这些引脚和变量只属于该示例，不代表所有队伍工程。

## 9. Trace：找函数热点

### 9.1 Trace 实际能回答什么

当前 Trace 复用现有 **SWO 数据流中的 DWT PC 采样**，把采样到的程序计数器地址映射到当前 ELF 的函数，帮助判断某段运行场景中哪些函数经常被采到。它是**统计热点分析**，可导出 JSON/CSV。

它不提供完整的每次函数调用记录、精确单次执行耗时、完整指令历史或源码行/指令覆盖率。没采到某函数**不能证明它从未执行**，热点比例也不等于严格的 CPU 时间占比。完整 ETM 跟踪/覆盖率需要额外的目标与探针支持，本版尚未实现相关完整解码。

Trace 不另开探针连接，不为分析发起 Live Watch 的变量/内存读取；样本经有界队列由后台 Worker 统计。它可以和 Live Watch 一起开，但 SWO 带宽、目标支持和电脑处理能力仍会影响采集质量。

### 9.2 开启前提

1. 芯片支持用于 PC 采样的 DWT/SWO，不能默认所有 Cortex-M 都有。
2. 探针型号、固件与调试服务器确实支持 SWO；**能够 SWD 烧录并不代表能够采集 SWO**。DAPLink、ST-Link、J-Link 均复用分析入口，但具体硬件能力需确认。
3. 目标板 SWO 引脚已接到探针 SWO 输入，接地正确；引脚未被其他功能占用，必要时固件正确配置复用。
4. 设置真实运行时的核心时钟与兼容的 SWO 频率；固件切换时钟后也要保持匹配。
5. 使用当前构建的 ELF，保留函数符号；OpenOCD 链路继续满足 **0.12.0 及以上**与配套 scripts 要求。

### 9.3 配置、采集与导出

在当前 `launch.json` 的调试 configuration 内合并以下字段。**下面仅示例“目标实际运行于 168 MHz，链路支持 2 MHz SWO”时的参数**；F1、H7 或任何其他时钟都要按实际修改，不能直接复制：

```json
"swoConfig": {
    "enabled": true,
    "profile": true,
    "source": "probe",
    "cpuFrequency": 168000000,
    "swoFrequency": 2000000,
    "decoders": []
}
```

`enabled` 打开 SWO；**`profile: true` 才开启 PC 采样**；`source: "probe"` 表示使用可提供 SWO 的探针链路。`cpuFrequency` 与 `swoFrequency` 单位均为 Hz。`decoders: []` 可用于只采 PC 的场景，需要 ITM 文本等通道时再按调试属性配置 decoder。SWO 的外部串口采集与第 8 节 RM2 UART 遥测是两套不同协议，不要混用。

1. 保存配置后**停止并重新启动 Debug**，仅在已有会话中编辑 JSON 不会重新配置 SWO。
2. 打开调试侧栏 **Trace**，或运行 **rm_debug: 显示 Trace**。
3. 确认没有“未启用 PC 采样/数据源未连接/符号未就绪”等提示，让 MCU 继续运行。
4. 点击 **开始**（**rm_debug: 开始 Trace 采集**），在想分析的固定场景下运行一段时间。
5. 点击 **停止**，等待后台统计结束；再点 **导出**，选择 JSON 或 CSV 与保存位置。
6. 需要新一轮结果时，停止后 **清空 Trace 报告**，再开始采集。对比算法前后时保持场景、采样时长和配置一致。

### 9.4 看懂报告与无样本问题

报告包含函数/PC 样本统计，以及总样本、已映射/未映射样本、平均接收速率、sleep 样本、gap 和丢样诊断；JSON 还保存 ELF 路径、SHA-256 等元数据，方便确认结果属于哪个固件。

- 热点靠前：从该函数和调用场景开始检查，结合源码断点与业务计时验证原因。
- 未映射样本多：检查 ELF 是否对应实际固件、符号是否保留，以及是否运行在库/ROM 等不在当前符号范围的代码。
- sleep 较多：结合低功耗与等待行为解释，不要直接归为函数执行时间。
- gap/丢样较多：结果存在采集空档或队列溢出，不能当作完整执行记录。
- 完全 0 样本：先确认 MCU 未暂停、`profile` 已启用并重启了会话，再检查 SWO 支持、接线、时钟、服务器输出和数据源连接。能看到 ITM 文本也不等于已经收到 PC 样本。

只开启 Trace 面板没有数据并不足以判断插件故障。相同链路能捕获有效 PC 样本、当前 ELF 也匹配，但 rm_debug 始终无法统计时，才进一步按第 11 节做插件对照排查。

## 10. 桌面 C/C++ 混编补充

需要在电脑上先验证算法时，可运行 **rm_debug: Configure Desktop C/C++**，选择桌面 CMake 工程、单文件或已有可执行程序。桌面模式使用**本机** GCC/MinGW + GDB 或 MSVC + Windows 调试器；不要选择 `arm-none-eabi` 工具。

多文件混编选择 CMake，单文件模式只编译当前文件。插件使用 `build/rm-desktop-gdb` / `build/rm-desktop-msvc` 等独立目录，以免与 ARM 缓存混用。桌面调试需要同一 Profile 启用 `ms-vscode.cpptools`；MSVC 需从 Developer PowerShell 环境启动 VS Code。桌面调试配置通常有先编译的任务，**不要把这个行为套到嵌入式 Debug 按钮上**。桌面模式的 Flash 不用于下载 STM32，Live Watch/SWO Trace 教程针对嵌入式会话。

C/C++ 混编与实际运行示例见 [test_cpp 教程](test_cpp/README.md)。

## 11. 故障判断：什么时候才考虑插件问题

**先分清程序逻辑、工程配置、工具/驱动/接线和插件本身。** “插件里出现报错”不等于“报错由插件造成”；OpenOCD 版本、ELF 错配、优化删除变量、串口没上报等，都应先核对。

### 11.1 先按现象定位

| 现象 | 优先检查 | 什么证据更像插件问题 |
|---|---|---|
| C/C++ 语法错误、类型不匹配、未定义引用 | 源码、头文件、库与 CMake source/target | 同环境直接构建成功，插件却漏传/改错参数或调用了错误工具 |
| CMake 找不到工具链/源码、缓存路径冲突 | 工程根目录、preset、toolchain、迁移缓存 | 命令行同路径构建成功，插件持续使用错误目录/生成错误声明 |
| 找不到 ELF、断点不命中、源码位置错乱 | 是否 Build、固件路径、下载是否成功、调试信息与优化 | 当前 ELF 已确认对应目标，同一工具链可正常调试，插件显示仍与原始 GDB 结果矛盾 |
| 找不到探针、权限不足、无法连接芯片 | USB 驱动/udev、供电、SWD 接线、target、探针占用 | 相同参数直接连接成功，插件在启动参数或资源释放上稳定失败 |
| 烧录失败、校验错误、OpenOCD 脚本报错 | **OpenOCD ≥ 0.12.0**、配套 scripts、芯片/保护状态、接线 | 完全相同的烧录命令直接成功，经插件执行稳定失败 |
| 烧录成功后 HardFault、看门狗复位、任务没运行 | 程序入口、栈、越界、空指针、中断、初始化与调度 | 不同调试工具观察到的是同一程序故障，不能因此归为插件问题 |
| Live Watch 找不到符号/值不变 | 当前 ELF、变量是否保留/实际更新、作用域、MCU 是否在跑 | GDB 对同一对象读到正确变化，插件对相同类型/地址稳定显示错值或不更新 |
| 大矩阵结构体使 Live Watch 卡死 | 全部字段范围、数组加载量与订阅数 | **属于已知的监控规模限制**；少量标量正常、加入大对象可稳定触发时值得反馈 |
| 串口图没线/无有效帧 | 端口、权限、115200/8N1、RM2 格式、固件是否真实发送 | 可保存的原始帧符合协议，其他工具能接收，插件解析或绘图稳定失败 |
| Trace 无样本 | SWO 支持/接线/时钟、`profile`、MCU 运行、数据源 | 有效 PC 数据与 ELF 已核实，插件 Worker 报错或有输入却始终无统计 |
| rm_debug 命令/面板消失、提示安装 Cortex-Debug | Profile、扩展启用、依赖、官方版冲突、重载 | 正确 Profile 与依赖齐全、无冲突，扩展宿主日志仍报告本插件激活异常 |

程序异常有时也会造成调试连接中断，例如进入低功耗、改写 SWD 引脚配置、频繁复位；这些要结合板子和程序状态调查，不能单凭“断连”定性。

### 11.2 验证符号、地址与数据来源

暂停 MCU，在 Debug Console 中求值，例如：

```text
p controller.output
p &controller.output
x/1fw &controller.output
```

`p` 看表达式，`p &...` 看地址；`x/1fw` 只适合该对象确实为 32 位浮点时。本插件的 Cortex-Debug 控制台可直接发送这些 GDB 命令。原始值都读不到时先排查符号/作用域/内存，不能要求 Live Watch 正常显示。

用当前工具链的 `nm` 检查**最终 ELF**是否保留变量（替换实际路径和名称）：

```powershell
& "D:/Tools/arm-gnu/bin/arm-none-eabi-nm.exe" ".\build\Debug\firmware.elf" | Select-String "controller"
```

```bash
arm-none-eabi-nm build/Debug/firmware.elf | rg 'controller'
```

源文件中有变量，不代表链接后的 ELF 中有它。没被引用的模块、优化、`--gc-sections` 都可能移除对象；`volatile` 用于匹配程序的访问语义，不是解决所有链接保留问题的万能开关。先确认模块真的参与构建并使用该对象，不要为看变量盲目修改算法语义。

对于错值，在暂停状态对照同地址/同类型，减少读取时序影响；对于刷新问题，用固定的小标量测试并观察实际采样日志。串口则保存原始行，Trace 则检查数据源与 PC 样本，而不是只截一个空白面板。

### 11.3 做最小对照后再归因

1. 保留故障发生时的配置和完整输出，确认当前 Profile 只启用了 rm_debug。
2. 对照日志中的**同一工具路径、工作目录、环境、ELF、参数**执行 CMake / OpenOCD / J-Link。独立测试前先停止调试，避免两者同时占探针；复制烧录命令会实际重写固件，先核对板子与 ELF。
3. 若独立命令也失败，优先修工具、接线、固件或工程规则；若独立成功而插件稳定失败，检查插件命令生成与启动过程。
4. 用最小工程/一个递增全局标量复现，逐步关闭 Live Watch、波形和 Trace，再单独启用，确定触发功能。
5. 需要与官方 Cortex-Debug 对照时，在另一个 Profile 或先禁用 rm_debug 后测试，**不能在同一环境同时启用两者**。保持同一个 ELF、硬件与服务器参数，才有比较意义。

这些证据说明“值得按插件问题反馈”，并不要求每个队员先独自查出根因。扩展激活异常、Webview/Worker 崩溃、可重复的解析错值、错误命令生成、正确输入下 UI 不更新，以及大对象造成的已知卡死，都是有价值的反馈。

## 12. 队内反馈与维护

### 12.1 报问题时带什么

把以下信息交给队内插件维护者，避免只发“Debug 不行”的截图：

- 操作系统/架构、VS Code 与 rm_debug 版本、当前 Profile、是否同时启用官方 Cortex-Debug。
- 芯片型号、探针型号/固件、供电与接线情况；OpenOCD 的**完整路径与版本**、scripts 路径，或 J-Link 版本。
- 从打开工程到故障的复现步骤；Build/Flash 是否成功；预期结果与实际结果。
- 相关 `.vscode/settings.json`、`launch.json`、preset；删去无关个人路径信息后提供即可。
- **rm_debug** 输出、**rm_debug Live Watch** 输出、Debug Console 和 GDB Server 终端的相关日志。扩展启动/界面异常可查看 **Log (Extension Host)** 与 **Developer: Toggle Developer Tools** 控制台。
- Live Watch 问题：表达式、相关类型定义、数组/矩阵维度、目标/实际频率、是否全部字段、批量/兼容模式，以及 GDB 对照值。
- 串口问题：原始 RM2 帧、字节/有效帧/无效行计数；Trace 问题：SWO 配置、数据源状态、导出的 JSON/CSV 与对应 ELF 信息。

### 12.2 维护者从源码打包

扩展源码在 `cortex-debug-master`。以下为维护者操作，普通队员直接安装 VSIX。先准备 Node.js 22 或更新版本与 npm；运行下面的真实 GDB 回归还需要本机 `g++` 和 `gdb`；Linux x64 包需在 Linux x64 上构建，ARM64 包需在 Linux ARM64 上构建。从仓库根目录执行：

```bash
cd cortex-debug-master
npm ci
npm run test-compile
node test/live-plot-subscription.test.js
node test/live-watch-sample-state.test.js
node test/live-watch-legacy.test.js
node test/live-watch-edit-ui.test.js
node test/live-watch-traversal.test.js
node test/live-memory-engine.test.js
node test/live-matrix.test.js
npm run lint
npm run package:ubuntu
code --profile "cmake_debug" --install-extension ./rm-debug-0.1.54-linux-x64.vsix --force
code --profile "cmake_debug" --list-extensions --show-versions
```

当前版本来自 `package.json`；Linux x64 产物为 `rm-debug-0.1.54-linux-x64.vsix`，可直接分发给同平台队员。`package:ubuntu` 会运行发布前构建、生成网页资源并准备原生 USB/串口模块，不需要手动复制 `dist`。Linux ARM64 替换安装文件名后缀；Windows 在 Windows 上使用 `npm run package` 构建自己的包。安装完成后重载对应 Profile 的窗口并重新启动调试。

Linux 包使用 `npm run package:ubuntu`，工具环境与原生 USB/串口模块要求见 [Ubuntu 文档](cortex-debug-master/UBUNTU.md)。源码调试可在该目录按 `F5` 启动 Extension Development Host。软件编译/测试通过与生成 VSIX 不代表真实板卡的烧录、运行中采样、SWO/串口功能均已验收，发包前仍需用队伍实际硬件验证。

本插件保留上游 MIT 许可证与相关声明，见 [LICENSE](cortex-debug-master/LICENSE)。


## Live Watch 矩阵网格（0.1.50）

固定大小的 Eigen `Matrix` / `Array` 和数值二维 C 数组会在 Watch 侧栏自动显示为行列网格，不需要展开 Eigen 的继承层级或 `m_storage`。向量保持实际形状，例如 `12 × 1`；非方阵保持原有行列数。每个可识别变量右侧有 **自动 / 默认 / 矩阵** 选择器，默认表示原有树形显示，选择会保存在当前工作区。

0.1.52 起，每个矩阵下方显示最近采样时间（含毫秒）及数值变化状态。时间持续更新但数值未变化，表示读到的目标内存值保持相同；请检查固件是否实际写入该矩阵。矩阵读取失败或暂停后的刷新也会立即送到侧栏，失败时清空旧单元格并显示原因。

0.1.54 起，每次开始调试默认收起所有监控项，并关闭上次会话的“全部字段”。手动逐层展开所需结构体、指针、`*`、反馈字段或矩阵；识别矩阵和切换显示方式不会自动展开。兼容采样模式也会显示未变化字段的首次采样值，角度变化不会再触发不必要的字段树重建。

一维数值 C 数组默认沿用树形显示；选择矩阵后，可右键 **设置矩阵行列数…**，例如把 16 个元素排成 `4x4`。元素总数必须一致。矩阵支持收起、变化单元格高亮，以及右键复制为制表符分隔的行；单元格显示约 6 位有效数字，悬停查看完整值。

实机矩阵直接解析自己的连续存储区并批量读取，不依赖父结构体的 C++ 布局解析，也不调用目标程序的 Eigen 方法。列优先和行优先存储均按实际行列顺序显示；读取失败时显示空值和原因。当前支持固定维度、数值元素且最多 4096 个元素的矩阵；动态大小 Eigen 矩阵沿用树形显示。MuJoCo 本机调试使用同一网格界面。

## MuJoCo 仿真 C++ 调试与 Live Watch（0.1.48）

Linux 上可从 rm_debug 面板直接执行 **MuJoCo 编译 C++**、**MuJoCo 窗口调试**、**MuJoCo 无窗口调试**。它使用 Microsoft C/C++ 的 `cppdbg` 和本机 GDB 启动 Python/MuJoCo，并在 Python 加载本机 Debug 动态库后绑定 C/C++ 断点。

已有 `MuJoCo: 嵌入式 C++ Debug（窗口）` 和无窗口配置的工程，打开整个工程目录即可点击两个仿真调试按钮；原配置、启动参数、CSV 路径和 `preLaunchTask` 原样使用。独立 MuJoCo 按钮可以与当前 DAPLink 工作流并用。

点击 **配置 MuJoCo 仿真 → 接入已有 MuJoCo 调试配置** 可将通用 Build / Debug 按钮也切换到仿真模式（`rm-debug.target: mujoco`）。实物烧录时重新运行“配置工程和工具路径”，或将该设置切回 `embedded`。

新工程选择 **生成 MuJoCo C++ 调试配置**，填写本机 CMake 目录、Debug 构建目录和 Python 入口。默认识别 `parallel_controller_mujoco/native`、`parallel_controller_mujoco/build/native`、`parallel_controller_mujoco/scripts/run_sim.py`，生成独立命名的窗口/无窗口配置及 CMake 任务，保留已有桌面和探针配置。入口脚本应支持 `--embedded`、`--headless`、`--duration`，并从指定构建目录加载动态库；可编辑生成的 `launch.json` 添加 `--embedded-library`、模型、载荷、日志等参数。Python 解释器可通过 `rm-debug.mujoco.pythonPath` 指向已安装 MuJoCo 的虚拟环境，再生成配置。无窗口时长默认 10 秒，生成前可设置 `rm-debug.mujoco.headlessDuration`；已有配置沿用原参数。

仿真调试启动前自动执行本机 Debug 构建。可在 `ArmApplication_step()`、`solve_platform_position()` 等实际 C++ 函数中设断点，展开 `arm_application` 或 `arm_sim_state`。动态库尚未加载时断点可能显示未绑定；生成配置启用 GDB pending breakpoint，加载后自动绑定。断点暂停时仿真一起暂停，继续即可恢复。

同一 VS Code Profile 需要启用 `ms-vscode.cpptools`，本机需要 Python/MuJoCo、GDB、CMake 和本机 C++ 编译器；不需要 Python 调试扩展。仿真执行本机适配的 C++ 代码，HAL、FreeRTOS、CAN 和实际 MCU 外设仍需要实物验证。SWO 仍用于嵌入式调试会话。

开发验证：`npm run test:mujoco`；Ubuntu 安装包：`npm run package:ubuntu`。

MuJoCo 启动时自动打开已有 Live Watch 面板，加入 `arm_application` 与 `arm_sim_state`，默认均收起。手动展开变量或显式启用“全部字段”可在运行中监视结构体、数组、指针及数值曲线，标量和枚举支持改值；默认 4 Hz，可在面板调整。采样通过同一调试会话的 GDB 读取对象内存，不暂停仿真。动态库加载前显示等待提示，加载后自动重新发现变量。其他全局表达式可使用面板添加按钮；`liveWatch.enabled: false` 可禁用此接入。本机 GDB 需支持 Python。升级后请执行“开发人员: 重新加载窗口”，再重新启动仿真调试。

本机采样回归：`python3 test/native-live-watch-real.test.py`（需要 GDB、g++ 和允许 ptrace 的环境）。
