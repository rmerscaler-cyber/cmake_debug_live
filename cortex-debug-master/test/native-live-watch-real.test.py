"""Real native GDB test: sample/edit globals while running, without interrupting."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time

helper = Path(__file__).resolve().parents[1] / 'support/native-live-watch.py'
with tempfile.TemporaryDirectory(prefix='rm-live-real-') as directory:
    root = Path(directory)
    library = root / 'late.so'
    (root / 'late.cpp').write_text('extern "C" { int late_state = 17; }\n')
    subprocess.run(['g++', '-shared', '-fPIC', '-g', str(root / 'late.cpp'), '-o', str(library)], check=True)
    source = root / 'counter.cpp'
    source.write_text('''#include <unistd.h>
#include <dlfcn.h>
enum Mode { Idle, Move };
struct State { int tick; double value; const int fixed; unsigned char byte; bool flag; Mode mode; int array[100]; double matrix[2][3]; };
State state = {0, 1.25, 7, 4, false, Idle, {1, 2, 3}};
State* ptr = &state;
int main() { for(int i=0;i<3000;i++) {if(i==100) dlopen(LATE_LIBRARY, RTLD_NOW); state.tick++; state.value+=.01;
  for(int r=0;r<2;r++) for(int c=0;c<3;c++) state.matrix[r][c]=i+10*r+c;
  usleep(5000);} }
'''.replace('LATE_LIBRARY', json.dumps(str(library))))
    subprocess.run(['g++', '-g', '-O0', str(source), '-ldl', '-o', str(root / 'counter')], check=True)
    pathname = str(root / 'gdb.sock')
    init = f'python rm_live_socket = {pathname!r}; exec(compile(open({str(helper)!r}).read(), {str(helper)!r}, "exec"))'
    debugger = subprocess.Popen(['gdb', '--quiet', '--interpreter=mi2', '-ex', 'set mi-async on',
                                 '-ex', init, str(root / 'counter')], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    output = []
    def drain():
        for line in debugger.stdout:
            output.append(line.rstrip())
    threading.Thread(target=drain, daemon=True).start()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(8)
    try:
        for _ in range(80):
            try:
                connection.connect(pathname)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                time.sleep(.05)
        debugger.stdin.write('1-exec-run\n')
        debugger.stdin.flush()
        stream = connection.makefile('rwb')
        def request(command, args=None):
            stream.write(json.dumps({'command': command, 'args': args or {}}).encode() + b'\n')
            stream.flush()
            result = json.loads(stream.readline())
            if 'error' in result:
                raise ValueError(result['error'])
            return result['body']
        assert request('ping')['ready']
        assert request('liveEvaluate', {'expression': 'late_state'})['unavailable']
        time.sleep(.2)
        state = request('liveEvaluate', {'expression': 'state'})
        children = request('liveVariables', {'variablesReference': state['variablesReference']})['variables']
        fields = {variable['name']: variable for variable in children}
        first = request('liveCacheRefresh')
        time.sleep(.2)
        second = request('liveCacheRefresh')
        tick = fields['tick']['gdbVarName']
        def sample(frame, name):
            return next(item['value'] for item in frame['changes'] if item['name'] == name)
        assert int(sample(second, tick)) > int(sample(first, tick))
        matrix = fields['matrix']
        matrix_args = {'subscription': [{'id': matrix['gdbVarName']}], 'matrices': [
            {'id': matrix['gdbVarName'], 'rows': 2, 'columns': 3}]}
        first_matrix = request('liveCacheRefresh', matrix_args)['matrices'][0]
        time.sleep(.1)
        second_matrix = request('liveCacheRefresh')['matrices'][0]
        assert 'error' not in first_matrix and 'error' not in second_matrix
        before = [float(value) for value in first_matrix['values']]
        after = [float(value) for value in second_matrix['values']]
        assert len(after) == 6 and all(b > a for a, b in zip(before, after)), 'running matrices must update every cell'
        assert after[3] - after[0] == 10, 'matrix samples must preserve logical rows'
        request('liveCacheRefresh', {'matrices': []})
        time.sleep(.3)
        assert request('liveCacheRefresh')['rebuild'], 'late DLL globals must trigger rediscovery'
        assert request('liveEvaluate', {'expression': 'late_state'})['result'] == '17'
        assert not any('*stopped' in line for line in output), 'sampling must not interrupt the inferior'
        array = fields['array']['variablesReference']
        elements = request('liveVariables', {'variablesReference': array, 'start': 1, 'count': 2})['variables']
        assert [item['name'] for item in elements] == ['[1]', '[2]']
        assert request('liveSetValue', {'name': elements[0]['gdbVarName'], 'value': '42'})['value'] == '42'
        assert request('liveSetValue', {'name': fields['flag']['gdbVarName'], 'value': 'true'})['value'] == '1'
        assert request('liveSetValue', {'name': fields['mode']['gdbVarName'], 'value': 'Move'})['value'] == 'Move'
        for name, value in [('fixed', '9'), ('byte', '256'), ('tick', 'call()'), ('value', '1e999')]:
            try:
                request('liveSetValue', {'name': fields[name]['gdbVarName'], 'value': value})
                raise AssertionError('invalid assignment must fail: ' + name)
            except ValueError:
                pass
        pointer = request('liveEvaluate', {'expression': 'ptr'})
        assert pointer['typeKind'] == 'pointer'
        dereference = request('liveEvaluate', {'expression': '*(ptr)'})
        assert dereference['variablesReference'] > 0
        request('liveCacheRefresh', {'subscription': [{'id': tick}]})
        frame = request('liveCacheRefresh')
        assert len(frame['changes']) == 1 and frame['changes'][0]['name'] == tick
        debugger.stdin.write('2-exec-interrupt\n')
        debugger.stdin.flush()
        time.sleep(.2)
        assert any('*stopped' in line for line in output)
        assert request('liveEvaluate', {'expression': 'state.tick'})['result'].isdigit()
        debugger.stdin.write('3-exec-continue\n')
        debugger.stdin.flush()
        time.sleep(.1)
        assert request('liveEvaluate', {'expression': 'state.tick'})['result'].isdigit()
        print('Native GDB Live Watch: changing matrix cells while running, arrays, pointers, scalar writes, validation, pause/continue passed')
    finally:
        connection.close()
        debugger.stdin.write('4-gdb-exit\n')
        debugger.stdin.flush()
        try:
            debugger.wait(timeout=3)
        except subprocess.TimeoutExpired:
            debugger.kill()
