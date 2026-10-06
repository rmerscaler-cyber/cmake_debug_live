# rm_debug 使用说明

完整的队伍教程已合并到 [README：从安装到 STM32 调试](./README.md)。默认/已有 Profile 与独立 `stm32` Profile 都可以使用，请按教程选择自己的安装方式。

0.1.56 的新功能入口：光标放在变量名上，按 **`Ctrl+Alt+Shift+F`**，选择检索方式与 **当前文件 / 当前工程 / 整个工作区**。详细步骤见 [变量搜索与跳转](./README.md#variable-search)，烧录报错提示见 [失败分析](./README.md#flash-diagnostics)。

教程覆盖工具路径、CMake 工程树与 C/C++ 混编、Build、Flash 失败原因分析、基础 Debug、变量搜索范围选择与定义/真实引用、Live Watch、调试接口与串口波形、SWO Trace，以及插件故障的对照排查方法。Ubuntu 的系统依赖与权限补充见 [Ubuntu 安装与验证说明](./UBUNTU.md)。

> 通过 OpenOCD 烧录必须使用 **0.12.0 及以上版本**和配套 scripts；包含大量矩阵/数组的结构体可能导致 **Live Watch 卡死**，请优先监控少量标量和需要的元素，规避与恢复步骤见 README 第 7 节。
