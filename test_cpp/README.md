# 以 C 为主的 C/C++ 混合编译示例

在 VS Code 打开本目录，启用 `rm_debug` 和 Microsoft C/C++ (`ms-vscode.cpptools`)。

1. 运行 **rm_debug: Configure Desktop C/C++**。
2. 选择 **桌面 CMake 工程**，再选择 **GCC / MinGW + GDB** 或 **MSVC + Windows 调试器**。
3. 工程目录填 `.`。GCC/MinGW 的程序路径填 `build/rm-desktop-gdb/app.exe`（Linux 填 `build/rm-desktop-gdb/app`）；MSVC 填 `build/rm-desktop-msvc/Debug/app.exe`。
4. 打开 `main.c`，在 `cpp_accumulate(value)` 行设置断点。
5. 点击 **Debug** 或按 F5，同一个 Build 会编译 `main.c`、`c_math.c` 和 `cpp_module.cpp`，并链接成一个 `app`。单步可以从 C 的 `main()` 进入 C++ 的 `Counter::add()`，再进入 C 的 `c_double()`。

GCC/MinGW 需要同一工具链里的 gcc、g++、GDB，以及 CMake 和 Ninja。MSVC 需要 Visual Studio C++ 工具和 CMake，并从 Developer PowerShell 启动 VS Code。

`mixed_api.h` 用 `#ifdef __cplusplus` 和 `extern "C"` 声明两种语言之间的接口。C 源文件仍按 C 编译，类只在 C++ 模块内部使用。正常输出为 `C/C++ mixed debug: total = 30`。

**当前 C/C++ 文件**模式只编译一个文件，会根据扩展名自动选择 C 或 C++ 编译器。本示例有多个文件，应选择 CMake 模式。

单文件模式默认 C11 / C++20，可通过 `rm-debug.desktop.cStandard` / `cppStandard` 修改。配置 CMake 工程时，插件设置 C++20 并要求编译器支持该标准；本例使用 C11 / C++20。
