"""Drive a password command through a real PTY, without putting input in argv."""
import errno
import json
import os
import select
import subprocess
import sys
import termios
import time

inputs = json.load(sys.stdin)
master, slave = os.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                         start_new_session=True)
os.close(slave)
output = b""
hidden = True
index = 0
prompts = ["Новый пароль: ".encode(), "Повторите пароль: ".encode()]
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            output += chunk
        if index < len(inputs) and prompts[index] in output:
            # Observe raw mode before sending: a prompt can precede setRawMode.
            if termios.tcgetattr(master)[3] & termios.ECHO:
                continue
            hidden = hidden and not (termios.tcgetattr(master)[3] & termios.ECHO)
            os.write(master, (inputs[index] + "\r").encode())
            index += 1
        if child.poll() is not None:
            break
    else:
        raise TimeoutError("Password command did not finish")
    print(json.dumps({"exitCode": child.wait(timeout=2), "hidden": hidden,
                      "inputsSent": index, "output": output.decode(errors="replace")}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
