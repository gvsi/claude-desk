"""Exercise the remote transaction watchdog without AWS, sudo or systemd."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

from desk_tools import testbox_client


@pytest.mark.parametrize('mode', ['eof', 'SIGTERM', 'SIGINT'])
def test_disconnect_stops_process_group_before_releasing_lane(tmp_path, mode):
    (tmp_path / 'repo').mkdir()
    script = tmp_path / 'job.py'
    script.write_text('''import os, signal, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(90)'])
def stop(*args):
    child.wait()
    raise SystemExit(143)
signal.signal(signal.SIGTERM, stop)
Path(sys.argv[1]).write_text(str(child.pid))
print('job-ready', flush=True)
time.sleep(90)
''')
    source = testbox_client.transaction_script(str(tmp_path), [sys.executable, str(script), str(tmp_path / 'child.pid')], [sys.executable, '-c', 'pass'])
    holder = subprocess.Popen([sys.executable, '-c', source], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        json.loads(holder.stdout.readline())
        holder.stdin.write('run\n')
        holder.stdin.flush()
        assert holder.stdout.readline().strip() == 'job-ready'
        child = int((tmp_path / 'child.pid').read_text())
        start = time.monotonic()
        # EOF models a killed client; the remote lock must survive until cleanup finishes.
        if mode == 'eof':
            holder.stdin.close()
            expected = 130
        else:
            signum = getattr(signal, mode)
            holder.send_signal(signum)
            expected = 128 + signum
        assert holder.wait(timeout=5) == expected
        assert time.monotonic() - start < 5
        with pytest.raises(ProcessLookupError):
            os.kill(child, 0)
        following = testbox_client.transaction_script(str(tmp_path), [sys.executable, '-c', 'print("next-job")'], [sys.executable, '-c', 'pass'])
        next_call = subprocess.Popen([sys.executable, '-c', following], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        json.loads(next_call.stdout.readline())
        next_call.stdin.write('run\n')
        next_call.stdin.flush()
        assert next_call.stdout.readline().strip() == 'next-job'
        assert next_call.wait(timeout=5) == 0
        next_call.stdin.close()
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.wait()


def test_worker_signal_unwinds_wait_before_reaping_process_group(tmp_path):
    worker = Path(__file__).parents[1] / 'testbox/worker.py'
    script = f'''import importlib.util, signal
spec = importlib.util.spec_from_file_location('worker', {str(worker)!r})
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
signal.signal(signal.SIGTERM, worker.stop)
worker.run([{sys.executable!r}, '-c', {('import os, time; from pathlib import Path; Path(' + repr(str(tmp_path / 'pid')) + ').write_text(str(os.getpid())); print("WAITING", flush=True); time.sleep(90)')!r}], stdout=None)
'''
    process = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE, text=True, start_new_session=True)
    try:
        assert process.stdout.readline().strip() == 'WAITING'
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=3) == 143
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        marker = tmp_path / 'pid'
        if marker.exists():
            try:
                os.kill(int(marker.read_text()), signal.SIGTERM)
            except ProcessLookupError:
                pass


def test_command_output_passes_through_byte_for_byte_with_its_exit_status(tmp_path):
    """Carriage returns and bytes that aren't UTF-8 reach the caller unchanged, the job runs to its end, and its
    own exit status comes back."""
    import io
    (tmp_path / 'repo').mkdir()
    first, last = b'a\r\nb\rc\xff\xfe\n', b'after\n'
    job = ('import sys, time; out = sys.stdout.buffer; out.write(' + repr(first) + '); out.flush(); '
           'time.sleep(0.3); out.write(' + repr(last) + '); sys.exit(37)')
    source = testbox_client.transaction_script(str(tmp_path), [sys.executable, '-c', job], [sys.executable, '-c', 'pass'])
    holder = testbox_client.start_holder([sys.executable, '-c', source])
    try:
        assert testbox_client.read_remote_state(holder) is not None
        received = io.BytesIO()
        assert testbox_client.relay(holder, received) == 37
        assert received.getvalue() == first + last
    finally:
        testbox_client.release(holder, started=True)


def test_a_caller_that_leaves_while_the_lane_is_busy_stops_waiting_at_once(tmp_path):
    """Another call holds the lane. The waiting holder has no job yet, so EOF from its caller ends the wait now,
    not when the other call finishes."""
    import fcntl
    (tmp_path / 'repo').mkdir()
    marker = tmp_path / 'ran'
    job = [sys.executable, '-c', f'from pathlib import Path; Path({str(marker)!r}).touch()']
    with (tmp_path / 'lock').open('w') as busy:
        fcntl.flock(busy, fcntl.LOCK_EX)
        source = testbox_client.transaction_script(str(tmp_path), job, [sys.executable, '-c', 'pass'])
        holder = subprocess.Popen([sys.executable, '-c', source], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            time.sleep(0.5)
            assert holder.poll() is None   # still waiting for the lane
            holder.stdin.close()
            assert holder.wait(timeout=3) == 130
            assert holder.stdout.read() == b''
        finally:
            if holder.poll() is None:
                holder.kill()
                holder.wait()
    assert not marker.exists()


def test_before_run_is_sent_the_client_stops_its_holder_without_waiting_for_it(tmp_path):
    """Before "run" there is no remote job to clean up, so an interrupted client never waits on a remote that is
    itself still waiting (for a busy lane or the bootstrap lock)."""
    stuck = testbox_client.start_holder([sys.executable, '-c', 'import signal, time\nwhile True: time.sleep(1)'])
    start = time.monotonic()
    testbox_client.release(stuck, started=False)
    assert time.monotonic() - start < 3
    assert stuck.returncode is not None
