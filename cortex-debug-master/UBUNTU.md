# rm_debug 0.1.54：Ubuntu 安装与验证

这一版保留 rm_debug 的命令、界面和工作流，为 Ubuntu 增加工具发现、Bash 命令执行、Linux 路径及原生串口/USB 打包支持。Windows 继续使用 Git Bash 和原有设置。0.1.54 修复 Live Watch 兼容模式中角度反馈一直等待首次采样的问题；每次开始调试默认收起监控项并关闭“全部字段”，手动展开所需分支以减少后台读取。矩阵保留最近采样时间与变化状态，具体操作见队伍教程第 7 节。

## 安装环境

以 Ubuntu 22.04/24.04 为目标；本次软件验证在 Ubuntu 22.04 x64 上完成。24.04 和 Linux arm64 尚未实测。

安装 **VS Code 1.92 或更新版本**（串口模块要求其扩展宿主提供 Node.js 20；无需单独安装系统 Node.js），然后在终端准备工具：

```bash
sudo apt update
sudo apt install cmake ninja-build gcc-arm-none-eabi binutils-arm-none-eabi \
    libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib gdb-multiarch openocd
```

> **烧录版本要求：OpenOCD 必须为 0.12.0 及以上。** 系统包不保证满足这一要求，安装后运行实际选用的 OpenOCD 完整路径加 `--version` 检查。低于 0.12.0 时更换符合要求的安装，并同步更新 `rm-debug.openocdPath` 与配套 `rm-debug.openocdScriptsPath`，不要混用旧 scripts。

桌面 C/C++ 开发另需 `build-essential` 和 `gdb`。如果工程要求特定 ARM GCC 版本，可继续使用对应的 Linux ARM GNU 工具链，在向导中选择它的 `arm-none-eabi-gcc`。插件会优先使用保存的 GDB 或 GCC 同目录的 `arm-none-eabi-gdb`；Ubuntu 下还会检查 GDB 能否启动，必要时回退到 `gdb-multiarch`。ARM 编译器/objdump/nm 和 GDB 可以位于不同目录。

如工程使用 C++20 库特性（例如 `std::bit_cast`），还需选择提供对应标准库支持的 ARM 工具链；Ubuntu 22.04 的默认 ARM GCC 10.3 在本次 F4 工程中无法编译该特性，使用已有 ARM GCC 12.3 后通过。仅设置 C++20 语言标准并不能补齐旧标准库。

