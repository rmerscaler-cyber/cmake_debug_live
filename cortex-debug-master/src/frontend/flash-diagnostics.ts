export interface FlashDiagnosis {
    id: string;
    cause: string;
    evidence: string;
    steps: string[];
}

/** One collector per invocation; retain the tool banner and the final error without unbounded buffering. */
export class FlashLog {
    private head = '';
    private tail = '';
    private truncated = false;

    append(text: string): void {
        const remaining = 16384 - this.head.length;
        if (remaining > 0) {
            this.head += text.slice(0, remaining);
            text = text.slice(remaining);
        }
        this.tail += text;
        if (this.tail.length > 114688) {
            this.tail = this.tail.slice(-114688);
            this.truncated = true;
        }
    }

    get text(): string {
        return this.head + (this.truncated ? '\n[分析缓冲省略中间日志；完整输出见上方]\n' : '') + this.tail;
    }
}

/** Suggestions are evidence-based possibilities, never a claim that hardware was inspected. */
export function analyzeFlashFailure(log: string, platform: NodeJS.Platform = process.platform): FlashDiagnosis[] {
    const clean = log.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g'), '');
    const lines = clean.split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
    const results: FlashDiagnosis[] = [];
    const add = (id: string, pattern: RegExp | RegExp[], cause: string, steps: string[]) => {
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        const evidence = lines.find((line) => patterns.some((expression) => expression.test(line)));
        if (evidence) { results.push({ id, cause, evidence: evidence.slice(0, 500), steps }); }
    };

    add('usb-permission', [
        /LIBUSB_ERROR_ACCESS|libusb[^\r\n]*(?:access denied|permission denied)/i,
        /(?:usb|hid)[^\r\n]*(?:access denied|permission denied)|(?:access denied|permission denied)[^\r\n]*(?:usb|hid)/i
    ], 'USB 探针访问权限不足', platform === 'win32'
        ? [
                '检查探针驱动是否与工具匹配：ST-Link 使用相应 ST 驱动，CMSIS-DAP 按设备接口使用 HID/WinUSB，J-Link 使用 SEGGER 驱动。',
                '关闭其他占用探针的程序，重新插拔 USB 后重试。'
            ]
        : [
                '安装当前 OpenOCD 或 SEGGER 软件附带的 USB udev 规则，重新加载规则后拔插探针。',
                '确认当前用户具有该 USB 设备的访问权限；串口 dialout 权限不能代替 USB 探针权限。'
            ]);
    add('usb-driver', /LIBUSB_ERROR_NOT_SUPPORTED|no (?:usable |supported )?USB driver|USB driver[^\r\n]*(?:not installed|not found)/i,
        'USB 驱动或接口后端不兼容', [
            '检查所选探针类型与实际设备一致，并安装工具支持的探针驱动。',
            'DAPLink 检查固件提供的是 HID 还是 bulk 接口；核对 OpenOCD 的 CMSIS-DAP 后端和配套 scripts。'
        ]);
    add('probe-busy', /LIBUSB_ERROR_BUSY|usb_claim_interface[^\r\n]*(?:-6|busy)|(?:probe|J-Link|ST-Link|USB|device)[^\r\n]*(?:already in use|in use by|busy)/i,
        '探针可能被其他程序占用', [
            '结束其他 IDE 的调试会话，关闭独立 OpenOCD、J-Link、STM32CubeProgrammer 等占用探针的程序。',
            '确认没有遗留的调试服务器，再重新连接探针。'
        ]);
    // A generic "cannot find/open probe" often follows a specific access/driver/busy error.
    if (!results.length) {
        add('probe-missing', [
            /unable to find[^\r\n]*(?:CMSIS-DAP|ST-?LINK|J-Link)|no[^\r\n]*(?:CMSIS-DAP|ST-?LINK|J-Link)[^\r\n]*(?:found|connected)/i,
            /(?:cannot|could not|failed to) connect to J-Link|LIBUSB_ERROR_NO_DEVICE|^(?:Error:\s*)?open failed\s*$/i,
            /stlink_usb_open\(\)[^\r\n]*(?:failed|error)/i
        ], '未找到或无法打开 Link 探针：可能未插 USB、线缆异常或探针类型不匹配', [
            '确认 DAPLink / ST-Link / J-Link 已插入电脑，使用可传数据的 USB 线，尝试其他 USB 口并检查系统是否识别设备。',
            '核对插件的探针类型、interface 配置及探针序列号筛选；设备可见但无法打开时再检查驱动、权限与占用。'
        ]);
    }
    add('tool-missing', [
        /command not found|No such file or directory|\bENOENT\b|找不到 Bash/i,
        /error while loading shared libraries|cannot execute|Exec format error/i
    ], '烧录工具无法启动，或所需文件/运行库缺失', [
        '检查本次命令里的 Bash、OpenOCD 或 J-Link 路径是否存在且适用于当前操作系统。',
        '运行“配置工程和工具路径”修正路径；若日志指定缺失的动态库或固件文件，检查该文件。'
    ]);
    add('tool-permission', /\bEACCES\b|permission denied|access is denied/i,
        '工具或文件访问被拒绝', [
            '检查日志指定的可执行文件、脚本和 ELF 的访问权限；Linux 工具还需要执行权限。',
            '若拒绝发生在 USB 设备上，检查探针对应的 udev 规则或驱动。'
        ]);
    if (results.some((item) => item.id === 'usb-permission')) {
        const index = results.findIndex((item) => item.id === 'tool-permission');
        if (index >= 0) { results.splice(index, 1); }
    }
    add('scripts', [
        /can(?:not|'t) find[^\r\n]*\.cfg|couldn'?t read file|invalid command name|unknown command/i,
        /unknown (?:interface|adapter|driver)|(?:interface|adapter|driver)[^\r\n]*not found/i
    ], 'OpenOCD 配置脚本缺失，或工具版本与 scripts 不匹配', [
        '核对 openocdScriptsPath、interfaceConfig、targetConfig，以及本次命令的 -s / -f 参数。',
        '本插件要求 OpenOCD 0.12.0 及以上；可执行文件和 scripts 使用同一套安装，避免新版脚本搭配旧工具。'
    ]);
    add('target-power', /(?:target voltage|VTref)[^\r\n]*(?:too low|0\.0+\s*V|0\s*mV)|target[^\r\n]*not powered/i,
        '目标板供电或参考电压异常', [
            '检查目标板供电、GND 和探针 VTref 接线；USB 连接成功不代表目标板已供电。',
            '按板卡和探针说明核对电压，修复供电后再试。'
        ]);
    add('target-connection', [
        /(?:cannot|can not|could not|failed to|unable to) connect to (?:the )?target|Error connecting to target/i,
        /(?:JTAG|SWD)-DP[^\r\n]*(?:error|fail)|(?:SWD|JTAG)[^\r\n]*ACK|Failed to read memory/i,
        /(?:target|cpu)[^\r\n]*(?:examination failed|not examined|not halted)|init mode failed|UNEXPECTED idcode|expected[^\r\n]*idcode/i
    ], '探针无法正常访问芯片：可能是接线、复位、速度或芯片配置问题', [
        '核对板子供电以及 SWDIO、SWCLK、GND、必要时 NRST 接线，缩短连线并尝试降低 SWD 速度。',
        '确认 target 配置 / J-Link device 对应实际芯片；若程序禁用 SWD 或进入低功耗，检查连接复位策略。'
    ]);
    add('flash-protection', [
        /(?:flash|device|sector|memory)[^\r\n]*(?:write.protected|is protected|\blocked\b)/i,
        /(?:read.?out protection|\bRDP\b|protection)[\s:=]*(?:is\s+)?(?:enabled|active|level\s*[12])/i
    ], '芯片 Flash 可能启用了读写保护', [
        '检查芯片选项字节、RDP 与 Flash 写保护状态，并确认芯片型号和固件地址。',
        '解除保护可能擦除数据或不可逆，请按芯片手册评估；插件不会自动解锁或擦除。'
    ]);
    if (!results.some((item) => item.id === 'flash-protection')) {
        add('flash-verify', [
            /verification (?:failed|error)|verify (?:failed|error)|contents differ/i,
            /(?:flash|erase|programming|write)[^\r\n]*(?:failed|failure)|no flash bank found/i
        ], 'Flash 写入或校验失败', [
            '核对芯片型号、Flash 容量、ELF 链接地址与目标配置；确认固件来自最近一次成功编译。',
            '检查供电稳定性、SWD 速度和 Flash 保护状态，再查看上方首次报错。'
        ]);
    }
    const version = clean.match(/Open On-Chip Debugger\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (version && Number(version[1]) === 0 && Number(version[2]) < 12) {
        results.push({
            id: 'openocd-version', cause: '当前 OpenOCD 低于插件要求的 0.12.0，可能不支持所用命令或探针',
            evidence: version[0], steps: [
                '安装 OpenOCD 0.12.0 或更新版本，并在“配置工程和工具路径”中选择实际使用的新工具。',
                '同时更新 openocdScriptsPath，确保 scripts 与可执行文件来自同一套安装。'
            ]
        });
    }
    if (!results.length) {
        results.push({
            id: 'unknown', cause: '现有日志不足以确定失败原因',
            evidence: (lines.find((line) => /error|failed|failure|exit|退出码/i.test(line)) || lines[lines.length - 1] || '工具未输出错误详情').slice(0, 500),
            steps: ['查看本次完整输出中的首次报错、实际工具路径、工作目录和退出码。',
                '检查探针连接与供电、USB 权限/驱动、芯片配置和工具版本；自定义烧录命令还需检查其自身参数和退出码。']
        });
    }
    return results.slice(0, 3);
}

export function formatFlashDiagnosis(diagnoses: FlashDiagnosis[]): string {
    return ['\n本次烧录失败分析（根据日志推测）：', ...diagnoses.map((item, index) => [
        `${index + 1}. 可能原因：${item.cause}`, `   日志依据：${item.evidence}`,
        ...item.steps.map((step) => `   建议：${step}`)
    ].join('\n'))].join('\n');
}
