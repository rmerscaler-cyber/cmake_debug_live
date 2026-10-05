"""Exercise actual Eigen values and the native matrix sampler inside native GDB."""
from pathlib import Path
import subprocess
import tempfile

helper = Path(__file__).resolve().parents[1] / 'support/native-live-watch.py'
with tempfile.TemporaryDirectory(prefix='rm-matrix-gdb-') as directory:
    root = Path(directory)
    source = root / 'matrix.cpp'
    source.write_text('''#include <Eigen/Core>
Eigen::Matrix<double, 2, 3> column_matrix;
Eigen::Matrix<double, 2, 3, Eigen::RowMajor> row_matrix;
Eigen::Matrix<double, 12, 1> vector_matrix;
float rectangular[2][3] = {{0, 1, 2}, {10, 11, 12}};
int flat[6] = {0, 1, 2, 10, 11, 12};
int main() {
  for (int r=0;r<2;r++) for(int c=0;c<3;c++) {
    column_matrix(r,c)=10*r+c; row_matrix(r,c)=10*r+c;
  }
  for(int i=0;i<12;i++) vector_matrix(i)=i;
  asm("nop"); // CHECK_MATRIX
  return 0;
}
''')
    subprocess.run(['g++', '-g', '-O0', '-I/usr/include/eigen3', str(source), '-o', str(root / 'matrix')], check=True)
    line = next(i for i, text in enumerate(source.read_text().splitlines(), 1) if 'CHECK_MATRIX' in text)
    assertions = root / 'assertions.py'
    assertions.write_text('''
watch = _rm_native_live_watch
expected = ['0.0', '1.0', '2.0', '10.0', '11.0', '12.0']
subscriptions = []
matrices = []
for expression in ['column_matrix', 'row_matrix', 'rectangular', 'flat', 'vector_matrix']:
    description = watch.request('liveEvaluate', {'expression': expression})
    shape = description['matrix']
    assert shape, expression
    if expression == 'vector_matrix':
        assert (shape['rows'], shape['columns']) == (12, 1)
    elif expression == 'flat':
        assert not shape['automatic']
    else:
        assert (shape['rows'], shape['columns']) == (2, 3)
    subscriptions.append({'id': description['gdbVarName']})
    matrices.append({'id': description['gdbVarName'], 'rows': 12 if expression == 'vector_matrix' else 2,
                     'columns': 1 if expression == 'vector_matrix' else 3})
frame = watch.request('liveCacheRefresh', {'subscription': subscriptions, 'matrices': matrices})
assert len(frame['matrices']) == 5
for i, sample in enumerate(frame['matrices']):
    assert 'error' not in sample, sample
    if i < 3:
        assert sample['values'] == expected, sample
    elif i == 3:
        assert sample['values'] == ['0', '1', '2', '10', '11', '12']
    else:
        assert sample['values'] == [str(float(i)) for i in range(12)]
gdb.execute('set variable column_matrix.m_storage.m_data.array[0] = 42')
updated = watch.request('liveCacheRefresh', {})
assert updated['matrices'][0]['values'][0] == '42.0'
watch.request('liveCacheRefresh', {'matrices': []})
assert watch.request('liveCacheRefresh', {})['matrices'] == []
print('REAL_MATRIX_GDB_OK')
''')
    init = f'python rm_live_socket = {str(root / "gdb.sock")!r}; exec(compile(open({str(helper)!r}).read(), {str(helper)!r}, "exec"))'
    result = subprocess.run(['gdb', '--batch', '-nx', '-ex', 'set pagination off',
                             '-ex', f'file {root / "matrix"}', '-ex', f'break {source}:{line}',
                             '-ex', 'run', '-ex', init, '-ex', f'source {assertions}'],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0 and 'REAL_MATRIX_GDB_OK' in result.stdout, result.stdout + result.stderr
    print('Actual GDB/Eigen: row/column-major matrices, rectangular arrays, 12x1 vectors, manual reshape and updated values passed.')