Ubuntu 的多架构 GDB 包见 [Ubuntu 官方包说明](https://packages.ubuntu.com/noble/gdb-multiarch)。使用 J-Link 时安装 [SEGGER 官方 Linux 软件包](https://www.segger.com/downloads/jlink)，向导识别 `JLinkExe`，以及 `JLinkGDBServerCLExe`、`JLinkGDBServerCL` 或 `JLinkGDBServer`。后一个名称也见 [SEGGER GDB Server 文档](https://kb.segger.com/J-Link_GDB_Server)。DAPLink 和 ST-Link 使用 OpenOCD。

## USB 与串口权限

Ubuntu 上探针由 USB/udev 权限管理。安装 OpenOCD 后检查规则：

```bash
dpkg -L openocd | grep rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

重新插拔探针。如果仍提示权限不足，先用 `lsusb` 确认探针的 VID/PID，再核对 OpenOCD 的规则是否包含它。部分自制 DAPLink 的 VID/PID 不在默认规则中，需要按实际设备补充规则。J-Link 使用 SEGGER 软件包随附的 udev 规则。

串口波形通常使用 `/dev/ttyACM0` 或 `/dev/ttyUSB0`：

```bash
sudo usermod -aG dialout "$USER"
ls -l /dev/ttyACM* /dev/ttyUSB* 2>/dev/null
```

加入组后注销并重新登录，再启动 VS Code。可通过 `/dev/serial/by-id/` 的设备路径避免端口编号变化。固件仍须输出原有的 RM2 协议；安装插件不会自动生成串口遥测数据。

## 安装插件与配置工程

默认/已有 Profile 与独立 `stm32` Profile 均支持，完整安装流程见 [队伍教程](./README.md)。以下命令以独立 `stm32` Profile 为例；不创建新 Profile 时，可在当前 Profile 的扩展视图使用 **Install from VSIX...**。

当前含 Live Watch 临时编辑、矩阵刷新、角度反馈首次采样修复及按需展开的 Linux x64 包为 `rm-debug-0.1.54-linux-x64.vsix`。可把同一个 VSIX 分发到其他 Linux x64 电脑，保存到任意目录；不需要源码仓库。下载直链及命令见[队伍教程的获取安装包说明](./README.md#1-下载与安装准备)。

在收到的 VSIX 所在目录运行：

```bash
code --profile stm32 --install-extension ./rm-debug-0.1.54-linux-x64.vsix --force
```

使用默认 Profile 时去掉 `--profile stm32`；已有其他 Profile 时替换成自己的名称。该包不适用于 Windows 或 Linux ARM64，需分别生成对应平台的包。

在该 Profile 中关闭官方 `marus25.cortex-debug`，避免同一种调试类型冲突。检查四个配套扩展是否已安装：`mcu-debug.debug-tracker-vscode`、`mcu-debug.memory-view`、`mcu-debug.rtos-views`、`mcu-debug.peripheral-viewer`。然后执行 **Developer: Reload Window**。

打开 STM32 工程，在 rm_debug 侧栏执行 **配置工程和工具路径**，选择 CMake 工程、preset、ELF 路径和探针。迁移旧 Windows 工程时重新运行向导，以更新本机工具和生成的调试配置。默认 Build 会识别源码/构建路径发生变化的旧 CMake 缓存，将 CMakeCache.txt 与 CMakeFiles 移到构建目录下的 `.rm-debug-cmake-cache-*` 备份目录，再重新配置。已有 ELF 和源码保留；未迁移的缓存继续用于增量构建。自定义 configureCommand 的构建目录由用户决定，需要自行处理旧缓存。

Linux 默认自动发现 Bash，无需安装 Git Bash。机器设置示例（ARM GCC 也可以改成自己安装的版本）：

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

这些路径保存在 Ubuntu 的 VS Code 用户设置中；工程参数保存在工作区。自定义 configure/build/flash 命令仍使用 Bash，请把旧命令中的 Windows 绝对路径换成当前机器的路径。J-Link 项目在向导中使用实际芯片的 device 名称。

之后依次使用 **Build → Flash → Debug**。DAPLink 的 Live Plot 继续通过 Live Watch 数据绘图；Serial Plot 选择 Linux 串口路径，继续按 RM2 帧绘图。

## 从源码打包

在 `cortex-debug-master` 中，使用可运行 npm 的 Node.js 22 或更新版本：

```bash
npm ci
npm run test:ubuntu
npm run lint
npm run package:ubuntu
```

`package:ubuntu` 在当前 Linux 架构上生成 `rm-debug-0.1.54-linux-x64.vsix` 或 `rm-debug-0.1.54-linux-arm64.vsix`。打包前构建扩展和网页资源，安装锁定的原生依赖，并检查串口/USB 模块可加载。应在目标架构的 Linux 上打包。不要直接复用 Windows 机器的 `dist/node_modules`。

## 本次验证范围

- TypeScript 编译和 ESLint 检查。
- 迁移缓存的备份、失败回滚、增量构建保留；使用真实 CMake 复现 Windows 缓存路径冲突并验证重新配置/构建成功。
- Ubuntu 配置向导：DAPLink、ST-Link、J-Link，保留其他已有调试配置。
- Bash、工具发现、可执行权限、失效 Windows 路径、GDB 启动失败回退，以及 GDB 与 ARM binutils 分目录。
- 含空格和单引号的工程/工具路径；构建和烧录命令通过模拟工具执行，核对参数及 J-Link 临时脚本清理。
- Linux CMake 大小写不同的源文件保留。
- 串口波形的分段 RM2 数据、LF/CRLF、浮点数、采样频率和无效帧处理（模拟串口）。
- Live Watch 类型、内存采样、遍历和状态回归，以及桌面工作流回归。
- 0.1.54 真实 GDB/MI 回归：未变化字段的首次采样、角度变化时保持字段树稳定，以及折叠分支冻结、展开后恢复读取（`test/live-watch-legacy.test.js`，需要本机 `g++` 和 `gdb`）。
- 默认收起、矩阵显示切换不自动展开、字段树重建时保留采样值，以及波形订阅和临时编辑界面回归。
- `test_cortex` 在本机 ARM GCC 下实际编译和链接 STM32 Debug ELF。
- 用真实 STM32 ELF 验证 Live Watch 的结构体、浮点、嵌套字段、函数指针和 300 元素数组布局（`test/ubuntu-elf-layout.test.js`）。
- 原有混编 smoke test：桌面 C/C++ 编译运行、GDB 断点/单步/变量/调用栈，以及 ARM Cortex-M3 混编链接。

原有 `test/suite/gdb_expansion.test.ts` 有 4 项失败：测试回调返回 0，而断言期待嵌套引用对象。该测试和 `src/backend/gdb_expansion.ts` 本次均未修改；未把这些用例记为通过。

尚需接实际探针/目标板验证：USB 权限、Flash 写入及复位、F5 启动、运行中 Live Watch、真实 DAPLink/串口波形、SWO/RTT 和 Trace。软件测试与生成 VSIX 不等于硬件功能已经验收。
