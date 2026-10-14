import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

GUARD = Path(__file__).with_name("guard.py")


def running(pid):
    try:
        os.kill(pid, 0)
        status = Path(f"/proc/{pid}/stat")
        return not status.exists() or status.read_text().split()[2] != "Z"
    except ProcessLookupError:
        return False


class GuardTests(unittest.TestCase):
    def exercise(self, crash):
        with tempfile.TemporaryDirectory(prefix="pi-agents-guard-") as directory:
            path = Path(directory) / "pids.json"
            source = (
                "import os,json,subprocess,time; "
                "p=subprocess.Popen(['bash','-c','sleep 60; true'],start_new_session=True); "
                f"open({str(path)!r},'w').write(json.dumps([os.getpid(),p.pid])); "
                "time.sleep(60)"
            )
            reader, writer = os.pipe()
            guard = subprocess.Popen(
                [
                    sys.executable,
                    str(GUARD),
                    "--lifeline-fd",
                    str(reader),
                    sys.executable,
                    "-c",
                    source,
                ],
                pass_fds=(reader,),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            os.close(reader)
            try:
                deadline = time.monotonic() + 5
                while not path.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(path.exists())
                pids = json.loads(path.read_text())
                if not sys.platform.startswith("linux"):
                    time.sleep(0.8)  # Darwin needs an observed separate group.
                if crash:
                    os.kill(pids[0], signal.SIGKILL)
                else:
                    os.close(writer)
                    writer = None
                guard.communicate(timeout=5)
                deadline = time.monotonic() + 3
                while any(running(pid) for pid in pids) and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertFalse(
                    any(running(pid) for pid in pids), f"surviving worker/Bash: {pids}"
                )
            finally:
                if writer is not None:
                    os.close(writer)
                if guard.poll() is None:
                    guard.kill()
                guard.communicate()
                if path.exists():
                    for pid in json.loads(path.read_text()):
                        try:
                            os.killpg(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_owner_lifeline_eof_stops_worker_and_separate_bash_group(self):
        self.exercise(False)

    def test_worker_crash_reaps_separate_bash_group(self):
        self.exercise(True)


if __name__ == "__main__":
    unittest.main()
