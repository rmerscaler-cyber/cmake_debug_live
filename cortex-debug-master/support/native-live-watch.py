"""Live Watch transport inside the owning native GDB (no second debugger or pause)."""
import gdb
import json
import math
import os
import re
import socket
import threading
import time


class NativeLiveWatch:
    def __init__(self, pathname):
        self.nodes = {}
        self.expressions = {}
        self.next_id = 1
        self.subscription = None
        self.matrix_requests = []
        self.pending_roots = set()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(pathname)
        os.chmod(pathname, 0o600)
        self.server.listen(1)
        threading.Thread(target=self.serve, daemon=True).start()

    def bind(self, expression, root=None, steps=None):
        if expression in self.expressions:
            return self.expressions[expression]
        number = self.next_id
        self.next_id += 1
        self.nodes[number] = {'expression': expression, 'root': root or number, 'steps': steps or []}
        self.expressions[expression] = number
        return number

    def value(self, number, cache):
        node = self.nodes[number]
        root = node['root']
        if root not in cache:
            expression = self.nodes[root]['expression']
            # Watches must never execute inferior functions or modify program state.
            if not expression or re.search(r'[;={}\n]|\+\+|--|[\w)>\]]\s*\(', expression):
                raise ValueError('Live Watch 仅支持无副作用的变量、成员、数组或指针表达式')
            value = gdb.parse_and_eval(expression)
            if value.address is not None and 0 < value.type.sizeof <= 1024 * 1024:
                data = gdb.selected_inferior().read_memory(int(value.address), value.type.sizeof).tobytes()
                value = gdb.Value(data, value.type)
            cache[root] = value
        value = cache[root]
        for step in node['steps']:
            value = value.cast(gdb.lookup_type(step['base'])) if isinstance(step, dict) else value[step]
        return value

    @staticmethod
    def kind(value):
        typ = value.type.strip_typedefs()
        code = typ.code
        if code == gdb.TYPE_CODE_PTR:
            return 'function-pointer' if typ.target().strip_typedefs().code in (gdb.TYPE_CODE_FUNC, gdb.TYPE_CODE_METHOD) else 'pointer'
        if code == gdb.TYPE_CODE_ARRAY:
            return 'array'
        if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            return 'struct'
        if code == gdb.TYPE_CODE_ENUM:
            return 'enum'
        return 'scalar'

    def description(self, number, value, label=None):
        kind = self.kind(value)
        typ = value.type.strip_typedefs()
        compound = kind in ('struct', 'array')
        result = {'result': '{...}' if compound else self.format(value), 'type': str(value.type),
                  'rawType': str(value.type), 'typeKind': kind,
                  'gdbVarName': 'native:' + str(number), 'variablesReference': number if compound else 0}
        result['matrix'] = self.matrix_shape(value)
        if kind == 'array':
            low, high = typ.range()
            result['indexedVariables'] = max(0, high - low + 1)
        if label is not None:
            result['name'] = label
            result['evaluateName'] = self.nodes[number]['expression']
            result['value'] = result.pop('result')
        return result

    @staticmethod
    def matrix_shape(value):
        typ = value.type.strip_typedefs()
        name = re.sub(r'^(?:class|struct)\s+', '', str(typ))
        match = re.fullmatch(r'Eigen::(?:Matrix|Array)<(.+)>', name)
        if match:
            # Eigen's supported scalar types here are numeric, not nested templates.
            args = [part.strip() for part in match[1].split(',')]
            if len(args) < 3 or not args[1].isdigit() or not args[2].isdigit():
                return None
            rows, columns = int(args[1]), int(args[2])
            options = int(args[3]) if len(args) > 3 and args[3].isdigit() else 0
            if 0 < rows * columns <= 4096:
                return {'rows': rows, 'columns': columns, 'scalar': args[0], 'kind': 'eigen',
                        'rowMajor': bool(options & 1), 'automatic': True}
            return None
        dims = []
        while typ.code == gdb.TYPE_CODE_ARRAY:
            low, high = typ.range()
            if low != 0:
                return None
            dims.append(high - low + 1)
            typ = typ.target().strip_typedefs()
        if len(dims) not in (1, 2) or typ.code not in (gdb.TYPE_CODE_FLT, gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_BOOL):
            return None
        rows, columns = dims if len(dims) == 2 else (1, dims[0])
        if rows <= 0 or columns <= 0 or rows * columns > 4096:
            return None
        return {'rows': rows, 'columns': columns, 'scalar': str(typ), 'kind': 'array',
                'rowMajor': True, 'automatic': len(dims) == 2}

    def matrix_sample(self, request, cache):
        name = request['id']
        try:
            number = int(name.split(':')[1])
            value = self.value(number, cache)
            shape = self.matrix_shape(value)
            rows, columns = int(request['rows']), int(request['columns'])
            if not shape or rows <= 0 or columns <= 0 or rows * columns != shape['rows'] * shape['columns']:
                raise ValueError('矩阵行列数与存储大小不一致')
            if shape['kind'] == 'eigen':
                if rows != shape['rows'] or columns != shape['columns']:
                    raise ValueError('Eigen 矩阵保持原有行列数')
                array = value['m_storage']['m_data']['array']
                values = [self.format(array[row * columns + column if shape['rowMajor'] else column * rows + row])
                          for row in range(rows) for column in range(columns)]
            elif shape['automatic']:
                values = [self.format(value[row][column]) for row in range(shape['rows']) for column in range(shape['columns'])]
            else:
                values = [self.format(value[index]) for index in range(rows * columns)]
            return {'name': name, 'values': values}
        except Exception as error:
            return {'name': name, 'values': [], 'error': str(error)}

    @staticmethod
    def format(value):
        typ = value.type.strip_typedefs()
        if typ.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_BOOL):
            return str(int(value))
        if typ.code == gdb.TYPE_CODE_FLT:
            return repr(float(value))
        return str(value)

    def children(self, number, start, count):
        node = self.nodes[number]
        value = self.value(number, {})
        typ = value.type.strip_typedefs()
        fields = []
        if typ.code == gdb.TYPE_CODE_ARRAY:
            low, high = typ.range()
            fields = [(f'[{i}]', i, f'({node["expression"]})[{i}]')
                      for i in range(low + start, min(high + 1, low + start + count))]
        elif typ.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            for field in typ.fields():
                if field.is_base_class:
                    fields.append((str(field.type), {'base': str(field.type)}, f'(({field.type}&)({node["expression"]}))'))
                elif field.name:
                    fields.append((field.name, field.name, f'({node["expression"]}).{field.name}'))
        variables = []
        for label, step, expression in fields:
            child_id = self.bind(expression, node['root'], node['steps'] + [step])
            child_value = value.cast(gdb.lookup_type(step['base'])) if isinstance(step, dict) else value[step]
            variables.append(self.description(child_id, child_value, label))
        return {'variables': variables}

    def write(self, args):
        number = int(args['name'].split(':')[1])
        node = self.nodes[number]
        value = gdb.parse_and_eval(node['expression'])
        typ = value.type.strip_typedefs()
        if self.kind(value) not in ('scalar', 'enum') or 'const' in str(value.type) or value.address is None:
            raise ValueError('仅支持可写的整数、浮点、布尔或枚举成员')
        text = str(args['value']).strip()
        if typ.code == gdb.TYPE_CODE_ENUM:
            names = [field.name for field in typ.fields()]
            if text in names:
                canonical = text
            else:
                canonical = self.integer(text, typ)
        elif typ.code == gdb.TYPE_CODE_BOOL:
            if text not in ('0', '1', 'true', 'false'):
                raise ValueError('请输入 0、1、true 或 false')
            canonical = '1' if text in ('1', 'true') else '0'
        elif typ.code == gdb.TYPE_CODE_FLT:
            if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', text) or not math.isfinite(float(text)):
                raise ValueError('请输入有限浮点数')
            canonical = repr(float(text))
        elif typ.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR):
            canonical = self.integer(text, typ)
        else:
            raise ValueError('该类型不支持修改')
        expected = gdb.parse_and_eval(f'({typ})({canonical})')
        if typ.code == gdb.TYPE_CODE_FLT and not math.isfinite(float(expected)):
            raise ValueError('输入值超出变量类型的范围')
        gdb.execute(f'set variable ({node["expression"]}) = ({typ})({canonical})', to_string=True)
        actual = self.format(gdb.parse_and_eval(node['expression']))
        applied = self.format(expected)
        return {'value': actual, 'appliedValue': applied, 'overwritten': actual != applied}

    @staticmethod
    def integer(text, typ):
        if not re.fullmatch(r'[+-]?(?:0[xX][0-9a-fA-F]+|\d+)', text):
            raise ValueError('请输入整数或十六进制数')
        number = int(text, 16 if '0x' in text.lower() else 10)
        signed = int(gdb.Value(-1).cast(typ)) < 0
        bits = typ.sizeof * 8
        low = -(1 << (bits - 1)) if signed else 0
        high = (1 << (bits - (1 if signed else 0))) - 1
        if not low <= number <= high:
            raise ValueError('输入值超出变量类型的范围')
        return str(number)

    def request(self, command, args):
        if command == 'ping':
            return {'ready': True}
        if command == 'load-function-symbols':
            return {'functionSymbols': []}
        if command == 'list-file-statics':
            requested = args['file'].replace('\\', '/')
            active = False
            names = []
            for line in gdb.execute('info variables', to_string=True).splitlines():
                if line.startswith('File ') and line.endswith(':'):
                    filename = line[5:-1].replace('\\', '/')
                    active = filename == requested or os.path.basename(filename) == os.path.basename(requested)
                elif active:
                    match = re.search(r'\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?;', line)
                    if match:
                        names.append(match.group(1))
            return {'names': names}
        if command == 'liveEvaluate':
            number = self.bind(args['expression'])
            try:
                result = self.description(number, self.value(number, {}))
                self.pending_roots.discard(number)
                return result
            except Exception as error:
                self.pending_roots.add(number)
                return {'unavailable': True, 'result': '<等待动态库或变量可用：' + str(error) + '>'}
        if command == 'liveVariables':
            return self.children(args['variablesReference'], int(args.get('start', 0)), int(args.get('count', 64)))
        if command == 'liveSetValue':
            return self.write(args)
        if command == 'liveCacheRefresh':
            if args.get('deleteAll'):
                self.nodes.clear()
                self.expressions.clear()
                self.subscription = None
                self.pending_roots.clear()
                self.matrix_requests = []
                return {'changes': [], 'rebuild': True, 'readMs': 0}
            if 'subscription' in args:
                self.subscription = [int(node['id'].split(':')[1]) for node in args['subscription'] if node['id'].startswith('native:')]
            if 'matrices' in args:
                self.matrix_requests = args['matrices'][:64]
            started = time.monotonic()
            changes = []
            unavailable = []
            cache = {}
            rebuild = False
            for number in list(self.pending_roots):
                try:
                    self.value(number, cache)
                    self.pending_roots.discard(number)
                    rebuild = True
                except Exception:
                    pass
            for number in self.subscription if self.subscription is not None else list(self.nodes):
                if number not in self.nodes:
                    continue
                try:
                    value = self.value(number, cache)
                    changes.append({'name': 'native:' + str(number), 'value': self.description(number, value)['result']})
                except Exception as error:
                    unavailable.append({'name': 'native:' + str(number), 'error': str(error)})
            matrices = [self.matrix_sample(request, cache) for request in self.matrix_requests]
            return {'changes': changes, 'unavailable': unavailable, 'rebuild': rebuild, 'matrices': matrices,
                    'readMs': (time.monotonic() - started) * 1000, 'mode': 'native'}
        raise ValueError('不支持的 Live Watch 请求：' + command)

    def serve(self):
        while True:
            connection, _ = self.server.accept()
            with connection:
                with connection.makefile('rwb') as stream:
                    for line in stream:
                        completed = threading.Event()
                        result = {}
                        def dispatch(line=line, result=result, completed=completed):
                            try:
                                request = json.loads(line)
                                result['body'] = self.request(request['command'], request.get('args') or {})
                            except Exception as error:
                                result['error'] = str(error)
                            finally:
                                completed.set()
                        gdb.post_event(dispatch)
                        if not completed.wait(10):
                            break
                        stream.write(json.dumps(result).encode('utf8') + b'\n')
                        stream.flush()


_rm_native_live_watch = NativeLiveWatch(rm_live_socket)
